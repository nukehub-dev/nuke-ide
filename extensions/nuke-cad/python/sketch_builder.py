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
        else:
            raise SketchError(
                f"primitives[{index}] has unknown or missing type {ptype!r}; "
                "expected 'point', 'line', 'circle', or 'arc'"
            )
        if record.id in seen_ids:
            raise SketchError(f"duplicate primitive id '{record.id}' in sketch")
        seen_ids.add(record.id)
        parsed.append(record)
    return parsed


def _build_plane(datum: dict[str, Any]) -> Any:
    """Return a build123d ``Plane`` for a datum definition.

    Raises ``SketchError`` for unsupported datum kinds (e.g. ``face`` datums).
    """
    if bd is None:
        raise SketchError("build123d is not available; cannot build sketch geometry")

    kind = datum.get("kind")
    if kind == "XY":
        return bd.Plane.XY
    if kind == "YZ":
        return bd.Plane.YZ
    if kind == "XZ":
        return bd.Plane.XZ
    if kind == "offset":
        offset = _as_finite_number(datum.get("offset"), "datum.offset")
        # Tier 1: offset datums are offsets of the XY plane along +Z. A future
        # schema revision will add an explicit base/normal reference.
        return bd.Plane.XY.offset(offset)
    if kind == "face":
        raise SketchError("'face' datums (sketch-on-face) are not supported yet")
    raise SketchError(f"unknown datum kind '{kind}'")


def _resolve_datum(datum_id: str, datums: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Return the datum definition for ``datum_id`` or raise ``SketchError``."""
    datum = datums.get(datum_id)
    if datum is None:
        raise SketchError(f"sketch references unknown datum '{datum_id}'")
    return datum


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
            edge = bd.Line((p1.x, p1.y), (p2.x, p2.y))

        elif isinstance(primitive, SketchCircle):
            center = points.get(primitive.center_id)
            if center is None:
                raise SketchError(
                    f"circle '{primitive.id}' references unknown center point '{primitive.center_id}'"
                )
            edge = bd.Circle(primitive.radius).edge()
            edge = bd.Location((center.x, center.y, 0)) * edge

        elif isinstance(primitive, SketchArc):
            center = points.get(primitive.center_id)
            if center is None:
                raise SketchError(
                    f"arc '{primitive.id}' references unknown center point '{primitive.center_id}'"
                )
            start_angle = math.degrees(primitive.start_angle)
            arc_size = math.degrees(primitive.end_angle - primitive.start_angle)
            # Normalize huge sweeps to keep the build123d call well-behaved.
            while arc_size > 360.0:
                arc_size -= 360.0
            while arc_size <= -360.0:
                arc_size += 360.0
            edge = bd.CenterArc((center.x, center.y), primitive.radius, start_angle, arc_size)
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
) -> tuple[Any, list[Any]]:
    """Parse a sketch and return ``(plane, faces)``.

    The returned ``plane`` is a build123d ``Plane`` representing the sketch
    datum. ``faces`` is a list of build123d ``Face`` objects (outer profiles
    with any contained profiles converted to holes).
    """
    if bd is None:
        raise SketchError("build123d is not available; cannot build sketch faces")

    sketch_name = sketch.get("name") or sketch.get("id") or "<unnamed>"
    datum_id = sketch.get("datumId")
    if not isinstance(datum_id, str) or not datum_id:
        raise SketchError(f"sketch '{sketch_name}' has no datumId")

    datum = _resolve_datum(datum_id, datums)
    plane = _build_plane(datum)

    primitives = sketch.get("primitives", [])
    if not isinstance(primitives, list):
        raise SketchError(f"sketch '{sketch_name}'.primitives must be a list")

    parsed = parse_sketch_primitives(primitives)
    points: dict[str, SketchPoint] = {p.id: p for p in parsed if isinstance(p, SketchPoint)}

    edges = _edges_from_primitives(parsed, points, plane)
    if not edges:
        raise SketchError(f"sketch '{sketch_name}' contains no drawable edges")

    wires = bd.Wire.combine(edges)
    faces = _build_faces_from_wires(list(wires), sketch_name)
    return plane, faces
