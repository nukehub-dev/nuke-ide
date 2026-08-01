"""Shared helpers for the nuke-visualizer end-to-end suite.

Path policy: NO default paths to machine-specific data. Cross sections come
from OPENMC_CROSS_SECTIONS (the openmc-standard env var) — tests that need it
skip with a clear message when the variable is unset or the file is missing.
"""

import os

import pytest


def require_openmc():
    """Import openmc or skip (minimal profile has no openmc)."""
    return pytest.importorskip("openmc", reason="e2e requires the full OpenMC profile")


def require_cross_sections():
    """Return the OPENMC_CROSS_SECTIONS path or skip when unset/missing."""
    xs = os.environ.get("OPENMC_CROSS_SECTIONS")
    if not xs:
        pytest.skip(
            "OPENMC_CROSS_SECTIONS not set — point it at a cross_sections.xml (see openmc.org data libraries)"
        )
    if not os.path.exists(xs):
        pytest.skip(f"OPENMC_CROSS_SECTIONS points at a missing file: {xs}")
    return xs
