"""Pytest configuration for the nuke-cad end-to-end suite.

These tests run REAL OpenMC simulations on DAGMC geometry produced by the
nuke-cad imprinting export pipeline. They only run in the full-dependency
profile (build123d/gmsh/pymoab/openmc installed, cross sections available);
every test skips cleanly in the minimal pytest+numpy profile.

Environment (no defaults — tests skip when these are unset):
    NUKE_TEST_PYTHON       Path to the full-dependency Python environment
    OPENMC_CROSS_SECTIONS  Path to cross_sections.xml (required for model runs)
"""

import os
import sys

import pytest

# Backend modules live in python/ (same convention as tests/python/conftest.py)
_PYTHON_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "python")
_PYTHON_DIR = os.path.abspath(_PYTHON_DIR)
if _PYTHON_DIR not in sys.path:
    sys.path.insert(0, _PYTHON_DIR)

# The openmc executable must be discoverable for subprocess runs — put the
# running interpreter's bin directory first on PATH (the full profile runs
# pytest with the environment python, so its sibling openmc binary is found).
_BIN_DIR = os.path.dirname(sys.executable)
if os.path.exists(os.path.join(_BIN_DIR, "openmc")) and _BIN_DIR not in os.environ.get(
    "PATH", ""
).split(os.pathsep):
    os.environ["PATH"] = _BIN_DIR + os.pathsep + os.environ.get("PATH", "")


def require_e2e_profile() -> str:
    """Return the OPENMC_CROSS_SECTIONS path or skip when the e2e gates are unset."""
    if not os.environ.get("NUKE_TEST_PYTHON"):
        pytest.skip(
            "NUKE_TEST_PYTHON not set — e2e requires the full-dependency Python environment"
        )
    xs = os.environ.get("OPENMC_CROSS_SECTIONS")
    if not xs:
        pytest.skip(
            "OPENMC_CROSS_SECTIONS not set — point it at a cross_sections.xml "
            "(see openmc.org data libraries)"
        )
    if not os.path.exists(xs):
        pytest.skip(f"OPENMC_CROSS_SECTIONS points at a missing file: {xs}")
    return xs


@pytest.fixture(autouse=True)
def _restore_cwd():
    """Some backends chdir into their working directory; undo that per test."""
    cwd = os.getcwd()
    yield
    os.chdir(cwd)
