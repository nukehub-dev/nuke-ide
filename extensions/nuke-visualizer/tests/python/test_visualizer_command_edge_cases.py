# Copyright (C) 2026 NukeHub and others.
# SPDX-License-Identifier: BSD-2-Clause
"""Edge-case tests for the base analysis commands.

The happy paths live in ``test_base_analysis.py``. This module targets the
defensive seams: validation messages, reader/writer failures, non-scalar or
missing arrays, block aggregation fallbacks, grid datasets, mixed cell
topologies, and the pure-VTK quality fallback used for quads and hexes.
Every VTK-backed test skips cleanly without ``vtk``; the fake-VTK tests
exercise the same error branches in the minimal pytest + numpy profile.
"""

import argparse
import json
from types import SimpleNamespace

import pytest

np = pytest.importorskip("numpy")

from nuke_viz.plugin import setup_parser_for_handler  # noqa: E402
from plugins.base.commands import analysis as analysis_cmds  # noqa: E402
from plugins.base.lib.analysis import AnalysisError  # noqa: E402


def _parse(handler, argv):
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(handler, parser)
    return parser.parse_args(argv)


def _stderr_error(capsys):
    err = capsys.readouterr().err.strip()
    assert err.startswith('{"error"'), f"expected JSON error on stderr, got: {err!r}"
    return json.loads(err)["error"]


# ---------------------------------------------------------------------------
# Path and reader validation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("path", [None, "", 7])
def test_require_file_rejects_empty_paths(path):
    with pytest.raises(AnalysisError, match="non-empty path"):
        analysis_cmds._require_file(path)


def test_require_file_rejects_unsupported_suffix(tmp_path):
    path = tmp_path / "mesh.obj"
    path.write_text("v 0 0 0")
    without_suffix = tmp_path / "mesh"
    without_suffix.write_text("v 0 0 0")
    with pytest.raises(AnalysisError, match="Unsupported VTK suffix '.obj'"):
        analysis_cmds._require_file(str(path))
    with pytest.raises(AnalysisError, match="<none>"):
        analysis_cmds._require_file(str(without_suffix))

    uppercase = tmp_path / "mesh.VTU"
    uppercase.write_text("v 0 0 0")
    assert analysis_cmds._require_file(str(uppercase)) == ".vtu"


@pytest.mark.parametrize("path", [None, "", 7])
def test_require_output_path_rejects_empty_paths(path):
    with pytest.raises(AnalysisError, match="non-empty path"):
        analysis_cmds._require_output_path(path)


def test_read_dataset_reports_update_exception(tmp_path, monkeypatch):
    path = tmp_path / "broken.vtk"
    path.write_text("broken")

    class _RaisingReader:
        def SetFileName(self, _path):
            pass

        def Update(self):
            raise RuntimeError("reader exploded")

        def GetOutput(self):
            return None

    class _FakeVTK:
        vtkGenericDataObjectReader = _RaisingReader

    monkeypatch.setattr(analysis_cmds, "_load_vtk", lambda: (_FakeVTK, None))
    with pytest.raises(AnalysisError, match="Could not read VTK file.*reader exploded"):
        analysis_cmds._read_dataset(str(path))


def test_read_dataset_rejects_non_dataset_output(tmp_path, monkeypatch):
    path = tmp_path / "empty.vtk"
    path.write_text("empty")

    class _Output:
        def IsA(self, _class_name):
            return False

    class _Reader:
        def SetFileName(self, _path):
            pass

        def Update(self):
            pass

        def GetOutput(self):
            return _Output()

    class _FakeVTK:
        vtkGenericDataObjectReader = _Reader

    monkeypatch.setattr(analysis_cmds, "_load_vtk", lambda: (_FakeVTK, None))
    with pytest.raises(AnalysisError, match="Unsupported VTK dataset"):
        analysis_cmds._read_dataset(str(path))


def test_read_dataset_malformed_legacy_file(tmp_path, capsys):
    pytest.importorskip("vtk")
    path = tmp_path / "garbage.vtk"
    path.write_text("this is not a vtk dataset")

    args = _parse(analysis_cmds.cmd_describe, ["--file", str(path), "--array", "cell:value"])
    assert analysis_cmds.cmd_describe(args) == 1
    assert "Unsupported VTK dataset" in _stderr_error(capsys)


# ---------------------------------------------------------------------------
# Scalar array extraction
# ---------------------------------------------------------------------------


def test_array_values_reports_available_arrays(tmp_path):
    vtk = pytest.importorskip("vtk")
    path = _write_hexa_vtu(vtk, tmp_path / "cube.vtu")
    reader = vtk.vtkXMLUnstructuredGridReader()
    reader.SetFileName(str(path))
    reader.Update()
    cell_data = reader.GetOutput().GetCellData()

    with pytest.raises(AnalysisError, match="cell array 'nope' not found.*value"):
        analysis_cmds._array_values(None, cell_data, "nope", "cell", 1)


def test_array_values_rejects_multicomponent_array(tmp_path):
    vtk = pytest.importorskip("vtk")
    path = _write_hexa_vtu(vtk, tmp_path / "cube.vtu")
    reader = vtk.vtkXMLUnstructuredGridReader()
    reader.SetFileName(str(path))
    reader.Update()
    dataset = reader.GetOutput()

    vector = vtk.vtkDoubleArray()
    vector.SetName("vector")
    vector.SetNumberOfComponents(3)
    vector.SetNumberOfTuples(dataset.GetNumberOfCells())
    dataset.GetCellData().AddArray(vector)

    from vtk.util import numpy_support

    with pytest.raises(AnalysisError, match="3 components; expected a scalar array"):
        analysis_cmds._array_values(
            numpy_support, dataset.GetCellData(), "vector", "cell", dataset.GetNumberOfCells()
        )


def test_array_values_rejects_value_count_mismatch(tmp_path):
    vtk = pytest.importorskip("vtk")
    path = _write_hexa_vtu(vtk, tmp_path / "cube.vtu")
    reader = vtk.vtkXMLUnstructuredGridReader()
    reader.SetFileName(str(path))
    reader.Update()
    dataset = reader.GetOutput()

    from vtk.util import numpy_support

    with pytest.raises(AnalysisError, match="1 values; expected 99"):
        analysis_cmds._array_values(numpy_support, dataset.GetCellData(), "value", "cell", 99)


# ---------------------------------------------------------------------------
# Cell/point measures and topology helpers
# ---------------------------------------------------------------------------


class _FilterOutput:
    def __init__(self, array):
        self._array = array

    def GetCellData(self):
        return SimpleNamespace(GetArray=lambda _name: self._array)


class _CellSizeFilter:
    output = None

    def SetInputData(self, _dataset):
        pass

    def SetComputeArea(self, _flag):
        pass

    def SetComputeVolume(self, _flag):
        pass

    def SetComputeLength(self, _flag):
        pass

    def Update(self):
        pass

    def GetOutput(self):
        return _FilterOutput(type(self).output)


class _FakeVTKWithFilter:
    vtkCellSizeFilter = _CellSizeFilter


class _DatasetStub:
    def __init__(self, cells=1):
        self._cells = cells

    def GetClassName(self):
        return "vtkStub"

    def GetNumberOfCells(self):
        return self._cells


def test_cell_measures_requires_cell_size_filter():
    with pytest.raises(AnalysisError, match="vtkCellSizeFilter is required"):
        analysis_cmds._cell_measures(SimpleNamespace(), None, _DatasetStub(), "area")


def test_cell_measures_reports_missing_array(monkeypatch):
    _CellSizeFilter.output = None
    monkeypatch.setattr(analysis_cmds, "_load_vtk", lambda: (_FakeVTKWithFilter, None))
    with pytest.raises(AnalysisError, match="could not compute cell area"):
        analysis_cmds._cell_measures(_FakeVTKWithFilter, None, _DatasetStub(), "area")


def test_cell_measures_reports_count_mismatch():
    _CellSizeFilter.output = object()
    numpy_support = SimpleNamespace(vtk_to_numpy=lambda _array: np.array([1.0, 2.0]))
    with pytest.raises(AnalysisError, match="2 cell volume values for 1 cells"):
        analysis_cmds._cell_measures(_FakeVTKWithFilter, numpy_support, _DatasetStub(1), "volume")


def test_dataset_cells_returns_none_for_non_polygon_polydata():
    vtk = pytest.importorskip("vtk")
    points = vtk.vtkPoints()
    points.InsertNextPoint(0.0, 0.0, 0.0)
    points.InsertNextPoint(1.0, 0.0, 0.0)
    line = vtk.vtkLine()
    line.GetPointIds().SetId(0, 0)
    line.GetPointIds().SetId(1, 1)
    lines = vtk.vtkCellArray()
    lines.InsertNextCell(line)
    polydata = vtk.vtkPolyData()
    polydata.SetPoints(points)
    polydata.SetLines(lines)

    assert analysis_cmds._dataset_cells(polydata) is None


def test_point_measures_requires_points():
    dataset = SimpleNamespace(GetNumberOfPoints=lambda: 0)
    with pytest.raises(AnalysisError, match="no points to integrate"):
        analysis_cmds._point_measures(None, dataset, np.zeros(0))


class _CellsStub:
    def GetOffsetsArray(self):
        return "offsets"

    def GetConnectivityArray(self):
        return "connectivity"


class _PointDatasetStub:
    def __init__(self, cells):
        self._cells = cells

    def IsA(self, _class_name):
        return False

    def GetNumberOfPoints(self):
        return 3

    def GetCells(self):
        return self._cells


def test_point_measures_rejects_invalid_connectivity_indices():
    numpy_support = SimpleNamespace(
        vtk_to_numpy=lambda array: np.array([0, 3]) if array == "offsets" else np.array([0, 1, 99])
    )
    dataset = _PointDatasetStub(_CellsStub())
    with pytest.raises(AnalysisError, match="invalid point indices"):
        analysis_cmds._point_measures(numpy_support, dataset, np.array([1.0]))


class _CellStub:
    def __init__(self, point_ids):
        self._point_ids = point_ids

    def GetNumberOfPoints(self):
        return len(self._point_ids)

    def GetPointId(self, offset):
        return self._point_ids[offset]


class _LegacyCellsStub:
    def __init__(self, cells):
        self._cells = cells

    def __getattr__(self, name):
        raise AttributeError(name)


def test_point_measures_falls_back_to_per_cell_lumping():
    cells = [_CellStub([0, 1]), _CellStub([1, 2])]
    dataset = SimpleNamespace(
        IsA=lambda _name: False,
        GetNumberOfPoints=lambda: 3,
        GetCells=lambda: _LegacyCellsStub(cells),
        GetCell=lambda index: cells[index],
    )

    lumped = analysis_cmds._point_measures(None, dataset, np.array([2.0, 4.0]))

    assert lumped == pytest.approx([1.0, 3.0, 2.0])


def test_point_measures_rejects_empty_fallback_cell():
    cells = [_CellStub([])]
    dataset = SimpleNamespace(
        IsA=lambda _name: False,
        GetNumberOfPoints=lambda: 1,
        GetCells=lambda: _LegacyCellsStub(cells),
        GetCell=lambda index: cells[index],
    )

    with pytest.raises(AnalysisError, match="cell 0 has no points"):
        analysis_cmds._point_measures(None, dataset, np.array([1.0]))


def test_find_block_array_skips_unnamed_and_multicomponent_arrays():
    class _Array:
        def __init__(self, name, components=1):
            self._name = name
            self._components = components

        def GetName(self):
            return self._name

        def GetNumberOfComponents(self):
            return self._components

    arrays = [_Array(""), _Array("block", 2), _Array("material_id")]
    cell_data = SimpleNamespace(
        GetNumberOfArrays=lambda: len(arrays),
        GetArray=lambda index: arrays[index],
    )
    dataset = SimpleNamespace(GetCellData=lambda: cell_data)

    name, values = analysis_cmds._find_block_array(
        SimpleNamespace(vtk_to_numpy=lambda _array: np.array([4, 4])), dataset
    )

    assert name == "material_id"
    assert values.tolist() == [4, 4]


def test_per_block_keeps_all_non_finite_block_row():
    entries = analysis_cmds._per_block(
        np.array([1.0, 1.0, 2.0]),
        np.array([np.nan, np.nan, 3.0]),
        np.array([2.0, 3.0, 4.0]),
    )

    assert entries[0] == {
        "block": 1,
        "total": 0.0,
        "mean": 0.0,
        "measure": 5.0,
        "count": 0,
        "nanCount": 2,
    }
    assert entries[1]["block"] == 2
    assert entries[1]["total"] == pytest.approx(12.0)


def test_distinct_cell_types_falls_back_to_per_cell_scan():
    class _Dataset:
        def GetCellType(self, index):
            return [3, 5][index]

        def GetNumberOfCells(self):
            return 2

    assert analysis_cmds._distinct_cell_types(None, None, _Dataset()) == {3, 5}


def test_distinct_cell_types_uses_types_array_and_swallows_failures():
    class _ArrayDataset:
        def GetCellTypesArray(self):
            return "types"

    class _FailingDataset(_ArrayDataset):
        def GetCellType(self, _index):
            return 4

        def GetNumberOfCells(self):
            return 1

    set_like = SimpleNamespace(vtk_to_numpy=lambda _array: np.array([7, 7, 9]))
    assert analysis_cmds._distinct_cell_types(None, set_like, _ArrayDataset()) == {7, 9}

    def _raise(_array):
        raise RuntimeError("cannot convert")

    assert analysis_cmds._distinct_cell_types(
        None, SimpleNamespace(vtk_to_numpy=_raise), _FailingDataset()
    ) == {4}


def test_homogeneous_topology_swallows_cell_access_failure(monkeypatch):
    vtk = pytest.importorskip("vtk")
    monkeypatch.setattr(analysis_cmds, "_distinct_cell_types", lambda *_args: {vtk.VTK_TRIANGLE})

    def _raise(_dataset):
        raise RuntimeError("no cells")

    monkeypatch.setattr(analysis_cmds, "_dataset_cells", _raise)
    assert analysis_cmds._homogeneous_topology(vtk, None, object(), vtk.VTK_TRIANGLE, 3) == (
        None,
        None,
    )


class _HomogeneousCells:
    def GetOffsetsArray(self):
        return "offsets"

    def GetConnectivityArray(self):
        return "connectivity"


class _HomogeneousDataset:
    def GetPoints(self):
        return SimpleNamespace(GetData=lambda: "points")

    def GetNumberOfCells(self):
        return 1


def test_homogeneous_topology_rejects_wrong_width(monkeypatch):
    vtk = pytest.importorskip("vtk")
    monkeypatch.setattr(analysis_cmds, "_distinct_cell_types", lambda *_args: {vtk.VTK_TRIANGLE})
    monkeypatch.setattr(analysis_cmds, "_dataset_cells", lambda _dataset: _HomogeneousCells())
    numpy_support = SimpleNamespace(
        vtk_to_numpy=lambda array: {
            "offsets": np.array([0, 2]),
            "connectivity": np.array([0, 1]),
            "points": np.zeros((2, 3)),
        }[array]
    )

    assert analysis_cmds._homogeneous_topology(
        vtk, numpy_support, _HomogeneousDataset(), vtk.VTK_TRIANGLE, 3
    ) == (None, None)


def test_homogeneous_topology_rejects_connectivity_size_mismatch(monkeypatch):
    vtk = pytest.importorskip("vtk")
    monkeypatch.setattr(analysis_cmds, "_distinct_cell_types", lambda *_args: {vtk.VTK_TRIANGLE})
    monkeypatch.setattr(analysis_cmds, "_dataset_cells", lambda _dataset: _HomogeneousCells())
    numpy_support = SimpleNamespace(
        vtk_to_numpy=lambda array: {
            "offsets": np.array([0, 3]),
            "connectivity": np.array([0, 1]),
            "points": np.zeros((2, 3)),
        }[array]
    )

    assert analysis_cmds._homogeneous_topology(
        vtk, numpy_support, _HomogeneousDataset(), vtk.VTK_TRIANGLE, 3
    ) == (None, None)


def test_has_volumetric_cells_accepts_image_data():
    vtk = pytest.importorskip("vtk")
    image = vtk.vtkImageData()
    image.SetDimensions(2, 2, 2)
    assert analysis_cmds._has_volumetric_cells(vtk, None, image) is True


# ---------------------------------------------------------------------------
# Integration command edge cases
# ---------------------------------------------------------------------------


def test_integrate_rejects_empty_dataset(tmp_path, capsys):
    vtk = pytest.importorskip("vtk")
    path = tmp_path / "empty.vtu"
    writer = vtk.vtkXMLUnstructuredGridWriter()
    writer.SetFileName(str(path))
    writer.SetInputData(vtk.vtkUnstructuredGrid())
    writer.Write()

    args = _parse(analysis_cmds.cmd_integrate, ["--file", str(path), "--array", "cell:value"])
    assert analysis_cmds.cmd_integrate(args) == 1
    assert "no cells to integrate" in _stderr_error(capsys)


def test_integrate_block_requires_block_array(tmp_path, capsys):
    vtk = pytest.importorskip("vtk")
    path = _write_hexa_vtu(vtk, tmp_path / "cube.vtu", block=False)

    args = _parse(
        analysis_cmds.cmd_integrate,
        ["--file", str(path), "--array", "cell:value", "--block", "1"],
    )
    assert analysis_cmds.cmd_integrate(args) == 1
    assert "no numeric block array" in _stderr_error(capsys)


def test_integrate_block_is_cell_only(tmp_path, capsys):
    vtk = pytest.importorskip("vtk")
    path = _write_hexa_vtu(vtk, tmp_path / "cube.vtu")

    args = _parse(
        analysis_cmds.cmd_integrate,
        ["--file", str(path), "--array", "point:pv", "--block", "1"],
    )
    assert analysis_cmds.cmd_integrate(args) == 1
    assert "--block is only supported for cell arrays" in _stderr_error(capsys)


def test_integrate_rejects_point_dataset_without_points(monkeypatch):
    dataset = SimpleNamespace(GetNumberOfCells=lambda: 1, GetNumberOfPoints=lambda: 0)
    monkeypatch.setattr(analysis_cmds, "_cell_measures", lambda *_args: np.array([1.0]))
    monkeypatch.setattr(analysis_cmds, "_has_volumetric_cells", lambda *_args: False)

    with pytest.raises(AnalysisError, match="no points to integrate"):
        analysis_cmds._integrate_dataset(None, None, dataset, "point", "flux", None, None)


# ---------------------------------------------------------------------------
# Mesh-quality metrics and writer edge cases
# ---------------------------------------------------------------------------


def test_mesh_quality_rejects_empty_dataset(tmp_path, capsys):
    vtk = pytest.importorskip("vtk")
    path = tmp_path / "empty.vtu"
    writer = vtk.vtkXMLUnstructuredGridWriter()
    writer.SetFileName(str(path))
    writer.SetInputData(vtk.vtkUnstructuredGrid())
    writer.Write()

    args = _parse(
        analysis_cmds.cmd_mesh_quality,
        ["--file", str(path), "--output", str(tmp_path / "out.vtu")],
    )
    assert analysis_cmds.cmd_mesh_quality(args) == 1
    assert "no cells for mesh-quality" in _stderr_error(capsys)


def test_mesh_quality_rejects_area_on_volumetric_cells(tmp_path, capsys):
    vtk = pytest.importorskip("vtk")
    path = _write_hexa_vtu(vtk, tmp_path / "cube.vtu")

    args = _parse(
        analysis_cmds.cmd_mesh_quality,
        ["--file", str(path), "--output", str(tmp_path / "out.vtu"), "--metric", "area"],
    )
    assert analysis_cmds.cmd_mesh_quality(args) == 1
    assert "metric 'area' requires 2D cells" in _stderr_error(capsys)


def test_mesh_quality_hex_volume_uses_cell_size_fallback(tmp_path, capsys):
    vtk = pytest.importorskip("vtk")
    path = _write_hexa_vtu(vtk, tmp_path / "cube.vtu")
    output = tmp_path / "cube-volume.vtu"

    args = _parse(
        analysis_cmds.cmd_mesh_quality,
        ["--file", str(path), "--output", str(output), "--metric", "volume"],
    )
    assert analysis_cmds.cmd_mesh_quality(args) == 0
    payload = json.loads(capsys.readouterr().out)

    assert payload["min"] == pytest.approx(8.0)
    assert payload["max"] == pytest.approx(8.0)
    assert output.is_file()


def test_mesh_quality_quad_min_angle_uses_vtk_quality(tmp_path, capsys):
    vtk = pytest.importorskip("vtk")
    path = _write_quad_vtp(vtk, tmp_path / "quad.vtp")
    output = tmp_path / "quad-angle.vtp"

    args = _parse(
        analysis_cmds.cmd_mesh_quality,
        ["--file", str(path), "--output", str(output), "--metric", "min-angle"],
    )
    assert analysis_cmds.cmd_mesh_quality(args) == 0
    payload = json.loads(capsys.readouterr().out)

    assert payload["min"] == pytest.approx(90.0)
    assert payload["max"] == pytest.approx(90.0)


def test_mesh_quality_hex_aspect_uses_vtk_quality(tmp_path, capsys):
    vtk = pytest.importorskip("vtk")
    path = _write_hexa_vtu(vtk, tmp_path / "cube.vtu")
    output = tmp_path / "cube-aspect.vtu"

    args = _parse(
        analysis_cmds.cmd_mesh_quality,
        ["--file", str(path), "--output", str(output), "--metric", "aspect"],
    )
    assert analysis_cmds.cmd_mesh_quality(args) == 0
    payload = json.loads(capsys.readouterr().out)

    assert payload["count"] == 1
    assert payload["max"] == pytest.approx(1.0)
    assert output.is_file()


def test_mesh_quality_rejects_unsupported_cell_type(tmp_path, capsys):
    vtk = pytest.importorskip("vtk")
    path = _write_line_vtp(vtk, tmp_path / "line.vtp")

    args = _parse(
        analysis_cmds.cmd_mesh_quality,
        [
            "--file",
            str(path),
            "--output",
            str(tmp_path / "line-angle.vtp"),
            "--metric",
            "min-angle",
        ],
    )
    assert analysis_cmds.cmd_mesh_quality(args) == 1
    assert "does not support VTK cell type ids" in _stderr_error(capsys)


def test_mesh_quality_replaces_existing_metric_array(tmp_path, capsys):
    vtk = pytest.importorskip("vtk")
    path = _write_hexa_vtu(vtk, tmp_path / "cube.vtu", existing_metric=True)
    output = tmp_path / "cube-aspect.vtu"

    args = _parse(
        analysis_cmds.cmd_mesh_quality,
        ["--file", str(path), "--output", str(output), "--metric", "aspect"],
    )
    assert analysis_cmds.cmd_mesh_quality(args) == 0
    capsys.readouterr()

    reader = vtk.vtkXMLUnstructuredGridReader()
    reader.SetFileName(str(output))
    reader.Update()
    names = [
        reader.GetOutput().GetCellData().GetArrayName(index)
        for index in range(reader.GetOutput().GetCellData().GetNumberOfArrays())
    ]
    assert names.count("mesh_quality_aspect") == 1


def test_mesh_quality_writes_legacy_vtk(tmp_path, capsys):
    vtk = pytest.importorskip("vtk")
    path = _write_hexa_vtu(vtk, tmp_path / "cube.vtu")
    output = tmp_path / "cube-volume.vtk"

    args = _parse(
        analysis_cmds.cmd_mesh_quality,
        ["--file", str(path), "--output", str(output), "--metric", "volume"],
    )
    assert analysis_cmds.cmd_mesh_quality(args) == 0
    capsys.readouterr()

    reader = vtk.vtkGenericDataObjectReader()
    reader.SetFileName(str(output))
    reader.Update()
    assert reader.GetOutput().GetCellData().GetArray("mesh_quality_volume") is not None


def test_mesh_quality_rejects_output_suffix_class_mismatch(tmp_path, capsys):
    vtk = pytest.importorskip("vtk")
    path = _write_hexa_vtu(vtk, tmp_path / "cube.vtu")

    args = _parse(
        analysis_cmds.cmd_mesh_quality,
        [
            "--file",
            str(path),
            "--output",
            str(tmp_path / "cube.vtp"),
            "--metric",
            "volume",
        ],
    )
    assert analysis_cmds.cmd_mesh_quality(args) == 1
    assert "requires a vtkPolyData dataset" in _stderr_error(capsys)


def test_vtk_quality_reports_missing_quality_array(monkeypatch):
    class _Quality:
        def SetInputData(self, _dataset):
            pass

        def SetTriangleQualityMeasureToMinAngle(self):
            pass

        def SetQuadQualityMeasureToMinAngle(self):
            pass

        def SetTetQualityMeasureToMinAngle(self):
            pass

        def SetTriangleQualityMeasureToAspectRatio(self):
            pass

        def SetQuadQualityMeasureToAspectRatio(self):
            pass

        def SetTetQualityMeasureToAspectRatio(self):
            pass

        def SetHexQualityMeasureToMaxAspectFrobenius(self):
            pass

        def Update(self):
            pass

        def GetOutput(self):
            return SimpleNamespace(GetCellData=lambda: SimpleNamespace(GetArray=lambda _name: None))

    class _VTK:
        VTK_TRIANGLE = 5
        VTK_QUAD = 9
        VTK_TETRA = 10
        VTK_HEXAHEDRON = 12
        vtkMeshQuality = _Quality

    class _Dataset:
        def GetCellType(self, _index):
            return 5

        def GetNumberOfCells(self):
            return 1

        def GetClassName(self):
            return "vtkStub"

    with pytest.raises(AnalysisError, match="could not compute the min-angle metric"):
        analysis_cmds._vtk_quality_metric(_VTK, None, _Dataset(), "min-angle")


def test_vtk_quality_reports_value_count_mismatch():
    class _Quality:
        def SetInputData(self, _dataset):
            pass

        def SetTriangleQualityMeasureToAspectRatio(self):
            pass

        def SetQuadQualityMeasureToAspectRatio(self):
            pass

        def SetTetQualityMeasureToAspectRatio(self):
            pass

        def SetHexQualityMeasureToMaxAspectFrobenius(self):
            pass

        def Update(self):
            pass

        def GetOutput(self):
            return SimpleNamespace(
                GetCellData=lambda: SimpleNamespace(GetArray=lambda _name: object())
            )

    class _VTK:
        VTK_TRIANGLE = 5
        VTK_QUAD = 9
        VTK_TETRA = 10
        VTK_HEXAHEDRON = 12
        vtkMeshQuality = _Quality

    class _Dataset:
        def GetCellType(self, _index):
            return 5

        def GetNumberOfCells(self):
            return 1

    numpy_support = SimpleNamespace(vtk_to_numpy=lambda _array: np.array([1.0, 2.0]))
    with pytest.raises(AnalysisError, match="2 aspect values for 1 cells"):
        analysis_cmds._vtk_quality_metric(_VTK, numpy_support, _Dataset(), "aspect")


def test_write_dataset_reports_missing_output(tmp_path):
    class _Writer:
        def SetFileName(self, _path):
            pass

        def SetInputData(self, _dataset):
            pass

        def Write(self):
            pass

    class _VTK:
        vtkGenericDataObjectWriter = _Writer

    output = tmp_path / "never-written.vtk"
    with pytest.raises(AnalysisError, match="Failed to write output VTK file"):
        analysis_cmds._write_dataset(_VTK(), object(), str(output), ".vtk")


def test_finite_range_rejects_all_non_finite_values():
    with pytest.raises(AnalysisError, match="no finite values"):
        analysis_cmds._finite_range(np.array([np.nan, np.inf]))


# ---------------------------------------------------------------------------
# Legacy input and point describe
# ---------------------------------------------------------------------------


def test_describe_point_array_from_legacy_vtk(tmp_path, capsys):
    vtk = pytest.importorskip("vtk")
    source = _write_hexa_vtu(vtk, tmp_path / "cube.vtu")
    reader = vtk.vtkXMLUnstructuredGridReader()
    reader.SetFileName(str(source))
    reader.Update()
    legacy = tmp_path / "cube.vtk"
    writer = vtk.vtkGenericDataObjectWriter()
    writer.SetFileName(str(legacy))
    writer.SetInputData(reader.GetOutput())
    writer.Write()

    args = _parse(
        analysis_cmds.cmd_describe,
        ["--file", str(legacy), "--array", "point:pv"],
    )
    assert analysis_cmds.cmd_describe(args) == 0
    payload = json.loads(capsys.readouterr().out)

    assert payload["association"] == "point"
    assert payload["array"] == "pv"
    assert payload["min"] == pytest.approx(1.5)
    assert payload["count"] == 8


# ---------------------------------------------------------------------------
# VTK fixture writers
# ---------------------------------------------------------------------------


def _write_hexa_vtu(vtk, path, block=True, existing_metric=False):
    coordinates = [
        (0.0, 0.0, 0.0),
        (2.0, 0.0, 0.0),
        (2.0, 2.0, 0.0),
        (0.0, 2.0, 0.0),
        (0.0, 0.0, 2.0),
        (2.0, 0.0, 2.0),
        (2.0, 2.0, 2.0),
        (0.0, 2.0, 2.0),
    ]
    points = vtk.vtkPoints()
    for coordinate in coordinates:
        points.InsertNextPoint(*coordinate)

    grid = vtk.vtkUnstructuredGrid()
    grid.SetPoints(points)
    hexahedron = vtk.vtkHexahedron()
    for index in range(8):
        hexahedron.GetPointIds().SetId(index, index)
    grid.InsertNextCell(hexahedron.GetCellType(), hexahedron.GetPointIds())

    values = vtk.vtkDoubleArray()
    values.SetName("value")
    values.InsertNextValue(2.5)
    grid.GetCellData().AddArray(values)

    point_values = vtk.vtkDoubleArray()
    point_values.SetName("pv")
    for _ in range(8):
        point_values.InsertNextValue(1.5)
    grid.GetPointData().AddArray(point_values)

    if block:
        block_ids = vtk.vtkIntArray()
        block_ids.SetName("block")
        block_ids.InsertNextValue(1)
        grid.GetCellData().AddArray(block_ids)

    if existing_metric:
        metric = vtk.vtkDoubleArray()
        metric.SetName("mesh_quality_aspect")
        metric.InsertNextValue(-1.0)
        grid.GetCellData().AddArray(metric)

    writer = vtk.vtkXMLUnstructuredGridWriter()
    writer.SetFileName(str(path))
    writer.SetInputData(grid)
    writer.Write()
    return path


def _write_quad_vtp(vtk, path):
    points = vtk.vtkPoints()
    for coordinate in [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (1.0, 1.0, 0.0), (0.0, 1.0, 0.0)]:
        points.InsertNextPoint(*coordinate)
    quad = vtk.vtkQuad()
    for index in range(4):
        quad.GetPointIds().SetId(index, index)
    polygons = vtk.vtkCellArray()
    polygons.InsertNextCell(quad)
    polydata = vtk.vtkPolyData()
    polydata.SetPoints(points)
    polydata.SetPolys(polygons)

    writer = vtk.vtkXMLPolyDataWriter()
    writer.SetFileName(str(path))
    writer.SetInputData(polydata)
    writer.Write()
    return path


def _write_line_vtp(vtk, path):
    points = vtk.vtkPoints()
    points.InsertNextPoint(0.0, 0.0, 0.0)
    points.InsertNextPoint(1.0, 0.0, 0.0)
    line = vtk.vtkLine()
    line.GetPointIds().SetId(0, 0)
    line.GetPointIds().SetId(1, 1)
    lines = vtk.vtkCellArray()
    lines.InsertNextCell(line)
    polydata = vtk.vtkPolyData()
    polydata.SetPoints(points)
    polydata.SetLines(lines)

    writer = vtk.vtkXMLPolyDataWriter()
    writer.SetFileName(str(path))
    writer.SetInputData(polydata)
    writer.Write()
    return path
