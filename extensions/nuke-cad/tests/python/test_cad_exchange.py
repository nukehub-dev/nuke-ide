"""Tests for the CAD exchange path: IGES/BREP/glTF read-write plus STL export.

Minimal-profile tests (import shape, absence guards, glTF-reader and
extension error paths) run everywhere; OCP-bound round-trip tests skip
cleanly without the full CAD profile.
"""

import json
import struct
import sys
from pathlib import Path

import geometry_service
import pytest


def _requires_cad():
    """Skip unless build123d (and therefore OCP) is installed."""
    return pytest.importorskip("build123d", reason="build123d not installed")


def _box_shape(label=None):
    """Return the wrapped OCP shape of a 10 mm cube, optionally labeled."""
    bd = _requires_cad()
    box = bd.Box(10, 10, 10)
    if label:
        box.label = label
    return box.wrapped


def _two_box_shape():
    """Return the wrapped OCP shape of two labeled 10 mm cubes."""
    bd = _requires_cad()
    box1 = bd.Box(10, 10, 10)
    box1.label = "left"
    box2 = bd.Pos(20, 0, 0) * bd.Box(10, 10, 10)
    box2.label = "right"
    return bd.Compound(children=[box1, box2]).wrapped


def _solid_count(shape) -> int:
    return len(geometry_service._solids_in_explorer_order(shape))


def _solid_volume(shape) -> float:
    OCP_GProp = pytest.importorskip("OCP.GProp", reason="OCP not installed")
    OCP_BRepGProp = pytest.importorskip("OCP.BRepGProp", reason="OCP not installed")
    props = OCP_GProp.GProp_GProps()
    OCP_BRepGProp.BRepGProp.VolumeProperties_s(shape, props)
    return float(props.Mass())


def _poison(monkeypatch, *module_names: str) -> None:
    """Force dependency absence even in the full profile (None in sys.modules).

    ``from OCP.X import ...`` raises ImportError when ``sys.modules[X]`` is
    None, so the not-supported guards trigger deterministically in both
    profiles (repo rule: never assume the ambient env lacks the dependency).
    """
    for name in module_names:
        monkeypatch.setitem(sys.modules, name, None)


# ---------------------------------------------------------------------------
# Availability contract: clear "not supported with this OCP" errors.
# ---------------------------------------------------------------------------


def test_exchange_helpers_are_importable_in_minimal_profile() -> None:
    for name in (
        "_write_iges",
        "_read_iges",
        "import_iges_file",
        "_write_brep",
        "_read_brep",
        "import_brep_file",
        "_write_gltf",
        "_read_gltf",
        "import_gltf_file",
        "_write_stl",
        "export_stl_file",
    ):
        assert callable(getattr(geometry_service, name)), name


def test_iges_write_without_ocp_reports_not_supported(monkeypatch) -> None:
    _poison(monkeypatch, "OCP.IGESControl", "OCP.IGESCAFControl")
    with pytest.raises(RuntimeError, match="not supported with this OCP"):
        geometry_service._write_iges(object(), Path("x.iges"))


def test_iges_read_without_ocp_reports_not_supported(monkeypatch, tmp_path: Path) -> None:
    _poison(monkeypatch, "OCP.IGESControl", "OCP.IGESCAFControl")
    probe = tmp_path / "probe.iges"
    probe.write_text("dummy")
    with pytest.raises(RuntimeError, match="not supported with this OCP"):
        geometry_service._read_iges(probe)


def test_import_iges_without_ocp_returns_structured_error(monkeypatch, tmp_path: Path) -> None:
    _poison(monkeypatch, "OCP.IGESControl", "OCP.IGESCAFControl")
    probe = tmp_path / "probe.iges"
    probe.write_text("dummy")
    result = geometry_service.import_iges_file(str(probe), output_dir=str(tmp_path))
    assert result["success"] is False
    assert "not supported with this OCP" in result["error"]


def test_brep_write_without_ocp_reports_not_supported(monkeypatch) -> None:
    _poison(monkeypatch, "OCP.BRepTools")
    with pytest.raises(RuntimeError, match="not supported with this OCP"):
        geometry_service._write_brep(object(), Path("x.brep"))


def test_brep_read_without_ocp_reports_not_supported(monkeypatch, tmp_path: Path) -> None:
    _poison(monkeypatch, "OCP.BRepTools", "OCP.BRep", "OCP.TopoDS")
    probe = tmp_path / "probe.brep"
    probe.write_text("dummy")
    with pytest.raises(RuntimeError, match="not supported with this OCP"):
        geometry_service._read_brep(probe)


def test_import_brep_without_ocp_returns_structured_error(monkeypatch, tmp_path: Path) -> None:
    _poison(monkeypatch, "OCP.BRepTools", "OCP.BRep", "OCP.TopoDS")
    probe = tmp_path / "probe.brep"
    probe.write_text("dummy")
    result = geometry_service.import_brep_file(str(probe), output_dir=str(tmp_path))
    assert result["success"] is False
    assert "not supported with this OCP" in result["error"]


def test_gltf_write_without_ocp_reports_not_supported(monkeypatch) -> None:
    _poison(monkeypatch, "OCP.RWGltf", "OCP.BRepMesh")
    with pytest.raises(RuntimeError, match="not supported with this OCP"):
        geometry_service._write_gltf(object(), Path("x.glb"))


def test_gltf_read_is_not_supported_in_any_profile() -> None:
    """RWGltf_CafReader exposes no document read API, so glTF stays write-only."""
    with pytest.raises(RuntimeError, match="not supported with this OCP"):
        geometry_service._read_gltf(Path("x.glb"))


def test_import_gltf_reports_not_supported(tmp_path: Path) -> None:
    probe = tmp_path / "probe.glb"
    probe.write_bytes(b"glTF dummy")
    result = geometry_service.import_gltf_file(str(probe), output_dir=str(tmp_path))
    assert result["success"] is False
    assert "not supported with this OCP" in result["error"]


def test_import_gltf_missing_file(tmp_path: Path) -> None:
    result = geometry_service.import_gltf_file(str(tmp_path / "missing.glb"))
    assert result["success"] is False
    assert "not found" in result["error"]


def test_stl_write_without_ocp_reports_not_supported(monkeypatch) -> None:
    _poison(monkeypatch, "OCP.StlAPI", "OCP.BRepMesh")
    with pytest.raises(RuntimeError, match="not supported with this OCP"):
        geometry_service._write_stl(object(), Path("x.stl"))


def test_export_stl_without_ocp_returns_structured_error(monkeypatch, tmp_path: Path) -> None:
    _poison(monkeypatch, "OCP.StlAPI", "OCP.BRepMesh", "OCP.STEPControl")
    probe = tmp_path / "probe.step"
    probe.write_text("dummy")
    result = geometry_service.export_stl_file(str(probe))
    assert result["success"] is False
    assert "not supported with this OCP" in result["error"]


def test_export_stl_missing_source(tmp_path: Path) -> None:
    result = geometry_service.export_stl_file(str(tmp_path / "missing.step"))
    assert result["success"] is False
    assert "not found" in result["error"]


def test_export_stl_rejects_unknown_extension(tmp_path: Path) -> None:
    probe = tmp_path / "model.xyz"
    probe.write_text("dummy")
    result = geometry_service.export_stl_file(str(probe))
    assert result["success"] is False
    assert "Unsupported exchange extension" in result["error"]


def test_import_step_missing_file_still_structured(tmp_path: Path) -> None:
    """Neighboring STEP contract the exchange imports mirror (regression pin)."""
    result = geometry_service.import_step_file(str(tmp_path / "missing.step"))
    assert result["success"] is False
    assert "not found" in result["error"]


# ---------------------------------------------------------------------------
# Full profile: IGES read-write (same OCAF name/color pattern as STEP).
# ---------------------------------------------------------------------------


def test_iges_round_trip_preserves_solids_names_and_volume(tmp_path: Path) -> None:
    _requires_cad()
    shape = _two_box_shape()
    names = geometry_service._solid_names_from_selector_map({"left": [1], "right": [2]}, 2)
    iges_path = tmp_path / "boxes.iges"
    assert geometry_service._write_iges(shape, iges_path, solid_names=names) is None

    back = geometry_service._read_iges(iges_path)
    assert _solid_count(back) == 2
    assert geometry_service._read_iges_names(iges_path, 2) == {1: "left", 2: "right"}
    assert _solid_volume(back) == pytest.approx(2 * 10**3, rel=1e-6)


def test_iges_plain_writer_path_without_names(tmp_path: Path) -> None:
    """Unlabeled models take the legacy IGESControl path, like STEP."""
    _requires_cad()
    shape = _box_shape()
    iges_path = tmp_path / "box.iges"
    assert geometry_service._write_iges(shape, iges_path) is None
    back = geometry_service._read_iges(iges_path)
    assert _solid_count(back) >= 1
    assert _solid_volume(back) == pytest.approx(10**3, rel=1e-6)


def test_import_iges_file_end_to_end(tmp_path: Path) -> None:
    _requires_cad()
    shape = _two_box_shape()
    names = geometry_service._solid_names_from_selector_map({"left": [1], "right": [2]}, 2)
    iges_path = tmp_path / "boxes.iges"
    geometry_service._write_iges(shape, iges_path, solid_names=names)

    out_dir = tmp_path / "imported"
    out_dir.mkdir()
    result = geometry_service.import_iges_file(str(iges_path), output_dir=str(out_dir))
    assert result["success"] is True, result.get("error", "")
    assert result["solidCount"] == 2
    assert result["selectorMap"] == {"left": [1], "right": [2]}
    assert Path(result["tessPath"]).exists()


def test_import_iges_rejects_collapsed_expansion_flags(tmp_path: Path) -> None:
    _requires_cad()
    iges_path = tmp_path / "box.iges"
    geometry_service._write_iges(_box_shape(), iges_path)
    with pytest.raises(ValueError, match="one object per solid"):
        geometry_service.import_iges_file(str(iges_path), expand_compound=False)
    with pytest.raises(ValueError, match="one object per solid"):
        geometry_service.import_iges_file(str(iges_path), one_object_per_solid=False)


# ---------------------------------------------------------------------------
# Full profile: BREP lossless native round-trip.
# ---------------------------------------------------------------------------


def test_brep_round_trip_is_lossless(tmp_path: Path) -> None:
    _requires_cad()
    shape = _two_box_shape()
    brep_path = tmp_path / "boxes.brep"
    geometry_service._write_brep(shape, brep_path)
    assert brep_path.stat().st_size > 0

    back = geometry_service._read_brep(brep_path)
    assert _solid_count(back) == 2
    assert _solid_volume(back) == pytest.approx(2 * 10**3, rel=1e-12)


def test_import_brep_file_end_to_end(tmp_path: Path) -> None:
    _requires_cad()
    brep_path = tmp_path / "box.brep"
    geometry_service._write_brep(_box_shape(), brep_path)

    out_dir = tmp_path / "imported"
    out_dir.mkdir()
    result = geometry_service.import_brep_file(str(brep_path), output_dir=str(out_dir))
    assert result["success"] is True, result.get("error", "")
    assert result["solidCount"] == 1
    # The native BREP format carries no product names.
    assert result["selectorMap"] == {}
    assert Path(result["stepPath"]).exists()
    assert Path(result["tessPath"]).exists()


# ---------------------------------------------------------------------------
# Full profile: glTF mesh+color exchange.
#
# Triangulation expectations: glTF carries only the precomputed facet mesh
# (plus XCAF surface colors/names) — never the B-rep. A .gltf JSON document
# therefore exposes its triangle budget as the sum of its index-accessor
# counts divided by 3, which must equal the tessellation route's triangle
# total at the same tolerance. There is no B-rep round-trip to assert
# (the OCP reader has no read API; see the not-supported tests above).
# ---------------------------------------------------------------------------


def test_gltf_write_binary_magic(tmp_path: Path) -> None:
    _requires_cad()
    glb_path = tmp_path / "box.glb"
    geometry_service._write_gltf(_box_shape(), glb_path)
    assert glb_path.stat().st_size > 0
    assert glb_path.read_bytes()[:4] == b"glTF"


def test_gltf_write_text_is_json_asset(tmp_path: Path) -> None:
    _requires_cad()
    gltf_path = tmp_path / "box.gltf"
    geometry_service._write_gltf(_box_shape(), gltf_path, binary=False)
    document = json.loads(gltf_path.read_text(encoding="utf-8"))
    assert "asset" in document
    assert document["asset"]["version"].startswith("2.")


def test_gltf_triangle_budget_matches_tessellation(tmp_path: Path) -> None:
    _requires_cad()
    shape = _box_shape()
    tolerance = 0.001
    solids = geometry_service._tessellate_shape(shape, tolerance)
    expected = sum(len(face["triangles"]) for solid in solids for face in solid["faces"])
    assert expected > 0

    gltf_path = tmp_path / "box.gltf"
    geometry_service._write_gltf(_box_shape(), gltf_path, tolerance=tolerance, binary=False)
    document = json.loads(gltf_path.read_text(encoding="utf-8"))
    index_counts = [
        document["accessors"][primitive["indices"]]["count"]
        for mesh in document.get("meshes", [])
        for primitive in mesh["primitives"]
        if "indices" in primitive
    ]
    assert sum(index_counts) // 3 == expected


def test_gltf_write_with_names_and_colors(tmp_path: Path) -> None:
    """Per-solid names/colors ride along where the format supports them."""
    _requires_cad()
    gltf_path = tmp_path / "boxes.glb"
    geometry_service._write_gltf(
        _two_box_shape(),
        gltf_path,
        solid_names=["left", "right"],
        face_colors=[(1.0, 0.0, 0.0), (0.0, 0.0, 1.0)],
    )
    assert gltf_path.stat().st_size > 0


# ---------------------------------------------------------------------------
# Full profile: STL exact-facet export via the tessellation route.
# ---------------------------------------------------------------------------


def _stl_binary_facet_count(stl_path: Path) -> int:
    with stl_path.open("rb") as handle:
        handle.seek(80)
        return struct.unpack("<I", handle.read(4))[0]


def test_stl_facets_match_tessellation_triangles(tmp_path: Path) -> None:
    """STL export must reuse the tessellation mesher, not a new one."""
    _requires_cad()
    tolerance = 0.001
    solids = geometry_service._tessellate_shape(_box_shape(), tolerance)
    expected = sum(len(face["triangles"]) for solid in solids for face in solid["faces"])

    stl_path = tmp_path / "box.stl"
    geometry_service._write_stl(_box_shape(), stl_path, tolerance=tolerance)
    assert _stl_binary_facet_count(stl_path) == expected


def test_stl_ascii_write_smoke(tmp_path: Path) -> None:
    _requires_cad()
    stl_path = tmp_path / "box_ascii.stl"
    geometry_service._write_stl(_box_shape(), stl_path, binary=False)
    text = stl_path.read_text(encoding="utf-8")
    assert text.startswith("solid")
    assert text.count("facet normal") == 12


def test_export_stl_file_end_to_end(tmp_path: Path) -> None:
    _requires_cad()
    step_path = tmp_path / "box.step"
    geometry_service._write_step(_box_shape(), step_path)

    result = geometry_service.export_stl_file(str(step_path))
    assert result["success"] is True, result.get("error", "")
    stl_path = Path(result["stlPath"])
    assert stl_path.exists()
    assert _stl_binary_facet_count(stl_path) == 12

    # IGES and BREP sources compose through the same path.
    iges_path = tmp_path / "box.iges"
    geometry_service._write_iges(_box_shape(), iges_path)
    assert geometry_service.export_stl_file(str(iges_path))["success"] is True
    brep_path = tmp_path / "box.brep"
    geometry_service._write_brep(_box_shape(), brep_path)
    assert geometry_service.export_stl_file(str(brep_path))["success"] is True
