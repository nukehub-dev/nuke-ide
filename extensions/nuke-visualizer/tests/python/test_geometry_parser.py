"""Tests for plugins.openmc.lib.geometry_parser — OpenMC geometry.xml parsing."""

import pytest
from plugins.openmc.lib.geometry_parser import (
    OpenMCGeometryParser,
    parse_geometry,
)

BASIC_GEOMETRY = """<?xml version="1.0"?>
<geometry>
  <surface id="1" type="sphere" coeffs="0 0 0 10" boundary="vacuum"/>
  <surface id="2" type="z-cylinder" coeffs="0.5 -0.5 5.25"/>
  <cell id="1" name="fuel" material="1" region="-2" universe="0" temperature="600" density="10.5"/>
  <cell id="2" name="gap" material="void" region="2 -1" universe="0"/>
</geometry>
"""

LATTICE_GEOMETRY = """<?xml version="1.0"?>
<geometry>
  <surface id="1" type="sphere" coeffs="0 0 0 50" boundary="vacuum"/>
  <cell id="1" name="pin" material="1" region="-1" universe="1"/>
  <cell id="2" name="root cell" fill="10" region="-1" universe="0"/>
  <lattice id="10" name="assy" type="rect" dimension="2 2" lower_left="-1.0 -1.0" pitch="1.0 1.0" outer="5">
    <universes>1 2
3 4</universes>
  </lattice>
</geometry>
"""

MATERIALS_XML = """<?xml version="1.0"?>
<materials>
  <material id="1" name="UO2">
    <density value="10.97" units="g/cm3"/>
    <nuclide name="U235" wo="0.05"/>
  </material>
</materials>
"""


def _write(tmp_path, name, content):
    path = tmp_path / name
    path.write_text(content)
    return path


def test_parse_surfaces(tmp_path):
    """Surfaces are parsed with id, mapped type, float coeffs and boundary."""
    geom = _write(tmp_path, "geometry.xml", BASIC_GEOMETRY)
    result = parse_geometry(str(geom))

    assert "error" not in result
    assert result["totalSurfaces"] == 2

    by_id = {s["id"]: s for s in result["surfaces"]}
    assert by_id[1]["type"] == "sphere"
    assert by_id[1]["coefficients"] == [0.0, 0.0, 0.0, 10.0]
    assert by_id[1]["boundary"] == "vacuum"
    assert by_id[2]["type"] == "z-cylinder"
    assert by_id[2]["coefficients"] == [0.5, -0.5, 5.25]
    # Boundary defaults to 'transmission' when not specified.
    assert by_id[2]["boundary"] == "transmission"


def test_surface_description_rendering(tmp_path):
    """Surface.to_dict includes a compact human-readable description."""
    geom = _write(tmp_path, "geometry.xml", BASIC_GEOMETRY)
    result = parse_geometry(str(geom))

    by_id = {s["id"]: s for s in result["surfaces"]}
    assert by_id[1]["description"] == "sphere(0, 0, 0, 10)"


def test_parse_cells_fill_types_and_attributes(tmp_path):
    """Cells capture fill type, region surfaces, temperature and density."""
    geom = _write(tmp_path, "geometry.xml", BASIC_GEOMETRY)
    result = parse_geometry(str(geom))

    assert result["totalCells"] == 2

    root = next(u for u in result["universes"] if u["isRoot"])
    cells = {c["id"]: c for c in root["cells"]}

    fuel = cells[1]
    assert fuel["name"] == "fuel"
    assert fuel["fillType"] == "material"
    assert fuel["fillId"] == 1
    # No materials.xml loaded, so a fallback name is generated.
    assert fuel["materialName"] == "Material 1"
    assert fuel["region"] == "-2"
    assert fuel["surfaces"] == [2]
    assert fuel["temperature"] == pytest.approx(600.0)
    assert fuel["density"] == pytest.approx(10.5)

    gap = cells[2]
    assert gap["fillType"] == "void"
    assert gap["fillId"] is None
    # Region "2 -1" references surfaces 1 and 2 (signs stripped).
    assert sorted(gap["surfaces"]) == [1, 2]
    assert gap["temperature"] is None


def test_parse_region_surface_extraction_handles_operators():
    """Parentheses, union/intersection and complement tokens are handled."""
    parser = OpenMCGeometryParser()
    ids = parser._extract_surfaces_from_region("(-1 & 2) | ~3")
    assert sorted(ids) == [1, 2, 3]
    assert parser._extract_surfaces_from_region("") == []


def test_parse_universe_organization(tmp_path):
    """Cells are grouped into universes; universe 0 becomes the root."""
    geom = _write(tmp_path, "geometry.xml", LATTICE_GEOMETRY)
    result = parse_geometry(str(geom))

    assert result["rootUniverseId"] == 0

    universes = {u["id"]: u for u in result["universes"]}
    assert universes[0]["isRoot"] is True
    assert universes[1]["isRoot"] is False
    assert universes[1]["nCells"] == 1

    # Universe-filled cell
    root_cell = universes[0]["cells"][0]
    assert root_cell["fillType"] == "universe"
    assert root_cell["fillId"] == 10


def test_parse_lattice(tmp_path):
    """Rectangular lattices parse dimensions, pitch, universes and outer."""
    geom = _write(tmp_path, "geometry.xml", LATTICE_GEOMETRY)
    result = parse_geometry(str(geom))

    assert len(result["lattices"]) == 1
    lat = result["lattices"][0]
    assert lat["id"] == 10
    assert lat["name"] == "assy"
    assert lat["type"] == "rect"
    assert lat["dimensions"] == [2, 2]
    assert lat["lowerLeft"] == [-1.0, -1.0]
    assert lat["pitch"] == [1.0, 1.0]
    assert lat["outer"] == 5
    # 2D universe grid is wrapped in an outer list (3D form).
    assert lat["universes"] == [[[1, 2], [3, 4]]]


def test_parse_model_directory_loads_material_names(tmp_path):
    """Parsing a directory picks up materials.xml for material names."""
    _write(tmp_path, "materials.xml", MATERIALS_XML)
    _write(tmp_path, "geometry.xml", BASIC_GEOMETRY)

    result = parse_geometry(str(tmp_path))

    assert "error" not in result
    assert result["totalMaterials"] == 1
    root = next(u for u in result["universes"] if u["isRoot"])
    fuel = next(c for c in root["cells"] if c["id"] == 1)
    assert fuel["materialName"] == "UO2"


def test_parse_missing_file_returns_error(tmp_path):
    """A nonexistent path yields an error dict rather than raising."""
    result = parse_geometry(str(tmp_path / "geometry.xml"))
    assert "error" in result
    assert "not found" in result["error"].lower()


def test_parse_rejects_known_non_geometry_files(tmp_path):
    """settings.xml / materials.xml etc. are rejected with a clear message."""
    settings = _write(tmp_path, "settings.xml", "<settings></settings>")
    result = parse_geometry(str(settings))
    assert "error" in result
    assert "not a geometry file" in result["error"].lower()


def test_parse_rejects_xml_without_geometry_elements(tmp_path):
    """An XML file with no cell/surface/lattice elements is not geometry."""
    weird = _write(tmp_path, "weird.xml", '<plots><plot id="1"/></plots>')
    result = parse_geometry(str(weird))
    assert "error" in result
    assert "Not a valid geometry file" in result["error"]


def test_parse_geometry_with_no_cells_returns_error(tmp_path):
    """A geometry file containing only surfaces reports the missing cells."""
    geom = _write(
        tmp_path,
        "geometry.xml",
        '<geometry><surface id="1" type="sphere" coeffs="0 0 0 1"/></geometry>',
    )
    result = parse_geometry(str(geom))
    assert "error" in result
    assert "No cells found" in result["error"]


def test_parse_unsupported_extension_returns_error(tmp_path):
    """Non-XML, non-Python files are unsupported."""
    dat = _write(tmp_path, "model.dat", "binary-ish")
    result = parse_geometry(str(dat))
    assert "error" in result
    assert "Unsupported file type" in result["error"]


def test_response_structure_keys(tmp_path):
    """The successful response carries the documented top-level keys."""
    geom = _write(tmp_path, "geometry.xml", BASIC_GEOMETRY)
    result = parse_geometry(str(geom))

    for key in (
        "filePath",
        "universes",
        "surfaces",
        "lattices",
        "rootUniverseId",
        "totalCells",
        "totalSurfaces",
        "totalMaterials",
    ):
        assert key in result
    assert result["filePath"] == str(geom)
