"""Tests for ncrystal_import: the NCrystal material import job.

The missing-dependency path is forced (openmc absent), and the success path
is exercised against a fake openmc module. The real NCrystal path is covered
by an importorskip integration test.
"""

import json
import sys
import types

import ncrystal_import
import pytest


class _FakeNuclide:
    def __init__(self, name, percent, percent_type="ao"):
        self.name = name
        self.percent = percent
        self.percent_type = percent_type


class _FakeMaterial:
    def __init__(self):
        self.nuclides = [_FakeNuclide("Al27", 1.0), _FakeNuclide("O16", 2.0)]
        self.density = 2.7
        self.temperature = 300.0


class TestImportNCrystal:
    def test_missing_openmc_returns_json_error(self, monkeypatch, capsys):
        """Forced openmc absence yields success=false with a dependency message."""
        monkeypatch.setitem(sys.modules, "openmc", None)
        with pytest.raises(ImportError):
            ncrystal_import.import_ncrystal("Al_sg225.ncmat;temp=300K")

    def test_missing_openmc_main_prints_json_error(self, monkeypatch, capsys):
        """main() reports the missing dependency as a JSON object, exit 0."""
        monkeypatch.setitem(sys.modules, "openmc", None)
        monkeypatch.setattr(sys, "argv", ["ncrystal_import.py", "Al_sg225.ncmat"])
        with pytest.raises(SystemExit) as exc:
            ncrystal_import.main()
        assert exc.value.code == 0
        result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert result["success"] is False
        assert "Missing dependency" in result["error"]

    def test_success_returns_composition(self, monkeypatch):
        """A successful import returns nuclides, density, and temperature."""
        fake_openmc = types.ModuleType("openmc")
        fake_openmc.Material = types.SimpleNamespace(
            from_ncrystal=staticmethod(lambda cfg: _FakeMaterial())
        )
        monkeypatch.setitem(sys.modules, "openmc", fake_openmc)

        result = ncrystal_import.import_ncrystal("Al_sg225.ncmat;temp=300K")

        assert result["success"] is True
        assert result["material"]["density"] == 2.7
        assert result["material"]["densityUnit"] == "g/cm3"
        assert result["material"]["temperature"] == 300.0
        assert result["material"]["nuclides"] == [
            {"name": "Al27", "fraction": 1.0, "fractionType": "ao"},
            {"name": "O16", "fraction": 2.0, "fractionType": "ao"},
        ]

    def test_runtime_error_returns_json_error(self, monkeypatch, capsys):
        """A RuntimeError from from_ncrystal (NCrystal missing) yields success=false."""

        def raise_runtime(cfg):
            raise RuntimeError("The .from_ncrystal method requires NCrystal to be installed.")

        fake_openmc = types.ModuleType("openmc")
        fake_openmc.Material = types.SimpleNamespace(from_ncrystal=staticmethod(raise_runtime))
        monkeypatch.setitem(sys.modules, "openmc", fake_openmc)
        monkeypatch.setattr(sys, "argv", ["ncrystal_import.py", "Al_sg225.ncmat"])

        with pytest.raises(SystemExit) as exc:
            ncrystal_import.main()
        assert exc.value.code == 0
        result = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert result["success"] is False
        assert "NCrystal" in result["error"]

    def test_missing_cfg_argument_exits_with_code_2(self, monkeypatch):
        """The cfg positional argument is required."""
        monkeypatch.setattr(sys, "argv", ["ncrystal_import.py"])
        with pytest.raises(SystemExit) as exc:
            ncrystal_import.main()
        assert exc.value.code == 2


class TestNCrystalIntegration:
    def test_real_ncrystal_import(self):
        """End-to-end import of an NCrystal material (requires openmc + NCrystal)."""
        pytest.importorskip("openmc")
        pytest.importorskip("NCrystal")

        result = ncrystal_import.import_ncrystal("Al_sg225.ncmat;temp=300K")

        assert result["success"] is True
        assert result["material"]["density"] > 0
        assert result["material"]["temperature"] == 300.0
        assert any(n["name"].startswith("Al") for n in result["material"]["nuclides"])
