"""Edge-case tests for the CMFD and criticality-search drivers.

Reuses the stub OpenMC harnesses from test_run_cmfd.py and
test_run_keff_search.py. Covers JSON fallbacks, malformed settings values,
MPI plumbing, statepoint read failures, unsupported geometry paths, and the
zero-sibling nuclide renormalization branch. No transport solve executes.
"""

import os
import sys
import types
from types import SimpleNamespace

import pytest
import run_cmfd
import run_keff_search
import test_run_cmfd as cmfd_harness
import test_run_keff_search as keff_harness


@pytest.fixture(autouse=True)
def _restore_cwd():
    """Both drivers chdir into the working directory; undo that per test."""
    cwd = os.getcwd()
    yield
    os.chdir(cwd)


# ---------------------------------------------------------------------------
# Shared JSON fallback encoder
# ---------------------------------------------------------------------------


class _ArrayLike:
    def tolist(self):
        return [1, 2, 3]


@pytest.mark.parametrize("module", [run_cmfd, run_keff_search])
def test_json_safe_scalar_array_like_and_object(module):
    """Each driver's fallback encoder handles scalars, arrays, and objects."""
    assert module._json_safe(SimpleNamespace(item=lambda: 7)) == 7
    assert module._json_safe(_ArrayLike()) == [1, 2, 3]
    assert module._json_safe(object()).startswith("<object object at")


@pytest.mark.parametrize("module", [run_cmfd, run_keff_search])
def test_json_safe_handles_multi_element_numpy_arrays(module):
    """Multi-element arrays expose item() but must use tolist() first."""
    np = pytest.importorskip("numpy")
    assert module._json_safe(np.array([1.0, 2.0])) == [1.0, 2.0]


# ---------------------------------------------------------------------------
# read_run_basics malformed values
# ---------------------------------------------------------------------------


def test_read_run_basics_ignores_non_integer_counts(tmp_path):
    """Non-numeric particles/inactive values are omitted, not raised."""
    (tmp_path / "settings.xml").write_text(
        "<settings><run_mode>eigenvalue</run_mode>"
        "<particles>many</particles><batches>10</batches><inactive>off</inactive>"
        "</settings>"
    )

    assert run_cmfd.read_run_basics(tmp_path) == {"runMode": "eigenvalue", "batches": 10}


# ---------------------------------------------------------------------------
# MPI wiring
# ---------------------------------------------------------------------------


def test_mpi_request_without_mpi4py_is_actionable(monkeypatch, tmp_path):
    """MPI > 1 with no mpi4py raises an explanatory ImportError."""
    cmfd_harness._install_fake_openmc(monkeypatch)
    workdir = cmfd_harness._make_workdir(tmp_path)
    monkeypatch.setitem(sys.modules, "mpi4py", None)

    with pytest.raises(ImportError, match="mpi4py is not available"):
        run_cmfd.run_cmfd(cmfd_harness._args(workdir, mpi_processes=2))


def test_mpi_request_forwards_the_world_communicator(monkeypatch, tmp_path, capsys):
    """MPI > 1 hands MPI.COMM_WORLD to the C API init kwargs."""
    cmfd_harness._install_fake_openmc(monkeypatch)
    workdir = cmfd_harness._make_workdir(tmp_path)
    world = object()
    fake_mpi = types.ModuleType("mpi4py")
    fake_mpi.MPI = SimpleNamespace(COMM_WORLD=world)
    monkeypatch.setitem(sys.modules, "mpi4py", fake_mpi)

    result = run_cmfd.run_cmfd(cmfd_harness._args(workdir, mpi_processes=2))

    assert result["success"] is True
    (run,) = cmfd_harness.RecordingCMFDRun.instances
    assert run.run_kwargs == {"intracomm": world}
    assert "MPI with 2 processes" in capsys.readouterr().err


def test_mpi_processes_one_does_not_require_mpi4py(monkeypatch, tmp_path):
    """A single-process run never imports mpi4py."""
    cmfd_harness._install_fake_openmc(monkeypatch)
    workdir = cmfd_harness._make_workdir(tmp_path)
    monkeypatch.setitem(sys.modules, "mpi4py", None)

    result = run_cmfd.run_cmfd(cmfd_harness._args(workdir, mpi_processes=1))

    assert result["success"] is True
    (run,) = cmfd_harness.RecordingCMFDRun.instances
    assert run.run_kwargs == {}


def test_statepoint_read_failure_keeps_the_run_result(monkeypatch, tmp_path, capsys):
    """An unreadable statepoint leaves kEff unset but reports the run."""
    fake_openmc = cmfd_harness._install_fake_openmc(monkeypatch)
    workdir = cmfd_harness._make_workdir(tmp_path)

    class BrokenStatePoint:
        def __init__(self, path):
            raise RuntimeError("truncated statepoint")

    fake_openmc.StatePoint = BrokenStatePoint

    result = run_cmfd.run_cmfd(cmfd_harness._args(workdir))

    assert result["success"] is True
    assert result["statepoint"] == str(workdir / "statepoint.100.h5")
    assert result["kEff"] is None
    assert "could not extract k-eff" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# Criticality-search parameter edge cases
# ---------------------------------------------------------------------------


def test_geometry_parameter_must_be_temperature():
    """Only geometry.<cell>.temperature is part of the vocabulary."""
    model = keff_harness._make_model()

    with pytest.raises(ValueError, match="Unsupported geometry parameter"):
        run_keff_search.apply_search_parameter(model, "geometry.fuel.density", 1.0)


def test_nuclide_fraction_with_zero_percent_siblings_uses_equal_split():
    """Zero-percent same-element siblings share the remaining fraction."""
    material = SimpleNamespace(
        name="fuel",
        nuclides=[
            SimpleNamespace(name="U235", percent=0.5, percent_type="ao"),
            SimpleNamespace(name="U238", percent=0.0, percent_type="ao"),
        ],
    )
    model = SimpleNamespace(materials=[material])

    run_keff_search.apply_search_parameter(model, "fuel.U235", 0.3)

    u235, u238 = material.nuclides
    assert u235.percent == 0.3
    assert u238.percent == pytest.approx(0.2)
