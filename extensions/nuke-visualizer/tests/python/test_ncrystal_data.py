"""Tests for plugins.openmc.commands.ncrystal_data.

NCrystal is faked via sys.modules entries (its import is lazy inside the
functions), so the listing/info/XS paths and the error contract run without
NCrystal installed. An importorskip integration test checks the real API
surface in the full profile.
"""

import argparse
import json
import sys
import types
from types import SimpleNamespace

import pytest

np = pytest.importorskip("numpy")

from nuke_viz.plugin import setup_parser_for_handler  # noqa: E402
from plugins.openmc.commands import ncrystal_data  # noqa: E402


def _parse(handler, argv):
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(handler, parser)
    return parser.parse_args(argv)


def _stdout_json(capsys):
    return json.loads(capsys.readouterr().out.strip())


# ---------------------------------------------------------------------------
# Fake NCrystal
# ---------------------------------------------------------------------------


def _fake_atom(element):
    return f"{element}={element}(cohSL=1fm mass=1amu Z=1)"


def _install_fake_ncrystal(monkeypatch, *, with_datasrc=True):
    fake_nc = types.ModuleType("NCrystal")

    fake_nc.createInfo = lambda cfg: SimpleNamespace(
        getPhases=lambda: [],
        getComposition=lambda: [(0.6, _fake_atom("O")), (0.4, _fake_atom("Al"))],
        getTemperature=lambda: 300.0,
        getDensity=lambda: 3.95,
        getStructureInfo=lambda: {"spacegroup": 167.0, "a": 4.757, "volume": 254.5},
    )
    fake_nc.createScatter = lambda cfg: SimpleNamespace(
        crossSectionIsotropic=lambda e: np.full(len(e), 1.4)
    )
    fake_nc.createAbsorption = lambda cfg: SimpleNamespace(crossSectionIsotropic=lambda e: 1.0 / e)

    monkeypatch.setitem(sys.modules, "NCrystal", fake_nc)

    if with_datasrc:
        fake_datasrc = types.ModuleType("NCrystal.datasrc")
        entries = [
            SimpleNamespace(name="Al_sg225.ncmat", factName="stdlib"),
            SimpleNamespace(name="0.72xCO2+0.28xAr/massfractions", factName="stdlib"),
            SimpleNamespace(name="Be_sg194.ncmat", factName="stdlib"),
        ]
        fake_datasrc.browseFiles = lambda: entries
        monkeypatch.setitem(sys.modules, "NCrystal.datasrc", fake_datasrc)

    return fake_nc


# ---------------------------------------------------------------------------
# read_ncrystal_materials
# ---------------------------------------------------------------------------


def test_materials_from_data_library(monkeypatch):
    _install_fake_ncrystal(monkeypatch)
    result = ncrystal_data.read_ncrystal_materials()

    assert result["success"] is True
    assert result["materialCount"] == 2  # the gas-mixture entry is filtered out
    assert [m["name"] for m in result["materials"]] == ["Al_sg225.ncmat", "Be_sg194.ncmat"]
    assert result["materials"][0]["source"] == "stdlib"


def test_materials_from_directory(tmp_path, monkeypatch):
    _install_fake_ncrystal(monkeypatch)
    (tmp_path / "B_sg137.ncmat").write_text("NCMAT v1\n")
    (tmp_path / "A_sg225.ncmat").write_text("NCMAT v1\n")
    (tmp_path / "notes.txt").write_text("not a material")

    result = ncrystal_data.read_ncrystal_materials(str(tmp_path))

    assert result["success"] is True
    assert result["materialCount"] == 2
    assert [m["name"] for m in result["materials"]] == ["A_sg225.ncmat", "B_sg137.ncmat"]


def test_materials_missing_directory(tmp_path):
    with pytest.raises(FileNotFoundError, match="Directory not found"):
        ncrystal_data.read_ncrystal_materials(str(tmp_path / "nope"))


def test_materials_missing_ncrystal(monkeypatch):
    monkeypatch.setitem(sys.modules, "NCrystal", None)
    with pytest.raises(RuntimeError, match="ncrystal not installed"):
        ncrystal_data.read_ncrystal_materials()


# ---------------------------------------------------------------------------
# read_ncrystal_info
# ---------------------------------------------------------------------------


def test_info_detail(monkeypatch):
    _install_fake_ncrystal(monkeypatch)
    result = ncrystal_data.read_ncrystal_info("Al2O3_sg167_Corundum.ncmat;temp=300K")

    assert result["success"] is True
    assert result["temperature"] == pytest.approx(300.0)
    assert result["density"] == pytest.approx(3.95)
    assert result["composition"] == [
        {"element": "O", "fraction": pytest.approx(0.6), "label": _fake_atom("O")},
        {"element": "Al", "fraction": pytest.approx(0.4), "label": _fake_atom("Al")},
    ]
    assert result["structure"]["spacegroup"] == pytest.approx(167.0)


def test_info_empty_cfg():
    with pytest.raises(ValueError, match="Empty NCrystal cfg"):
        ncrystal_data.read_ncrystal_info("   ")


def test_info_missing_ncrystal(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "NCrystal", None)
    with pytest.raises(RuntimeError, match="ncrystal not installed"):
        ncrystal_data.read_ncrystal_info("Al_sg225.ncmat")


# ---------------------------------------------------------------------------
# read_ncrystal_xs
# ---------------------------------------------------------------------------


def test_xs_sampling(monkeypatch):
    _install_fake_ncrystal(monkeypatch)
    result = ncrystal_data.read_ncrystal_xs(
        "Al_sg225.ncmat;temp=300K", emin=1e-2, emax=1e2, points=5
    )

    assert result["success"] is True
    assert len(result["energies"]) == 5
    assert result["energies"] == pytest.approx([1e-2, 1e-1, 1e0, 1e1, 1e2])
    assert result["scatter"] == pytest.approx([1.4] * 5)
    assert result["absorption"] == pytest.approx([1e2, 1e1, 1e0, 1e-1, 1e-2])


def test_xs_rejects_bad_range_and_points(monkeypatch):
    _install_fake_ncrystal(monkeypatch)
    with pytest.raises(ValueError, match="energy range"):
        ncrystal_data.read_ncrystal_xs("Al_sg225.ncmat", emin=1e2, emax=1e-2)
    with pytest.raises(ValueError, match="points"):
        ncrystal_data.read_ncrystal_xs("Al_sg225.ncmat", points=1)
    with pytest.raises(ValueError, match="Empty NCrystal cfg"):
        ncrystal_data.read_ncrystal_xs("")


# ---------------------------------------------------------------------------
# Command contract
# ---------------------------------------------------------------------------


def test_materials_command_success_and_error(tmp_path, monkeypatch, capsys):
    _install_fake_ncrystal(monkeypatch)
    args = _parse(ncrystal_data.cmd_ncrystal_materials, ["--dir", str(tmp_path)])
    assert ncrystal_data.cmd_ncrystal_materials(args) == 0
    assert _stdout_json(capsys)["success"] is True

    args = _parse(ncrystal_data.cmd_ncrystal_materials, ["--dir", str(tmp_path / "nope")])
    assert ncrystal_data.cmd_ncrystal_materials(args) == 1
    payload = _stdout_json(capsys)
    assert payload["success"] is False and "not found" in payload["error"].lower()


def test_info_command_error_json(tmp_path, monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "NCrystal", None)
    args = _parse(ncrystal_data.cmd_ncrystal_info, ["Al_sg225.ncmat"])
    assert ncrystal_data.cmd_ncrystal_info(args) == 1
    payload = _stdout_json(capsys)
    assert payload["success"] is False and "ncrystal not installed" in payload["error"]


def test_xs_command_success_and_error(monkeypatch, capsys):
    _install_fake_ncrystal(monkeypatch)
    args = _parse(
        ncrystal_data.cmd_ncrystal_xs,
        ["Al_sg225.ncmat;temp=300K", "--emin", "1e-3", "--emax", "1e3", "--points", "7"],
    )
    assert ncrystal_data.cmd_ncrystal_xs(args) == 0
    payload = _stdout_json(capsys)
    assert payload["success"] is True and len(payload["energies"]) == 7

    args = _parse(ncrystal_data.cmd_ncrystal_xs, ["Al_sg225.ncmat", "--points", "1"])
    assert ncrystal_data.cmd_ncrystal_xs(args) == 1
    assert _stdout_json(capsys)["success"] is False


# ---------------------------------------------------------------------------
# Integration: real NCrystal API surface (full profile only)
# ---------------------------------------------------------------------------


def test_ncrystal_api_surface_matches_assumptions():
    NC = pytest.importorskip("NCrystal")
    from NCrystal.datasrc import browseFiles

    names = [e.name for e in browseFiles()]
    assert any(n.endswith(".ncmat") for n in names)

    info = NC.createInfo("Al_sg225.ncmat;temp=300K")
    assert hasattr(info, "getPhases")
    assert hasattr(info, "getComposition")
    assert hasattr(info, "getStructureInfo")

    scatter = NC.createScatter("Al_sg225.ncmat;temp=300K")
    assert hasattr(scatter, "crossSectionIsotropic")
    absorption = NC.createAbsorption("Al_sg225.ncmat;temp=300K")
    assert hasattr(absorption, "crossSectionIsotropic")
