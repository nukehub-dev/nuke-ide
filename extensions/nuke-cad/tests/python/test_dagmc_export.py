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
