# Copyright (C) 2026 NukeHub and others.
# SPDX-License-Identifier: BSD-2-Clause
"""Tests for the pure export helpers and the base export command.

``plugins.base.lib.export`` is stdlib-only at import time (no vtk), so CSV
rendering, format/extension validation, and array-spec parsing run in the
minimal pytest + numpy profile. The ``base.export`` handler keeps vtk lazy:
error paths (missing file, bad format, bad output suffix, missing array)
run everywhere, while the end-to-end CSV/VTK/glTF tests skip cleanly when
vtk is absent.
"""

import argparse
import csv
import io
import json
import sys

import pytest
from nuke_viz.plugin import setup_parser_for_handler
from plugins.base.commands import export as export_cmds
from plugins.base.lib import export as export_lib
from plugins.base.lib.export import ExportError


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


def _parse_csv(text):
    """Parse CSV text into header + rows."""
    return list(csv.reader(io.StringIO(text)))


def _read_csv(path):
    """Parse a written CSV file into header + rows."""
    with open(path, newline="", encoding="utf-8") as handle:
        return list(csv.reader(handle))


# ---------------------------------------------------------------------------
# Format and output-extension validation
# ---------------------------------------------------------------------------


def test_validate_export_format_normalizes_names():
    """Formats are case-insensitive and whitespace tolerant."""
    assert export_lib.validate_export_format("csv") == "csv"
    assert export_lib.validate_export_format(" VTK ") == "vtk"
    assert export_lib.validate_export_format("GltF") == "gltf"


@pytest.mark.parametrize("value", ["json", "", "  ", None, 3])
def test_validate_export_format_rejects_unknown(value):
    """Unknown or non-string formats raise ExportError (a ValueError)."""
    with pytest.raises(ExportError, match="Unsupported export format"):
        export_lib.validate_export_format(value)


def test_default_extension_per_format():
    """Each format has its own default suffix."""
    assert export_lib.default_extension("csv") == ".csv"
    assert export_lib.default_extension("vtk") == ".vtk"
    assert export_lib.default_extension("gltf") == ".gltf"
    with pytest.raises(ExportError):
        export_lib.default_extension("json")


@pytest.mark.parametrize(
    ("path", "format_name", "expected"),
    [
        ("out.csv", "csv", ".csv"),
        ("out.CSV", "csv", ".csv"),
        ("out.vtk", "vtk", ".vtk"),
        ("out.vtp", "vtk", ".vtp"),
        ("out.vtu", "vtk", ".vtu"),
        ("out.vti", "vtk", ".vti"),
        ("out.vtr", "vtk", ".vtr"),
        ("out.vts", "vtk", ".vts"),
        ("out.gltf", "gltf", ".gltf"),
        ("out.glb", "gltf", ".glb"),
    ],
)
def test_validate_output_extension_accepts_matching_suffixes(path, format_name, expected):
    """Every documented suffix is accepted case-insensitively."""
    assert export_lib.validate_output_extension(path, format_name) == expected


@pytest.mark.parametrize(
    ("path", "format_name"),
    [
        ("out.xyz", "csv"),
        ("out.csv", "vtk"),
        ("out.vtu", "csv"),
        ("out.csv", "gltf"),
        ("out", "csv"),
        ("", "csv"),
    ],
)
def test_validate_output_extension_rejects_mismatches(path, format_name):
    """Wrong or missing suffixes are rejected with a format-specific message."""
    with pytest.raises(ExportError, match="output suffix|non-empty path"):
        export_lib.validate_output_extension(path, format_name)


# ---------------------------------------------------------------------------
# CSV rendering
# ---------------------------------------------------------------------------


def test_array_to_csv_scalar_header_and_rows():
    """A scalar array renders one row per tuple after the tuple column."""
    text = export_lib.array_to_csv([1.0, 2.0, 3.0], 1, [("tuple", [0, 1, 2])], name="value")

    assert text == "tuple,value\n0,1.0\n1,2.0\n2,3.0\n"
    assert _parse_csv(text) == [
        ["tuple", "value"],
        ["0", "1.0"],
        ["1", "2.0"],
        ["2", "3.0"],
    ]


def test_array_to_csv_multi_component_columns():
    """Multi-component arrays expand to name[i] columns."""
    text = export_lib.array_to_csv([1, 2, 3, 4], 2, [("tuple", [0, 1])], name="vector")

    assert text == "tuple,vector[0],vector[1]\n0,1,2\n1,3,4\n"
    assert _parse_csv(text)[0] == ["tuple", "vector[0]", "vector[1]"]


def test_array_to_csv_rfc4180_quoting():
    """Commas, quotes, and embedded newlines are quoted per RFC 4180."""
    text = export_lib.array_to_csv(
        ["a,b", 'say "hi"', "line\nbreak"], 1, [("tuple", [0, 1, 2])], name="label"
    )

    assert text == 'tuple,label\n0,"a,b"\n1,"say ""hi"""\n2,"line\nbreak"\n'
    assert _parse_csv(text) == [
        ["tuple", "label"],
        ["0", "a,b"],
        ["1", 'say "hi"'],
        ["2", "line\nbreak"],
    ]


def test_array_to_csv_empty_array_renders_header_only():
    """An empty array keeps its header and writes no data rows."""
    assert export_lib.array_to_csv([], 1, [("tuple", [])], name="value") == "tuple,value\n"


def test_export_csv_payload_combines_arrays_and_extra_columns():
    """Multiple arrays share the tuple column and preserve tuple order."""
    payload = export_lib.export_csv_payload(
        [
            {"name": "a", "values": [1.0, 2.0], "components": 1},
            ("b", [3.0, 4.0], 1),
        ],
        [("tuple", [0, 1])],
    )

    assert payload["columns"] == ["tuple", "a", "b"]
    assert payload["rows"] == 2
    assert payload["arrays"] == ["a", "b"]
    assert payload["csv"] == "tuple,a,b\n0,1.0,3.0\n1,2.0,4.0\n"


def test_export_csv_payload_empty_is_empty():
    """No arrays and no extra columns produce an empty payload."""
    assert export_lib.export_csv_payload([]) == {
        "csv": "",
        "columns": [],
        "rows": 0,
        "arrays": [],
    }


def test_export_csv_payload_extra_columns_only():
    """Extra columns without arrays still produce a valid header."""
    payload = export_lib.export_csv_payload([], {"tuple": []})

    assert payload["csv"] == "tuple\n"
    assert payload["columns"] == ["tuple"]
    assert payload["rows"] == 0


def test_csv_formatting_blanks_non_finite_and_normalizes_zero():
    """NaN/inf cells are empty and negative zero renders as 0."""
    text = export_lib.array_to_csv(
        [float("nan"), float("inf"), -0.0, 2.5],
        1,
        [("tuple", [0, 1, 2, 3])],
        name="value",
    )

    assert text == "tuple,value\n0,\n1,\n2,0\n3,2.5\n"


@pytest.mark.parametrize(
    ("values", "components", "error"),
    [
        ([1, 2, 3], 2, "not a multiple"),
        ([1, 2], 0, "positive integer"),
        ([1, 2], -1, "positive integer"),
    ],
)
def test_array_to_csv_rejects_bad_shapes(values, components, error):
    """Non-divisible value counts and non-positive components are rejected."""
    with pytest.raises(ExportError, match=error):
        export_lib.array_to_csv(values, components, [("tuple", [0])], name="value")


def test_export_csv_payload_rejects_mismatched_tuple_counts():
    """Arrays and extra columns must agree on the tuple count."""
    with pytest.raises(ExportError, match="expected 1"):
        export_lib.export_csv_payload(
            [
                {"name": "a", "values": [1], "components": 1},
                {"name": "b", "values": [1, 2], "components": 1},
            ]
        )

    with pytest.raises(ExportError, match="expected 2"):
        export_lib.export_csv_payload(
            [{"name": "a", "values": [1, 2], "components": 1}],
            [("tuple", [0])],
        )


def test_export_csv_payload_rejects_bad_entries():
    """Malformed array/extra-column entries and unnamed arrays are rejected."""
    with pytest.raises(ExportError, match="mapping or a"):
        export_lib.export_csv_payload([("only", "two")])

    with pytest.raises(ExportError, match="non-empty string"):
        export_lib.export_csv_payload([{"name": "", "values": [1]}])

    with pytest.raises(ExportError, match="sized sequence"):
        export_lib.export_csv_payload([{"name": "a", "values": (value for value in [1])}])

    with pytest.raises(ExportError, match="pairs"):
        export_lib.export_csv_payload([{"name": "a", "values": [1]}], [("tuple",)])

    with pytest.raises(ExportError, match="sized sequence"):
        export_lib.export_csv_payload([], [("tuple", (value for value in [0]))])


def test_format_export_value_keeps_integers_exact():
    """Integers keep their decimal form instead of becoming floats."""
    assert export_lib.format_export_value(7) == "7"
    assert export_lib.format_export_value(-2) == "-2"
    assert export_lib.format_export_value(True) == "1"
    assert export_lib.format_export_value(None) == ""


# ---------------------------------------------------------------------------
# Array spec parsing
# ---------------------------------------------------------------------------


def test_parse_array_spec():
    """Array specs split on the first colon and validate the association."""
    assert export_lib.parse_array_spec("cell:flux") == ("cell", "flux")
    assert export_lib.parse_array_spec("point: temperature ") == ("point", "temperature")
    assert export_lib.parse_array_spec("cell:block:value") == ("cell", "block:value")

    with pytest.raises(ExportError, match="cell:<name>"):
        export_lib.parse_array_spec("flux")
    with pytest.raises(ExportError, match="association"):
        export_lib.parse_array_spec("vertex:flux")
    with pytest.raises(ExportError, match="array name"):
        export_lib.parse_array_spec("cell:")


# ---------------------------------------------------------------------------
# Command parsing and error paths (no vtk required)
# ---------------------------------------------------------------------------


def test_export_arguments_default_and_flags():
    """--format defaults to csv; --array/--block are optional."""
    args = _parse(
        export_cmds.cmd_export,
        ["--file", "mesh.vtu", "--output", "out.csv"],
    )
    assert args.format == "csv"
    assert args.array is None
    assert args.block is None

    args = _parse(
        export_cmds.cmd_export,
        [
            "--file",
            "mesh.vtu",
            "--output",
            "out.vtu",
            "--format",
            "vtk",
            "--array",
            "cell:flux",
            "--block",
            "3",
        ],
    )
    assert args.format == "vtk"
    assert args.array == "cell:flux"
    assert args.block == 3


def test_export_requires_file_and_output():
    """--file and --output are required; argparse aborts with SystemExit."""
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(export_cmds.cmd_export, parser)
    with pytest.raises(SystemExit) as excinfo:
        parser.parse_args(["--file", "mesh.vtu"])
    assert excinfo.value.code == 2

    parser = argparse.ArgumentParser()
    setup_parser_for_handler(export_cmds.cmd_export, parser)
    with pytest.raises(SystemExit) as excinfo:
        parser.parse_args(["--output", "out.csv"])
    assert excinfo.value.code == 2


def test_export_invalid_format_is_json_error(tmp_path, capsys):
    """An unknown --format fails with one JSON error and exit code 1."""
    fake = tmp_path / "mesh.vtu"
    fake.write_text("fake")

    args = _parse(
        export_cmds.cmd_export,
        ["--file", str(fake), "--output", str(tmp_path / "out.csv"), "--format", "json"],
    )

    assert export_cmds.cmd_export(args) == 1
    assert "Unsupported export format" in _stderr_error(capsys)


def test_export_invalid_output_suffix_is_json_error(tmp_path, capsys):
    """An output suffix that does not match the format fails before vtk."""
    fake = tmp_path / "mesh.vtu"
    fake.write_text("fake")

    args = _parse(
        export_cmds.cmd_export,
        ["--file", str(fake), "--output", str(tmp_path / "out.xyz"), "--format", "csv"],
    )

    assert export_cmds.cmd_export(args) == 1
    assert "Unsupported output suffix" in _stderr_error(capsys)


def test_export_missing_file(tmp_path, capsys):
    """A nonexistent VTK file fails with a JSON error and exit code 1."""
    args = _parse(
        export_cmds.cmd_export,
        ["--file", str(tmp_path / "missing.vtu"), "--output", str(tmp_path / "out.csv")],
    )

    assert export_cmds.cmd_export(args) == 1
    assert "File not found" in _stderr_error(capsys)


def test_export_reports_missing_vtk(tmp_path, monkeypatch, capsys):
    """A missing vtk dependency surfaces as a JSON error, never a traceback."""
    fake = tmp_path / "mesh.vtu"
    fake.write_text("fake")
    monkeypatch.setitem(sys.modules, "vtk", None)

    args = _parse(
        export_cmds.cmd_export,
        ["--file", str(fake), "--output", str(tmp_path / "out.csv")],
    )

    assert export_cmds.cmd_export(args) == 1
    assert "vtk is required" in _stderr_error(capsys)


def test_export_gltf_rejects_array_before_reading(tmp_path, capsys):
    """glTF stores geometry only, so --array fails before vtk is imported."""
    fake = tmp_path / "mesh.vtu"
    fake.write_text("fake")

    args = _parse(
        export_cmds.cmd_export,
        [
            "--file",
            str(fake),
            "--output",
            str(tmp_path / "out.gltf"),
            "--format",
            "gltf",
            "--array",
            "point:temperature",
        ],
    )

    assert export_cmds.cmd_export(args) == 1
    assert "not supported for glTF" in _stderr_error(capsys)


def test_resolve_output_path_appends_matching_suffix():
    """Extensionless outputs inherit the format (VTK prefers the input suffix)."""
    assert export_cmds._resolve_output_path("out", "csv", "mesh.vtp") == "out.csv"
    assert export_cmds._resolve_output_path("out", "gltf", "mesh.vtp") == "out.gltf"
    assert export_cmds._resolve_output_path("out", "vtk", "mesh.vtu") == "out.vtu"
    assert export_cmds._resolve_output_path("out", "vtk", "mesh.vtk") == "out.vtk"
    assert export_cmds._resolve_output_path("out.vtp", "vtk", "mesh.vtu") == "out.vtp"


# ---------------------------------------------------------------------------
# Command end-to-end over real VTK datasets (skip without vtk)
# ---------------------------------------------------------------------------


def _write_triangle_vtp(vtk, path, block_id=7):
    """Write one triangle with point/cell arrays and a block id."""
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

    temperature = vtk.vtkDoubleArray()
    temperature.SetName("temperature")
    for value in (10.0, 20.0, 30.0):
        temperature.InsertNextValue(value)
    polydata.GetPointData().AddArray(temperature)

    vector = vtk.vtkDoubleArray()
    vector.SetName("vector")
    vector.SetNumberOfComponents(2)
    for value in (1.0, 2.0, 3.0, 4.0, 5.0, 6.0):
        vector.InsertNextValue(value)
    polydata.GetPointData().AddArray(vector)

    pressure = vtk.vtkDoubleArray()
    pressure.SetName("pressure")
    pressure.InsertNextValue(5.0)
    polydata.GetCellData().AddArray(pressure)

    blocks = vtk.vtkIntArray()
    blocks.SetName("block")
    blocks.InsertNextValue(block_id)
    polydata.GetCellData().AddArray(blocks)

    writer = vtk.vtkXMLPolyDataWriter()
    writer.SetFileName(str(path))
    writer.SetInputData(polydata)
    writer.Write()
    return path


def _write_cell_only_vtp(vtk, path):
    """Write one triangle with only cell arrays (no point arrays)."""
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

    pressure = vtk.vtkDoubleArray()
    pressure.SetName("pressure")
    pressure.InsertNextValue(5.0)
    polydata.GetCellData().AddArray(pressure)

    writer = vtk.vtkXMLPolyDataWriter()
    writer.SetFileName(str(path))
    writer.SetInputData(polydata)
    writer.Write()
    return path


def _write_two_triangle_vtp(vtk, path):
    """Write two disconnected triangles in blocks 7 and 8."""
    points = vtk.vtkPoints()
    for coordinate in [
        (0.0, 0.0, 0.0),
        (1.0, 0.0, 0.0),
        (0.0, 1.0, 0.0),
        (2.0, 0.0, 0.0),
        (3.0, 0.0, 0.0),
        (2.0, 1.0, 0.0),
    ]:
        points.InsertNextPoint(*coordinate)

    polygons = vtk.vtkCellArray()
    for offset in (0, 3):
        triangle = vtk.vtkTriangle()
        for index in range(3):
            triangle.GetPointIds().SetId(index, offset + index)
        polygons.InsertNextCell(triangle)

    polydata = vtk.vtkPolyData()
    polydata.SetPoints(points)
    polydata.SetPolys(polygons)

    temperature = vtk.vtkDoubleArray()
    temperature.SetName("temperature")
    for value in (10.0, 20.0, 30.0, 40.0, 50.0, 60.0):
        temperature.InsertNextValue(value)
    polydata.GetPointData().AddArray(temperature)

    pressure = vtk.vtkDoubleArray()
    pressure.SetName("pressure")
    for value in (1.5, 2.5):
        pressure.InsertNextValue(value)
    polydata.GetCellData().AddArray(pressure)

    blocks = vtk.vtkIntArray()
    blocks.SetName("block")
    for value in (7, 8):
        blocks.InsertNextValue(value)
    polydata.GetCellData().AddArray(blocks)

    writer = vtk.vtkXMLPolyDataWriter()
    writer.SetFileName(str(path))
    writer.SetInputData(polydata)
    writer.Write()
    return path


def test_export_csv_default_exports_point_arrays(tmp_path, capsys):
    """CSV defaults to point arrays with a tuple column and one row per tuple."""
    vtk = pytest.importorskip("vtk")
    source = _write_triangle_vtp(vtk, tmp_path / "triangle.vtp")
    output = tmp_path / "triangle.csv"

    args = _parse(
        export_cmds.cmd_export,
        ["--file", str(source), "--output", str(output), "--format", "csv"],
    )
    rc = export_cmds.cmd_export(args)
    payload = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert payload == {
        "path": str(output),
        "format": "csv",
        "rows": 3,
        "arrays": ["temperature", "vector"],
    }
    rows = _read_csv(output)
    assert rows[0] == ["tuple", "temperature", "vector[0]", "vector[1]"]
    assert [float(value) for value in rows[1]] == [0.0, 10.0, 1.0, 2.0]
    assert [float(value) for value in rows[3]] == [2.0, 30.0, 5.0, 6.0]


def test_export_csv_default_falls_back_to_cell_arrays(tmp_path, capsys):
    """A dataset with only cell arrays exports those instead of failing."""
    vtk = pytest.importorskip("vtk")
    source = _write_cell_only_vtp(vtk, tmp_path / "triangle-cell-only.vtp")
    output = tmp_path / "triangle-cell-only.csv"

    args = _parse(
        export_cmds.cmd_export,
        ["--file", str(source), "--output", str(output), "--format", "csv"],
    )
    rc = export_cmds.cmd_export(args)
    payload = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert payload["rows"] == 1
    assert payload["arrays"] == ["pressure"]
    rows = _read_csv(output)
    assert rows[0] == ["tuple", "pressure"]
    assert float(rows[1][1]) == pytest.approx(5.0)


def test_export_csv_selected_point_array_includes_coordinates(tmp_path, capsys):
    """--array point:<name> writes just that array plus x/y/z coordinates."""
    vtk = pytest.importorskip("vtk")
    source = _write_triangle_vtp(vtk, tmp_path / "triangle-point.vtp")
    output = tmp_path / "triangle-point.csv"

    args = _parse(
        export_cmds.cmd_export,
        [
            "--file",
            str(source),
            "--output",
            str(output),
            "--format",
            "csv",
            "--array",
            "point:temperature",
        ],
    )
    rc = export_cmds.cmd_export(args)
    payload = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert payload["rows"] == 3
    assert payload["arrays"] == ["temperature"]
    rows = _read_csv(output)
    assert rows[0] == ["tuple", "x", "y", "z", "temperature"]
    assert [float(value) for value in rows[1]] == [0.0, 0.0, 0.0, 0.0, 10.0]
    assert [float(value) for value in rows[3]] == [2.0, 0.0, 1.0, 0.0, 30.0]


def test_export_csv_selected_cell_array_includes_cell_centers(tmp_path, capsys):
    """--array cell:<name> writes the array plus cell-center coordinates."""
    vtk = pytest.importorskip("vtk")
    source = _write_triangle_vtp(vtk, tmp_path / "triangle-cell.vtp")
    output = tmp_path / "triangle-cell.csv"

    args = _parse(
        export_cmds.cmd_export,
        [
            "--file",
            str(source),
            "--output",
            str(output),
            "--format",
            "csv",
            "--array",
            "cell:pressure",
        ],
    )
    rc = export_cmds.cmd_export(args)
    payload = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert payload["rows"] == 1
    assert payload["arrays"] == ["pressure"]
    rows = _read_csv(output)
    assert rows[0] == ["tuple", "x", "y", "z", "pressure"]
    values = [float(value) for value in rows[1]]
    assert values[0] == 0.0
    assert values[1] == pytest.approx(1.0 / 3.0)
    assert values[2] == pytest.approx(1.0 / 3.0)
    assert values[3] == 0.0
    assert values[4] == pytest.approx(5.0)


def test_export_csv_block_filter_cells(tmp_path, capsys):
    """--block keeps only matching cell tuples and errors for unknown ids."""
    vtk = pytest.importorskip("vtk")
    source = _write_two_triangle_vtp(vtk, tmp_path / "two-blocks.vtp")

    output = tmp_path / "block-8.csv"
    args = _parse(
        export_cmds.cmd_export,
        [
            "--file",
            str(source),
            "--output",
            str(output),
            "--format",
            "csv",
            "--array",
            "cell:pressure",
            "--block",
            "8",
        ],
    )
    rc = export_cmds.cmd_export(args)
    payload = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert payload["rows"] == 1
    rows = _read_csv(output)
    assert rows[1][0] == "1"
    assert float(rows[1][-1]) == pytest.approx(2.5)

    args = _parse(
        export_cmds.cmd_export,
        [
            "--file",
            str(source),
            "--output",
            str(tmp_path / "missing-block.csv"),
            "--array",
            "cell:pressure",
            "--block",
            "99",
        ],
    )
    assert export_cmds.cmd_export(args) == 1
    assert "block id 99 not found" in _stderr_error(capsys)


def test_export_csv_block_filter_points(tmp_path, capsys):
    """Point rows are the points referenced by the selected block's cells."""
    vtk = pytest.importorskip("vtk")
    source = _write_two_triangle_vtp(vtk, tmp_path / "two-blocks-points.vtp")
    output = tmp_path / "block-8-points.csv"

    args = _parse(
        export_cmds.cmd_export,
        [
            "--file",
            str(source),
            "--output",
            str(output),
            "--format",
            "csv",
            "--array",
            "point:temperature",
            "--block",
            "8",
        ],
    )
    rc = export_cmds.cmd_export(args)
    payload = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert payload["rows"] == 3
    rows = _read_csv(output)
    assert [row[0] for row in rows[1:]] == ["3", "4", "5"]
    assert [float(row[-1]) for row in rows[1:]] == [40.0, 50.0, 60.0]


def test_export_csv_block_without_block_array(tmp_path, capsys):
    """--block without a numeric block array fails with the looked-for names."""
    vtk = pytest.importorskip("vtk")
    source = _write_cell_only_vtp(vtk, tmp_path / "triangle-no-block.vtp")

    args = _parse(
        export_cmds.cmd_export,
        [
            "--file",
            str(source),
            "--output",
            str(tmp_path / "no-block.csv"),
            "--array",
            "cell:pressure",
            "--block",
            "1",
        ],
    )

    assert export_cmds.cmd_export(args) == 1
    message = _stderr_error(capsys)
    assert "no numeric block array" in message
    assert "block_id" in message


def test_export_csv_missing_array(tmp_path, capsys):
    """A missing selected array reports the available arrays without a traceback."""
    vtk = pytest.importorskip("vtk")
    source = _write_triangle_vtp(vtk, tmp_path / "triangle-missing.vtp")

    args = _parse(
        export_cmds.cmd_export,
        [
            "--file",
            str(source),
            "--output",
            str(tmp_path / "missing.csv"),
            "--array",
            "cell:not_there",
        ],
    )

    assert export_cmds.cmd_export(args) == 1
    message = _stderr_error(capsys)
    assert "cell array 'not_there' not found" in message
    assert "pressure" in message


def test_export_vtk_missing_array(tmp_path, capsys):
    """A missing selected array fails the VTK export with a clear message."""
    vtk = pytest.importorskip("vtk")
    source = _write_triangle_vtp(vtk, tmp_path / "triangle-vtk-missing.vtp")

    args = _parse(
        export_cmds.cmd_export,
        [
            "--file",
            str(source),
            "--output",
            str(tmp_path / "missing.vtp"),
            "--format",
            "vtk",
            "--array",
            "point:not_there",
        ],
    )

    assert export_cmds.cmd_export(args) == 1
    message = _stderr_error(capsys)
    assert "point array 'not_there' not found" in message
    assert "temperature" in message


def test_export_vtk_roundtrip(tmp_path, capsys):
    """VTK export writes the same polydata with its arrays intact."""
    vtk = pytest.importorskip("vtk")
    source = _write_triangle_vtp(vtk, tmp_path / "triangle-vtk.vtp")
    output = tmp_path / "triangle-export.vtp"

    args = _parse(
        export_cmds.cmd_export,
        ["--file", str(source), "--output", str(output), "--format", "vtk"],
    )
    rc = export_cmds.cmd_export(args)
    payload = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert payload == {"path": str(output), "format": "vtk"}

    reader = vtk.vtkXMLPolyDataReader()
    reader.SetFileName(str(output))
    reader.Update()
    dataset = reader.GetOutput()
    assert int(dataset.GetNumberOfPoints()) == 3
    assert dataset.GetPointData().GetArray("temperature") is not None
    assert dataset.GetCellData().GetArray("pressure") is not None
    assert dataset.GetCellData().GetArray("block") is not None


def test_export_vtk_array_filter_and_legacy_suffix(tmp_path, capsys):
    """--array keeps only the picked array; .vtk writes a legacy dataset."""
    vtk = pytest.importorskip("vtk")
    source = _write_triangle_vtp(vtk, tmp_path / "triangle-filter.vtp")
    output = tmp_path / "triangle-filter.vtk"

    args = _parse(
        export_cmds.cmd_export,
        [
            "--file",
            str(source),
            "--output",
            str(output),
            "--format",
            "vtk",
            "--array",
            "cell:pressure",
        ],
    )
    rc = export_cmds.cmd_export(args)
    payload = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert payload["arrays"] == ["pressure"]

    reader = vtk.vtkGenericDataObjectReader()
    reader.SetFileName(str(output))
    reader.Update()
    dataset = reader.GetOutput()
    assert int(dataset.GetNumberOfPoints()) == 3
    assert dataset.GetPointData().GetNumberOfArrays() == 0
    cell_arrays = [
        dataset.GetCellData().GetArrayName(index)
        for index in range(dataset.GetCellData().GetNumberOfArrays())
    ]
    assert cell_arrays == ["pressure"]


def test_export_vtk_block_filter(tmp_path, capsys):
    """--block extracts selected cells into an unstructured grid."""
    vtk = pytest.importorskip("vtk")
    source = _write_two_triangle_vtp(vtk, tmp_path / "two-blocks-vtk.vtp")
    output = tmp_path / "block-8.vtu"

    args = _parse(
        export_cmds.cmd_export,
        [
            "--file",
            str(source),
            "--output",
            str(output),
            "--format",
            "vtk",
            "--block",
            "8",
        ],
    )
    rc = export_cmds.cmd_export(args)
    payload = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert payload == {"path": str(output), "format": "vtk"}

    reader = vtk.vtkXMLUnstructuredGridReader()
    reader.SetFileName(str(output))
    reader.Update()
    dataset = reader.GetOutput()
    assert int(dataset.GetNumberOfCells()) == 1
    pressure = dataset.GetCellData().GetArray("pressure")
    assert pressure is not None
    assert pressure.GetTuple1(0) == pytest.approx(2.5)


def test_export_vtk_rejects_mismatched_xml_suffix(tmp_path, capsys):
    """A polydata cannot be written with the unstructured-grid XML writer."""
    vtk = pytest.importorskip("vtk")
    source = _write_triangle_vtp(vtk, tmp_path / "triangle-mismatch.vtp")

    args = _parse(
        export_cmds.cmd_export,
        [
            "--file",
            str(source),
            "--output",
            str(tmp_path / "triangle-mismatch.vtu"),
            "--format",
            "vtk",
        ],
    )

    assert export_cmds.cmd_export(args) == 1
    message = _stderr_error(capsys)
    assert "requires a vtkUnstructuredGrid" in message
    assert ".vtk for a legacy export" in message


def test_export_gltf_reports_missing_writer(tmp_path, monkeypatch, capsys):
    """Without a polydata-capable glTF writer the command returns a JSON error."""
    vtk = pytest.importorskip("vtk")
    source = _write_triangle_vtp(vtk, tmp_path / "triangle-gltf-missing.vtp")
    monkeypatch.delattr(vtk, "vtkGLTFWriter", raising=False)
    monkeypatch.delattr(vtk, "vtkGLTFExporter", raising=False)

    args = _parse(
        export_cmds.cmd_export,
        [
            "--file",
            str(source),
            "--output",
            str(tmp_path / "triangle.gltf"),
            "--format",
            "gltf",
        ],
    )

    assert export_cmds.cmd_export(args) == 1
    assert "glTF export is not available" in _stderr_error(capsys)


@pytest.mark.parametrize("suffix", [".gltf", ".glb"])
def test_export_gltf_writes_surface(tmp_path, capsys, suffix):
    """When a headless glTF writer exists, the surface is written self-contained."""
    vtk = pytest.importorskip("vtk")
    has_writer = hasattr(vtk, "vtkGLTFWriter")
    exporter = getattr(vtk, "vtkGLTFExporter", None)
    if not has_writer and not (exporter is not None and hasattr(exporter(), "SetInputData")):
        pytest.skip("this VTK build has no polydata-capable glTF writer")
    source = _write_triangle_vtp(vtk, tmp_path / f"triangle-gltf{suffix}.vtp")
    output = tmp_path / f"triangle{suffix}"

    args = _parse(
        export_cmds.cmd_export,
        ["--file", str(source), "--output", str(output), "--format", "gltf"],
    )
    rc = export_cmds.cmd_export(args)
    payload = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert payload == {"path": str(output), "format": "gltf"}
    assert output.is_file()
    assert output.stat().st_size > 0
    assert list(tmp_path.glob("*.bin")) == []


def test_export_gltf_surface_from_volume(tmp_path, capsys):
    """A volumetric dataset exports its boundary surface as glTF."""
    vtk = pytest.importorskip("vtk")
    has_writer = hasattr(vtk, "vtkGLTFWriter")
    exporter = getattr(vtk, "vtkGLTFExporter", None)
    if not has_writer and not (exporter is not None and hasattr(exporter(), "SetInputData")):
        pytest.skip("this VTK build has no polydata-capable glTF writer")

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
    source = tmp_path / "tetra.vtu"
    writer = vtk.vtkXMLUnstructuredGridWriter()
    writer.SetFileName(str(source))
    writer.SetInputData(grid)
    writer.Write()

    output = tmp_path / "tetra.gltf"
    args = _parse(
        export_cmds.cmd_export,
        ["--file", str(source), "--output", str(output), "--format", "gltf"],
    )
    rc = export_cmds.cmd_export(args)
    payload = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert payload == {"path": str(output), "format": "gltf"}
    assert output.is_file()
    assert output.stat().st_size > 0
