"""Subprocess-based tests for server.py — the unified CLI entry point."""

import importlib.metadata
import json
import os
import subprocess
import sys

import pytest
import server
from nuke_viz import registry

_SERVER_PY = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "python", "server.py")
)

# Discovery imports every command module, so allow generous but bounded time.
_TIMEOUT = 30


def _run_server(*argv):
    """Run server.py in a subprocess and return the CompletedProcess.

    An explicit UTF-8 encoding is used because the help text contains
    non-ASCII characters and the ambient locale may be ASCII-only.
    """
    return subprocess.run(
        [sys.executable, _SERVER_PY, *argv],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=_TIMEOUT,
    )


def test_no_args_prints_usage_and_exits_1():
    """Running without a command prints help and returns exit code 1."""
    proc = _run_server()

    assert proc.returncode == 1
    assert "usage" in proc.stdout.lower()
    # Help should advertise at least one registered command.
    assert "openmc.check" in proc.stdout


def test_bogus_command_fails():
    """An unknown command is rejected by argparse (exit code 2 with a
    usage error on stderr — argparse handles it before server.main can
    return its own exit code 1)."""
    proc = _run_server("bogus-command")

    assert proc.returncode != 0
    assert "invalid choice" in proc.stderr


def test_openmc_check_command_json_shape():
    """openmc.check works without heavy deps: it reports whether the
    openmc Python module is importable as a JSON object on stdout.

    Exit code 0 + available=true when openmc is installed,
    exit code 1 + available=false otherwise.
    """
    proc = _run_server("openmc.check")

    payload = json.loads(proc.stdout.strip())
    assert "available" in payload

    if payload["available"]:
        assert proc.returncode == 0
        assert "version" in payload
    else:
        assert proc.returncode == 1
        assert "error" in payload


def test_help_lists_registered_commands():
    """-h exits successfully and lists commands from both plugins."""
    proc = _run_server("-h")

    assert proc.returncode == 0
    assert "openmc.check" in proc.stdout


def fake_handler(args):
    return 7


fake_handler._command_help = "fake command"


def test_main_routes_to_the_registered_handler(monkeypatch):
    monkeypatch.setattr(server, "discover_plugins", lambda: [])
    monkeypatch.setattr(server, "get_commands", lambda: {"fake": fake_handler})
    monkeypatch.setattr(sys, "argv", ["server.py", "fake"])
    assert server.main() == 7


def test_main_without_a_command_prints_help(monkeypatch, capsys):
    monkeypatch.setattr(server, "discover_plugins", lambda: [])
    monkeypatch.setattr(server, "get_commands", lambda: {})
    monkeypatch.setattr(sys, "argv", ["server.py"])
    assert server.main() == 1
    assert "usage:" in capsys.readouterr().out


def test_entry_point_discovery_loads_plugins(monkeypatch):
    class EntryPoint:
        name = "example"

        def load(self):
            return None

    class EntryPoints(list):
        def select(self, group):
            return self

    monkeypatch.setattr(importlib.metadata, "entry_points", lambda: EntryPoints([EntryPoint()]))
    assert registry.discover_plugins_from_entry_points() == ["example"]


def test_entry_point_discovery_reports_a_broken_plugin(monkeypatch, capsys):
    class EntryPoint:
        name = "broken"

        def load(self):
            raise RuntimeError("missing dependency")

    class EntryPoints(list):
        def select(self, group):
            return self

    monkeypatch.setattr(importlib.metadata, "entry_points", lambda: EntryPoints([EntryPoint()]))
    assert registry.discover_plugins_from_entry_points() == []
    assert "broken" in capsys.readouterr().err


def test_entry_point_discovery_supports_the_legacy_mapping_api(monkeypatch):
    class EntryPoint:
        name = "legacy"

        def load(self):
            return None

    class LegacyEntryPoints:
        def get(self, group, default=None):
            return [EntryPoint()]

    monkeypatch.setattr(importlib.metadata, "entry_points", lambda: LegacyEntryPoints())
    assert registry.discover_plugins_from_entry_points() == ["legacy"]


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__]))
