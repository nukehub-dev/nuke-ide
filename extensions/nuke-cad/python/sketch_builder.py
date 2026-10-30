#!/usr/bin/env python3
"""Sketch parser and build123d face builder for `.nuke-cad` documents.

Consumes the planegcs-verbatim primitives stored in a sketch definition and
reconstructs one or more build123d ``Face`` objects on the sketch's datum
plane. The geometric constraint solver runs client-side; this module never
re-solves, it only builds geometry from solved coordinates.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

# Heavy imports are guarded so the module stays importable in the minimal pytest
# profile (pytest + numpy only).
try:
    import build123d as bd

    HAS_BUILD123D = True
except Exception:
    bd = None  # type: ignore
    HAS_BUILD123D = False

try:
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge
    from OCP.Geom import Geom_BSplineCurve
    from OCP.gp import gp_Pnt
    from OCP.TColgp import TColgp_Array1OfPnt
    from OCP.TColStd import TColStd_Array1OfInteger, TColStd_Array1OfReal

    HAS_OCP = True
except Exception:
    HAS_OCP = False
    BRepBuilderAPI_MakeEdge = None  # type: ignore
    Geom_BSplineCurve = None  # type: ignore
    gp_Pnt = None  # type: ignore
    TColgp_Array1OfPnt = None  # type: ignore
    TColStd_Array1OfInteger = None  # type: ignore
    TColStd_Array1OfReal = None  # type: ignore


class SketchError(ValueError):
    """Raised when a sketch cannot be reconstructed as closed face(s)."""


@dataclass(frozen=True)
class SketchPoint:
    """A solved 2D sketch point in the sketch's local coordinate system."""

    id: str
    x: float
    y: float
    construction: bool


@dataclass(frozen=True)
class SketchLine:
    """A solved 2D line segment referencing two point ids."""

    id: str
    p1_id: str
    p2_id: str
    construction: bool


@dataclass(frozen=True)
class SketchCircle:
    """A solved 2D circle referencing a center point id."""

    id: str
    center_id: str
    radius: float
    construction: bool


@dataclass(frozen=True)
class SketchArc:
    """A solved 2D arc referencing a center and start/end points.

    ``start_angle`` and ``end_angle`` are stored in radians (the internal unit
    used by PlaneGCS). They are converted to degrees when building the
    build123d ``CenterArc`` edge.
    """

    id: str
    center_id: str
    radius: float
    start_angle: float
    end_angle: float
    start_id: str
    end_id: str
    construction: bool


SketchPrimitive = SketchPoint | SketchLine | SketchCircle | SketchArc


@dataclass(frozen=True)
class SketchEllipse:
    """A solved 2D ellipse referencing a center and a focus point.

    Stored the way PlaneGCS models it: the focus sets the major-axis direction
    and focal distance, so the major semi-axis is
    ``sqrt(radmin**2 + |c - f1|**2)`` and ``radmin`` is the minor semi-axis.
    """

    id: str
    center_id: str
    focus1_id: str
    radmin: float
    construction: bool


@dataclass(frozen=True)
class SketchBSpline:
    """A solved 2D B-spline authored by control polygon.

    The poles are separate ``SketchPoint`` records. Non-periodic (clamped
    uniform) knots interpolate the end poles, so they double as wire endpoints.
    ``knots``/``mult`` use the OpenCASCADE compressed form; the consistency
    invariant is ``sum(mult) == len(pole_ids) + degree + 1``.
    """

    id: str
    pole_ids: tuple[str, ...]
    weights: tuple[float, ...]
    knots: tuple[float, ...]
    mult: tuple[int, ...]
    degree: int
    periodic: bool
    construction: bool


SketchPrimitive = SketchPrimitive | SketchEllipse | SketchBSpline


def _as_finite_number(value: Any, context: str) -> float:
    """Return ``value`` as a finite float or raise ``SketchError``."""
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise SketchError(f"{context} must be a finite number, got {value!r}")
    return float(value)


def _as_bool(value: Any, default: bool) -> bool:
    """Return ``value`` as a bool, falling back to ``default`` when missing."""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    raise SketchError(f"expected a boolean, got {value!r}")


def _get_str(obj: dict[str, Any], key: str, context: str) -> str:
    """Return a required string field or raise ``SketchError``."""
    value = obj.get(key)
    if not isinstance(value, str) or not value:
        raise SketchError(f"{context} missing required string field '{key}'")
    return value


def _get_finite_number(obj: dict[str, Any], key: str, context: str) -> float:
    """Return a required finite numeric field or raise ``SketchError``."""
    return _as_finite_number(obj.get(key), f"{context}.{key}")


def _parse_point(primitive: dict[str, Any]) -> SketchPoint:
    """Parse a point primitive (planegcs-verbatim or camelCase alias)."""
    pid = _get_str(primitive, "id", "point")
    return SketchPoint(
        id=pid,
        x=_get_finite_number(primitive, "x", f"point '{pid}'"),
        y=_get_finite_number(primitive, "y", f"point '{pid}'"),
        construction=_as_bool(primitive.get("construction"), False),
    )


def _parse_line(primitive: dict[str, Any]) -> SketchLine:
    """Parse a line primitive (planegcs-verbatim or camelCase alias)."""
    pid = _get_str(primitive, "id", "line")
    return SketchLine(
        id=pid,
        p1_id=_get_str(primitive, "p1_id", f"line '{pid}'")
        if "p1_id" in primitive
        else _get_str(primitive, "p1Id", f"line '{pid}'"),
        p2_id=_get_str(primitive, "p2_id", f"line '{pid}'")
        if "p2_id" in primitive
        else _get_str(primitive, "p2Id", f"line '{pid}'"),
        construction=_as_bool(primitive.get("construction"), False),
    )


def _parse_circle(primitive: dict[str, Any]) -> SketchCircle:
    """Parse a circle primitive (planegcs-verbatim or camelCase alias)."""
    pid = _get_str(primitive, "id", "circle")
    center_id = (
        _get_str(primitive, "c_id", f"circle '{pid}'")
        if "c_id" in primitive
        else _get_str(primitive, "centerId", f"circle '{pid}'")
    )
    return SketchCircle(
        id=pid,
        center_id=center_id,
        radius=_get_finite_number(primitive, "radius", f"circle '{pid}'"),
        construction=_as_bool(primitive.get("construction"), False),
    )


def _parse_arc(primitive: dict[str, Any]) -> SketchArc:
    """Parse an arc primitive (planegcs-verbatim or camelCase alias)."""
    pid = _get_str(primitive, "id", "arc")
    center_id = (
        _get_str(primitive, "c_id", f"arc '{pid}'")
        if "c_id" in primitive
        else _get_str(primitive, "centerId", f"arc '{pid}'")
    )
    start_id = (
        _get_str(primitive, "start_id", f"arc '{pid}'")
        if "start_id" in primitive
        else _get_str(primitive, "startId", f"arc '{pid}'")
    )
    end_id = (
        _get_str(primitive, "end_id", f"arc '{pid}'")
        if "end_id" in primitive
        else _get_str(primitive, "endId", f"arc '{pid}'")
    )
    return SketchArc(
        id=pid,
        center_id=center_id,
        radius=_get_finite_number(primitive, "radius", f"arc '{pid}'"),
        start_angle=_get_finite_number(
            primitive, "start_angle" if "start_angle" in primitive else "startAngle", f"arc '{pid}'"
        ),
        end_angle=_get_finite_number(
            primitive, "end_angle" if "end_angle" in primitive else "endAngle", f"arc '{pid}'"
        ),
        start_id=start_id,
        end_id=end_id,
        construction=_as_bool(primitive.get("construction"), False),
    )


def _parse_ellipse(primitive: dict[str, Any]) -> SketchEllipse:
    """Parse an ellipse primitive (planegcs-verbatim or camelCase alias)."""
    pid = _get_str(primitive, "id", "ellipse")
    center_id = (
        _get_str(primitive, "c_id", f"ellipse '{pid}'")
        if "c_id" in primitive
        else _get_str(primitive, "centerId", f"ellipse '{pid}'")
    )
    focus1_id = (
        _get_str(primitive, "focus1_id", f"ellipse '{pid}'")
        if "focus1_id" in primitive
        else _get_str(primitive, "focus1Id", f"ellipse '{pid}'")
    )
    return SketchEllipse(
        id=pid,
        center_id=center_id,
        focus1_id=focus1_id,
        radmin=_get_finite_number(primitive, "radmin", f"ellipse '{pid}'"),
        construction=_as_bool(primitive.get("construction"), False),
    )


def _as_id_tuple(value: Any, context: str) -> tuple[str, ...]:
    """Return ``value`` as a tuple of non-empty strings or raise ``SketchError``."""
    if not isinstance(value, list) or not value:
        raise SketchError(f"{context} must be a non-empty list of point ids, got {value!r}")
    ids: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item:
            raise SketchError(f"{context} entries must be non-empty strings, got {item!r}")
        ids.append(item)
    return tuple(ids)


def _as_number_tuple(value: Any, context: str) -> tuple[float, ...]:
    """Return ``value`` as a tuple of finite floats or raise ``SketchError``."""
    if not isinstance(value, list) or not value:
        raise SketchError(f"{context} must be a non-empty list of numbers, got {value!r}")
    return tuple(_as_finite_number(item, f"{context} entry") for item in value)


def _parse_bspline(primitive: dict[str, Any]) -> SketchBSpline:
    """Parse a B-spline primitive (planegcs-verbatim or camelCase alias)."""
    pid = _get_str(primitive, "id", "bspline")
    pole_ids = _as_id_tuple(
        primitive.get("pole_ids", primitive.get("poleIds")), f"bspline '{pid}'.pole_ids"
    )
    weights = _as_number_tuple(primitive.get("weights"), f"bspline '{pid}'.weights")
    knots = _as_number_tuple(primitive.get("knots"), f"bspline '{pid}'.knots")
    mult_value = primitive.get("mult")
    if not isinstance(mult_value, list) or not mult_value:
        raise SketchError(
            f"bspline '{pid}'.mult must be a non-empty list of integers, got {mult_value!r}"
        )
    mult: list[int] = []
    for item in mult_value:
        if not isinstance(item, int) or isinstance(item, bool) or item < 1:
            raise SketchError(
                f"bspline '{pid}'.mult entries must be positive integers, got {item!r}"
            )
        mult.append(item)
    degree = primitive.get("degree")
    if not isinstance(degree, int) or isinstance(degree, bool) or degree < 1:
        raise SketchError(f"bspline '{pid}'.degree must be a positive integer, got {degree!r}")
    if len(pole_ids) < degree + 1:
        raise SketchError(
            f"bspline '{pid}' needs at least {degree + 1} poles for degree {degree}, got {len(pole_ids)}"
        )
    if len(weights) != len(pole_ids):
        raise SketchError(
            f"bspline '{pid}' weights length {len(weights)} does not match {len(pole_ids)} poles"
        )
    if len(knots) != len(mult):
        raise SketchError(
            f"bspline '{pid}' knots length {len(knots)} does not match mult length {len(mult)}"
        )
    if sum(mult) != len(pole_ids) + degree + 1:
        raise SketchError(
            f"bspline '{pid}' knot multiplicities sum to {sum(mult)}, "
            f"expected {len(pole_ids) + degree + 1} (poles + degree + 1)"
        )
    return SketchBSpline(
        id=pid,
        pole_ids=pole_ids,
        weights=weights,
        knots=knots,
        mult=tuple(mult),
        degree=degree,
        periodic=_as_bool(primitive.get("periodic"), False),
        construction=_as_bool(primitive.get("construction"), False),
    )


def parse_sketch_primitives(primitives: list[dict[str, Any]]) -> list[SketchPrimitive]:
    """Parse a list of planegcs-verbatim primitives into typed records.

    The parser accepts both the canonical planegcs snake_case field names and
    the camelCase aliases used by the public TypeScript ``SketchPrimitive``
    type. Construction geometry is parsed but marked as such; it is skipped when
    building edges.
    """
    parsed: list[SketchPrimitive] = []
    seen_ids: set[str] = set()
    for index, primitive in enumerate(primitives):
        if not isinstance(primitive, dict):
            raise SketchError(f"primitives[{index}] must be an object")
        ptype = primitive.get("type")
        if ptype == "point":
            record = _parse_point(primitive)
        elif ptype == "line":
            record = _parse_line(primitive)
        elif ptype == "circle":
            record = _parse_circle(primitive)
        elif ptype == "arc":
            record = _parse_arc(primitive)
        elif ptype == "ellipse":
            record = _parse_ellipse(primitive)
        elif ptype == "bspline":
            record = _parse_bspline(primitive)
        else:
            raise SketchError(
                f"primitives[{index}] has unknown or missing type {ptype!r}; "
                "expected 'point', 'line', 'circle', 'arc', 'ellipse', or 'bspline'"
            )
        if record.id in seen_ids:
            raise SketchError(f"duplicate primitive id '{record.id}' in sketch")
        seen_ids.add(record.id)
        parsed.append(record)
    return parsed


def _build_plane(datum: dict[str, Any]) -> Any:
    """Return a build123d ``Plane`` for a datum definition.

    Raises ``SketchError`` for datum kinds that need a resolved face workplane
    (``face`` and ``midplane`` datums are handled by the feature builder
    before this is called), for ``line2Point`` datums (axes, not planes), or
    for otherwise unknown kinds.
    """
    if bd is None:
        raise SketchError("build123d is not available; cannot build sketch geometry")

    kind = datum.get("kind")
    datum_id = datum.get("id", "<unknown>")
    if kind == "XY":
        return bd.Plane.XY
    if kind == "YZ":
        return bd.Plane.YZ
    if kind == "XZ":
        return bd.Plane.XZ
    if kind == "offset":
        offset = _as_finite_number(datum.get("offset"), "datum.offset")
        # Offset datums are offsets of the XY plane along +Z. A future
        # schema revision will add an explicit base/normal reference.
        return bd.Plane.XY.offset(offset)
    if kind == "threePoint":
        points = datum.get("points")
        if not isinstance(points, (list, tuple)) or len(points) != 3:
            raise SketchError(f"datum '{datum_id}' requires exactly 3 points")
        coords: list[tuple[float, float, float]] = []
        for point in points:
            if (
                not isinstance(point, (list, tuple))
                or len(point) != 3
                or any(
                    not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v)
                    for v in point
                )
            ):
                raise SketchError(f"datum '{datum_id}' points must be finite [x, y, z]")
            coords.append((float(point[0]), float(point[1]), float(point[2])))
        (ax, ay, az), (bx, by, bz), (cx, cy, cz) = coords
        ab = (bx - ax, by - ay, bz - az)
        ac = (cx - ax, cy - ay, cz - az)
        cross = (
            ab[1] * ac[2] - ab[2] * ac[1],
            ab[2] * ac[0] - ab[0] * ac[2],
            ab[0] * ac[1] - ab[1] * ac[0],
        )
        area = 0.5 * math.sqrt(cross[0] ** 2 + cross[1] ** 2 + cross[2] ** 2)
        ab_len = math.sqrt(ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)
        ac_len = math.sqrt(ac[0] ** 2 + ac[1] ** 2 + ac[2] ** 2)
        if ab_len == 0.0 or ac_len == 0.0:
            raise SketchError(f"datum '{datum_id}' has coincident points")
        if area <= 1e-9:
            raise SketchError(f"datum '{datum_id}' points are collinear")
        length = math.sqrt(cross[0] ** 2 + cross[1] ** 2 + cross[2] ** 2)
        normal = (cross[0] / length, cross[1] / length, cross[2] / length)
        x_len = math.sqrt(ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)
        x_dir = (ab[0] / x_len, ab[1] / x_len, ab[2] / x_len)
        return bd.Plane(origin=(ax, ay, az), x_dir=x_dir, z_dir=normal)
    if kind == "face":
        raise SketchError(
            "'face' datums must be resolved to a workplane by the feature builder; "
            "sketch_builder only handles coordinate datums"
        )
    if kind == "midplane":
        raise SketchError(
            "'midplane' datums must be resolved to a workplane by the feature builder; "
            "sketch_builder only handles coordinate datums"
        )
    if kind == "line2Point":
        raise SketchError(f"datum '{datum_id}' is a line and cannot be used as a sketch plane")
    raise SketchError(f"unknown datum kind '{kind}'")


def _resolve_datum(datum_id: str, datums: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Return the datum definition for ``datum_id`` or raise ``SketchError``."""
    datum = datums.get(datum_id)
    if datum is None:
        raise SketchError(f"sketch references unknown datum '{datum_id}'")
    return datum


def _bspline_edge(
    poles: list[tuple[float, float]], knots: tuple[float, ...], mult: tuple[int, ...], degree: int
) -> Any:
    """Build a build123d ``Edge`` from a clamped non-periodic B-spline.

    The raw ``Geom_BSplineCurve`` is wrapped through ``BRepBuilderAPI_MakeEdge``
    because ``bd.Edge(...)`` rejects bare Geom curves. Clamped knots make the
    curve interpolate the first and last pole, so wire/loop assembly treats the
    end poles as ordinary endpoints.
    """
    if not HAS_OCP or bd is None:
        raise SketchError("OCP is not available; cannot build B-spline edges")
    if len(poles) < degree + 1:
        raise SketchError(
            f"bspline needs at least {degree + 1} poles for degree {degree}, got {len(poles)}"
        )
    if len(knots) != len(mult):
        raise SketchError(
            f"bspline knots length {len(knots)} does not match mult length {len(mult)}"
        )
    if sum(mult) != len(poles) + degree + 1:
        raise SketchError(
            f"bspline knot multiplicities sum to {sum(mult)}, expected {len(poles) + degree + 1} (poles + degree + 1)"
        )
    pole_array = TColgp_Array1OfPnt(1, len(poles))
    for index, (x, y) in enumerate(poles, start=1):
        pole_array.SetValue(index, gp_Pnt(x, y, 0))
    knot_array = TColStd_Array1OfReal(1, len(knots))
    for index, value in enumerate(knots, start=1):
        knot_array.SetValue(index, float(value))
    mult_array = TColStd_Array1OfInteger(1, len(mult))
    for index, value in enumerate(mult, start=1):
        mult_array.SetValue(index, int(value))
    try:
        curve = Geom_BSplineCurve(pole_array, knot_array, mult_array, int(degree), False)
        return bd.Edge(BRepBuilderAPI_MakeEdge(curve).Edge())
    except Exception as exc:
        raise SketchError(f"could not build bspline edge: {exc}") from exc


def _edges_from_primitives(
    primitives: list[SketchPrimitive],
    points: dict[str, SketchPoint],
    plane: Any,
) -> list[Any]:
    """Build build123d edge objects from non-construction sketch primitives."""
    if bd is None:
        raise SketchError("build123d is not available; cannot build sketch edges")

    edges: list[Any] = []
    for primitive in primitives:
        if isinstance(primitive, SketchPoint) or primitive.construction:
            continue

        if isinstance(primitive, SketchLine):
            p1 = points.get(primitive.p1_id)
            p2 = points.get(primitive.p2_id)
            if p1 is None or p2 is None:
                raise SketchError(
                    f"line '{primitive.id}' references unknown point "
                    f"'{primitive.p1_id if p1 is None else primitive.p2_id}'"
                )
            try:
                edge = bd.Line((p1.x, p1.y), (p2.x, p2.y))
            except Exception as exc:
                raise SketchError(f"could not build line '{primitive.id}': {exc}") from exc

        elif isinstance(primitive, SketchCircle):
            center = points.get(primitive.center_id)
            if center is None:
                raise SketchError(
                    f"circle '{primitive.id}' references unknown center point '{primitive.center_id}'"
                )
            try:
                edge = bd.Circle(primitive.radius).edge()
                edge = bd.Location((center.x, center.y, 0)) * edge
            except Exception as exc:
                raise SketchError(
                    f"could not build circle '{primitive.id}' (radius={primitive.radius}): {exc}"
                ) from exc

        elif isinstance(primitive, SketchArc):
            center = points.get(primitive.center_id)
            if center is None:
                raise SketchError(
                    f"arc '{primitive.id}' references unknown center point '{primitive.center_id}'"
                )
            start_angle = math.degrees(primitive.start_angle)
            raw_arc_size = math.degrees(primitive.end_angle - primitive.start_angle)
            # Normalize huge sweeps to keep the build123d call well-behaved.
            arc_size = math.fmod(raw_arc_size, 360.0)
            if arc_size == 0.0 and raw_arc_size > 0.0:
                # Preserve a positive full-circle sweep that fmod collapsed to 0.
                arc_size = 360.0
            if arc_size <= -360.0:
                arc_size += 360.0
            elif arc_size > 360.0:
                arc_size -= 360.0
            try:
                edge = bd.CenterArc((center.x, center.y), primitive.radius, start_angle, arc_size)
            except Exception as exc:
                raise SketchError(
                    f"could not build arc '{primitive.id}' (radius={primitive.radius}): {exc}"
                ) from exc

        elif isinstance(primitive, SketchEllipse):
            center = points.get(primitive.center_id)
            focus1 = points.get(primitive.focus1_id)
            if center is None:
                raise SketchError(
                    f"ellipse '{primitive.id}' references unknown center point '{primitive.center_id}'"
                )
            if focus1 is None:
                raise SketchError(
                    f"ellipse '{primitive.id}' references unknown focus point '{primitive.focus1_id}'"
                )
            # planegcs stores the focus: major = sqrt(radmin^2 + |c - f1|^2)
            # and the focus direction is the major-axis angle.
            focal_dx = focus1.x - center.x
            focal_dy = focus1.y - center.y
            major = math.sqrt(
                primitive.radmin * primitive.radmin + focal_dx * focal_dx + focal_dy * focal_dy
            )
            rotation = math.degrees(math.atan2(focal_dy, focal_dx))
            try:
                edge = bd.Ellipse(
                    x_radius=major, y_radius=primitive.radmin, rotation=rotation
                ).edge()
                edge = bd.Location((center.x, center.y, 0)) * edge
            except Exception as exc:
                raise SketchError(
                    f"could not build ellipse '{primitive.id}' "
                    f"(major={major}, minor={primitive.radmin}): {exc}"
                ) from exc

        elif isinstance(primitive, SketchBSpline):
            if primitive.periodic:
                raise SketchError(
                    f"bspline '{primitive.id}' is periodic; only clamped non-periodic curves are supported"
                )
            pole_coords: list[tuple[float, float]] = []
            for pole_id in primitive.pole_ids:
                pole = points.get(pole_id)
                if pole is None:
                    raise SketchError(
                        f"bspline '{primitive.id}' references unknown pole point '{pole_id}'"
                    )
                pole_coords.append((pole.x, pole.y))
            if any(weight != 1 for weight in primitive.weights):
                raise SketchError(
                    f"bspline '{primitive.id}' uses non-unit weights, which are not supported"
                )
            edge = _bspline_edge(pole_coords, primitive.knots, primitive.mult, primitive.degree)
        else:
            continue

        edges.append(plane.location * edge)

    return edges


def _build_faces_from_wires(
    wires: list[Any],
    sketch_name: str,
) -> list[Any]:
    """Create ``Face`` objects from closed wires, pairing inner wires as holes."""
    if bd is None:
        raise SketchError("build123d is not available; cannot build sketch faces")

    open_wires = [w for w in wires if not w.is_closed]
    if open_wires:
        raise SketchError(
            f"sketch '{sketch_name}' contains open wire(s); ensure all profiles are closed"
        )

    # Compute a planar face for each wire so we can classify holes by area and
    # containment. Use the absolute area so orientation does not matter.
    wire_faces: list[tuple[Any, Any, float]] = []
    for wire in wires:
        try:
            face = bd.Face(wire)
        except Exception as exc:
            raise SketchError(
                f"sketch '{sketch_name}': could not build face from wire: {exc}"
            ) from exc
        wire_faces.append((wire, face, abs(float(face.area))))

    # Sort by descending area: the largest face is an outer profile; smaller
    # faces contained inside it are holes.
    wire_faces.sort(key=lambda item: item[2], reverse=True)

    faces: list[Any] = []
    outer_items: list[tuple[Any, Any]] = []
    for wire, face, _area in wire_faces:
        assigned = False
        for _outer_wire, outer_face in outer_items:
            try:
                if outer_face.is_inside(face.center()):
                    assigned = True
                    break
            except Exception:
                pass
        if assigned:
            continue
        outer_items.append((wire, face))

    # Build each outer face with its holes.
    for outer_wire, outer_face in outer_items:
        hole_wires: list[Any] = []
        for wire, face, _area in wire_faces:
            if wire is outer_wire:
                continue
            try:
                if outer_face.is_inside(face.center()):
                    hole_wires.append(wire)
            except Exception:
                pass
        try:
            if hole_wires:
                faces.append(bd.Face(outer_wire, list(hole_wires)))
            else:
                faces.append(outer_face)
        except Exception as exc:
            raise SketchError(
                f"sketch '{sketch_name}': could not build face with holes: {exc}"
            ) from exc

    if not faces and wires:
        raise SketchError(f"sketch '{sketch_name}' produced no valid faces")

    return faces


def build_sketch_faces(
    sketch: dict[str, Any],
    datums: dict[str, dict[str, Any]],
    plane: Any | None = None,
    extra_primitives: list[dict[str, Any]] | None = None,
) -> tuple[Any, list[Any]]:
    """Parse a sketch and return ``(plane, faces)``.

    The returned ``plane`` is a build123d ``Plane`` representing the sketch
    datum. ``faces`` is a list of build123d ``Face`` objects (outer profiles
    with any contained profiles converted to holes).

    When ``plane`` is supplied it is used directly; otherwise the plane is
    derived from the sketch's datum definition. ``extra_primitives`` are
    appended to the sketch's own primitives before parsing (they should carry
    ``construction: true`` so they do not become output edges).
    """
    if bd is None:
        raise SketchError("build123d is not available; cannot build sketch faces")

    sketch_name = sketch.get("name") or sketch.get("id") or "<unnamed>"
    datum_id = sketch.get("datumId")
    if not isinstance(datum_id, str) or not datum_id:
        raise SketchError(f"sketch '{sketch_name}' has no datumId")

    if plane is None:
        datum = _resolve_datum(datum_id, datums)
        plane = _build_plane(datum)

    primitives = list(sketch.get("primitives", []))
    if not isinstance(primitives, list):
        raise SketchError(f"sketch '{sketch_name}'.primitives must be a list")
    if extra_primitives:
        primitives.extend(extra_primitives)

    parsed = parse_sketch_primitives(primitives)
    points: dict[str, SketchPoint] = {p.id: p for p in parsed if isinstance(p, SketchPoint)}

    edges = _edges_from_primitives(parsed, points, plane)
    if not edges:
        raise SketchError(f"sketch '{sketch_name}' contains no drawable edges")

    try:
        wires = bd.Wire.combine(edges)
    except Exception as exc:
        raise SketchError(
            f"sketch '{sketch_name}': could not combine edges into closed wires: {exc}"
        ) from exc
    faces = _build_faces_from_wires(list(wires), sketch_name)
    return plane, faces
