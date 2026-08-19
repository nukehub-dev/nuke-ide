#!/usr/bin/env python3
"""Topological fingerprint extraction and reference resolution for nuke-cad.

This module is OCP-bound: it extracts geometric fingerprints from an OCCT
B-rep and resolves named references against a rebuilt shape.  Heavy OCP
imports are guarded so the module stays importable in the minimal pytest
profile (pytest + numpy only).
"""

from __future__ import annotations

from typing import Any

from reference_scoring import (
    DEFAULT_TOLERANCE_SCALE,
    EdgeFingerprint,
    FaceFingerprint,
    MatchResult,
    match_references,
)

# Heavy dependencies are optional; the module must remain importable without them.
try:
    from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
    from OCP.BRepGProp import BRepGProp
    from OCP.GeomAbs import (
        GeomAbs_BezierCurve,
        GeomAbs_BezierSurface,
        GeomAbs_BSplineCurve,
        GeomAbs_BSplineSurface,
        GeomAbs_Circle,
        GeomAbs_Cone,
        GeomAbs_Cylinder,
        GeomAbs_Ellipse,
        GeomAbs_Hyperbola,
        GeomAbs_Line,
        GeomAbs_OffsetSurface,
        GeomAbs_Parabola,
        GeomAbs_Plane,
        GeomAbs_Sphere,
        GeomAbs_SurfaceOfExtrusion,
        GeomAbs_SurfaceOfRevolution,
        GeomAbs_Torus,
    )
    from OCP.GProp import GProp_GProps
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS
    from ocp_compat import ensure_topo_ds_static_aliases

    ensure_topo_ds_static_aliases()
    HAS_OCP = True
except ImportError:
    HAS_OCP = False


def _require_ocp() -> None:
    """Raise a clear error when OCP is required but unavailable."""
    if not HAS_OCP:
        raise RuntimeError("reference_resolver requires OCP (cadquery-ocp/build123d).")


def _gp_pnt_to_tuple(pnt: Any) -> tuple[float, float, float]:
    return (pnt.X(), pnt.Y(), pnt.Z())


def _gp_dir_to_tuple(d: Any) -> tuple[float, float, float]:
    return (d.X(), d.Y(), d.Z())


def _surface_type_string(surf: Any) -> str:
    stype = surf.GetType()
    if stype == GeomAbs_Plane:
        return "plane"
    if stype == GeomAbs_Cylinder:
        return "cylinder"
    if stype == GeomAbs_Cone:
        return "cone"
    if stype == GeomAbs_Sphere:
        return "sphere"
    if stype == GeomAbs_Torus:
        return "torus"
    if stype == GeomAbs_SurfaceOfRevolution:
        return "revolution"
    if stype == GeomAbs_SurfaceOfExtrusion:
        return "extrusion"
    if stype == GeomAbs_OffsetSurface:
        return "offset"
    if stype == GeomAbs_BSplineSurface:
        return "bspline"
    if stype == GeomAbs_BezierSurface:
        return "bezier"
    return "other"


def _curve_type_string(curv: Any) -> str:
    ctype = curv.GetType()
    if ctype == GeomAbs_Line:
        return "line"
    if ctype == GeomAbs_Circle:
        return "circle"
    if ctype == GeomAbs_Ellipse:
        return "ellipse"
    if ctype == GeomAbs_Parabola:
        return "parabola"
    if ctype == GeomAbs_Hyperbola:
        return "hyperbola"
    if ctype == GeomAbs_BSplineCurve:
        return "bspline"
    if ctype == GeomAbs_BezierCurve:
        return "bezier"
    return "other"


def _axis_from_gp_ax1(axis: Any) -> dict[str, Any]:
    """Build an ``Axis`` dict from an OCCT ``gp_Ax1``."""
    return {
        "origin": _gp_pnt_to_tuple(axis.Location()),
        "direction": _gp_dir_to_tuple(axis.Direction()),
    }


def _extract_face_fingerprint(face: Any) -> dict[str, Any] | None:
    """Build a raw face fingerprint from a ``TopoDS_Face``.

    Returns ``None`` if the face is degenerate or otherwise unprocessable.
    """
    try:
        surf = BRepAdaptor_Surface(face)
        stype = _surface_type_string(surf)

        props = GProp_GProps()
        BRepGProp.SurfaceProperties_s(face, props)
        area = props.Mass()
        com = props.CentreOfMass()
        center = _gp_pnt_to_tuple(com)

        data: dict[str, Any] = {
            "surface_type": stype,
            "area": area,
            "center": center,
        }

        if stype == "plane":
            normal = _gp_dir_to_tuple(surf.Plane().Axis().Direction())
            data["normal"] = normal
        elif stype == "cylinder":
            cyl = surf.Cylinder()
            data["axis"] = _axis_from_gp_ax1(cyl.Axis())
            data["radius"] = cyl.Radius()
        elif stype == "cone":
            cone = surf.Cone()
            data["axis"] = _axis_from_gp_ax1(cone.Axis())
            data["radius"] = cone.Radius()
        elif stype == "sphere":
            sph = surf.Sphere()
            data["radius"] = sph.Radius()
        elif stype == "torus":
            tor = surf.Torus()
            data["axis"] = _axis_from_gp_ax1(tor.Axis())
            data["radius"] = tor.MajorRadius()
            data["minor_radius"] = tor.MinorRadius()
        elif stype == "revolution":
            data["axis"] = _axis_from_gp_ax1(surf.Axis())

        return data
    except Exception:
        return None


def _extract_edge_fingerprint(edge: Any) -> dict[str, Any] | None:
    """Build a raw edge fingerprint from a ``TopoDS_Edge``.

    Returns ``None`` if the edge is degenerate or otherwise unprocessable.
    """
    try:
        curv = BRepAdaptor_Curve(edge)
        ctype = _curve_type_string(curv)

        props = GProp_GProps()
        BRepGProp.LinearProperties_s(edge, props)
        length = props.Mass()

        first = curv.FirstParameter()
        last = curv.LastParameter()
        start = _gp_pnt_to_tuple(curv.Value(first))
        end = _gp_pnt_to_tuple(curv.Value(last))

        data: dict[str, Any] = {
            "curve_type": ctype,
            "length": length,
            "start": start,
            "end": end,
        }

        if ctype in ("circle", "ellipse"):
            circ = curv.Circle() if ctype == "circle" else curv.Ellipse()
            data["center"] = _gp_pnt_to_tuple(circ.Location())

        return data
    except Exception:
        return None


def _stable_candidate_id(kind: str, index: int) -> str:
    return f"{kind}_{index:04d}"


def _rounded(value: float, decimals: int = 9) -> float:
    return round(float(value), decimals)


def _canonical_endpoints(
    start: tuple[float, float, float], end: tuple[float, float, float]
) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    """Return endpoints in a deterministic order for duplicate detection."""
    return (end, start) if start > end else (start, end)


def _face_orientation_key(data: dict[str, Any]) -> tuple:
    """Return a hashable orientation descriptor for face deduplication."""
    if data.get("normal") is not None:
        normal = data["normal"]
        return ("normal", _rounded(normal[0]), _rounded(normal[1]), _rounded(normal[2]))
    if data.get("axis") is not None:
        direction = data["axis"]["direction"]
        return ("axis", _rounded(direction[0]), _rounded(direction[1]), _rounded(direction[2]))
    return ("none",)


def extract_face_fingerprints(
    shape: Any, warnings: list[str] | None = None
) -> list[FaceFingerprint]:
    """Extract deterministic face fingerprints from a ``TopoDS_Shape``.

    Faces are sorted by descending area (then by center coordinates) before
    receiving stable ``face_0001`` style ids so repeated extractions of the
    same shape produce the same candidate ids.  Degenerate faces are skipped
    and, if ``warnings`` is provided, a message is appended for each skip.
    """
    _require_ocp()

    raw: list[dict[str, Any]] = []
    seen: set[tuple] = set()
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = TopoDS.Face_s(explorer.Current())
        data = _extract_face_fingerprint(face)
        if data is None:
            if warnings is not None:
                warnings.append(
                    "Skipped a degenerate/unreadable face during fingerprint extraction."
                )
            explorer.Next()
            continue

        key = (
            data["surface_type"],
            _rounded(data["area"]),
            _rounded(data["center"][0]),
            _rounded(data["center"][1]),
            _rounded(data["center"][2]),
            _face_orientation_key(data),
            _rounded(data.get("radius") if data.get("radius") is not None else -1.0),
            _rounded(data.get("minor_radius") if data.get("minor_radius") is not None else -1.0),
        )
        if key not in seen:
            seen.add(key)
            raw.append(data)
        explorer.Next()

    raw.sort(key=lambda d: (-d["area"], d["center"]))
    return [
        FaceFingerprint(candidate_id=_stable_candidate_id("face", i + 1), **data)
        for i, data in enumerate(raw)
    ]


def extract_edge_fingerprints(
    shape: Any, warnings: list[str] | None = None
) -> list[EdgeFingerprint]:
    """Extract deterministic edge fingerprints from a ``TopoDS_Shape``.

    Edges are sorted by descending length (then by start point) before
    receiving stable ``edge_0001`` style ids.  Duplicates are removed because
    some shapes (e.g. build123d ``Box`` compounds) store the same geometric
    edge once per adjacent face.  Degenerate edges are skipped and, if
    ``warnings`` is provided, a message is appended for each skip.
    """
    _require_ocp()

    raw: list[dict[str, Any]] = []
    seen: set[tuple] = set()
    explorer = TopExp_Explorer(shape, TopAbs_EDGE)
    while explorer.More():
        edge = TopoDS.Edge_s(explorer.Current())
        data = _extract_edge_fingerprint(edge)
        if data is None:
            if warnings is not None:
                warnings.append(
                    "Skipped a degenerate/unreadable edge during fingerprint extraction."
                )
            explorer.Next()
            continue

        start, end = _canonical_endpoints(data["start"], data["end"])
        center = data.get("center")
        key = (
            data["curve_type"],
            _rounded(data["length"]),
            _rounded(start[0]),
            _rounded(start[1]),
            _rounded(start[2]),
            _rounded(end[0]),
            _rounded(end[1]),
            _rounded(end[2]),
            (
                _rounded(center[0]),
                _rounded(center[1]),
                _rounded(center[2]),
            )
            if center is not None
            else ("none",),
        )
        if key not in seen:
            seen.add(key)
            raw.append(data)
        explorer.Next()

    raw.sort(key=lambda d: (-d["length"], d["start"]))
    return [
        EdgeFingerprint(candidate_id=_stable_candidate_id("edge", i + 1), **data)
        for i, data in enumerate(raw)
    ]


def resolve_references(
    refs: list[FaceFingerprint] | list[EdgeFingerprint],
    new_shape: Any,
    *,
    tolerance_scale: float = DEFAULT_TOLERANCE_SCALE,
    ambiguity_margin: float = 0.05,
) -> MatchResult:
    """Resolve a list of references against a rebuilt shape.

    Extracts candidates from ``new_shape`` and delegates scoring to
    :func:`reference_scoring.match_references`.  The kind of extraction
    (face vs edge) is inferred from the first reference.
    """
    _require_ocp()
    if not refs:
        return MatchResult([])

    first = refs[0]
    if isinstance(first, FaceFingerprint):
        candidates = extract_face_fingerprints(new_shape)
    elif isinstance(first, EdgeFingerprint):
        candidates = extract_edge_fingerprints(new_shape)
    else:
        raise ValueError(f"Unsupported fingerprint type: {type(first).__name__}")

    return match_references(
        refs,
        candidates,
        tolerance_scale=tolerance_scale,
        ambiguity_margin=ambiguity_margin,
    )
