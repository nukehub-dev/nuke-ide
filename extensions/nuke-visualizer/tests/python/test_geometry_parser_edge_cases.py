"""Edge-case tests for plugins.openmc.lib.geometry_parser.

Complements ``test_geometry_parser.py`` with the paths that only run on
malformed model attributes, DAGMC references, and summary re-anchoring.
"""

import sys
import types

import pytest
from plugins.openmc.lib import geometry_parser as geometry

MATERIALS_XML = """<?xml version="1.0"?>
<materials>
  <material id="1" name="UO2"/>
</materials>
"""

BASIC_GEOMETRY = """<?xml version="1.0"?>
<geometry>
  <surface id="1" type="sphere" coeffs="0 0 0 10" boundary="vacuum"/>
  <cell id="1" name="fuel" material="1" region="-1" universe="0"/>
</geometry>
"""

DAGMC_GEOMETRY = """<?xml version="1.0"?>
<geometry>
  <dagmc_universe filename="{filename}"/>
</geometry>
"""


def _write(tmp_path, name, content):
    path = tmp_path / name
    path.write_text(content)
    return path


# ---------------------------------------------------------------------------
# parse() dispatch and directory fallbacks
# ---------------------------------------------------------------------------


def test_parse_unexpected_exception_returns_details():
    """A non-path argument is caught and reported with a traceback."""
    result = geometry.parse_geometry(None)

    assert "Failed to parse geometry" in result["error"]
    assert "Traceback" in result["details"]


def test_parse_directory_without_geometry_xml(tmp_path):
    """A model directory with materials but no geometry.xml is a clear error."""
    _write(tmp_path, "materials.xml", MATERIALS_XML)

    result = geometry.parse_geometry(str(tmp_path))

    assert "No geometry.xml found" in result["error"]


def test_parse_directory_warns_on_unreadable_materials(tmp_path, capsys):
    """Broken materials.xml only warns; geometry still parses with fallback names."""
    _write(tmp_path, "materials.xml", "<materials><material")
    _write(tmp_path, "geometry.xml", BASIC_GEOMETRY)

    result = geometry.parse_geometry(str(tmp_path))

    assert "error" not in result
    assert "Could not parse materials.xml" in capsys.readouterr().err
    cell = result["universes"][0]["cells"][0]
    assert cell["materialName"] == "Material 1"


# ---------------------------------------------------------------------------
# Malformed numeric cell attributes and region tokens
# ---------------------------------------------------------------------------


def test_parse_cell_ignores_non_numeric_temperature_and_density(tmp_path):
    """Bad temperature/density text leaves the optional fields unset."""
    geom = _write(
        tmp_path,
        "geometry.xml",
        """<geometry>
  <surface id="1" type="sphere" coeffs="0 0 0 1"/>
  <cell id="1" material="1" region="-1" temperature="hot" density="dense"/>
</geometry>""",
    )

    result = geometry.parse_geometry(str(geom))

    cell = result["universes"][0]["cells"][0]
    assert cell["temperature"] is None
    assert cell["density"] is None


def test_extract_surfaces_skips_non_numeric_tokens():
    """Tokens that are not surface ids are ignored instead of failing."""
    parser = geometry.OpenMCGeometryParser()

    assert sorted(parser._extract_surfaces_from_region("(-1 & 2) | ~3 | wall")) == [1, 2, 3]


# ---------------------------------------------------------------------------
# DAGMC geometry files
# ---------------------------------------------------------------------------


def test_dagmc_geometry_reports_resolved_relative_path(tmp_path):
    """A relative dagmc_universe filename is joined to the geometry directory."""
    geom = _write(tmp_path, "geometry.xml", DAGMC_GEOMETRY.format(filename="model.h5m"))

    result = geometry.parse_geometry(str(geom))

    assert "DAGMC geometry" in result["error"]
    assert str(tmp_path / "model.h5m") in result["error"]


def test_dagmc_geometry_keeps_absolute_filename(tmp_path):
    """An absolute dagmc_universe filename is reported unchanged."""
    absolute = tmp_path / "cad" / "model.h5m"
    geom = _write(tmp_path, "geometry.xml", DAGMC_GEOMETRY.format(filename=absolute))

    result = geometry.parse_geometry(str(geom))

    assert "DAGMC geometry" in result["error"]
    assert str(absolute) in result["error"]


def test_dagmc_without_filename_reports_missing_cells(tmp_path):
    """A dagmc_universe element with no filename falls through to the no-cells error."""
    geom = _write(tmp_path, "geometry.xml", "<geometry><dagmc_universe/></geometry>")

    result = geometry.parse_geometry(str(geom))

    assert "No cells found" in result["error"]


# ---------------------------------------------------------------------------
# _resolve_dagmc_path
# ---------------------------------------------------------------------------


def test_resolve_dagmc_path_returns_none_without_filename(tmp_path):
    assert geometry._resolve_dagmc_path(None, str(tmp_path)) is None


def test_resolve_dagmc_path_relative_file_in_reference_dir(tmp_path):
    target = _write(tmp_path, "model.h5m", "fake")

    resolved = geometry._resolve_dagmc_path("model.h5m", str(tmp_path))

    assert resolved == str(target.resolve())


def test_resolve_dagmc_path_searches_parent_directory(tmp_path):
    """summary.h5 under output/ resolves a DAGMC file in the model root."""
    output = tmp_path / "output"
    output.mkdir()
    target = _write(tmp_path, "model.h5m", "fake")

    resolved = geometry._resolve_dagmc_path("model.h5m", str(output))

    assert resolved == str(target.resolve())


def test_resolve_dagmc_path_absolute_file_exists(tmp_path):
    target = _write(tmp_path, "model.h5m", "fake")

    resolved = geometry._resolve_dagmc_path(str(target), str(tmp_path / "elsewhere"))

    assert resolved == str(target.resolve())


def test_resolve_dagmc_path_missing_absolute_falls_back_to_reference_dir(tmp_path):
    """A stale absolute path still resolves its basename next to the summary."""
    target = _write(tmp_path, "model.h5m", "fake")

    resolved = geometry._resolve_dagmc_path("/stale/project/model.h5m", str(tmp_path))

    assert resolved == str(target.resolve())


@pytest.mark.parametrize("fallback", ["geometry.h5m", "dagmc.h5m"])
def test_resolve_dagmc_path_fallback_names(tmp_path, fallback):
    """Common fallback names are tried when the referenced name is absent."""
    reference = tmp_path / "project"
    reference.mkdir()
    target = _write(reference, fallback, "fake")

    resolved = geometry._resolve_dagmc_path("missing.h5m", str(reference))

    assert resolved == str(target.resolve())


def test_resolve_dagmc_path_returns_first_candidate_when_nothing_exists(tmp_path):
    """When no file exists the first candidate is returned for a useful error."""
    resolved = geometry._resolve_dagmc_path("missing.h5m", str(tmp_path))

    assert resolved == str((tmp_path / "missing.h5m").resolve())


# ---------------------------------------------------------------------------
# convert_summary_to_xml DAGMC re-anchoring
# ---------------------------------------------------------------------------


def _fake_summary_openmc(geometry_xml):
    """Fake openmc.Summary exporting a fixed geometry.xml and no materials."""
    fake = types.ModuleType("openmc")

    class _Geometry:
        def export_to_xml(self, path):
            with open(path, "w") as handle:
                handle.write(geometry_xml)

    fake.Summary = lambda path: types.SimpleNamespace(geometry=_Geometry(), materials=None)
    return fake


def test_convert_summary_reanchors_relative_dagmc_filename(tmp_path, monkeypatch):
    """The converted XML points at the original project's DAGMC file."""
    project = tmp_path / "project"
    project.mkdir()
    target = _write(project, "model.h5m", "fake")
    summary = _write(project, "summary.h5", "fake")
    geometry_xml = DAGMC_GEOMETRY.format(filename="model.h5m")
    monkeypatch.setitem(sys.modules, "openmc", _fake_summary_openmc(geometry_xml))

    out_dir = geometry.convert_summary_to_xml(str(summary), str(tmp_path / "out"))

    converted = (tmp_path / "out" / "geometry.xml").read_text()
    assert out_dir == str(tmp_path / "out")
    assert str(target.resolve()) in converted


def test_convert_summary_survives_reanchoring_failure(tmp_path, monkeypatch):
    """A re-anchoring failure leaves the converted geometry.xml untouched."""
    summary = _write(tmp_path, "summary.h5", "fake")
    geometry_xml = DAGMC_GEOMETRY.format(filename="model.h5m")
    monkeypatch.setitem(sys.modules, "openmc", _fake_summary_openmc(geometry_xml))

    def _explode(_path):
        raise RuntimeError("cannot re-read geometry.xml")

    monkeypatch.setattr(geometry.ET, "parse", _explode)

    out_dir = geometry.convert_summary_to_xml(str(summary), str(tmp_path / "out"))

    assert out_dir == str(tmp_path / "out")
    assert (tmp_path / "out" / "geometry.xml").read_text() == geometry_xml
