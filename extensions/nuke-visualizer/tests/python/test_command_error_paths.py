"""Tests for error paths and argument handling in base command modules.

The handlers in plugins.base.commands do their heavy imports lazily,
so a missing dependency (pymoab, gmsh, pydagmc, vtk) must surface as a
JSON error object on stderr with exit code 1 — never a traceback.

OpenMC-plugin handlers follow the same lazy pattern but emit the JSON
error object on stdout (the node side is stdout-first); the
openmc.tally-line-probe and openmc.tally-contour sections pin that contract.
"""

import argparse
import json
import sys
import tempfile

import pytest
from nuke_viz.plugin import setup_parser_for_handler
from plugins.base.commands import convert as convert_cmds
from plugins.base.commands import dagmc as dagmc_cmds
from plugins.openmc.commands import tally_vtk as tally_vtk_cmds


@pytest.fixture
def hermetic_tmp(monkeypatch, tmp_path):
    """Redirect tempfile.gettempdir so cache dirs stay inside tmp_path."""
    monkeypatch.setattr(tempfile, "gettempdir", lambda: str(tmp_path))
    return tmp_path


def _parse(handler, argv):
    """Build a real parser for the handler and parse argv with it."""
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(handler, parser)
    return parser.parse_args(argv)


def _stderr_error_line(capsys):
    """Extract and JSON-decode the single {"error": ...} stderr line."""
    err = capsys.readouterr().err.strip()
    assert err.startswith('{"error"'), f"expected JSON error on stderr, got: {err!r}"
    return json.loads(err)["error"]


# ---------------------------------------------------------------------------
# base.convert-dagmc
# ---------------------------------------------------------------------------


def test_convert_dagmc_missing_file(hermetic_tmp, capsys):
    """A nonexistent input file fails with a JSON error and exit code 1."""
    args = _parse(convert_cmds.cmd_convert_dagmc, ["--file", "/no/such/model.h5m"])

    rc = convert_cmds.cmd_convert_dagmc(args)

    assert rc == 1
    assert _stderr_error_line(capsys)


def test_convert_dagmc_missing_pymoab(hermetic_tmp, monkeypatch, capsys):
    """With pymoab unavailable, conversion reports the import failure."""
    fake_h5m = hermetic_tmp / "model.h5m"
    fake_h5m.write_bytes(b"fake")
    monkeypatch.setitem(sys.modules, "pymoab", None)

    args = _parse(convert_cmds.cmd_convert_dagmc, ["--file", str(fake_h5m)])
    rc = convert_cmds.cmd_convert_dagmc(args)

    assert rc == 1
    assert "pymoab" in _stderr_error_line(capsys)


def test_convert_dagmc_volume_missing_pydagmc(hermetic_tmp, monkeypatch, capsys):
    """The --volume path reports a missing pydagmc dependency."""
    fake_h5m = hermetic_tmp / "model.h5m"
    fake_h5m.write_bytes(b"fake")
    monkeypatch.setitem(sys.modules, "pydagmc", None)

    args = _parse(
        convert_cmds.cmd_convert_dagmc,
        ["--file", str(fake_h5m), "--volume", "3"],
    )
    rc = convert_cmds.cmd_convert_dagmc(args)

    assert rc == 1
    assert "pydagmc" in _stderr_error_line(capsys)


# ---------------------------------------------------------------------------
# base.convert-step
# ---------------------------------------------------------------------------


def test_convert_step_missing_file(hermetic_tmp, capsys):
    """A nonexistent STEP file fails with a JSON error and exit code 1."""
    args = _parse(convert_cmds.cmd_convert_step, ["--file", "/no/such/part.step"])

    rc = convert_cmds.cmd_convert_step(args)

    assert rc == 1
    assert _stderr_error_line(capsys)


def test_convert_step_missing_gmsh(hermetic_tmp, monkeypatch, capsys):
    """With gmsh unavailable, STEP conversion reports the import failure."""
    fake_step = hermetic_tmp / "part.step"
    fake_step.write_bytes(b"fake")
    monkeypatch.setitem(sys.modules, "gmsh", None)

    args = _parse(convert_cmds.cmd_convert_step, ["--file", str(fake_step)])
    rc = convert_cmds.cmd_convert_step(args)

    assert rc == 1
    assert "gmsh" in _stderr_error_line(capsys)


# ---------------------------------------------------------------------------
# dagmc.info
# ---------------------------------------------------------------------------


def test_dagmc_info_missing_file(capsys):
    """dagmc.info on a missing file reports 'DAGMC file not found'."""
    args = _parse(dagmc_cmds.cmd_dagmc_info, ["--file", "/no/such/model.h5m"])

    rc = dagmc_cmds.cmd_dagmc_info(args)

    assert rc == 1
    assert "DAGMC file not found" in _stderr_error_line(capsys)


def test_dagmc_info_missing_pydagmc(tmp_path, monkeypatch, capsys):
    """With pydagmc unavailable, dagmc.info reports the import failure."""
    fake_h5m = tmp_path / "model.h5m"
    fake_h5m.write_bytes(b"fake")
    monkeypatch.setitem(sys.modules, "pydagmc", None)

    args = _parse(dagmc_cmds.cmd_dagmc_info, ["--file", str(fake_h5m)])
    rc = dagmc_cmds.cmd_dagmc_info(args)

    assert rc == 1
    assert "pydagmc" in _stderr_error_line(capsys)


# ---------------------------------------------------------------------------
# Argument parsing behavior
# ---------------------------------------------------------------------------


def test_convert_dagmc_file_argument_required():
    """--file is required; argparse aborts with SystemExit when missing."""
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(convert_cmds.cmd_convert_dagmc, parser)

    with pytest.raises(SystemExit) as excinfo:
        parser.parse_args([])
    assert excinfo.value.code == 2


def test_convert_step_mesh_size_default_and_override():
    """--mesh-size defaults to 10.0 and parses as a float."""
    args = _parse(convert_cmds.cmd_convert_step, ["--file", "a.step"])
    assert args.mesh_size == pytest.approx(10.0)

    args = _parse(convert_cmds.cmd_convert_step, ["--file", "a.step", "--mesh-size", "2.5"])
    assert args.mesh_size == pytest.approx(2.5)


# ---------------------------------------------------------------------------
# openmc.tally-line-probe (stdout-JSON contract, exit 1)
# ---------------------------------------------------------------------------


def _probe_argv(*extra):
    """Base probe argv: tally 1 along the unit diagonal of a missing file."""
    return [
        "--tally-id",
        "1",
        "--p0",
        "0",
        "0",
        "0",
        "--p1",
        "1",
        "1",
        "1",
        *extra,
        "/no/such/statepoint.h5",
    ]


def _stdout_error_line(capsys):
    """Extract and JSON-decode the single {"error": ...} stdout line."""
    out = capsys.readouterr().out.strip()
    assert out.startswith('{"error"'), f"expected JSON error on stdout, got: {out!r}"
    return json.loads(out)["error"]


def test_line_probe_missing_file(capsys):
    """A nonexistent statepoint fails with a stdout JSON error and exit 1."""
    args = _parse(tally_vtk_cmds.cmd_tally_line_probe, _probe_argv())

    rc = tally_vtk_cmds.cmd_tally_line_probe(args)

    assert rc == 1
    assert "File not found" in _stdout_error_line(capsys)


def test_line_probe_exclusive_interpolation_flags(capsys):
    """--smooth + --pixelated together fail before any file access."""
    args = _parse(tally_vtk_cmds.cmd_tally_line_probe, _probe_argv("--smooth", "--pixelated"))

    rc = tally_vtk_cmds.cmd_tally_line_probe(args)

    assert rc == 1
    assert "mutually exclusive" in _stdout_error_line(capsys)


def test_line_probe_bad_npoints(capsys):
    """An out-of-range --npoints fails with a stdout JSON error."""
    args = _parse(tally_vtk_cmds.cmd_tally_line_probe, _probe_argv("--npoints", "1"))

    rc = tally_vtk_cmds.cmd_tally_line_probe(args)

    assert rc == 1
    assert "npoints" in _stdout_error_line(capsys)


def test_line_probe_endpoints_required():
    """--p0/--p1 are required; argparse aborts with SystemExit when missing."""
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(tally_vtk_cmds.cmd_tally_line_probe, parser)

    with pytest.raises(SystemExit) as excinfo:
        parser.parse_args(["--tally-id", "1", "sp.h5"])
    assert excinfo.value.code == 2


def test_line_probe_npoints_default_and_parsing():
    """--npoints defaults to 100 and parses as an int."""
    args = _parse(tally_vtk_cmds.cmd_tally_line_probe, _probe_argv())
    assert args.npoints == 100
    assert args.p0 == [0.0, 0.0, 0.0]
    assert args.p1 == [1.0, 1.0, 1.0]

    args = _parse(tally_vtk_cmds.cmd_tally_line_probe, _probe_argv("--npoints", "25"))
    assert args.npoints == 25


# ---------------------------------------------------------------------------
# openmc.tally-contour (stdout-JSON contract, exit 1)
# ---------------------------------------------------------------------------


def _contour_argv(*extra):
    """Base contour argv: tally 1 with one iso over a missing file.

    The statepoint positional leads: --iso takes 1+ values and would
    greedily swallow a trailing positional.
    """
    return ["/no/such/statepoint.h5", "--tally-id", "1", "--iso", "5.0", *extra]


def test_tally_contour_missing_file(capsys):
    """A nonexistent statepoint fails with a stdout JSON error and exit 1."""
    args = _parse(tally_vtk_cmds.cmd_tally_contour, _contour_argv())

    rc = tally_vtk_cmds.cmd_tally_contour(args)

    assert rc == 1
    assert "File not found" in _stdout_error_line(capsys)


def test_tally_contour_exclusive_interpolation_flags(capsys):
    """--smooth + --pixelated together fail before any file access."""
    args = _parse(tally_vtk_cmds.cmd_tally_contour, _contour_argv("--smooth", "--pixelated"))

    rc = tally_vtk_cmds.cmd_tally_contour(args)

    assert rc == 1
    assert "mutually exclusive" in _stdout_error_line(capsys)


def test_tally_contour_bad_iso(capsys):
    """A non-finite --iso fails with a stdout JSON error."""
    args = _parse(tally_vtk_cmds.cmd_tally_contour, _contour_argv())
    args.iso = [float("nan")]

    rc = tally_vtk_cmds.cmd_tally_contour(args)

    assert rc == 1
    assert "iso" in _stdout_error_line(capsys)


def test_tally_contour_iso_required():
    """--iso is required; argparse aborts with SystemExit when missing."""
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(tally_vtk_cmds.cmd_tally_contour, parser)

    with pytest.raises(SystemExit) as excinfo:
        parser.parse_args(["--tally-id", "1", "sp.h5"])
    assert excinfo.value.code == 2


def test_tally_contour_multi_iso_parsing():
    """--iso takes several values in one call."""
    args = _parse(tally_vtk_cmds.cmd_tally_contour, _contour_argv())
    assert args.iso == [5.0]

    args = _parse(
        tally_vtk_cmds.cmd_tally_contour,
        ["/no/such/statepoint.h5", "--tally-id", "1", "--iso", "1.0", "2.5", "4.0"],
    )
    assert args.iso == [1.0, 2.5, 4.0]
