# Copyright (C) 2026 NukeHub and others.
# SPDX-License-Identifier: BSD-2-Clause
"""Tests for the pure analysis helpers and the base analysis commands.

``plugins.base.lib.analysis`` is numpy-only at import time (no vtk), so the
integration/describe/quality math runs in the minimal pytest + numpy
profile with exact analytic meshes. The ``base.integrate`` /
``base.describe`` / ``base.mesh-quality`` handlers keep vtk lazy: error
paths (missing file, bad array spec, missing vtk) run everywhere, while
the end-to-end VTK read/write tests skip cleanly when vtk is absent.
"""

import argparse
import json
import sys

import pytest

np = pytest.importorskip("numpy")

from nuke_viz.plugin import setup_parser_for_handler  # noqa: E402
from plugins.base.commands import analysis as analysis_cmds  # noqa: E402
from plugins.base.lib import analysis as analysis_lib  # noqa: E402
from plugins.base.lib.analysis import AnalysisError  # noqa: E402


def _parse(handler, argv):
    """Build a real parser for the handler and parse argv with it."""
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(handler, parser)
    return parser.parse_args(argv)


def _stderr_error(capsys):
    """Extract and JSON-decode the single {"error": ...} stderr line."""
    err = capsys.readouterr().err.strip()
    assert err.startswith('{"error"'), f"expected JSON error on stderr, got: {err!r}"
    return json.loads(err)["error"]


# ---------------------------------------------------------------------------
# integrate_cell_values / integrate_point_values
# ---------------------------------------------------------------------------


def test_integrate_cell_values_unit_cube():
    """Eight unit cubes with value 2.5 integrate to total 20 over volume 8."""
    values = [2.5] * 8
    volumes = [1.0] * 8

    stats = analysis_lib.integrate_cell_values(values, volumes)

    assert stats["total"] == pytest.approx(20.0)
    assert stats["mean"] == pytest.approx(2.5)
    assert stats["measure"] == pytest.approx(8.0)
    assert stats["count"] == 8
    assert stats["nanCount"] == 0


def test_integrate_cell_values_weighted_values():
    """A two-cell mix integrates value * volume exactly."""
    stats = analysis_lib.integrate_cell_values([1.0, 3.0], [2.0, 2.0])

    assert stats["total"] == pytest.approx(8.0)
    assert stats["mean"] == pytest.approx(2.0)
    assert stats["measure"] == pytest.approx(4.0)
    assert stats["count"] == 2


def test_integrate_cell_values_excludes_nan_and_inf():
    """Non-finite values are dropped and counted in nanCount."""
    stats = analysis_lib.integrate_cell_values(
        [1.0, float("nan"), 3.0, float("inf")], [1.0, 1.0, 1.0, 1.0]
    )

    assert stats["total"] == pytest.approx(4.0)
    assert stats["mean"] == pytest.approx(2.0)
    assert stats["measure"] == pytest.approx(2.0)
    assert stats["count"] == 2
    assert stats["nanCount"] == 2


def test_integrate_point_values_weighted_mean():
    """Point integration is the volume-weighted average times total volume."""
    stats = analysis_lib.integrate_point_values([1.0, 2.0, 3.0], [1.0, 1.0, 2.0])

    assert stats["total"] == pytest.approx(9.0)
    assert stats["mean"] == pytest.approx(2.25)
    assert stats["measure"] == pytest.approx(4.0)
    assert stats["count"] == 3


@pytest.mark.parametrize(
    ("values", "measures", "message"),
    [
        ([], [], "empty"),
        ([1.0, 2.0], [1.0], "same length"),
        ([1.0, 2.0], [1.0, -1.0], "non-negative"),
        ([1.0, 2.0], [0.0, 0.0], "total measure"),
        ([float("nan"), float("inf")], [1.0, 1.0], "no finite values"),
    ],
)
def test_integrate_rejects_bad_input(values, measures, message):
    """Empty, mismatched, negative or all-NaN integration input is rejected."""
    with pytest.raises(AnalysisError, match=message):
        analysis_lib.integrate_cell_values(values, measures)


def test_integrate_rejects_non_vector_values():
    """A multi-component array is not a scalar integration input."""
    with pytest.raises(AnalysisError, match="1-D"):
        analysis_lib.integrate_cell_values(np.zeros((2, 3)), [1.0, 1.0])


# ---------------------------------------------------------------------------
# describe_values
# ---------------------------------------------------------------------------


def test_describe_values_known_sequence():
    """Quartiles, mean and population std match numpy on 1..4."""
    stats = analysis_lib.describe_values([1.0, 2.0, 3.0, 4.0])

    assert stats["min"] == pytest.approx(1.0)
    assert stats["q1"] == pytest.approx(1.75)
    assert stats["median"] == pytest.approx(2.5)
    assert stats["q3"] == pytest.approx(3.25)
    assert stats["max"] == pytest.approx(4.0)
    assert stats["mean"] == pytest.approx(2.5)
    assert stats["std"] == pytest.approx(np.sqrt(1.25))
    assert stats["count"] == 4
    assert stats["nanCount"] == 0


def test_describe_values_excludes_non_finite():
    """NaN and inf entries are excluded from stats and reported separately."""
    stats = analysis_lib.describe_values([1.0, float("nan"), 3.0, float("inf")])

    assert stats["min"] == pytest.approx(1.0)
    assert stats["q1"] == pytest.approx(1.5)
    assert stats["median"] == pytest.approx(2.0)
    assert stats["q3"] == pytest.approx(2.5)
    assert stats["max"] == pytest.approx(3.0)
    assert stats["mean"] == pytest.approx(2.0)
    assert stats["std"] == pytest.approx(1.0)
    assert stats["count"] == 2
    assert stats["nanCount"] == 2


@pytest.mark.parametrize("values", [[], [float("nan")], [float("inf"), float("nan")]])
def test_describe_values_rejects_empty_or_non_finite(values):
    """An empty or entirely non-finite array cannot be described."""
    with pytest.raises(AnalysisError):
        analysis_lib.describe_values(values)


# ---------------------------------------------------------------------------
# mesh_quality_triangles
# ---------------------------------------------------------------------------


def test_triangle_quality_right_isosceles():
    """A unit right isosceles triangle has area 0.5, min angle 45 and R/2r ~1.207."""
    quality = analysis_lib.mesh_quality_triangles(
        [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0)], [[0, 1, 2]]
    )

    assert quality["count"] == 1
    assert quality["area"][0] == pytest.approx(0.5)
    assert quality["min_angle"][0] == pytest.approx(45.0)
    assert quality["aspect_ratio"][0] == pytest.approx((2**0.5 + 1.0) / 2.0)
    assert quality["skew"][0] == pytest.approx(0.25)


def test_triangle_quality_equilateral():
    """An equilateral triangle is the ideal: 60 degrees, aspect 1 and skew 0."""
    height = 3**0.5 / 2.0
    quality = analysis_lib.mesh_quality_triangles(
        [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.5, height, 0.0)], [[0, 1, 2]]
    )

    assert quality["area"][0] == pytest.approx(3**0.5 / 4.0)
    assert quality["min_angle"][0] == pytest.approx(60.0)
    assert quality["aspect_ratio"][0] == pytest.approx(1.0)
    assert quality["skew"][0] == pytest.approx(0.0)


def test_triangle_quality_degenerate_is_data_not_error():
    """A collinear triangle reports zero area/angle and infinite aspect."""
    quality = analysis_lib.mesh_quality_triangles(
        [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (2.0, 0.0, 0.0)], [[0, 1, 2]]
    )

    assert quality["area"][0] == pytest.approx(0.0)
    assert quality["min_angle"][0] == pytest.approx(0.0)
    assert quality["aspect_ratio"][0] == float("inf")
    assert quality["skew"][0] == pytest.approx(1.0)


def test_triangle_quality_empty_and_bad_shapes():
    """Empty meshes, wrong widths and out-of-range indices are rejected."""
    positions = [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0)]
    with pytest.raises(AnalysisError, match="no triangles"):
        analysis_lib.mesh_quality_triangles(positions, [])
    with pytest.raises(AnalysisError, match="index array"):
        analysis_lib.mesh_quality_triangles(positions, [[0, 1]])
    with pytest.raises(AnalysisError, match="outside positions"):
        analysis_lib.mesh_quality_triangles(positions, [[0, 1, 3]])
    with pytest.raises(AnalysisError, match="empty"):
        analysis_lib.mesh_quality_triangles([], [[0, 1, 2]])


def test_triangle_quality_returns_json_safe_lists_and_numpy_on_request():
    """Default output is JSON-safe; as_lists=False returns numpy arrays."""
    positions = [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0)]
    quality = analysis_lib.mesh_quality_triangles(positions, [[0, 1, 2]])

    assert isinstance(quality["area"], list)
    assert json.loads(json.dumps(quality))["area"] == quality["area"]

    arrays = analysis_lib.mesh_quality_triangles(positions, [[0, 1, 2]], as_lists=False)
    assert isinstance(arrays["area"], np.ndarray)
    assert arrays["area"][0] == pytest.approx(0.5)


def test_triangle_quality_can_skip_skew():
    """include_skew=False omits the skew array."""
    quality = analysis_lib.mesh_quality_triangles(
        [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0)],
        [[0, 1, 2]],
        include_skew=False,
    )

    assert "skew" not in quality


# ---------------------------------------------------------------------------
# mesh_quality_tets
# ---------------------------------------------------------------------------


def test_tet_quality_unit_corner_tet():
    """A unit corner tetrahedron has volume 1/6 and the analytic aspect ratio."""
    quality = analysis_lib.mesh_quality_tets(
        [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)],
        [[0, 1, 2, 3]],
    )

    assert quality["count"] == 1
    assert quality["volume"][0] == pytest.approx(1.0 / 6.0)
    assert quality["surface_area"][0] == pytest.approx((3.0 + 3**0.5) / 2.0)
    assert quality["aspect_ratio"][0] == pytest.approx((1.0 + 3**0.5) / 2.0)


def test_tet_quality_degenerate_and_empty():
    """A coplanar tet reports zero volume/infinite aspect; an empty mesh errors."""
    quality = analysis_lib.mesh_quality_tets(
        [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (1.0, 1.0, 0.0)],
        [[0, 1, 2, 3]],
    )
    assert quality["volume"][0] == pytest.approx(0.0)
    assert quality["aspect_ratio"][0] == float("inf")

    with pytest.raises(AnalysisError, match="no tets"):
        analysis_lib.mesh_quality_tets([(0.0, 0.0, 0.0)], [])


# ---------------------------------------------------------------------------
# Command argument parsing and error paths (no vtk required)
# ---------------------------------------------------------------------------


def test_parse_array_spec():
    """Array specs split on the first colon and validate the association."""
    assert analysis_cmds.parse_array_spec("cell:flux") == ("cell", "flux")
    assert analysis_cmds.parse_array_spec("point: temperature ") == ("point", "temperature")
    assert analysis_cmds.parse_array_spec("cell:block:value") == ("cell", "block:value")

    with pytest.raises(AnalysisError, match="cell:<name>"):
        analysis_cmds.parse_array_spec("flux")
    with pytest.raises(AnalysisError, match="association"):
        analysis_cmds.parse_array_spec("vertex:flux")
    with pytest.raises(AnalysisError, match="array name"):
        analysis_cmds.parse_array_spec("cell:")


def test_integrate_arguments_default_and_flags():
    """--surface/--volume are booleans and --block is optional."""
    args = _parse(
        analysis_cmds.cmd_integrate,
        ["--file", "mesh.vtu", "--array", "cell:flux"],
    )
    assert args.surface is False
    assert args.volume is False
    assert args.block is None

    args = _parse(
        analysis_cmds.cmd_integrate,
        ["--file", "mesh.vtu", "--array", "point:t", "--surface", "--block", "3"],
    )
    assert args.surface is True
    assert args.block == 3


def test_integrate_requires_file_and_array():
    """--file and --array are required; argparse aborts with SystemExit."""
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(analysis_cmds.cmd_integrate, parser)
    with pytest.raises(SystemExit) as excinfo:
        parser.parse_args(["--file", "mesh.vtu"])
    assert excinfo.value.code == 2


def test_mesh_quality_metric_choices_and_default():
    """--metric defaults to aspect and rejects unknown metrics."""
    args = _parse(
        analysis_cmds.cmd_mesh_quality,
        ["--file", "mesh.vtp", "--output", "out.vtp"],
    )
    assert args.metric == "aspect"

    args = _parse(
        analysis_cmds.cmd_mesh_quality,
        ["--file", "mesh.vtp", "--output", "out.vtp", "--metric", "min-angle"],
    )
    assert args.metric == "min-angle"

    parser = argparse.ArgumentParser()
    setup_parser_for_handler(analysis_cmds.cmd_mesh_quality, parser)
    with pytest.raises(SystemExit) as excinfo:
        parser.parse_args(["--file", "mesh.vtp", "--output", "out.vtp", "--metric", "skew"])
    assert excinfo.value.code == 2


def test_integrate_missing_file(capsys):
    """A nonexistent VTK file fails with a JSON error on stderr and exit 1."""
    args = _parse(
        analysis_cmds.cmd_integrate,
        ["--file", "/no/such/mesh.vtk", "--array", "cell:flux"],
    )

    rc = analysis_cmds.cmd_integrate(args)

    assert rc == 1
    assert "File not found" in _stderr_error(capsys)


def test_integrate_exclusive_surface_volume_flags(capsys):
    """--surface and --volume together fail before any file or vtk access."""
    args = _parse(
        analysis_cmds.cmd_integrate,
        ["--file", "/no/such/mesh.vtk", "--array", "cell:flux", "--surface", "--volume"],
    )

    rc = analysis_cmds.cmd_integrate(args)

    assert rc == 1
    assert "mutually exclusive" in _stderr_error(capsys)


def test_describe_bad_array_spec(capsys):
    """A missing association prefix fails before any file or vtk access."""
    args = _parse(
        analysis_cmds.cmd_describe,
        ["--file", "/no/such/mesh.vtk", "--array", "flux"],
    )

    rc = analysis_cmds.cmd_describe(args)

    assert rc == 1
    assert "cell:<name>" in _stderr_error(capsys)


def test_mesh_quality_bad_output_suffix(tmp_path, capsys):
    """An unsupported output suffix fails before vtk is imported."""
    fake = tmp_path / "mesh.vtk"
    fake.write_text("fake")

    args = _parse(
        analysis_cmds.cmd_mesh_quality,
        ["--file", str(fake), "--output", str(tmp_path / "out.xyz"), "--metric", "area"],
    )

    rc = analysis_cmds.cmd_mesh_quality(args)

    assert rc == 1
    assert "Unsupported output suffix" in _stderr_error(capsys)


def test_analysis_commands_report_missing_vtk(tmp_path, monkeypatch, capsys):
    """A missing vtk dependency surfaces as a JSON error, never a traceback."""
    fake = tmp_path / "mesh.vtk"
    fake.write_text("fake")
    monkeypatch.setitem(sys.modules, "vtk", None)

    args = _parse(
        analysis_cmds.cmd_describe,
        ["--file", str(fake), "--array", "cell:flux"],
    )
    rc = analysis_cmds.cmd_describe(args)

    assert rc == 1
    assert "vtk" in _stderr_error(capsys)


# ---------------------------------------------------------------------------
# Command end-to-end over real VTK datasets (skip without vtk)
# ---------------------------------------------------------------------------


def _write_hexa_vtu(vtk, path, cell_value=2.5, point_value=2.5, block_id=1):
    """Write one 2x2x2 hexahedron with scalar cell/point/block arrays."""
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

    cell_values = vtk.vtkDoubleArray()
    cell_values.SetName("value")
    cell_values.InsertNextValue(cell_value)
    grid.GetCellData().AddArray(cell_values)

    point_values = vtk.vtkDoubleArray()
    point_values.SetName("point_value")
    for _ in range(8):
        point_values.InsertNextValue(point_value)
    grid.GetPointData().AddArray(point_values)

    blocks = vtk.vtkIntArray()
    blocks.SetName("block")
    blocks.InsertNextValue(block_id)
    grid.GetCellData().AddArray(blocks)

    writer = vtk.vtkXMLUnstructuredGridWriter()
    writer.SetFileName(str(path))
    writer.SetInputData(grid)
    writer.Write()
    return path


def _write_unit_triangle_vtp(vtk, path):
    """Write one unit right-isosceles triangle as XML polydata."""
    points = vtk.vtkPoints()
    for coordinate in [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0)]:
        points.InsertNextPoint(*coordinate)

    triangle = vtk.vtkTriangle()
    for index in range(3):
        triangle.GetPointIds().SetId(index, index)
    polygons = vtk.vtkCellArray()
    polygons.InsertNextCell(triangle)

    polydata = vtk.vtkPolyData()
    polydata.SetPoints(points)
    polydata.SetPolys(polygons)

    writer = vtk.vtkXMLPolyDataWriter()
    writer.SetFileName(str(path))
    writer.SetInputData(polydata)
    writer.Write()
    return path


def test_integrate_command_cell_array(tmp_path, capsys):
    """base.integrate reports total 20 for a 2.5-valued volume-8 hex."""
    vtk = pytest.importorskip("vtk")
    path = _write_hexa_vtu(vtk, tmp_path / "cube.vtu")

    args = _parse(
        analysis_cmds.cmd_integrate,
        ["--file", str(path), "--array", "cell:value"],
    )
    rc = analysis_cmds.cmd_integrate(args)
    payload = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert payload["total"] == pytest.approx(20.0)
    assert payload["mean"] == pytest.approx(2.5)
    assert payload["measure"] == pytest.approx(8.0)
    assert payload["measureKind"] == "volume"
    assert payload["count"] == 1
    assert payload["perBlock"] == [
        {
            "block": 1,
            "total": pytest.approx(20.0),
            "mean": pytest.approx(2.5),
            "measure": pytest.approx(8.0),
            "count": 1,
            "nanCount": 0,
        }
    ]


def test_integrate_command_point_array(tmp_path, capsys):
    """base.integrate lumps cell volume over points and reports the mean."""
    vtk = pytest.importorskip("vtk")
    path = _write_hexa_vtu(vtk, tmp_path / "cube-points.vtu", point_value=2.5)

    args = _parse(
        analysis_cmds.cmd_integrate,
        ["--file", str(path), "--array", "point:point_value"],
    )
    rc = analysis_cmds.cmd_integrate(args)
    payload = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert payload["total"] == pytest.approx(20.0)
    assert payload["mean"] == pytest.approx(2.5)
    assert payload["measure"] == pytest.approx(8.0)
    assert payload["count"] == 8
    assert payload["association"] == "point"
    assert "perBlock" not in payload


def test_integrate_command_unstructured_surface_defaults_to_area(tmp_path, capsys):
    """A triangle .vtu defaults to area even though its dataset type is a grid."""
    vtk = pytest.importorskip("vtk")
    points = vtk.vtkPoints()
    for coordinate in [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0)]:
        points.InsertNextPoint(*coordinate)
    triangle = vtk.vtkTriangle()
    for index in range(3):
        triangle.GetPointIds().SetId(index, index)
    grid = vtk.vtkUnstructuredGrid()
    grid.SetPoints(points)
    grid.InsertNextCell(triangle.GetCellType(), triangle.GetPointIds())
    cell_values = vtk.vtkDoubleArray()
    cell_values.SetName("value")
    cell_values.InsertNextValue(4.0)
    grid.GetCellData().AddArray(cell_values)
    source = tmp_path / "surface.vtu"
    writer = vtk.vtkXMLUnstructuredGridWriter()
    writer.SetFileName(str(source))
    writer.SetInputData(grid)
    writer.Write()

    args = _parse(
        analysis_cmds.cmd_integrate,
        ["--file", str(source), "--array", "cell:value"],
    )
    rc = analysis_cmds.cmd_integrate(args)
    payload = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert payload["measureKind"] == "area"
    assert payload["measure"] == pytest.approx(0.5)
    assert payload["total"] == pytest.approx(2.0)
    assert payload["mean"] == pytest.approx(4.0)


def test_integrate_command_block_filter(tmp_path, capsys):
    """--block selects only the matching block before integration."""
    vtk = pytest.importorskip("vtk")
    path = _write_hexa_vtu(vtk, tmp_path / "cube-block.vtu", block_id=7)

    args = _parse(
        analysis_cmds.cmd_integrate,
        ["--file", str(path), "--array", "cell:value", "--block", "7"],
    )
    rc = analysis_cmds.cmd_integrate(args)
    payload = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert payload["total"] == pytest.approx(20.0)

    args = _parse(
        analysis_cmds.cmd_integrate,
        ["--file", str(path), "--array", "cell:value", "--block", "8"],
    )
    rc = analysis_cmds.cmd_integrate(args)
    assert rc == 1
    assert "block id 8 not found" in _stderr_error(capsys)


def test_describe_command_cell_array(tmp_path, capsys):
    """base.describe reports the stats of a scalar cell array."""
    vtk = pytest.importorskip("vtk")
    path = _write_hexa_vtu(vtk, tmp_path / "cube-describe.vtu")

    args = _parse(
        analysis_cmds.cmd_describe,
        ["--file", str(path), "--array", "cell:value"],
    )
    rc = analysis_cmds.cmd_describe(args)
    payload = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert payload["min"] == pytest.approx(2.5)
    assert payload["max"] == pytest.approx(2.5)
    assert payload["mean"] == pytest.approx(2.5)
    assert payload["std"] == pytest.approx(0.0)
    assert payload["count"] == 1


@pytest.mark.parametrize(
    ("metric", "expected"),
    [
        ("area", 0.5),
        ("min-angle", 45.0),
        ("aspect", (2**0.5 + 1.0) / 2.0),
    ],
)
def test_mesh_quality_command_triangle(tmp_path, capsys, metric, expected):
    """Mesh-quality writes the metric cell array and reports its range."""
    vtk = pytest.importorskip("vtk")
    source = _write_unit_triangle_vtp(vtk, tmp_path / "triangle.vtp")
    output = tmp_path / f"triangle-{metric}.vtp"

    args = _parse(
        analysis_cmds.cmd_mesh_quality,
        ["--file", str(source), "--output", str(output), "--metric", metric],
    )
    rc = analysis_cmds.cmd_mesh_quality(args)
    payload = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert payload["path"] == str(output)
    assert payload["metric"] == metric
    assert payload["min"] == pytest.approx(expected)
    assert payload["max"] == pytest.approx(expected)
    assert payload["arrayName"] == "mesh_quality_" + metric.replace("-", "_")
    assert output.is_file()

    reader = vtk.vtkXMLPolyDataReader()
    reader.SetFileName(str(output))
    reader.Update()
    array = reader.GetOutput().GetCellData().GetArray(payload["arrayName"])
    assert array is not None
    assert array.GetNumberOfTuples() == 1
    assert array.GetTuple1(0) == pytest.approx(expected)


def test_mesh_quality_command_volume_on_surface_fails(tmp_path, capsys):
    """Volume on an all-triangle surface mesh fails with a clear message."""
    vtk = pytest.importorskip("vtk")
    source = _write_unit_triangle_vtp(vtk, tmp_path / "surface.vtp")

    args = _parse(
        analysis_cmds.cmd_mesh_quality,
        [
            "--file",
            str(source),
            "--output",
            str(tmp_path / "surface-volume.vtp"),
            "--metric",
            "volume",
        ],
    )
    rc = analysis_cmds.cmd_mesh_quality(args)

    assert rc == 1
    assert "surface mesh" in _stderr_error(capsys)


def test_mesh_quality_command_tet_volume(tmp_path, capsys):
    """An all-tet unstructured grid uses the pure-numpy volume path."""
    vtk = pytest.importorskip("vtk")
    points = vtk.vtkPoints()
    for coordinate in [
        (0.0, 0.0, 0.0),
        (1.0, 0.0, 0.0),
        (0.0, 1.0, 0.0),
        (0.0, 0.0, 1.0),
    ]:
        points.InsertNextPoint(*coordinate)
    tetra = vtk.vtkTetra()
    for index in range(4):
        tetra.GetPointIds().SetId(index, index)
    grid = vtk.vtkUnstructuredGrid()
    grid.SetPoints(points)
    grid.InsertNextCell(tetra.GetCellType(), tetra.GetPointIds())
    source = tmp_path / "tet.vtu"
    writer = vtk.vtkXMLUnstructuredGridWriter()
    writer.SetFileName(str(source))
    writer.SetInputData(grid)
    writer.Write()

    args = _parse(
        analysis_cmds.cmd_mesh_quality,
        [
            "--file",
            str(source),
            "--output",
            str(tmp_path / "tet-volume.vtu"),
            "--metric",
            "volume",
        ],
    )
    rc = analysis_cmds.cmd_mesh_quality(args)
    payload = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert payload["min"] == pytest.approx(1.0 / 6.0)
    assert payload["max"] == pytest.approx(1.0 / 6.0)
    assert payload["arrayName"] == "mesh_quality_volume"
