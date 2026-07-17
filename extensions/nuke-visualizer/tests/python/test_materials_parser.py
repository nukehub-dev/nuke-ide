"""Tests for plugins.openmc.lib.materials_parser — materials.xml parsing."""

import pytest

from plugins.openmc.lib.materials_parser import (
    Material,
    Nuclide,
    OpenMCMaterialsParser,
    ThermalScattering,
    get_material_cell_linkage,
    parse_materials_file,
)

MATERIALS_XML = """<?xml version="1.0"?>
<materials>
  <material id="2" name="Fuel" depletable="true">
    <density value="10.97" units="g/cm3"/>
    <nuclide name="U235" ao="0.05"/>
    <nuclide name="U238" ao="0.95"/>
    <nuclide name="O16" ao="2.0"/>
    <volume>100.5</volume>
    <temperature>900.0</temperature>
  </material>
  <material id="1" name="Water">
    <density value="1.0" units="g/cm3"/>
    <nuclide name="H1" wo="0.111"/>
    <nuclide name="O16" wo="0.889"/>
    <sab name="c_H_in_H2O" fraction="1.0"/>
  </material>
</materials>
"""

GEOMETRY_XML = """<?xml version="1.0"?>
<geometry>
  <surface id="1" type="sphere" coeffs="0 0 0 10" boundary="vacuum"/>
  <cell id="1" name="fuel cell" material="2" region="-1" universe="0"/>
  <cell id="2" name="moderator" material="1" region="-1" universe="0"/>
  <cell id="3" name="more fuel" material="2" region="-1" universe="1"/>
  <cell id="4" name="vacuum" material="void" region="-1" universe="0"/>
</geometry>
"""


@pytest.fixture
def materials_path(tmp_path):
    path = tmp_path / 'materials.xml'
    path.write_text(MATERIALS_XML)
    return path


def test_parse_returns_true_and_collects_materials(materials_path):
    """parse() returns True and fills both the dict and sorted list views."""
    parser = OpenMCMaterialsParser()
    assert parser.parse(str(materials_path)) is True

    assert set(parser.materials) == {1, 2}
    # materials_list is sorted by id regardless of document order.
    assert [m.id for m in parser.materials_list] == [1, 2]


def test_nuclide_fraction_types(materials_path):
    """wo= weight fractions and ao= atomic fractions are distinguished."""
    parser = OpenMCMaterialsParser()
    parser.parse(str(materials_path))

    water = parser.get_material(1)
    assert [(n.name, n.fraction, n.fraction_type) for n in water.nuclides] == [
        ('H1', pytest.approx(0.111), 'wo'),
        ('O16', pytest.approx(0.889), 'wo'),
    ]

    fuel = parser.get_material(2)
    assert all(n.fraction_type == 'ao' for n in fuel.nuclides)
    assert fuel.nuclides[0].name == 'U235'
    assert fuel.nuclides[0].fraction == pytest.approx(0.05)


def test_density_units_and_depletable(materials_path):
    """Density values/units and the depletable flag are captured."""
    parser = OpenMCMaterialsParser()
    parser.parse(str(materials_path))

    water = parser.get_material(1)
    assert water.density == pytest.approx(1.0)
    assert water.density_unit == 'g/cm3'
    assert water.is_depletable is False

    fuel = parser.get_material(2)
    assert fuel.density == pytest.approx(10.97)
    assert fuel.is_depletable is True


def test_volume_and_temperature(materials_path):
    """Optional volume and temperature elements are parsed when present."""
    parser = OpenMCMaterialsParser()
    parser.parse(str(materials_path))

    fuel = parser.get_material(2)
    assert fuel.volume == pytest.approx(100.5)
    assert fuel.temperature == pytest.approx(900.0)

    water = parser.get_material(1)
    assert water.volume is None
    assert water.temperature is None


def test_thermal_scattering(materials_path):
    """S(alpha,beta) tables become ThermalScattering entries."""
    parser = OpenMCMaterialsParser()
    parser.parse(str(materials_path))

    water = parser.get_material(1)
    assert len(water.thermal_scattering) == 1
    sab = water.thermal_scattering[0]
    assert sab.name == 'c_H_in_H2O'
    assert sab.fraction == pytest.approx(1.0)

    assert parser.get_material(2).thermal_scattering == []


def test_get_material_summary(materials_path):
    """The summary aggregates counts and serializes each material."""
    parser = OpenMCMaterialsParser()
    parser.parse(str(materials_path))
    summary = parser.get_material_summary()

    assert summary['totalMaterials'] == 2
    assert summary['totalNuclides'] == 5
    assert summary['depletableMaterials'] == 1
    assert summary['materialsWithThermalScattering'] == 1

    water = next(m for m in summary['materials'] if m['id'] == 1)
    assert water['name'] == 'Water'
    assert water['densityUnit'] == 'g/cm3'
    assert water['totalNuclides'] == 2
    assert water['nuclides'][0] == {
        'name': 'H1',
        'fraction': pytest.approx(0.111),
        'fractionType': 'wo',
    }
    assert water['thermalScattering'] == [
        {'name': 'c_H_in_H2O', 'fraction': pytest.approx(1.0)}
    ]
    assert water['isDepletable'] is False


def test_parse_materials_file_convenience(materials_path):
    """parse_materials_file returns the summary dict on success."""
    summary = parse_materials_file(str(materials_path))
    assert summary['totalMaterials'] == 2
    assert 'error' not in summary


def test_parse_missing_file_returns_false(tmp_path, capsys):
    """A missing file logs to stderr and parse() returns False."""
    parser = OpenMCMaterialsParser()
    assert parser.parse(str(tmp_path / 'nope.xml')) is False
    assert 'File not found' in capsys.readouterr().err


def test_parse_invalid_xml_returns_false(tmp_path, capsys):
    """Malformed XML returns False instead of raising."""
    bad = tmp_path / 'materials.xml'
    bad.write_text('<materials><material id="1">')
    parser = OpenMCMaterialsParser()
    assert parser.parse(str(bad)) is False
    assert 'Error parsing materials.xml' in capsys.readouterr().err

    # The convenience wrapper surfaces the failure as an error dict.
    assert parse_materials_file(str(bad)) == {'error': 'Failed to parse materials.xml'}


def test_search_materials(materials_path):
    """Search matches by name, id substring, and nuclide name."""
    parser = OpenMCMaterialsParser()
    parser.parse(str(materials_path))

    assert [m.id for m in parser.search_materials('water')] == [1]
    assert [m.id for m in parser.search_materials('u235')] == [2]

    by_id = parser.search_materials('1')
    assert parser.get_material(1) in by_id


def test_get_material_cell_linkage(tmp_path, materials_path):
    """Cells referencing each material are grouped by material id."""
    geom = tmp_path / 'geometry.xml'
    geom.write_text(GEOMETRY_XML)

    result = get_material_cell_linkage(str(materials_path), str(geom))

    assert 'error' not in result
    assert result['materialNames'] == {1: 'Water', 2: 'Fuel'}

    linkage = result['linkage']
    assert set(linkage) == {'1', '2'}

    fuel_cells = linkage['2']
    assert [c['id'] for c in fuel_cells] == [1, 3]
    assert fuel_cells[0]['name'] == 'fuel cell'
    assert fuel_cells[1]['universe'] == 1

    # The void-filled cell is not linked to any material.
    assert linkage['1'] == [{'id': 2, 'name': 'moderator', 'universe': 0}]


def test_get_material_cell_linkage_bad_materials_file(tmp_path):
    """A broken materials.xml surfaces as an error dict."""
    bad = tmp_path / 'materials.xml'
    bad.write_text('not xml at all <<<')
    geom = tmp_path / 'geometry.xml'
    geom.write_text(GEOMETRY_XML)

    result = get_material_cell_linkage(str(bad), str(geom))
    assert result == {'error': 'Failed to parse materials.xml'}
