"""Edge-case tests for plugins.openmc.lib.output_readers.

``test_openmc_output_readers.py`` covers the documented layouts and the
openmc/h5py kinetics paths. This module targets the remaining defensive
branches: importing without h5py, glob resolution, non-track datasets,
empty collision filters, mesh-group scalar decoding, optional particle
restart fields, and the delayed-group filter guards.
"""

import importlib.util
import sys
import types
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")
pytest.importorskip("h5py")

from plugins.openmc.lib import output_readers  # noqa: E402


@pytest.fixture
def h5py():
    return pytest.importorskip("h5py")


def _track_dtype():
    position = [("x", "<f8"), ("y", "<f8"), ("z", "<f8")]
    return np.dtype(
        [
            ("r", position),
            ("u", position),
            ("E", "<f8"),
            ("time", "<f8"),
            ("wgt", "<f8"),
            ("cell_id", "<i4"),
            ("cell_instance", "<i4"),
            ("material_id", "<i4"),
        ]
    )


def _collision_dtype():
    position = [("x", "<f8"), ("y", "<f8"), ("z", "<f8")]
    return np.dtype(
        [
            ("r", position),
            ("E", "<f8"),
            ("dE", "<f8"),
            ("time", "<f8"),
            ("wgt", "<f8"),
            ("event_mt", "<i4"),
            ("cell_id", "<i4"),
            ("nuclide_id", "<i4"),
            ("material_id", "<i4"),
            ("particle", "<i4"),
        ]
    )


# ---------------------------------------------------------------------------
# Import without h5py
# ---------------------------------------------------------------------------


def test_module_import_without_h5py():
    """The module degrades to HAS_H5PY=False and reports it from readers."""
    spec = importlib.util.spec_from_file_location(
        "_output_readers_without_h5py", Path(output_readers.__file__)
    )
    isolated = importlib.util.module_from_spec(spec)
    original = sys.modules.get("h5py")
    sys.modules["h5py"] = None
    try:
        spec.loader.exec_module(isolated)
    finally:
        if original is None:
            sys.modules.pop("h5py", None)
        else:
            sys.modules["h5py"] = original

    assert isolated.HAS_H5PY is False
    with pytest.raises(isolated.OutputReaderError, match="h5py not installed"):
        isolated._require_h5py()


# ---------------------------------------------------------------------------
# File resolution and track datasets
# ---------------------------------------------------------------------------


def test_resolve_output_files_glob_returns_matches(tmp_path):
    path = tmp_path / "tracks.h5"
    path.write_bytes(b"")

    files = output_readers.resolve_output_files(str(tmp_path / "*.h5"), ("tracks.h5",))

    assert files == [str(path)]


def test_read_tracks_info_skips_non_track_datasets(tmp_path, h5py):
    """Datasets that do not match track_<b>_<g>_<p> are ignored."""
    states = np.zeros(3, dtype=_track_dtype())
    states["r"]["x"] = [0.0, 1.0, 2.0]
    path = tmp_path / "tracks.h5"
    with h5py.File(path, "w") as handle:
        handle.create_dataset("notes", data=[1, 2])
        dset = handle.create_dataset("track_1_1_0", data=states)
        dset.attrs["offsets"] = [0, 3]
        dset.attrs["particles"] = [2112]

    info = output_readers.read_tracks_info(str(path))

    assert info["nTracks"] == 1
    assert info["totalStates"] == 3
    assert info["tracks"][0]["dataset"] == "track_1_1_0"


def test_read_collision_track_data_filter_matches_nothing(tmp_path, h5py):
    """An empty filtered selection still returns aligned (empty) columns."""
    bank = np.zeros(2, dtype=_collision_dtype())
    bank["event_mt"] = [2, 18]
    path = tmp_path / "collision_track.h5"
    with h5py.File(path, "w") as handle:
        handle.create_dataset("collision_track_bank", data=bank)

    data = output_readers.read_collision_track_data(str(path), mt_filter=[999])

    assert data["matchedCollisions"] == 0
    assert data["returned"] == 0
    assert data["collisions"]["positions"] == []
    assert data["collisions"]["energies"] == []
    assert data["collisions"]["eventMt"] == []


# ---------------------------------------------------------------------------
# Mesh-group decoding and weight-window extras
# ---------------------------------------------------------------------------


def _write_weight_windows(path, h5py, with_max_ratio=True):
    with h5py.File(path, "w") as handle:
        meshes = handle.create_group("meshes")
        mesh = meshes.create_group("mesh 1")
        mesh.create_dataset("dimension", data=[2, 2, 2])
        mesh.create_dataset("lower_left", data=[0.0, 0.0, 0.0])
        mesh.create_dataset("upper_right", data=[1.0, 1.0, 1.0])
        mesh.create_dataset("label", data=b"regular")
        mesh.create_dataset("cells", data=np.int32(8))
        mesh.create_dataset("ratio", data=np.float64(1.25))

        windows = handle.create_group("weight_windows")
        window = windows.create_group("weight_windows_1")
        window.create_dataset("mesh", data=1)
        window.create_dataset("particle_type", data=b"neutron")
        window.create_dataset("energy_bounds", data=[0.0, 1.0])
        window.create_dataset("lower_ww_bounds", data=[0.5] * 8)
        window.create_dataset("upper_ww_bounds", data=[2.5] * 8)
        window.create_dataset("survival_ratio", data=3.0)
        window.create_dataset("max_split", data=5)
        window.create_dataset("weight_cutoff", data=0.25)
        if with_max_ratio:
            window.create_dataset("max_lower_bound_ratio", data=0.125)


def test_read_weight_windows_decodes_mesh_scalars_and_max_ratio(tmp_path, h5py):
    path = tmp_path / "weight_windows.h5"
    _write_weight_windows(path, h5py)

    result = output_readers.read_weight_windows(str(path))

    (mesh,) = result["meshes"]
    assert mesh["label"] == "regular"
    assert mesh["cells"] == 8
    assert mesh["ratio"] == pytest.approx(1.25)
    assert result["weightWindows"][0]["maxLowerBoundRatio"] == pytest.approx(0.125)


# ---------------------------------------------------------------------------
# Particle restart extras
# ---------------------------------------------------------------------------


def test_read_particle_restart_missing_file(tmp_path):
    with pytest.raises(output_readers.OutputReaderError, match="File not found"):
        output_readers.read_particle_restart(str(tmp_path / "particle_restart.h5"))


def test_read_particle_restart_optional_fields_default_to_none(tmp_path, h5py):
    """A minimal restart file omits optional scalars and file attributes."""
    path = tmp_path / "particle_restart.h5"
    with h5py.File(path, "w") as handle:
        handle.create_dataset("current_batch", data=1)
        handle.create_dataset("current_generation", data=2)
        handle.create_dataset("id", data=7)
        handle.create_dataset("type", data=2112)
        handle.create_dataset("energy", data=1.0e6)
        handle.create_dataset("xyz", data=[0.0, 0.0, 0.0])
        handle.create_dataset("uvw", data=[0.0, 0.0, 1.0])

    result = output_readers.read_particle_restart(str(path))

    assert result["filetype"] is None
    assert result["version"] is None
    assert result["generationsPerBatch"] is None
    assert result["nParticles"] is None
    assert result["runMode"] is None
    assert result["weight"] is None
    assert result["time"] is None
    assert result["particle"] == "neutron"


# ---------------------------------------------------------------------------
# IFP tally helpers
# ---------------------------------------------------------------------------


def test_find_ifp_tallies_skips_non_tally_groups(tmp_path, h5py):
    path = tmp_path / "statepoint.h5"
    with h5py.File(path, "w") as handle:
        tallies = handle.create_group("tallies")
        tallies.create_dataset("not_a_tally", data=[1])
        tallies.create_group("tally 2")
        tally = tallies.create_group("tally 1")
        tally.create_dataset("score_bins", data=np.array([b"ifp-denominator"]))

        found = output_readers._find_ifp_tallies(handle)

    assert set(found) == {"ifp-denominator"}


def test_delayed_group_count_rejects_non_delayed_group_tallies(tmp_path, h5py):
    """Only a single-filter DelayedGroupFilter tally reports a group count."""
    path = tmp_path / "statepoint.h5"
    with h5py.File(path, "w") as handle:
        tallies = handle.create_group("tallies")
        filters = tallies.create_group("filters")
        delayed = filters.create_group("filter 1")
        delayed.create_dataset("type", data=b"delayedgroup")
        delayed.create_dataset("n_bins", data=2)
        cell = filters.create_group("filter 2")
        cell.create_dataset("type", data=b"cell")
        cell.create_dataset("n_bins", data=3)

        multiple = tallies.create_group("tally 1")
        multiple.create_dataset("filters", data=[1, 2])
        missing = tallies.create_group("tally 2")
        missing.create_dataset("filters", data=[9])
        wrong_type = tallies.create_group("tally 3")
        wrong_type.create_dataset("filters", data=[2])

        assert output_readers._delayed_group_count(handle, multiple) is None
        assert output_readers._delayed_group_count(handle, missing) is None
        assert output_readers._delayed_group_count(handle, wrong_type) is None


# ---------------------------------------------------------------------------
# read_kinetics dispatches to the openmc path
# ---------------------------------------------------------------------------


def test_read_kinetics_returns_openmc_result(tmp_path, monkeypatch):
    class FakeUfloat:
        nominal_value = 2.0e-6
        std_dev = 1.0e-7

    class FakeStatePoint:
        def __init__(self, path):
            pass

        def get_kinetics_parameters(self):
            return types.SimpleNamespace(generation_time=FakeUfloat(), beta_effective=None)

        keff = None

    fake_openmc = types.ModuleType("openmc")
    fake_openmc.StatePoint = FakeStatePoint
    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)

    path = tmp_path / "statepoint.h5"
    path.write_bytes(b"fake")

    result = output_readers.read_kinetics(str(path))

    assert result["method"] == "openmc"
    assert result["generationTime"] == {"mean": 2.0e-6, "stdDev": 1.0e-7}
    assert result["betaEffective"] is None
