"""Tests for plugins.openmc.lib.output_vtk (VTK export for output viewers).

Pure-logic tests (polyline/grid geometry construction, missing-dependency
error paths) need only pytest + numpy. Tests that build HDF5 fixtures are
guarded by importorskip("h5py"); the end-to-end VTK write is guarded by
importorskip("vtk").
"""

import argparse
import json

import pytest

np = pytest.importorskip("numpy")

from nuke_viz.plugin import setup_parser_for_handler  # noqa: E402
from plugins.openmc.commands import output_vtk as output_vtk_cmds  # noqa: E402
from plugins.openmc.commands import tracks as tracks_cmds  # noqa: E402
from plugins.openmc.lib import output_readers, output_vtk  # noqa: E402


def _parse(handler, argv):
    """Build a real parser for the handler and parse argv with it."""
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(handler, parser)
    return parser.parse_args(argv)


def _stdout_json(capsys):
    """Decode the single JSON object printed on stdout."""
    out = capsys.readouterr().out.strip()
    return json.loads(out)


def _track(batch, generation, pid, segments):
    """Synthetic track dict in read_tracks_data() shape."""
    return {
        "file": "tracks.h5",
        "dataset": f"track_{batch}_{generation}_{pid}",
        "batch": batch,
        "generation": generation,
        "particleId": pid,
        "segments": segments,
    }


def _segment(pdg, positions, energies=None, cell_ids=None):
    n = len(positions)
    return {
        "particle": "neutron" if pdg == 2112 else "photon",
        "pdg": pdg,
        "nStates": n,
        "stride": 1,
        "positions": positions,
        "energies": energies if energies is not None else [1.0e6] * n,
        "times": [0.0] * n,
        "weights": [1.0] * n,
        "cellIds": cell_ids if cell_ids is not None else [1] * n,
    }


# ---------------------------------------------------------------------------
# Pure logic: build_polylines
# ---------------------------------------------------------------------------


def test_build_polylines_geometry_and_scalars():
    tracks = [
        _track(
            1,
            1,
            0,
            [
                _segment(2112, [[0, 0, 0], [1, 0, 0], [2, 0, 0]]),
                _segment(22, [[5, 5, 5], [6, 6, 6]], energies=[2.0e6, 3.0e6], cell_ids=[7, 7]),
            ],
        ),
        _track(2, 1, 3, [_segment(2112, [[9, 9, 9], [10, 9, 9]])]),
    ]
    geometry = output_vtk.build_polylines(tracks)

    assert geometry["points"].shape == (7, 3)
    assert geometry["line_lengths"].tolist() == [3, 2, 2]

    line_arrays = geometry["line_arrays"]
    assert line_arrays["pdg"].tolist() == [2112, 22, 2112]
    assert line_arrays["batch"].tolist() == [1, 1, 2]
    assert line_arrays["generation"].tolist() == [1, 1, 1]
    assert line_arrays["particle_id"].tolist() == [0, 0, 3]
    assert line_arrays["track_index"].tolist() == [0, 0, 1]

    point_arrays = geometry["point_arrays"]
    assert point_arrays["energy"].tolist() == [1.0e6, 1.0e6, 1.0e6, 2.0e6, 3.0e6, 1.0e6, 1.0e6]
    assert point_arrays["cell_id"].tolist() == [1, 1, 1, 7, 7, 1, 1]


def test_build_polylines_empty():
    geometry = output_vtk.build_polylines([])
    assert geometry["points"].shape == (0, 3)
    assert geometry["line_lengths"].shape == (0,)
    assert geometry["line_arrays"]["pdg"].shape == (0,)


# ---------------------------------------------------------------------------
# Pure logic: weight_window_grid
# ---------------------------------------------------------------------------


def _mesh(dimension=(2, 3, 4), lower_left=(-1.0, -2.0, -3.0), upper_right=(1.0, 2.0, 3.0)):
    mesh = {
        "id": 1,
        "type": "regular",
        "dimension": list(dimension),
        "lower_left": list(lower_left),
    }
    if upper_right is not None:
        mesh["upper_right"] = list(upper_right)
    return mesh


def test_weight_window_grid_axes_and_arrays():
    nx, ny, nz = 2, 3, 4
    n_energy = 2
    mesh = _mesh((nx, ny, nz))
    lower = np.arange(n_energy * nz * ny * nx, dtype=float).reshape(n_energy, nz, ny, nx)
    window = {
        "id": 1,
        "meshId": 1,
        "energyBounds": [1.0e-5, 1.0e-1, 2.0e7],
        "lowerBounds": lower.ravel().tolist(),
        "upperBounds": (lower * 5.0).ravel().tolist(),
    }

    axes, arrays = output_vtk.weight_window_grid(mesh, window)

    assert [len(a) for a in axes] == [nx + 1, ny + 1, nz + 1]
    assert axes[0].tolist() == pytest.approx([-1.0, 0.0, 1.0])
    assert axes[2].tolist() == pytest.approx([-3.0, -1.5, 0.0, 1.5, 3.0])

    assert sorted(arrays.keys()) == ["lower_g0", "lower_g1", "upper_g0", "upper_g1"]
    # x-fastest VTK cell order == C-order ravel of (nz, ny, nx)
    assert arrays["lower_g0"].tolist() == pytest.approx(lower[0].ravel().tolist())
    assert arrays["upper_g1"].tolist() == pytest.approx((lower[1] * 5.0).ravel().tolist())


def test_weight_window_grid_from_width():
    mesh = _mesh((2, 2, 2), upper_right=None)
    mesh["width"] = [1.0, 2.0, 3.0]
    window = {
        "id": 1,
        "meshId": 1,
        "energyBounds": [0.0, 1.0],
        "lowerBounds": [0.5] * 8,
        "upperBounds": [2.5] * 8,
    }
    axes, arrays = output_vtk.weight_window_grid(mesh, window)
    assert axes[0].tolist() == pytest.approx([-1.0, 0.0, 1.0])
    assert axes[1].tolist() == pytest.approx([-2.0, 0.0, 2.0])
    assert axes[2].tolist() == pytest.approx([-3.0, 0.0, 3.0])
    assert arrays["lower_g0"].tolist() == [0.5] * 8


def test_weight_window_grid_missing_bounds():
    mesh = _mesh((2, 2, 2), upper_right=None)
    window = {
        "id": 1,
        "meshId": 1,
        "energyBounds": [0.0, 1.0],
        "lowerBounds": [1.0] * 8,
        "upperBounds": [1.0] * 8,
    }
    with pytest.raises(output_readers.OutputReaderError, match="upper_right"):
        output_vtk.weight_window_grid(mesh, window)


# ---------------------------------------------------------------------------
# Missing-dependency error paths (HAS_VTK forced off)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "call",
    [
        lambda: output_vtk.tracks_to_vtk("tracks.h5"),
        lambda: output_vtk.collision_track_to_vtk("collision_track.h5"),
        lambda: output_vtk.weight_windows_to_vtk("weight_windows.h5"),
        lambda: output_vtk.voxel_to_vtk("voxel.h5"),
        lambda: output_vtk.read_vtk_info("plot.vti"),
    ],
)
def test_exports_report_missing_vtk(monkeypatch, call):
    monkeypatch.setattr(output_vtk, "HAS_VTK", False)
    with pytest.raises(output_readers.OutputReaderError, match="vtk not installed"):
        call()


@pytest.mark.parametrize(
    "handler,argv",
    [
        (output_vtk_cmds.cmd_tracks_vtk, ["tracks.h5"]),
        (output_vtk_cmds.cmd_collision_vtk, ["collision_track.h5"]),
        (output_vtk_cmds.cmd_weight_windows_vtk, ["weight_windows.h5"]),
        (output_vtk_cmds.cmd_voxel_vtk, ["voxel.h5"]),
        (output_vtk_cmds.cmd_vtk_info, ["plot.vti"]),
    ],
)
def test_commands_report_missing_vtk(monkeypatch, capsys, handler, argv):
    """Commands convert the missing-vtk failure to a JSON error, exit 1."""
    monkeypatch.setattr(output_vtk, "HAS_VTK", False)
    args = _parse(handler, argv)
    rc = handler(args)
    assert rc == 1
    assert "vtk not installed" in _stdout_json(capsys)["error"]


def test_tracks_data_command_accepts_cell_material_args():
    """The openmc.tracks-data command parses --cell/--material lists."""
    args = _parse(
        tracks_cmds.cmd_tracks_data,
        ["tracks.h5", "--cell", "1, 2,3", "--material", "4"],
    )
    assert args.cell == "1, 2,3"
    assert args.material == "4"


# ---------------------------------------------------------------------------
# h5py integration: reader filters + conversion paths up to the vtk write
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


@pytest.fixture
def tracks_file(tmp_path, h5py):
    """tracks.h5 with two neutron segments in different cells/materials."""
    dtype = _track_dtype()
    first = np.zeros(5, dtype=dtype)
    first["r"]["x"] = np.arange(5, dtype=float)
    first["cell_id"] = 1
    first["material_id"] = 10
    second = np.zeros(3, dtype=dtype)
    second["r"]["x"] = 100.0 + np.arange(3, dtype=float)
    second["cell_id"] = 2
    second["material_id"] = 20

    path = tmp_path / "tracks.h5"
    with h5py.File(path, "w") as f:
        f.attrs["filetype"] = "track"
        f.attrs["version"] = [3, 1]
        data = np.concatenate([first, second])
        dset = f.create_dataset("track_1_1_0", data=data)
        dset.attrs["n_particles"] = 2
        dset.attrs["offsets"] = [0, 5, 8]
        dset.attrs["particles"] = [2112, 2112]
    return path


def test_read_tracks_data_cell_filter(tracks_file):
    data = output_readers.read_tracks_data(str(tracks_file), cell_filter=[2])
    segments = data["tracks"][0]["segments"]
    assert len(segments) == 1
    assert segments[0]["positions"][0][0] == pytest.approx(100.0)


def test_read_tracks_data_material_filter(tracks_file):
    data = output_readers.read_tracks_data(str(tracks_file), material_filter=[10])
    segments = data["tracks"][0]["segments"]
    assert len(segments) == 1
    assert segments[0]["positions"][0][0] == pytest.approx(0.0)


def test_read_tracks_data_filter_matches_nothing(tracks_file):
    data = output_readers.read_tracks_data(str(tracks_file), cell_filter=[999])
    assert data["tracks"][0]["segments"] == []


def test_tracks_to_vtk_empty_after_filter(tracks_file, monkeypatch):
    """Filters eliminating everything produce a clear error (before any vtk call)."""
    monkeypatch.setattr(output_vtk, "HAS_VTK", True)
    with pytest.raises(output_readers.OutputReaderError, match="nothing to visualize"):
        output_vtk.tracks_to_vtk(str(tracks_file), cell_filter=[999])


def test_weight_windows_to_vtk_missing_mesh(tmp_path, h5py, monkeypatch):
    """A window referencing a missing mesh is a clear error (before any vtk call)."""
    monkeypatch.setattr(output_vtk, "HAS_VTK", True)
    path = tmp_path / "weight_windows.h5"
    with h5py.File(path, "w") as f:
        ww = f.create_group("weight_windows")
        group = ww.create_group("weight_windows_1")
        group.create_dataset("mesh", data=42)
        group.create_dataset("particle_type", data=b"neutron")
        group.create_dataset("energy_bounds", data=[0.0, 1.0])
        group.create_dataset("lower_ww_bounds", data=[0.5])
        group.create_dataset("upper_ww_bounds", data=[2.5])
        group.create_dataset("survival_ratio", data=3.0)
        group.create_dataset("max_split", data=5)
        group.create_dataset("weight_cutoff", data=0.25)
    with pytest.raises(output_readers.OutputReaderError, match="Mesh 42"):
        output_vtk.weight_windows_to_vtk(str(path))


# ---------------------------------------------------------------------------
# vtk integration: end-to-end file writes (runs in the full docker profile)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def vtk_mod():
    return pytest.importorskip("vtk")


def test_tracks_to_vtk_writes_polyline_file(tracks_file, vtk_mod, tmp_path):
    out = tmp_path / "tracks.vtp"
    result = output_vtk.tracks_to_vtk(str(tracks_file), output_path=str(out))
    assert result["nLines"] == 2
    assert result["nPoints"] == 8

    reader = vtk_mod.vtkXMLPolyDataReader()
    reader.SetFileName(str(out))
    reader.Update()
    polydata = reader.GetOutput()
    assert polydata.GetNumberOfLines() == 2
    assert polydata.GetNumberOfPoints() == 8
    assert polydata.GetCellData().GetArray("pdg") is not None
    assert polydata.GetPointData().GetArray("energy") is not None


# ---------------------------------------------------------------------------
# Voxel plots: read_voxel_info / voxel_to_vtk / read_vtk_info
# ---------------------------------------------------------------------------


def test_read_voxel_info_reports_missing_h5py(monkeypatch):
    monkeypatch.setattr(output_readers, "HAS_H5PY", False)
    with pytest.raises(output_readers.OutputReaderError, match="h5py not installed"):
        output_readers.read_voxel_info("voxel.h5")


def test_serve_command_accepts_color_by_arg():
    """base.serve parses --color-by (drives the initial viewer coloring)."""
    from plugins.base.commands import serve as serve_cmds

    args = _parse(serve_cmds.cmd_serve, ["--file", "plot.vti", "--color-by", "Point: flux_group_0"])
    assert args.color_by == "Point: flux_group_0"

    args = _parse(serve_cmds.cmd_serve, ["--file", "plot.vti"])
    assert args.color_by is None


@pytest.fixture
def voxel_file(tmp_path, h5py):
    """Synthetic voxel plot: 2x3x4 grid of domain ids (nz, ny, nx ordering)."""
    path = tmp_path / "plot_voxel.h5"
    data = np.arange(2 * 3 * 4, dtype=np.int32).reshape(4, 3, 2)
    with h5py.File(path, "w") as f:
        f.attrs["version"] = [2, 0]
        f.attrs["num_voxels"] = [2, 3, 4]
        f.attrs["voxel_width"] = [0.5, 1.0, 2.0]
        f.attrs["lower_left"] = [-1.0, -2.0, -3.0]
        f.create_dataset("data", data=data)
    return path


def test_read_voxel_info(voxel_file):
    info = output_readers.read_voxel_info(str(voxel_file))
    assert info["dimensions"] == [2, 3, 4]
    assert info["voxelWidth"] == [0.5, 1.0, 2.0]
    assert info["lowerLeft"] == [-1.0, -2.0, -3.0]
    assert info["version"] == [2, 0]
    assert info["idRange"] == [0, 23]
    assert info["uniqueIds"] == 24


def test_read_voxel_info_not_a_voxel_file(tmp_path, h5py):
    bad = tmp_path / "statepoint.h5"
    with h5py.File(bad, "w") as f:
        f.create_dataset("k_combined", data=[1.0, 0.001])
    with pytest.raises(output_readers.OutputReaderError, match="voxel"):
        output_readers.read_voxel_info(str(bad))


def test_voxel_to_vtk_end_to_end(voxel_file, vtk_mod, tmp_path):
    out = tmp_path / "plot.vti"
    result = output_vtk.voxel_to_vtk(str(voxel_file), output_path=str(out))
    assert result["dimensions"] == [2, 3, 4]

    reader = vtk_mod.vtkXMLImageDataReader()
    reader.SetFileName(str(out))
    reader.Update()
    grid = reader.GetOutput()
    assert grid.GetDimensions() == (3, 4, 5)
    assert grid.GetSpacing() == (0.5, 1.0, 2.0)
    assert grid.GetOrigin() == (-1.0, -2.0, -3.0)
    ids = grid.GetCellData().GetArray("id")
    assert ids is not None
    assert ids.GetNumberOfTuples() == 24


def test_read_vtk_info_on_voxel_vti(voxel_file, vtk_mod, tmp_path):
    out = tmp_path / "plot.vti"
    output_vtk.voxel_to_vtk(str(voxel_file), output_path=str(out))
    info = output_vtk.read_vtk_info(str(out))

    assert info["type"] == "vtkImageData"
    assert info["dimensions"] == [3, 4, 5]
    assert info["nCells"] == 24
    (id_array,) = info["arrays"]
    assert id_array["name"] == "id"
    assert id_array["association"] == "cell"
    assert id_array["range"] == [0.0, 23.0]


def test_read_vtk_info_rejects_unknown_extension(tmp_path, vtk_mod):
    bad = tmp_path / "plot.txt"
    bad.write_text("nope")
    with pytest.raises(output_readers.OutputReaderError, match="Unsupported VTK"):
        output_vtk.read_vtk_info(str(bad))


def test_voxel_vtk_command_success(voxel_file, vtk_mod, tmp_path, capsys):
    out = tmp_path / "plot.vti"
    args = _parse(output_vtk_cmds.cmd_voxel_vtk, [str(voxel_file), "--output", str(out)])
    rc = output_vtk_cmds.cmd_voxel_vtk(args)
    assert rc == 0
    assert _stdout_json(capsys)["dimensions"] == [2, 3, 4]


def test_vtk_info_command_success(voxel_file, vtk_mod, tmp_path, capsys):
    out = tmp_path / "plot.vti"
    output_vtk.voxel_to_vtk(str(voxel_file), output_path=str(out))
    args = _parse(output_vtk_cmds.cmd_vtk_info, [str(out)])
    rc = output_vtk_cmds.cmd_vtk_info(args)
    assert rc == 0
    assert _stdout_json(capsys)["arrays"][0]["name"] == "id"
