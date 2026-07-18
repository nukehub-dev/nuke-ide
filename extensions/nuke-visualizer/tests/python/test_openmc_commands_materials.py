"""Tests for plugins.openmc.commands.materials handlers.

openmc and PyYAML are not installed here. Success paths use fake openmc
modules injected into sys.modules; the XML-editing handlers
(openmc.add-material, openmc.mix-materials error paths, parser commands)
run against real files with stdlib-only code.
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
    """Build a real parser for the handler and parse argv with it."""
    parser = argparse.ArgumentParser()
    setup_parser_for_handler(handler, parser)
    return parser.parse_args(argv)


def _stdout_json(capsys):
    """Decode the single JSON object printed on stdout."""
    out = capsys.readouterr().out.strip()
    return json.loads(out)


@pytest.fixture(autouse=True)
def _reset_group_structure_cache(monkeypatch):
    """Isolate the module-level group-structure cache between tests."""
    monkeypatch.setattr(materials_cmds, "_group_structures_cache", None)


@pytest.fixture
def hermetic_group_structure_dirs(monkeypatch, tmp_path):
    """Point HOME and cwd at tmp_path so no real YAML config leaks in."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.chdir(tmp_path)
    return tmp_path


# ---------------------------------------------------------------------------
# load_group_structures / openmc.list-group-structures
# ---------------------------------------------------------------------------


def test_load_group_structures_empty_environment(hermetic_group_structure_dirs):
    """No openmc and no YAML files: empty structures, no sources."""
    structures, metadata = materials_cmds.load_group_structures()

    if "openmc.mgxs" not in sys.modules:
        assert structures == {}
        assert metadata == {"openmc_available": False, "sources": []}


def test_load_group_structures_is_cached(hermetic_group_structure_dirs):
    first = materials_cmds.load_group_structures()
    second = materials_cmds.load_group_structures()
    assert first is second


def test_load_group_structures_openmc_builtins(monkeypatch, hermetic_group_structure_dirs):
    mgxs_mod = ModuleType("openmc.mgxs")
    mgxs_mod.GROUP_STRUCTURES = {"XMAS-172": [1.0, 2.0, 3.0], "CASMO-2": [0.0, 20.0]}
    openmc_mod = ModuleType("openmc")
    openmc_mod.mgxs = mgxs_mod
    monkeypatch.setitem(sys.modules, "openmc", openmc_mod)
    monkeypatch.setitem(sys.modules, "openmc.mgxs", mgxs_mod)

    structures, metadata = materials_cmds.load_group_structures()

    assert structures == {"XMAS-172": [3.0, 2.0, 1.0], "CASMO-2": [20.0, 0.0]}
    assert metadata["openmc_available"] is True
    assert metadata["sources"] == ["OpenMC Built-ins"]


def test_load_group_structures_yaml_without_pyyaml(hermetic_group_structure_dirs, capsys):
    """A YAML config exists but PyYAML is missing: skip with a warning."""
    config = hermetic_group_structure_dirs / "group_structures.yaml"
    config.write_text("structures:\n  CUSTOM:\n    boundaries_eV: [1, 2]\n")

    structures, metadata = materials_cmds.load_group_structures()

    if "yaml" not in sys.modules:
        assert "CUSTOM" not in structures
        assert "PyYAML not installed" in capsys.readouterr().err


def test_cmd_list_group_structures(monkeypatch, capsys):
    monkeypatch.setattr(
        materials_cmds,
        "_group_structures_cache",
        ({"XMAS-172": [3.0, 2.0, 1.0], "ONE": [1.0]}, {"openmc_available": True, "sources": []}),
    )

    args = _parse(materials_cmds.cmd_list_group_structures, [])
    assert materials_cmds.cmd_list_group_structures(args) == 0

    result = _stdout_json(capsys)
    by_name = {s["name"]: s for s in result["structures"]}
    assert by_name["XMAS-172"]["groups"] == 2
    assert by_name["XMAS-172"]["boundaries"] == [3.0, 2.0, 1.0]
    assert by_name["ONE"]["groups"] == 0  # single boundary -> zero groups
    assert result["metadata"]["openmc_available"] is True


# ---------------------------------------------------------------------------
# openmc.list-thermal-materials / openmc.list-nuclides
# ---------------------------------------------------------------------------


def _install_fake_openmc_data(monkeypatch, libraries=None, open_raises=None):
    """Install fake openmc + openmc.data modules with a scripted DataLibrary."""
    data_mod = ModuleType("openmc.data")

    class DataLibrary:
        @staticmethod
        def from_xml(path):
            if open_raises is not None:
                raise open_raises
            return SimpleNamespace(libraries=libraries or [])

        @staticmethod
        def open():
            if open_raises is not None:
                raise open_raises
            return SimpleNamespace(libraries=libraries or [])

    data_mod.DataLibrary = DataLibrary
    openmc_mod = ModuleType("openmc")
    openmc_mod.data = data_mod
    monkeypatch.setitem(sys.modules, "openmc", openmc_mod)
    monkeypatch.setitem(sys.modules, "openmc.data", data_mod)
    return data_mod


def test_list_thermal_materials_openmc_missing(capsys):
    """openmc is not installed here: empty list with an error is reported."""
    args = _parse(materials_cmds.cmd_list_thermal_materials, [])
    rc = materials_cmds.cmd_list_thermal_materials(args)

    if "openmc" not in sys.modules:
        assert rc == 1
        result = _stdout_json(capsys)
        assert result["thermal_materials"] == []
        assert "error" in result


def test_list_thermal_materials_from_library(monkeypatch, capsys):
    _install_fake_openmc_data(
        monkeypatch,
        libraries=[
            {"type": "thermal", "materials": ["c_H_in_H2O", "c_Graphite"]},
            {"type": "neutron", "materials": ["U235"]},
            {"type": "thermal", "materials": ["c_H_in_H2O", "c_D_in_D2O"]},
            "not-a-dict",
        ],
    )

    args = _parse(materials_cmds.cmd_list_thermal_materials, [])
    assert materials_cmds.cmd_list_thermal_materials(args) == 0
    assert _stdout_json(capsys)["thermal_materials"] == ["c_D_in_D2O", "c_Graphite", "c_H_in_H2O"]


def test_list_thermal_materials_with_cross_sections_arg(monkeypatch, capsys):
    _install_fake_openmc_data(monkeypatch, libraries=[{"type": "thermal", "materials": ["x"]}])

    args = _parse(
        materials_cmds.cmd_list_thermal_materials, ["--cross-sections", "/xs/cross_sections.xml"]
    )
    assert materials_cmds.cmd_list_thermal_materials(args) == 0
    assert _stdout_json(capsys)["thermal_materials"] == ["x"]


def test_list_nuclides_openmc_missing(capsys):
    args = _parse(materials_cmds.cmd_list_nuclides, [])
    rc = materials_cmds.cmd_list_nuclides(args)

    if "openmc" not in sys.modules:
        assert rc == 1
        result = _stdout_json(capsys)
        assert result["nuclides"] == []
        assert "OpenMC not installed" in result["error"]


def test_list_nuclides_fallback_to_common_list(monkeypatch, capsys):
    """When the default data library cannot be opened, common nuclides are returned."""
    _install_fake_openmc_data(monkeypatch, open_raises=RuntimeError("no default library"))

    args = _parse(materials_cmds.cmd_list_nuclides, [])
    assert materials_cmds.cmd_list_nuclides(args) == 0
    nuclides = _stdout_json(capsys)["nuclides"]
    assert "U235" in nuclides
    assert "H1" in nuclides
    assert len(nuclides) > 100


def test_list_nuclides_from_dict_entries(monkeypatch, capsys):
    _install_fake_openmc_data(
        monkeypatch,
        libraries=[
            {"path": "/xs/U235.h5", "type": "neutron", "materials": ["U235", "U238"]},
            {"path": "/xs/H1.h5", "type": "neutron", "materials": ["H1"]},
            {"path": "/xs/empty.h5", "type": "neutron", "materials": []},
        ],
    )

    args = _parse(materials_cmds.cmd_list_nuclides, ["--cross-sections", "/xs/cross_sections.xml"])
    assert materials_cmds.cmd_list_nuclides(args) == 0
    assert _stdout_json(capsys)["nuclides"] == ["H1", "U235", "U238"]


def test_list_nuclides_from_old_api_entries(monkeypatch, capsys):
    """Old-style entries expose tables with nuclide/name attributes."""
    table_with_nuclide = SimpleNamespace(nuclide="Pu239")
    table_with_name = SimpleNamespace(name="Am241")
    table_with_nothing = SimpleNamespace()
    entry = SimpleNamespace(
        tables={"a": table_with_nuclide, "b": table_with_name, "c": table_with_nothing}
    )
    _install_fake_openmc_data(monkeypatch, libraries=[entry])

    args = _parse(materials_cmds.cmd_list_nuclides, ["--cross-sections", "/xs/cross_sections.xml"])
    assert materials_cmds.cmd_list_nuclides(args) == 0
    assert _stdout_json(capsys)["nuclides"] == ["Am241", "Pu239"]


def test_list_nuclides_library_error_reports_traceback(monkeypatch, capsys):
    def _raise(path):
        raise OSError("disk on fire")

    data_mod = ModuleType("openmc.data")
    data_mod.DataLibrary = SimpleNamespace(from_xml=_raise)
    openmc_mod = ModuleType("openmc")
    openmc_mod.data = data_mod
    monkeypatch.setitem(sys.modules, "openmc", openmc_mod)
    monkeypatch.setitem(sys.modules, "openmc.data", data_mod)

    args = _parse(materials_cmds.cmd_list_nuclides, ["--cross-sections", "/xs/cross_sections.xml"])
    assert materials_cmds.cmd_list_nuclides(args) == 1
    result = _stdout_json(capsys)
    assert result["nuclides"] == []
    assert "disk on fire" in result["error"]
    assert "traceback" in result


# ---------------------------------------------------------------------------
# openmc.materials / openmc.material-cell-linkage (real parsers)
# ---------------------------------------------------------------------------


def test_cmd_materials_success(tmp_path, capsys):
    mats = tmp_path / "materials.xml"
    mats.write_text(
        '<materials><material id="1" name="water">'
        '<density value="1.0" units="g/cm3"/>'
        '<nuclide name="H1" ao="2.0"/><nuclide name="O16" ao="1.0"/>'
        "</material></materials>"
    )
    args = _parse(materials_cmds.cmd_materials, [str(mats)])
    assert materials_cmds.cmd_materials(args) == 0
    result = _stdout_json(capsys)
    assert "error" not in result
    assert result["materials"][0]["name"] == "water"


def test_cmd_materials_missing_file(tmp_path, capsys):
    args = _parse(materials_cmds.cmd_materials, [str(tmp_path / "nope.xml")])
    assert materials_cmds.cmd_materials(args) == 1
    assert "error" in _stdout_json(capsys)


def test_cmd_material_cell_linkage_success(tmp_path, capsys):
    mats = tmp_path / "materials.xml"
    mats.write_text(
        '<materials><material id="1" name="fuel">'
        '<nuclide name="U235" ao="0.7"/></material></materials>'
    )
    geom = tmp_path / "geometry.xml"
    geom.write_text(
        '<geometry><surface id="1" type="sphere" coeffs="0 0 0 5"/>'
        '<cell id="10" material="1" region="-1"/></geometry>'
    )

    args = _parse(materials_cmds.cmd_material_cell_linkage, [str(mats), str(geom)])
    assert materials_cmds.cmd_material_cell_linkage(args) == 0
    result = _stdout_json(capsys)
    assert "error" not in result


def test_cmd_material_cell_linkage_missing_file(tmp_path, capsys):
    args = _parse(
        materials_cmds.cmd_material_cell_linkage,
        [str(tmp_path / "no.xml"), str(tmp_path / "no2.xml")],
    )
    assert materials_cmds.cmd_material_cell_linkage(args) == 1
    assert "error" in _stdout_json(capsys)


def _install_fake_materials_parser(monkeypatch, **attrs):
    module = ModuleType("plugins.openmc.lib.materials_parser")
    for key, value in attrs.items():
        setattr(module, key, value)
    monkeypatch.setitem(sys.modules, "plugins.openmc.lib.materials_parser", module)


def test_cmd_materials_unexpected_exception(monkeypatch, capsys):
    """A parser that raises (instead of returning an error dict) is caught."""

    def _boom(path):
        raise RuntimeError("parser exploded")

    _install_fake_materials_parser(monkeypatch, parse_materials_file=_boom)
    args = _parse(materials_cmds.cmd_materials, ["mats.xml"])
    assert materials_cmds.cmd_materials(args) == 1
    assert _stdout_json(capsys)["error"] == "parser exploded"


def test_cmd_material_cell_linkage_unexpected_exception(monkeypatch, capsys):
    def _boom(materials_path, geometry_path):
        raise RuntimeError("linkage exploded")

    _install_fake_materials_parser(monkeypatch, get_material_cell_linkage=_boom)
    args = _parse(materials_cmds.cmd_material_cell_linkage, ["mats.xml", "geom.xml"])
    assert materials_cmds.cmd_material_cell_linkage(args) == 1
    assert _stdout_json(capsys)["error"] == "linkage exploded"


# ---------------------------------------------------------------------------
# openmc.add-material (pure stdlib XML editing)
# ---------------------------------------------------------------------------


_MAT_SNIPPET = (
    '<material id="2" name="clad">'
    '<density value="6.5" units="g/cm3"/>'
    '<nuclide name="Zr90" wo="0.98"/>'
    "</material>"
)


def test_add_material_creates_new_file(tmp_path, capsys):
    target = tmp_path / "materials.xml"
    args = _parse(materials_cmds.cmd_add_material, [str(target), "--material-xml", _MAT_SNIPPET])
    assert materials_cmds.cmd_add_material(args) == 0
    assert _stdout_json(capsys)["success"] is True

    root = ET.parse(target).getroot()
    ids = [m.get("id") for m in root.findall("material")]
    assert ids == ["2"]


def test_add_material_replaces_duplicate_id(tmp_path, capsys):
    target = tmp_path / "materials.xml"
    target.write_text(
        '<materials><material id="2" name="old"/><material id="3" name="other"/></materials>'
    )

    args = _parse(materials_cmds.cmd_add_material, [str(target), "--material-xml", _MAT_SNIPPET])
    assert materials_cmds.cmd_add_material(args) == 0

    root = ET.parse(target).getroot()
    materials = root.findall("material")
    ids = [m.get("id") for m in materials]
    assert ids == ["3", "2"]  # duplicate removed, new one appended
    replaced = [m for m in materials if m.get("id") == "2"][0]
    assert replaced.get("name") == "clad"


def test_add_material_invalid_xml_returns_error(tmp_path, capsys):
    target = tmp_path / "materials.xml"
    args = _parse(materials_cmds.cmd_add_material, [str(target), "--material-xml", "<material"])
    assert materials_cmds.cmd_add_material(args) == 1
    assert "error" in _stdout_json(capsys)


# ---------------------------------------------------------------------------
# openmc.mix-materials
# ---------------------------------------------------------------------------


def _input_material(
    mat_id, name, density, nuclides, density_units="atom/b-cm", sab=None, depletable=False
):
    return SimpleNamespace(
        id=mat_id,
        name=name,
        density=density,
        density_units=density_units,
        nuclides=nuclides,
        _sab=sab or [],
        depletable=depletable,
    )


class _CreatedMaterial:
    """Records the material built by openmc.Material(...)."""

    instances = []

    def __init__(self, material_id=None, name=None):
        self.id = material_id if material_id is not None else 99
        self.name = name
        self.density = None
        self.density_units = None
        self.added_nuclides = []
        _CreatedMaterial.instances.append(self)

    def set_density(self, units, value):
        self.density_units = units
        self.density = value

    def add_nuclide(self, name, fraction, percent_type):
        self.added_nuclides.append((name, fraction, percent_type))

    def to_xml_element(self):
        elem = ET.Element("material", id=str(self.id))
        elem.set("name", self.name or "")
        return elem


def _install_mix_openmc(monkeypatch, materials_by_id, atomic_masses=None):
    """Fake openmc for mix_materials: Materials.from_xml, Nuclide, Material."""
    _CreatedMaterial.instances = []
    openmc_mod = ModuleType("openmc")
    openmc_mod.Materials = SimpleNamespace(from_xml=lambda path: list(materials_by_id.values()))
    openmc_mod.Material = _CreatedMaterial

    masses = atomic_masses or {}

    def _nuclide(name):
        if name in masses:
            return SimpleNamespace(atomic_mass=masses[name])
        raise ValueError(f"unknown nuclide {name}")

    openmc_mod.Nuclide = _nuclide
    monkeypatch.setitem(sys.modules, "openmc", openmc_mod)
    return openmc_mod


def test_mix_materials_missing_file(monkeypatch, tmp_path, capsys):
    _install_mix_openmc(monkeypatch, {})
    args = _parse(
        materials_cmds.cmd_mix_materials,
        [str(tmp_path / "nope.xml"), "--material-ids", "1", "--fractions", "1.0"],
    )
    assert materials_cmds.cmd_mix_materials(args) == 1
    assert "Materials file not found" in _stdout_json(capsys)["error"]


def test_mix_materials_openmc_missing(tmp_path, capsys):
    """Without openmc the handler reports the import failure."""
    mats = tmp_path / "materials.xml"
    mats.write_text("<materials/>")
    args = _parse(
        materials_cmds.cmd_mix_materials,
        [str(mats), "--material-ids", "1", "--fractions", "1.0"],
    )
    rc = materials_cmds.cmd_mix_materials(args)
    if "openmc" not in sys.modules:
        assert rc == 1
        assert "error" in _stdout_json(capsys)


def test_mix_materials_invalid_ids_and_not_found(monkeypatch, tmp_path, capsys):
    mats = tmp_path / "materials.xml"
    mats.write_text("<materials/>")
    _install_mix_openmc(monkeypatch, {})

    args = _parse(
        materials_cmds.cmd_mix_materials,
        [str(mats), "--material-ids", "a,b", "--fractions", "1.0"],
    )
    assert materials_cmds.cmd_mix_materials(args) == 1
    assert "Invalid material IDs or fractions" in _stdout_json(capsys)["error"]

    args = _parse(
        materials_cmds.cmd_mix_materials,
        [str(mats), "--material-ids", "42", "--fractions", "1.0"],
    )
    assert materials_cmds.cmd_mix_materials(args) == 1
    assert "Material 42 not found" in _stdout_json(capsys)["error"]


def test_mix_materials_atom_fraction(monkeypatch, tmp_path, capsys):
    mats = tmp_path / "materials.xml"
    mats.write_text("<materials/>")
    m1 = _input_material(1, "fuel", 10.0, [("U235", 0.7, "ao"), ("U238", 0.3, "ao")])
    m2 = _input_material(2, " absorber ", 8.0, [("B10", 1.0, "ao")], depletable=True)
    _install_mix_openmc(monkeypatch, {1: m1, 2: m2})

    args = _parse(
        materials_cmds.cmd_mix_materials,
        [
            str(mats),
            "--material-ids",
            "1,2",
            "--fractions",
            "0.75,0.25",
            "--name",
            "mix",
            "--id",
            "10",
        ],
    )
    assert materials_cmds.cmd_mix_materials(args) == 0

    result = _stdout_json(capsys)
    assert result["id"] == 10
    assert result["name"] == "mix"
    assert result["fractionType"] == "ao"
    assert result["method"] == "Manual Homogenization"
    assert result["isDepletable"] is True
    assert result["totalNuclides"] == 3
    fractions = {n["name"]: n["fraction"] for n in result["nuclides"]}
    # 0.75*0.7 : 0.75*0.3 : 0.25*1.0 normalized
    total = 0.75 * 0.7 + 0.75 * 0.3 + 0.25
    assert fractions["U235"] == pytest.approx(0.75 * 0.7 / total)
    assert fractions["U238"] == pytest.approx(0.75 * 0.3 / total)
    assert fractions["B10"] == pytest.approx(0.25 / total)

    created = _CreatedMaterial.instances[0]
    assert created.density_units == "atom/b-cm"
    assert created.density == pytest.approx((0.75 * 10.0 + 0.25 * 8.0) / 1.0)
    assert all(pt == "ao" for _, _, pt in created.added_nuclides)
    assert result["xml"].startswith("<material")


def test_mix_materials_ao_with_wo_conversion(monkeypatch, tmp_path, capsys):
    """wo nuclides inside an ao mix are converted via atomic masses."""
    mats = tmp_path / "materials.xml"
    mats.write_text("<materials/>")
    m1 = _input_material(1, "steel", 7.9, [("Fe54", 1.0, "wo")], density_units="g/cm3")
    _install_mix_openmc(monkeypatch, {1: m1}, atomic_masses={"Fe54": 53.94})

    args = _parse(
        materials_cmds.cmd_mix_materials,
        [str(mats), "--material-ids", "1", "--fractions", "1.0"],
    )
    assert materials_cmds.cmd_mix_materials(args) == 0
    result = _stdout_json(capsys)
    fractions = {n["name"]: n["fraction"] for n in result["nuclides"]}
    assert fractions["Fe54"] == pytest.approx(1.0)


def test_mix_materials_ao_with_wo_fallback_mass_number(monkeypatch, tmp_path, capsys):
    """If the nuclide lookup fails, the mass number is parsed from the name."""
    mats = tmp_path / "materials.xml"
    mats.write_text("<materials/>")
    m1 = _input_material(1, "x", 5.0, [("Zz99", 0.5, "wo"), ("H1", 0.5, "ao")])
    _install_mix_openmc(monkeypatch, {1: m1}, atomic_masses={})

    args = _parse(
        materials_cmds.cmd_mix_materials,
        [str(mats), "--material-ids", "1", "--fractions", "1.0"],
    )
    assert materials_cmds.cmd_mix_materials(args) == 0
    fractions = {n["name"]: n["fraction"] for n in _stdout_json(capsys)["nuclides"]}
    # Zz99: 0.5/99 atoms; H1: 0.5 atoms -> normalized
    total = 0.5 / 99 + 0.5
    assert fractions["Zz99"] == pytest.approx((0.5 / 99) / total)
    assert fractions["H1"] == pytest.approx(0.5 / total)


def test_mix_materials_weight_fraction(monkeypatch, tmp_path, capsys):
    mats = tmp_path / "materials.xml"
    mats.write_text("<materials/>")
    m1 = _input_material(1, "m1", 4.0, [("U235", 0.5, "wo")], density_units="g/cm3")
    m2 = _input_material(2, "m2", 6.0, [("U238", 0.5, "wo"), ("Pu239", 0.5, "ao")])
    _install_mix_openmc(
        monkeypatch, {1: m1, 2: m2}, atomic_masses={"U235": 235.0, "U238": 238.0, "Pu239": 239.0}
    )

    args = _parse(
        materials_cmds.cmd_mix_materials,
        [str(mats), "--material-ids", "1,2", "--fractions", "1.0,3.0", "--percent-type", "wo"],
    )
    assert materials_cmds.cmd_mix_materials(args) == 0

    result = _stdout_json(capsys)
    assert result["fractionType"] == "wo"
    assert result["densityUnit"] == "g/cm3"
    assert result["density"] == pytest.approx((1.0 * 4.0 + 3.0 * 6.0) / 4.0)
    fractions = {n["name"]: n["fraction"] for n in result["nuclides"]}
    # U235: 1.0*0.5; U238: 3.0*0.5; Pu239: 3.0*0.5*239 (ao -> mass contribution)
    total = 0.5 + 1.5 + 1.5 * 239.0
    assert fractions["U235"] == pytest.approx(0.5 / total)
    assert fractions["U238"] == pytest.approx(1.5 / total)
    assert fractions["Pu239"] == pytest.approx(1.5 * 239.0 / total)
    # The created material is populated with the weight fractions.
    created = _CreatedMaterial.instances[0]
    assert created.density_units == "g/cm3"
    assert all(pt == "wo" for _, _, pt in created.added_nuclides)


def test_mix_materials_volume_fraction(monkeypatch, tmp_path, capsys):
    mats = tmp_path / "materials.xml"
    mats.write_text("<materials/>")
    m1 = _input_material(1, "m1", 0.08, [("U235", 1.0, "ao")])
    m2 = _input_material(2, "m2", 0.02, [("B10", 1.0, "ao")])
    _install_mix_openmc(monkeypatch, {1: m1, 2: m2})

    args = _parse(
        materials_cmds.cmd_mix_materials,
        [str(mats), "--material-ids", "1,2", "--fractions", "0.6,0.4", "--percent-type", "vo"],
    )
    assert materials_cmds.cmd_mix_materials(args) == 0

    result = _stdout_json(capsys)
    assert result["fractionType"] == "vo"
    # Number densities: U235 0.6*0.08, B10 0.4*0.02 -> normalized atom fractions.
    total = 0.6 * 0.08 + 0.4 * 0.02
    fractions = {n["name"]: n["fraction"] for n in result["nuclides"]}
    assert fractions["U235"] == pytest.approx(0.048 / total)
    assert fractions["B10"] == pytest.approx(0.008 / total)
    # Density is the volume-weighted sum stored as atom/b-cm.
    created = _CreatedMaterial.instances[0]
    assert created.density_units == "atom/b-cm"
    assert created.density == pytest.approx(total / 1.0)


def test_mix_materials_volume_fraction_with_wo_nuclides(monkeypatch, tmp_path, capsys):
    mats = tmp_path / "materials.xml"
    mats.write_text("<materials/>")
    m1 = _input_material(1, "m1", 7.8, [("Fe54", 1.0, "wo")], density_units="g/cm3")
    _install_mix_openmc(monkeypatch, {1: m1}, atomic_masses={"Fe54": 53.94})

    args = _parse(
        materials_cmds.cmd_mix_materials,
        [str(mats), "--material-ids", "1", "--fractions", "1.0", "--percent-type", "vo"],
    )
    assert materials_cmds.cmd_mix_materials(args) == 0
    fractions = {n["name"]: n["fraction"] for n in _stdout_json(capsys)["nuclides"]}
    assert fractions["Fe54"] == pytest.approx(1.0)


def test_mix_materials_zero_fraction_sums(monkeypatch, tmp_path, capsys):
    mats = tmp_path / "materials.xml"
    mats.write_text("<materials/>")
    m1 = _input_material(1, "m1", 1.0, [("U235", 1.0, "ao")])
    _install_mix_openmc(monkeypatch, {1: m1})

    for percent_type, message in [
        ("ao", "Atom fractions sum to zero"),
        ("wo", "Weight fractions sum to zero"),
        ("vo", "Volume fractions sum to zero"),
    ]:
        args = _parse(
            materials_cmds.cmd_mix_materials,
            [
                str(mats),
                "--material-ids",
                "1",
                "--fractions",
                "0.0",
                "--percent-type",
                percent_type,
            ],
        )
        assert materials_cmds.cmd_mix_materials(args) == 1
        assert message in _stdout_json(capsys)["error"]


def test_mix_materials_sab_warnings(monkeypatch, tmp_path, capsys):
    mats = tmp_path / "materials.xml"
    mats.write_text("<materials/>")
    m1 = _input_material(1, "water", 1.0, [("H1", 1.0, "ao")], sab=["c_H_in_H2O"])
    _install_mix_openmc(monkeypatch, {1: m1})

    args = _parse(
        materials_cmds.cmd_mix_materials,
        [str(mats), "--material-ids", "1", "--fractions", "1.0"],
    )
    assert materials_cmds.cmd_mix_materials(args) == 0

    result = _stdout_json(capsys)
    assert result["warnings"] == ["Material 'water' (ID 1) contains c_H_in_H2O"]
    assert result["thermalScattering"] == [{"name": "c_H_in_H2O"}]
