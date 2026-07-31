"""Tests for run_cmfd (CMFD acceleration driver).

The real CMFD run never executes: openmc and openmc.cmfd are replaced with
recording stubs, so config parsing, mesh/knob mapping, eigenvalue guard, and
result reporting are all exercised without OpenMC installed. Each test runs
in a tmp working directory and restores the process CWD afterwards. The only
test that touches real OpenMC is the importorskip signature check at the end.
"""

import json
import os
import sys
import types
from types import SimpleNamespace

import pytest
import run_cmfd


@pytest.fixture(autouse=True)
def _restore_cwd():
    """run_cmfd chdirs into the working directory; undo that per test."""
    cwd = os.getcwd()
    yield
    os.chdir(cwd)


# ---------------------------------------------------------------------------
# Stub builders
# ---------------------------------------------------------------------------


class RecordingCMFDMesh:
    """Records attribute assignments made by the driver."""

    instances = []

    def __init__(self):
        self.assignments = {}
        RecordingCMFDMesh.instances.append(self)

    def __setattr__(self, name, value):
        if name != "assignments":
            self.assignments[name] = value
        super().__setattr__(name, value)


class RecordingCMFDRun:
    """Records attribute assignments and run() invocation."""

    instances = []
    fail_on_run = False

    def __init__(self):
        self.assignments = {}
        self.ran = False
        self.run_kwargs = None
        RecordingCMFDRun.instances.append(self)

    def __setattr__(self, name, value):
        if name not in ("assignments", "ran", "run_kwargs"):
            self.assignments[name] = value
        super().__setattr__(name, value)

    def run(self, **kwargs):
        if RecordingCMFDRun.fail_on_run:
            raise RuntimeError("C API run failed")
        self.ran = True
        self.run_kwargs = kwargs


def _install_fake_openmc(monkeypatch):
    """Insert stub openmc/openmc.cmfd modules; returns the fake openmc."""
    fake_openmc = types.ModuleType("openmc")
    fake_cmfd = types.ModuleType("openmc.cmfd")
    fake_cmfd.CMFDMesh = RecordingCMFDMesh
    fake_cmfd.CMFDRun = RecordingCMFDRun
    fake_openmc.cmfd = fake_cmfd

    fake_keff = SimpleNamespace(n=1.05123, s=0.00421)

    class FakeStatePoint:
        def __init__(self, path):
            self.path = path
            self.keff = fake_keff

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    fake_openmc.StatePoint = FakeStatePoint

    RecordingCMFDMesh.instances = []
    RecordingCMFDRun.instances = []
    RecordingCMFDRun.fail_on_run = False

    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)
    monkeypatch.setitem(sys.modules, "openmc.cmfd", fake_cmfd)
    return fake_openmc


SETTINGS_XML = """<?xml version='1.0' encoding='utf-8'?>
<settings>
  <run_mode>eigenvalue</run_mode>
  <particles>1000</particles>
  <batches>100</batches>
  <inactive>20</inactive>
</settings>
"""

FULL_CONFIG = {
    "mesh": {
        "lowerLeft": [-10.0, -5.0, -1.0],
        "upperRight": [10.0, 5.0, 1.0],
        "dimension": [10, 5, 1],
        "albedo": [0, 0, 0.5, 1, 1, 1],
    },
    "feedback": True,
    "tallyBegin": 5,
    "solverBegin": 10,
    "cmfdKtol": 1e-7,
    "stol": 1e-6,
    "norm": 0.95,
    "gaussSeidelTolerance": [1e-12, 1e-6],
    "downscatter": True,
    "powerMonitor": True,
    "windowType": "rolling",
    "windowSize": 7,
    "runAdjoint": True,
    "adjointType": "math",
}


def _make_workdir(tmp_path, settings_xml=SETTINGS_XML, with_statepoint=True):
    """Create a working directory with settings.xml (and a dummy statepoint)."""
    if settings_xml is not None:
        (tmp_path / "settings.xml").write_text(settings_xml)
    if with_statepoint:
        (tmp_path / "statepoint.100.h5").write_bytes(b"fake")
    return tmp_path


def _args(workdir, config=FULL_CONFIG, mpi_processes=None):
    return SimpleNamespace(
        working_directory=str(workdir),
        cmfd_config=json.dumps(config),
        mpi_processes=mpi_processes,
    )


# ---------------------------------------------------------------------------
# read_run_basics
# ---------------------------------------------------------------------------


def test_read_run_basics_parses_settings_xml(tmp_path):
    _make_workdir(tmp_path, with_statepoint=False)
    basics = run_cmfd.read_run_basics(tmp_path)
    assert basics == {"runMode": "eigenvalue", "particles": 1000, "batches": 100, "inactive": 20}


def test_read_run_basics_missing_file(tmp_path):
    assert run_cmfd.read_run_basics(tmp_path) == {}


# ---------------------------------------------------------------------------
# apply_cmfd_config
# ---------------------------------------------------------------------------


def test_apply_cmfd_config_maps_all_knobs():
    mesh = RecordingCMFDMesh()
    run = RecordingCMFDRun()
    run_cmfd.apply_cmfd_config(run, mesh, FULL_CONFIG)

    assert mesh.assignments["lower_left"] == [-10.0, -5.0, -1.0]
    assert mesh.assignments["upper_right"] == [10.0, 5.0, 1.0]
    assert mesh.assignments["dimension"] == [10, 5, 1]
    assert mesh.assignments["albedo"] == [0, 0, 0.5, 1, 1, 1]

    assert run.assignments["mesh"] is mesh
    assert run.assignments["feedback"] is True
    assert run.assignments["tally_begin"] == 5
    assert run.assignments["solver_begin"] == 10
    assert run.assignments["cmfd_ktol"] == 1e-7
    assert run.assignments["stol"] == 1e-6
    assert run.assignments["norm"] == 0.95
    assert run.assignments["gauss_seidel_tolerance"] == [1e-12, 1e-6]
    assert run.assignments["downscatter"] is True
    assert run.assignments["power_monitor"] is True
    assert run.assignments["window_type"] == "rolling"
    assert run.assignments["window_size"] == 7
    assert run.assignments["run_adjoint"] is True
    assert run.assignments["adjoint_type"] == "math"


def test_apply_cmfd_config_minimal_uses_defaults():
    mesh = RecordingCMFDMesh()
    run = RecordingCMFDRun()
    minimal = {"mesh": {"lowerLeft": [0, 0, 0], "upperRight": [1, 1, 1], "dimension": [2, 2, 2]}}
    run_cmfd.apply_cmfd_config(run, mesh, minimal)

    assert mesh.assignments["albedo"] == [1, 1, 1, 1, 1, 1]
    assert run.assignments["feedback"] is False
    # Optional knobs are left untouched so OpenMC defaults apply
    assert "tally_begin" not in run.assignments
    assert "window_type" not in run.assignments
    assert "run_adjoint" not in run.assignments


def test_apply_cmfd_config_requires_complete_mesh():
    with pytest.raises(ValueError, match="incomplete"):
        run_cmfd.apply_cmfd_config(
            RecordingCMFDRun(), RecordingCMFDMesh(), {"mesh": {"lowerLeft": [0, 0, 0]}}
        )
    with pytest.raises(ValueError, match="incomplete"):
        run_cmfd.apply_cmfd_config(RecordingCMFDRun(), RecordingCMFDMesh(), {})


def test_apply_cmfd_config_rejects_bad_albedo():
    config = {
        "mesh": {
            "lowerLeft": [0, 0, 0],
            "upperRight": [1, 1, 1],
            "dimension": [2, 2, 2],
            "albedo": [1, 1],
        }
    }
    with pytest.raises(ValueError, match="albedo"):
        run_cmfd.apply_cmfd_config(RecordingCMFDRun(), RecordingCMFDMesh(), config)


# ---------------------------------------------------------------------------
# run_cmfd with stub openmc
# ---------------------------------------------------------------------------


def test_run_cmfd_builds_and_runs(monkeypatch, tmp_path):
    _install_fake_openmc(monkeypatch)
    workdir = _make_workdir(tmp_path)

    result = run_cmfd.run_cmfd(_args(workdir))

    assert result["success"] is True
    assert result["statepoint"] == str(workdir / "statepoint.100.h5")
    assert result["kEff"] == {"mean": pytest.approx(1.05123), "std": pytest.approx(0.00421)}
    assert result["feedback"] is True
    assert result["run"]["batches"] == 100

    run = RecordingCMFDRun.instances[0]
    assert run.ran is True
    assert run.run_kwargs == {}
    assert run.assignments["mesh"] is RecordingCMFDMesh.instances[0]


def test_run_cmfd_without_statepoint_still_succeeds(monkeypatch, tmp_path):
    _install_fake_openmc(monkeypatch)
    workdir = _make_workdir(tmp_path, with_statepoint=False)

    result = run_cmfd.run_cmfd(_args(workdir))
    assert result["success"] is True
    assert result["statepoint"] is None
    assert result["kEff"] is None


def test_run_cmfd_rejects_fixed_source_mode(monkeypatch, tmp_path):
    _install_fake_openmc(monkeypatch)
    workdir = _make_workdir(
        tmp_path, settings_xml=SETTINGS_XML.replace("eigenvalue", "fixed source")
    )

    with pytest.raises(ValueError, match="eigenvalue"):
        run_cmfd.run_cmfd(_args(workdir))
    assert RecordingCMFDRun.instances == [] or not RecordingCMFDRun.instances[0].ran


def test_run_cmfd_missing_settings_xml(monkeypatch, tmp_path):
    _install_fake_openmc(monkeypatch)
    with pytest.raises(FileNotFoundError, match="settings.xml"):
        run_cmfd.run_cmfd(_args(tmp_path))


def test_run_cmfd_propagates_run_failure(monkeypatch, tmp_path):
    _install_fake_openmc(monkeypatch)
    RecordingCMFDRun.fail_on_run = True
    workdir = _make_workdir(tmp_path)

    with pytest.raises(RuntimeError, match="C API run failed"):
        run_cmfd.run_cmfd(_args(workdir))


# ---------------------------------------------------------------------------
# main() CLI contract: exactly one JSON object on stdout
# ---------------------------------------------------------------------------


def test_main_success_prints_one_json_object(monkeypatch, tmp_path, capsys):
    _install_fake_openmc(monkeypatch)
    workdir = _make_workdir(tmp_path)
    monkeypatch.setattr(
        sys, "argv", ["run_cmfd.py", str(workdir), "--cmfd-config", json.dumps(FULL_CONFIG)]
    )

    assert run_cmfd.main() == 0
    out = capsys.readouterr().out.strip()
    payload = json.loads(out)  # single parseable JSON object
    assert payload["success"] is True
    assert payload["kEff"]["mean"] == pytest.approx(1.05123)


def test_main_failure_prints_error_json(monkeypatch, tmp_path, capsys):
    _install_fake_openmc(monkeypatch)
    monkeypatch.setattr(
        sys, "argv", ["run_cmfd.py", str(tmp_path), "--cmfd-config", json.dumps(FULL_CONFIG)]
    )

    assert run_cmfd.main() == 1
    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["success"] is False
    assert "settings.xml" in payload["error"]


def test_main_requires_cmfd_config(monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "argv", ["run_cmfd.py", str(tmp_path)])
    with pytest.raises(SystemExit):
        run_cmfd.main()


# ---------------------------------------------------------------------------
# Integration: real OpenMC API surface (skipped when openmc is absent)
# ---------------------------------------------------------------------------


def test_cmfd_api_surface_matches_driver_assumptions():
    pytest.importorskip("openmc")
    import openmc.cmfd as cmfd_mod

    for attr in ("lower_left", "upper_right", "dimension", "albedo"):
        assert hasattr(cmfd_mod.CMFDMesh, attr), f"CMFDMesh.{attr} missing"
    for attr in (
        "mesh",
        "feedback",
        "tally_begin",
        "solver_begin",
        "cmfd_ktol",
        "stol",
        "norm",
        "gauss_seidel_tolerance",
        "downscatter",
        "power_monitor",
        "window_type",
        "window_size",
        "run_adjoint",
        "adjoint_type",
    ):
        assert hasattr(cmfd_mod.CMFDRun, attr), f"CMFDRun.{attr} missing"
    assert callable(cmfd_mod.CMFDRun.run)
