"""Headless CLI contract tests for every registered visualizer command.

Two contracts are pinned here, both against ``python/server.py`` run as a
subprocess (the same entry point the IDE backend uses):

- every registered command supports ``--help`` with argparse usage on
  stdout and no traceback on stderr;
- OpenMC-plugin commands report missing/broken input as exactly one JSON
  object with an ``error`` string on stdout, exit code 1, and no traceback
  on stderr. When a heavy optional dependency (h5py, vtk, openmc, NCrystal)
  makes the command unexercisable, the JSON error names that dependency.

The command list is discovered in-process through the real plugin registry,
so commands added later are covered automatically. Tests run with only
pytest + numpy installed; dependency-shaped failures are asserted, never
skipped.
"""

import importlib.util
import json
import os
import subprocess
import sys

import pytest
from nuke_viz.plugin import get_commands
from nuke_viz.registry import discover_plugins

_PYTHON_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "python"))
_SERVER_PY = os.path.join(_PYTHON_DIR, "server.py")

# Discovery imports every command module, so allow generous but bounded time.
_TIMEOUT = 30

# A path no command can resolve; used to reach each handler's error path.
_MISSING_PATH = "/no/such/file"

# Every registered command name, discovered through the real registry.
discover_plugins()
_REGISTERED_COMMANDS = sorted(get_commands())


def _run_server(*argv):
    """Run server.py in a subprocess and return the CompletedProcess.

    An explicit UTF-8 encoding is used because help text contains non-ASCII
    characters and the ambient locale may be ASCII-only.
    """
    return subprocess.run(
        [sys.executable, _SERVER_PY, *argv],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=_TIMEOUT,
    )


def _module_available(module_name):
    """True when the module can be imported in this environment."""
    try:
        return importlib.util.find_spec(module_name) is not None
    except (ImportError, ValueError):
        return False


def _assert_stdout_error(proc, dependencies=()):
    """Assert the single-JSON-object-on-stdout error contract.

    ``dependencies`` names the heavy imports a handler needs before it can
    reach its file validation. When any of them is missing, the JSON error
    must name the missing dependency instead of a bare file error.
    """
    assert proc.returncode == 1, (
        f"expected exit code 1, got {proc.returncode}; "
        f"stdout={proc.stdout!r} stderr={proc.stderr!r}"
    )

    stdout = proc.stdout.strip()
    assert stdout, f"expected a JSON error on stdout, got nothing (stderr={proc.stderr!r})"

    payload = json.loads(stdout)
    assert isinstance(payload, dict), f"expected a JSON object, got: {payload!r}"
    error = payload.get("error")
    assert isinstance(error, str) and error, f"expected an 'error' string, got: {payload!r}"

    assert "Traceback" not in proc.stderr, f"handler leaked a traceback: {proc.stderr!r}"

    missing = [name for name in dependencies if not _module_available(name)]
    if missing:
        lowered = error.lower()
        assert any(name.lower() in lowered for name in missing), (
            f"expected the JSON error to name a missing dependency {missing}, got: {error!r}"
        )


def _case(command, argv, dependencies=()):
    """Build a parametrized missing-input case."""
    return pytest.param(command, argv, dependencies, id=command)


# Commands with no error-path coverage yet. Each argv passes argparse with a
# nonexistent file, so the handler must fail through its JSON error contract.
_MISSING_INPUT_CASES = [
    _case("openmc.spectrum", [_MISSING_PATH, "1"], ("h5py", "vtk")),
    _case("openmc.spatial", [_MISSING_PATH, "1", "x"], ("h5py", "vtk")),
    _case("openmc.heatmap", [_MISSING_PATH, "1", "xy", "0"], ("h5py", "vtk")),
    _case("openmc.heatmap-all", [_MISSING_PATH, "1", "xy"], ("h5py", "vtk")),
    _case("openmc.depletion-summary", [_MISSING_PATH], ("h5py", "vtk")),
    _case("openmc.depletion-materials", [_MISSING_PATH], ("h5py", "vtk")),
    _case("openmc.depletion-data", [_MISSING_PATH, "0"], ("h5py", "vtk")),
    _case("openmc.depletion-contact-dose", [_MISSING_PATH, "0"]),
    _case("openmc.depletion-decay-spectrum", [_MISSING_PATH, "0", "0"]),
    _case("openmc.kinetics", [_MISSING_PATH], ("h5py",)),
    _case("openmc.particle-restart", [_MISSING_PATH], ("h5py",)),
    _case("openmc.xs-plot", ["--reactions", "102"], ("openmc",)),
    _case("openmc.nuclear-data-library", ["--cross-sections", _MISSING_PATH]),
    _case("openmc.nuclear-data-nuclide", [_MISSING_PATH]),
    _case("openmc.endf-evaluations", [_MISSING_PATH]),
    _case("openmc.endf-detail", [_MISSING_PATH]),
    _case("openmc.ncrystal-materials", ["--dir", _MISSING_PATH]),
    _case("openmc.ncrystal-info", [_MISSING_PATH], ("NCrystal",)),
    _case("openmc.ncrystal-xs", [_MISSING_PATH], ("NCrystal",)),
    _case("openmc.tracks-info", [_MISSING_PATH], ("h5py",)),
    _case("openmc.tracks-data", [_MISSING_PATH], ("h5py",)),
    _case("openmc.collision-track-info", [_MISSING_PATH], ("h5py",)),
    _case("openmc.collision-track-data", [_MISSING_PATH], ("h5py",)),
    _case("openmc.weight-windows", [_MISSING_PATH], ("h5py",)),
    _case("openmc.overlap-viz", [_MISSING_PATH, "--overlaps", "[]"], ("openmc",)),
    _case("openmc.tracks-vtk", [_MISSING_PATH], ("h5py", "vtk")),
    _case("openmc.collision-vtk", [_MISSING_PATH], ("h5py", "vtk")),
    _case("openmc.weight-windows-vtk", [_MISSING_PATH], ("h5py", "vtk")),
    _case("openmc.voxel-vtk", [_MISSING_PATH], ("h5py", "vtk")),
    _case("openmc.vtk-info", [_MISSING_PATH + ".vtk"]),
]


def test_registry_discovers_commands():
    """The plugin registry exposes the real command set (not an empty list)."""
    assert _REGISTERED_COMMANDS
    assert "openmc.check" in _REGISTERED_COMMANDS
    assert "base.probe" in _REGISTERED_COMMANDS


@pytest.mark.parametrize("command", _REGISTERED_COMMANDS)
def test_every_registered_command_has_help_contract(command):
    """server.py <command> --help exits 0 with usage and no traceback."""
    proc = _run_server(command, "--help")

    assert proc.returncode == 0, (
        f"{command} --help failed with {proc.returncode}; stderr={proc.stderr!r}"
    )
    assert "usage:" in proc.stdout, f"{command} --help printed no usage: {proc.stdout!r}"
    assert "Traceback" not in proc.stderr, f"{command} --help leaked a traceback: {proc.stderr!r}"


def test_help_matrix_covers_every_registered_command():
    """The parametrized help matrix is built from the live registry."""
    current = sorted(get_commands())
    assert current == _REGISTERED_COMMANDS


def test_missing_input_cases_are_registered():
    """Every table-driven case names a command the registry actually knows."""
    case_names = {case.id for case in _MISSING_INPUT_CASES}
    assert case_names <= set(_REGISTERED_COMMANDS)


@pytest.mark.parametrize("command, argv, dependencies", _MISSING_INPUT_CASES)
def test_missing_input_reports_json_error(command, argv, dependencies):
    """Missing input yields exit 1, one stdout JSON error, and no traceback."""
    proc = _run_server(command, *argv)

    _assert_stdout_error(proc, dependencies)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__]))
