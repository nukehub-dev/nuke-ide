"""Tests for plugins.openmc.lib.output_readers and its command wrappers.

Pure-logic tests (decimation, JSON encoding, filters, error paths with
dependencies forced absent) need only pytest + numpy. Integration tests that
build synthetic HDF5 fixtures are guarded by pytest.importorskip("h5py") and
match the layouts written by OpenMC (src/track_output.cpp,
src/collision_track.cpp, src/weight_windows.cpp, openmc/tallies.py).
"""

import argparse
import json
import sys

import pytest

np = pytest.importorskip("numpy")

from nuke_viz.plugin import setup_parser_for_handler  # noqa: E402
from plugins.openmc.commands import collision_track as collision_track_cmds  # noqa: E402
from plugins.openmc.commands import kinetics as kinetics_cmds  # noqa: E402
from plugins.openmc.commands import particle_restart as particle_restart_cmds  # noqa: E402
from plugins.openmc.commands import tracks as tracks_cmds  # noqa: E402
from plugins.openmc.commands import weight_windows as weight_windows_cmds  # noqa: E402
from plugins.openmc.lib import output_readers  # noqa: E402


def _parse(handler, argv):
    """Build a real parser for the handler and parse argv with it."""
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(handler, parser)
    return parser.parse_args(argv)


def _stdout_json(capsys):
    """Decode the single JSON object printed on stdout."""
    out = capsys.readouterr().out.strip()
    return json.loads(out)


# ---------------------------------------------------------------------------
# Pure logic: decimation
# ---------------------------------------------------------------------------


def test_decimate_indices_short_sequence_returns_all():
    idx = output_readers.decimate_indices(10, 100)
    assert idx.tolist() == list(range(10))


def test_decimate_indices_no_limit_returns_all():
    idx = output_readers.decimate_indices(10, 0)
    assert idx.tolist() == list(range(10))
    idx = output_readers.decimate_indices(10, None)
    assert idx.tolist() == list(range(10))


def test_decimate_indices_caps_and_keeps_endpoints():
    idx = output_readers.decimate_indices(1000, 100)
    assert len(idx) <= 100
    assert idx[0] == 0
    assert idx[-1] == 999
    # Evenly strided (except the possible final endpoint hop)
    diffs = np.diff(idx)
    assert diffs.max() - diffs.min() <= 9


def test_decimate_indices_empty():
    assert output_readers.decimate_indices(0, 10).tolist() == []


# ---------------------------------------------------------------------------
# Pure logic: JSON encoding hook
# ---------------------------------------------------------------------------


def test_json_default_handles_numpy_and_bytes():
    payload = {
        "array": np.array([1, 2, 3]),
        "int": np.int32(7),
        "float": np.float64(1.5),
        "bool": np.bool_(True),
        "bytes": b"neutron",
    }
    decoded = json.loads(json.dumps(payload, default=output_readers.json_default))
    assert decoded == {
        "array": [1, 2, 3],
        "int": 7,
        "float": 1.5,
        "bool": True,
        "bytes": "neutron",
    }


def test_json_default_rejects_unknown_types():
    with pytest.raises(TypeError):
        json.dumps({"x": object()}, default=output_readers.json_default)


# ---------------------------------------------------------------------------
# Pure logic: particle filter mapping
# ---------------------------------------------------------------------------


def test_particle_pdg_names_and_numbers():
    assert output_readers.particle_pdg("neutron") == 2112
    assert output_readers.particle_pdg("photon") == 22
    assert output_readers.particle_pdg("electron") == 11
    assert output_readers.particle_pdg("positron") == -11
    assert output_readers.particle_pdg("2112") == 2112
    assert output_readers.particle_pdg(None) is None


def test_particle_pdg_rejects_unknown():
    with pytest.raises(output_readers.OutputReaderError):
        output_readers.particle_pdg("muon")


# ---------------------------------------------------------------------------
# Pure logic: ratio uncertainty propagation
# ---------------------------------------------------------------------------


def test_ratio_with_uncertainty_math():
    mean, std = output_readers.ratio_with_uncertainty(5.0, 0.3, 10.0, 0.2)
    assert mean == pytest.approx(0.5)
    assert std == pytest.approx(0.5 * ((0.3 / 5.0) ** 2 + (0.2 / 10.0) ** 2) ** 0.5)


def test_ratio_with_uncertainty_zero_denominator():
    with pytest.raises(output_readers.OutputReaderError):
        output_readers.ratio_with_uncertainty(1.0, 0.1, 0.0, 0.1)


# ---------------------------------------------------------------------------
# Pure logic: file resolution errors (no h5py needed)
# ---------------------------------------------------------------------------


def test_resolve_output_files_missing_file():
    with pytest.raises(output_readers.OutputReaderError, match="File not found"):
        output_readers.resolve_output_files("/no/such/tracks.h5", ("tracks.h5",))


def test_resolve_output_files_glob_no_match():
    with pytest.raises(output_readers.OutputReaderError, match="No files match"):
        output_readers.resolve_output_files("/no/such/dir/tracks_p*.h5", ("tracks.h5",))


def test_resolve_output_files_empty_directory(tmp_path):
    with pytest.raises(output_readers.OutputReaderError, match="No files matching"):
        output_readers.resolve_output_files(str(tmp_path), ("tracks.h5", "tracks_p*.h5"))


def test_resolve_output_files_directory_sorting(tmp_path):
    for name in ("tracks_p2.h5", "tracks.h5", "tracks_p10.h5", "tracks_p1.h5"):
        (tmp_path / name).write_bytes(b"")
    files = output_readers.resolve_output_files(str(tmp_path), ("tracks.h5", "tracks_p*.h5"))
    assert [f.rsplit("/", 1)[-1] for f in files] == [
        "tracks.h5",
        "tracks_p1.h5",
        "tracks_p10.h5",
        "tracks_p2.h5",
    ]


# ---------------------------------------------------------------------------
# Missing-dependency error paths (HAS_H5PY forced off)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "call",
    [
        lambda: output_readers.read_tracks_info("x.h5"),
        lambda: output_readers.read_tracks_data("x.h5"),
        lambda: output_readers.read_collision_track_info("x.h5"),
        lambda: output_readers.read_collision_track_data("x.h5"),
        lambda: output_readers.read_weight_windows("x.h5"),
        lambda: output_readers.read_kinetics("x.h5"),
        lambda: output_readers.read_particle_restart("x.h5"),
    ],
)
def test_readers_report_missing_h5py(monkeypatch, call):
    monkeypatch.setattr(output_readers, "HAS_H5PY", False)
    with pytest.raises(output_readers.OutputReaderError, match="h5py not installed"):
        call()


@pytest.mark.parametrize(
    "handler,argv",
    [
        (tracks_cmds.cmd_tracks_info, ["tracks.h5"]),
        (tracks_cmds.cmd_tracks_data, ["tracks.h5"]),
        (collision_track_cmds.cmd_collision_track_info, ["collision_track.h5"]),
        (collision_track_cmds.cmd_collision_track_data, ["collision_track.h5"]),
        (weight_windows_cmds.cmd_weight_windows, ["weight_windows.h5"]),
        (kinetics_cmds.cmd_kinetics, ["statepoint.h5"]),
        (particle_restart_cmds.cmd_particle_restart, ["particle_restart.h5"]),
    ],
)
def test_commands_report_missing_h5py(monkeypatch, capsys, handler, argv):
    """Commands convert the missing-h5py failure to a JSON error, exit 1."""
    monkeypatch.setattr(output_readers, "HAS_H5PY", False)
    args = _parse(handler, argv)
    rc = handler(args)
    assert rc == 1
    assert "h5py not installed" in _stdout_json(capsys)["error"]


def test_commands_missing_file(tmp_path, capsys):
    """With h5py present (or forced on), a missing file is a JSON error, exit 1."""
    if not output_readers.HAS_H5PY:
        pytest.skip("requires h5py to reach the file check")
    args = _parse(tracks_cmds.cmd_tracks_info, [str(tmp_path / "nope.h5")])
    rc = tracks_cmds.cmd_tracks_info(args)
    assert rc == 1
    assert "File not found" in _stdout_json(capsys)["error"]


def test_tracks_data_rejects_bad_particle_filter(tmp_path, capsys):
    if not output_readers.HAS_H5PY:
        pytest.skip("requires h5py to reach the filter parsing")
    (tmp_path / "tracks.h5").write_bytes(b"")
    args = _parse(tracks_cmds.cmd_tracks_data, [str(tmp_path / "tracks.h5"), "--particle", "muon"])
    rc = tracks_cmds.cmd_tracks_data(args)
    assert rc == 1
    assert "Unknown particle filter" in _stdout_json(capsys)["error"]


# ---------------------------------------------------------------------------
# h5py integration fixtures matching the real OpenMC layouts
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def h5py():
    """h5py module, skipping only the integration tests that need it."""
    return pytest.importorskip("h5py")


def _track_dtype():
    pos = [("x", "<f8"), ("y", "<f8"), ("z", "<f8")]
    return np.dtype(
        [
            ("r", pos),
            ("u", pos),
            ("E", "<f8"),
            ("time", "<f8"),
            ("wgt", "<f8"),
            ("cell_id", "<i4"),
            ("cell_instance", "<i4"),
            ("material_id", "<i4"),
        ]
    )


def _make_states(n, x0=0.0):
    """Synthetic TrackState array: x increases, u = +z, E/time/wgt constant."""
    states = np.zeros(n, dtype=_track_dtype())
    states["r"]["x"] = x0 + np.arange(n, dtype=float)
    states["r"]["y"] = 1.0
    states["r"]["z"] = 2.0
    states["u"]["z"] = 1.0
    states["E"] = 1.0e6
    states["time"] = np.arange(n, dtype=float) * 1e-9
    states["wgt"] = 1.0
    states["cell_id"] = 5
    return states


def _write_track_dset(f, name, segments):
    """Write one track_<b>_<g>_<p> dataset; segments = [(pdg, states), ...]."""
    offsets = [0]
    particles = []
    arrays = []
    for pdg, states in segments:
        particles.append(pdg)
        arrays.append(states)
        offsets.append(offsets[-1] + len(states))
    data = np.concatenate(arrays)
    dset = f.create_dataset(name, data=data)
    dset.attrs["n_particles"] = len(segments)
    dset.attrs["offsets"] = offsets
    dset.attrs["particles"] = particles


@pytest.fixture
def tracks_file(tmp_path, h5py):
    """tracks.h5 with two tracks: (batch 1, gen 1, pid 0) neutron+photon,
    (batch 1, gen 2, pid 7) neutron only."""
    path = tmp_path / "tracks.h5"
    with h5py.File(path, "w") as f:
        f.attrs["filetype"] = "track"
        f.attrs["version"] = [3, 1]
        _write_track_dset(
            f, "track_1_1_0", [(2112, _make_states(10)), (22, _make_states(5, x0=100.0))]
        )
        _write_track_dset(f, "track_1_2_7", [(2112, _make_states(4, x0=200.0))])
    return path


def test_read_tracks_info(tracks_file):
    info = output_readers.read_tracks_info(str(tracks_file))
    assert info["nTracks"] == 2
    assert info["totalStates"] == 19
    first, second = info["tracks"]
    assert (first["batch"], first["generation"], first["particleId"]) == (1, 1, 0)
    assert first["nStates"] == 15
    assert first["segments"] == [
        {"particle": "neutron", "pdg": 2112, "nStates": 10},
        {"particle": "photon", "pdg": 22, "nStates": 5},
    ]
    assert (second["batch"], second["generation"], second["particleId"]) == (1, 2, 7)


def test_read_tracks_data_decimates_and_flattens(tracks_file):
    data = output_readers.read_tracks_data(str(tracks_file), max_points_per_track=4)
    assert data["totalTracks"] == 2
    assert data["returnedTracks"] == 2
    neutron = data["tracks"][0]["segments"][0]
    assert neutron["nStates"] == 10
    assert len(neutron["positions"]) <= 4
    # Endpoints survive decimation
    assert neutron["positions"][0][0] == pytest.approx(0.0)
    assert neutron["positions"][-1][0] == pytest.approx(9.0)
    assert len(neutron["positions"]) == len(neutron["energies"]) == len(neutron["cellIds"])


def test_read_tracks_data_particle_filter(tracks_file):
    data = output_readers.read_tracks_data(str(tracks_file), particle_filter="photon")
    first = data["tracks"][0]
    assert len(first["segments"]) == 1
    assert first["segments"][0]["particle"] == "photon"
    # The neutron-only second track ends up with no segments
    assert data["tracks"][1]["segments"] == []


def test_read_tracks_data_pagination(tracks_file):
    page = output_readers.read_tracks_data(str(tracks_file), offset=1, limit=1)
    assert page["totalTracks"] == 2
    assert page["returnedTracks"] == 1
    assert page["tracks"][0]["dataset"] == "track_1_2_7"


def test_read_tracks_combines_mpi_files(tmp_path, h5py):
    """A directory with tracks_p0.h5 + tracks_p1.h5 reads as one logical file."""
    for rank in (0, 1):
        with h5py.File(tmp_path / f"tracks_p{rank}.h5", "w") as f:
            f.attrs["filetype"] = "track"
            f.attrs["version"] = [3, 1]
            _write_track_dset(f, f"track_1_1_{rank}", [(2112, _make_states(3, x0=rank))])
    info = output_readers.read_tracks_info(str(tmp_path))
    assert info["nTracks"] == 2
    assert len(info["files"]) == 2


# ---------------------------------------------------------------------------
# Collision track integration
# ---------------------------------------------------------------------------


def _collision_dtype():
    pos = [("x", "<f8"), ("y", "<f8"), ("z", "<f8")]
    return np.dtype(
        [
            ("r", pos),
            ("u", pos),
            ("E", "<f8"),
            ("dE", "<f8"),
            ("time", "<f8"),
            ("wgt", "<f8"),
            ("event_mt", "<i4"),
            ("delayed_group", "<i4"),
            ("cell_id", "<i4"),
            ("nuclide_id", "<i4"),
            ("material_id", "<i4"),
            ("universe_id", "<i4"),
            ("n_collision", "<i4"),
            ("particle", "<i4"),
            ("parent_id", "<i8"),
            ("progeny_id", "<i8"),
        ]
    )


@pytest.fixture
def collision_track_file(tmp_path, h5py):
    """collision_track.h5 with 6 collisions across two MTs and two cells."""
    bank = np.zeros(6, dtype=_collision_dtype())
    bank["r"]["x"] = np.arange(6, dtype=float)
    bank["E"] = [1e6, 2e6, 3e6, 4e6, 5e6, 6e6]
    bank["dE"] = 1e5
    bank["time"] = 1e-9
    bank["wgt"] = 1.0
    bank["event_mt"] = [2, 2, 18, 102, 18, 2]
    bank["cell_id"] = [1, 1, 2, 2, 1, 2]
    bank["particle"] = 0
    path = tmp_path / "collision_track.h5"
    with h5py.File(path, "w") as f:
        f.attrs["filetype"] = "collision_track"
        f.attrs["version"] = [1, 2]
        f.create_dataset("collision_track_bank", data=bank)
    return path


def test_read_collision_track_info(collision_track_file):
    info = output_readers.read_collision_track_info(str(collision_track_file))
    assert info["nCollisions"] == 6
    assert "event_mt" in info["columns"]
    assert "r" in info["columns"]


def test_read_collision_track_data_unfiltered(collision_track_file):
    data = output_readers.read_collision_track_data(str(collision_track_file))
    assert data["totalCollisions"] == 6
    assert data["matchedCollisions"] == 6
    assert data["returned"] == 6
    assert data["collisions"]["energies"] == [1e6, 2e6, 3e6, 4e6, 5e6, 6e6]
    assert data["collisions"]["positions"][3][0] == pytest.approx(3.0)


def test_read_collision_track_data_mt_filter(collision_track_file):
    data = output_readers.read_collision_track_data(str(collision_track_file), mt_filter=[18])
    assert data["matchedCollisions"] == 2
    assert data["collisions"]["eventMt"] == [18, 18]


def test_read_collision_track_data_cell_filter(collision_track_file):
    data = output_readers.read_collision_track_data(str(collision_track_file), cell_filter=[1])
    assert data["matchedCollisions"] == 3
    assert data["collisions"]["cellIds"] == [1, 1, 1]


def test_read_collision_track_data_combined_filters_and_limit(collision_track_file):
    data = output_readers.read_collision_track_data(
        str(collision_track_file), mt_filter=[2], cell_filter=[1], offset=1, limit=1
    )
    assert data["matchedCollisions"] == 2
    assert data["returned"] == 1
    assert data["collisions"]["energies"] == [2e6]


def test_read_collision_track_missing_bank(tmp_path, h5py):
    bad = tmp_path / "collision_track.h5"
    with h5py.File(bad, "w") as f:
        f.create_dataset("something_else", data=[1])
    with pytest.raises(output_readers.OutputReaderError, match="collision_track_bank"):
        output_readers.read_collision_track_info(str(bad))


# ---------------------------------------------------------------------------
# Weight windows integration
# ---------------------------------------------------------------------------


@pytest.fixture
def weight_windows_file(tmp_path, h5py):
    """weight_windows.h5: one regular 2x3x4 mesh, one neutron weight window
    with 2 energy bins (bounds stored flat, C-order (n_energy, nz, ny, nx))."""
    path = tmp_path / "weight_windows.h5"
    with h5py.File(path, "w") as f:
        f.attrs["filetype"] = "weight_windows"
        f.attrs["version"] = [1, 0]
        meshes = f.create_group("meshes")
        meshes.attrs["n_meshes"] = 1
        meshes.attrs["ids"] = [1]
        mesh = meshes.create_group("mesh 1")
        mesh.create_dataset("dimension", data=[2, 3, 4])
        mesh.create_dataset("lower_left", data=[-1.0, -2.0, -3.0])
        mesh.create_dataset("upper_right", data=[1.0, 2.0, 3.0])

        ww = f.create_group("weight_windows")
        ww.attrs["n_weight_windows"] = 1
        ww.attrs["ids"] = [1]
        group = ww.create_group("weight_windows_1")
        group.create_dataset("mesh", data=1)
        group.create_dataset("particle_type", data=b"neutron")
        group.create_dataset("energy_bounds", data=[1.0e-5, 1.0e-1, 2.0e7])
        n = 2 * 4 * 3 * 2
        group.create_dataset("lower_ww_bounds", data=np.arange(n, dtype=float) * 0.1)
        group.create_dataset("upper_ww_bounds", data=np.arange(n, dtype=float) * 0.5)
        group.create_dataset("survival_ratio", data=3.0)
        group.create_dataset("max_split", data=5)
        group.create_dataset("weight_cutoff", data=0.25)
    return path


def test_read_weight_windows(weight_windows_file):
    result = output_readers.read_weight_windows(str(weight_windows_file))
    assert result["meshes"] == [
        {
            "id": 1,
            "type": "regular",
            "dimension": [2, 3, 4],
            "lower_left": [-1.0, -2.0, -3.0],
            "upper_right": [1.0, 2.0, 3.0],
        }
    ]
    (window,) = result["weightWindows"]
    assert window["id"] == 1
    assert window["meshId"] == 1
    assert window["particleType"] == "neutron"
    assert window["energyBounds"] == [1.0e-5, 1.0e-1, 2.0e7]
    assert window["boundsShape"] == [2, 4, 3, 2]
    assert len(window["lowerBounds"]) == 48
    assert window["lowerBounds"][0] == pytest.approx(0.0)
    assert window["upperBounds"][-1] == pytest.approx(47 * 0.5)
    assert window["survivalRatio"] == pytest.approx(3.0)
    assert window["maxSplit"] == 5
    assert window["weightCutoff"] == pytest.approx(0.25)
    assert window["maxLowerBoundRatio"] is None


def test_read_weight_windows_missing_group(tmp_path, h5py):
    bad = tmp_path / "weight_windows.h5"
    with h5py.File(bad, "w") as f:
        f.create_dataset("nope", data=[1])
    with pytest.raises(output_readers.OutputReaderError, match="weight_windows"):
        output_readers.read_weight_windows(str(bad))


# ---------------------------------------------------------------------------
# Kinetics (IFP) integration — h5py fallback with openmc forced absent
# ---------------------------------------------------------------------------


@pytest.fixture
def ifp_statepoint(tmp_path, h5py):
    """Statepoint with one IFP tally (denominator, time and beta numerators).

    Moments follow openmc/tallies.py: mean = sum/n,
    std = sqrt((sum_sq/n - mean**2)/(n-1)) with n = 10 realizations.
    Chosen so denominator -> (10, 0.2), time -> (5, 0.3), beta -> (0.7, 0.1).
    """
    path = tmp_path / "statepoint.h5"
    with h5py.File(path, "w") as f:
        f.create_dataset("k_combined", data=[1.0, 0.001])
        tallies = f.create_group("tallies")
        tally = tallies.create_group("tally 1")
        tally.attrs["name"] = "ifp"
        tally.create_dataset("n_realizations", data=10)
        tally.create_dataset(
            "score_bins",
            data=np.array([b"ifp-denominator", b"ifp-time-numerator", b"ifp-beta-numerator"]),
        )
        tally.create_dataset("nuclides", data=np.array([b"total"]))
        results = np.zeros((1, 3, 2))
        results[0, 0] = [100.0, 1003.6]
        results[0, 1] = [50.0, 258.1]
        results[0, 2] = [7.0, 5.8]
        tally.create_dataset("results", data=results)
    return path


def test_read_kinetics_h5py_fallback(ifp_statepoint, monkeypatch):
    monkeypatch.setitem(sys.modules, "openmc", None)
    result = output_readers.read_kinetics(str(ifp_statepoint))

    assert result["method"] == "h5py"
    assert result["keff"]["mean"] == pytest.approx(1.0)

    beta = result["betaEffective"]
    assert beta["mean"] == pytest.approx(0.07)
    expected_std = 0.07 * ((0.1 / 0.7) ** 2 + (0.2 / 10.0) ** 2) ** 0.5
    assert beta["stdDev"] == pytest.approx(expected_std)
    assert result["betaEffectiveGroups"] == [beta]

    gen_time = result["generationTime"]
    assert gen_time["mean"] == pytest.approx(0.5)
    expected_gt_std = 0.5 * ((0.3 / 5.0) ** 2 + (0.2 / 10.0) ** 2) ** 0.5
    assert gen_time["stdDev"] == pytest.approx(expected_gt_std)


def test_read_kinetics_delayed_groups(tmp_path, monkeypatch, h5py):
    """A DelayedGroupFilter as the only filter splits beta per group."""
    monkeypatch.setitem(sys.modules, "openmc", None)
    path = tmp_path / "statepoint.h5"
    with h5py.File(path, "w") as f:
        f.create_dataset("k_combined", data=[1.0, 0.001])
        tallies = f.create_group("tallies")

        filters = tallies.create_group("filters")
        filt = filters.create_group("filter 1")
        filt.create_dataset("type", data=b"delayedgroup")
        filt.create_dataset("n_bins", data=2)

        tally = tallies.create_group("tally 1")
        tally.create_dataset("n_realizations", data=10)
        tally.create_dataset("filters", data=[1])
        tally.create_dataset(
            "score_bins", data=np.array([b"ifp-denominator", b"ifp-beta-numerator"])
        )
        tally.create_dataset("nuclides", data=np.array([b"total"]))
        results = np.zeros((2, 2, 2))
        results[:, 0] = [[100.0, 1003.6], [100.0, 1003.6]]  # denominator per group
        results[:, 1] = [[3.5, 5.8], [3.5, 5.8]]  # beta numerator per group
        tally.create_dataset("results", data=results)

    result = output_readers.read_kinetics(str(path))
    assert len(result["betaEffectiveGroups"]) == 2
    for group in result["betaEffectiveGroups"]:
        # denominator collapses to sum=20 over the two filter bins
        assert group["mean"] == pytest.approx(0.35 / 20.0)
    assert result["betaEffective"]["mean"] == pytest.approx(2 * 0.35 / 20.0)
    assert result["generationTime"] is None


def test_read_kinetics_no_ifp_tallies(tmp_path, monkeypatch, h5py):
    monkeypatch.setitem(sys.modules, "openmc", None)
    path = tmp_path / "statepoint.h5"
    with h5py.File(path, "w") as f:
        tallies = f.create_group("tallies")
        tally = tallies.create_group("tally 1")
        tally.create_dataset("score_bins", data=np.array([b"flux"]))
    with pytest.raises(output_readers.OutputReaderError, match="No IFP tallies"):
        output_readers.read_kinetics(str(path))


def test_kinetics_command_success(ifp_statepoint, monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "openmc", None)
    args = _parse(kinetics_cmds.cmd_kinetics, [str(ifp_statepoint)])
    rc = kinetics_cmds.cmd_kinetics(args)
    assert rc == 0
    result = _stdout_json(capsys)
    assert result["betaEffective"]["mean"] == pytest.approx(0.07)


def test_kinetics_command_error(tmp_path, monkeypatch, capsys, h5py):
    monkeypatch.setitem(sys.modules, "openmc", None)
    path = tmp_path / "statepoint.h5"
    with h5py.File(path, "w") as f:
        f.create_dataset("k_combined", data=[1.0, 0.001])
    args = _parse(kinetics_cmds.cmd_kinetics, [str(path)])
    rc = kinetics_cmds.cmd_kinetics(args)
    assert rc == 1
    assert "No IFP tallies" in _stdout_json(capsys)["error"]


# ---------------------------------------------------------------------------
# Command-level success paths over the other readers
# ---------------------------------------------------------------------------


def test_tracks_commands_success(tracks_file, capsys):
    args = _parse(tracks_cmds.cmd_tracks_info, [str(tracks_file)])
    assert tracks_cmds.cmd_tracks_info(args) == 0
    assert _stdout_json(capsys)["nTracks"] == 2

    args = _parse(
        tracks_cmds.cmd_tracks_data,
        [str(tracks_file), "--limit", "1", "--max-points", "3", "--particle", "neutron"],
    )
    assert tracks_cmds.cmd_tracks_data(args) == 0
    data = _stdout_json(capsys)
    assert data["returnedTracks"] == 1
    assert data["tracks"][0]["segments"][0]["particle"] == "neutron"


def test_collision_track_commands_success(collision_track_file, capsys):
    args = _parse(collision_track_cmds.cmd_collision_track_info, [str(collision_track_file)])
    assert collision_track_cmds.cmd_collision_track_info(args) == 0
    assert _stdout_json(capsys)["nCollisions"] == 6

    args = _parse(
        collision_track_cmds.cmd_collision_track_data,
        [str(collision_track_file), "--mt", "18,102", "--limit", "10"],
    )
    assert collision_track_cmds.cmd_collision_track_data(args) == 0
    data = _stdout_json(capsys)
    assert data["matchedCollisions"] == 3


def test_weight_windows_command_success(weight_windows_file, capsys):
    args = _parse(weight_windows_cmds.cmd_weight_windows, [str(weight_windows_file)])
    assert weight_windows_cmds.cmd_weight_windows(args) == 0
    result = _stdout_json(capsys)
    assert result["weightWindows"][0]["particleType"] == "neutron"


# ---------------------------------------------------------------------------
# Particle restart integration (layout: src/particle.cpp write_restart)
# ---------------------------------------------------------------------------


@pytest.fixture
def particle_restart_file(tmp_path, h5py):
    """Synthetic particle restart file matching the C++ writer layout."""
    path = tmp_path / "particle_restart.h5"
    with h5py.File(path, "w") as f:
        f.attrs["filetype"] = "particle restart"
        f.attrs["version"] = [2, 1]
        f.create_dataset("current_batch", data=17)
        f.create_dataset("generations_per_batch", data=1)
        f.create_dataset("current_generation", data=3)
        f.create_dataset("n_particles", data=10000)
        f.create_dataset("run_mode", data=b"eigenvalue")
        f.create_dataset("id", data=42)
        f.create_dataset("type", data=2112)
        f.create_dataset("weight", data=1.5)
        f.create_dataset("energy", data=1.2e6)
        f.create_dataset("time", data=3.4e-7)
        f.create_dataset("xyz", data=[1.0, 2.0, 3.0])
        f.create_dataset("uvw", data=[0.0, 0.0, 1.0])
    return path


def test_read_particle_restart(particle_restart_file):
    result = output_readers.read_particle_restart(str(particle_restart_file))
    assert result["filetype"] == "particle restart"
    assert result["version"] == [2, 1]
    assert result["currentBatch"] == 17
    assert result["currentGeneration"] == 3
    assert result["generationsPerBatch"] == 1
    assert result["nParticles"] == 10000
    assert result["runMode"] == "eigenvalue"
    assert result["particleId"] == 42
    assert result["particle"] == "neutron"
    assert result["pdg"] == 2112
    assert result["weight"] == pytest.approx(1.5)
    assert result["energy"] == pytest.approx(1.2e6)
    assert result["time"] == pytest.approx(3.4e-7)
    assert result["position"] == [1.0, 2.0, 3.0]
    assert result["direction"] == [0.0, 0.0, 1.0]


def test_read_particle_restart_not_a_restart_file(tmp_path, h5py):
    bad = tmp_path / "particle_restart.h5"
    with h5py.File(bad, "w") as f:
        f.create_dataset("something_else", data=[1])
    with pytest.raises(output_readers.OutputReaderError, match="Missing datasets"):
        output_readers.read_particle_restart(str(bad))


def test_particle_restart_command_success(particle_restart_file, capsys):
    args = _parse(particle_restart_cmds.cmd_particle_restart, [str(particle_restart_file)])
    rc = particle_restart_cmds.cmd_particle_restart(args)
    assert rc == 0
    result = _stdout_json(capsys)
    assert result["particle"] == "neutron"
    assert result["energy"] == pytest.approx(1.2e6)


# ---------------------------------------------------------------------------
# json_default numpy/bytes conversions
# ---------------------------------------------------------------------------


def test_json_default_converts_numpy_and_bytes_types():
    """json_default maps numpy scalars/arrays and bytes to JSON-safe values."""
    assert output_readers.json_default(np.array([1, 2])) == [1, 2]
    assert output_readers.json_default(np.int64(7)) == 7
    assert output_readers.json_default(np.float64(2.5)) == 2.5
    assert output_readers.json_default(np.bool_(True)) is True
    assert output_readers.json_default(b"abc") == "abc"


# ---------------------------------------------------------------------------
# Error paths across readers
# ---------------------------------------------------------------------------


def test_resolve_output_files_no_match_raises(tmp_path):
    with pytest.raises(output_readers.OutputReaderError, match="No files match glob"):
        output_readers.resolve_output_files(str(tmp_path / "nomatch*.h5"), ("tracks.h5",))


def test_read_tracks_data_offset_and_limit_validation(tracks_file):
    with pytest.raises(output_readers.OutputReaderError, match="offset must be >= 0"):
        output_readers.read_tracks_data(str(tracks_file), offset=-1)
    with pytest.raises(output_readers.OutputReaderError, match="limit must be > 0"):
        output_readers.read_tracks_data(str(tracks_file), limit=0)


def test_read_collision_track_data_offset_and_limit_validation(tmp_path, h5py):
    path = tmp_path / "collision_track.h5"
    with h5py.File(path, "w") as f:
        bank = f.create_group("collision_track_bank")
        bank.create_dataset("positions", data=np.zeros((0, 3)))
    with pytest.raises(output_readers.OutputReaderError, match="offset must be >= 0"):
        output_readers.read_collision_track_data(str(path), offset=-1)
    with pytest.raises(output_readers.OutputReaderError, match="limit must be > 0"):
        output_readers.read_collision_track_data(str(path), limit=0)


def test_read_collision_track_data_missing_bank_raises(tmp_path, h5py):
    path = tmp_path / "collision_track.h5"
    with h5py.File(path, "w"):
        pass
    with pytest.raises(output_readers.OutputReaderError, match="collision_track_bank"):
        output_readers.read_collision_track_data(str(path))


def test_read_weight_windows_missing_file_raises(tmp_path, h5py):
    with pytest.raises(output_readers.OutputReaderError, match="File not found"):
        output_readers.read_weight_windows(str(tmp_path / "nope.h5"))


def test_read_weight_windows_missing_group_raises(tmp_path, h5py):
    path = tmp_path / "weight_windows.h5"
    with h5py.File(path, "w"):
        pass
    with pytest.raises(output_readers.OutputReaderError, match="weight_windows"):
        output_readers.read_weight_windows(str(path))


def test_read_mesh_group_type_conversions(tmp_path, h5py):
    """Mesh group values convert ndarray/bytes/numpy-scalars to JSON-safe types."""
    path = tmp_path / "weight_windows.h5"
    with h5py.File(path, "w") as f:
        meshes = f.create_group("meshes")
        mesh = meshes.create_group("mesh 7")
        mesh.create_dataset("dimension", data=np.array([2, 2, 2]))
        mesh.attrs["type"] = np.bytes_("regular")
        mesh.attrs["id"] = np.int64(7)
        ww = f.create_group("weight_windows")
        group = ww.create_group("weight_windows_1")
        group.create_dataset("mesh", data=7)
        group.create_dataset("particle_type", data=b"neutron")
        group.create_dataset("energy_bounds", data=[0.0, 1.0])
        group.create_dataset("lower_ww_bounds", data=[0.5] * 8)
        group.create_dataset("upper_ww_bounds", data=[2.5] * 8)
        group.create_dataset("survival_ratio", data=3.0)
        group.create_dataset("max_split", data=5)
        group.create_dataset("weight_cutoff", data=0.25)

    result = output_readers.read_weight_windows(str(path))
    (mesh,) = result["meshes"]
    assert mesh["id"] == 7
    assert mesh["type"] == "regular"
    assert mesh["dimension"] == [2, 2, 2]


def test_read_voxel_info_missing_file_raises(tmp_path, h5py):
    with pytest.raises(output_readers.OutputReaderError, match="File not found"):
        output_readers.read_voxel_info(str(tmp_path / "nope.h5"))


def test_read_voxel_info_missing_data_raises(tmp_path, h5py):
    path = tmp_path / "voxel.h5"
    with h5py.File(path, "w"):
        pass
    with pytest.raises(output_readers.OutputReaderError):
        output_readers.read_voxel_info(str(path))


def test_read_particle_restart_missing_datasets_raises(tmp_path, h5py):
    path = tmp_path / "particle_restart.h5"
    with h5py.File(path, "w") as f:
        f.create_dataset("current_batch", data=1)
    with pytest.raises(output_readers.OutputReaderError, match="Missing datasets"):
        output_readers.read_particle_restart(str(path))


def test_read_kinetics_missing_file_raises(tmp_path, h5py):
    with pytest.raises(output_readers.OutputReaderError, match="File not found"):
        output_readers.read_kinetics(str(tmp_path / "nope.h5"))


def test_tally_score_moments_out_of_range_raises(tmp_path, h5py):
    path = tmp_path / "statepoint.h5"
    with h5py.File(path, "w") as f:
        tally = f.create_group("tally 1")
        tally.create_dataset("n_realizations", data=10)
        tally.create_dataset("results", data=np.zeros((1, 2, 2)))
        with pytest.raises(output_readers.OutputReaderError, match="out of range"):
            output_readers._tally_score_moments(tally, 5)


# ---------------------------------------------------------------------------
# Kinetics via the openmc API path (_read_kinetics_openmc)
# ---------------------------------------------------------------------------


class _FakeUfloat:
    def __init__(self, nominal, std):
        self.nominal_value = nominal
        self.std_dev = std


def _fake_openmc_statepoint(params, keff=None, keff_raises=False):
    """Fake openmc module whose StatePoint serves canned kinetics parameters."""
    import types

    fake = types.ModuleType("openmc")

    class _SP:
        def __init__(self, path):
            pass

        def get_kinetics_parameters(self):
            return params

    if keff_raises:

        class _KeffExplodes:
            @property
            def keff(self):
                raise RuntimeError("no keff")

        class _SPNoKeff(_SP, _KeffExplodes):
            pass

        fake.StatePoint = _SPNoKeff
    else:
        _SP.keff = keff
        fake.StatePoint = _SP
    return fake


def test_read_kinetics_openmc_full(monkeypatch):
    """The openmc path shapes generation time, per-group betas, totals, and keff."""
    params = type(
        "P",
        (),
        {
            "generation_time": _FakeUfloat(2e-6, 1e-7),
            "beta_effective": [_FakeUfloat(0.003, 0.001), _FakeUfloat(0.004, 0.002)],
        },
    )()
    monkeypatch.setitem(
        sys.modules, "openmc", _fake_openmc_statepoint(params, keff=_FakeUfloat(1.01, 0.002))
    )

    result = output_readers._read_kinetics_openmc("ignored.h5")

    assert result["method"] == "openmc"
    assert result["generationTime"] == {"mean": 2e-6, "stdDev": 1e-7}
    assert result["betaEffectiveGroups"] == [
        {"mean": 0.003, "stdDev": 0.001},
        {"mean": 0.004, "stdDev": 0.002},
    ]
    # Total: means sum, independent stds add in quadrature
    assert result["betaEffective"]["mean"] == pytest.approx(0.007)
    assert result["betaEffective"]["stdDev"] == pytest.approx((0.001**2 + 0.002**2) ** 0.5)
    assert result["keff"] == {"mean": 1.01, "stdDev": 0.002}


def test_read_kinetics_openmc_no_ifp_raises(monkeypatch):
    params = type("P", (), {"generation_time": None, "beta_effective": None})()
    monkeypatch.setitem(sys.modules, "openmc", _fake_openmc_statepoint(params))
    with pytest.raises(output_readers.OutputReaderError, match="No IFP tallies found"):
        output_readers._read_kinetics_openmc("ignored.h5")


def test_read_kinetics_openmc_keff_failure_is_ignored(monkeypatch):
    """A failing sp.keff access degrades to keff=None instead of raising."""
    params = type(
        "P", (), {"generation_time": None, "beta_effective": [_FakeUfloat(0.005, 0.001)]}
    )()
    monkeypatch.setitem(sys.modules, "openmc", _fake_openmc_statepoint(params, keff_raises=True))

    result = output_readers._read_kinetics_openmc("ignored.h5")

    assert result["keff"] is None
    assert result["generationTime"] is None
    assert result["betaEffective"]["mean"] == pytest.approx(0.005)


def test_read_kinetics_openmc_import_error_returns_none(monkeypatch):
    monkeypatch.setitem(sys.modules, "openmc", None)
    assert output_readers._read_kinetics_openmc("ignored.h5") is None
