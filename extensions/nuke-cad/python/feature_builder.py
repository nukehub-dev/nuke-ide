#!/usr/bin/env python3
"""Feature builder for `.nuke-cad` documents.

Executes a document's feature tree in topological order, producing a single
accumulated build123d shape and a selector map from feature labels to solid
indices. Full rebuilds are performed on every call; per-feature shape caching is
deliberately deferred.
"""

from __future__ import annotations

import math
from typing import Any

# Heavy imports are guarded so the module stays importable in the minimal pytest
# profile (pytest + numpy only).
try:
    import build123d as bd

    HAS_BUILD123D = True
except Exception:
    bd = None  # type: ignore
    HAS_BUILD123D = False

from sketch_builder import build_sketch_faces


class FeatureBuilderError(ValueError):
    """Raised when the feature tree cannot be built."""


_AXIS_VECTOR: dict[str, tuple[float, float, float]] = {
    "x": (1.0, 0.0, 0.0),
    "y": (0.0, 1.0, 0.0),
    "z": (0.0, 0.0, 1.0),
}

_BUILD_AXIS: dict[str, Any] = {}


def _ensure_build_axis() -> None:
    """Populate the build123d axis cache once imports are available."""
    if bd is None:
        return
    if not _BUILD_AXIS:
        _BUILD_AXIS["x"] = bd.Axis.X
        _BUILD_AXIS["y"] = bd.Axis.Y
        _BUILD_AXIS["z"] = bd.Axis.Z


def _normalized_vector(v: tuple[float, float, float]) -> tuple[float, float, float]:
    """Return a unit vector in the same direction as ``v``."""
    length = math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)
    if length == 0.0:
        raise FeatureBuilderError("cannot use a zero-length direction vector")
    return (v[0] / length, v[1] / length, v[2] / length)


def _dot(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _extract_plane_normal(plane: Any) -> tuple[float, float, float]:
    """Return the normal vector of a build123d ``Plane``."""
    return (float(plane.z_dir.X), float(plane.z_dir.Y), float(plane.z_dir.Z))


def _extrude_direction(
    plane: Any,
    axis: str | None,
    feature_context: str,
) -> Any:
    """Return the build123d extrusion direction for a sketch plane.

    The default direction is the sketch plane normal. If ``axis`` is supplied it
    must be parallel to the plane normal (either direction); anything else is an
    error for Tier 1 because the schema does not yet support draft/extrude along
    an arbitrary vector.
    """
    if bd is None:
        raise FeatureBuilderError("build123d is not available; cannot compute extrude direction")

    normal = _extract_plane_normal(plane)
    if axis is None:
        return bd.Vector(normal)

    if axis not in _AXIS_VECTOR:
        raise FeatureBuilderError(f"{feature_context}: unknown axis '{axis}'")
    axis_vector = _AXIS_VECTOR[axis]
    if abs(abs(_dot(normal, axis_vector)) - 1.0) > 1e-6:
        raise FeatureBuilderError(
            f"{feature_context}: extrude axis '{axis}' is not aligned with the sketch plane normal"
        )
    return bd.Vector(axis_vector)


def _build_feature_shape(
    feature: dict[str, Any],
    datums: dict[str, dict[str, Any]],
    sketches: dict[str, dict[str, Any]],
) -> Any:
    """Build the tool shape produced by a single feature.

    Returns a build123d ``Shape`` (typically a ``Solid`` or ``Part``).
    """
    if bd is None:
        raise FeatureBuilderError("build123d is not available; cannot build feature shapes")

    _ensure_build_axis()
    feature_id = feature["id"]
    feature_type = feature["type"]
    params = feature.get("params", {}) if isinstance(feature.get("params"), dict) else {}

    if feature_type not in ("pad", "pocket", "revolve", "groove"):
        raise FeatureBuilderError(
            f"feature '{feature_id}': type '{feature_type}' is not supported yet"
        )

    sketch_id = feature.get("sketchId")
    if not isinstance(sketch_id, str) or not sketch_id:
        raise FeatureBuilderError(f"feature '{feature_id}' ({feature_type}) requires a sketchId")
    sketch = sketches.get(sketch_id)
    if sketch is None:
        raise FeatureBuilderError(f"feature '{feature_id}' references unknown sketch '{sketch_id}'")

    plane, faces = build_sketch_faces(sketch, datums)
    if not faces:
        raise FeatureBuilderError(f"feature '{feature_id}': sketch '{sketch_id}' produced no faces")

    if feature_type in ("pad", "pocket"):
        length = params.get("length")
        if (
            not isinstance(length, (int, float))
            or isinstance(length, bool)
            or not math.isfinite(length)
            or length <= 0
        ):
            raise FeatureBuilderError(
                f"feature '{feature_id}': pad/pocket requires a positive length"
            )
        length = float(length)
        symmetric = bool(params.get("symmetric", False))
        axis = params.get("axis")
        direction = _extrude_direction(plane, axis, f"feature '{feature_id}'")
        if symmetric:
            amount = length / 2.0
            both = True
        else:
            amount = length
            both = False

        # Additive pads with holes (e.g. concentric pincell regions) are built
        # via boolean subtraction instead of extruding a face with holes. This
        # makes shared cylindrical surfaces originate from the same underlying
        # geometry, which lets DAGMC imprint/merge them without tiny sealing
        # mismatches.
        tool_shapes: list[Any] = []
        for face in faces:
            inner_wires = face.inner_wires()
            if feature_type == "pad" and inner_wires:
                outer_face = bd.Face(face.outer_wire())
                tool = bd.extrude(outer_face, amount=amount, dir=direction, both=both)
                for hole_wire in inner_wires:
                    hole_solid = bd.extrude(
                        bd.Face(hole_wire), amount=amount, dir=direction, both=both
                    )
                    tool = tool - hole_solid
                tool_shapes.append(tool)
            else:
                tool_shapes.append(bd.extrude(face, amount=amount, dir=direction, both=both))

        if len(tool_shapes) == 1:
            return tool_shapes[0]
        return bd.Compound(children=tool_shapes)

    # revolve / groove
    axis = params.get("axis")
    if axis not in _BUILD_AXIS:
        raise FeatureBuilderError(
            f"feature '{feature_id}': revolve/groove requires axis 'x', 'y', or 'z'"
        )
    angle = params.get("angle")
    if (
        not isinstance(angle, (int, float))
        or isinstance(angle, bool)
        or not math.isfinite(angle)
        or angle <= 0
        or angle > 360
    ):
        raise FeatureBuilderError(f"feature '{feature_id}': revolve angle must be in (0, 360]")
    return bd.revolve(faces, axis=_BUILD_AXIS[axis], revolution_arc=float(angle))


def topo_sort_features(features: list[dict[str, Any]]) -> list[str]:
    """Return feature ids in topological order (dependencies first).

    Raises ``FeatureBuilderError`` when a dependency cycle is detected, naming
    the members of the cycle.
    """
    feature_map = {f["id"]: f for f in features}
    missing = [
        f"feature '{f['id']}' depends on unknown feature '{dep}'"
        for f in features
        for dep in f.get("dependsOn", [])
        if dep not in feature_map
    ]
    if missing:
        raise FeatureBuilderError("; ".join(missing))

    in_degree: dict[str, int] = dict.fromkeys(feature_map, 0)
    dependents: dict[str, list[str]] = {fid: [] for fid in feature_map}
    for f in features:
        fid = f["id"]
        for dep in f.get("dependsOn", []):
            in_degree[fid] += 1
            dependents[dep].append(fid)

    queue = sorted([fid for fid, degree in in_degree.items() if degree == 0])
    sorted_ids: list[str] = []
    while queue:
        fid = queue.pop(0)
        sorted_ids.append(fid)
        for dependent in sorted(dependents[fid]):
            in_degree[dependent] -= 1
            if in_degree[dependent] == 0:
                queue.append(dependent)
        queue.sort()

    if len(sorted_ids) != len(feature_map):
        cycle = _find_cycle(features)
        raise FeatureBuilderError(f"feature dependency cycle detected: {' -> '.join(cycle)}")

    return sorted_ids


def _find_cycle(features: list[dict[str, Any]]) -> list[str]:
    """Return a readable cycle from the feature dependency graph."""
    feature_map = {f["id"]: f for f in features}
    state: dict[str, str] = dict.fromkeys(feature_map, "unvisited")
    path: list[str] = []

    def dfs(fid: str) -> list[str] | None:
        state[fid] = "visiting"
        path.append(fid)
        for dep in feature_map[fid].get("dependsOn", []):
            if dep not in state:
                continue
            if state[dep] == "visiting":
                start = path.index(dep)
                return path[start:] + [dep]
            if state[dep] == "unvisited":
                result = dfs(dep)
                if result:
                    return result
        path.pop()
        state[fid] = "visited"
        return None

    for fid in sorted(feature_map):
        if state[fid] == "unvisited":
            cycle = dfs(fid)
            if cycle:
                return cycle
    return list(feature_map.keys())[:1] or ["<unknown>"]


def _selector_indices_for_tool(
    tool_shape: Any,
    previous_solid_count: int,
) -> list[int]:
    """Return the 1-based indices of solids added by ``tool_shape``.

    Additive features are accumulated as a ``Compound`` so that distinct solids
    (e.g. concentric pincell regions) remain separate. The new solids are always
    appended after the existing ones, so the indices are a simple contiguous
    range.
    """
    new_count = len(tool_shape.solids()) if tool_shape is not None else 0
    return list(range(previous_solid_count + 1, previous_solid_count + new_count + 1))


def _combine_additive(a: Any, b: Any) -> Any:
    """Combine two additive tool shapes into a single ``Compound``.

    Using ``Compound(children=[...])`` instead of the ``+`` boolean union keeps
    touching-but-separate regions (e.g. fuel/clad/moderator) as distinct solids
    so they can be labeled independently.
    """
    if bd is None:
        raise FeatureBuilderError("build123d is not available; cannot combine additive shapes")
    children: list[Any] = []
    for shape in (a, b):
        # ``Part`` subclasses ``Compound`` but represents a single fused body;
        # do not decompose it. Boolean results may also be ``Compound`` objects
        # that carry solids without populated ``children``; keep those whole too.
        if isinstance(shape, bd.Compound) and not isinstance(shape, bd.Part):
            sub_children = list(shape.children)
            if sub_children:
                children.extend(sub_children)
                continue
        children.append(shape)
    return bd.Compound(children=children)


def build_document_shape(
    document: dict[str, Any],
) -> dict[str, Any]:
    """Build the shape described by a ``.nuke-cad`` document.

    Returns a dict with:

        ``shape``
            The accumulated build123d shape, or ``None`` if no additive feature
            succeeded.
        ``selectorMap``
            Mapping from feature label to sorted 1-based solid indices.
        ``featureResults``
            List of ``{featureId, status, error?}`` records in build order.
    """
    if bd is None:
        raise FeatureBuilderError("build123d is not available; cannot build document shape")

    datums = {
        d["id"]: d
        for d in document.get("datums", [])
        if isinstance(d, dict) and isinstance(d.get("id"), str)
    }
    sketches = {
        s["id"]: s
        for s in document.get("sketches", [])
        if isinstance(s, dict) and isinstance(s.get("id"), str)
    }
    features = [
        f
        for f in document.get("features", [])
        if isinstance(f, dict) and isinstance(f.get("id"), str)
    ]

    order = topo_sort_features(features)
    feature_map = {f["id"]: f for f in features}

    accumulated: Any | None = None
    selector_map: dict[str, list[int]] = {}
    feature_results: list[dict[str, Any]] = []
    stale_or_failed: set[str] = set()

    for feature_id in order:
        feature = feature_map[feature_id]

        if feature.get("suppressed"):
            feature_results.append({"featureId": feature_id, "status": "stale"})
            stale_or_failed.add(feature_id)
            continue

        dependency_status = (
            "stale" if any(dep in stale_or_failed for dep in feature.get("dependsOn", [])) else None
        )
        if dependency_status:
            feature_results.append({"featureId": feature_id, "status": "stale"})
            stale_or_failed.add(feature_id)
            continue

        try:
            tool_shape = _build_feature_shape(feature, datums, sketches)
        except Exception as exc:
            feature_results.append({"featureId": feature_id, "status": "failed", "error": str(exc)})
            stale_or_failed.add(feature_id)
            continue

        feature_type = feature["type"]
        previous_solid_count = len(accumulated.solids()) if accumulated is not None else 0
        try:
            if feature_type in ("pad", "revolve"):
                if accumulated is None:
                    accumulated = tool_shape
                else:
                    accumulated = _combine_additive(accumulated, tool_shape)
            elif feature_type in ("pocket", "groove"):
                if accumulated is None:
                    raise FeatureBuilderError(
                        f"feature '{feature_id}': {feature_type} requires an existing solid body"
                    )
                accumulated = accumulated - tool_shape
            else:
                raise FeatureBuilderError(
                    f"feature '{feature_id}': type '{feature_type}' is not supported yet"
                )
        except Exception as exc:
            feature_results.append({"featureId": feature_id, "status": "failed", "error": str(exc)})
            stale_or_failed.add(feature_id)
            continue

        label = feature.get("label")
        if label and isinstance(label, str) and feature_type in ("pad", "revolve"):
            indices = _selector_indices_for_tool(tool_shape, previous_solid_count)
            if indices:
                existing = selector_map.setdefault(label, [])
                for idx in indices:
                    if idx not in existing:
                        existing.append(idx)
                existing.sort()

        feature_results.append({"featureId": feature_id, "status": "built"})

    return {
        "shape": accumulated,
        "selectorMap": selector_map,
        "featureResults": feature_results,
    }
