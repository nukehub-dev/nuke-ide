"""Tests for the dose-response coefficient helper script."""

import json
import subprocess
import sys
import types
from pathlib import Path

import dose_coefficients
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


def _run_main(monkeypatch, capsys, *args):
    monkeypatch.setattr(sys, "argv", ["dose_coefficients.py", *args])
    code = dose_coefficients.main()
    return code, json.loads(capsys.readouterr().out)


def _install_fake_openmc_data(monkeypatch, coefficient):
    data_module = types.ModuleType("openmc.data")
    data_module.dose_coefficients = coefficient
    openmc_module = types.ModuleType("openmc")
    openmc_module.data = data_module
    monkeypatch.setitem(sys.modules, "openmc", openmc_module)
    monkeypatch.setitem(sys.modules, "openmc.data", data_module)


def test_prints_the_requested_coefficient_table(monkeypatch, capsys):
    calls = []

    def fake_coefficients(particle, geometry, source, quantity):
        calls.append((particle, geometry, source, quantity))
        return [1e-3, 2e-3], [3.0, 4.0]

    _install_fake_openmc_data(monkeypatch, fake_coefficients)
    code, payload = _run_main(
        monkeypatch,
        capsys,
        "--data-source",
        "icrp74",
        "--dose-quantity",
        "ambient",
        "--geometry",
        "ISO",
    )
    assert code == 0
    assert payload == {
        "success": True,
        "energy": [1e-3, 2e-3],
        "response": [3.0, 4.0],
        "units": "pSv cm^2",
    }
    assert calls == [("photon", "ISO", "icrp74", "ambient")]


def test_reports_a_missing_table(monkeypatch, capsys):
    def fail(*args, **kwargs):
        raise ValueError("no table for this quantity")

    _install_fake_openmc_data(monkeypatch, fail)
    code, payload = _run_main(monkeypatch, capsys)
    assert code == 0
    assert payload == {"success": False, "error": "no table for this quantity"}


def test_reports_openmc_missing(monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "openmc", None)
    monkeypatch.setitem(sys.modules, "openmc.data", None)
    code, payload = _run_main(monkeypatch, capsys)
    assert code == 0
    assert payload["success"] is False
    assert "OpenMC is required" in payload["error"]
