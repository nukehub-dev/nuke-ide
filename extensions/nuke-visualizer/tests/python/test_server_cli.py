"""Subprocess-based tests for server.py — the unified CLI entry point."""

import json
import os
import subprocess
import sys

import pytest

_SERVER_PY = os.path.abspath(
    os.path.join(os.path.dirname(__file__), '..', '..', 'python', 'server.py')
)

# Discovery imports every command module; tally_viz pulls in paraview/vtk
# when available, so allow generous but bounded time.
_TIMEOUT = 30


def _run_server(*argv):
    """Run server.py in a subprocess and return the CompletedProcess."""
    return subprocess.run(
        [sys.executable, _SERVER_PY, *argv],
        capture_output=True,
        text=True,
        timeout=_TIMEOUT,
    )


def test_no_args_prints_usage_and_exits_1():
    """Running without a command prints help and returns exit code 1."""
    proc = _run_server()

    assert proc.returncode == 1
    assert 'usage' in proc.stdout.lower()
    # Help should advertise at least one registered command.
    assert 'openmc.check' in proc.stdout


def test_bogus_command_fails():
    """An unknown command is rejected by argparse (exit code 2 with a
    usage error on stderr — argparse handles it before server.main can
    return its own exit code 1)."""
    proc = _run_server('bogus-command')

    assert proc.returncode != 0
    assert 'invalid choice' in proc.stderr


def test_openmc_check_command_json_shape():
    """openmc.check works without heavy deps: it reports whether the
    openmc Python module is importable as a JSON object on stdout.

    Exit code 0 + available=true when openmc is installed,
    exit code 1 + available=false otherwise.
    """
    proc = _run_server('openmc.check')

    payload = json.loads(proc.stdout.strip())
    assert 'available' in payload

    if payload['available']:
        assert proc.returncode == 0
        assert 'version' in payload
    else:
        assert proc.returncode == 1
        assert 'error' in payload


def test_help_lists_registered_commands():
    """-h exits successfully and lists commands from both plugins."""
    proc = _run_server('-h')

    assert proc.returncode == 0
    assert 'openmc.check' in proc.stdout


if __name__ == '__main__':  # pragma: no cover
    raise SystemExit(pytest.main([__file__]))
