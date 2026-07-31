"""Shared helpers for the openmc-studio end-to-end suite.

Kept in a uniquely-named module (NOT conftest.py) so test modules can import
them even when pytest has several test directories on sys.path — conftest
module names collide across directories.

Path policy: NO default paths to machine-specific data. Cross sections come
from OPENMC_CROSS_SECTIONS (the openmc-standard env var), the depletion chain
from NUKE_E2E_CHAIN — tests that need them skip with a clear message when the
variable is unset or the file is missing. The DAGMC test asset is repo-local
(tests/e2e/assets/fuel_pin.h5m).
"""

import os

import pytest

# Repo-local DAGMC test asset (committed to the repo, resolved from this file)
ASSETS_DIR = os.path.dirname(os.path.abspath(__file__))
FUEL_PIN_H5M = os.path.join(ASSETS_DIR, "assets", "fuel_pin.h5m")


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


def require_chain():
    """Return the NUKE_E2E_CHAIN depletion chain path or skip when unset/missing."""
    chain = os.environ.get("NUKE_E2E_CHAIN")
    if not chain:
        pytest.skip("NUKE_E2E_CHAIN not set — point it at a depletion chain file")
    if not os.path.exists(chain):
        pytest.skip(f"NUKE_E2E_CHAIN points at a missing file: {chain}")
    return chain
