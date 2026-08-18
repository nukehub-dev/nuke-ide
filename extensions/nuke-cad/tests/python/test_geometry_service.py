"""Tests for the nuke-cad geometry service."""

import json
from pathlib import Path

import geometry_service
import pytest


def _require_cadquery():
    """Skip unless a *working* cadquery is installed (a broken install that
    imports but lacks Workplane — e.g. an ABI-broken env — must skip, not fail)."""
    cq = pytest.importorskip("cadquery", reason="cadquery not installed")
    if not hasattr(cq, "Workplane"):
        pytest.skip("cadquery install is broken (no Workplane attribute)")
    return cq


def test_missing_script_returns_error(tmp_path: Path) -> None:
    result = geometry_service.build_geometry(str(tmp_path / "missing.py"))
    assert result["success"] is False
    assert "Script not found" in result["error"]


def test_script_without_model_returns_error(tmp_path: Path) -> None:
    script = tmp_path / "no_model.py"
    script.write_text("x = 1\n")
    result = geometry_service.build_geometry(str(script))
    assert result["success"] is False
    assert "did not define a top-level 'model'" in result["error"]


def test_sys_exit_in_script_is_reported_not_fatal(tmp_path: Path) -> None:
    """sys.exit() in a user script must not kill the service; it is an error result."""
    script = tmp_path / "bail.py"
    script.write_text("import sys\nsys.exit(3)\n")
    result = geometry_service.build_geometry(str(script))
    assert result["success"] is False
    assert "sys.exit(3)" in result["error"]


def test_script_timeout_is_reported(tmp_path: Path) -> None:
    """A hung user script is killed after the timeout and reported as an error."""
    script = tmp_path / "hang.py"
    script.write_text("import time\nwhile True:\n    time.sleep(0.1)\n")
    result = geometry_service.build_geometry(str(script), script_timeout=2.0)
    assert result["success"] is False
    assert "timed out" in result["error"]


def test_script_stdout_noise_does_not_corrupt_protocol(tmp_path: Path) -> None:
    """User prints on stdout must not break result parsing."""
    script = tmp_path / "noisy.py"
    script.write_text('print("hello from user script")\nprint({"not": "protocol"})\n')
    result = geometry_service.build_geometry(str(script))
    assert result["success"] is False
    assert "did not define a top-level 'model'" in result["error"]


def test_build_simple_build123d_box(tmp_path: Path) -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    script = tmp_path / "box.py"
    script.write_text("from build123d import *\nmodel = Box(10, 10, 10)\n")
    result = geometry_service.build_geometry(str(script), output_dir=str(tmp_path))
    assert result["success"] is True, result.get("error", "")
    assert result["solidCount"] == 1
    assert result["triangleCount"] > 0

    step_path = Path(result["stepPath"])
    tess_path = Path(result["tessPath"])
    assert step_path.exists()
    assert tess_path.exists()

    tess_data = json.loads(tess_path.read_text())
    assert tess_data["version"] == 1
    assert len(tess_data["solids"]) == 1

    # DAGMC export is attempted automatically when pymoab is available.
    h5m_path = Path(result["dagmcPath"])
    if result["dagmcSuccess"]:
        assert h5m_path.exists()
    elif result["dagmcError"]:
        assert "DAGMC export" in result["dagmcError"] or "pymoab" in result["dagmcError"].lower()


def test_region_manifest_warning_for_unknown_selector(tmp_path: Path) -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    script = tmp_path / "box.py"
    script.write_text("from build123d import *\nmodel = Box(10, 10, 10)\n")
    manifest = tmp_path / "box.regions.json"
    manifest.write_text(
        json.dumps(
            {
                "version": 1,
                "volumes": [{"selector": "nonexistent", "name": "x", "material": "M"}],
            }
        )
    )
    result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert result["success"] is True
    assert any("unknown selectors" in w.lower() for w in (result.get("warnings") or []))


def test_labeled_compound_selector_map(tmp_path: Path) -> None:
    """build123d labels on Compound children resolve to 1-based solid indices."""
    pytest.importorskip("build123d", reason="build123d not installed")
    script = tmp_path / "boxes.py"
    script.write_text(
        "from build123d import *\n"
        "box1 = Box(10, 10, 10)\n"
        "box1.label = 'left'\n"
        "box2 = Pos(10, 0, 0) * Box(10, 10, 10)\n"
        "box2.label = 'right'\n"
        "model = Compound(children=[box1, box2])\n"
    )
    manifest = tmp_path / "boxes.regions.json"
    manifest.write_text(
        json.dumps(
            {
                "version": 1,
                "volumes": [
                    {"selector": "left", "name": "left_block", "material": "mat1"},
                    {"selector": "right", "name": "right_block", "material": "mat2"},
                ],
            }
        )
    )
    result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert result["success"] is True, result.get("error", "")
    assert result["selectorMap"] == {"left": [1], "right": [2]}
    assert not any("unknown selectors" in w.lower() for w in (result.get("warnings") or []))


def test_unsupported_build123d_type_error_reaches_user(tmp_path: Path) -> None:
    """A non-Part/Compound build123d model must produce a specific error."""
    pytest.importorskip("build123d", reason="build123d not installed")
    script = tmp_path / "sketch.py"
    script.write_text("from build123d import *\nmodel = Solid.make_box(5, 5, 5)\n")
    result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert result["success"] is False
    assert "Unsupported build123d model type" in result["error"]


_CADQUERY_ASSEMBLY_SCRIPT = (
    "import cadquery as cq\n"
    "assy = cq.Assembly()\n"
    "assy.add(cq.Workplane().box(5, 5, 5), name='fuel')\n"
    "assy.add(cq.Workplane().box(5, 5, 5), name='clad', loc=cq.Location((10, 0, 0)))\n"
    "model = assy\n"
)


def test_cadquery_workplane_build(tmp_path: Path) -> None:
    """A plain CadQuery Workplane builds with a positional (empty) selector map."""
    _require_cadquery()
    script = tmp_path / "box.py"
    script.write_text("import cadquery as cq\nmodel = cq.Workplane().box(10, 10, 10)\n")
    result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert result["success"] is True, result.get("error", "")
    assert result["solidCount"] == 1
    assert result["triangleCount"] > 0


def test_cadquery_workplane_multi_solid(tmp_path: Path) -> None:
    """A Workplane holding multiple separate solids must keep all of them."""
    _require_cadquery()
    script = tmp_path / "two.py"
    script.write_text(
        "import cadquery as cq\n"
        "model = cq.Workplane().add(cq.Workplane().box(5, 5, 5))"
        ".add(cq.Workplane().box(2, 2, 2).translate((10, 0, 0)))\n"
    )
    result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert result["success"] is True, result.get("error", "")
    assert result["solidCount"] == 2


def test_cadquery_assembly_selector_map(tmp_path: Path) -> None:
    """CadQuery Assembly part names resolve to 1-based solid indices."""
    _require_cadquery()
    script = tmp_path / "assy.py"
    script.write_text(_CADQUERY_ASSEMBLY_SCRIPT)
    manifest = tmp_path / "assy.regions.json"
    manifest.write_text(
        json.dumps(
            {
                "version": 1,
                "volumes": [
                    {"selector": "fuel", "name": "fuel_region", "material": "mat1"},
                    {"selector": "clad", "name": "clad_region", "material": "mat2"},
                    {"selector": "ghost", "name": "ghost_region", "material": "mat3"},
                ],
            }
        )
    )
    result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert result["success"] is True, result.get("error", "")
    assert result["solidCount"] == 2
    assert result["selectorMap"] == {"fuel": [1], "clad": [2]}
    warnings = [w.lower() for w in (result.get("warnings") or [])]
    assert any("unknown selectors" in w and "ghost" in w for w in warnings)


def test_cadquery_assembly_unnamed_part_is_skipped(tmp_path: Path) -> None:
    """Parts without a name (CadQuery auto-UUIDs) must not enter the selector map."""
    _require_cadquery()
    script = tmp_path / "partial.py"
    script.write_text(
        "import cadquery as cq\n"
        "assy = cq.Assembly()\n"
        "assy.add(cq.Workplane().box(5, 5, 5), name='named')\n"
        "assy.add(cq.Workplane().box(5, 5, 5), loc=cq.Location((10, 0, 0)))\n"
        "model = assy\n"
    )
    shape, selector_map, error = geometry_service._execute_script_isolated(script)
    assert error is None
    assert selector_map == {"named": [1]}


def test_cadquery_nested_assembly_selector_map(tmp_path: Path) -> None:
    """Nested assemblies resolve part names across the whole tree."""
    _require_cadquery()
    script = tmp_path / "nested.py"
    script.write_text(
        "import cadquery as cq\n"
        "inner = cq.Assembly(name='core')\n"
        "inner.add(cq.Workplane().box(2, 2, 2), name='pin', loc=cq.Location((0, 0, 10)))\n"
        "assy = cq.Assembly()\n"
        "assy.add(cq.Workplane().box(5, 5, 5), name='block')\n"
        "assy.add(inner, loc=cq.Location((0, 20, 0)))\n"
        "model = assy\n"
    )
    result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert result["success"] is True, result.get("error", "")
    assert result["solidCount"] == 2

    shape, selector_map, error = geometry_service._execute_script_isolated(script)
    assert error is None
    assert selector_map == {"block": [1], "pin": [2]}


def test_cadquery_assembly_manifest_resolves_to_groups(tmp_path: Path) -> None:
    """End-to-end: assembly part names -> selector map -> manifest -> mat:<name> groups."""
    _require_cadquery()
    pytest.importorskip("gmsh", reason="gmsh not installed")
    pytest.importorskip("pymoab", reason="pymoab not installed")
    from pymoab import core as moab_core
    from pymoab import types as moab_types

    script = tmp_path / "assy.py"
    script.write_text(_CADQUERY_ASSEMBLY_SCRIPT)
    manifest = tmp_path / "assy.regions.json"
    manifest.write_text(
        json.dumps(
            {
                "version": 1,
                "volumes": [
                    {"selector": "fuel", "name": "fuel_region", "material": "mat1"},
                    {"selector": "clad", "name": "clad_region", "material": "mat2"},
                ],
            }
        )
    )
    result = geometry_service.build_geometry(
        str(script),
        output_dir=str(tmp_path),
        export_dagmc=True,
        export_mesh=False,
        add_graveyard=False,
        tolerance=1.0,
    )
    assert result["success"] is True, result.get("error", "")
    assert result["selectorMap"] == {"fuel": [1], "clad": [2]}
    assert result["dagmcSuccess"] is True, result.get("dagmcError", "")

    mb = moab_core.Core()
    mb.load_file(result["dagmcPath"])
    cat_tag = mb.tag_get_handle(moab_types.CATEGORY_TAG_NAME)
    name_tag = mb.tag_get_handle(moab_types.NAME_TAG_NAME)
    gdim_tag = mb.tag_get_handle(moab_types.GEOM_DIMENSION_TAG_NAME)
    groups = mb.get_entities_by_type_and_tag(
        mb.get_root_set(), moab_types.MBENTITYSET, [cat_tag], ["Group"]
    )
    group_names = set()
    for gset in groups:
        if mb.tag_get_data(gdim_tag, gset)[0][0] != 4:
            continue
        raw_name = mb.tag_get_data(name_tag, gset)[0][0]
        group_names.add(raw_name.decode("utf-8") if isinstance(raw_name, bytes) else str(raw_name))
    assert "mat:fuel_region" in group_names
    assert "mat:clad_region" in group_names


def test_import_step_file(tmp_path: Path) -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    script = tmp_path / "box.py"
    script.write_text("from build123d import *\nmodel = Box(10, 10, 10)\n")
    build_result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert build_result["success"] is True, build_result.get("error", "")

    import_dir = tmp_path / "imported"
    import_dir.mkdir()
    result = geometry_service.import_step_file(build_result["stepPath"], output_dir=str(import_dir))
    assert result["success"] is True, result.get("error", "")
    assert result["solidCount"] == 1
    assert result["triangleCount"] > 0

    tess_path = Path(result["tessPath"])
    assert tess_path.exists()
    tess_data = json.loads(tess_path.read_text())
    assert len(tess_data["solids"]) == 1

    # STEP imports skip DAGMC/mesh export by default.
    assert result["dagmcSuccess"] is False
    assert Path(result["dagmcPath"]).exists() is False
    assert result["meshSuccess"] is False
    assert Path(result["meshPath"]).exists() is False


def test_import_step_file_export_opt_in(tmp_path: Path) -> None:
    """Explicitly requesting DAGMC export on a STEP import must produce the H5M."""
    pytest.importorskip("build123d", reason="build123d not installed")
    pytest.importorskip("gmsh", reason="gmsh not installed")
    pytest.importorskip("pymoab", reason="pymoab not installed")
    script = tmp_path / "box.py"
    script.write_text("from build123d import *\nmodel = Box(10, 10, 10)\n")
    build_result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert build_result["success"] is True, build_result.get("error", "")

    import_dir = tmp_path / "imported"
    import_dir.mkdir()
    result = geometry_service.import_step_file(
        build_result["stepPath"],
        output_dir=str(import_dir),
        export_dagmc=True,
        add_graveyard=False,
        tolerance=1.0,
    )
    assert result["success"] is True, result.get("error", "")
    assert result["dagmcSuccess"] is True, result.get("dagmcError", "")
    assert Path(result["dagmcPath"]).exists()
