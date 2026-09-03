"""Tests for the nuke-cad geometry service."""

import json
import math
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

    # Every tessellated face carries a geometric fingerprint for toponaming.
    for solid in tess_data["solids"]:
        for face in solid["faces"]:
            fp = face.get("fingerprint")
            assert fp is not None, f"face {face['faceId']} missing fingerprint"
            assert fp["surfaceType"] == "plane"
            assert "area" in fp
            assert "center" in fp
            assert len(fp["center"]) == 3

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


def _rect_sketch_for_doc(width: float = 40.0, height: float = 20.0) -> dict:
    return {
        "id": "rect",
        "name": "rectangle",
        "datumId": "dxy",
        "primitives": [
            {"id": "p1", "type": "point", "x": 0, "y": 0},
            {"id": "p2", "type": "point", "x": width, "y": 0},
            {"id": "p3", "type": "point", "x": width, "y": height},
            {"id": "p4", "type": "point", "x": 0, "y": height},
            {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
            {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
            {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
            {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
        ],
        "constraints": [],
    }


def _circle_sketch_for_doc(x: float, y: float, radius: float, sid: str) -> dict:
    return {
        "id": sid,
        "name": sid,
        "datumId": "dxy",
        "primitives": [
            {"id": "c", "type": "point", "x": x, "y": y},
            {"id": "circ", "type": "circle", "c_id": "c", "radius": radius},
        ],
        "constraints": [],
    }


def _write_pincell_document(path: Path) -> None:
    doc = {
        "version": 2,
        "name": "pincell",
        "parameters": {},
        "datums": [{"id": "dxy", "kind": "XY", "name": "XY"}],
        "bodies": [
            {"id": "body-clad", "name": "clad", "label": "clad"},
            {"id": "body-fuel", "name": "fuel", "label": "fuel"},
        ],
        "sketches": [
            _rect_sketch_for_doc(),
            _circle_sketch_for_doc(60, 10, 5, "fuel"),
        ],
        "features": [
            {
                "id": "clad",
                "name": "clad",
                "type": "pad",
                "body": "body-clad",
                "sketchId": "rect",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "fuel",
                "name": "fuel",
                "type": "pad",
                "body": "body-fuel",
                "sketchId": "fuel",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
            },
        ],
    }
    path.write_text(json.dumps(doc), encoding="utf-8")


def test_build_document_missing_file_returns_error(tmp_path: Path) -> None:
    result = geometry_service.build_document(str(tmp_path / "missing.nuke-cad"))
    assert result["success"] is False
    assert "Document not found" in result["error"]


def test_build_document_pincell(tmp_path: Path) -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    doc_path = tmp_path / "pincell.nuke-cad"
    _write_pincell_document(doc_path)
    result = geometry_service.build_document(
        str(doc_path),
        output_dir=str(tmp_path),
        export_dagmc=False,
        export_mesh=False,
    )
    assert result["success"] is True, result.get("error", "")
    assert result["solidCount"] == 2
    assert Path(result["stepPath"]).exists()
    assert Path(result["tessPath"]).exists()
    assert result["selectorMap"] == {"clad": [1], "fuel": [2]}
    assert len(result["featureResults"]) == 2
    assert all(r["status"] == "built" for r in result["featureResults"])


def test_build_document_manifest_flow_to_dagmc_groups(tmp_path: Path) -> None:
    """End-to-end: document labels -> selector map -> manifest -> mat:<name> groups."""
    pytest.importorskip("build123d", reason="build123d not installed")
    pytest.importorskip("gmsh", reason="gmsh not installed")
    pytest.importorskip("pymoab", reason="pymoab not installed")
    from pymoab import core as moab_core
    from pymoab import types as moab_types

    doc_path = tmp_path / "pincell.nuke-cad"
    _write_pincell_document(doc_path)
    manifest = tmp_path / "pincell.regions.json"
    manifest.write_text(
        json.dumps(
            {
                "version": 1,
                "volumes": [
                    {"selector": "clad", "name": "clad_region", "material": "mat1"},
                    {"selector": "fuel", "name": "fuel_region", "material": "mat2"},
                ],
            }
        ),
        encoding="utf-8",
    )
    result = geometry_service.build_document(
        str(doc_path),
        output_dir=str(tmp_path),
        export_dagmc=True,
        export_mesh=False,
        add_graveyard=False,
        tolerance=1.0,
    )
    assert result["success"] is True, result.get("error", "")
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
    assert "mat:clad_region" in group_names
    assert "mat:fuel_region" in group_names


def test_protocol_marker_prefixes_child_output(tmp_path: Path) -> None:
    """The child process must prefix the JSON result with __NUKE_RESULT__."""
    script = tmp_path / "no_model.py"
    script.write_text("x = 1\n")
    result = geometry_service.build_geometry(str(script))
    assert result["success"] is False
    assert "did not define a top-level 'model'" in result["error"]


def test_protocol_marker_ignores_unmarked_json(tmp_path: Path) -> None:
    """Lines that are JSON but lack the protocol marker must not be parsed as results."""
    script = tmp_path / "noisy_json.py"
    script.write_text('print(\'{"success": true, "solidCount": 99}\')\n')
    result = geometry_service.build_geometry(str(script))
    assert result["success"] is False
    assert "did not define a top-level 'model'" in result["error"]


def _write_minimal_document(path: Path) -> None:
    doc = {
        "version": 2,
        "name": "minimal",
        "parameters": {},
        "datums": [{"id": "dxy", "kind": "XY", "name": "XY"}],
        "bodies": [{"id": "body-1", "name": "Body 1"}],
        "sketches": [_rect_sketch_for_doc()],
        "features": [
            {
                "id": "pad1",
                "name": "pad1",
                "type": "pad",
                "body": "body-1",
                "sketchId": "rect",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
            }
        ],
    }
    path.write_text(json.dumps(doc), encoding="utf-8")


def test_build_document_rejects_unsupported_feature_type(tmp_path: Path) -> None:
    doc_path = tmp_path / "bad.nuke-cad"
    _write_minimal_document(doc_path)
    doc = json.loads(doc_path.read_text())
    doc["features"][0]["type"] = "thread"
    doc_path.write_text(json.dumps(doc), encoding="utf-8")
    result = geometry_service.build_document(str(doc_path), output_dir=str(tmp_path))
    assert result["success"] is False
    assert "unsupported type 'thread'" in result["error"]


def test_build_document_rejects_missing_sketch_id(tmp_path: Path) -> None:
    doc_path = tmp_path / "bad.nuke-cad"
    _write_minimal_document(doc_path)
    doc = json.loads(doc_path.read_text())
    doc["features"][0]["sketchId"] = None
    doc_path.write_text(json.dumps(doc), encoding="utf-8")
    result = geometry_service.build_document(str(doc_path), output_dir=str(tmp_path))
    assert result["success"] is False
    assert "requires a sketchId" in result["error"]


def test_build_document_rejects_non_positive_length(tmp_path: Path) -> None:
    doc_path = tmp_path / "bad.nuke-cad"
    _write_minimal_document(doc_path)
    doc = json.loads(doc_path.read_text())
    doc["features"][0]["params"]["length"] = -5
    doc_path.write_text(json.dumps(doc), encoding="utf-8")
    result = geometry_service.build_document(str(doc_path), output_dir=str(tmp_path))
    assert result["success"] is False
    assert "positive length" in result["error"]


def test_build_document_rejects_sweep_without_path_curve(tmp_path: Path) -> None:
    doc_path = tmp_path / "bad.nuke-cad"
    _write_minimal_document(doc_path)
    doc = json.loads(doc_path.read_text())
    doc["features"][0] = {
        "id": "sw1",
        "name": "sw1",
        "type": "sweep",
        "body": "body-1",
        "sketchId": "rect",
        "params": {"orientation": "frenet"},
        "dependsOn": [],
        "suppressed": False,
    }
    doc_path.write_text(json.dumps(doc), encoding="utf-8")
    result = geometry_service.build_document(str(doc_path), output_dir=str(tmp_path))
    assert result["success"] is False
    assert "requires a pathCurveId" in result["error"]


def test_build_document_rejects_sweep_unknown_path_curve(tmp_path: Path) -> None:
    doc_path = tmp_path / "bad.nuke-cad"
    _write_minimal_document(doc_path)
    doc = json.loads(doc_path.read_text())
    doc["features"][0] = {
        "id": "sw1",
        "name": "sw1",
        "type": "sweep",
        "body": "body-1",
        "sketchId": "rect",
        "params": {"pathCurveId": "nope", "orientation": "frenet"},
        "dependsOn": [],
        "suppressed": False,
    }
    doc_path.write_text(json.dumps(doc), encoding="utf-8")
    result = geometry_service.build_document(str(doc_path), output_dir=str(tmp_path))
    assert result["success"] is False
    assert "references unknown curve 'nope'" in result["error"]


def test_build_document_pipe_does_not_require_sketch(tmp_path: Path) -> None:
    """Pipe validation checks the path curve, not a sketch (pipe has no sketchId)."""
    doc_path = tmp_path / "bad.nuke-cad"
    _write_minimal_document(doc_path)
    doc = json.loads(doc_path.read_text())
    doc["features"][0] = {
        "id": "p1",
        "name": "p1",
        "type": "pipe",
        "body": "body-1",
        "params": {"pathCurveId": "nope", "radius": 2.0, "orientation": "frenet"},
        "dependsOn": [],
        "suppressed": False,
    }
    doc_path.write_text(json.dumps(doc), encoding="utf-8")
    result = geometry_service.build_document(str(doc_path), output_dir=str(tmp_path))
    assert result["success"] is False
    # The path-curve check fires; the sketch gate is not hit for pipes.
    assert "references unknown curve 'nope'" in result["error"]
    assert "sketchId" not in result["error"]


def test_build_document_rejects_pipe_non_positive_radius(tmp_path: Path) -> None:
    doc_path = tmp_path / "bad.nuke-cad"
    _write_minimal_document(doc_path)
    doc = json.loads(doc_path.read_text())
    doc["version"] = 3
    doc["features"][0] = {
        "id": "p1",
        "name": "p1",
        "type": "pipe",
        "body": "body-1",
        "params": {"pathCurveId": "arc", "radius": 0, "orientation": "frenet"},
        "dependsOn": [],
        "suppressed": False,
    }
    doc["curves"] = [
        {
            "id": "arc",
            "name": "arc",
            "source": {"kind": "points"},
            "samples": [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]],
        }
    ]
    doc_path.write_text(json.dumps(doc), encoding="utf-8")
    result = geometry_service.build_document(str(doc_path), output_dir=str(tmp_path))
    assert result["success"] is False
    assert "pipe) requires a positive radius" in result["error"]


def _add_second_sketch(doc: dict, sketch_id: str = "rect-2") -> dict:
    """Clone the minimal document's rect sketch under a second id."""
    rect = next(s for s in doc["sketches"] if s["id"] == "rect")
    second = json.loads(json.dumps(rect))
    second["id"] = sketch_id
    second["name"] = sketch_id
    doc["sketches"].append(second)
    return doc


def test_build_document_rejects_loft_without_sections(tmp_path: Path) -> None:
    doc_path = tmp_path / "bad.nuke-cad"
    _write_minimal_document(doc_path)
    doc = json.loads(doc_path.read_text())
    doc["features"][0] = {
        "id": "l1",
        "name": "l1",
        "type": "loft",
        "body": "body-1",
        "params": {"sectionSketchIds": ["rect"], "ruled": False},
        "dependsOn": [],
        "suppressed": False,
    }
    doc_path.write_text(json.dumps(doc), encoding="utf-8")
    result = geometry_service.build_document(str(doc_path), output_dir=str(tmp_path))
    assert result["success"] is False
    assert "loft) requires at least 2 section sketches" in result["error"]


def test_build_document_rejects_loft_unknown_section_sketch(tmp_path: Path) -> None:
    doc_path = tmp_path / "bad.nuke-cad"
    _write_minimal_document(doc_path)
    doc = _add_second_sketch(json.loads(doc_path.read_text()))
    doc["features"][0] = {
        "id": "l1",
        "name": "l1",
        "type": "loft",
        "body": "body-1",
        "params": {"sectionSketchIds": ["rect", "nope"], "ruled": False},
        "dependsOn": [],
        "suppressed": False,
    }
    doc_path.write_text(json.dumps(doc), encoding="utf-8")
    result = geometry_service.build_document(str(doc_path), output_dir=str(tmp_path))
    assert result["success"] is False
    assert "references unknown sketch 'nope'" in result["error"]


def test_build_document_rejects_helical_sweep_missing_sketch(tmp_path: Path) -> None:
    doc_path = tmp_path / "bad.nuke-cad"
    _write_minimal_document(doc_path)
    doc = json.loads(doc_path.read_text())
    doc["features"][0] = {
        "id": "h1",
        "name": "h1",
        "type": "helicalSweep",
        "body": "body-1",
        "params": {"axis": "Z", "startRadius": 20.0, "pitch": 5.0, "turns": 3.0},
        "dependsOn": [],
        "suppressed": False,
    }
    doc_path.write_text(json.dumps(doc), encoding="utf-8")
    result = geometry_service.build_document(str(doc_path), output_dir=str(tmp_path))
    assert result["success"] is False
    assert "helicalSweep) requires a sketchId" in result["error"]


def test_build_document_rejects_helical_sweep_bad_params(tmp_path: Path) -> None:
    doc_path = tmp_path / "bad.nuke-cad"
    _write_minimal_document(doc_path)
    doc = json.loads(doc_path.read_text())
    doc["features"][0] = {
        "id": "h1",
        "name": "h1",
        "type": "helicalSweep",
        "body": "body-1",
        "sketchId": "rect",
        "params": {"axis": "z", "startRadius": 20.0, "pitch": 5.0, "turns": 3.0},
        "dependsOn": [],
        "suppressed": False,
    }
    doc_path.write_text(json.dumps(doc), encoding="utf-8")
    result = geometry_service.build_document(str(doc_path), output_dir=str(tmp_path))
    assert result["success"] is False
    assert "helicalSweep) requires axis 'X', 'Y', or 'Z'" in result["error"]

    doc = json.loads(doc_path.read_text())
    doc["features"][0]["params"] = {
        "axis": "Z",
        "startRadius": 20.0,
        "pitch": -5.0,
        "turns": 3.0,
    }
    doc_path.write_text(json.dumps(doc), encoding="utf-8")
    result = geometry_service.build_document(str(doc_path), output_dir=str(tmp_path))
    assert result["success"] is False
    assert "helicalSweep) requires a positive pitch" in result["error"]


def test_build_document_sweep_and_pipe_build(tmp_path: Path) -> None:
    """Full profile: curves build before features and feed sweep/pipe path wires."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc_path = tmp_path / "sweep_pipe.nuke-cad"
    _write_minimal_document(doc_path)
    doc = json.loads(doc_path.read_text())
    doc["version"] = 3
    arc = [
        [50.0 * math.cos(math.pi * i / 32), 50.0 * math.sin(math.pi * i / 32), 0.0]
        for i in range(33)
    ]
    doc["curves"] = [{"id": "arc", "name": "arc", "source": {"kind": "points"}, "samples": arc}]
    doc["features"] = [
        {
            "id": "sw1",
            "name": "sw1",
            "type": "sweep",
            "body": "body-1",
            "sketchId": "rect",
            "params": {"pathCurveId": "arc", "orientation": "frenet"},
            "dependsOn": [],
            "suppressed": False,
        },
        {
            "id": "p1",
            "name": "p1",
            "type": "pipe",
            "body": "body-2",
            "params": {"pathCurveId": "arc", "radius": 2.0, "orientation": "frenet"},
            "dependsOn": [],
            "suppressed": False,
        },
    ]
    doc["bodies"].append({"id": "body-2", "name": "Body 2"})
    doc_path.write_text(json.dumps(doc), encoding="utf-8")
    result = geometry_service.build_document(
        str(doc_path), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert result["success"] is True, result.get("error")
    by_id = {r["featureId"]: r for r in result.get("featureResults", [])}
    assert by_id["sw1"]["status"] == "built"
    assert by_id["p1"]["status"] == "built"
    # The viewport reads the curves stream from the tessellation artifact.
    tess = json.loads(Path(result["tessPath"]).read_text(encoding="utf-8"))
    assert len(tess.get("curves", [])) == 1


def test_build_document_rejects_revolve_axis_out_of_plane(tmp_path: Path) -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    doc_path = tmp_path / "bad.nuke-cad"
    _write_minimal_document(doc_path)
    doc = json.loads(doc_path.read_text())
    doc["features"][0] = {
        "id": "rev1",
        "name": "rev1",
        "type": "revolve",
        "body": "body-1",
        "sketchId": "rect",
        "params": {"axis": "z", "angle": 360},
        "dependsOn": [],
        "suppressed": False,
    }
    doc_path.write_text(json.dumps(doc), encoding="utf-8")
    result = geometry_service.build_document(str(doc_path), output_dir=str(tmp_path))
    # This reaches the Python builder; it should fail cleanly rather than crash.
    assert result["success"] is False
    by_id = {r["featureId"]: r for r in result.get("featureResults", [])}
    assert by_id["rev1"]["status"] == "failed"
    assert "sketch plane" in by_id["rev1"]["error"].lower()


def test_build_document_with_face_datum_and_external_refs(tmp_path: Path) -> None:
    """End-to-end: face datums and externalRefs resolve and report status."""
    pytest.importorskip("build123d", reason="build123d not installed")
    import feature_builder as fb
    import reference_resolver as rr

    # Build a base pad and capture its top face.
    base_doc = {
        "version": 2,
        "name": "base",
        "parameters": {},
        "datums": [{"id": "dxy", "kind": "XY", "name": "XY"}],
        "bodies": [{"id": "body-base", "name": "base"}],
        "sketches": [_rect_sketch_for_doc()],
        "features": [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "body": "body-base",
                "sketchId": "rect",
                "params": {"length": 5},
                "dependsOn": [],
                "suppressed": False,
            }
        ],
    }
    base_result = fb.build_document_shape(base_doc)
    assert base_result["shape"] is not None

    faces = rr.extract_face_fingerprints(base_result["shape"].wrapped)
    import numpy as np

    top_faces = [
        f
        for f in faces
        if f.surface_type == "plane" and f.normal is not None and np.isclose(f.normal[2], 1.0)
    ]
    assert len(top_faces) == 1
    top_ref = {"featureId": "base", "kind": "face", "fingerprint": top_faces[0].to_dict()}

    # Use one of the vertical edges as external geometry.
    edges = rr.extract_edge_fingerprints(base_result["shape"].wrapped)
    vertical_edges = [
        e
        for e in edges
        if e.curve_type == "line"
        and np.isclose(e.length, 5.0)
        and np.isclose(abs(e.start[2] - e.end[2]), 5.0)
    ]
    assert len(vertical_edges) >= 1
    edge_ref = {"featureId": "base", "kind": "edge", "fingerprint": vertical_edges[0].to_dict()}

    doc = {
        "version": 2,
        "name": "refs",
        "parameters": {},
        "datums": [
            {"id": "dxy", "kind": "XY", "name": "XY"},
            {"id": "face", "kind": "face", "name": "Top face", "reference": top_ref},
        ],
        "bodies": [{"id": "body-base", "name": "base"}],
        "sketches": [
            _rect_sketch_for_doc(),
            {
                "id": "top",
                "name": "top",
                "datumId": "face",
                "externalRefs": [edge_ref],
                "primitives": [
                    {"id": "p1", "type": "point", "x": 0, "y": 0},
                    {"id": "p2", "type": "point", "x": 5, "y": 0},
                    {"id": "p3", "type": "point", "x": 5, "y": 5},
                    {"id": "p4", "type": "point", "x": 0, "y": 5},
                    {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
                    {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
                    {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
                    {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
                ],
                "constraints": [],
            },
        ],
        "features": [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "body": "body-base",
                "sketchId": "rect",
                "params": {"length": 5},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "top",
                "name": "top",
                "type": "pad",
                "body": "body-base",
                "sketchId": "top",
                "params": {"length": 2},
                "dependsOn": ["base"],
                "suppressed": False,
            },
        ],
    }
    doc_path = tmp_path / "refs.nuke-cad"
    doc_path.write_text(json.dumps(doc), encoding="utf-8")
    result = geometry_service.build_document(
        str(doc_path), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert result["success"] is True, result.get("error", "")
    assert result["solidCount"] == 2
    assert all(r["status"] == "built" for r in result.get("featureResults", []))

    ref_results = result.get("referenceResults", [])
    assert len(ref_results) == 2
    by_path = {r["path"]: r for r in ref_results}
    assert by_path["datum.face.reference"]["status"] == "matched"
    assert by_path["datum.face.reference"]["featureId"] == "top"
    assert by_path["sketch.top.externalRefs[0]"]["status"] == "matched"
    assert by_path["sketch.top.externalRefs[0]"]["featureId"] == "top"


def _load_tess_solids(result: dict) -> list[dict]:
    tess_data = json.loads(Path(result["tessPath"]).read_text())
    return tess_data["solids"]


def _assert_properties_shape(props: dict) -> None:
    assert set(props.keys()) == {"volume", "area", "bbox", "centerOfMass"}
    assert isinstance(props["volume"], float)
    assert isinstance(props["area"], float)
    assert set(props["bbox"].keys()) == {"min", "max"}
    for point in (props["bbox"]["min"], props["bbox"]["max"], props["centerOfMass"]):
        assert isinstance(point, list)
        assert len(point) == 3
        assert all(isinstance(v, float) for v in point)


def test_solid_properties_unit_cube(tmp_path: Path) -> None:
    """A unit cube reports exact mass properties on every solid."""
    pytest.importorskip("build123d", reason="build123d not installed")
    script = tmp_path / "cube.py"
    script.write_text("from build123d import *\nmodel = Box(1, 1, 1)\n")
    result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert result["success"] is True, result.get("error", "")
    solids = _load_tess_solids(result)
    assert len(solids) == 1
    for solid in solids:
        props = solid.get("properties")
        assert props is not None, f"solid {solid['solidId']} missing properties"
        _assert_properties_shape(props)
        assert props["volume"] == pytest.approx(1.0)
        assert props["area"] == pytest.approx(6.0)
        assert props["bbox"]["min"] == pytest.approx([-0.5, -0.5, -0.5])
        assert props["bbox"]["max"] == pytest.approx([0.5, 0.5, 0.5])
        assert props["centerOfMass"] == pytest.approx([0.0, 0.0, 0.0])


def test_solid_properties_cylinder(tmp_path: Path) -> None:
    """A cylinder matches the analytic V = pi r^2 h and A = 2 pi r h + 2 pi r^2."""
    pytest.importorskip("build123d", reason="build123d not installed")
    script = tmp_path / "cyl.py"
    script.write_text("from build123d import *\nmodel = Cylinder(2, 10)\n")
    result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert result["success"] is True, result.get("error", "")
    solids = _load_tess_solids(result)
    assert len(solids) == 1
    props = solids[0].get("properties")
    assert props is not None, "solid missing properties"
    _assert_properties_shape(props)
    assert props["volume"] == pytest.approx(math.pi * 2 * 2 * 10, rel=1e-6)
    assert props["area"] == pytest.approx(2 * math.pi * 2 * 10 + 2 * math.pi * 2 * 2, rel=1e-6)
    # Curved-face bboxes come from the triangulation, so allow mesh-level slack.
    assert props["bbox"]["min"] == pytest.approx([-2.0, -2.0, -5.0], abs=1e-3)
    assert props["bbox"]["max"] == pytest.approx([2.0, 2.0, 5.0], abs=1e-3)
    assert props["centerOfMass"] == pytest.approx([0.0, 0.0, 0.0])


def test_solid_properties_present_on_every_solid_in_compound(tmp_path: Path) -> None:
    """Every solid of a multi-solid compound carries its own properties dict."""
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
    result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert result["success"] is True, result.get("error", "")
    solids = _load_tess_solids(result)
    assert len(solids) == 2
    by_id = {solid["solidId"]: solid.get("properties") for solid in solids}
    for solid_id, props in by_id.items():
        assert props is not None, f"solid {solid_id} missing properties"
        _assert_properties_shape(props)
        assert props["volume"] == pytest.approx(1000.0)
    assert by_id[1]["centerOfMass"] == pytest.approx([0.0, 0.0, 0.0])
    assert by_id[2]["centerOfMass"] == pytest.approx([10.0, 0.0, 0.0])
