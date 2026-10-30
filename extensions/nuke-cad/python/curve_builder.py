#!/usr/bin/env python3
"""Curve builder for `.nuke-cad` documents.

Fits a B-spline wire through each curve's stored sample polyline. Parametric
and Fourier sources are treated as exact interpolations; points sources are
approximated with a tolerance derived from the sample spacing. Closed curves
are detected from the first/last sample distance and built as periodic wires.

Heavy OCP imports are guarded so the module stays importable in the minimal
pytest profile (pytest + numpy only).
"""

from __future__ import annotations

import math
from typing import Any

# Heavy imports are guarded so the module stays importable in the minimal pytest
# profile (pytest + numpy only).
try:
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeWire
    from OCP.GeomAbs import GeomAbs_C2
    from OCP.GeomAPI import GeomAPI_Interpolate, GeomAPI_PointsToBSpline
    from OCP.gp import gp_Pnt
    from OCP.TColgp import TColgp_Array1OfPnt, TColgp_HArray1OfPnt
    from OCP.TopoDS import TopoDS_Wire

    HAS_OCP = True
except Exception:
    HAS_OCP = False
    BRepBuilderAPI_MakeEdge = None  # type: ignore
    BRepBuilderAPI_MakeWire = None  # type: ignore
    gp_Pnt = None  # type: ignore
    GeomAPI_Interpolate = None  # type: ignore
    GeomAPI_PointsToBSpline = None  # type: ignore
    GeomAbs_C2 = None  # type: ignore
    TColgp_Array1OfPnt = None  # type: ignore
    TColgp_HArray1OfPnt = None  # type: ignore
    TopoDS_Wire = None  # type: ignore


class CurveBuildError(ValueError):
    """Raised when a curve cannot be built."""


def _require_ocp() -> None:
    if not HAS_OCP:
        raise CurveBuildError("Curve building requires OCP (cadquery-ocp/build123d).")


def _array_of_points(points: list[tuple[float, float, float]]) -> Any:
    arr = TColgp_Array1OfPnt(1, len(points))
    for i, (x, y, z) in enumerate(points, start=1):
        arr.SetValue(i, gp_Pnt(x, y, z))
    return arr


def _harray_of_points(points: list[tuple[float, float, float]]) -> Any:
    arr = TColgp_HArray1OfPnt(1, len(points))
    for i, (x, y, z) in enumerate(points, start=1):
        arr.SetValue(i, gp_Pnt(x, y, z))
    return arr


def _is_closed(points: list[tuple[float, float, float]]) -> bool:
    # The endpoints of a closed loop meet well within one sample spacing
    # (the frontend repeats the first point exactly; noisy CSV imports land a
    # small fraction of a spacing away). A genuinely open curve whose ends
    # happen to sit about one chord apart must stay open, so the tolerance is
    # relative to the average spacing, not the bounding box.
    if len(points) < 2:
        return False
    first = points[0]
    last = points[-1]
    distance = math.sqrt(
        (first[0] - last[0]) ** 2 + (first[1] - last[1]) ** 2 + (first[2] - last[2]) ** 2
    )
    tol = max(1e-9, 0.1 * _average_spacing(points))
    return distance < tol


def _average_spacing(points: list[tuple[float, float, float]]) -> float:
    if len(points) < 2:
        return 1.0
    total = 0.0
    for i in range(len(points) - 1):
        a = points[i]
        b = points[i + 1]
        total += math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)
    return total / (len(points) - 1)


def _interpolate(points: list[tuple[float, float, float]], closed: bool) -> Any:
    # Periodic interpolation expects the first point exactly once; the curve
    # closes back to it automatically.
    interp_points = points[:-1] if closed else points
    arr = _harray_of_points(interp_points)
    interp = GeomAPI_Interpolate(arr, closed, 1e-6)
    interp.Perform()
    if not interp.IsDone():
        raise CurveBuildError("interpolation failed")
    return interp.Curve()


def _approximate(points: list[tuple[float, float, float]]) -> Any:
    arr = _array_of_points(points)
    spacing = _average_spacing(points)
    tolerance = max(1e-6, spacing * 0.05)
    max_degree = min(8, len(points) - 1)
    pts = GeomAPI_PointsToBSpline(arr, 1, max_degree, GeomAbs_C2, tolerance)
    if not pts.IsDone():
        raise CurveBuildError("B-spline approximation failed")
    return pts.Curve()


def _fit_curve(
    curve_id: str,
    name: str,
    source: dict[str, Any],
    points: list[tuple[float, float, float]],
) -> dict[str, Any]:
    if len(points) < 4:
        raise CurveBuildError(f"curve '{curve_id}' ('{name}'): at least 4 points are required")

    _require_ocp()

    closed = _is_closed(points)
    kind = source.get("kind") if isinstance(source, dict) else None

    if kind == "points":
        curve = _approximate(points)
    else:
        curve = _interpolate(points, closed)

    edge = BRepBuilderAPI_MakeEdge(curve, curve.FirstParameter(), curve.LastParameter()).Edge()
    wire_maker = BRepBuilderAPI_MakeWire()
    wire_maker.Add(edge)
    if not wire_maker.IsDone():
        raise CurveBuildError(f"curve '{curve_id}' ('{name}'): could not build wire")
    wire = wire_maker.Wire()

    return {
        "wire": wire,
        "name": name,
        "points": points,
        "closed": closed,
    }


def build_curves(document: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Fit B-spline wires for every curve in ``document``.

    Returns a mapping from curve id to a result dict containing:

        ``wire``
            The fitted ``TopoDS_Wire``.
        ``points``
            The echoed sample polyline.
        ``closed``
            Whether the curve was detected as closed.
    """
    results: dict[str, dict[str, Any]] = {}
    for i, curve in enumerate(document.get("curves", [])):
        if not isinstance(curve, dict):
            raise CurveBuildError(f"curve[{i}]: expected a curve object")
        curve_id = str(curve.get("id", f"[{i}]"))
        name = str(curve.get("name", curve_id))
        source = curve.get("source", {})
        samples = curve.get("samples", [])
        if not isinstance(samples, list) or len(samples) < 4:
            raise CurveBuildError(f"curve '{curve_id}' ('{name}'): at least 4 samples are required")
        points: list[tuple[float, float, float]] = []
        for p in samples:
            if not isinstance(p, (list, tuple)) or len(p) != 3:
                raise CurveBuildError(f"curve '{curve_id}' ('{name}'): sample must be [x, y, z]")
            try:
                points.append((float(p[0]), float(p[1]), float(p[2])))
            except (TypeError, ValueError) as exc:
                raise CurveBuildError(
                    f"curve '{curve_id}' ('{name}'): sample contains non-numeric value"
                ) from exc
        results[curve_id] = _fit_curve(curve_id, name, source, points)
    return results
