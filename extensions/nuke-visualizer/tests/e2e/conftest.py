"""Pytest configuration for the nuke-visualizer end-to-end suite.

These tests run against REAL data (a cross_sections.xml library and the
installed openmc package). They only run in the full-dependency profile;
every test skips cleanly in the minimal pytest+numpy profile.

Environment (no defaults — tests skip when unset):
    OPENMC_CROSS_SECTIONS  Path to cross_sections.xml
"""

import os
import sys

# Driver modules live in python/ (same convention as tests/python/conftest.py)
_PYTHON_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "python")
_PYTHON_DIR = os.path.abspath(_PYTHON_DIR)
if _PYTHON_DIR not in sys.path:
    sys.path.insert(0, _PYTHON_DIR)

# openmc.run() shells out to the openmc executable; make the interpreter's
# sibling binary discoverable when this suite runs on its own.
_BIN_DIR = os.path.dirname(sys.executable)
if os.path.exists(os.path.join(_BIN_DIR, "openmc")) and _BIN_DIR not in os.environ.get(
    "PATH", ""
).split(os.pathsep):
    os.environ["PATH"] = _BIN_DIR + os.pathsep + os.environ.get("PATH", "")
