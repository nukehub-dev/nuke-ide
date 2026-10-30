"""Edge-case tests for run_depletion helpers and driver branches.

The OpenMC model, chain, operators, and integrators are recording stubs
shared with test_run_depletion_run.py; no transport solve executes. These
tests target capability probes, config validation, DAGMC universe syncing,
the continuation/transfer-rate branches, and clean error reporting.
"""

import importlib.util
import json
import os
import sys
import types
from types import SimpleNamespace

import pytest
import run_depletion
from test_run_depletion_advanced import _args as _advanced_args
from test_run_depletion_advanced import _FakeMaterial as _AdvancedMaterial
from test_run_depletion_advanced import _FakeOpenMC
from test_run_depletion_run import (
    FakeMaterial,
    RecordingIntegrator,
    RecordingOperator,
    _args,
    _install_fake_openmc,
    _workdir,
)

pytestmark = pytest.mark.skipif(
    importlib.util.find_spec("openmc") is None,
    reason="DAGMC/OpenMC depletion helpers require openmc",
)


@pytest.fixture(autouse=True)
def _restore_cwd():
    """run_depletion chdirs into the working directory; undo that per test."""
    cwd = os.getcwd()
    yield
    os.chdir(cwd)


@pytest.fixture()
def chain_file(tmp_path):
    chain = tmp_path / "chain.xml"
    chain.write_text("<depletion_chain/>")
    return str(chain)


@pytest.fixture()
def previous_results(tmp_path):
    path = tmp_path / "depletion_results.h5"
    path.write_text("h5")
    return str(path)


# ---------------------------------------------------------------------------
# Capability probes and option parsing
# ---------------------------------------------------------------------------


class TestCapabilityProbes:
    @pytest.mark.parametrize("error", [ImportError, TypeError, ValueError])
    def test_option_probe_failure_returns_false(self, monkeypatch, error):
        """An uninspectable Integrator makes the option probe fail closed."""

        def boom():
            raise error("no integrator")

        monkeypatch.setattr(run_depletion, "get_integrator_class", boom)
        assert run_depletion.supports_integrator_option("substeps") is False

    def test_method_probe_import_failure_returns_false(self, monkeypatch):
        """An unavailable deplete package makes the method probe fail closed."""

        def boom():
            raise ImportError("no openmc.deplete")

        monkeypatch.setattr(run_depletion, "get_integrator_class", boom)
        assert run_depletion.supports_integrator_method("add_keff_search_control") is False

    def test_invalid_json_option_is_a_config_error(self):
        with pytest.raises(run_depletion.DepletionConfigError, match="Invalid JSON for --x"):
            run_depletion.parse_json_option("{not json", "--x")

    def test_absent_json_option_is_none(self):
        assert run_depletion.parse_json_option(None, "--x") is None


class TestLoadPreviousResults:
    def _install_deplete(self, monkeypatch, results=None):
        fake_openmc = types.ModuleType("openmc")
        fake_deplete = types.ModuleType("openmc.deplete")
        fake_openmc.deplete = fake_deplete
        if results is not None:
            fake_deplete.Results = results
        monkeypatch.setitem(sys.modules, "openmc", fake_openmc)
        monkeypatch.setitem(sys.modules, "openmc.deplete", fake_deplete)
        return fake_deplete

    def test_missing_results_class_is_actionable(self, monkeypatch, tmp_path):
        """OpenMC without openmc.deplete.Results reports the 0.15.1 requirement."""
        self._install_deplete(monkeypatch)
        with pytest.raises(run_depletion.DepletionConfigError, match="0.15.1 or newer"):
            run_depletion.load_previous_results(str(tmp_path / "results.h5"))

    def test_read_failure_is_wrapped(self, monkeypatch, tmp_path):
        """A corrupt results file becomes a clean DepletionConfigError."""
        path = tmp_path / "results.h5"
        path.write_text("not hdf5")

        def corrupt(path):
            raise RuntimeError("bad magic")

        self._install_deplete(monkeypatch, corrupt)
        with pytest.raises(
            run_depletion.DepletionConfigError, match="Could not read previous depletion"
        ):
            run_depletion.load_previous_results(str(path))

    def test_success_returns_results_object(self, monkeypatch, tmp_path):
        sentinel = object()
        path = tmp_path / "results.h5"
        path.write_text("h5")
        self._install_deplete(monkeypatch, lambda p: sentinel)

        assert run_depletion.load_previous_results(str(path)) is sentinel


# ---------------------------------------------------------------------------
# Reactivity-control validation
# ---------------------------------------------------------------------------


def _cell_control(**overrides):
    control = {
        "enabled": True,
        "parameter": "cell-translation",
        "cellId": 7,
        "axis": "z",
        "x0": 0.0,
        "x1": 10.0,
        "bracket": [-20.0, 20.0],
    }
    control.update(overrides)
    return control


class _RaisingControl:
    def run(self, value):
        raise ValueError("Search for keff failed to converge")


class _RecordingIntegrator:
    def __init__(self):
        self.calls = []
        self._keff_search_control = _RaisingControl()

    def add_keff_search_control(self, function, **kwargs):
        self.calls.append((function, kwargs))


class TestReactivityControlValidation:
    def test_not_configured_is_a_noop(self):
        integrator = _RecordingIntegrator()
        run_depletion.apply_reactivity_control(integrator, None)
        run_depletion.apply_reactivity_control(integrator, {"enabled": False})
        assert integrator.calls == []

    def test_unsupported_api_is_a_config_error(self, monkeypatch):
        monkeypatch.setattr(run_depletion, "supports_integrator_method", lambda method: False)
        with pytest.raises(run_depletion.DepletionConfigError, match="requires OpenMC 0.16"):
            run_depletion.apply_reactivity_control(_RecordingIntegrator(), _cell_control())

    def test_cell_translation_requires_an_axis(self):
        with pytest.raises(run_depletion.DepletionConfigError, match="needs an axis"):
            run_depletion.build_reactivity_modifier(_cell_control(axis="q"))

    def test_nuclide_density_requires_a_nuclide(self):
        control = _cell_control(parameter="nuclide-density", materialId=1, nuclide="")
        with pytest.raises(run_depletion.DepletionConfigError, match="needs a nuclide"):
            run_depletion.build_reactivity_modifier(control)

    def test_unknown_parameter_is_rejected(self):
        with pytest.raises(run_depletion.DepletionConfigError, match="must be 'cell-translation'"):
            run_depletion.build_reactivity_modifier(_cell_control(parameter="bogus"))

    @pytest.mark.parametrize(
        ("overrides", "message"),
        [
            ({"x0": "low"}, "numeric x0 and x1"),
            ({"bracket": 5}, "bracket must be"),
            ({"bracket": [20, -20]}, "bracket must be increasing"),
            ({"x0": 1.0, "x1": 1.0}, "guesses x0/x1 must differ"),
        ],
    )
    def test_interval_validation_messages(self, monkeypatch, overrides, message):
        """Each malformed search interval gets its own actionable error."""
        monkeypatch.setattr(run_depletion, "supports_integrator_method", lambda method: True)
        with pytest.raises(run_depletion.DepletionConfigError, match=message):
            run_depletion.apply_reactivity_control(
                _RecordingIntegrator(), _cell_control(**overrides)
            )

    def test_warn_on_failure_wraps_the_search_control(self, monkeypatch, capsys):
        """onFailure='warn' replaces the control's run with a tolerant wrapper."""
        monkeypatch.setattr(run_depletion, "supports_integrator_method", lambda method: True)
        integrator = _RecordingIntegrator()

        run_depletion.apply_reactivity_control(integrator, _cell_control(onFailure="warn"))

        ((function, kwargs),) = integrator.calls
        assert kwargs["x0"] == 0.0 and kwargs["x1"] == 10.0
        assert integrator._keff_search_control.run(1.0) is None
        assert "reactivity search did not converge" in capsys.readouterr().err

    def test_missing_control_attribute_is_a_noop(self):
        """install_warn_on_search_failure leaves integrators without a control alone."""
        run_depletion.install_warn_on_search_failure(SimpleNamespace())


# ---------------------------------------------------------------------------
# External source rates
# ---------------------------------------------------------------------------


class _RateIntegrator:
    timesteps = [1.0, 1.0]

    def __init__(self):
        self.calls = []

    def add_external_source_rate(self, material, composition, rate, **kwargs):
        self.calls.append((material, composition, rate, kwargs))


def _rate(**overrides):
    row = {
        "material": 1,
        "composition": [{"name": "U235", "weightPercent": 100}],
        "rate": 1e-6,
    }
    row.update(overrides)
    return row


class TestExternalSourceRateValidation:
    def test_empty_rates_is_a_noop(self):
        integrator = _RateIntegrator()
        run_depletion.apply_external_source_rates(integrator, [])
        assert integrator.calls == []

    def test_unsupported_api_is_a_config_error(self, monkeypatch):
        monkeypatch.setattr(run_depletion, "supports_integrator_method", lambda method: False)
        with pytest.raises(run_depletion.DepletionConfigError, match="0.15.3 or newer"):
            run_depletion.apply_external_source_rates(_RateIntegrator(), [_rate()])

    @pytest.mark.parametrize(
        ("row", "message"),
        [
            (
                {
                    "material": 1,
                    "composition": [{"name": "", "weightPercent": 100}],
                    "rate": 1,
                },
                "positive weight percents",
            ),
            (
                {
                    "material": 1,
                    "composition": [{"name": "U235", "weightPercent": 0}],
                    "rate": 1,
                },
                "positive weight percents",
            ),
            (
                {
                    "material": 1,
                    "composition": [
                        {"name": "U235", "weightPercent": 50},
                        {"name": "U235", "weightPercent": 50},
                    ],
                    "rate": 1,
                },
                "repeats 'U235'",
            ),
            ({"material": 1, "composition": [], "rate": 1}, "empty composition"),
            (_rate(material=0), "positive material ID"),
            (_rate(rate=0), "non-zero rate"),
            (_rate(rate=None), "non-zero rate"),
            (_rate(timesteps="first"), "non-negative whole indices"),
            (_rate(timesteps=[-1]), "non-negative whole indices"),
            (_rate(timesteps=[2]), "references timestep 2"),
        ],
    )
    def test_invalid_rows_are_rejected(self, row, message):
        with pytest.raises(run_depletion.DepletionConfigError, match=message):
            run_depletion.apply_external_source_rates(_RateIntegrator(), [row])

    def test_valid_row_forwards_units_and_timesteps(self, capsys):
        integrator = _RateIntegrator()
        row = _rate(units="kg/s", timesteps=[0])

        run_depletion.apply_external_source_rates(integrator, [row])

        assert integrator.calls == [
            (
                1,
                {"U235": 100.0},
                1e-6,
                {"rate_units": "kg/s", "timesteps": [0]},
            )
        ]
        err = capsys.readouterr().err
        assert "External source rate: material 1" in err
        assert "timesteps [0]" in err

    def test_valid_row_without_timesteps_mentions_all_steps(self, capsys):
        run_depletion.apply_external_source_rates(_RateIntegrator(), [_rate()])
        assert "(all steps)" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# DAGMC universe synchronization
# ---------------------------------------------------------------------------


def _install_dagmc_openmc(monkeypatch, universes, cell_fills):
    """Install a fake openmc with DAGMC classes and a lib cell map."""
    fake_openmc = types.ModuleType("openmc")

    class FakeDAGMCUniverse:
        def __init__(self, uid):
            self.id = uid
            self.cells = []

        def add_cell(self, cell):
            self.cells.append(cell)

    class FakeDAGMCCell:
        def __init__(self, cell_id, fill):
            self.cell_id = cell_id
            self.fill = fill

    fake_openmc.DAGMCUniverse = FakeDAGMCUniverse
    fake_openmc.DAGMCCell = FakeDAGMCCell
    fake_openmc.lib = SimpleNamespace(
        dagmc=SimpleNamespace(dagmc_universe_cell_ids=lambda uid: list(cell_fills[uid])),
        cells={cid: SimpleNamespace(fill=fill) for cid, fill in cell_fills["lib"].items()},
    )
    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)
    return fake_openmc


class _SyncModel:
    def __init__(self, universes, materials, fail_sync=False):
        self.universes = list(universes)
        self.materials = list(materials)
        self.fail_sync = fail_sync
        self.init_calls = 0
        self.finalize_calls = 0
        self.determined_paths = 0
        self.geometry = SimpleNamespace(
            get_all_universes=lambda: {u.id: u for u in self.universes},
            determine_paths=self._determine_paths,
        )

    def init_lib(self, output=True):
        self.init_calls += 1

    def finalize_lib(self):
        self.finalize_calls += 1

    def sync_dagmc_universes(self):
        if self.fail_sync:
            raise RuntimeError("compact tag layout")
        for universe in self.universes:
            universe.add_cell("upstream")

    def _determine_paths(self):
        self.determined_paths += 1


class TestSyncDagmcUniverses:
    def test_without_dagmc_support_returns_zero(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "openmc", types.ModuleType("openmc"))
        assert run_depletion.sync_dagmc_universes_for_depletion(SimpleNamespace()) == 0

    def test_without_dagmc_universes_returns_zero(self, monkeypatch):
        _install_dagmc_openmc(monkeypatch, [], {"lib": {}})
        model = _SyncModel([], [])
        assert run_depletion.sync_dagmc_universes_for_depletion(model) == 0

    def test_upstream_sync_short_circuits(self, monkeypatch):
        fake_openmc = _install_dagmc_openmc(monkeypatch, [], {"lib": {}})
        universe = fake_openmc.DAGMCUniverse(1)
        universe.cells = ["already"]
        model = _SyncModel([universe], [])

        assert run_depletion.sync_dagmc_universes_for_depletion(model) == 1
        assert model.init_calls == 0

    def test_fallback_enumerates_cells_and_fills(self, monkeypatch, capsys):
        """A failing upstream sync falls back to lib cell enumeration."""
        fake_openmc = _install_dagmc_openmc(
            monkeypatch,
            [],
            {
                1: [10],
                2: [11, 12, 13],
                "lib": {
                    11: [SimpleNamespace(id=1), None],
                    12: SimpleNamespace(id=2),
                    13: None,
                },
            },
        )
        material1 = SimpleNamespace(id=1)
        material2 = SimpleNamespace(id=2)
        synced = fake_openmc.DAGMCUniverse(1)
        synced.cells = ["from-upstream"]
        pending = fake_openmc.DAGMCUniverse(2)
        model = _SyncModel([synced, pending], [material1, material2], fail_sync=True)

        count = run_depletion.sync_dagmc_universes_for_depletion(model)

        assert count == 4  # 1 already-synced + 3 enumerated
        assert model.init_calls == 1 and model.finalize_calls == 1
        assert model.determined_paths == 1
        assert [c.cell_id for c in pending.cells] == [11, 12, 13]
        assert pending.cells[0].fill == [material1]
        assert pending.cells[1].fill is material2
        assert pending.cells[2].fill is None
        assert "falling back to direct lib cell enumeration" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# run_depletion branch coverage
# ---------------------------------------------------------------------------


class TestRunDepletionBranches:
    def test_threads_are_logged(self, monkeypatch, tmp_path, chain_file, capsys):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        run_depletion.run_depletion(_args(workdir, chain_file=chain_file, threads=2))

        assert "2 OpenMP thread(s) per rank" in capsys.readouterr().err

    def test_none_substeps_defaults_to_one(self, monkeypatch, tmp_path, chain_file):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        result = run_depletion.run_depletion(_args(workdir, chain_file=chain_file, substeps=None))

        (integrator,) = RecordingIntegrator.instances
        assert integrator.kwargs == {}
        assert result["substeps"] == 1

    def test_continue_timesteps_requires_support(
        self, monkeypatch, tmp_path, chain_file, previous_results
    ):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        monkeypatch.setattr(run_depletion, "load_previous_results", lambda path: object())
        monkeypatch.setattr(run_depletion, "supports_integrator_option", lambda option: False)
        workdir = _workdir(tmp_path)

        with pytest.raises(run_depletion.DepletionConfigError, match="requires OpenMC 0.15.1"):
            run_depletion.run_depletion(
                _args(
                    workdir,
                    chain_file=chain_file,
                    continue_from_results=previous_results,
                    continue_timesteps=True,
                )
            )

    def test_decay_only_steps_accepts_a_list(self, monkeypatch, tmp_path, chain_file):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        result = run_depletion.run_depletion(
            _args(workdir, chain_file=chain_file, decay_only_steps=[1, 1])
        )

        assert result["decayOnlySteps"] == [1]

    def test_invalid_decay_only_steps_are_a_config_error(self, monkeypatch, tmp_path, chain_file):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        with pytest.raises(run_depletion.DepletionConfigError, match="zero-based integers"):
            run_depletion.run_depletion(
                _args(workdir, chain_file=chain_file, decay_only_steps="first")
            )

    def test_external_source_rates_must_be_a_list(self, monkeypatch, tmp_path, chain_file):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        with pytest.raises(run_depletion.DepletionConfigError, match="must be a JSON list"):
            run_depletion.run_depletion(
                _args(
                    workdir,
                    chain_file=chain_file,
                    external_source_rates=json.dumps({"material": 1}),
                )
            )

    def test_diff_burnable_mats_and_fission_q_reach_the_operator(
        self, monkeypatch, tmp_path, chain_file
    ):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        workdir = _workdir(tmp_path)

        run_depletion.run_depletion(
            _args(
                workdir,
                chain_file=chain_file,
                diff_burnable_mats=True,
                diff_volume_method="match cell",
                fission_q=json.dumps({"U235": 2.02e8}),
            )
        )

        (operator,) = RecordingOperator.instances
        assert operator.kwargs["diff_burnable_mats"] is True
        assert operator.kwargs["diff_volume_method"] == "match cell"
        assert operator.kwargs["fission_q"] == {"U235": 2.02e8}

    def test_depletion_config_error_from_operator_is_not_wrapped(
        self, monkeypatch, tmp_path, chain_file
    ):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])

        def fail_sync(model):
            raise run_depletion.DepletionConfigError("DAGMC sync failed")

        monkeypatch.setattr(run_depletion, "sync_dagmc_universes_for_depletion", fail_sync)
        workdir = _workdir(tmp_path)

        with pytest.raises(run_depletion.DepletionConfigError, match="DAGMC sync failed"):
            run_depletion.run_depletion(_args(workdir, chain_file=chain_file))

    def test_integrator_value_error_propagates_when_not_continuing(
        self, monkeypatch, tmp_path, chain_file
    ):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])

        class RejectingIntegrator(RecordingIntegrator):
            def __init__(self, *args, **kwargs):
                raise ValueError("bad power schedule")

        sys.modules["openmc.deplete"].CECMIntegrator = RejectingIntegrator
        workdir = _workdir(tmp_path)

        with pytest.raises(ValueError, match="bad power schedule"):
            run_depletion.run_depletion(_args(workdir, chain_file=chain_file))

    def test_transfer_rates_reach_the_integrator(self, monkeypatch, tmp_path, chain_file):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])
        rates = [
            {
                "material": 1,
                "element": "U",
                "rate": 1e-5,
                "units": "1/s",
                "destinationMaterial": 2,
            }
        ]
        workdir = _workdir(tmp_path)

        run_depletion.run_depletion(
            _args(workdir, chain_file=chain_file, transfer_rates=json.dumps(rates))
        )

        (integrator,) = RecordingIntegrator.instances
        assert integrator.transfer_rate_calls == [
            (1, ["U"], 1e-5, {"transfer_rate_units": "1/s", "destination_material": 2})
        ]

    def test_keff_search_failure_becomes_a_config_error(self, monkeypatch, tmp_path, chain_file):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])

        class SearchFailingIntegrator(RecordingIntegrator):
            def integrate(self):
                raise ValueError("Search for keff failed to converge after 50 iterations")

        sys.modules["openmc.deplete"].CECMIntegrator = SearchFailingIntegrator
        workdir = _workdir(tmp_path)

        with pytest.raises(
            run_depletion.DepletionConfigError, match="did not converge during depletion"
        ):
            run_depletion.run_depletion(_args(workdir, chain_file=chain_file))

    def test_generic_integration_value_error_propagates(
        self, monkeypatch, tmp_path, chain_file, capsys
    ):
        _install_fake_openmc(monkeypatch, materials=[FakeMaterial("fuel")])

        class TransportFailingIntegrator(RecordingIntegrator):
            def integrate(self):
                raise ValueError("transport diverged")

        sys.modules["openmc.deplete"].CECMIntegrator = TransportFailingIntegrator
        workdir = _workdir(tmp_path)

        with pytest.raises(ValueError, match="transport diverged"):
            run_depletion.run_depletion(_args(workdir, chain_file=chain_file))
        assert "Error during depletion: transport diverged" in capsys.readouterr().err


class TestBuildIndependentOperatorFiles:
    def test_flux_and_microxs_files_with_previous_results(self, monkeypatch, tmp_path):
        fake = _FakeOpenMC()
        monkeypatch.setitem(sys.modules, "openmc", fake)
        flux = tmp_path / "flux.npy"
        (tmp_path / "micro.csv").write_text("x")
        import numpy as np

        np.save(flux, np.array([1.0, 2.0]))
        sentinel = object()
        args = _advanced_args(
            flux_files=str(flux),
            microxs_files=str(tmp_path / "micro.csv"),
        )

        op = run_depletion.build_independent_operator(
            args,
            model="model",
            materials=[_AdvancedMaterial(1)],
            chain="chain",
            fission_q=None,
            prev_results=sentinel,
        )

        assert op.fluxes[0].tolist() == [1.0, 2.0]
        assert op.micros == [("MicroXS", str(tmp_path / "micro.csv"))]
        assert op.kwargs["prev_results"] is sentinel


# ---------------------------------------------------------------------------
# main() clean config-error reporting
# ---------------------------------------------------------------------------


def test_main_reports_config_error_without_traceback(monkeypatch, capsys):
    def fail(args):
        raise run_depletion.DepletionConfigError("bad configuration")

    monkeypatch.setattr(run_depletion, "run_depletion", fail)
    monkeypatch.setattr(sys, "argv", ["run_depletion.py", "/tmp/model", "--time-steps", "1"])

    assert run_depletion.main() == 1
    captured = capsys.readouterr()
    assert json.loads(captured.out) == {"success": False, "error": "bad configuration"}
    assert "FAILED: bad configuration" in captured.err
    assert "Traceback" not in captured.err
