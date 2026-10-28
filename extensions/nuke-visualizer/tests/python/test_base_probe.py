# Copyright (C) 2026 NukeHub and others.
# SPDX-License-Identifier: BSD-2-Clause
"""Tests for the pure probe helpers and the headless ``base.probe`` command.

``plugins.base.lib.probe`` is numpy-only at import time (no vtk), so the
coordinate parsing, sample-count clamping, polyline sampling and result
assembly run in the minimal pytest + numpy profile. The command keeps vtk
lazy: every error path (missing file/array, both/neither mode, bad point
text, bad sample count, missing vtk) runs everywhere, while the sampling
tests skip cleanly when vtk is absent.
"""

import argparse
import json
import sys

import pytest

np = pytest.importorskip("numpy")

from nuke_viz.plugin import setup_parser_for_handler  # noqa: E402
from plugins.base.commands import probe as probe_cmds  # noqa: E402
from plugins.base.lib import probe as probe_lib  # noqa: E402
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
# Coordinate parsing and sample counts (no vtk required)
# ---------------------------------------------------------------------------


def test_parse_points_basic():
    """Point text splits on semicolons, tolerates blanks and converts to floats."""
    assert probe_lib.parse_points("0,0,0; 1, 2.5, -3 ") == [
        (0.0, 0.0, 0.0),
        (1.0, 2.5, -3.0),
    ]
    assert probe_lib.parse_points("1,2,3;") == [(1.0, 2.0, 3.0)]


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("", "coordinates"),
        ("   ", "coordinates"),
        ("1,2", "x,y,z"),
        ("1,2,3;4,5", "x,y,z"),
        ("a,b,c", "numeric"),
        ("1,2,nan", "finite"),
    ],
)
def test_parse_points_rejects_bad_syntax(text, message):
    """Malformed point text raises a readable AnalysisError."""
    with pytest.raises(AnalysisError, match=message):
        probe_lib.parse_points(text)


def test_parse_path_requires_two_points():
    """A path polyline needs at least two points."""
    assert probe_lib.parse_path("0,0,0;1,0,0") == [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0)]

    with pytest.raises(AnalysisError, match="at least 2"):
        probe_lib.parse_path("0,0,0")
    with pytest.raises(AnalysisError, match="coordinates"):
        probe_lib.parse_path("")


def test_sample_count_default_and_clamp():
    """Missing samples default to 100; numeric values clamp to 2..10000."""
    assert probe_lib.sample_count() == 100
    assert probe_lib.sample_count(None) == 100
    assert probe_lib.sample_count(50) == 50
    assert probe_lib.sample_count("64") == 64
    assert probe_lib.sample_count(1) == 2
    assert probe_lib.sample_count(-7) == 2
    assert probe_lib.sample_count(20000) == 10000


@pytest.mark.parametrize("value", ["abc", "", 2.5, float("nan"), float("inf")])
def test_sample_count_rejects_non_integers(value):
    """Fractional or non-numeric sample counts are errors, not clamped."""
    with pytest.raises(AnalysisError, match="integer"):
        probe_lib.sample_count(value)


def test_path_samples_straight_line():
    """Samples are evenly spaced by arc length on a single segment."""
    samples, length = probe_lib.path_samples([(0.0, 0.0, 0.0), (0.0, 0.0, 10.0)], 5)

    assert length == pytest.approx(10.0)
    assert [sample["distance"] for sample in samples] == pytest.approx([0.0, 2.5, 5.0, 7.5, 10.0])
    assert samples[2]["position"] == pytest.approx([0.0, 0.0, 5.0])


def test_path_samples_uses_cumulative_distance():
    """Distances accumulate over the whole polyline, not per segment."""
    samples, length = probe_lib.path_samples([(0.0, 0.0, 0.0), (3.0, 0.0, 0.0), (3.0, 4.0, 0.0)], 3)

    assert length == pytest.approx(7.0)
    assert [sample["distance"] for sample in samples] == pytest.approx([0.0, 3.5, 7.0])
    assert samples[1]["position"] == pytest.approx([3.0, 0.5, 0.0])
    assert samples[2]["position"] == pytest.approx([3.0, 4.0, 0.0])


def test_path_samples_default_count_and_degenerate_path():
    """No count means 100 samples; a zero-length path repeats its first point."""
    samples, length = probe_lib.path_samples([(0.0, 0.0, 0.0), (1.0, 0.0, 0.0)])
    assert length == pytest.approx(1.0)
    assert len(samples) == 100

    samples, length = probe_lib.path_samples([(1.0, 2.0, 3.0), (1.0, 2.0, 3.0)], 4)
    assert length == 0.0
    assert [sample["distance"] for sample in samples] == [0.0, 0.0, 0.0, 0.0]
    assert all(sample["position"] == [1.0, 2.0, 3.0] for sample in samples)


def test_path_samples_rejects_bad_input():
    """A path needs two finite 3-D points."""
    with pytest.raises(AnalysisError, match="at least two"):
        probe_lib.path_samples([(0.0, 0.0, 0.0)], 3)
    with pytest.raises(AnalysisError, match="3-D"):
        probe_lib.path_samples([(0.0, 0.0), (1.0, 1.0)], 3)
    with pytest.raises(AnalysisError, match="finite"):
        probe_lib.path_samples([(0.0, 0.0, 0.0), (float("nan"), 0.0, 0.0)], 3)


def test_build_probe_result_point_mode():
    """Point results carry position/value/valid plus the source data range."""
    sampled = {"values": [1.5, None], "valid": [True, False], "dataRange": [0.0, 2.0]}

    result = probe_lib.build_probe_result(
        "/tmp/a.vti", "cell", "flux", [(0.5, 0.5, 0.5), (9.0, 9.0, 9.0)], sampled
    )

    assert result == {
        "file": "/tmp/a.vti",
        "array": "flux",
        "association": "cell",
        "points": [
            {"position": [0.5, 0.5, 0.5], "value": 1.5, "valid": True},
            {"position": [9.0, 9.0, 9.0], "value": None, "valid": False},
        ],
        "dataRange": [0.0, 2.0],
    }
    assert "series" not in result
    assert "length" not in result


def test_build_probe_result_path_mode():
    """Path results repeat the samples as distance rows and add the length."""
    series, length = probe_lib.path_samples([(0.0, 0.0, 0.0), (1.0, 0.0, 0.0)], 3)
    positions = [sample["position"] for sample in series]
    sampled = {"values": [2.0, 3.0, 4.0], "valid": [True, True, True], "dataRange": None}

    result = probe_lib.build_probe_result(
        "/tmp/a.vti", "point", "f", positions, sampled, series=series, length=length
    )

    assert result["length"] == pytest.approx(1.0)
    assert [row["distance"] for row in result["series"]] == pytest.approx([0.0, 0.5, 1.0])
    assert [row["value"] for row in result["series"]] == [2.0, 3.0, 4.0]
    assert result["series"][1]["position"] == pytest.approx([0.5, 0.0, 0.0])
    assert "dataRange" not in result


def test_build_probe_result_rejects_mismatched_samples():
    """Sample/value arrays must line up with the probe positions."""
    with pytest.raises(AnalysisError, match="do not match"):
        probe_lib.build_probe_result(
            "/tmp/a.vti", "point", "f", [(0.0, 0.0, 0.0)], {"values": [1.0], "valid": []}
        )
    with pytest.raises(AnalysisError, match="missing"):
        probe_lib.build_probe_result(
            "/tmp/a.vti",
            "point",
            "f",
            [(0.0, 0.0, 0.0)],
            {"values": [1.0], "valid": [True], "dataRange": None},
            series=[{"distance": 0.0, "position": [0.0, 0.0, 0.0]}],
        )


# ---------------------------------------------------------------------------
# Command argument parsing and error paths (no vtk required)
# ---------------------------------------------------------------------------


def test_probe_argument_defaults():
    """--samples and --component are optional; point text stays a string."""
    args = _parse(
        probe_cmds.cmd_probe,
        ["--file", "mesh.vti", "--array", "point:f", "--points", "0,0,0"],
    )
    assert args.points == "0,0,0"
    assert args.path is None
    assert args.samples is None
    assert args.component is None

    args = _parse(
        probe_cmds.cmd_probe,
        [
            "--file",
            "mesh.vti",
            "--array",
            "cell:c",
            "--path",
            "0,0,0;1,0,0",
            "--samples",
            "50",
            "--component",
            "2",
        ],
    )
    assert args.samples == "50"
    assert args.component == 2


def test_probe_requires_file_and_array():
    """--file and --array are required; argparse aborts with SystemExit."""
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(probe_cmds.cmd_probe, parser)
    with pytest.raises(SystemExit) as excinfo:
        parser.parse_args(["--array", "point:f", "--points", "0,0,0"])
    assert excinfo.value.code == 2


def test_probe_missing_file(capsys):
    """A nonexistent VTK file fails with a JSON error on stderr and exit 1."""
    args = _parse(
        probe_cmds.cmd_probe,
        ["--file", "/no/such/mesh.vtk", "--array", "cell:flux", "--points", "0,0,0"],
    )

    rc = probe_cmds.cmd_probe(args)

    assert rc == 1
    assert "File not found" in _stderr_error(capsys)


@pytest.mark.parametrize(
    ("argv", "message"),
    [
        (
            ["--points", "0,0,0", "--path", "0,0,0;1,0,0"],
            "mutually exclusive",
        ),
        ([], "one of --points or --path"),
    ],
)
def test_probe_requires_exactly_one_mode(argv, capsys, message):
    """Both or neither of --points/--path is rejected before any file access."""
    args = _parse(
        probe_cmds.cmd_probe,
        ["--file", "/no/such/mesh.vtk", "--array", "cell:flux", *argv],
    )

    rc = probe_cmds.cmd_probe(args)

    assert rc == 1
    assert message in _stderr_error(capsys)


@pytest.mark.parametrize(
    ("points", "message"),
    [
        ("0,0", "x,y,z"),
        ("a,b,c", "numeric"),
        ("0,0,inf", "finite"),
        ("", "coordinates"),
    ],
)
def test_probe_rejects_bad_point_text(points, capsys, message):
    """Bad point syntax fails before the file is read."""
    args = _parse(
        probe_cmds.cmd_probe,
        ["--file", "/no/such/mesh.vtk", "--array", "point:f", "--points", points],
    )

    rc = probe_cmds.cmd_probe(args)

    assert rc == 1
    assert message in _stderr_error(capsys)


def test_probe_rejects_bad_path_and_samples(capsys):
    """A short path or a non-integer sample count fails before file access."""
    args = _parse(
        probe_cmds.cmd_probe,
        ["--file", "/no/such/mesh.vtk", "--array", "point:f", "--path", "1,2,3"],
    )
    assert probe_cmds.cmd_probe(args) == 1
    assert "at least 2" in _stderr_error(capsys)

    args = _parse(
        probe_cmds.cmd_probe,
        [
            "--file",
            "/no/such/mesh.vtk",
            "--array",
            "point:f",
            "--path",
            "0,0,0;1,0,0",
            "--samples",
            "many",
        ],
    )
    assert probe_cmds.cmd_probe(args) == 1
    assert "integer" in _stderr_error(capsys)


def test_probe_reports_missing_vtk(tmp_path, monkeypatch, capsys):
    """A missing vtk dependency surfaces as a JSON error, never a traceback."""
    fake = tmp_path / "mesh.vtk"
    fake.write_text("fake")
    monkeypatch.setitem(sys.modules, "vtk", None)

    args = _parse(
        probe_cmds.cmd_probe,
        ["--file", str(fake), "--array", "point:f", "--points", "0,0,0"],
    )
    rc = probe_cmds.cmd_probe(args)

    assert rc == 1
    assert "vtk" in _stderr_error(capsys)


def test_sample_array_values_reports_missing_vtk(monkeypatch):
    """The lib itself raises a clean AnalysisError when vtk cannot be imported."""
    monkeypatch.setitem(sys.modules, "vtk", None)

    with pytest.raises(AnalysisError, match="vtk"):
        probe_lib.sample_array_values(None, None, "point", "f", [(0.0, 0.0, 0.0)])


# ---------------------------------------------------------------------------
# Sampling over real VTK datasets (skip without vtk)
# ---------------------------------------------------------------------------


def _vtk_modules():
    """Import vtk + numpy_support, skipping the test when vtk is absent."""
    vtk = pytest.importorskip("vtk")
    from vtk.util import numpy_support

    return vtk, numpy_support


def _image_dataset(vtk, numpy_support):
    """Build a 3x3x3 image with point field ``f = x + 2y + 3z`` and cell ids."""
    image = vtk.vtkImageData()
    image.SetDimensions(3, 3, 3)
    image.SetOrigin(0.0, 0.0, 0.0)
    image.SetSpacing(1.0, 1.0, 1.0)

    point_values = np.array(
        [i + 2.0 * j + 3.0 * k for k in range(3) for j in range(3) for i in range(3)]
    )
    point_array = numpy_support.numpy_to_vtk(point_values, deep=True)
    point_array.SetName("f")
    image.GetPointData().AddArray(point_array)

    cell_values = np.arange(8, dtype=float)
    cell_array = numpy_support.numpy_to_vtk(cell_values, deep=True)
    cell_array.SetName("c")
    image.GetCellData().AddArray(cell_array)
    return image


def _add_vector_array(numpy_support, image):
    """Attach the vector point array ``v = (x, 2y, 3z)`` to an image."""
    vectors = np.array(
        [[float(i), 2.0 * j, 3.0 * k] for k in range(3) for j in range(3) for i in range(3)]
    )
    array = numpy_support.numpy_to_vtk(vectors, deep=True)
    array.SetName("v")
    image.GetPointData().AddArray(array)
    return image


def _vector_image(vtk, numpy_support):
    """Build a 3x3x3 image with the vector point array ``v = (x, 2y, 3z)``."""
    image = vtk.vtkImageData()
    image.SetDimensions(3, 3, 3)
    image.SetOrigin(0.0, 0.0, 0.0)
    image.SetSpacing(1.0, 1.0, 1.0)
    return _add_vector_array(numpy_support, image)


def _write_image(vtk, image, path):
    """Write an image dataset as XML ``.vti`` and return the path."""
    writer = vtk.vtkXMLImageDataWriter()
    writer.SetFileName(str(path))
    writer.SetInputData(image)
    writer.Write()
    return path


def test_probe_command_point_mode(tmp_path, capsys):
    """Point probes interpolate a point array and report its finite range."""
    vtk, numpy_support = _vtk_modules()
    image = _image_dataset(vtk, numpy_support)
    path = _write_image(vtk, image, tmp_path / "image.vti")

    args = _parse(
        probe_cmds.cmd_probe,
        [
            "--file",
            str(path),
            "--array",
            "point:f",
            "--points",
            "0.5,0.5,0.5;1.5,1.0,2.0",
        ],
    )
    rc = probe_cmds.cmd_probe(args)
    payload = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert payload["file"] == str(path)
    assert payload["array"] == "f"
    assert payload["association"] == "point"
    assert [point["position"] for point in payload["points"]] == [
        [0.5, 0.5, 0.5],
        [1.5, 1.0, 2.0],
    ]
    assert payload["points"][0]["value"] == pytest.approx(3.0)
    assert payload["points"][1]["value"] == pytest.approx(9.5)
    assert all(point["valid"] for point in payload["points"])
    assert payload["dataRange"] == pytest.approx([0.0, 12.0])
    assert "series" not in payload
    assert "length" not in payload


def test_probe_command_cell_mode(tmp_path, capsys):
    """Cell probes copy the containing cell value; misses are null/invalid."""
    vtk, numpy_support = _vtk_modules()
    image = _image_dataset(vtk, numpy_support)
    path = _write_image(vtk, image, tmp_path / "image.vti")

    args = _parse(
        probe_cmds.cmd_probe,
        [
            "--file",
            str(path),
            "--array",
            "cell:c",
            "--points",
            "1.5,0.5,0.5;0.5,1.5,0.5;3.5,0.5,0.5",
        ],
    )
    rc = probe_cmds.cmd_probe(args)
    payload = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert payload["association"] == "cell"
    assert [point["value"] for point in payload["points"]] == [
        pytest.approx(1.0),
        pytest.approx(2.0),
        None,
    ]
    assert [point["valid"] for point in payload["points"]] == [True, True, False]
    assert payload["dataRange"] == pytest.approx([0.0, 7.0])


def test_probe_command_path_mode(tmp_path, capsys):
    """Path mode samples by cumulative distance and adds series/length."""
    vtk, numpy_support = _vtk_modules()
    image = _image_dataset(vtk, numpy_support)
    path = _write_image(vtk, image, tmp_path / "image.vti")

    args = _parse(
        probe_cmds.cmd_probe,
        [
            "--file",
            str(path),
            "--array",
            "point:f",
            "--path",
            "0.5,0.5,0.5;1.5,0.5,0.5",
            "--samples",
            "3",
        ],
    )
    rc = probe_cmds.cmd_probe(args)
    payload = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert payload["length"] == pytest.approx(1.0)
    assert [row["distance"] for row in payload["series"]] == pytest.approx([0.0, 0.5, 1.0])
    positions = [row["position"] for row in payload["series"]]
    assert positions[0] == pytest.approx([0.5, 0.5, 0.5])
    assert positions[1] == pytest.approx([1.0, 0.5, 0.5])
    assert positions[2] == pytest.approx([1.5, 0.5, 0.5])
    assert [row["value"] for row in payload["series"]] == pytest.approx([3.0, 3.5, 4.0])
    assert all(row["valid"] for row in payload["series"])
    assert [point["position"] for point in payload["points"]] == [
        row["position"] for row in payload["series"]
    ]


def test_probe_command_path_default_samples(tmp_path, capsys):
    """Path mode defaults to 100 samples spanning the whole polyline."""
    vtk, numpy_support = _vtk_modules()
    image = _image_dataset(vtk, numpy_support)
    path = _write_image(vtk, image, tmp_path / "image.vti")

    args = _parse(
        probe_cmds.cmd_probe,
        [
            "--file",
            str(path),
            "--array",
            "point:f",
            "--path",
            "0.5,0.5,0.5;1.5,0.5,0.5",
        ],
    )
    rc = probe_cmds.cmd_probe(args)
    payload = json.loads(capsys.readouterr().out)

    assert rc == 0
    assert len(payload["series"]) == 100
    assert payload["series"][0]["distance"] == pytest.approx(0.0)
    assert payload["series"][-1]["distance"] == pytest.approx(1.0)


def test_probe_command_vector_magnitude_and_component(tmp_path, capsys):
    """Multi-component arrays use L2 magnitude unless a component is selected."""
    vtk, numpy_support = _vtk_modules()
    image = _vector_image(vtk, numpy_support)
    path = _write_image(vtk, image, tmp_path / "vector.vti")

    base = ["--file", str(path), "--array", "point:v", "--points", "1.0,0.5,0.5"]

    rc = probe_cmds.cmd_probe(_parse(probe_cmds.cmd_probe, base))
    magnitude = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert magnitude["points"][0]["value"] == pytest.approx(np.sqrt(4.25))
    assert magnitude["dataRange"] == pytest.approx([0.0, np.sqrt(56.0)])

    rc = probe_cmds.cmd_probe(_parse(probe_cmds.cmd_probe, [*base, "--component", "2"]))
    component = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert component["points"][0]["value"] == pytest.approx(1.5)
    assert component["dataRange"] == pytest.approx([0.0, 6.0])

    rc = probe_cmds.cmd_probe(_parse(probe_cmds.cmd_probe, [*base, "--component", "0"]))
    first = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert first["points"][0]["value"] == pytest.approx(1.0)
    assert first["dataRange"] == pytest.approx([0.0, 2.0])


def test_probe_command_component_validation(tmp_path, capsys):
    """Single-component arrays accept 0 only; components are bounds-checked."""
    vtk, numpy_support = _vtk_modules()
    image = _add_vector_array(numpy_support, _image_dataset(vtk, numpy_support))
    path = _write_image(vtk, image, tmp_path / "image.vti")

    scalar = ["--file", str(path), "--array", "point:f", "--points", "0.5,0.5,0.5"]
    rc = probe_cmds.cmd_probe(_parse(probe_cmds.cmd_probe, [*scalar, "--component", "0"]))
    payload = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert payload["points"][0]["value"] == pytest.approx(3.0)

    rc = probe_cmds.cmd_probe(_parse(probe_cmds.cmd_probe, [*scalar, "--component", "1"]))
    assert rc == 1
    assert "single-component" in _stderr_error(capsys)

    vector = ["--file", str(path), "--array", "point:v", "--points", "0.5,0.5,0.5"]
    rc = probe_cmds.cmd_probe(_parse(probe_cmds.cmd_probe, [*vector, "--component", "3"]))
    assert rc == 1
    assert "out of range" in _stderr_error(capsys)


def test_probe_command_missing_array(tmp_path, capsys):
    """A missing array reports the available arrays and exits 1."""
    vtk, numpy_support = _vtk_modules()
    image = _image_dataset(vtk, numpy_support)
    path = _write_image(vtk, image, tmp_path / "image.vti")

    args = _parse(
        probe_cmds.cmd_probe,
        ["--file", str(path), "--array", "cell:nope", "--points", "0.5,0.5,0.5"],
    )
    rc = probe_cmds.cmd_probe(args)

    assert rc == 1
    error = _stderr_error(capsys)
    assert "not found" in error
    assert "c" in error


def test_probe_command_duplicate_array_name_across_associations(tmp_path, capsys):
    """A cell array wins over a same-named point array in cell mode."""
    vtk, numpy_support = _vtk_modules()
    image = _image_dataset(vtk, numpy_support)
    duplicate = numpy_support.numpy_to_vtk(np.zeros(27, dtype=float), deep=True)
    duplicate.SetName("c")
    image.GetPointData().AddArray(duplicate)
    path = _write_image(vtk, image, tmp_path / "duplicate.vti")

    cell_args = _parse(
        probe_cmds.cmd_probe,
        ["--file", str(path), "--array", "cell:c", "--points", "1.5,0.5,0.5"],
    )
    rc = probe_cmds.cmd_probe(cell_args)
    payload = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert payload["points"][0]["value"] == pytest.approx(1.0)

    point_args = _parse(
        probe_cmds.cmd_probe,
        ["--file", str(path), "--array", "point:c", "--points", "1.5,0.5,0.5"],
    )
    rc = probe_cmds.cmd_probe(point_args)
    payload = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert payload["points"][0]["value"] == pytest.approx(0.0)


def test_sample_array_values_marks_misses_and_non_finite_values():
    """Out-of-bounds points and non-finite tuples are invalid, range stays finite."""
    vtk, numpy_support = _vtk_modules()
    image = _image_dataset(vtk, numpy_support)

    nan_values = np.arange(27, dtype=float)
    nan_values[26] = np.nan
    nan_array = numpy_support.numpy_to_vtk(nan_values, deep=True)
    nan_array.SetName("n")
    image.GetPointData().AddArray(nan_array)

    sampled = probe_lib.sample_array_values(
        image, numpy_support, "point", "n", [(0.5, 0.5, 0.5), (2.0, 2.0, 2.0), (9.0, 9.0, 9.0)]
    )

    assert sampled["values"][0] == pytest.approx(6.5)
    assert sampled["valid"] == [True, False, False]
    assert sampled["values"][1] is None
    assert sampled["values"][2] is None
    assert sampled["dataRange"] == pytest.approx([0.0, 25.0])


def test_sample_array_values_validates_input():
    """Unknown associations, empty positions and missing arrays are errors."""
    vtk, numpy_support = _vtk_modules()
    image = _image_dataset(vtk, numpy_support)

    with pytest.raises(AnalysisError, match="association"):
        probe_lib.sample_array_values(image, numpy_support, "vertex", "f", [(0.0, 0.0, 0.0)])
    with pytest.raises(AnalysisError, match="non-empty"):
        probe_lib.sample_array_values(image, numpy_support, "point", "f", [])
    with pytest.raises(AnalysisError, match="not found"):
        probe_lib.sample_array_values(image, numpy_support, "cell", "nope", [(0.5, 0.5, 0.5)])
