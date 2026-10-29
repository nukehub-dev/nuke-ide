"""Tests for the dose-response coefficient helper script."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "python" / "dose_coefficients.py"


def run_script(*args):
    result = subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        check=False,
    )
    return json.loads(result.stdout), result


def test_script_returns_json_in_both_profiles():
    payload, _ = run_script("--particle", "photon", "--data-source", "icrp116")
    assert "success" in payload
    if payload["success"]:
        assert len(payload["energy"]) == len(payload["response"])
        assert payload["units"] == "pSv cm^2"
    else:
        assert "OpenMC" in payload["error"]


def test_missing_ambient_table_is_a_clean_error():
    pytest.importorskip("openmc")
    payload, result = run_script("--data-source", "icrp116", "--dose-quantity", "ambient")
    assert payload["success"] is False
    assert payload["error"]
    assert result.returncode == 0
