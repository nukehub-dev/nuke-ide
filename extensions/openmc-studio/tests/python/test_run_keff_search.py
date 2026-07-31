"""Tests for run_keff_search (criticality search driver).

The real search never executes: openmc and openmc.search are replaced with
recording stubs, so the model_builder shim, parameter application (the
optimization parameter vocabulary), bracket/guess validation, and result
reporting are all exercised without OpenMC installed. Each test runs in a tmp
working directory and restores the process CWD afterwards. The only test that
touches real OpenMC is the importorskip signature check at the end.
"""

import copy
import json
import os
import sys
import types
from types import SimpleNamespace

import pytest
import run_keff_search


@pytest.fixture(autouse=True)
def _restore_cwd():
    """run_search chdirs into the working directory; undo that per test."""
    cwd = os.getcwd()
    yield
    os.chdir(cwd)


# ---------------------------------------------------------------------------
# Stub builders
# ---------------------------------------------------------------------------


def _make_model():
    """A fake openmc.Model with one material (2 nuclides), settings, geometry."""
    material = SimpleNamespace(
        name="Water",
        density=1.0,
        temperature=293.6,
        nuclides=[
            SimpleNamespace(name="H1", percent=2.0 / 3.0, percent_type="ao"),
            SimpleNamespace(name="O16", percent=1.0 / 3.0, percent_type="ao"),
        ],
    )
    cell = SimpleNamespace(name="fuel", temperature=600.0)
    model = SimpleNamespace(
        materials=[material],
        settings=SimpleNamespace(particles=1000, batches=100, inactive=10, seed=1),
        geometry=SimpleNamespace(get_all_cells=lambda: {1: cell}),
    )
    model.clone = lambda: copy.deepcopy(model)
    return model


class RecordingSearch:
    """Records search_for_keff invocation and drives model_builder calls."""

    calls = []
    fail_with = None

    @classmethod
    def search_for_keff(cls, model_builder, **kwargs):
        cls.calls.append(kwargs)
        if cls.fail_with is not None:
            # Still exercise the builder once (search_for_keff does this too)
            model_builder(kwargs.get("initial_guess") or (kwargs.get("bracket") or [1.0])[0])
            raise cls.fail_with
        guesses = [0.5, 1.0, 0.75]
        results = [
            SimpleNamespace(n=0.95, s=0.01),
            SimpleNamespace(n=1.02, s=0.01),
            SimpleNamespace(n=1.0, s=0.01),
        ]
        for guess in guesses:
            model = model_builder(guess)
            assert isinstance(model, SimpleNamespace)  # shim returns the clone
        return 0.75, guesses, results


def _install_fake_openmc(monkeypatch):
    """Insert stub openmc/openmc.search modules; returns the fake openmc."""
    fake_openmc = types.ModuleType("openmc")
    base_model = _make_model()
    fake_openmc.Materials = SimpleNamespace(from_xml=lambda path: base_model.materials)
    fake_openmc.Geometry = SimpleNamespace(from_xml=lambda path, mats: base_model.geometry)
    fake_openmc.Settings = SimpleNamespace(from_xml=lambda path: base_model.settings)
    fake_openmc.Model = lambda geometry, materials, settings: base_model

    fake_search = types.ModuleType("openmc.search")
    fake_search.search_for_keff = RecordingSearch.search_for_keff

    RecordingSearch.calls = []
    RecordingSearch.fail_with = None

    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)
    monkeypatch.setitem(sys.modules, "openmc.search", fake_search)
    return fake_openmc, base_model


def _make_workdir(tmp_path):
    (tmp_path / "settings.xml").write_text("<settings/>")
    return tmp_path


def _args(workdir, **overrides):
    defaults = {
        "working_directory": str(workdir),
        "parameter": "water.density",
        "target": 1.0,
        "initial_guess": None,
        "bracket": "0.5,1.5",
        "method": "brentq",
        "tol": 1e-8,
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


# ---------------------------------------------------------------------------
# apply_search_parameter (the optimization parameter vocabulary)
# ---------------------------------------------------------------------------


def test_apply_density_and_temperature():
    model = _make_model()
    run_keff_search.apply_search_parameter(model, "water.density", 0.8)
    assert model.materials[0].density == 0.8
    run_keff_search.apply_search_parameter(model, "Water.temperature", 300.0)  # case-insensitive
    assert model.materials[0].temperature == 300.0


def test_apply_nuclide_fraction_renormalizes_others():
    model = _make_model()
    run_keff_search.apply_search_parameter(model, "water.H1", 0.5)
    h1, o16 = model.materials[0].nuclides
    assert h1.percent == 0.5
    assert o16.percent == pytest.approx(0.5)  # remaining 0.5 over the only other nuclide
    assert sum(n.percent for n in model.materials[0].nuclides) == pytest.approx(1.0)


def test_apply_settings_and_geometry_parameters():
    model = _make_model()
    run_keff_search.apply_search_parameter(model, "settings.particles", 5000.0)
    assert model.settings.particles == 5000
    run_keff_search.apply_search_parameter(model, "geometry.fuel.temperature", 900.0)
    assert model.geometry.get_all_cells()[1].temperature == 900.0


def test_apply_unknown_paths_raise():
    model = _make_model()
    with pytest.raises(ValueError, match="Invalid parameter path"):
        run_keff_search.apply_search_parameter(model, "density", 1.0)
    with pytest.raises(ValueError, match="Material not found"):
        run_keff_search.apply_search_parameter(model, "unobtanium.density", 1.0)
    with pytest.raises(ValueError, match="Nuclide not found"):
        run_keff_search.apply_search_parameter(model, "water.U235", 0.05)
    with pytest.raises(ValueError, match="Unsupported settings"):
        run_keff_search.apply_search_parameter(model, "settings.bogus", 1.0)
    with pytest.raises(ValueError, match="Cell not found"):
        run_keff_search.apply_search_parameter(model, "geometry.void.temperature", 1.0)


# ---------------------------------------------------------------------------
# run_search with stub openmc.search
# ---------------------------------------------------------------------------


def test_run_search_bracket_flow(monkeypatch, tmp_path):
    _, base_model = _install_fake_openmc(monkeypatch)
    workdir = _make_workdir(tmp_path)

    result = run_keff_search.run_search(_args(workdir))

    assert result["success"] is True
    assert result["convergedValue"] == 0.75
    assert result["method"] == "brentq"
    assert result["parameter"] == "water.density"
    assert result["target"] == 1.0
    assert len(result["iterations"]) == 3
    assert result["iterations"][0] == {"iteration": 1, "guess": 0.5, "keff": 0.95, "keffStd": 0.01}
    assert result["finalKeff"] == 1.0

    # search_for_keff received the bracket/method/tol and a model_builder
    call = RecordingSearch.calls[0]
    assert call["bracket"] == [0.5, 1.5]
    assert call["bracketed_method"] == "brentq"
    assert call["tol"] == 1e-8
    assert call["print_iterations"] is True
    assert call["run_args"] == {"cwd": str(workdir)}

    # The shim clones: the base model is not mutated by builder calls
    assert base_model.materials[0].density == 1.0


def test_run_search_shim_applies_parameter(monkeypatch, tmp_path):
    _install_fake_openmc(monkeypatch)
    workdir = _make_workdir(tmp_path)

    seen_densities = []
    original_builder_check = RecordingSearch.search_for_keff

    def checking_search(model_builder, **kwargs):
        for guess in (0.7, 0.9):
            model = model_builder(guess)
            seen_densities.append(model.materials[0].density)
        return 0.9, [0.7, 0.9], [SimpleNamespace(n=1.0, s=0.01), SimpleNamespace(n=1.0, s=0.01)]

    monkeypatch.setitem(sys.modules["openmc.search"].__dict__, "search_for_keff", checking_search)
    result = run_keff_search.run_search(_args(workdir))

    assert seen_densities == [0.7, 0.9]  # guess written into the cloned model
    assert result["success"] is True
    # restore (not strictly needed: instances reset per test)
    assert original_builder_check is not None


def test_run_search_secant_method_without_bracket(monkeypatch, tmp_path):
    _install_fake_openmc(monkeypatch)
    workdir = _make_workdir(tmp_path)

    result = run_keff_search.run_search(_args(workdir, bracket=None, initial_guess=0.6))
    assert result["success"] is True
    assert result["method"] == "secant"
    assert RecordingSearch.calls[0]["bracket"] is None
    assert RecordingSearch.calls[0]["initial_guess"] == 0.6


def test_run_search_requires_guess_or_bracket(monkeypatch, tmp_path):
    _install_fake_openmc(monkeypatch)
    workdir = _make_workdir(tmp_path)
    with pytest.raises(ValueError, match="initial-guess or --bracket"):
        run_keff_search.run_search(_args(workdir, bracket=None, initial_guess=None))


def test_run_search_rejects_bad_bracket(monkeypatch, tmp_path):
    _install_fake_openmc(monkeypatch)
    workdir = _make_workdir(tmp_path)
    with pytest.raises(ValueError, match="Invalid bracket"):
        run_keff_search.run_search(_args(workdir, bracket="1.5,0.5"))
    with pytest.raises(ValueError, match="Invalid bracket"):
        run_keff_search.run_search(_args(workdir, bracket="1.0"))


def test_run_search_missing_settings_xml(monkeypatch, tmp_path):
    _install_fake_openmc(monkeypatch)
    with pytest.raises(FileNotFoundError, match="settings.xml"):
        run_keff_search.run_search(_args(tmp_path))


def test_run_search_non_convergence_propagates(monkeypatch, tmp_path):
    _install_fake_openmc(monkeypatch)
    RecordingSearch.fail_with = RuntimeError("Failed to converge after 50 iterations")
    workdir = _make_workdir(tmp_path)
    with pytest.raises(RuntimeError, match="Failed to converge"):
        run_keff_search.run_search(_args(workdir))


# ---------------------------------------------------------------------------
# main() CLI contract
# ---------------------------------------------------------------------------


def test_main_success_writes_result_file_and_json(monkeypatch, tmp_path, capsys):
    _install_fake_openmc(monkeypatch)
    workdir = _make_workdir(tmp_path)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "run_keff_search.py",
            str(workdir),
            "--parameter",
            "water.density",
            "--bracket",
            "0.5,1.5",
            "--method",
            "brentq",
        ],
    )

    assert run_keff_search.main() == 0
    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["success"] is True
    assert payload["convergedValue"] == 0.75

    result_file = workdir / "keff_search_result.json"
    assert result_file.exists()
    assert json.loads(result_file.read_text())["convergedValue"] == 0.75


def test_main_failure_prints_error_json(monkeypatch, tmp_path, capsys):
    _install_fake_openmc(monkeypatch)
    RecordingSearch.fail_with = RuntimeError("Failed to converge")
    workdir = _make_workdir(tmp_path)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "run_keff_search.py",
            str(workdir),
            "--parameter",
            "water.density",
            "--initial-guess",
            "0.6",
        ],
    )

    assert run_keff_search.main() == 1
    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["success"] is False
    assert "Failed to converge" in payload["error"]


def test_main_requires_parameter(monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "argv", ["run_keff_search.py", str(tmp_path)])
    with pytest.raises(SystemExit):
        run_keff_search.main()


# ---------------------------------------------------------------------------
# Integration: real OpenMC API surface (skipped when openmc is absent)
# ---------------------------------------------------------------------------


def test_search_for_keff_signature_matches_driver_assumptions():
    pytest.importorskip("openmc")
    import inspect

    from openmc.search import search_for_keff

    params = inspect.signature(search_for_keff).parameters
    for expected in (
        "model_builder",
        "initial_guess",
        "target",
        "bracket",
        "tol",
        "bracketed_method",
        "print_iterations",
        "run_args",
    ):
        assert expected in params, f"search_for_keff missing parameter {expected}"
