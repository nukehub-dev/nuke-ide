#!/usr/bin/env python3
# Copyright (C) 2026 NukeHub and others.
# SPDX-License-Identifier: BSD-2-Clause
"""Tests for the nuke-cad drawing service.

Minimal profile (pytest + numpy only): import safety, guarded-dependency
errors, pure helpers (section offset, Kasa fit, SVG goldens). Full profile
(OCP/build123d/ezdxf): box HLR counts, section area + hatch loops, SVG/DXF
goldens, dimension recompute after a param edit, and stale flags on broken
refs. Full-profile tests skip cleanly when the heavy deps are absent.
"""

from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

import pytest

# Ensure the service module is importable.
_SERVICE_DIR = Path(__file__).parent.parent.parent / "python"
sys.path.insert(0, str(_SERVICE_DIR))

import drawing_service  # noqa: E402
import geometry_service  # noqa: E402


def _require_ocp():
    return pytest.importorskip("OCP.HLRBRep", reason="OCP not installed")


def _require_build123d():
    return pytest.importorskip("build123d", reason="build123d not installed")


def _box_shape(dx: float = 10.0, dy: float = 10.0, dz: float = 10.0):
    """Centered OCP box (full profile)."""
    _require_ocp()
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt

    return BRepPrimAPI_MakeBox(
        gp_Pnt(-dx / 2.0, -dy / 2.0, -dz / 2.0),
        gp_Pnt(dx / 2.0, dy / 2.0, dz / 2.0),
    ).Shape()


def _base_sheet(**overrides) -> dict:
    sheet = {
        "id": "sheet-1",
        "name": "Sheet 1",
        "size": "A4",
        "orientation": "landscape",
        "views": [
            {
                "id": "base",
                "kind": "base",
                "orientation": "front",
                "scale": 1.0,
                "position": [50.0, 50.0],
            }
        ],
        "dimensions": [],
    }
    sheet.update(overrides)
    return sheet


def _rect_sketch(width: float = 10.0, height: float = 10.0) -> dict:
    return {
        "id": "rect",
        "name": "rectangle",
        "datumId": "datum-xy",
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


def _write_box_doc(
    path: Path, dx: float = 10.0, dy: float = 10.0, dz: float = 10.0, sheet: dict | None = None
) -> Path:
    """Write a minimal v3 document: rect sketch + pad box + one drawing sheet."""
    doc = {
        "version": 3,
        "name": "drawing-box",
        "parameters": {},
        "bodies": [{"id": "body-1", "label": "box", "name": "box"}],
        "datums": [{"id": "datum-xy", "kind": "XY", "name": "XY Plane"}],
        "curves": [],
        "sketches": [_rect_sketch(dx, dy)],
        "features": [
            {
                "id": "box",
                "name": "box",
                "type": "pad",
                "body": "body-1",
                "sketchId": "rect",
                "dependsOn": [],
                "suppressed": False,
                "params": {"length": dz},
            }
        ],
        "drawings": [sheet if sheet is not None else _base_sheet()],
    }
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Minimal profile: import safety + pure helpers
# ---------------------------------------------------------------------------


def test_module_imports_without_heavy_deps() -> None:
    """The module imports with pytest + numpy only; heavy deps are guarded."""
    assert isinstance(drawing_service.HAS_OCP, bool)
    assert isinstance(drawing_service.HAS_EZDXF, bool)
    assert isinstance(drawing_service.HAS_REFERENCE_RESOLVER, bool)
    assert drawing_service.SHEET_SIZES_MM["A4"] == (297.0, 210.0)
    assert drawing_service.SHEET_SIZES_MM["A3"] == (420.0, 297.0)


def test_build_drawing_without_ocp_is_structured_error(monkeypatch) -> None:
    """Missing OCP is a structured error dict, never an import crash."""
    monkeypatch.setattr(drawing_service, "HAS_OCP", False)
    result = drawing_service.build_drawing("whatever.nuke-cad", "sheet-1")
    assert result["success"] is False
    assert "OCP" in result["error"]


def test_unknown_orientation_is_structured_error() -> None:
    """Unknown view orientations fail with a readable error (no OCP needed)."""
    with pytest.raises(drawing_service.DrawingError, match="Unknown view orientation"):
        drawing_service._view_frame("bogus")


def test_section_offset_follows_section_plane_convention() -> None:
    """Cut position is min + fraction * (max - min), fraction clamped."""
    assert drawing_service.section_offset("z", 0.0, 10.0, 0.5) == 5.0
    assert drawing_service.section_offset("x", -5.0, 5.0, 0.25) == -2.5
    assert drawing_service.section_offset("z", 0.0, 10.0, -1.0) == 0.0
    assert drawing_service.section_offset("z", 0.0, 10.0, 2.0) == 10.0


def test_kasa_fit_recovers_circle() -> None:
    """Kasa fallback fits a circle in an arbitrary plane (numpy only)."""
    points = [
        (5.0 * math.cos(t) + 1.0, 5.0 * math.sin(t) - 2.0, 3.0)
        for t in [i * 2.0 * math.pi / 24 for i in range(24)]
    ]
    fit = drawing_service._kasa_circle_fit(points)
    assert fit is not None
    center, radius = fit
    assert radius == pytest.approx(5.0, rel=1e-9)
    assert math.dist(center, (1.0, -2.0, 3.0)) < 1e-9


def test_kasa_fit_rejects_line() -> None:
    """Non-circular points fail the Kasa fit (None, not a bogus radius)."""
    points = [(float(i), 0.0, 0.0) for i in range(10)]
    assert drawing_service._kasa_circle_fit(points) is None
    assert drawing_service._kasa_circle_fit([(0.0, 0.0, 0.0)]) is None


def test_emit_svg_golden() -> None:
    """SVG golden: sheet rect, polylines, hatch pattern fill, dimension text."""
    views = [
        {
            "id": "base",
            "visible": [{"points": [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]], "closed": False}],
            "hidden": [{"points": [[0.0, 0.0], [0.0, 10.0]], "closed": False}],
            "hatchLoops": [{"loop": [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]], "area": 50.0}],
            "center": [5.0, 5.0],
        }
    ]
    dims = [{"id": "d1", "text": "10.00", "anchors": [[0.0, 0.0], [10.0, 0.0]]}]
    svg = drawing_service.emit_svg((297.0, 210.0), views, dims)
    assert "<svg" in svg and "</svg>" in svg
    assert 'viewBox="0 0 297 210"' in svg
    assert 'id="ansi31"' in svg
    assert '<polyline points="0,210 10,210 10,200"' in svg
    assert 'stroke-dasharray="2,1"' in svg
    assert 'fill="url(#ansi31)"' in svg
    assert ">10.00</text>" in svg


def test_emit_dxf_guard_and_layers() -> None:
    """DXF without ezdxf is a structured error; with it, layers exist."""
    views = [
        {
            "id": "base",
            "visible": [
                {"points": [[0.0, 0.0], [10.0, 0.0]], "closed": False},
                {
                    "points": [[10.0, 0.0], [10.0, 10.0]],
                    "closed": False,
                    "circle": {"center": [5.0, 5.0], "radius": 5.0},
                },
            ],
            "hidden": [{"points": [[0.0, 0.0], [0.0, 10.0]], "closed": False}],
            "hatchLoops": [
                {"loop": [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 0.0]], "area": 50.0}
            ],
            "center": [5.0, 5.0],
        }
    ]
    dims = [{"id": "d1", "text": "10.00", "anchors": [[0.0, 0.0], [10.0, 0.0]]}]
    if not drawing_service.HAS_EZDXF:
        with pytest.raises(drawing_service.DrawingError, match="ezdxf"):
            drawing_service.emit_dxf((297.0, 210.0), views, dims)
        return
    dxf = drawing_service.emit_dxf((297.0, 210.0), views, dims)
    for layer in ("VISIBLE", "HIDDEN", "SECTION", "DIMENSION", "CENTER"):
        assert layer in dxf
    assert "CIRCLE" in dxf
    assert "LINE" in dxf
    assert "HATCH" in dxf
    assert "10.00" in dxf


# ---------------------------------------------------------------------------
# Full profile: HLR projection
# ---------------------------------------------------------------------------


def test_box_front_view_visible_and_hidden_counts() -> None:
    """Face-on box front view: 4 visible + 4 hidden edges (depth edges are
    degenerate in projection, so the total is 8, not 12 — see iso test)."""
    shape = _box_shape()
    _lo, _hi, center, diagonal = drawing_service._shape_bbox(shape)
    view = {
        "id": "base",
        "kind": "base",
        "orientation": "front",
        "scale": 1.0,
        "position": [50.0, 50.0],
        "showHidden": True,
    }
    out = drawing_service.project_view(shape, view, center, diagonal)
    assert len(out["visible"]) == 4, [len(out["visible"])]
    assert len(out["hidden"]) == 4, [len(out["hidden"])]
    for polyline in out["visible"] + out["hidden"]:
        assert len(polyline["points"]) >= 2


def test_box_front_view_hides_hidden_unless_requested() -> None:
    """Hidden linework is omitted unless the view sets showHidden."""
    shape = _box_shape()
    _lo, _hi, center, diagonal = drawing_service._shape_bbox(shape)
    view = {
        "id": "base",
        "kind": "base",
        "orientation": "front",
        "scale": 1.0,
        "position": [50.0, 50.0],
    }
    out = drawing_service.project_view(shape, view, center, diagonal)
    assert len(out["visible"]) == 4
    assert out["hidden"] == []


def test_box_iso_view_counts_all_twelve_edges() -> None:
    """Iso view sees every box edge: 9 visible + 3 hidden = 12 total."""
    shape = _box_shape()
    _lo, _hi, center, diagonal = drawing_service._shape_bbox(shape)
    view = {
        "id": "iso",
        "kind": "base",
        "orientation": "iso",
        "scale": 1.0,
        "position": [150.0, 50.0],
        "showHidden": True,
    }
    out = drawing_service.project_view(shape, view, center, diagonal)
    assert len(out["visible"]) == 9, len(out["visible"])
    assert len(out["hidden"]) == 3, len(out["hidden"])


def test_section_cut_axis_convention() -> None:
    """Unflipped z-cuts keep the minimum side; flip keeps the maximum side."""
    _require_ocp()
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    shape = _box_shape(10.0, 10.0, 10.0)

    def _z_extent(cut) -> tuple[float, float]:
        box = Bnd_Box()
        BRepBndLib.Add_s(cut, box)
        return box.CornerMin().Z(), box.CornerMax().Z()

    lower, _ = drawing_service._apply_section_cut(shape, "z", 0.5, False)
    assert _z_extent(lower)[1] == pytest.approx(0.0, abs=1e-6)
    upper, _ = drawing_service._apply_section_cut(shape, "z", 0.5, True)
    assert _z_extent(upper)[0] == pytest.approx(0.0, abs=1e-6)


def test_section_view_area_and_hatch_loops() -> None:
    """Mid-plane section of a 10^3 box: area 100 with non-empty hatch loops."""
    shape = _box_shape()
    _lo, _hi, center, diagonal = drawing_service._shape_bbox(shape)
    view = {
        "id": "sec",
        "kind": "section",
        "orientation": "top",
        "scale": 2.0,
        "position": [50.0, 50.0],
        "sectionAxis": "z",
        "sectionFraction": 0.5,
        "sectionFlip": False,
    }
    out = drawing_service.project_view(shape, view, center, diagonal)
    assert out["sectionArea"] == pytest.approx(100.0, rel=1e-6)
    assert len(out["hatchLoops"]) >= 1
    outer = max(out["hatchLoops"], key=lambda h: h["area"])
    assert outer["area"] == pytest.approx(100.0, rel=1e-6)
    assert len(out["visible"]) >= 4


def test_cylinder_front_view_has_silhouette_and_circle() -> None:
    """Curved surfaces contribute outline (silhouette) edges to visible."""
    _require_ocp()
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder

    shape = BRepPrimAPI_MakeCylinder(5.0, 10.0).Shape()
    _lo, _hi, center, diagonal = drawing_service._shape_bbox(shape)
    view = {
        "id": "base",
        "kind": "base",
        "orientation": "front",
        "scale": 1.0,
        "position": [50.0, 50.0],
    }
    out = drawing_service.project_view(shape, view, center, diagonal)
    assert len(out["visible"]) >= 4


# ---------------------------------------------------------------------------
# Full profile: documents, dimensions, export, dispatch
# ---------------------------------------------------------------------------


def _face_ref(kind: str, fingerprint) -> dict:
    return {"kind": kind, "fingerprint": fingerprint.to_dict()}


def _z_face_refs(shape) -> tuple[dict, dict]:
    """TopologyRefs for the two z-normal faces of a box (distance pair)."""
    import reference_resolver  # noqa: E402

    bottom = top = None
    for fp in reference_resolver.extract_face_fingerprints(shape):
        if fp.surface_type != "plane" or fp.normal is None:
            continue
        if abs(fp.normal[2]) < 0.99:
            continue
        if fp.normal[2] > 0:
            top = fp
        else:
            bottom = fp
    assert bottom is not None and top is not None
    return _face_ref("face", bottom), _face_ref("face", top)


def test_build_drawing_document_flow(tmp_path: Path) -> None:
    """End-to-end RPC shape: views + svg/dxf strings + warnings channel."""
    _require_build123d()
    sheet = _base_sheet(
        views=[
            {
                "id": "base",
                "kind": "base",
                "orientation": "front",
                "scale": 2.0,
                "position": [50.0, 50.0],
            },
            {
                "id": "sec",
                "kind": "section",
                "orientation": "top",
                "scale": 2.0,
                "position": [150.0, 50.0],
                "showHidden": True,
                "sectionAxis": "z",
                "sectionFraction": 0.5,
                "sectionFlip": False,
            },
        ]
    )
    doc_path = _write_box_doc(tmp_path / "box.nuke-cad", sheet=sheet)
    result = drawing_service.build_drawing(str(doc_path), "sheet-1")
    assert result["success"] is True, result.get("error", "")
    assert result["sheetId"] == "sheet-1"
    assert result["size"] == "A4"
    assert result["sheetSizeMm"] == [297.0, 210.0]
    assert [v["id"] for v in result["views"]] == ["base", "sec"]
    base = result["views"][0]
    assert len(base["visible"]) == 4
    sec = result["views"][1]
    assert sec["sectionArea"] == pytest.approx(100.0, rel=1e-6)
    assert len(sec["hatchLoops"]) >= 1
    assert isinstance(result["svg"], str) and "<svg" in result["svg"]
    if drawing_service.HAS_EZDXF:
        assert isinstance(result["dxf"], str) and "VISIBLE" in result["dxf"]
        assert result["dxfError"] is None
    else:
        assert result["dxf"] is None
        assert result["dxfError"] is not None and "ezdxf" in result["dxfError"]
    assert isinstance(result["warnings"], list)


def test_build_drawing_grounded_assembly_uses_placed_shape(tmp_path: Path, monkeypatch) -> None:
    """A grounded assembly projects the placed instance compound, not own bodies."""
    _require_build123d()
    doc_path = _write_box_doc(tmp_path / "assembly.nuke-cad")
    document = json.loads(doc_path.read_text(encoding="utf-8"))
    document["assembly"] = {
        "instances": [
            {
                "id": "box_m0",
                "part": "body:body-1",
                "placement": {
                    "position": [20.0, 0.0, 0.0],
                    "orientation": [0.0, 0.0, 0.0, 1.0],
                },
            }
        ],
        "connectors": [],
        "mates": [],
        "groundedInstanceId": "box_m0",
    }
    doc_path.write_text(json.dumps(document), encoding="utf-8")

    calls: list[str] = []
    original = geometry_service.assembly_builder.build_assembly_shape

    def spy(doc: dict, **kwargs) -> dict:
        calls.append("called")
        return original(doc, **kwargs)

    monkeypatch.setattr(geometry_service.assembly_builder, "build_assembly_shape", spy)
    result = drawing_service.build_drawing(str(doc_path), "sheet-1")
    assert result["success"] is True, result.get("error", "")
    assert calls == ["called"]
    assert len(result["views"][0]["visible"]) == 4


def test_dimension_value_updates_after_param_edit(tmp_path: Path) -> None:
    """Re-resolving stored face refs after a z-size edit updates the value."""
    _require_build123d()
    shape10 = _box_shape(10.0, 10.0, 10.0)
    bottom_ref, top_ref = _z_face_refs(shape10)
    _lo, _hi, center10, _diag = drawing_service._shape_bbox(shape10)
    frames10 = drawing_service._view_frames(_base_sheet(), center10)
    dims = drawing_service.compute_dimensions(
        [
            {
                "id": "d1",
                "kind": "distance",
                "viewId": "base",
                "targets": [bottom_ref, top_ref],
            }
        ],
        shape10,
        frames10,
    )
    assert dims[0]["stale"] is False
    assert dims[0]["value"] == pytest.approx(10.0, rel=1e-6)

    # Same stored refs against the edited (taller) shape recompute from 3D.
    shape20 = _box_shape(10.0, 10.0, 20.0)
    _lo, _hi, center20, _diag = drawing_service._shape_bbox(shape20)
    frames20 = drawing_service._view_frames(_base_sheet(), center20)
    dims = drawing_service.compute_dimensions(dims, shape20, frames20)
    assert dims[0]["stale"] is False
    assert dims[0]["value"] == pytest.approx(20.0, rel=1e-6)
    assert dims[0]["text"] == "20.00"


def test_dimension_stale_on_deleted_ref() -> None:
    """Unresolvable refs keep last-good text and set stale: True."""
    shape = _box_shape()
    _lo, _hi, center, _diag = drawing_service._shape_bbox(shape)
    frames = drawing_service._view_frames(_base_sheet(), center)
    bogus = {
        "kind": "face",
        "fingerprint": {
            "surfaceType": "sphere",
            "area": 1e9,
            "center": [1e6, 1e6, 1e6],
            "radius": 1e6,
        },
    }
    dims = drawing_service.compute_dimensions(
        [
            {
                "id": "d1",
                "kind": "distance",
                "viewId": "base",
                "targets": [bogus, bogus],
                "value": 10.0,
                "text": "10.00",
            }
        ],
        shape,
        frames,
    )
    assert dims[0]["stale"] is True
    assert dims[0]["value"] == pytest.approx(10.0)
    assert dims[0]["text"] == "10.00"


def test_radius_and_diameter_from_circular_edge() -> None:
    """Radius/diameter dimensions read the fingerprint circle center + radius."""
    _require_ocp()
    import reference_resolver  # noqa: E402
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder

    shape = BRepPrimAPI_MakeCylinder(5.0, 10.0).Shape()
    circle_fp = None
    for fp in reference_resolver.extract_edge_fingerprints(shape):
        if fp.curve_type == "circle" and fp.center is not None:
            circle_fp = fp
            break
    assert circle_fp is not None
    ref = {"kind": "edge", "fingerprint": circle_fp.to_dict()}
    _lo, _hi, center, _diag = drawing_service._shape_bbox(shape)
    frames = drawing_service._view_frames(_base_sheet(), center)
    dims = drawing_service.compute_dimensions(
        [
            {"id": "r1", "kind": "radius", "viewId": "base", "targets": [ref]},
            {"id": "d1", "kind": "diameter", "viewId": "base", "targets": [ref]},
        ],
        shape,
        frames,
    )
    assert dims[0]["stale"] is False
    assert dims[0]["value"] == pytest.approx(5.0, rel=1e-6)
    assert dims[1]["stale"] is False
    assert dims[1]["value"] == pytest.approx(10.0, rel=1e-6)


def test_geometry_service_drawing_dispatch(tmp_path: Path) -> None:
    """geometry_service.build_drawing delegates to drawing_service."""
    _require_build123d()
    doc_path = _write_box_doc(tmp_path / "box.nuke-cad")
    result = geometry_service.build_drawing(str(doc_path), "sheet-1")
    assert result["success"] is True, result.get("error", "")
    assert result["sheetId"] == "sheet-1"
    assert "<svg" in result["svg"]


def test_geometry_service_drawing_dispatch_without_module(monkeypatch) -> None:
    """Missing drawing_service is a structured error, never an import crash."""
    monkeypatch.setattr(geometry_service, "HAS_DRAWING_SERVICE", False)
    monkeypatch.setattr(geometry_service, "drawing_service", None)
    result = geometry_service.build_drawing("whatever.nuke-cad", "sheet-1")
    assert result["success"] is False
    assert "drawing_service" in result["error"]


def test_unknown_sheet_id_lists_available(tmp_path: Path) -> None:
    """Unknown sheet ids fail with the available ids (deterministic both profiles)."""
    _require_build123d()
    doc_path = _write_box_doc(tmp_path / "box.nuke-cad")
    result = drawing_service.build_drawing(str(doc_path), "missing")
    assert result["success"] is False
    assert "sheet-1" in result["error"]


def test_drawing_cli_from_drawing_flag(tmp_path: Path) -> None:
    """--from-drawing/--sheet-id CLI dispatch emits the stdout-JSON protocol."""
    _write_box_doc(tmp_path / "box.nuke-cad")
    proc = subprocess.run(
        [
            sys.executable,
            str(_SERVICE_DIR / "geometry_service.py"),
            "--from-drawing",
            str(tmp_path / "box.nuke-cad"),
            "--sheet-id",
            "missing",
            "--no-dagmc",
            "--no-mesh",
        ],
        capture_output=True,
        text=True,
        timeout=300,
    )
    marker = geometry_service.RESULT_MARKER
    payload = None
    for line in reversed(proc.stdout.splitlines()):
        if line.strip().startswith(marker):
            payload = json.loads(line.strip()[len(marker) :])
            break
    assert payload is not None, proc.stdout[-2000:] + proc.stderr[-2000:]
    assert payload["success"] is False
    assert "missing" in payload["error"] or "OCP" in payload["error"]
