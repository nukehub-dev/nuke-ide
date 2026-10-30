"""Edge-case tests for plugins.openmc.lib.materials_parser.

Complements ``test_materials_parser.py`` with malformed density/volume/
temperature values, skipped nuclides and S(alpha,beta) rows, and the
material-cell linkage failure paths.
"""

import pytest
from plugins.openmc.lib.materials_parser import (
    OpenMCMaterialsParser,
    get_material_cell_linkage,
)

BASIC_GEOMETRY = """<?xml version="1.0"?>
<geometry>
  <cell id="1" name="fuel" material="1" region="-1" universe="0"/>
</geometry>
"""


def _parse_xml(tmp_path, content):
    path = tmp_path / "materials.xml"
    path.write_text(content)
    parser = OpenMCMaterialsParser()
    assert parser.parse(str(path)) is True
    return parser


# ---------------------------------------------------------------------------
# parse() failure paths
# ---------------------------------------------------------------------------


def test_parse_directory_is_an_unexpected_error(tmp_path, capsys):
    """A directory path fails the generic handler instead of raising."""
    parser = OpenMCMaterialsParser()

    assert parser.parse(str(tmp_path)) is False
    assert "Unexpected error" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# Density special values
# ---------------------------------------------------------------------------


def test_density_sum_and_non_numeric_values(tmp_path):
    """'sum' switches the unit; other unparsable values fall back to 0.0."""
    parser = _parse_xml(
        tmp_path,
        """<materials>
  <material id="1" name="sum density">
    <density value="sum" units="atom/b-cm"/>
  </material>
  <material id="2" name="bad density">
    <density value="not-a-number"/>
  </material>
  <material id="3" name="sum without units">
    <density value="sum"/>
  </material>
</materials>""",
    )

    summed = parser.get_material(1)
    assert summed.density == 0.0
    assert summed.density_unit == "atom/b-cm"

    bad = parser.get_material(2)
    assert bad.density == 0.0
    assert bad.density_unit == "g/cm3"

    unitless_sum = parser.get_material(3)
    assert unitless_sum.density == 0.0
    assert unitless_sum.density_unit == "sum"


# ---------------------------------------------------------------------------
# Optional volume/temperature values
# ---------------------------------------------------------------------------


def test_invalid_volume_and_temperature_are_left_unset(tmp_path):
    parser = _parse_xml(
        tmp_path,
        """<materials>
  <material id="1" name="bad extras">
    <density value="1.0"/>
    <volume>large</volume>
    <temperature>warm</temperature>
  </material>
</materials>""",
    )

    material = parser.get_material(1)
    assert material.volume is None
    assert material.temperature is None


def test_material_without_id_is_skipped(tmp_path, capsys):
    """A material with no numeric id is logged and omitted from the result."""
    parser = _parse_xml(
        tmp_path,
        """<materials>
  <material name="no id"><density value="1.0"/></material>
  <material id="2" name="valid"/>
</materials>""",
    )

    assert [material.id for material in parser.materials_list] == [2]
    assert "Error parsing material" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# Nuclide / thermal scattering malformed rows
# ---------------------------------------------------------------------------


def test_invalid_nuclides_are_skipped(tmp_path, capsys):
    """Nuclides need a name and a numeric fraction; bad rows are dropped."""
    parser = _parse_xml(
        tmp_path,
        """<materials>
  <material id="1" name="mixed">
    <nuclide wo="0.5"/>
    <nuclide name="U235" wo="not-a-number"/>
    <nuclide name="O16" wo="2.0"/>
  </material>
</materials>""",
    )

    material = parser.get_material(1)
    assert [(n.name, n.fraction) for n in material.nuclides] == [("O16", pytest.approx(2.0))]
    assert "Error parsing nuclide" in capsys.readouterr().err


def test_invalid_thermal_scattering_rows_are_skipped(tmp_path, capsys):
    parser = _parse_xml(
        tmp_path,
        """<materials>
  <material id="1" name="sab">
    <sab fraction="0.5"/>
    <sab name="bad" fraction="not-a-number"/>
    <sab name="c_H_in_H2O" fraction="2.0"/>
  </material>
</materials>""",
    )

    material = parser.get_material(1)
    assert [(s.name, s.fraction) for s in material.thermal_scattering] == [
        ("c_H_in_H2O", pytest.approx(2.0))
    ]
    assert "Error parsing thermal scattering" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# Material-cell linkage failure paths
# ---------------------------------------------------------------------------


def test_linkage_skips_non_integer_material_references(tmp_path):
    """A non-numeric material attribute on a cell is not a linkage error."""
    materials = tmp_path / "materials.xml"
    materials.write_text(
        """<materials>
  <material id="1" name="Fuel"/>
</materials>"""
    )
    geometry = tmp_path / "geometry.xml"
    geometry.write_text(
        """<geometry>
  <cell id="1" name="named material" material="UO2" region="-1" universe="0"/>
  <cell id="2" name="fuel" material="1" region="-1" universe="0"/>
</geometry>"""
    )

    result = get_material_cell_linkage(str(materials), str(geometry))

    assert "error" not in result
    assert result["linkage"] == {"1": [{"id": 2, "name": "fuel", "universe": 0}]}


def test_linkage_reports_geometry_parse_failure(tmp_path):
    """A missing geometry file surfaces as an error dict, not a traceback."""
    materials = tmp_path / "materials.xml"
    materials.write_text(
        """<materials>
  <material id="1" name="Fuel"/>
</materials>"""
    )

    result = get_material_cell_linkage(str(materials), str(tmp_path / "missing.xml"))

    assert "missing.xml" in result["error"]
