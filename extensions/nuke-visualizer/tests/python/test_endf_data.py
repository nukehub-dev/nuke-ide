"""Tests for plugins.openmc.commands.endf_data.

The directory scan and the ENDF text-record section scan need no heavy deps
(synthetic files). openmc.data.decay / FissionProductYields are faked via
sys.modules entries for the decay/FPY detail paths (their imports are lazy).
An importorskip integration test checks the real openmc API surface.
"""

import argparse
import json
import sys
import types
from types import SimpleNamespace

import pytest

np = pytest.importorskip("numpy")

from nuke_viz.plugin import setup_parser_for_handler  # noqa: E402
from plugins.openmc.commands import endf_data  # noqa: E402


def _parse(handler, argv):
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(handler, parser)
    return parser.parse_args(argv)


def _stdout_json(capsys):
    return json.loads(capsys.readouterr().out.strip())


def _endf_record(data, mat, mf, mt, ns=1):
    """Build an 80-char ENDF record line."""
    return f"{data:<66}{mat:>4}{mf:>2}{mt:>3}{ns:>5}\n"


def _write_neutron_endf(path):
    """Minimal synthetic neutron evaluation: HEAD + a few MF3 sections."""
    lines = [
        " $Rev:: 573      $  $Date:: 2011-12-16#$                             1 0  0    0\n",
        _endf_record(" 9.223500+4 2.330248+2", 9228, 1, 451),
        _endf_record(" 1.000000+0 2.000000+7", 9228, 3, 2),
        _endf_record(" 1.000000+0 2.000000+7", 9228, 3, 18),
        _endf_record(" 1.000000+0 2.000000+7", 9228, 3, 102),
        _endf_record(" 0.000000+0 0.000000+0", 9228, 3, 0),  # SEND: mt=0, skipped
        _endf_record(" 0.000000+0 0.000000+0", 0, 0, 0),  # FEND
    ]
    path.write_text("".join(lines))
    return path


def _build_library(tmp_path):
    """Synthetic ENDF library tree."""
    neutrons = tmp_path / "neutrons"
    neutrons.mkdir()
    _write_neutron_endf(neutrons / "n-092_U_235.endf")
    (neutrons / "n-001_H_001.endf").write_text("fake")
    (neutrons / "notes.txt").write_text("ignored")
    decay = tmp_path / "decay"
    decay.mkdir()
    (decay / "dec-092_U_235.endf").write_text("fake")
    nfy = tmp_path / "nfy"
    nfy.mkdir()
    (nfy / "nfy-092_U_235.endf").write_text("fake")
    return tmp_path


# ---------------------------------------------------------------------------
# read_endf_evaluations (pure filesystem)
# ---------------------------------------------------------------------------


def test_evaluations_scan(tmp_path):
    _build_library(tmp_path)
    result = endf_data.read_endf_evaluations(str(tmp_path))

    assert result["success"] is True
    by_name = {s["name"]: s for s in result["sublibraries"]}
    assert set(by_name) == {"neutrons", "decay", "nfy"}
    assert by_name["neutrons"]["nuclideCount"] == 2
    assert by_name["decay"]["kind"] == "decay"
    assert by_name["nfy"]["kind"] == "nfy"

    u235 = [n for n in by_name["neutrons"]["nuclides"] if n["element"] == "U"][0]
    assert u235["z"] == 92 and u235["a"] == 235 and u235["name"] == "U235"


def test_evaluations_natural_element_mass(tmp_path):
    neutrons = tmp_path / "neutrons"
    neutrons.mkdir()
    (neutrons / "n-006_C_000.endf").write_text("fake")
    result = endf_data.read_endf_evaluations(str(tmp_path))
    (natc,) = result["sublibraries"][0]["nuclides"]
    assert natc["a"] == 0 and natc["name"] == "C0"


def test_evaluations_missing_and_empty_dir(tmp_path):
    with pytest.raises(FileNotFoundError, match="Directory not found"):
        endf_data.read_endf_evaluations(str(tmp_path / "nope"))
    with pytest.raises(ValueError, match="No ENDF sub-libraries"):
        endf_data.read_endf_evaluations(str(tmp_path))


# ---------------------------------------------------------------------------
# Neutron detail: text-record section scan (no heavy deps)
# ---------------------------------------------------------------------------


def test_neutron_detail_scan(tmp_path, monkeypatch):
    path = _write_neutron_endf(tmp_path / "n-092_U_235.endf")
    fake_openmc = types.ModuleType("openmc")
    fake_data = types.ModuleType("openmc.data")
    fake_data.REACTION_NAME = {2: "(n,elastic)", 18: "(n,fission)", 102: "(n,gamma)"}
    fake_openmc.data = fake_data
    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)
    monkeypatch.setitem(sys.modules, "openmc.data", fake_data)

    result = endf_data.read_endf_detail(str(path))

    assert result["success"] is True
    assert result["kind"] == "neutron"
    assert result["za"] == 92235
    mf3 = [r for r in result["reactions"] if r["mf"] == 3]
    assert [r["mt"] for r in mf3] == [2, 18, 102]
    assert mf3[1]["label"] == "(n,fission)"


def test_neutron_detail_without_openmc(tmp_path, monkeypatch):
    """Without openmc the scan still works, with plain MT labels."""
    path = _write_neutron_endf(tmp_path / "n-092_U_235.endf")
    monkeypatch.setitem(sys.modules, "openmc.data", None)

    result = endf_data.read_endf_detail(str(path))

    assert result["success"] is True
    assert {r["label"] for r in result["reactions"] if r["mf"] == 3} == {"MT 2", "MT 18", "MT 102"}


def test_parse_endf_float():
    assert endf_data._parse_endf_float(" 9.223500+4") == pytest.approx(92235.0)
    assert endf_data._parse_endf_float("-2.330248+2") == pytest.approx(-233.0248)
    assert endf_data._parse_endf_float(" 2.53e-02") == pytest.approx(0.0253)
    assert endf_data._parse_endf_float("3.0") == pytest.approx(3.0)


# ---------------------------------------------------------------------------
# Decay / FPY detail (fake openmc.data modules)
# ---------------------------------------------------------------------------


def _install_fake_decay(monkeypatch):
    fake_openmc = types.ModuleType("openmc")
    fake_data = types.ModuleType("openmc.data")
    fake_decay_mod = types.ModuleType("openmc.data.decay")

    class FakeMode:
        def __init__(self, modes, daughter, ratio):
            self.modes = modes
            self.daughter = daughter
            self.branching_ratio = ratio

    fake_decay_mod.Decay = SimpleNamespace(
        from_endf=lambda path: SimpleNamespace(
            nuclide={"name": "U235", "stable": False},
            half_life=2.221e16,
            modes=[FakeMode(["sf"], "U235", 7.2e-11), FakeMode(["alpha"], "Th231", 1.0)],
        )
    )
    fake_data.decay = fake_decay_mod
    fake_openmc.data = fake_data
    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)
    monkeypatch.setitem(sys.modules, "openmc.data", fake_data)
    monkeypatch.setitem(sys.modules, "openmc.data.decay", fake_decay_mod)


def _install_fake_fpy(monkeypatch):
    fake_openmc = types.ModuleType("openmc")
    fake_data = types.ModuleType("openmc.data")
    fake_data.FissionProductYields = SimpleNamespace(
        from_endf=lambda path: SimpleNamespace(
            nuclide={"name": "U235"},
            energies=[0.0253, 5.0e5],
            independent=[
                {"Te134": 0.0622, "Zr100": 0.0498, "Xe138": 0.0481, "Sr95": 0.001},
                {"Te134": 0.05, "Zr100": 0.04},
            ],
        )
    )
    fake_openmc.data = fake_data
    monkeypatch.setitem(sys.modules, "openmc", fake_openmc)
    monkeypatch.setitem(sys.modules, "openmc.data", fake_data)


def test_decay_detail(tmp_path, monkeypatch):
    path = tmp_path / "dec-092_U_235.endf"
    path.write_text("fake")
    _install_fake_decay(monkeypatch)

    result = endf_data.read_endf_detail(str(path))

    assert result["success"] is True
    assert result["kind"] == "decay"
    assert result["nuclide"] == "U235"
    assert result["halfLife"]["seconds"] == pytest.approx(2.221e16)
    assert result["halfLife"]["years"] == pytest.approx(2.221e16 / (365.25 * 24 * 3600), rel=1e-3)
    assert result["modes"][1] == {
        "modes": ["alpha"],
        "daughter": "Th231",
        "branchingRatio": 1.0,
        "branchingStdDev": 0.0,
    }


def test_fpy_detail(tmp_path, monkeypatch):
    path = tmp_path / "nfy-092_U_235.endf"
    path.write_text("fake")
    _install_fake_fpy(monkeypatch)

    result = endf_data.read_endf_detail(str(path), top_n=3)

    assert result["success"] is True
    assert result["kind"] == "nfy"
    assert result["energyCount"] == 2
    first = result["energies"][0]
    assert first["energy"] == pytest.approx(0.0253)
    assert first["productCount"] == 4
    assert [p["nuclide"] for p in first["topProducts"]] == ["Te134", "Zr100", "Xe138"]
    assert first["totalYield"] == pytest.approx(0.0622 + 0.0498 + 0.0481 + 0.001)


def test_spy_kind_dispatch(tmp_path, monkeypatch):
    path = tmp_path / "sfy-092_U_238.endf"
    path.write_text("fake")
    _install_fake_fpy(monkeypatch)
    result = endf_data.read_endf_detail(str(path))
    assert result["kind"] == "sfy"


# ---------------------------------------------------------------------------
# Command contract
# ---------------------------------------------------------------------------


def test_evaluations_command_success_and_error(tmp_path, capsys):
    _build_library(tmp_path)
    args = _parse(endf_data.cmd_endf_evaluations, [str(tmp_path)])
    assert endf_data.cmd_endf_evaluations(args) == 0
    assert _stdout_json(capsys)["success"] is True

    args = _parse(endf_data.cmd_endf_evaluations, [str(tmp_path / "nope")])
    assert endf_data.cmd_endf_evaluations(args) == 1
    payload = _stdout_json(capsys)
    assert payload["success"] is False and "not found" in payload["error"].lower()


def test_detail_command_missing_file(tmp_path, capsys):
    args = _parse(endf_data.cmd_endf_detail, [str(tmp_path / "n-092_U_235.endf")])
    assert endf_data.cmd_endf_detail(args) == 1
    payload = _stdout_json(capsys)
    assert payload["success"] is False and "not found" in payload["error"].lower()


# ---------------------------------------------------------------------------
# Integration: real openmc API surface (full profile only)
# ---------------------------------------------------------------------------


def test_openmc_decay_fpy_api_surface():
    pytest.importorskip("openmc")
    from openmc.data import FissionProductYields
    from openmc.data.decay import Decay

    assert hasattr(Decay, "from_endf")
    assert hasattr(FissionProductYields, "from_endf")
    import openmc.data

    assert 18 in openmc.data.REACTION_NAME
