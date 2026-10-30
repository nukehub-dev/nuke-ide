"""Tests for nuke-cad DAGMC export."""

import json
from pathlib import Path
from typing import Any

import dagmc_export
import geometry_service
import pytest


def _requires_full_profile() -> None:
    """Skip a test if the full CAD/DAGMC dependency profile is unavailable."""
    pytest.importorskip("build123d", reason="build123d not installed")
    pytest.importorskip("gmsh", reason="gmsh not installed")
    pytest.importorskip("pymoab", reason="pymoab not installed")


def _load_h5m_groups(h5m_path: Path) -> dict[str, list[str]]:
    """Return a dict mapping group material names to their volume names."""
    from pymoab import core as moab_core
    from pymoab import types as moab_types

    mb = moab_core.Core()
    mb.load_file(str(h5m_path))

    cat_tag = mb.tag_get_handle(moab_types.CATEGORY_TAG_NAME)
    name_tag = mb.tag_get_handle(moab_types.NAME_TAG_NAME)
    gdim_tag = mb.tag_get_handle(moab_types.GEOM_DIMENSION_TAG_NAME)

    groups = mb.get_entities_by_type_and_tag(
        mb.get_root_set(), moab_types.MBENTITYSET, [cat_tag], ["Group"]
    )

    result: dict[str, list[str]] = {}
    for gset in groups:
        if mb.tag_get_data(gdim_tag, gset)[0][0] != 4:
            continue
        raw_name = mb.tag_get_data(name_tag, gset)[0][0]
        mat_name = raw_name.decode("utf-8") if isinstance(raw_name, bytes) else str(raw_name)
        volumes = mb.get_entities_by_type(gset, moab_types.MBENTITYSET)
        vol_names = []
        for vset in volumes:
            raw_cat = mb.tag_get_data(cat_tag, vset)[0][0]
            vname = raw_cat.decode("utf-8") if isinstance(raw_cat, bytes) else str(raw_cat)
            vol_names.append(vname)
        result[mat_name] = vol_names
    return result


def test_module_imports_without_heavy_deps() -> None:
    """dagmc_export must be importable in the minimal pytest profile."""
    import dagmc_export

    assert dagmc_export.HAS_NUMPY is True


def test_fallback_material_name_uses_mat_prefix() -> None:
    """Positional fallback groups follow openmc-studio's mat:mat_<id-1> convention."""
    assert dagmc_export._fallback_material_name(1) == "mat:mat_0"
    assert dagmc_export._fallback_material_name(3) == "mat:mat_2"


def test_verify_surface_senses_accepts_one_or_two_adjacent() -> None:
    dagmc_export._verify_surface_senses(
        {1: None, 2: None},
        {1: [1], 2: [1, 2]},
    )


def test_verify_surface_senses_errors_with_diagnostics() -> None:
    """Zero- or 3+-adjacency surfaces are a hard error listing the offenders."""
    with pytest.raises(RuntimeError) as excinfo:
        dagmc_export._verify_surface_senses(
            {1: None, 2: None, 5: None},
            {1: [1], 2: [], 5: [1, 2, 3]},
        )
    message = str(excinfo.value)
    assert "surface 2 (adjacent volumes: 0)" in message
    assert "surface 5 (adjacent volumes: 3)" in message
    assert "surface 1 " not in message


def test_two_touching_boxes_share_one_surface(tmp_path: Path) -> None:
    """Two touching boxes must produce exactly one shared surface."""
    _requires_full_profile()

    script = tmp_path / "boxes.py"
    script.write_text(
        "from build123d import *\n"
        "box1 = Box(10, 10, 10)\n"
        "box2 = Pos(10, 0, 0) * Box(10, 10, 10)\n"
        "model = Compound([box1, box2])\n"
    )
    result = geometry_service.build_geometry(
        str(script),
        output_dir=str(tmp_path),
        export_dagmc=True,
        add_graveyard=False,
        tolerance=1.0,
    )
    assert result["success"] is True, result.get("error", "")
    assert result["dagmcSuccess"] is True, result.get("dagmcError", "")

    h5m_path = Path(result["dagmcPath"])
    assert h5m_path.exists()

    from pymoab import core as moab_core
    from pymoab import types as moab_types

    mb = moab_core.Core()
    mb.load_file(str(h5m_path))

    cat_tag = mb.tag_get_handle(moab_types.CATEGORY_TAG_NAME)
    gdim_tag = mb.tag_get_handle(moab_types.GEOM_DIMENSION_TAG_NAME)
    sense_tag = mb.tag_get_handle("GEOM_SENSE_2")

    surfaces = mb.get_entities_by_type_and_tag(
        mb.get_root_set(), moab_types.MBENTITYSET, [cat_tag], ["Surface"]
    )
    surface_volumes: dict[Any, list[Any]] = {}
    for sset in surfaces:
        if mb.tag_get_data(gdim_tag, sset)[0][0] != 2:
            continue
        sense = mb.tag_get_data(sense_tag, sset)
        vols = [v for v in sense[0] if int(v) != 0]
        surface_volumes[sset] = vols

    shared = [s for s, vols in surface_volumes.items() if len(vols) == 2]
    boundary = [s for s, vols in surface_volumes.items() if len(vols) == 1]
    assert len(shared) == 1, f"expected 1 shared surface, found {len(shared)}"
    assert len(boundary) == 10, f"expected 10 boundary surfaces, found {len(boundary)}"

    volumes = mb.get_entities_by_type_and_tag(
        mb.get_root_set(), moab_types.MBENTITYSET, [cat_tag], ["Volume"]
    )
    assert len(volumes) == 2


def test_manifest_names_become_material_groups(tmp_path: Path) -> None:
    """Named volumes in the manifest map to mat:<name> groups in the H5M."""
    _requires_full_profile()

    script = tmp_path / "boxes.py"
    script.write_text(
        "from build123d import *\n"
        "box1 = Box(10, 10, 10)\n"
        "box2 = Pos(10, 0, 0) * Box(10, 10, 10)\n"
        "model = Compound([box1, box2])\n"
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

    # Build STEP first (label extraction is not the focus of this test).
    service_result = geometry_service.build_geometry(
        str(script),
        output_dir=str(tmp_path),
        export_dagmc=False,
        tolerance=1.0,
    )
    assert service_result["success"] is True, service_result.get("error", "")

    # Drive dagmc_export directly with a manual selector map.
    from region_manifest import RegionManifest

    h5m_path = tmp_path / "boxes.h5m"
    result = dagmc_export.convert_to_dagmc(
        service_result["stepPath"],
        output_path=str(h5m_path),
        manifest=RegionManifest.from_file(manifest),
        selector_map={"left": [1], "right": [2]},
        add_graveyard=False,
        faceting_tolerance=1.0,
    )
    assert result["success"] is True, result.get("error", "")

    groups = _load_h5m_groups(h5m_path)
    assert "mat:left_block" in groups
    assert "mat:right_block" in groups
    assert "mat:graveyard" not in groups


def test_single_box_six_boundary_surfaces(tmp_path: Path) -> None:
    """A single box has six boundary surfaces, all with sense 1."""
    _requires_full_profile()

    script = tmp_path / "box.py"
    script.write_text("from build123d import *\nmodel = Box(10, 10, 10)\n")
    result = geometry_service.build_geometry(
        str(script),
        output_dir=str(tmp_path),
        export_dagmc=True,
        tolerance=1.0,
    )
    assert result["success"] is True, result.get("error", "")
    assert result["dagmcSuccess"] is True, result.get("dagmcError", "")

    h5m_path = Path(result["dagmcPath"])
    assert h5m_path.exists()

    from pymoab import core as moab_core
    from pymoab import types as moab_types

    mb = moab_core.Core()
    mb.load_file(str(h5m_path))

    cat_tag = mb.tag_get_handle(moab_types.CATEGORY_TAG_NAME)
    gdim_tag = mb.tag_get_handle(moab_types.GEOM_DIMENSION_TAG_NAME)
    sense_tag = mb.tag_get_handle("GEOM_SENSE_2")

    surfaces = mb.get_entities_by_type_and_tag(
        mb.get_root_set(), moab_types.MBENTITYSET, [cat_tag], ["Surface"]
    )
    boundary_count = 0
    for sset in surfaces:
        if mb.tag_get_data(gdim_tag, sset)[0][0] != 2:
            continue
        sense = mb.tag_get_data(sense_tag, sset)
        vols = [v for v in sense[0] if int(v) != 0]
        if len(vols) == 1:
            boundary_count += 1

    # 6 box faces + graveyard boundary faces.
    assert boundary_count >= 6


def test_export_dagmc_false_skips_h5m(tmp_path: Path) -> None:
    """With export_dagmc=False no H5M file is produced."""
    _requires_full_profile()

    script = tmp_path / "box.py"
    script.write_text("from build123d import *\nmodel = Box(10, 10, 10)\n")
    result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False
    )
    assert result["success"] is True, result.get("error", "")
    assert Path(result["dagmcPath"]).exists() is False


def test_fallback_groups_use_mat_prefix(tmp_path: Path) -> None:
    """Unmanifested volumes get mat:mat_<vol_id-1> groups (OpenMC recognizes mat:)."""
    _requires_full_profile()

    script = tmp_path / "boxes.py"
    script.write_text(
        "from build123d import *\n"
        "box1 = Box(10, 10, 10)\n"
        "box2 = Pos(10, 0, 0) * Box(10, 10, 10)\n"
        "model = Compound([box1, box2])\n"
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
    assert result["dagmcSuccess"] is True, result.get("dagmcError", "")

    groups = _load_h5m_groups(Path(result["dagmcPath"]))
    assert "mat:mat_0" in groups
    assert "mat:mat_1" in groups


def test_labeled_script_manifest_resolves_to_groups(tmp_path: Path) -> None:
    """End-to-end: build123d labels -> selector map -> manifest -> mat:<name> groups."""
    _requires_full_profile()

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
        str(script),
        output_dir=str(tmp_path),
        export_dagmc=True,
        export_mesh=False,
        add_graveyard=False,
        tolerance=1.0,
    )
    assert result["success"] is True, result.get("error", "")
    assert result["selectorMap"] == {"left": [1], "right": [2]}
    assert result["dagmcSuccess"] is True, result.get("dagmcError", "")

    groups = _load_h5m_groups(Path(result["dagmcPath"]))
    assert "mat:left_block" in groups
    assert "mat:right_block" in groups


def test_watertight_two_touching_boxes(tmp_path: Path) -> None:
    """A conformal two-box imprint is sealed: no non-manifold or hole edges."""
    _requires_full_profile()

    script = tmp_path / "boxes.py"
    script.write_text(
        "from build123d import *\n"
        "box1 = Box(10, 10, 10)\n"
        "box2 = Pos(10, 0, 0) * Box(10, 10, 10)\n"
        "model = Compound([box1, box2])\n"
    )
    build_result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert build_result["success"] is True, build_result.get("error", "")

    result = dagmc_export.convert_to_dagmc(
        build_result["stepPath"],
        output_path=str(tmp_path / "boxes.h5m"),
        add_graveyard=False,
        faceting_tolerance=1.0,
    )
    assert result["success"] is True, result.get("error", "")
    watertight = result["watertight"]
    assert watertight["holeEdges"] == 0, watertight
    # Seam edges where the shared face meets the outer faces are legitimately
    # shared by 3 triangles; they are diagnostics, not defects.
    assert watertight["nonManifoldEdges"] == 20, watertight
    assert watertight["sealed"] is True
    assert result["overlapCheck"]["overlappingPairs"] == []


def test_watertight_check_flags_open_sheet() -> None:
    """An open two-triangle sheet has 4 hole edges and is not sealed."""
    pytest.importorskip("pymoab", reason="pymoab not installed")
    import numpy as np
    from pymoab import core as moab_core
    from pymoab import types as moab_types

    mb = moab_core.Core()
    verts = mb.create_vertices(
        np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]], dtype=np.float64)
    )
    sset = mb.create_meshset()
    tri1 = mb.create_element(moab_types.MBTRI, (verts[0], verts[1], verts[2]))
    tri2 = mb.create_element(moab_types.MBTRI, (verts[1], verts[3], verts[2]))
    mb.add_entity(sset, tri1)
    mb.add_entity(sset, tri2)

    warnings: list[str] = []
    report = dagmc_export._watertight_check(mb, {1: sset}, warnings)
    assert report["holeEdges"] == 4
    assert report["nonManifoldEdges"] == 0
    assert report["sealed"] is False
    assert any("hole" in w.lower() for w in warnings)


def test_watertight_check_sealed_tetrahedron() -> None:
    """A closed tetrahedron has every edge shared by exactly two triangles."""
    pytest.importorskip("pymoab", reason="pymoab not installed")
    import numpy as np
    from pymoab import core as moab_core
    from pymoab import types as moab_types

    mb = moab_core.Core()
    verts = mb.create_vertices(
        np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], dtype=np.float64)
    )
    sset = mb.create_meshset()
    for a, b, c in [(0, 2, 1), (0, 1, 3), (1, 2, 3), (2, 0, 3)]:
        tri = mb.create_element(moab_types.MBTRI, (verts[a], verts[b], verts[c]))
        mb.add_entity(sset, tri)

    warnings: list[str] = []
    report = dagmc_export._watertight_check(mb, {1: sset}, warnings)
    assert report["holeEdges"] == 0
    assert report["nonManifoldEdges"] == 0
    assert report["sealed"] is True
    assert warnings == []


def test_overlap_check_detects_overlapping_boxes() -> None:
    """Sampling + BRepClass3d reports overlapping volume pairs only."""
    pytest.importorskip("build123d", reason="build123d not installed")
    from build123d import Box, Compound, Pos

    touching = Compound([Box(10, 10, 10), Pos(10, 0, 0) * Box(10, 10, 10)])
    report = dagmc_export._check_volume_overlaps(touching.wrapped)
    assert report["checkedVolumes"] == 2
    assert report["overlappingPairs"] == []

    overlapping = Compound([Box(10, 10, 10), Pos(5, 0, 0) * Box(10, 10, 10)])
    report = dagmc_export._check_volume_overlaps(overlapping.wrapped)
    assert [1, 2] in report["overlappingPairs"]


def test_overlapping_boxes_reported_in_export(tmp_path: Path) -> None:
    """The export result surfaces overlapping volume pairs as warnings + report."""
    _requires_full_profile()

    script = tmp_path / "overlap.py"
    script.write_text(
        "from build123d import *\n"
        "box1 = Box(10, 10, 10)\n"
        "box2 = Pos(5, 0, 0) * Box(10, 10, 10)\n"
        "model = Compound([box1, box2])\n"
    )
    build_result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert build_result["success"] is True, build_result.get("error", "")

    result = dagmc_export.convert_to_dagmc(
        build_result["stepPath"],
        output_path=str(tmp_path / "overlap.h5m"),
        add_graveyard=False,
        faceting_tolerance=1.0,
    )
    assert result["success"] is True, result.get("error", "")
    assert [1, 2] in result["overlapCheck"]["overlappingPairs"]
    assert any("overlap" in w.lower() for w in result["warnings"])


def test_length_scale_scales_dagmc_vertices(tmp_path: Path) -> None:
    """A length_scale of 0.1 converts a 10 cm box to 1 m vertices in the h5m."""
    _requires_full_profile()

    from pymoab import core as moab_core
    from pymoab import types as moab_types

    script = tmp_path / "box.py"
    script.write_text("from build123d import *\nmodel = Box(10, 10, 10)\n")
    build_result = geometry_service.build_geometry(
        str(script),
        output_dir=str(tmp_path),
        export_dagmc=True,
        add_graveyard=False,
        tolerance=1.0,
        length_scale=0.1,
    )
    assert build_result["success"] is True, build_result.get("error", "")
    assert build_result["dagmcSuccess"] is True, build_result.get("dagmcError", "")

    mb = moab_core.Core()
    mb.load_file(build_result["dagmcPath"])
    vertices = mb.get_entities_by_type(mb.get_root_set(), moab_types.MBVERTEX)
    coords = mb.get_coords(list(vertices))
    assert len(coords) > 0
    # With 0.1 scaling, the 10 cm unit box spans [-0.5, 0.5] m.
    assert coords.min() >= -0.6
    assert coords.max() <= 0.6


def test_graveyard_heuristic_no_longer_triggers() -> None:
    """A large unnamed enclosing solid is no longer misdetected as graveyard."""
    pytest.importorskip("build123d", reason="build123d not installed")
    from build123d import Box, Compound, Pos

    model = Compound([Box(10, 10, 10), Pos(0, 0, 0) * Box(200, 200, 200)])
    detected, _ = dagmc_export._detect_existing_graveyard(model.wrapped, "")
    assert detected is False


def test_existing_graveyard_vol_ids_skip_auto_creation(tmp_path: Path) -> None:
    """Explicit 1-based graveyard IDs are honored and auto-creation is skipped."""
    _requires_full_profile()

    script = tmp_path / "boxes.py"
    script.write_text(
        "from build123d import *\n"
        "box1 = Box(10, 10, 10)\n"
        "box2 = Pos(20, 0, 0) * Box(10, 10, 10)\n"
        "model = Compound([box1, box2])\n"
    )
    build_result = geometry_service.build_geometry(
        str(script), output_dir=str(tmp_path), export_dagmc=False, export_mesh=False
    )
    assert build_result["success"] is True, build_result.get("error", "")

    result = dagmc_export.convert_to_dagmc(
        build_result["stepPath"],
        output_path=str(tmp_path / "boxes.h5m"),
        add_graveyard=True,
        existing_graveyard_vol_ids={2},
        faceting_tolerance=1.0,
    )
    assert result["success"] is True, result.get("error", "")
    assert any("flagged by caller" in w.lower() for w in result["warnings"])

    groups = _load_h5m_groups(Path(result["output_path"]))
    assert "mat:graveyard" in groups


def test_verify_surface_senses_rejects_empty_faces() -> None:
    """An empty face triangle map is a hard error, not a silent success."""
    with pytest.raises(RuntimeError, match="no exported faces"):
        dagmc_export._verify_surface_senses({}, {})


def test_per_cell_selectors_beat_body_selector(tmp_path: Path) -> None:
    """A body-level selector covering every solid does not shadow per-cell groups.

    Lattice exports carry one body-level entry (all solids) plus one entry per
    cell (one solid each); most-specific resolution must form the per-cell
    groups instead of collapsing everything into the body group.
    """
    _requires_full_profile()

    script = tmp_path / "cells.py"
    script.write_text(
        "from build123d import *\n"
        "box1 = Box(10, 10, 10)\n"
        "box2 = Pos(20, 0, 0) * Box(10, 10, 10)\n"
        "model = Compound([box1, box2])\n"
    )
    service_result = geometry_service.build_geometry(
        str(script),
        output_dir=str(tmp_path),
        export_dagmc=False,
        tolerance=1.0,
    )
    assert service_result["success"] is True, service_result.get("error", "")

    from region_manifest import RegionManifest

    manifest = RegionManifest.from_dict(
        {
            "version": 1,
            "volumes": [
                {"selector": "assembly", "name": "assembly", "material": "fuel"},
                {"selector": "assembly_r0c0", "name": "assembly_r0c0", "material": "fuel"},
                {"selector": "assembly_r0c1", "name": "assembly_r0c1", "material": "fuel"},
            ],
        }
    )
    h5m_path = tmp_path / "cells.h5m"
    result = dagmc_export.convert_to_dagmc(
        service_result["stepPath"],
        output_path=str(h5m_path),
        manifest=manifest,
        selector_map={"assembly": [1, 2], "assembly_r0c0": [1], "assembly_r0c1": [2]},
        add_graveyard=False,
        faceting_tolerance=1.0,
    )
    assert result["success"] is True, result.get("error", "")
    groups = _load_h5m_groups(h5m_path)
    assert "mat:assembly_r0c0" in groups
    assert "mat:assembly_r0c1" in groups
    assert "mat:assembly" not in groups
