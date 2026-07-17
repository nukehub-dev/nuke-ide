"""Tests for error paths and argument handling in base command modules.

The handlers in plugins.base.commands do their heavy imports lazily,
so a missing dependency (pymoab, gmsh, pydagmc, vtk) must surface as a
JSON error object on stderr with exit code 1 — never a traceback.
"""

import argparse
import json
import sys
import tempfile
import types

import pytest

from nuke_viz.plugin import setup_parser_for_handler
from plugins.base.commands import convert as convert_cmds
from plugins.base.commands import dagmc as dagmc_cmds


@pytest.fixture
def hermetic_tmp(monkeypatch, tmp_path):
    """Redirect tempfile.gettempdir so cache dirs stay inside tmp_path."""
    monkeypatch.setattr(tempfile, 'gettempdir', lambda: str(tmp_path))
    return tmp_path


def _parse(handler, argv):
    """Build a real parser for the handler and parse argv with it."""
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(handler, parser)
    return parser.parse_args(argv)


def _stderr_error_line(capsys):
    """Extract and JSON-decode the single {"error": ...} stderr line."""
    err = capsys.readouterr().err.strip()
    assert err.startswith('{"error"'), f'expected JSON error on stderr, got: {err!r}'
    return json.loads(err)['error']


# ---------------------------------------------------------------------------
# base.convert-dagmc
# ---------------------------------------------------------------------------

def test_convert_dagmc_missing_file(hermetic_tmp, capsys):
    """A nonexistent input file fails with a JSON error and exit code 1."""
    args = _parse(convert_cmds.cmd_convert_dagmc, ['--file', '/no/such/model.h5m'])

    rc = convert_cmds.cmd_convert_dagmc(args)

    assert rc == 1
    assert _stderr_error_line(capsys)


def test_convert_dagmc_missing_pymoab(hermetic_tmp, monkeypatch, capsys):
    """With pymoab unavailable, conversion reports the import failure."""
    fake_h5m = hermetic_tmp / 'model.h5m'
    fake_h5m.write_bytes(b'fake')
    monkeypatch.setitem(sys.modules, 'pymoab', None)

    args = _parse(convert_cmds.cmd_convert_dagmc, ['--file', str(fake_h5m)])
    rc = convert_cmds.cmd_convert_dagmc(args)

    assert rc == 1
    assert 'pymoab' in _stderr_error_line(capsys)


def test_convert_dagmc_volume_missing_pydagmc(hermetic_tmp, monkeypatch, capsys):
    """The --volume path reports a missing pydagmc dependency."""
    fake_h5m = hermetic_tmp / 'model.h5m'
    fake_h5m.write_bytes(b'fake')
    monkeypatch.setitem(sys.modules, 'pydagmc', None)

    args = _parse(
        convert_cmds.cmd_convert_dagmc,
        ['--file', str(fake_h5m), '--volume', '3'],
    )
    rc = convert_cmds.cmd_convert_dagmc(args)

    assert rc == 1
    assert 'pydagmc' in _stderr_error_line(capsys)


# ---------------------------------------------------------------------------
# base.convert-step
# ---------------------------------------------------------------------------

def test_convert_step_missing_file(hermetic_tmp, capsys):
    """A nonexistent STEP file fails with a JSON error and exit code 1."""
    args = _parse(convert_cmds.cmd_convert_step, ['--file', '/no/such/part.step'])

    rc = convert_cmds.cmd_convert_step(args)

    assert rc == 1
    assert _stderr_error_line(capsys)


def test_convert_step_missing_gmsh(hermetic_tmp, monkeypatch, capsys):
    """With gmsh unavailable, STEP conversion reports the import failure."""
    fake_step = hermetic_tmp / 'part.step'
    fake_step.write_bytes(b'fake')
    monkeypatch.setitem(sys.modules, 'gmsh', None)

    args = _parse(convert_cmds.cmd_convert_step, ['--file', str(fake_step)])
    rc = convert_cmds.cmd_convert_step(args)

    assert rc == 1
    assert 'gmsh' in _stderr_error_line(capsys)


# ---------------------------------------------------------------------------
# dagmc.info
# ---------------------------------------------------------------------------

def test_dagmc_info_missing_file(capsys):
    """dagmc.info on a missing file reports 'DAGMC file not found'."""
    args = _parse(dagmc_cmds.cmd_dagmc_info, ['--file', '/no/such/model.h5m'])

    rc = dagmc_cmds.cmd_dagmc_info(args)

    assert rc == 1
    assert 'DAGMC file not found' in _stderr_error_line(capsys)


def test_dagmc_info_missing_pydagmc(tmp_path, monkeypatch, capsys):
    """With pydagmc unavailable, dagmc.info reports the import failure."""
    fake_h5m = tmp_path / 'model.h5m'
    fake_h5m.write_bytes(b'fake')
    monkeypatch.setitem(sys.modules, 'pydagmc', None)

    args = _parse(dagmc_cmds.cmd_dagmc_info, ['--file', str(fake_h5m)])
    rc = dagmc_cmds.cmd_dagmc_info(args)

    assert rc == 1
    assert 'pydagmc' in _stderr_error_line(capsys)


# ---------------------------------------------------------------------------
# dagmc.visualize
# ---------------------------------------------------------------------------

def test_dagmc_visualize_missing_vtk(monkeypatch, capsys):
    """With vtk unavailable, dagmc.visualize reports the library failure
    without ever starting a server."""
    monkeypatch.delitem(sys.modules, 'plugins.base.lib.dagmc_viz', raising=False)
    monkeypatch.setitem(sys.modules, 'vtk', None)

    args = _parse(dagmc_cmds.cmd_dagmc_visualize, ['--file', 'model.h5m'])
    rc = dagmc_cmds.cmd_dagmc_visualize(args)

    assert rc == 1
    assert 'DAGMC visualization library not available' in _stderr_error_line(capsys)


def test_dagmc_visualize_highlight_list_parsing(monkeypatch):
    """The --highlight comma-separated string becomes a list of ints."""
    captured = {}

    def fake_visualize_dagmc(file, port, theme, highlight_ids):
        captured.update(
            file=file, port=port, theme=theme, highlight_ids=highlight_ids
        )
        return 0

    fake_module = types.ModuleType('plugins.base.lib.dagmc_viz')
    fake_module.visualize_dagmc = fake_visualize_dagmc
    monkeypatch.setitem(sys.modules, 'plugins.base.lib.dagmc_viz', fake_module)

    args = _parse(
        dagmc_cmds.cmd_dagmc_visualize,
        ['--file', 'model.h5m', '--port', '8123', '--theme', 'light',
         '--highlight', '1, 2,3'],
    )
    rc = dagmc_cmds.cmd_dagmc_visualize(args)

    assert rc == 0
    assert captured == {
        'file': 'model.h5m',
        'port': 8123,
        'theme': 'light',
        'highlight_ids': [1, 2, 3],
    }


def test_dagmc_visualize_no_highlight_passes_none(monkeypatch):
    """Without --highlight, highlight_ids is None."""
    captured = {}

    def fake_visualize_dagmc(file, port, theme, highlight_ids):
        captured['highlight_ids'] = highlight_ids
        return 0

    fake_module = types.ModuleType('plugins.base.lib.dagmc_viz')
    fake_module.visualize_dagmc = fake_visualize_dagmc
    monkeypatch.setitem(sys.modules, 'plugins.base.lib.dagmc_viz', fake_module)

    args = _parse(dagmc_cmds.cmd_dagmc_visualize, ['--file', 'model.h5m'])
    rc = dagmc_cmds.cmd_dagmc_visualize(args)

    assert rc == 0
    assert captured['highlight_ids'] is None


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
    args = _parse(convert_cmds.cmd_convert_step, ['--file', 'a.step'])
    assert args.mesh_size == pytest.approx(10.0)

    args = _parse(convert_cmds.cmd_convert_step, ['--file', 'a.step', '--mesh-size', '2.5'])
    assert args.mesh_size == pytest.approx(2.5)


def test_dagmc_visualize_theme_choices_enforced():
    """--theme only accepts 'dark' or 'light' (default 'dark')."""
    args = _parse(dagmc_cmds.cmd_dagmc_visualize, ['--file', 'm.h5m'])
    assert args.theme == 'dark'

    parser = argparse.ArgumentParser()
    setup_parser_for_handler(dagmc_cmds.cmd_dagmc_visualize, parser)
    with pytest.raises(SystemExit):
        parser.parse_args(['--file', 'm.h5m', '--theme', 'blue'])
