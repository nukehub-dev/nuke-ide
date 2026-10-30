"""Validation and helper coverage for plugins.openmc.lib.output_vtk.

``test_openmc_output_vtk.py`` covers the happy paths and the end-to-end VTK
writes. This module focuses on the pure-numpy geometry validators, the
lazy-import failure branches, default output naming, and VTK inspection
errors that the main suite does not reach.
"""

import os
import sys
import types

import pytest

np = pytest.importorskip("numpy")
pytest.importorskip("vtk")

from plugins.openmc.lib import output_readers, output_vtk  # noqa: E402


def _segment(n=2):
    return {
        "particle": "neutron",
        "pdg": 2112,
        "nStates": n,
        "stride": 1,
        "positions": [[float(i), 0.0, 0.0] for i in range(n)],
        "energies": [1.0e6] * n,
        "times": [0.0] * n,
        "weights": [1.0] * n,
        "cellIds": [1] * n,
    }


def _track(segments=None):
    return {
        "file": "tracks.h5",
        "dataset": "track_1_1_0",
        "batch": 1,
        "generation": 1,
        "particleId": 0,
        "segments": [_segment()] if segments is None else segments,
    }


# ---------------------------------------------------------------------------
# Lazy vtk import and positive-limit validation
# ---------------------------------------------------------------------------


def test_load_vtk_wraps_import_failure(monkeypatch):
    """HAS_VTK may be stale; a failing import still becomes a clean error."""
    monkeypatch.setattr(output_vtk, "HAS_VTK", True)
    monkeypatch.setitem(sys.modules, "vtk", None)

    with pytest.raises(output_readers.OutputReaderError, match="required for VTK export"):
        output_vtk._load_vtk()


def test_require_positive_accepts_none_and_numbers():
    assert output_vtk._require_positive("max_tracks", None) is None
    assert output_vtk._require_positive("max_tracks", "12") == 12
    assert output_vtk._require_positive("max_tracks", 3) == 3


@pytest.mark.parametrize("value", [True, "many", object(), 2.5, float("inf"), float("nan")])
def test_require_positive_rejects_bools_and_non_integers(value):
    with pytest.raises(output_readers.OutputReaderError, match="positive integer"):
        output_vtk._require_positive("max_tracks", value)


# ---------------------------------------------------------------------------
# build_polylines validation
# ---------------------------------------------------------------------------


def test_build_polylines_rejects_track_without_segments():
    with pytest.raises(output_readers.OutputReaderError, match="missing 'segments'"):
        output_vtk.build_polylines([{"batch": 1, "generation": 1, "particleId": 0}])


def test_build_polylines_rejects_missing_track_identifiers():
    with pytest.raises(output_readers.OutputReaderError, match="batch/generation/particleId"):
        output_vtk.build_polylines([{"segments": [_segment()]}])


def test_build_polylines_rejects_segment_without_pdg():
    segment = _segment()
    del segment["pdg"]
    with pytest.raises(output_readers.OutputReaderError, match="missing integer 'pdg'"):
        output_vtk.build_polylines([_track([segment])])


def test_build_polylines_rejects_non_numeric_positions():
    segment = _segment()
    segment["positions"] = [["left", 0.0, 0.0], ["right", 0.0, 0.0]]
    with pytest.raises(output_readers.OutputReaderError, match="non-numeric positions"):
        output_vtk.build_polylines([_track([segment])])


def test_build_polylines_rejects_two_column_positions():
    segment = _segment()
    segment["positions"] = [[0.0, 0.0], [1.0, 1.0]]
    with pytest.raises(output_readers.OutputReaderError, match="3 columns"):
        output_vtk.build_polylines([_track([segment])])


def test_build_polylines_rejects_missing_per_state_array():
    segment = _segment()
    del segment["energies"]
    with pytest.raises(output_readers.OutputReaderError, match="missing 'energies'"):
        output_vtk.build_polylines([_track([segment])])


def test_build_polylines_rejects_ragged_per_state_array():
    segment = _segment()
    segment["energies"] = [[1.0], [2.0, 3.0]]
    with pytest.raises(output_readers.OutputReaderError, match="non-numeric 'energies'"):
        output_vtk.build_polylines([_track([segment])])


# ---------------------------------------------------------------------------
# build_collision_points validation
# ---------------------------------------------------------------------------


def test_build_collision_points_rejects_missing_positions():
    with pytest.raises(output_readers.OutputReaderError, match="missing 'positions'"):
        output_vtk.build_collision_points({"energies": [1.0]})


def test_build_collision_points_rejects_non_numeric_positions():
    with pytest.raises(output_readers.OutputReaderError, match="positions are non-numeric"):
        output_vtk.build_collision_points({"positions": [["a", "b", "c"]]})


def test_build_collision_points_rejects_ragged_arrays():
    collisions = {"positions": [[0.0, 0.0, 0.0], [1.0, 1.0, 1.0]]}
    collisions["energies"] = [[1.0], [2.0, 3.0]]
    with pytest.raises(output_readers.OutputReaderError, match="energies.*non-numeric"):
        output_vtk.build_collision_points(collisions)


# ---------------------------------------------------------------------------
# Default output paths
# ---------------------------------------------------------------------------


def test_tracks_to_vtk_defaults_output_path(tmp_path, monkeypatch):
    """No explicit path writes into a temp directory named after the source."""
    source = tmp_path / "tracks.h5"
    source.write_bytes(b"fake")
    monkeypatch.setattr(output_vtk, "_require_vtk", lambda: None)
    monkeypatch.setattr(
        output_readers,
        "read_tracks_data",
        lambda *args, **kwargs: {
            "files": [str(source)],
            "totalTracks": 1,
            "returnedTracks": 1,
            "tracks": [_track()],
        },
    )
    written = {}
    monkeypatch.setattr(
        output_vtk,
        "_write_polyline_vtp",
        lambda geometry, path: written.setdefault("path", path),
    )

    result = output_vtk.tracks_to_vtk(str(source))

    assert result["vtkPath"].endswith("tracks.vtp")
    assert written["path"] == result["vtkPath"]


def test_collision_track_to_vtk_defaults_output_path(monkeypatch):
    """The collision point cloud also derives a temp .vtp path."""
    monkeypatch.setattr(
        output_readers,
        "read_collision_track_data",
        lambda *args, **kwargs: {
            "files": ["collision_track.h5"],
            "totalCollisions": 2,
            "matchedCollisions": 2,
            "collisions": {"positions": [[0.0, 0.0, 0.0], [1.0, 2.0, 3.0]]},
        },
    )

    class FakePoints:
        def SetData(self, values):
            pass

    class FakeCells:
        def InsertNextCell(self, n):
            pass

        def InsertCellPoint(self, index):
            pass

    class FakePolyData:
        def SetPoints(self, points):
            pass

        def SetVerts(self, verts):
            pass

        def GetPointData(self):
            return None

    captured = {}

    class FakeWriter:
        def SetFileName(self, path):
            captured["path"] = path

        def SetInputData(self, data):
            pass

        def Write(self):
            pass

    fake_vtk = types.SimpleNamespace(
        vtkPoints=FakePoints,
        vtkCellArray=FakeCells,
        vtkPolyData=FakePolyData,
        vtkXMLPolyDataWriter=FakeWriter,
    )
    monkeypatch.setattr(
        output_vtk,
        "_load_vtk",
        lambda: (fake_vtk, types.SimpleNamespace(numpy_to_vtk=lambda values, deep=True: values)),
    )
    monkeypatch.setattr(output_vtk, "_set_array", lambda *args, **kwargs: None)

    result = output_vtk.collision_track_to_vtk("collision_track.h5")

    assert result["vtkPath"].endswith("collision_track.vtp")
    assert captured["path"] == result["vtkPath"]


# ---------------------------------------------------------------------------
# weight_window_grid mesh/window validation
# ---------------------------------------------------------------------------


def _window(n_cells=8):
    return {
        "id": 1,
        "meshId": 1,
        "energyBounds": [0.0, 1.0],
        "lowerBounds": [0.5] * n_cells,
        "upperBounds": [2.5] * n_cells,
    }


def _mesh():
    return {
        "id": 1,
        "type": "regular",
        "dimension": [2, 2, 2],
        "lower_left": [0.0, 0.0, 0.0],
        "upper_right": [1.0, 1.0, 1.0],
    }


def test_weight_window_grid_rejects_non_dict_mesh():
    with pytest.raises(output_readers.OutputReaderError, match="missing 'dimension'"):
        output_vtk.weight_window_grid(None, _window())


def test_weight_window_grid_rejects_non_numeric_dimension():
    mesh = _mesh()
    mesh["dimension"] = ["a", "b", "c"]
    with pytest.raises(output_readers.OutputReaderError, match="invalid dimension"):
        output_vtk.weight_window_grid(mesh, _window())


def test_weight_window_grid_rejects_missing_lower_left():
    mesh = _mesh()
    del mesh["lower_left"]
    with pytest.raises(output_readers.OutputReaderError, match="numeric 'lower_left'"):
        output_vtk.weight_window_grid(mesh, _window())


def test_weight_window_grid_rejects_wrong_lower_left_shape():
    mesh = _mesh()
    mesh["lower_left"] = [0.0, 0.0]
    with pytest.raises(output_readers.OutputReaderError, match="must have 3 values"):
        output_vtk.weight_window_grid(mesh, _window())


def test_weight_window_grid_rejects_non_numeric_upper_right():
    mesh = _mesh()
    mesh["upper_right"] = ["a", "b", "c"]
    with pytest.raises(output_readers.OutputReaderError, match="non-numeric 'upper_right'"):
        output_vtk.weight_window_grid(mesh, _window())


def test_weight_window_grid_rejects_non_numeric_width():
    mesh = _mesh()
    del mesh["upper_right"]
    mesh["width"] = ["a", "b", "c"]
    with pytest.raises(output_readers.OutputReaderError, match="non-numeric 'width'"):
        output_vtk.weight_window_grid(mesh, _window())


def test_weight_window_grid_rejects_wrong_upper_right_shape():
    mesh = _mesh()
    mesh["upper_right"] = [1.0, 1.0]
    with pytest.raises(output_readers.OutputReaderError, match="bounds must have 3 values"):
        output_vtk.weight_window_grid(mesh, _window())


def test_weight_window_grid_rejects_missing_window_bounds():
    window = _window()
    del window["upperBounds"]
    with pytest.raises(output_readers.OutputReaderError, match="missing numeric"):
        output_vtk.weight_window_grid(_mesh(), window)


def test_weight_window_grid_rejects_single_energy_bound():
    window = _window()
    window["energyBounds"] = [0.0]
    window["lowerBounds"] = []
    window["upperBounds"] = []
    with pytest.raises(output_readers.OutputReaderError, match="at least 2 values"):
        output_vtk.weight_window_grid(_mesh(), window)


# ---------------------------------------------------------------------------
# voxel_image_geometry validation
# ---------------------------------------------------------------------------


def test_voxel_image_geometry_rejects_non_dict():
    with pytest.raises(output_readers.OutputReaderError, match="must be a dict"):
        output_vtk.voxel_image_geometry(None)


def test_voxel_image_geometry_rejects_missing_key():
    with pytest.raises(output_readers.OutputReaderError, match="lowerLeft"):
        output_vtk.voxel_image_geometry({"dimensions": [1, 1, 1], "voxelWidth": [1.0, 1.0, 1.0]})


def test_voxel_image_geometry_rejects_non_numeric_values():
    with pytest.raises(output_readers.OutputReaderError, match="must be numeric"):
        output_vtk.voxel_image_geometry(
            {
                "dimensions": ["a", 1, 1],
                "voxelWidth": [1.0, 1.0, 1.0],
                "lowerLeft": [0.0, 0.0, 0.0],
            }
        )


def test_voxel_image_geometry_rejects_wrong_lengths():
    with pytest.raises(output_readers.OutputReaderError, match="each have 3 values"):
        output_vtk.voxel_image_geometry(
            {
                "dimensions": [1, 1, 1],
                "voxelWidth": [1.0, 1.0, 1.0],
                "lowerLeft": [0.0, 0.0],
            }
        )


def test_voxel_image_geometry_rejects_non_positive_widths():
    with pytest.raises(output_readers.OutputReaderError, match="widths must be positive"):
        output_vtk.voxel_image_geometry(
            {
                "dimensions": [1, 1, 1],
                "voxelWidth": [0.0, 1.0, 1.0],
                "lowerLeft": [0.0, 0.0, 0.0],
            }
        )


def test_voxel_to_vtk_defaults_output_path(tmp_path):
    """A real 2x1x1 voxel file exports to a temp .vti without an output path."""
    h5py = pytest.importorskip("h5py")
    pytest.importorskip("vtk")
    path = tmp_path / "plot_voxel.h5"
    with h5py.File(path, "w") as handle:
        handle.attrs["version"] = [2, 0]
        handle.attrs["num_voxels"] = [2, 1, 1]
        handle.attrs["voxel_width"] = [0.5, 1.0, 1.0]
        handle.attrs["lower_left"] = [-1.0, 0.0, 0.0]
        handle.create_dataset("data", data=np.array([0, 1], dtype=np.int32))

    result = output_vtk.voxel_to_vtk(str(path))

    assert result["vtkPath"].endswith("plot_voxel.vti")
    assert os.path.isfile(result["vtkPath"])


# ---------------------------------------------------------------------------
# read_vtk_info branches
# ---------------------------------------------------------------------------


def test_read_vtk_info_reports_missing_file(tmp_path):
    with pytest.raises(output_readers.OutputReaderError, match="File not found"):
        output_vtk.read_vtk_info(str(tmp_path / "missing.vti"))


def test_read_vtk_info_reads_legacy_vtk_file(tmp_path):
    """The legacy .vtk branch uses vtkGenericDataObjectReader."""
    vtk = pytest.importorskip("vtk")
    from vtk.util import numpy_support

    polydata = vtk.vtkPolyData()
    points = vtk.vtkPoints()
    points.InsertNextPoint(0.0, 0.0, 0.0)
    points.InsertNextPoint(1.0, 0.0, 0.0)
    polydata.SetPoints(points)
    array = numpy_support.numpy_to_vtk(np.array([1.0, 2.0]), deep=True)
    array.SetName("f")
    polydata.GetPointData().AddArray(array)

    path = tmp_path / "legacy.vtk"
    writer = vtk.vtkPolyDataWriter()
    writer.SetFileName(str(path))
    writer.SetInputData(polydata)
    writer.SetFileTypeToASCII()
    writer.Write()

    info = output_vtk.read_vtk_info(str(path))

    assert info["type"] == "vtkPolyData"
    assert info["nPoints"] == 2
    assert [(entry["name"], entry["association"]) for entry in info["arrays"]] == [("f", "point")]


def _fake_reader_vtk(reader_class):
    return types.SimpleNamespace(
        vtkGenericDataObjectReader=reader_class,
        vtkXMLGenericDataObjectReader=reader_class,
    )


def test_read_vtk_info_wraps_reader_failure(tmp_path, monkeypatch):
    class RaisingReader:
        def SetFileName(self, path):
            pass

        def Update(self):
            raise RuntimeError("corrupt file")

        def GetOutput(self):
            return None

    path = tmp_path / "plot.vti"
    path.write_text("not vtk")
    monkeypatch.setattr(output_vtk, "_load_vtk", lambda: (_fake_reader_vtk(RaisingReader), None))

    with pytest.raises(output_readers.OutputReaderError, match="corrupt file"):
        output_vtk.read_vtk_info(str(path))


def test_read_vtk_info_rejects_empty_reader_output(tmp_path, monkeypatch):
    class EmptyReader:
        def SetFileName(self, path):
            pass

        def Update(self):
            pass

        def GetOutput(self):
            return None

    path = tmp_path / "plot.vti"
    path.write_text("not vtk")
    monkeypatch.setattr(output_vtk, "_load_vtk", lambda: (_fake_reader_vtk(EmptyReader), None))

    with pytest.raises(output_readers.OutputReaderError, match="Could not read VTK file"):
        output_vtk.read_vtk_info(str(path))


def test_read_vtk_info_skips_unnamed_arrays(tmp_path, monkeypatch):
    class Attributes:
        def GetNumberOfArrays(self):
            return 2

        def GetArray(self, index):
            if index == 0:
                return None
            return types.SimpleNamespace(GetName=lambda: "")

    class Dataset:
        def GetPointData(self):
            return Attributes()

        def GetCellData(self):
            return Attributes()

        def GetNumberOfPoints(self):
            return 0

        def GetNumberOfCells(self):
            return 0

        def GetBounds(self):
            return (0.0, 0.0, 0.0, 0.0, 0.0, 0.0)

        def GetClassName(self):
            return "vtkPolyData"

        def IsA(self, class_name):
            return False

    class Reader:
        def SetFileName(self, path):
            pass

        def Update(self):
            pass

        def GetOutput(self):
            return Dataset()

    path = tmp_path / "plot.vti"
    path.write_text("not vtk")
    monkeypatch.setattr(output_vtk, "_load_vtk", lambda: (_fake_reader_vtk(Reader), None))

    info = output_vtk.read_vtk_info(str(path))

    assert info["arrays"] == []
    assert info["bounds"] == [0.0] * 6
