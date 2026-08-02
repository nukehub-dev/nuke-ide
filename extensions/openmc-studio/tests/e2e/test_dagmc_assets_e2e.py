"""End-to-end tests for the DAGMC services against the repo-local test asset.

Copies tests/e2e/assets/fuel_pin.h5m (committed to the repo) into a temp dir
and exercises dagmc_info.py and dagmc_editor_service.py against it.
"""

import json
import os
import shutil
import subprocess
import sys

import pytest
from e2e_helpers import FUEL_PIN_H5M, require_openmc

openmc = require_openmc()
# The DAGMC drivers shell out to pydagmc (needs pymoab) — skip when unavailable
pytest.importorskip("pydagmc", reason="dagmc e2e requires pydagmc (with pymoab)")

pytestmark = pytest.mark.e2e

PYTHON_DIR = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "python")
)


def _asset_h5m():
    if not os.path.exists(FUEL_PIN_H5M):
        pytest.skip(f"DAGMC asset not found: {FUEL_PIN_H5M}")
    return FUEL_PIN_H5M


def _run_script(script, *argv):
    """Run a python/ driver script as a subprocess and parse its JSON output."""
    proc = subprocess.run(
        [sys.executable, os.path.join(PYTHON_DIR, script), *argv],
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert proc.returncode == 0, f"{script} failed: {proc.stderr[-500:]}"
    return json.loads(proc.stdout.strip().splitlines()[-1])


@pytest.mark.e2e
def test_dagmc_info_on_fuel_pin(tmp_path):
    src = _asset_h5m()
    work = tmp_path / "fuel_pin.h5m"
    shutil.copy(src, work)

    result = _run_script("dagmc_info.py", str(work), "--output-json")

    assert result.get("success") is True
    # Verified against the asset: 4 volumes (2 fuel pins, clad, graveyard)
    assert result["volumeCount"] == 4
    assert len(result["volumes"]) == 4
    assert "fuel" in result["materials"]
    assert result["totalTriangles"] > 0


@pytest.mark.e2e
def test_dagmc_editor_load_on_fuel_pin(tmp_path):
    src = _asset_h5m()
    work = tmp_path / "fuel_pin.h5m"
    shutil.copy(src, work)

    result = _run_script("dagmc_editor_service.py", "load", str(work))

    assert result.get("success") is True
    data = result["data"]
    assert data["volumeCount"] == 4
    assert data["materials"]["fuel"]["volumes"] == [1, 2]
