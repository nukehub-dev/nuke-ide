# Copyright (C) 2026 NukeHub and others.
# SPDX-License-Identifier: BSD-2-Clause
"""Edge cases for the OpenMC materials commands.

``test_openmc_commands_materials.py`` covers the common homogenization
paths. This module adds the branches that depend on unusual density units,
nuclide data without a resolved atomic mass, empty number densities, and an
unexpected parser failure. OpenMC itself is faked so the tests stay fast and
run in the minimal pytest + numpy profile.
"""

import argparse
import json
import sys
import xml.etree.ElementTree as ET
from types import ModuleType, SimpleNamespace

import pytest

np = pytest.importorskip("numpy")

from nuke_viz.plugin import setup_parser_for_handler  # noqa: E402
from plugins.openmc.commands import materials as materials_cmds  # noqa: E402


def _parse(handler, argv):
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(handler, parser)
    return parser.parse_args(argv)


def _stdout_json(capsys):
    return json.loads(capsys.readouterr().out.strip())


@pytest.fixture(autouse=True)
def _reset_group_structure_cache(monkeypatch):
    monkeypatch.setattr(materials_cmds, "_group_structures_cache", None)


@pytest.fixture
def hermetic_dirs(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.chdir(tmp_path)
    return tmp_path


# ---------------------------------------------------------------------------
# Group-structure discovery
# ---------------------------------------------------------------------------


def test_group_structures_ignore_missing_openmc_mgxs(monkeypatch, hermetic_dirs):
    monkeypatch.setitem(sys.modules, "openmc.mgxs", None)

    structures, metadata = materials_cmds.load_group_structures()

    assert structures == {}
    assert metadata == {"openmc_available": False, "sources": []}


def test_group_structures_report_missing_pyyaml(monkeypatch, hermetic_dirs, capsys):
    config = hermetic_dirs / "group_structures.yaml"
    config.write_text("structures:\n  CUSTOM:\n    boundaries_eV: [1, 2]\n")
    monkeypatch.setitem(sys.modules, "yaml", None)
    monkeypatch.setitem(sys.modules, "openmc.mgxs", None)

    structures, metadata = materials_cmds.load_group_structures()

    assert "CUSTOM" not in structures
    assert metadata["sources"] == []
    assert "PyYAML not installed" in capsys.readouterr().err


def test_group_structures_report_yaml_read_error(monkeypatch, hermetic_dirs, capsys):
    config = hermetic_dirs / "group_structures.yaml"
    config.write_text("structures: [unterminated\n")

    yaml_module = ModuleType("yaml")

    def _safe_load(_stream):
        raise RuntimeError("invalid yaml")

    yaml_module.safe_load = _safe_load
    monkeypatch.setitem(sys.modules, "yaml", yaml_module)
    monkeypatch.setitem(sys.modules, "openmc.mgxs", None)

    structures, metadata = materials_cmds.load_group_structures()

    assert structures == {}
    assert metadata["sources"] == []
    assert "Error loading" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# Nuclide listing without OpenMC
# ---------------------------------------------------------------------------


def test_list_nuclides_reports_missing_openmc(monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "openmc", None)

    args = _parse(materials_cmds.cmd_list_nuclides, [])
    assert materials_cmds.cmd_list_nuclides(args) == 1

    payload = _stdout_json(capsys)
    assert payload["nuclides"] == []
    assert "OpenMC not installed" in payload["error"]


# ---------------------------------------------------------------------------
# Homogenization edge cases
# ---------------------------------------------------------------------------


class _InputMaterial:
    def __init__(
        self,
        material_id,
        name,
        density,
        nuclides,
        density_units="atom/b-cm",
        depletable=False,
        sab=None,
    ):
        self.id = material_id
        self.name = name
        self.density = density
        self.density_units = density_units
        self.nuclides = nuclides
        self.depletable = depletable
        if sab:
            self._sab = list(sab)


class _CreatedMaterial:
    instances = []

    def __init__(self, material_id=None, name=None):
        self.id = material_id if material_id is not None else 1
        self.name = name or "Mixed Material"
        self.density = 0.0
        self.density_units = "atom/b-cm"
        self.added_nuclides = []
        type(self).instances.append(self)

    def set_density(self, units, value):
        self.density_units = units
        self.density = value

    def add_nuclide(self, name, fraction, percent_type="ao"):
        self.added_nuclides.append((name, fraction, percent_type))

    def to_xml_element(self):
        return ET.Element("material", {"id": str(self.id)})


def _install_openmc(monkeypatch, materials, atomic_masses=None, from_xml_error=None):
    _CreatedMaterial.instances = []
    module = ModuleType("openmc")
    if from_xml_error is not None:

        def _from_xml(_path):
            raise from_xml_error

        module.Materials = SimpleNamespace(from_xml=_from_xml)
    else:
        module.Materials = SimpleNamespace(from_xml=lambda _path: list(materials.values()))
    module.Material = _CreatedMaterial
    masses = atomic_masses or {}

    def _nuclide(name):
        if name in masses:
            return SimpleNamespace(atomic_mass=masses[name])
        raise ValueError(f"unknown nuclide {name}")

    module.Nuclide = _nuclide
    monkeypatch.setitem(sys.modules, "openmc", module)
    return module


def _mix(tmp_path, monkeypatch, materials, fractions, percent_type, atomic_masses=None):
    materials_file = tmp_path / "materials.xml"
    materials_file.write_text("<materials/>")
    _install_openmc(monkeypatch, materials, atomic_masses=atomic_masses)
    args = _parse(
        materials_cmds.cmd_mix_materials,
        [
            str(materials_file),
            "--material-ids",
            ",".join(str(material_id) for material_id in materials),
            "--fractions",
            fractions,
            "--percent-type",
            percent_type,
        ],
    )
    return materials_cmds.cmd_mix_materials(args)


def test_volume_mix_converts_mass_density_atom_fractions(tmp_path, monkeypatch, capsys):
    material = _InputMaterial(
        1,
        "steel",
        7.0,
        [("Fe54", 1.0, "ao")],
        density_units="g/cm3",
    )

    assert _mix(tmp_path, monkeypatch, {1: material}, "1.0", "vo") == 0

    payload = _stdout_json(capsys)
    assert payload["nuclides"] == [{"name": "Fe54", "fraction": 1.0, "fractionType": "ao"}]
    created = _CreatedMaterial.instances[0]
    assert created.density_units == "atom/b-cm"
    assert created.density == pytest.approx(7.0)


def test_volume_mix_falls_back_for_unknown_nuclide_masses(tmp_path, monkeypatch, capsys):
    material = _InputMaterial(
        1,
        "mix",
        2.0,
        [("Zz99", 0.5, "wo"), ("Qq1", 0.5, "other")],
        density_units="g/cm3",
    )

    assert _mix(tmp_path, monkeypatch, {1: material}, "1.0", "vo") == 0

    fractions = {n["name"]: n["fraction"] for n in _stdout_json(capsys)["nuclides"]}
    expected_total = 2.0 * 0.5 / 99 + 2.0 * 0.5
    assert fractions["Zz99"] == pytest.approx((2.0 * 0.5 / 99) / expected_total)
    assert fractions["Qq1"] == pytest.approx((2.0 * 0.5) / expected_total)
    assert sum(fractions.values()) == pytest.approx(1.0)


def test_volume_mix_with_zero_number_density(tmp_path, monkeypatch, capsys):
    material = _InputMaterial(1, "void", 0.0, [("U235", 1.0, "ao")])

    assert _mix(tmp_path, monkeypatch, {1: material}, "1.0", "vo") == 0

    payload = _stdout_json(capsys)
    assert payload["nuclides"] == [{"name": "U235", "fraction": 0, "fractionType": "ao"}]
    assert _CreatedMaterial.instances[0].density == pytest.approx(0.0)


def test_weight_mix_falls_back_for_unknown_atomic_masses(tmp_path, monkeypatch, capsys):
    material = _InputMaterial(1, "alloy", 1.0, [("Zz42", 0.5, "ao")])

    assert _mix(tmp_path, monkeypatch, {1: material}, "1.0", "wo") == 0

    payload = _stdout_json(capsys)
    assert payload["nuclides"] == [{"name": "Zz42", "fraction": 1.0, "fractionType": "wo"}]
    created = _CreatedMaterial.instances[0]
    assert created.density_units == "g/cm3"
    assert all(percent_type == "wo" for _name, _fraction, percent_type in created.added_nuclides)


def test_mix_materials_reports_unexpected_parser_failure(tmp_path, monkeypatch, capsys):
    materials_file = tmp_path / "materials.xml"
    materials_file.write_text("<materials/>")
    _install_openmc(monkeypatch, {}, from_xml_error=RuntimeError("corrupt library"))
    args = _parse(
        materials_cmds.cmd_mix_materials,
        [str(materials_file), "--material-ids", "1", "--fractions", "1.0"],
    )

    assert materials_cmds.cmd_mix_materials(args) == 1

    payload = _stdout_json(capsys)
    assert payload["error"] == "corrupt library"
    assert "Traceback" in payload["traceback"]
