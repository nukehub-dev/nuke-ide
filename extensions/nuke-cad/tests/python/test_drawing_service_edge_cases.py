#!/usr/bin/env python3
# Copyright (C) 2026 NukeHub and others.
# SPDX-License-Identifier: BSD-2-Clause
"""Edge-case coverage for the nuke-cad drawing service.

Targets the guarded import paths, analytic circle/arc metadata, section-cut
failure paths, Kasa/kernel fallbacks, SVG/DXF entity variants, and the
document/loader error contract. Full-profile tests skip cleanly when OCP or
ezdxf are absent.
"""

from __future__ import annotations

import builtins
import importlib
import json
import sys
import types
from pathlib import Path

import pytest

# Ensure the service module is importable.
_SERVICE_DIR = Path(__file__).parent.parent.parent / "python"
sys.path.insert(0, str(_SERVICE_DIR))

import drawing_service as ds  # noqa: E402
import geometry_service  # noqa: E402


def _require_ocp():
    return pytest.importorskip("OCP.HLRBRep", reason="OCP not installed")


def _require_ezdxf():
    return pytest.importorskip("ezdxf", reason="ezdxf not installed")


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


def _identity_frame() -> dict:
    return {"right": (1.0, 0.0, 0.0), "up": (0.0, 1.0, 0.0), "center_u": 0.0, "center_v": 0.0}


def _circle_edge(radius: float = 5.0, center=(1.0, 2.0, 0.0)):
    _require_ocp()
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge
    from OCP.gp import gp_Ax2, gp_Circ, gp_Dir, gp_Pnt

    circ = gp_Circ(gp_Ax2(gp_Pnt(*center), gp_Dir(0.0, 0.0, 1.0)), radius)
    return BRepBuilderAPI_MakeEdge(circ).Edge()


def _arc_edge(points):
    _require_ocp()
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge
    from OCP.GC import GC_MakeArcOfCircle
    from OCP.gp import gp_Pnt

    curve = GC_MakeArcOfCircle(*(gp_Pnt(*point) for point in points)).Value()
    return BRepBuilderAPI_MakeEdge(curve).Edge()


def _first_edge(shape):
    _require_ocp()
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    explorer = TopExp_Explorer(shape, TopAbs_EDGE)
    assert explorer.More()
    return TopoDS.Edge_s(explorer.Current())


class _WrappedShape:
    """Mimics build123d's ``shape.wrapped`` accessor contract."""

    def __init__(self, wrapped):
        self.wrapped = wrapped


class _FakeBuilder:
    def __init__(self, result=None, error: Exception | None = None):
        self.result = result
        self.error = error
        self.calls: list[tuple[dict, dict]] = []

    def build_document_shape(self, document, **kwargs):
        self.calls.append((document, kwargs))
        if self.error is not None:
            raise self.error
        return self.result


def _fake_loader(monkeypatch, shape=None, warnings=None):
    monkeypatch.setattr(ds, "_load_model_shape", lambda _path: (shape, warnings or []))


def _write_document(path: Path, document: dict) -> Path:
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Import guards and frame validation
# ---------------------------------------------------------------------------


def test_module_reload_guards_missing_optional_dependencies(tmp_path: Path) -> None:
    """Absent OCP/ezdxf/reference_resolver re-import to flags, never a crash."""
    original_ocp = ds.HAS_OCP
    module_dir = str(Path(ds.__file__).parent.resolve())
    symlink_dir = tmp_path / "python-link"
    symlink_dir.symlink_to(module_dir, target_is_directory=True)
    original_path = list(sys.path)
    # Reach the module through a symlink so the real directory is absent from
    # sys.path (the module then restores its own resolved directory).
    sys.path[:] = [str(symlink_dir) if entry == module_dir else entry for entry in sys.path]
    real_import = builtins.__import__

    def _blocked_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name.split(".")[0] in {"OCP", "ezdxf", "reference_resolver"}:
            raise ImportError(f"blocked {name}")
        return real_import(name, globals, locals, fromlist, level)

    try:
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(builtins, "__import__", _blocked_import)
            reloaded = importlib.reload(ds)
            assert reloaded.HAS_OCP is False
            assert reloaded.reference_resolver is None
            assert reloaded.HAS_REFERENCE_RESOLVER is False
            assert reloaded.ezdxf is None
            assert reloaded.HAS_EZDXF is False
            # The module restores its own script directory before importing.
            assert module_dir in sys.path
    finally:
        sys.path[:] = original_path
        importlib.reload(ds)
    assert ds.HAS_OCP is original_ocp


def test_view_frame_rejects_mirrored_frame(monkeypatch) -> None:
    monkeypatch.setitem(
        ds._ORIENTATIONS,
        "mirrored",
        {"look": (0.0, 1.0, 0.0), "right": (1.0, 0.0, 0.0), "up": (0.0, 0.0, -1.0)},
    )
    with pytest.raises(ds.DrawingError, match="mirrored frame"):
        ds._view_frame("mirrored")


def test_hlr_rejects_projector_frame_divergence(monkeypatch) -> None:
    """A non-unit frame direction trips the projector-consistency guard."""
    shape = _box_shape()
    _lo, _hi, center, diagonal = ds._shape_bbox(shape)
    monkeypatch.setattr(
        ds, "_view_frame", lambda _orientation: ((0.0, 1.0, 0.0), (2.0, 0.0, 0.0), (0.0, 0.0, 1.0))
    )
    with pytest.raises(ds.DrawingError, match="projector frame diverged"):
        ds._hlr_edge_lists(shape, center, diagonal, "front")


# ---------------------------------------------------------------------------
# Analytic circle/arc and polyline guards
# ---------------------------------------------------------------------------


def test_analytic_circle_returns_closed_circle_metadata() -> None:
    edge = _circle_edge(radius=5.0, center=(1.0, 2.0, 0.0))
    analytic = ds._analytic_circle(edge, _identity_frame(), 2.0, [10.0, 20.0])
    assert analytic is not None
    assert analytic["kind"] == "circle"
    assert analytic["center"] == pytest.approx([12.0, 24.0])
    assert analytic["radius"] == pytest.approx(10.0)


def test_analytic_circle_arc_orientation_both_sweeps() -> None:
    """CCW and CW arcs report a consistent start/end ordering."""
    frame = _identity_frame()
    ccw = ds._analytic_circle(
        _arc_edge([(0.0, -5.0, 0.0), (5.0, 0.0, 0.0), (0.0, 5.0, 0.0)]),
        frame,
        1.0,
        [0.0, 0.0],
    )
    assert ccw is not None and ccw["kind"] == "arc"
    assert (ccw["startAngle"], ccw["endAngle"]) == pytest.approx((-90.0, 90.0))

    clockwise = ds._analytic_circle(
        _arc_edge([(0.0, -5.0, 0.0), (-5.0, 0.0, 0.0), (0.0, 5.0, 0.0)]),
        frame,
        1.0,
        [0.0, 0.0],
    )
    assert clockwise is not None and clockwise["kind"] == "arc"
    assert (clockwise["startAngle"], clockwise["endAngle"]) == pytest.approx((90.0, -90.0))


def test_analytic_circle_rejects_non_circular_sampling_and_short_arcs(monkeypatch) -> None:
    """Circular adaptors still need verifiably circular, long-enough samples."""

    class _OpenTool:
        @staticmethod
        def IsClosed_s(_edge):
            return False

    circle = _circle_edge()
    monkeypatch.setattr(ds, "BRep_Tool", _OpenTool)
    monkeypatch.setattr(
        ds, "_hlr_polyline_points", lambda *_args, **_kwargs: [[0.0, 0.0], [1.0, 0.0]]
    )
    assert ds._analytic_circle(circle, _identity_frame(), 1.0, [0.0, 0.0]) is None

    monkeypatch.setattr(
        ds, "_hlr_polyline_points", lambda *_args, **_kwargs: [[0.0, 0.0], [5.0, 0.0], [4.0, 0.0]]
    )
    assert ds._analytic_circle(circle, _identity_frame(), 1.0, [0.0, 0.0]) is None


def test_analytic_circle_rejects_lines_and_survives_broken_edges() -> None:
    _require_ocp()
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge
    from OCP.gp import gp_Pnt

    line = BRepBuilderAPI_MakeEdge(gp_Pnt(0.0, 0.0, 0.0), gp_Pnt(5.0, 0.0, 0.0)).Edge()
    assert ds._analytic_circle(line, _identity_frame(), 1.0, [0.0, 0.0]) is None
    assert ds._analytic_circle(None, _identity_frame(), 1.0, [0.0, 0.0]) is None


def test_edge_to_polyline_appends_closed_seam_and_guards(monkeypatch) -> None:
    _require_ocp()
    frame = _identity_frame()
    circle = _circle_edge()
    polyline = ds._edge_to_polyline(circle, frame, 1.0, [0.0, 0.0])
    assert polyline is not None and polyline["closed"] is True
    assert polyline["circle"] is not None
    assert polyline["points"][0] == pytest.approx(polyline["points"][-1])

    arc = _arc_edge([(0.0, -5.0, 0.0), (5.0, 0.0, 0.0), (0.0, 5.0, 0.0)])
    arc_polyline = ds._edge_to_polyline(arc, frame, 1.0, [0.0, 0.0])
    assert arc_polyline is not None and arc_polyline["arc"] is not None

    assert ds._edge_to_polyline(None, frame, 1.0, [0.0, 0.0]) is None

    class _ClosedTool:
        @staticmethod
        def IsClosed_s(_edge):
            return True

    box_edge = _first_edge(_box_shape())
    monkeypatch.setattr(ds, "BRep_Tool", _ClosedTool)
    monkeypatch.setattr(
        ds, "_hlr_polyline_points", lambda *_args, **_kwargs: [[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]]
    )
    closed = ds._edge_to_polyline(box_edge, frame, 1.0, [0.0, 0.0])
    assert closed is not None and closed["points"][-1] == [0.0, 0.0]

    monkeypatch.setattr(ds, "_hlr_polyline_points", lambda *_args, **_kwargs: [[1.0, 2.0]])
    assert ds._edge_to_polyline(box_edge, frame, 1.0, [0.0, 0.0]) is None


def test_project_view_cylinder_reports_analytic_circles() -> None:
    """A cylinder seen down its axis yields analytic circle linework."""
    _require_ocp()
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt

    shape = BRepPrimAPI_MakeCylinder(
        gp_Ax2(gp_Pnt(0.0, 0.0, 0.0), gp_Dir(0.0, 1.0, 0.0)), 5.0, 10.0
    ).Shape()
    _lo, _hi, center, diagonal = ds._shape_bbox(shape)
    view = {
        "id": "base",
        "kind": "base",
        "orientation": "front",
        "scale": 1.0,
        "position": [50.0, 50.0],
        "showHidden": True,
    }
    out = ds.project_view(shape, view, center, diagonal)
    assert len(out["visible"]) == 1
    assert out["visible"][0]["circle"]["radius"] == pytest.approx(5.0)
    assert len(out["hidden"]) == 1
    assert out["hidden"][0]["circle"]["radius"] == pytest.approx(5.0)


def test_project_view_rejects_non_positive_scale() -> None:
    shape = _box_shape()
    _lo, _hi, center, diagonal = ds._shape_bbox(shape)
    view = {"id": "bad", "orientation": "front", "scale": 0.0, "position": [0.0, 0.0]}
    with pytest.raises(ds.DrawingError, match="non-positive scale"):
        ds.project_view(shape, view, center, diagonal)


# ---------------------------------------------------------------------------
# Section cut failure paths
# ---------------------------------------------------------------------------


def test_section_cut_rejects_unknown_axis() -> None:
    shape = _box_shape()
    with pytest.raises(ds.DrawingError, match="Unknown section axis"):
        ds._apply_section_cut(shape, "w", 0.5, False)


def test_section_cut_boolean_failure_is_structured(monkeypatch) -> None:
    _require_ocp()

    class _FailedCut:
        def __init__(self, *_args):
            pass

        def Build(self) -> None:
            pass

        def IsDone(self) -> bool:
            return False

    monkeypatch.setattr(ds, "BRepAlgoAPI_Cut", _FailedCut)
    with pytest.raises(ds.DrawingError, match="Section cut failed"):
        ds._apply_section_cut(_box_shape(), "z", 0.5, False)


def test_section_view_without_cut_faces_warns(monkeypatch) -> None:
    """A cut whose faces cannot be classified still projects with a warning."""
    shape = _box_shape()
    _lo, _hi, center, diagonal = ds._shape_bbox(shape)

    def _broken_surface(_face):
        raise RuntimeError("unreadable surface")

    monkeypatch.setattr(ds, "BRepAdaptor_Surface", _broken_surface)
    view = {
        "id": "sec",
        "kind": "section",
        "orientation": "top",
        "scale": 1.0,
        "position": [50.0, 50.0],
        "sectionAxis": "z",
        "sectionFraction": 0.5,
    }
    out = ds.project_view(shape, view, center, diagonal)
    assert out["sectionArea"] == 0.0
    assert out["hatchLoops"] == []
    assert any("produced no cut faces" in warning for warning in out["warnings"])


def test_face_wire_loops_skips_unreadable_edges(monkeypatch) -> None:
    _require_ocp()
    shape = _box_shape()
    _cut, cut_faces = ds._apply_section_cut(shape, "z", 0.5, False)
    assert cut_faces

    def _broken_sampler(_edge, count=ds._EDGE_SAMPLES):
        if count == 17:
            raise RuntimeError("sampling failed")
        return ds.__dict__["_orig_sample_edge_points"](_edge, count)

    monkeypatch.setattr(ds, "_orig_sample_edge_points", ds._sample_edge_points, raising=False)
    monkeypatch.setattr(ds, "_sample_edge_points", _broken_sampler)
    loops = ds._face_wire_loops(
        cut_faces[0]["face"], [0.0, 0.0, 0.0], (1, 0, 0), (0, 1, 0), 1.0, [0.0, 0.0]
    )
    assert loops == []


def test_face_wire_loops_flips_mismatched_edge_traversal(monkeypatch) -> None:
    """A traversed edge that starts at the wrong end is reversed, not zigzagged."""
    _require_ocp()
    shape = _box_shape()
    _cut, cut_faces = ds._apply_section_cut(shape, "z", 0.5, False)
    assert cut_faces
    sequences = iter(
        [
            [[0.0, 0.0], [1.0, 0.0]],
            [[0.0, 0.0], [9.0, 9.0]],
            [[9.0, 9.0], [5.0, 0.0]],
            [[5.0, 0.0], [1.0, 0.0]],
        ]
    )
    monkeypatch.setattr(ds, "_project_points", lambda *_args, **_kwargs: next(sequences))
    loops = ds._face_wire_loops(
        cut_faces[0]["face"], [0.0, 0.0, 0.0], (1, 0, 0), (0, 1, 0), 1.0, [0.0, 0.0]
    )
    assert loops
    assert loops[0]["area"] > 0.0


# ---------------------------------------------------------------------------
# Kasa fallback failure branches
# ---------------------------------------------------------------------------


def _circle_points(count: int = 8) -> list[tuple[float, float, float]]:
    import math

    return [
        (5.0 * math.cos(i * 2.0 * math.pi / count), 5.0 * math.sin(i * 2.0 * math.pi / count), 0.0)
        for i in range(count)
    ]


def test_kasa_fit_handles_svd_failure(monkeypatch) -> None:
    def _raise(*_args, **_kwargs):
        raise ds.np.linalg.LinAlgError("no svd")

    monkeypatch.setattr(ds.np.linalg, "svd", _raise)
    assert ds._kasa_circle_fit(_circle_points()) is None


def test_kasa_fit_rejects_zero_normal(monkeypatch) -> None:
    monkeypatch.setattr(
        ds.np.linalg,
        "svd",
        lambda data, full_matrices=False: (data, ds.np.ones(3), ds.np.zeros((3, 3))),
    )
    assert ds._kasa_circle_fit(_circle_points()) is None


def test_kasa_fit_rejects_degenerate_plane() -> None:
    assert ds._kasa_circle_fit([(1.0, 1.0, 1.0)] * 6) is None


def test_kasa_fit_handles_lstsq_failure(monkeypatch) -> None:
    def _raise(*_args, **_kwargs):
        raise ds.np.linalg.LinAlgError("no lstsq")

    monkeypatch.setattr(ds.np.linalg, "lstsq", _raise)
    assert ds._kasa_circle_fit(_circle_points()) is None


def test_kasa_fit_rejects_non_positive_radius_squared(monkeypatch) -> None:
    monkeypatch.setattr(
        ds.np.linalg,
        "lstsq",
        lambda *_args, **_kwargs: (ds.np.array([0.0, 0.0, -1.0]), None, 0, None),
    )
    assert ds._kasa_circle_fit(_circle_points()) is None


# ---------------------------------------------------------------------------
# Dimension anchor resolution
# ---------------------------------------------------------------------------


def test_resolve_anchor_requires_reference_resolver(monkeypatch) -> None:
    monkeypatch.setattr(ds, "HAS_REFERENCE_RESOLVER", False)
    monkeypatch.setattr(ds, "reference_resolver", None)
    with pytest.raises(ds.DrawingError, match="reference_resolver"):
        ds._resolve_anchor({}, None)


def test_resolve_anchor_returns_none_when_entity_is_missing(monkeypatch) -> None:
    match_result = types.SimpleNamespace(
        matches=[types.SimpleNamespace(status="matched", candidate_id="gone")]
    )
    fake = types.SimpleNamespace(
        topology_ref_to_fingerprint=lambda _ref: object(),
        resolve_references_with_entities=lambda _fps, _shape: (match_result, {}),
    )
    monkeypatch.setattr(ds, "HAS_REFERENCE_RESOLVER", True)
    monkeypatch.setattr(ds, "reference_resolver", fake)
    monkeypatch.setattr(ds, "HAS_OCP", True)
    assert ds._resolve_anchor({"kind": "edge"}, None) is None


def test_resolve_anchor_line_edge_uses_midpoint_and_kasa_fallback(monkeypatch) -> None:
    _require_ocp()
    import reference_resolver

    shape = _box_shape()
    line_fp = next(
        fp for fp in reference_resolver.extract_edge_fingerprints(shape) if fp.curve_type == "line"
    )
    ref = {"kind": "edge", "fingerprint": line_fp.to_dict()}
    anchor, radius = ds._resolve_anchor(ref, shape)
    assert len(anchor) == 3
    assert radius is None

    monkeypatch.setattr(ds, "_kasa_circle_fit", lambda _points: ([9.0, 8.0, 7.0], 4.0))
    anchor, radius = ds._resolve_anchor(ref, shape)
    assert anchor == pytest.approx([9.0, 8.0, 7.0])
    assert radius == pytest.approx(4.0)


def test_resolve_anchor_rejects_unsupported_target_kind(monkeypatch) -> None:
    match_result = types.SimpleNamespace(
        matches=[types.SimpleNamespace(status="matched", candidate_id="entity")]
    )
    fake = types.SimpleNamespace(
        topology_ref_to_fingerprint=lambda _ref: object(),
        resolve_references_with_entities=lambda _fps, _shape: (match_result, {"entity": object()}),
    )
    monkeypatch.setattr(ds, "HAS_REFERENCE_RESOLVER", True)
    monkeypatch.setattr(ds, "reference_resolver", fake)
    monkeypatch.setattr(ds, "HAS_OCP", True)
    with pytest.raises(ds.DrawingError, match="Unsupported dimension target kind"):
        ds._resolve_anchor({"kind": "vertex"}, None)


def test_compute_dimensions_stale_and_label_offset_paths() -> None:
    frames = {
        "base": {
            "center": [0.0, 0.0, 0.0],
            "right": (1.0, 0.0, 0.0),
            "up": (0.0, 1.0, 0.0),
            "scale": 1.0,
            "position": [0.0, 0.0],
        }
    }
    dims = ds.compute_dimensions(
        [
            {
                "id": "d1",
                "kind": "distance",
                "viewId": "base",
                "targets": [],
                "value": 5.0,
                "labelOffset": [2.0, 3.0],
            },
            {"id": "d2", "kind": "distance", "viewId": "missing", "targets": [], "text": "old"},
            {"id": "d3", "kind": "radius", "viewId": "base", "targets": []},
        ],
        None,
        frames,
    )
    assert dims[0]["stale"] is True
    assert dims[0]["text"] == "5.00"
    assert dims[0]["labelOffset"] == [2.0, 3.0]
    assert "needs 2 target" in dims[0]["note"]
    assert "unknown view" in dims[1]["note"]
    assert "needs 1 target" in dims[2]["note"]


def test_compute_dimensions_radius_non_circular_target_is_stale() -> None:
    _require_ocp()
    import reference_resolver

    shape = _box_shape()
    line_fp = next(
        fp for fp in reference_resolver.extract_edge_fingerprints(shape) if fp.curve_type == "line"
    )
    ref = {"kind": "edge", "fingerprint": line_fp.to_dict()}
    _lo, _hi, center, _diagonal = ds._shape_bbox(shape)
    frames = ds._view_frames(_base_sheet(), center)
    dims = ds.compute_dimensions(
        [{"id": "r", "kind": "radius", "viewId": "base", "targets": [ref]}], shape, frames
    )
    assert dims[0]["stale"] is True
    assert "not circular" in dims[0]["note"]


def test_view_frames_skips_bad_ids_and_orientations() -> None:
    sheet = {
        "views": [
            {"id": 7, "orientation": "front"},
            {"id": "bogus", "orientation": "bogus"},
            {"id": "ok", "orientation": "top", "scale": 2.0, "position": [1.0, 2.0]},
        ]
    }
    frames = ds._view_frames(sheet, [0.0, 0.0, 0.0])
    assert list(frames) == ["ok"]
    assert frames["ok"]["scale"] == 2.0


# ---------------------------------------------------------------------------
# SVG emission variants
# ---------------------------------------------------------------------------


def test_emit_svg_circle_arc_and_dimension_anchor_variants() -> None:
    views = [
        {
            "id": "base",
            "visible": [
                {
                    "points": [[5.0, 5.0], [6.0, 6.0]],
                    "closed": True,
                    "circle": {"center": [5.0, 5.0], "radius": 2.5},
                },
                {
                    "points": [[0.0, 0.0], [10.0, 0.0]],
                    "closed": False,
                    "arc": {
                        "kind": "arc",
                        "center": [5.0, 5.0],
                        "radius": 5.0,
                        "startAngle": 0.0,
                        "endAngle": 90.0,
                    },
                },
            ],
            "center": [5.0, 5.0],
        }
    ]
    dims = [
        {"id": "one", "text": "R2.50", "anchors": [[5.0, 5.0]]},
        {"id": "none", "text": "orphan", "anchors": []},
        {
            "id": "bad-offset",
            "text": "10.00",
            "anchors": [[0.0, 0.0], [10.0, 0.0]],
            "labelOffset": ["x", 1],
        },
    ]
    svg = ds.emit_svg((297.0, 210.0), views, dims)
    assert '<circle cx="5" cy="205" r="2.5"' in svg
    assert '<path d="M 10 205' in svg
    assert ">R2.50</text>" in svg
    assert ">orphan</text>" not in svg
    assert 'x="5" y="205"' in svg


def test_svg_arc_path_sweep_flags() -> None:
    large = ds._svg_arc_path(
        {"center": [0.0, 0.0], "radius": 10.0, "startAngle": 0.0, "endAngle": 270.0}, 100.0
    )
    assert " 0 1 0 " in large
    small = ds._svg_arc_path(
        {"center": [0.0, 0.0], "radius": 10.0, "startAngle": 0.0, "endAngle": 90.0}, 100.0
    )
    assert " 0 0 0 " in small


# ---------------------------------------------------------------------------
# DXF emission variants
# ---------------------------------------------------------------------------


def test_emit_dxf_guard_without_ezdxf(monkeypatch) -> None:
    monkeypatch.setattr(ds, "HAS_EZDXF", False)
    monkeypatch.setattr(ds, "ezdxf", None)
    with pytest.raises(ds.DrawingError, match="ezdxf"):
        ds.emit_dxf((297.0, 210.0), [], [])


def test_emit_dxf_arcs_polylines_and_error_guards() -> None:
    _require_ezdxf()
    views = [
        {
            "id": "base",
            "visible": [
                {
                    "points": [[0.0, 0.0], [5.0, 5.0]],
                    "closed": False,
                    "arc": {
                        "kind": "arc",
                        "center": [0.0, 0.0],
                        "radius": 5.0,
                        "startAngle": 0.0,
                        "endAngle": 90.0,
                    },
                },
                {"points": [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]], "closed": True},
                {
                    "points": [[0.0, 0.0]],
                    "closed": False,
                    "circle": {"center": [None, 0.0], "radius": 1.0},
                },
            ],
            "hatchLoops": [{"loop": [["bad", "point"], [1.0, 1.0], [2.0, 2.0]], "area": 1.0}],
            "center": [5.0, 5.0],
        }
    ]
    dims = [
        {"id": "one", "text": "R2.50", "anchors": [[5.0, 5.0]]},
        {"id": "none", "text": "orphan", "anchors": []},
        {"id": "bad", "text": "10.00", "anchors": [[0.0, 0.0]], "labelOffset": None},
    ]
    dxf = ds.emit_dxf((297.0, 210.0), views, dims)
    assert "ARC" in dxf
    assert "LWPOLYLINE" in dxf
    assert "R2.50" in dxf
    assert "orphan" not in dxf


def test_emit_dxf_without_text_alignment_enum(monkeypatch) -> None:
    _require_ezdxf()
    monkeypatch.setitem(sys.modules, "ezdxf.enums", None)
    views = [{"id": "base", "visible": [], "center": [1.0, 2.0]}]
    dims = [{"id": "d", "text": "10.00", "anchors": [[0.0, 0.0], [10.0, 0.0]]}]
    dxf = ds.emit_dxf((297.0, 210.0), views, dims)
    assert "TEXT" in dxf
    assert "10.00" in dxf


# ---------------------------------------------------------------------------
# Model loading contract
# ---------------------------------------------------------------------------


def test_load_model_shape_missing_file_is_structured() -> None:
    with pytest.raises(ds.DrawingError, match="Model file not found"):
        ds._load_model_shape("/nonexistent/nuke-drawing.nuke-cad")


def test_load_model_shape_rejects_broken_json_and_versions(tmp_path: Path) -> None:
    broken = tmp_path / "broken.nuke-cad"
    broken.write_text("{not json", encoding="utf-8")
    with pytest.raises(ds.DrawingError, match="Failed to parse"):
        ds._load_model_shape(str(broken))

    array_doc = tmp_path / "array.nuke-cad"
    array_doc.write_text("[]", encoding="utf-8")
    with pytest.raises(ds.DrawingError, match="JSON object"):
        ds._load_model_shape(str(array_doc))

    future = _write_document(tmp_path / "future.nuke-cad", {"version": 9})
    with pytest.raises(ds.DrawingError, match="Unsupported .nuke-cad schema version"):
        ds._load_model_shape(str(future))


def test_load_model_shape_report_reference_validation_error(monkeypatch, tmp_path: Path) -> None:
    doc = _write_document(tmp_path / "bad-ref.nuke-cad", {"version": 3})
    monkeypatch.setattr(
        geometry_service,
        "_validate_document_refs",
        lambda _doc, _source: {"error": "bad reference"},
    )
    with pytest.raises(ds.DrawingError, match="bad reference"):
        ds._load_model_shape(str(doc))


def test_load_model_shape_requires_feature_builder(monkeypatch, tmp_path: Path) -> None:
    doc = _write_document(tmp_path / "box.nuke-cad", {"version": 3})
    monkeypatch.setattr(geometry_service, "_validate_document_refs", lambda _doc, _source: None)
    monkeypatch.setattr(geometry_service, "feature_builder", None)
    with pytest.raises(ds.DrawingError, match="requires build123d"):
        ds._load_model_shape(str(doc))


def test_load_model_shape_migrates_v1_through_v2(monkeypatch, tmp_path: Path) -> None:
    doc = _write_document(tmp_path / "v1.nuke-cad", {"version": 1})
    calls: list[str] = []
    monkeypatch.setattr(
        geometry_service,
        "_migrate_v1_to_v2",
        lambda document: calls.append("v1") or dict(document, version=2),
    )
    monkeypatch.setattr(
        geometry_service,
        "_migrate_v2_to_v3",
        lambda document: calls.append("v2") or dict(document, version=3, curves=[]),
    )
    monkeypatch.setattr(geometry_service, "_validate_document_refs", lambda _doc, _source: None)
    shape = _box_shape()
    builder = _FakeBuilder(result={"shape": _WrappedShape(shape), "warnings": ["loaded"]})
    monkeypatch.setattr(geometry_service, "feature_builder", builder)

    loaded, warnings = ds._load_model_shape(str(doc))
    assert loaded == shape
    assert warnings == ["loaded"]
    assert calls == ["v1", "v2"]
    assert builder.calls[0][0]["version"] == 3


def test_load_model_shape_curve_builder_guards(monkeypatch, tmp_path: Path) -> None:
    doc = _write_document(tmp_path / "curves.nuke-cad", {"version": 3, "curves": [{"id": "c1"}]})
    monkeypatch.setattr(geometry_service, "_validate_document_refs", lambda _doc, _source: None)
    shape = _box_shape()
    builder = _FakeBuilder(result={"shape": _WrappedShape(shape)})
    monkeypatch.setattr(geometry_service, "feature_builder", builder)

    monkeypatch.setattr(geometry_service, "HAS_CURVE_BUILDER", False)
    monkeypatch.setattr(geometry_service, "curve_builder", None)
    with pytest.raises(ds.DrawingError, match="curve builder is unavailable"):
        ds._load_model_shape(str(doc))

    monkeypatch.setattr(geometry_service, "HAS_CURVE_BUILDER", True)
    monkeypatch.setattr(
        geometry_service,
        "curve_builder",
        types.SimpleNamespace(
            build_curves=lambda _doc: (_ for _ in ()).throw(ValueError("bad curve"))
        ),
    )
    with pytest.raises(ds.DrawingError, match="Curve build failed"):
        ds._load_model_shape(str(doc))

    curve_results = {"c1": {"wire": "ok"}}
    monkeypatch.setattr(
        geometry_service,
        "curve_builder",
        types.SimpleNamespace(build_curves=lambda _doc: curve_results),
    )
    assert ds._load_model_shape(str(doc))[0] == shape
    assert builder.calls[-1][1]["curve_results"] is curve_results


def test_load_model_shape_document_build_failures(monkeypatch, tmp_path: Path) -> None:
    doc = _write_document(tmp_path / "box.nuke-cad", {"version": 3})
    monkeypatch.setattr(geometry_service, "_validate_document_refs", lambda _doc, _source: None)

    monkeypatch.setattr(
        geometry_service, "feature_builder", _FakeBuilder(error=RuntimeError("kaboom"))
    )
    with pytest.raises(ds.DrawingError, match="Document build failed: kaboom"):
        ds._load_model_shape(str(doc))

    monkeypatch.setattr(geometry_service, "feature_builder", _FakeBuilder(result={"shape": None}))
    with pytest.raises(ds.DrawingError, match="produced no solids"):
        ds._load_model_shape(str(doc))

    monkeypatch.setattr(
        geometry_service, "feature_builder", _FakeBuilder(result={"shape": _WrappedShape(None)})
    )
    with pytest.raises(ds.DrawingError, match="unsupported shape type"):
        ds._load_model_shape(str(doc))


def test_load_model_shape_grounded_assembly_paths(monkeypatch, tmp_path: Path) -> None:
    import assembly_builder

    doc = _write_document(
        tmp_path / "asm.nuke-cad",
        {"version": 3, "assembly": {"groundedInstanceId": "i1"}},
    )
    monkeypatch.setattr(geometry_service, "_validate_document_refs", lambda _doc, _source: None)
    monkeypatch.setattr(geometry_service, "feature_builder", _FakeBuilder(result={}))
    shape = _box_shape()

    monkeypatch.setattr(geometry_service, "HAS_ASSEMBLY_BUILDER", False)
    with pytest.raises(ds.DrawingError, match="requires the assembly builder"):
        ds._load_model_shape(str(doc))

    monkeypatch.setattr(geometry_service, "HAS_ASSEMBLY_BUILDER", True)
    monkeypatch.setattr(
        assembly_builder,
        "build_assembly_shape",
        lambda _doc, **_kwargs: (_ for _ in ()).throw(
            assembly_builder.AssemblyBuildError("assembly broke")
        ),
    )
    with pytest.raises(ds.DrawingError, match="assembly broke"):
        ds._load_model_shape(str(doc))

    monkeypatch.setattr(
        assembly_builder,
        "build_assembly_shape",
        lambda _doc, **_kwargs: (_ for _ in ()).throw(RuntimeError("kernel died")),
    )
    with pytest.raises(ds.DrawingError, match="Assembly build failed: kernel died"):
        ds._load_model_shape(str(doc))

    monkeypatch.setattr(
        assembly_builder, "build_assembly_shape", lambda _doc, **_kwargs: {"shape": None}
    )
    with pytest.raises(ds.DrawingError, match="Assembly produced no solids"):
        ds._load_model_shape(str(doc))

    monkeypatch.setattr(
        assembly_builder,
        "build_assembly_shape",
        lambda _doc, **_kwargs: {"shape": shape, "warnings": ["assembly warning"]},
    )
    loaded, warnings = ds._load_model_shape(str(doc))
    assert loaded == shape
    assert warnings == ["assembly warning"]


def test_load_model_shape_script_paths(monkeypatch, tmp_path: Path) -> None:
    script = tmp_path / "model.py"
    script.write_text("model = None\n", encoding="utf-8")
    shape = _box_shape()

    monkeypatch.setattr(
        geometry_service, "_execute_script_isolated", lambda _source: (shape, {}, None)
    )
    loaded, warnings = ds._load_model_shape(str(script))
    assert loaded == shape
    assert warnings == []

    monkeypatch.setattr(
        geometry_service,
        "_execute_script_isolated",
        lambda _source: (None, {}, {"error": "script exploded"}),
    )
    with pytest.raises(ds.DrawingError, match="script exploded"):
        ds._load_model_shape(str(script))

    monkeypatch.setattr(
        geometry_service, "_execute_script_isolated", lambda _source: (None, {}, None)
    )
    with pytest.raises(ds.DrawingError, match="Script produced no shape"):
        ds._load_model_shape(str(script))


# ---------------------------------------------------------------------------
# build_drawing contract
# ---------------------------------------------------------------------------


def test_build_drawing_rejects_non_document_input(monkeypatch, tmp_path: Path) -> None:
    script = tmp_path / "model.py"
    script.write_text("model = None\n", encoding="utf-8")
    monkeypatch.setattr(ds, "HAS_OCP", True)
    _fake_loader(monkeypatch, shape=object())
    result = ds.build_drawing(str(script))
    assert result["success"] is False
    assert "Drawings require a .nuke-cad document" in result["error"]


def test_build_drawing_document_structure_errors(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(ds, "HAS_OCP", True)
    _fake_loader(monkeypatch, shape=object())

    no_drawings = _write_document(tmp_path / "empty.nuke-cad", {"version": 3})
    result = ds.build_drawing(str(no_drawings))
    assert result["success"] is False
    assert "no drawings block" in result["error"]

    bad_size = _write_document(
        tmp_path / "size.nuke-cad",
        {"version": 3, "drawings": [{"id": "sheet-1", "size": "A0"}]},
    )
    result = ds.build_drawing(str(bad_size))
    assert result["success"] is False
    assert "Unknown sheet size" in result["error"]

    broken = tmp_path / "broken.nuke-cad"
    broken.write_text("{", encoding="utf-8")
    result = ds.build_drawing(str(broken))
    assert result["success"] is False
    assert "Failed to parse" in result["error"]


def test_build_drawing_defaults_to_first_sheet(monkeypatch, tmp_path: Path) -> None:
    _require_ocp()
    doc = _write_document(tmp_path / "sheet.nuke-cad", {"version": 3, "drawings": [_base_sheet()]})
    _fake_loader(monkeypatch, shape=_box_shape())
    result = ds.build_drawing(str(doc))
    assert result["success"] is True, result.get("error")
    assert result["sheetId"] == "sheet-1"
    assert any("No sheet-id given" in warning for warning in result["warnings"])


def test_build_drawing_surfaces_dxf_failure_and_unexpected_errors(
    monkeypatch, tmp_path: Path
) -> None:
    _require_ocp()
    doc = _write_document(tmp_path / "sheet.nuke-cad", {"version": 3, "drawings": [_base_sheet()]})
    _fake_loader(monkeypatch, shape=_box_shape())

    def _broken_dxf(*_args, **_kwargs):
        raise ds.DrawingError("DXF exploded")

    monkeypatch.setattr(ds, "emit_dxf", _broken_dxf)
    result = ds.build_drawing(str(doc), "sheet-1")
    assert result["success"] is True
    assert result["dxf"] is None
    assert result["dxfError"] == "DXF exploded"
    assert "DXF exploded" in result["warnings"]

    def _broken_loader(_path):
        raise RuntimeError("unexpected loader bug")

    monkeypatch.setattr(ds, "_load_model_shape", _broken_loader)
    result = ds.build_drawing(str(doc), "sheet-1")
    assert result["success"] is False
    assert "Drawing build failed: unexpected loader bug" in result["error"]
    assert "Traceback" in result["traceback"]
