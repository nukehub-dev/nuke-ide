#!/usr/bin/env python3
# Copyright (C) 2026 NukeHub and others.
# SPDX-License-Identifier: BSD-2-Clause
"""Orthographic drawing core for nuke-cad (Wave D1 backend).

Builds a single-sheet orthographic drawing from a ``.nuke-cad`` document:
base + projected views, one section view, one detail view, associative
linear/radial dimensions, and SVG + DXF export.

Projection uses exact OCP hidden-line removal (``HLRBRep_Algo`` +
``HLRBRep_HLRToShape``): one projector per view from the standard
orientation, with output per view as ``{visible: Polyline[],
hidden: Polyline[]}`` in sheet-mm 2D. Section views cut the body with a
``BRepAlgoAPI_Cut`` half-space box at ``sectionAxis/Fraction/Flip`` (same
axis convention as ``section-plane.ts``: the cut sits at
``min + fraction * (max - min)`` along the axis, the unflipped view keeps
the minimum side) and HLR the result; cut-face loops carry hatch metadata.
Detail views HLR the full body (clipping to the detail circle is
client-side). SVG is emitted natively via stdlib string building; DXF goes
through ``ezdxf`` (guarded optional import, structured error when absent).
PDF is not part of this phase.

RPC shape (``build_drawing``)::

    build_drawing(script_path, sheet_id) -> {
        'success': True,
        'sheetId': str, 'size': 'A4' | 'A3', 'orientation': 'landscape',
        'sheetSizeMm': [width, height],
        'views': [{
            'id': str, 'kind': str, 'orientation': str, 'scale': float,
            'position': [x, y], 'showHidden': bool,
            'visible': [Polyline], 'hidden': [Polyline],
            'hatchLoops': [{'loop': [[x, y], ...], 'area': float}],
            'sectionArea': float, 'center': [x, y],
        }],
        'dimensions': [{
            'id': str, 'kind': str, 'viewId': str,
            'value': float | None, 'stale': bool, 'text': str,
            'anchors': [[[x, y], ...]],
        }],
        'svg': str, 'dxf': str | None, 'dxfError': str | None,
        'warnings': [str],
    }

A ``Polyline`` is ``{'points': [[x, y], ...], 'closed': bool,
'circle': {'center': [x, y], 'radius': float} | None,
'arc': {'center': [x, y], 'radius': float,
'startAngle': float, 'endAngle': float} | None}``; analytic ``circle``/``arc``
metadata is present only where the projected 3D curve is analytic (a 3D
circle facing the view plane), otherwise the sampled ``points`` carry the
geometry and DXF falls back to ``LWPOLYLINE``. All 2D coordinates are
sheet-mm from the sheet bottom-left corner (y-up); SVG flips y internally.

Associativity: dimension ``TopologyRef`` targets are re-resolved against the
rebuilt shape via ``reference_resolver`` and values are recomputed from the
3D measurement. ``unmatched``/``ambiguous`` refs keep the last-good text and
set ``stale: True``.

This module stays importable in the minimal pytest profile (pytest + numpy
only): OCP, ``ezdxf``, and ``reference_resolver`` imports are guarded behind
``HAS_*`` flags with structured errors, never bare imports.
"""

from __future__ import annotations

import io
import json
import math
import sys
import traceback
from pathlib import Path
from typing import Any

# Ensure sibling modules are importable when run as a script.
_SCRIPT_DIR = Path(__file__).parent.resolve()
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

import numpy as np

# Optional heavy dependency: exact hidden-line removal + B-rep section cuts.
try:
    from OCP.Bnd import Bnd_Box
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepGProp import BRepGProp
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.GeomAbs import GeomAbs_Circle, GeomAbs_Line, GeomAbs_Plane
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt
    from OCP.GProp import GProp_GProps
    from OCP.HLRAlgo import HLRAlgo_Projector
    from OCP.HLRBRep import HLRBRep_Algo, HLRBRep_HLRToShape
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED, TopAbs_WIRE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    HAS_OCP = True
except ImportError:
    HAS_OCP = False

# Optional DXF dependency: guarded so SVG + polylines work without it.
try:
    import ezdxf  # type: ignore

    HAS_EZDXF = True
except ImportError:
    ezdxf = None  # type: ignore
    HAS_EZDXF = False

# Fingerprint resolver for associative dimensions; guards its own OCP import.
try:
    import reference_resolver

    HAS_REFERENCE_RESOLVER = True
except Exception:
    reference_resolver = None  # type: ignore
    HAS_REFERENCE_RESOLVER = False


class DrawingError(RuntimeError):
    """Structured drawing failure (returned as an error dict, never raised)."""


#: Landscape sheet sizes in sheet-mm (width, height), matching the fixed
#: A4/A3 landscape templates from the drawings brief.
SHEET_SIZES_MM: dict[str, tuple[float, float]] = {
    "A4": (297.0, 210.0),
    "A3": (420.0, 297.0),
}

#: Standard orientations. Each entry gives the eye-to-shape view direction
#: ``look`` plus the sheet-right / sheet-up basis in model coordinates. The
#: view directions match the viewport's ``setStandardView`` (Z-up model:
#: front looks along +Y, top looks down -Z, right looks along -X).
_ORIENTATIONS: dict[str, dict[str, tuple[float, float, float]]] = {
    "front": {"look": (0.0, 1.0, 0.0), "right": (1.0, 0.0, 0.0), "up": (0.0, 0.0, 1.0)},
    "top": {"look": (0.0, 0.0, -1.0), "right": (1.0, 0.0, 0.0), "up": (0.0, 1.0, 0.0)},
    "right": {"look": (-1.0, 0.0, 0.0), "right": (0.0, 1.0, 0.0), "up": (0.0, 0.0, 1.0)},
    "iso": {
        "look": (-0.5773502691896258, 0.5773502691896258, -0.5773502691896258),
        "right": (0.7071067811865476, 0.7071067811865476, 0.0),
        "up": (-0.4082482904638631, 0.4082482904638631, 0.8164965809277261),
    },
}

_AXIS_INDEX = {"x": 0, "y": 1, "z": 2}

#: Samples per non-linear edge when polygonizing projected HLR edges.
_EDGE_SAMPLES = 33

#: Relative residual threshold for the Kasa circle-fit fallback.
_KASA_TOLERANCE = 0.01


def _require_ocp() -> None:
    """Raise a structured error when OCP is required but unavailable."""
    if not HAS_OCP:
        raise DrawingError(
            "Drawing projection requires OCP (cadquery-ocp/build123d), "
            "which is not available in the active Python environment"
        )


def section_offset(axis: str, box_min: float, box_max: float, fraction: float) -> float:
    """Model-space cut position along ``axis``: ``min + fraction * (max - min)``.

    Pure function of the ``section-plane.ts`` convention (fraction clamped to
    [0, 1]); no OCP needed.
    """
    _ = axis
    clamped = min(1.0, max(0.0, float(fraction)))
    return float(box_min) + clamped * (float(box_max) - float(box_min))


def _view_frame(orientation: str) -> tuple[Any, Any, Any]:
    """Return ``(look, right, up)`` unit vectors for a standard orientation.

    The frame is orthonormal with ``right x up == -look`` (screen axes as
    seen by a viewer looking along ``look``), so drawings never mirror.
    """
    spec = _ORIENTATIONS.get(orientation)
    if spec is None:
        raise DrawingError(
            f"Unknown view orientation {orientation!r}; expected one of {sorted(_ORIENTATIONS)}"
        )
    look, right, up = spec["look"], spec["right"], spec["up"]
    cross = (
        right[1] * up[2] - right[2] * up[1],
        right[2] * up[0] - right[0] * up[2],
        right[0] * up[1] - right[1] * up[0],
    )
    if math.dist(cross, (-look[0], -look[1], -look[2])) > 1e-9:
        raise DrawingError(f"View orientation {orientation!r} has a mirrored frame")
    return look, right, up


def _shape_bbox(shape: Any) -> tuple[list[float], list[float], list[float], float]:
    """Return ``(min, max, center, diagonal)`` of an OCP shape."""
    _require_ocp()
    box = Bnd_Box()
    BRepBndLib.Add_s(shape, box)
    lo, hi = box.CornerMin(), box.CornerMax()
    lo_pt = [lo.X(), lo.Y(), lo.Z()]
    hi_pt = [hi.X(), hi.Y(), hi.Z()]
    center = [(a + b) / 2.0 for a, b in zip(lo_pt, hi_pt, strict=True)]
    diagonal = math.dist(lo_pt, hi_pt)
    return lo_pt, hi_pt, center, diagonal


def _hlr_edge_lists(
    shape: Any, center: list[float], diagonal: float, orientation: str
) -> tuple[list[Any], list[Any], dict[str, Any]]:
    """Run exact HLR for one view; return ``(visible, hidden, frame)``.

    Visible edges come from ``VCompound`` + ``OutLineVCompound`` (the latter
    carries silhouettes of curved surfaces); hidden edges from ``HCompound`` +
    ``OutLineHCompound``. ``Rg1``/``Iso`` compounds are subsets/auxiliary
    lines and are excluded so edges are never double-counted.

    ``frame`` maps HLR output coordinates to shape-relative view units (see
    :func:`_hlr_point_to_view`): the projector is built with an explicit
    ``(right, up)`` frame so the drawing orientation never depends on gp's
    automatic axis choice.
    """
    _require_ocp()
    look, right, up = _view_frame(orientation)
    # Shape-to-eye direction: with N == -look the projector frame
    # (X=right, Y=up, Z=N) satisfies X x Y == -look, i.e. screen axes as
    # seen by the viewer (no mirroring).
    normal = (-look[0], -look[1], -look[2])
    distance = 10.0 * diagonal + 1.0
    eye = gp_Pnt(
        center[0] - look[0] * distance,
        center[1] - look[1] * distance,
        center[2] - look[2] * distance,
    )
    axis = gp_Ax2(eye, gp_Dir(*normal), gp_Dir(*right))
    x_dir = axis.XDirection()
    y_dir = axis.YDirection()
    frame_right = (x_dir.X(), x_dir.Y(), x_dir.Z())
    frame_up = (y_dir.X(), y_dir.Y(), y_dir.Z())
    if math.dist(frame_right, right) > 1e-9 or math.dist(frame_up, up) > 1e-9:
        raise DrawingError(
            f"View orientation {orientation!r}: projector frame diverged from the drawing frame"
        )
    projector = HLRAlgo_Projector(axis)
    algo = HLRBRep_Algo()
    algo.Add(shape)
    algo.Projector(projector)
    algo.Update()
    algo.Hide()
    hlr = HLRBRep_HLRToShape(algo)

    def _collect(*compounds: str) -> list[Any]:
        edges: list[Any] = []
        for name in compounds:
            exp = TopExp_Explorer(getattr(hlr, name)(), TopAbs_EDGE)
            while exp.More():
                edges.append(TopoDS.Edge_s(exp.Current()))
                exp.Next()
        return edges

    visible = _collect("VCompound", "OutLineVCompound")
    hidden = _collect("HCompound", "OutLineHCompound")
    frame = {
        "right": frame_right,
        "up": frame_up,
        "center_u": sum(
            (c - e) * r
            for c, e, r in zip(center, (eye.X(), eye.Y(), eye.Z()), frame_right, strict=True)
        ),
        "center_v": sum(
            (c - e) * r
            for c, e, r in zip(center, (eye.X(), eye.Y(), eye.Z()), frame_up, strict=True)
        ),
    }
    return visible, hidden, frame


def _hlr_point_to_view(
    point: tuple[float, float, float], frame: dict[str, Any]
) -> tuple[float, float]:
    """Map an HLR output point to shape-relative view units ``(u, v)``.

    ``HLRBRep_HLRToShape`` emits edges in the projector's 2D frame embedded
    as ``(u, v, 0)`` (verified: output ranges track the view-plane axes, not
    world 3D). Subtracting the shape center's view position centers the
    drawing on the model.
    """
    return (point[0] - frame["center_u"], point[1] - frame["center_v"])


def _hlr_polyline_points(
    edge: Any, frame: dict[str, Any], scale: float, position: list[float]
) -> list[list[float]]:
    """Sample one HLR output edge straight to sheet-mm 2D."""
    raw = _sample_edge_points(edge)
    view_pts = [_hlr_point_to_view(p, frame) for p in raw]
    projected = [[position[0] + u * scale, position[1] + v * scale] for u, v in view_pts]
    deduped: list[list[float]] = []
    for pt in projected:
        if not deduped or math.dist(pt, deduped[-1]) > 1e-9:
            deduped.append(pt)
    return deduped


def _sample_edge_points(edge: Any, count: int = _EDGE_SAMPLES) -> list[tuple[float, float, float]]:
    """Sample ``count`` 3D points uniformly along an edge (2 for lines)."""
    adaptor = BRepAdaptor_Curve(edge)
    first, last = adaptor.FirstParameter(), adaptor.LastParameter()
    if adaptor.GetType() == GeomAbs_Line:
        count = 2
    points: list[tuple[float, float, float]] = []
    for i in range(count):
        t = first if count == 1 else first + (last - first) * i / (count - 1)
        pnt = adaptor.Value(t)
        points.append((pnt.X(), pnt.Y(), pnt.Z()))
    return points


def _to_sheet(
    point: tuple[float, float, float],
    center: list[float],
    right: Any,
    up: Any,
    scale: float,
    position: list[float],
) -> list[float]:
    """Project a model point to sheet-mm 2D (y-up from the bottom-left)."""
    u = sum((c - o) * r for c, o, r in zip(point, center, right, strict=True))
    v = sum((c - o) * r for c, o, r in zip(point, center, up, strict=True))
    return [position[0] + u * scale, position[1] + v * scale]


def _project_points(
    points: list[tuple[float, float, float]],
    center: list[float],
    right: Any,
    up: Any,
    scale: float,
    position: list[float],
) -> list[list[float]]:
    """Project sampled model points to sheet-mm, dropping consecutive dupes."""
    projected = [_to_sheet(p, center, right, up, scale, position) for p in points]
    deduped: list[list[float]] = []
    for pt in projected:
        if not deduped or math.dist(pt, deduped[-1]) > 1e-9:
            deduped.append(pt)
    return deduped


def _analytic_circle(
    edge: Any, frame: dict[str, Any], scale: float, position: list[float]
) -> dict[str, Any] | None:
    """Return analytic 2D circle/arc metadata when the HLR edge is circular.

    HLR output already lives in the view plane, so a ``GeomAbs_Circle`` edge
    is a true 2D circle/arc. The sampled points verify circularity (guarding
    against non-uniform HLR parameterizations) before analytic metadata is
    attached; anything else stays polyline-only.
    """
    try:
        adaptor = BRepAdaptor_Curve(edge)
        if adaptor.GetType() != GeomAbs_Circle:
            return None
        circ = adaptor.Circle()
        loc = circ.Location()
        cu, cv = _hlr_point_to_view((loc.X(), loc.Y(), loc.Z()), frame)
        center_2d = [position[0] + cu * scale, position[1] + cv * scale]
        radius = circ.Radius() * scale
        pts2d = _hlr_polyline_points(edge, frame, scale, position)
        if len(pts2d) >= 3:
            residual = max(abs(math.dist(pt, center_2d) - radius) / radius for pt in pts2d)
            if residual > 1e-6:
                return None
        if BRep_Tool.IsClosed_s(edge):
            return {"kind": "circle", "center": center_2d, "radius": radius}
        if len(pts2d) < 3:
            return None

        def _angle(pt: list[float]) -> float:
            return math.degrees(math.atan2(pt[1] - center_2d[1], pt[0] - center_2d[0]))

        a0, a1 = _angle(pts2d[0]), _angle(pts2d[-1])
        mid = _angle(pts2d[len(pts2d) // 2])

        def _on_ccw(start: float, end: float, probe: float) -> bool:
            sweep = (end - start) % 360.0
            return ((probe - start) % 360.0) <= sweep

        if _on_ccw(a0, a1, mid):
            start, end = a0, a1
        else:
            start, end = a1, a0
        return {
            "kind": "arc",
            "center": center_2d,
            "radius": radius,
            "startAngle": start,
            "endAngle": end,
        }
    except Exception:
        return None


def _edge_to_polyline(
    edge: Any, frame: dict[str, Any], scale: float, position: list[float]
) -> dict[str, Any] | None:
    """Convert one HLR output edge to a sheet-mm polyline (None if degenerate)."""
    try:
        closed = bool(BRep_Tool.IsClosed_s(edge))
        points = _hlr_polyline_points(edge, frame, scale, position)
        if len(points) < 2:
            return None
        if closed and len(points) > 2 and math.dist(points[0], points[-1]) > 1e-9:
            points.append(list(points[0]))
        analytic = _analytic_circle(edge, frame, scale, position)
        polyline: dict[str, Any] = {"points": points, "closed": closed}
        if analytic is not None and analytic["kind"] == "circle":
            polyline["circle"] = {"center": analytic["center"], "radius": analytic["radius"]}
        elif analytic is not None:
            polyline["arc"] = analytic
        return polyline
    except Exception:
        return None


def _apply_section_cut(
    shape: Any, axis: str, fraction: float, flip: bool
) -> tuple[Any, list[dict[str, Any]]]:
    """Cut ``shape`` with a half-space box; return ``(cut, cut_faces)``.

    The cut sits at ``min + fraction * (max - min)`` along ``axis`` (the
    ``section-plane.ts`` convention); the unflipped view keeps the minimum
    side, ``flip`` keeps the maximum side. The half-space tool covers the
    *removed* half (``BRepAlgoAPI_Cut`` subtracts), and ``cut_faces`` carries
    the planar faces lying on the cut plane with model-unit areas for hatching.
    """
    _require_ocp()
    if axis not in _AXIS_INDEX:
        raise DrawingError(f"Unknown section axis {axis!r}; expected 'x', 'y', or 'z'")
    lo, hi, _center, diagonal = _shape_bbox(shape)
    index = _AXIS_INDEX[axis]
    offset = section_offset(axis, lo[index], hi[index], fraction)
    margin = 10.0 * diagonal + 1.0
    box_lo = [lo[i] - margin for i in range(3)]
    box_hi = [hi[i] + margin for i in range(3)]
    if flip:
        box_hi[index] = offset
    else:
        box_lo[index] = offset
    tool = BRepPrimAPI_MakeBox(
        gp_Pnt(box_lo[0], box_lo[1], box_lo[2]),
        gp_Pnt(box_hi[0], box_hi[1], box_hi[2]),
    ).Shape()
    cutter = BRepAlgoAPI_Cut(shape, tool)
    cutter.Build()
    if not cutter.IsDone():
        raise DrawingError("Section cut failed (boolean operation did not complete)")
    cut = cutter.Shape()
    tolerance = 1e-6 * max(1.0, diagonal)
    cut_faces: list[dict[str, Any]] = []
    exp = TopExp_Explorer(cut, TopAbs_FACE)
    while exp.More():
        face = TopoDS.Face_s(exp.Current())
        try:
            surf = BRepAdaptor_Surface(face)
            if surf.GetType() == GeomAbs_Plane:
                plane = surf.Plane()
                loc = plane.Location()
                normal = plane.Axis().Direction()
                coords = (loc.X(), loc.Y(), loc.Z())
                dirs = (normal.X(), normal.Y(), normal.Z())
                if abs(abs(dirs[index]) - 1.0) < 1e-9 and abs(coords[index] - offset) <= tolerance:
                    props = GProp_GProps()
                    BRepGProp.SurfaceProperties_s(face, props)
                    cut_faces.append({"face": face, "area": props.Mass()})
        except Exception:
            pass
        exp.Next()
    return cut, cut_faces


def _face_wire_loops(
    face: Any, center: list[float], right: Any, up: Any, scale: float, position: list[float]
) -> list[dict[str, Any]]:
    """Polygonize every wire of a cut face into sheet-mm hatch loops."""
    loops: list[dict[str, Any]] = []
    wire_exp = TopExp_Explorer(face, TopAbs_WIRE)
    while wire_exp.More():
        wire = wire_exp.Current()
        points_2d: list[list[float]] = []
        edge_exp = TopExp_Explorer(wire, TopAbs_EDGE)
        while edge_exp.More():
            try:
                edge = TopoDS.Edge_s(edge_exp.Current())
                pts = _project_points(
                    _sample_edge_points(edge, 17), center, right, up, scale, position
                )
                # Wire traversal order follows edge orientation: REVERSED
                # edges run end-to-start and must be flipped, otherwise the
                # loop zigzags and the shoelace area collapses.
                if edge.Orientation() == TopAbs_REVERSED:
                    pts = list(reversed(pts))
                if points_2d and pts and math.dist(pts[0], points_2d[-1]) > 1e-9:
                    flipped = list(reversed(pts))
                    if math.dist(flipped[0], points_2d[-1]) <= 1e-9:
                        pts = flipped
                for pt in pts:
                    if not points_2d or math.dist(pt, points_2d[-1]) > 1e-9:
                        points_2d.append(pt)
            except Exception:
                pass
            edge_exp.Next()
        if len(points_2d) >= 3:
            if math.dist(points_2d[0], points_2d[-1]) > 1e-9:
                points_2d.append(list(points_2d[0]))
            area = 0.0
            for i in range(len(points_2d) - 1):
                area += (
                    points_2d[i][0] * points_2d[i + 1][1] - points_2d[i + 1][0] * points_2d[i][1]
                )
            loops.append({"loop": points_2d, "area": abs(area) / 2.0 / (scale * scale)})
        wire_exp.Next()
    return loops


def project_view(
    shape: Any, view: dict[str, Any], center: list[float], diagonal: float
) -> dict[str, Any]:
    """Project one drawing view to sheet-mm linework (HLR, full profile).

    Section views cut first via :func:`_apply_section_cut`; detail views HLR
    the full body (clipping to the detail circle is client-side).
    """
    _require_ocp()
    orientation = view.get("orientation", "front")
    scale = float(view.get("scale", 1.0))
    position = [float(v) for v in view.get("position", [0.0, 0.0])]
    if scale <= 0.0:
        raise DrawingError(f"View {view.get('id')!r} has non-positive scale {scale}")
    look, right, up = _view_frame(orientation)
    target = shape
    hatch_loops: list[dict[str, Any]] = []
    section_area = 0.0
    warnings: list[str] = []
    if view.get("kind") == "section":
        axis = view.get("sectionAxis", "z")
        fraction = float(view.get("sectionFraction", 0.5))
        flip = bool(view.get("sectionFlip", False))
        target, cut_faces = _apply_section_cut(shape, axis, fraction, flip)
        for entry in cut_faces:
            section_area += entry["area"]
            hatch_loops.extend(_face_wire_loops(entry["face"], center, right, up, scale, position))
        if not cut_faces:
            warnings.append(
                f"Section view {view.get('id')!r} produced no cut faces "
                f"(axis {axis} fraction {fraction})"
            )
    visible_edges, hidden_edges, frame = _hlr_edge_lists(target, center, diagonal, orientation)
    visible: list[dict[str, Any]] = []
    for edge in visible_edges:
        polyline = _edge_to_polyline(edge, frame, scale, position)
        if polyline is not None:
            visible.append(polyline)
    hidden: list[dict[str, Any]] = []
    if view.get("showHidden", False):
        for edge in hidden_edges:
            polyline = _edge_to_polyline(edge, frame, scale, position)
            if polyline is not None:
                hidden.append(polyline)
    return {
        "id": view.get("id"),
        "kind": view.get("kind", "base"),
        "orientation": orientation,
        "scale": scale,
        "position": position,
        "showHidden": bool(view.get("showHidden", False)),
        "visible": visible,
        "hidden": hidden,
        "hatchLoops": hatch_loops,
        "sectionArea": section_area,
        "center": _to_sheet(tuple(center), center, right, up, scale, position),
        "warnings": warnings,
    }


def project_shape(shape: Any, sheet: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    """Project every view of ``sheet``; return ``(views, warnings)``."""
    _require_ocp()
    _lo, _hi, center, diagonal = _shape_bbox(shape)
    views: list[dict[str, Any]] = []
    warnings: list[str] = []
    for view in sheet.get("views", []):
        out = project_view(shape, view, center, diagonal)
        warnings.extend(out.pop("warnings", []))
        views.append(out)
    return views, warnings


def _kasa_circle_fit(points: list[tuple[float, float, float]]) -> tuple[list[float], float] | None:
    """Kasa least-squares circle fit of 3D points in their best-fit plane.

    Mirrors the ``radius-fit.ts`` fallback: returns ``(center, radius)`` or
    None when the points are not circular (relative residual above threshold).
    Pure numpy; no OCP needed.
    """
    if len(points) < 3:
        return None
    data = np.asarray(points, dtype=float)
    centroid = data.mean(axis=0)
    try:
        _u, _s, vh = np.linalg.svd(data - centroid, full_matrices=False)
    except np.linalg.LinAlgError:
        return None
    normal = vh[-1]
    if float(np.linalg.norm(normal)) == 0.0:
        return None
    normal = normal / float(np.linalg.norm(normal))
    basis_u = data - centroid
    axis0 = basis_u[0] - normal * float(np.dot(basis_u[0], normal))
    if float(np.linalg.norm(axis0)) < 1e-12:
        axis0 = basis_u[len(basis_u) // 2] - normal * float(
            np.dot(basis_u[len(basis_u) // 2], normal)
        )
    if float(np.linalg.norm(axis0)) < 1e-12:
        return None
    axis0 = axis0 / float(np.linalg.norm(axis0))
    axis1 = np.cross(normal, axis0)
    coords = np.stack([np.dot(data - centroid, axis0), np.dot(data - centroid, axis1)], axis=1)
    mat = np.column_stack([2.0 * coords[:, 0], 2.0 * coords[:, 1], np.ones(len(coords))])
    rhs = coords[:, 0] ** 2 + coords[:, 1] ** 2
    try:
        solution, _res, _rank, _sv = np.linalg.lstsq(mat, rhs, rcond=None)
    except np.linalg.LinAlgError:
        return None
    cx, cy, c = (float(v) for v in solution)
    radius_sq = c + cx * cx + cy * cy
    if radius_sq <= 0.0:
        return None
    radius = math.sqrt(radius_sq)
    predicted = np.sqrt((coords[:, 0] - cx) ** 2 + (coords[:, 1] - cy) ** 2)
    residual = float(np.sqrt(np.mean((predicted - radius) ** 2)) / radius)
    if residual > _KASA_TOLERANCE or not math.isfinite(radius):
        return None
    center_3d = centroid + axis0 * cx + axis1 * cy
    return [float(center_3d[0]), float(center_3d[1]), float(center_3d[2])], float(radius)


def _resolve_anchor(ref: dict[str, Any], shape: Any) -> tuple[list[float], float | None] | None:
    """Resolve one ``TopologyRef`` to ``(3D anchor, radius|None)``.

    Returns None when the ref is ``unmatched``/``ambiguous`` (the caller
    applies the stale path). Radius comes from fingerprint data (circle edge
    center axis, cylindrical/spherical face radius) or the Kasa fallback.
    """
    if not HAS_REFERENCE_RESOLVER or reference_resolver is None:
        raise DrawingError(
            "Associative dimensions require reference_resolver "
            "(reference_resolver.py could not be imported)"
        )
    _require_ocp()
    fingerprint = reference_resolver.topology_ref_to_fingerprint(ref)
    match_result, entities = reference_resolver.resolve_references_with_entities(
        [fingerprint], shape
    )
    if not match_result.matches or match_result.matches[0].status != "matched":
        return None
    entity = entities.get(match_result.matches[0].candidate_id or "")
    if entity is None:
        return None
    kind = ref.get("kind")
    if kind == "edge":
        adaptor = BRepAdaptor_Curve(entity)
        if adaptor.GetType() == GeomAbs_Circle:
            circ = adaptor.Circle()
            loc = circ.Location()
            return [loc.X(), loc.Y(), loc.Z()], float(circ.Radius())
        first, last = adaptor.FirstParameter(), adaptor.LastParameter()
        mid = adaptor.Value((first + last) / 2.0)
        anchor = [mid.X(), mid.Y(), mid.Z()]
        radius: float | None = None
        fit = _kasa_circle_fit(_sample_edge_points(entity))
        if fit is not None:
            anchor, radius = fit
        return anchor, radius
    if kind == "face":
        props = GProp_GProps()
        BRepGProp.SurfaceProperties_s(entity, props)
        com = props.CentreOfMass()
        radius_value = fingerprint.radius
        return [com.X(), com.Y(), com.Z()], radius_value
    raise DrawingError(f"Unsupported dimension target kind {kind!r}")


def _format_value(value: float) -> str:
    """Format a dimension value for SVG/DXF text (model units)."""
    return f"{value:.2f}"


def compute_dimensions(
    dimensions: list[dict[str, Any]], shape: Any, frames: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    """Recompute dimension values from 3D; stale refs keep last-good text."""
    results: list[dict[str, Any]] = []
    for dim in dimensions:
        dim_id = dim.get("id")
        kind = dim.get("kind", "distance")
        view_id = dim.get("viewId")
        frame = frames.get(view_id or "")
        targets = dim.get("targets", [])
        last_value = dim.get("value")
        last_text = dim.get("text")
        if last_text is None and isinstance(last_value, (int, float)):
            last_text = _format_value(float(last_value))
        entry: dict[str, Any] = {
            "id": dim_id,
            "kind": kind,
            "viewId": view_id,
            # The reference spec rides through so rebuilt outputs re-resolve
            # (associativity: last-good value/text + targets survive a rebuild).
            "targets": targets,
            "value": last_value,
            "stale": False,
            "text": last_text if isinstance(last_text, str) else "?",
            "anchors": [],
        }
        if dim.get("labelOffset") is not None:
            entry["labelOffset"] = dim.get("labelOffset")
        try:
            if frame is None:
                raise DrawingError(f"Dimension {dim_id!r} references unknown view {view_id!r}")
            resolved: list[tuple[list[float], float | None]] = []
            broken = False
            for target in targets:
                anchor = _resolve_anchor(target, shape)
                if anchor is None:
                    broken = True
                    break
                resolved.append(anchor)
            if broken:
                entry["stale"] = True
            elif kind == "distance" and len(resolved) == 2:
                value = math.dist(resolved[0][0], resolved[1][0])
                entry["value"] = value
                entry["text"] = _format_value(value)
                entry["anchors"] = [
                    _to_sheet(
                        tuple(a[0]),
                        frame["center"],
                        frame["right"],
                        frame["up"],
                        frame["scale"],
                        frame["position"],
                    )
                    for a in resolved
                ]
            elif kind in ("radius", "diameter") and len(resolved) == 1:
                radius = resolved[0][1]
                if radius is None or radius <= 0.0:
                    raise DrawingError(
                        f"Dimension {dim_id!r}: target is not circular (Kasa fit rejected)"
                    )
                value = radius if kind == "radius" else 2.0 * radius
                entry["value"] = value
                entry["text"] = _format_value(value)
                entry["anchors"] = [
                    _to_sheet(
                        tuple(resolved[0][0]),
                        frame["center"],
                        frame["right"],
                        frame["up"],
                        frame["scale"],
                        frame["position"],
                    )
                ]
            else:
                raise DrawingError(
                    f"Dimension {dim_id!r}: kind {kind!r} needs "
                    f"{1 if kind in ('radius', 'diameter') else 2} target(s)"
                )
        except DrawingError as exc:
            entry["stale"] = True
            entry["note"] = str(exc)
        results.append(entry)
    return results


def _view_frames(sheet: dict[str, Any], center: list[float]) -> dict[str, dict[str, Any]]:
    """Build per-view projection frames for dimension anchor projection."""
    frames: dict[str, dict[str, Any]] = {}
    for view in sheet.get("views", []):
        view_id = view.get("id")
        if not isinstance(view_id, str):
            continue
        try:
            look, right, up = _view_frame(view.get("orientation", "front"))
        except DrawingError:
            continue
        frames[view_id] = {
            "center": center,
            "look": look,
            "right": right,
            "up": up,
            "scale": float(view.get("scale", 1.0)),
            "position": [float(v) for v in view.get("position", [0.0, 0.0])],
        }
    return frames


def _fmt(value: float) -> str:
    """Format a sheet-mm coordinate (compact, deterministic)."""
    text = f"{value:.3f}"
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text if text else "0"


def _svg_polyline(points: list[list[float]], flip_y: float, extra: str = "") -> str:
    """Emit one polyline/polygon as an SVG ``<polyline>``/``<polygon>``."""
    coords = " ".join(f"{_fmt(x)},{_fmt(flip_y - y)}" for x, y in points)
    return f'<polyline points="{coords}"{extra} />'


def emit_svg(
    sheet_size: tuple[float, float], views: list[dict[str, Any]], dimensions: list[dict[str, Any]]
) -> str:
    """Emit the drawing sheet as an SVG string (stdlib only, no new dep)."""
    width, height = sheet_size
    parts: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{_fmt(width)}mm" '
        f'height="{_fmt(height)}mm" viewBox="0 0 {_fmt(width)} {_fmt(height)}">',
        '<defs><pattern id="ansi31" width="3" height="3" patternTransform="rotate(45)" '
        'patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0" y2="3" '
        'stroke="#000" stroke-width="0.25" /></pattern></defs>',
        f'<rect x="0" y="0" width="{_fmt(width)}" height="{_fmt(height)}" '
        'fill="none" stroke="#000" stroke-width="0.5" />',
    ]
    for view in views:
        parts.append(f'<g id="view-{view["id"]}">')
        for polyline in view.get("visible", []):
            circle = polyline.get("circle")
            arc = polyline.get("arc")
            if circle is not None:
                cx, cy = circle["center"]
                parts.append(
                    f'<circle cx="{_fmt(cx)}" cy="{_fmt(height - cy)}" '
                    f'r="{_fmt(circle["radius"])}" fill="none" stroke="#000" '
                    'stroke-width="0.35" />'
                )
            elif arc is not None:
                arc_path = _svg_arc_path(arc, height)
                parts.append(
                    f'<path d="{arc_path}" fill="none" stroke="#000" stroke-width="0.35" />'
                )
            else:
                parts.append(
                    _svg_polyline(
                        polyline["points"],
                        height,
                        ' fill="none" stroke="#000" stroke-width="0.35"',
                    )
                )
        for polyline in view.get("hidden", []):
            parts.append(
                _svg_polyline(
                    polyline["points"],
                    height,
                    ' fill="none" stroke="#000" stroke-width="0.25" stroke-dasharray="2,1"',
                )
            )
        for hatch in view.get("hatchLoops", []):
            coords = " ".join(f"{_fmt(x)},{_fmt(height - y)}" for x, y in hatch["loop"])
            parts.append(
                f'<polygon points="{coords}" fill="url(#ansi31)" stroke="#000" '
                'stroke-width="0.25" />'
            )
        cx, cy = view.get("center", [0.0, 0.0])
        parts.append(
            f'<g id="center-{view["id"]}" stroke="#000" stroke-width="0.2">'
            f'<line x1="{_fmt(cx - 3)}" y1="{_fmt(height - cy)}" '
            f'x2="{_fmt(cx + 3)}" y2="{_fmt(height - cy)}" />'
            f'<line x1="{_fmt(cx)}" y1="{_fmt(height - cy - 3)}" '
            f'x2="{_fmt(cx)}" y2="{_fmt(height - cy + 3)}" /></g>'
        )
        parts.append("</g>")
    for dim in dimensions:
        anchors = dim.get("anchors", [])
        label = dim.get("text", "?")
        if len(anchors) >= 2:
            mx = sum(p[0] for p in anchors) / len(anchors)
            my = sum(p[1] for p in anchors) / len(anchors)
        elif len(anchors) == 1:
            mx, my = anchors[0]
        else:
            continue
        offset = dim.get("labelOffset", [0.0, 5.0])
        try:
            dx, dy = float(offset[0]), float(offset[1])
        except (TypeError, ValueError, IndexError):
            dx, dy = 0.0, 5.0
        parts.append(
            f'<text x="{_fmt(mx + dx)}" y="{_fmt(height - (my + dy))}" '
            f'font-size="3.5" text-anchor="middle">{label}</text>'
        )
    parts.append("</svg>")
    return "\n".join(parts)


def _svg_arc_path(arc: dict[str, Any], sheet_height: float) -> str:
    """Emit an analytic arc as an SVG path (sweep flag from angle order)."""
    cx, cy = arc["center"]
    radius = arc["radius"]
    start = math.radians(arc["startAngle"])
    end = math.radians(arc["endAngle"])
    x0, y0 = cx + radius * math.cos(start), cy + radius * math.sin(start)
    x1, y1 = cx + radius * math.cos(end), cy + radius * math.sin(end)
    sweep = (arc["endAngle"] - arc["startAngle"]) % 360.0
    large = 1 if sweep > 180.0 else 0
    return (
        f"M {_fmt(x0)} {_fmt(sheet_height - y0)} "
        f"A {_fmt(radius)} {_fmt(radius)} 0 {large} 0 {_fmt(x1)} {_fmt(sheet_height - y1)}"
    )


def emit_dxf(
    sheet_size: tuple[float, float], views: list[dict[str, Any]], dimensions: list[dict[str, Any]]
) -> str:
    """Emit the drawing sheet as a DXF string (requires ``ezdxf``).

    Entities: ``LINE`` (visible) on ``VISIBLE``, dashed ``LINE`` (hidden) on
    ``HIDDEN``, ``CIRCLE``/``ARC`` where the projected curve is analytic else
    ``LWPOLYLINE``, ``HATCH`` (section faces) on ``SECTION``, ``TEXT``
    (dimensions) on ``DIMENSION``, center marks on ``CENTER``.
    """
    if not HAS_EZDXF or ezdxf is None:
        raise DrawingError(
            "DXF export requires the ezdxf package (pip install ezdxf==1.4.2); "
            "SVG output is unaffected"
        )
    doc = ezdxf.new()
    msp = doc.modelspace()
    for layer in ("VISIBLE", "HIDDEN", "SECTION", "DIMENSION", "CENTER"):
        if layer not in doc.layers:
            doc.layers.add(layer)
    try:
        dashed = doc.linetypes.get("DASHED")
    except Exception:
        dashed = None
    if dashed is None:
        try:
            doc.linetypes.add_new("DASHED", [0.0, [0.5, -0.25]], description="dashed")
        except Exception:
            pass
    for view in views:
        for polyline in view.get("visible", []):
            _dxf_add_polyline(msp, polyline, "VISIBLE", None)
        for polyline in view.get("hidden", []):
            _dxf_add_polyline(msp, polyline, "HIDDEN", "DASHED")
        for hatch in view.get("hatchLoops", []):
            try:
                dxf_hatch = msp.add_hatch(dxfattribs={"layer": "SECTION"})
                dxf_hatch.set_pattern_fill("ANSI31", scale=1.0)
                dxf_hatch.paths.add_polyline_path(
                    [(float(x), float(y)) for x, y in hatch["loop"]], is_closed=True
                )
            except Exception:
                pass
        cx, cy = view.get("center", [0.0, 0.0])
        msp.add_line((cx - 3.0, cy), (cx + 3.0, cy), dxfattribs={"layer": "CENTER"})
        msp.add_line((cx, cy - 3.0), (cx, cy + 3.0), dxfattribs={"layer": "CENTER"})
    for dim in dimensions:
        anchors = dim.get("anchors", [])
        label = dim.get("text", "?")
        if len(anchors) >= 2:
            mx = sum(p[0] for p in anchors) / len(anchors)
            my = sum(p[1] for p in anchors) / len(anchors)
        elif len(anchors) == 1:
            mx, my = anchors[0]
        else:
            continue
        offset = dim.get("labelOffset", [0.0, 5.0])
        try:
            dx, dy = float(offset[0]), float(offset[1])
        except (TypeError, ValueError, IndexError):
            dx, dy = 0.0, 5.0
        text = msp.add_text(label, height=3.5, dxfattribs={"layer": "DIMENSION"})
        try:
            from ezdxf.enums import TextEntityAlignment  # type: ignore

            align = TextEntityAlignment.MIDDLE_CENTER
        except ImportError:
            align = None
        if align is not None:
            text.set_placement((mx + dx, my + dy), align=align)
        else:
            text.set_placement((mx + dx, my + dy))
    stream = io.StringIO()
    doc.write(stream)
    return stream.getvalue()


def _dxf_add_polyline(msp: Any, polyline: dict[str, Any], layer: str, linetype: str | None) -> None:
    """Add one projected polyline to the DXF modelspace (analytic if known)."""
    attribs: dict[str, Any] = {"layer": layer}
    if linetype is not None:
        attribs["linetype"] = linetype
    circle = polyline.get("circle")
    arc = polyline.get("arc")
    try:
        if circle is not None:
            msp.add_circle(
                (float(circle["center"][0]), float(circle["center"][1])),
                float(circle["radius"]),
                dxfattribs=attribs,
            )
        elif arc is not None:
            msp.add_arc(
                (float(arc["center"][0]), float(arc["center"][1])),
                float(arc["radius"]),
                float(arc["startAngle"]),
                float(arc["endAngle"]),
                dxfattribs=attribs,
            )
        elif len(polyline.get("points", [])) == 2 and not polyline.get("closed"):
            (x0, y0), (x1, y1) = polyline["points"]
            msp.add_line((float(x0), float(y0)), (float(x1), float(y1)), dxfattribs=attribs)
        else:
            msp.add_lwpolyline(
                [(float(x), float(y)) for x, y in polyline["points"]],
                close=bool(polyline.get("closed")),
                dxfattribs=attribs,
            )
    except Exception:
        pass


def _load_model_shape(script_path: str) -> tuple[Any, list[str]]:
    """Load the model B-rep for a ``.py`` script or ``.nuke-cad`` document.

    Reuses ``geometry_service``'s script isolation and document feature
    pipeline (lazy import, so neither module pays the import cost unless
    drawings are built).
    """
    from geometry_service import (  # noqa: E402
        _execute_script_isolated,
        _migrate_v1_to_v2,
        _migrate_v2_to_v3,
        _validate_document_refs,
        feature_builder,
    )

    source = Path(script_path).resolve()
    if not source.exists():
        raise DrawingError(f"Model file not found: {script_path}")
    if source.suffix == ".nuke-cad":
        try:
            with source.open("r", encoding="utf-8") as fh:
                document = json.load(fh)
        except json.JSONDecodeError as exc:
            raise DrawingError(f"Failed to parse .nuke-cad document: {exc}") from exc
        if not isinstance(document, dict):
            raise DrawingError(".nuke-cad document must be a JSON object")
        version = document.get("version")
        if version not in (1, 2, 3):
            raise DrawingError(
                f"Unsupported .nuke-cad schema version {version!r}; expected 1, 2, or 3"
            )
        if version == 1:
            document = _migrate_v1_to_v2(document)
        if document.get("version") == 2:
            document = _migrate_v2_to_v3(document)
        ref_error = _validate_document_refs(document, source)
        if ref_error is not None:
            raise DrawingError(ref_error.get("error", "Document reference validation failed"))
        if feature_builder is None:
            raise DrawingError(
                "Drawing documents requires build123d, "
                "which is not available in the active Python environment"
            )
        curve_results: dict[str, dict[str, Any]] = {}
        curves = document.get("curves", [])
        if isinstance(curves, list) and curves:
            from geometry_service import HAS_CURVE_BUILDER, curve_builder  # noqa: E402

            if not HAS_CURVE_BUILDER or curve_builder is None:
                raise DrawingError("Document contains curves but the curve builder is unavailable")
            try:
                curve_results = curve_builder.build_curves(document)
            except Exception as exc:
                raise DrawingError(f"Curve build failed: {exc}") from exc
        try:
            build_result = feature_builder.build_document_shape(
                document, curve_results=curve_results
            )
        except Exception as exc:
            raise DrawingError(f"Document build failed: {exc}") from exc
        shape = build_result.get("shape")
        if shape is None:
            raise DrawingError("Document produced no solids; check feature results for failures")
        wrapped = getattr(shape, "wrapped", None)
        if wrapped is None:
            raise DrawingError("Document build returned an unsupported shape type")
        return wrapped, list(build_result.get("warnings", []))
    shape, _selector_map, error = _execute_script_isolated(source)
    if error is not None:
        raise DrawingError(error.get("error", "Script execution failed"))
    if shape is None:
        raise DrawingError("Script produced no shape")
    return shape, []


def build_drawing(
    script_path: str, sheet_id: str | None = None, output_dir: str | None = None
) -> dict[str, Any]:
    """Build a drawing sheet: HLR linework + dimensions + SVG/DXF strings.

    ``script_path`` is a ``.nuke-cad`` document (which owns the ``drawings``
    block) or a ``.py`` model script; ``sheet_id`` selects the sheet (the
    first sheet wins when omitted). ``output_dir`` is accepted for
    dispatch parity and is currently unused (no artifacts are written).
    """
    _ = output_dir
    warnings: list[str] = []
    try:
        _require_ocp()
        shape, load_warnings = _load_model_shape(script_path)
        warnings.extend(load_warnings)
        source = Path(script_path).resolve()
        if source.suffix != ".nuke-cad":
            return {
                "success": False,
                "error": "Drawings require a .nuke-cad document with a drawings block; "
                f"got {source.suffix or 'no suffix'} input",
                "scriptPath": str(source),
            }
        try:
            with source.open("r", encoding="utf-8") as fh:
                document = json.load(fh)
        except json.JSONDecodeError as exc:
            return {
                "success": False,
                "error": f"Failed to parse .nuke-cad document: {exc}",
                "scriptPath": str(source),
            }
        sheets = document.get("drawings", [])
        if not isinstance(sheets, list) or not sheets:
            return {
                "success": False,
                "error": "Document has no drawings block (add a DrawingSheet first)",
                "scriptPath": str(source),
            }
        if sheet_id is None:
            sheet = sheets[0]
            warnings.append(f"No sheet-id given; using first sheet {sheet.get('id')!r}")
        else:
            sheet = next((s for s in sheets if s.get("id") == sheet_id), None)
            if sheet is None:
                available = [s.get("id") for s in sheets if isinstance(s, dict)]
                return {
                    "success": False,
                    "error": f"Unknown sheet id {sheet_id!r}; available: {available}",
                    "scriptPath": str(source),
                }
        size = sheet.get("size", "A4")
        if size not in SHEET_SIZES_MM:
            return {
                "success": False,
                "error": f"Unknown sheet size {size!r}; expected 'A4' or 'A3'",
                "scriptPath": str(source),
            }
        sheet_size = SHEET_SIZES_MM[size]
        _lo, _hi, center, diagonal = _shape_bbox(shape)
        views, view_warnings = project_shape(shape, sheet)
        warnings.extend(view_warnings)
        frames = _view_frames(sheet, center)
        # Dimension label offsets ride on the stored spec (draggable labels
        # pin a sheet-mm offset, mirroring the sketch label convention).
        dimensions = compute_dimensions(sheet.get("dimensions", []), shape, frames)
        svg = emit_svg(sheet_size, views, dimensions)
        dxf: str | None = None
        dxf_error: str | None = None
        try:
            dxf = emit_dxf(sheet_size, views, dimensions)
        except DrawingError as exc:
            dxf_error = str(exc)
            warnings.append(dxf_error)
        return {
            "success": True,
            "sheetId": sheet.get("id"),
            "size": size,
            "orientation": sheet.get("orientation", "landscape"),
            "sheetSizeMm": list(sheet_size),
            "views": views,
            "dimensions": dimensions,
            "svg": svg,
            "dxf": dxf,
            "dxfError": dxf_error,
            "warnings": warnings,
            "scriptPath": str(source),
        }
    except DrawingError as exc:
        return {
            "success": False,
            "error": str(exc),
            "traceback": traceback.format_exc(),
            "scriptPath": str(script_path),
        }
    except Exception as exc:
        return {
            "success": False,
            "error": f"Drawing build failed: {exc}",
            "traceback": traceback.format_exc(),
            "scriptPath": str(script_path),
        }
