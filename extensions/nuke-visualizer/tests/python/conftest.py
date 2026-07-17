"""Pytest configuration for the nuke-visualizer Python test suite.

Adds the extension's ``python/`` directory to ``sys.path`` (the same way
``python/server.py`` does) so that ``nuke_viz`` and ``plugins`` are
importable, and isolates the global command registry between tests.
"""

import os
import sys

import pytest

_PYTHON_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "python")
_PYTHON_DIR = os.path.abspath(_PYTHON_DIR)
if _PYTHON_DIR not in sys.path:
    sys.path.insert(0, _PYTHON_DIR)

from nuke_viz import plugin as _plugin_module  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_command_registry():
    """Snapshot and restore the global @command registry around each test."""
    snapshot = dict(_plugin_module._COMMANDS)
    yield
    _plugin_module._COMMANDS.clear()
    _plugin_module._COMMANDS.update(snapshot)
