#!/usr/bin/env python3
"""Feature builder for `.nuke-cad` documents.

Executes a document's feature tree in topological order, maintaining one
accumulated build123d shape per body. Boolean features (fuse/cut/common)
combine bodies via OCP boolean operations. The final shape is a Compound of
all non-consumed bodies in document body order.

Fuzzy tolerance for boolean operations uses OCP defaults. The DAGMC export
path no longer performs OCP boolean cuts (it uses gmsh fragment/merge
instead), so there is no project-wide fuzzy-tolerance convention to align
with on this code path.
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

import sketch_builder
from reference_scoring import DEFAULT_TOLERANCE_SCALE
from sketch_builder import build_sketch_faces

# Heavy imports are guarded so the module stays importable in the minimal pytest
# profile (pytest + numpy only).
try:
    import reference_resolver as rr

    HAS_REFERENCE_RESOLVER = True
except Exception:
    rr = None  # type: ignore
    HAS_REFERENCE_RESOLVER = False


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


def _require_reference_resolver() -> None:
    """Raise a clear error when the reference resolver is required but unavailable."""
    if not HAS_REFERENCE_RESOLVER or rr is None:
        raise FeatureBuilderError(
            "Topological reference resolution requires OCP (cadquery-ocp/build123d)."
        )


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


def _deterministic_x_dir(normal: tuple[float, float, float]) -> tuple[float, float, float]:
    """Return a deterministic in-plane x-direction for a face normal."""
    nx, ny, nz = normal
    # When the normal is close to world Z, use world X as the fallback so the
    # cross product does not collapse to zero.
    if abs(nz) < 0.999:
        x_dir = (-ny, nx, 0.0)
    else:
        x_dir = (1.0, 0.0, 0.0)
    return _normalized_vector(x_dir)


def _workplane_from_face(topods_face: Any, offset: float = 0.0) -> Any:
    """Build a build123d ``Plane`` from a planar ``TopoDS_Face``.

    The origin is the plane's reference point (a point on the face). ``offset``
    shifts the origin along the face normal.
    """
    if bd is None:
        raise FeatureBuilderError("build123d is not available; cannot build face workplane")
    _require_reference_resolver()

    origin, normal = rr.face_plane_origin_normal(topods_face)
    if offset:
        origin = (
            origin[0] + offset * normal[0],
            origin[1] + offset * normal[1],
            origin[2] + offset * normal[2],
        )
    x_dir = _deterministic_x_dir(normal)
    return bd.Plane(origin=origin, x_dir=x_dir, z_dir=normal)


def _collect_topology_refs(
    feature: dict[str, Any],
    datums: dict[str, dict[str, Any]],
    sketches: dict[str, dict[str, Any]],
) -> list[tuple[str, dict[str, Any]]]:
    """Collect all ``TopologyRef`` dicts associated with a feature.

    Returns a list of ``(path, ref_dict)`` tuples. The paths are stable
    document locations so the frontend can map resolution status back to the
    feature tree.
    """
    refs: list[tuple[str, dict[str, Any]]] = []
    fid = feature.get("id", "<unknown>")
    sketch_id = feature.get("sketchId")
    sketch = sketches.get(sketch_id) if isinstance(sketch_id, str) else None

    if sketch is not None:
        datum_id = sketch.get("datumId")
        datum = datums.get(datum_id) if isinstance(datum_id, str) else None
        if datum is not None and datum.get("kind") == "face":
            ref = datum.get("reference")
            if isinstance(ref, dict):
                refs.append((f"datum.{datum_id}.reference", ref))
        external_refs = sketch.get("externalRefs", [])
        if isinstance(external_refs, list):
            for i, ref in enumerate(external_refs):
                if isinstance(ref, dict):
                    refs.append((f"sketch.{sketch_id}.externalRefs[{i}]", ref))

    params = feature.get("params", {}) if isinstance(feature.get("params"), dict) else {}
    up_to_face = params.get("upToFace")
    if isinstance(up_to_face, dict):
        refs.append((f"feature.{fid}.params.upToFace", up_to_face))

    return refs


def _resolve_document_refs(
    refs_with_paths: list[tuple[str, dict[str, Any]]],
    feature_shapes: dict[str, Any],
    *,
    owner_feature_id: str,
    tolerance_scale: float = DEFAULT_TOLERANCE_SCALE,
    ambiguity_margin: float = 0.05,
) -> tuple[list[Any], list[dict[str, Any]]]:
    """Resolve a heterogeneous list of document TopologyRefs.

    References are grouped by the predecessor feature they point to and by
    topological kind, then resolved in batches against that feature's current
    B-rep. Returns ``(entities, results)`` aligned with the input list.

    The ``featureId`` field in each result record identifies the owning feature
    (the one being built), not the predecessor feature that produced the
    geometry. The predecessor id is encoded in the ``path`` and in the reference
    payload itself.
    """
    _require_reference_resolver()
    assert rr is not None

    if not refs_with_paths:
        return [], []

    path_to_index = {path: i for i, (path, _) in enumerate(refs_with_paths)}
    entities: list[Any] = [None] * len(refs_with_paths)
    results: list[dict[str, Any]] = [
        {
            "featureId": owner_feature_id,
            "path": path,
            "kind": ref.get("kind", "face"),
            "status": "unmatched",
            "candidateId": None,
            "score": 0.0,
            "runnerUpScore": 0.0,
            "candidates": None,
        }
        for path, ref in refs_with_paths
    ]

    groups: dict[tuple[str, str], list[tuple[str, dict[str, Any]]]] = {}
    for path, ref in refs_with_paths:
        feature_id = ref.get("featureId", "")
        kind = ref.get("kind", "face")
        groups.setdefault((feature_id, kind), []).append((path, ref))

    for (feature_id, kind), items in groups.items():
        shape = feature_shapes.get(feature_id)
        if shape is None:
            for path, _ref in items:
                i = path_to_index[path]
                results[i] = {
                    "featureId": owner_feature_id,
                    "path": path,
                    "kind": kind,
                    "status": "unmatched",
                    "candidateId": None,
                    "score": 0.0,
                    "runnerUpScore": 0.0,
                    "candidates": None,
                }
            continue

        try:
            fingerprints = [rr.topology_ref_to_fingerprint(ref) for _, ref in items]
            match_result, entity_map = rr.resolve_references_with_entities(
                fingerprints,
                shape,
                tolerance_scale=tolerance_scale,
                ambiguity_margin=ambiguity_margin,
            )
        except Exception as exc:
            for path, _ref in items:
                i = path_to_index[path]
                results[i] = {
                    "featureId": owner_feature_id,
                    "path": path,
                    "kind": kind,
                    "status": "unmatched",
                    "candidateId": None,
                    "score": 0.0,
                    "runnerUpScore": 0.0,
                    "candidates": None,
                    "error": str(exc),
                }
            continue

        for (path, _ref), match in zip(items, match_result.matches, strict=True):
            i = path_to_index[path]
            entity = entity_map.get(match.candidate_id) if match.candidate_id else None
            entities[i] = entity
            results[i] = {
                "featureId": owner_feature_id,
                "path": path,
                "kind": kind,
                "status": match.status,
                "candidateId": match.candidate_id,
                "score": match.score,
                "runnerUpScore": match.runner_up_score,
                "candidates": [c.to_dict() for c in match.candidates] if match.candidates else None,
            }

    return entities, results


def _project_point_to_plane(
    point: tuple[float, float, float],
    plane: Any,
) -> tuple[float, float]:
    """Project a 3D point onto a build123d ``Plane`` and return 2D sketch coords."""
    if bd is None:
        raise FeatureBuilderError("build123d is not available; cannot project geometry")
    v = bd.Vector(point) - bd.Vector(plane.origin)
    u = float(v.dot(plane.x_dir))
    w = float(v.dot(plane.y_dir))
    return (u, w)


def _primitive_id(prefix: str, index: int) -> str:
    return f"{prefix}_{index:04d}"


def _project_edge_to_sketch(
    topods_edge: Any,
    plane: Any,
    index: int,
) -> list[dict[str, Any]]:
    """Project a ``TopoDS_Edge`` into sketch-plane construction primitives.

    Handles linear edges and circles/arcs that are parallel to the sketch plane.
    Other curve types are approximated by a single construction line between the
    projected endpoints.
    """
    _require_reference_resolver()
    assert rr is not None
    if bd is None:
        raise FeatureBuilderError("build123d is not available; cannot project geometry")

    from OCP.BRepAdaptor import BRepAdaptor_Curve

    curv = BRepAdaptor_Curve(topods_edge)
    ctype = rr._curve_type_string(curv)
    first = curv.FirstParameter()
    last = curv.LastParameter()

    def pnt_3d(param: float) -> tuple[float, float, float]:
        pnt = curv.Value(param)
        return (pnt.X(), pnt.Y(), pnt.Z())

    def pnt_2d(param: float) -> tuple[float, float]:
        return _project_point_to_plane(pnt_3d(param), plane)

    if ctype == "line":
        p1 = pnt_2d(first)
        p2 = pnt_2d(last)
        # Degenerate projection (edge perpendicular to plane) becomes a point.
        if math.hypot(p2[0] - p1[0], p2[1] - p1[1]) < 1e-9:
            return []
        pid = _primitive_id("ext_p", index)
        lid = _primitive_id("ext_l", index)
        return [
            {"id": pid, "type": "point", "x": p1[0], "y": p1[1], "construction": True},
            {"id": f"{pid}_2", "type": "point", "x": p2[0], "y": p2[1], "construction": True},
            {
                "id": lid,
                "type": "line",
                "p1_id": pid,
                "p2_id": f"{pid}_2",
                "construction": True,
            },
        ]

    if ctype in ("circle", "ellipse"):
        circ = curv.Circle() if ctype == "circle" else curv.Ellipse()
        center_3d = (circ.Location().X(), circ.Location().Y(), circ.Location().Z())
        normal_3d = (
            circ.Axis().Direction().X(),
            circ.Axis().Direction().Y(),
            circ.Axis().Direction().Z(),
        )
        sketch_normal = _extract_plane_normal(plane)
        # Only emit a true circle/arc when the source curve lies in a plane
        # parallel to the sketch plane.
        if abs(abs(_dot(normal_3d, sketch_normal)) - 1.0) < 1e-6:
            radius = float(circ.Radius()) if ctype == "circle" else float(circ.MajorRadius())
            center_2d = _project_point_to_plane(center_3d, plane)
            pid = _primitive_id("ext_p", index)
            cid = _primitive_id("ext_c", index)
            return [
                {
                    "id": pid,
                    "type": "point",
                    "x": center_2d[0],
                    "y": center_2d[1],
                    "construction": True,
                },
                {"id": cid, "type": "circle", "c_id": pid, "radius": radius, "construction": True},
            ]

    # Fallback: chord from projected endpoints.
    p1 = pnt_2d(first)
    p2 = pnt_2d(last)
    if math.hypot(p2[0] - p1[0], p2[1] - p1[1]) < 1e-9:
        return []
    pid = _primitive_id("ext_p", index)
    lid = _primitive_id("ext_l", index)
    return [
        {"id": pid, "type": "point", "x": p1[0], "y": p1[1], "construction": True},
        {"id": f"{pid}_2", "type": "point", "x": p2[0], "y": p2[1], "construction": True},
        {
            "id": lid,
            "type": "line",
            "p1_id": pid,
            "p2_id": f"{pid}_2",
            "construction": True,
        },
    ]


def _project_entity_to_sketch(
    topods_entity: Any,
    plane: Any,
    index: int,
) -> list[dict[str, Any]]:
    """Project a resolved face or edge into sketch-plane construction primitives."""
    _require_reference_resolver()
    assert rr is not None
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    shape_type = topods_entity.ShapeType()
    if shape_type == TopAbs_FACE:
        primitives: list[dict[str, Any]] = []
        exp = TopExp_Explorer(topods_entity, TopAbs_EDGE)
        edge_index = 0
        while exp.More():
            edge = TopoDS.Edge_s(exp.Current())
            primitives.extend(_project_edge_to_sketch(edge, plane, index * 100 + edge_index))
            edge_index += 1
            exp.Next()
        return primitives

    if shape_type == TopAbs_EDGE:
        return _project_edge_to_sketch(topods_entity, plane, index)

    return []


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
    feature_shapes: dict[str, Any],
    reference_results: list[dict[str, Any]],
) -> Any:
    """Build the tool shape produced by a single sketch-based feature.

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

    refs_with_paths = _collect_topology_refs(feature, datums, sketches)
    entities, ref_results = _resolve_document_refs(
        refs_with_paths, feature_shapes, owner_feature_id=feature_id
    )
    reference_results.extend(ref_results)

    broken = [r for r in ref_results if r["status"] in ("unmatched", "ambiguous")]
    if broken:
        details = "; ".join(
            f"{r['path']} is {r['status']} (score {r['score']:.3f})" for r in broken
        )
        raise FeatureBuilderError(
            f"feature '{feature_id}' has unresolved topological references: {details}"
        )

    ref_path_to_index = {path: i for i, (path, _) in enumerate(refs_with_paths)}

    # Determine the sketch plane. Face datums use the resolved face; other datum
    # kinds are handled by the sketch builder.
    plane: Any | None = None
    sketch_datum_id = sketch.get("datumId")
    sketch_datum = datums.get(sketch_datum_id) if isinstance(sketch_datum_id, str) else None
    if sketch_datum is not None and sketch_datum.get("kind") == "face":
        datum_ref_path = f"datum.{sketch_datum_id}.reference"
        entity = entities[ref_path_to_index[datum_ref_path]]
        offset = sketch_datum.get("offset", 0.0)
        if (
            not isinstance(offset, (int, float))
            or isinstance(offset, bool)
            or not math.isfinite(offset)
        ):
            offset = 0.0
        plane = _workplane_from_face(entity, offset)

    extra_primitives: list[dict[str, Any]] = []
    for path, _ref in refs_with_paths:
        if path.startswith(f"sketch.{sketch_id}.externalRefs["):
            idx = int(path[path.index("[") + 1 : path.index("]")])
            entity = entities[ref_path_to_index[path]]
            # Ensure we have a plane to project onto.
            if plane is None:
                if sketch_datum is None:
                    raise FeatureBuilderError(
                        f"feature '{feature_id}': sketch '{sketch_id}' has no datum"
                    )
                plane = sketch_builder._build_plane(sketch_datum)
            extra_primitives.extend(_project_entity_to_sketch(entity, plane, idx))

    plane, faces = build_sketch_faces(
        sketch, datums, plane=plane, extra_primitives=extra_primitives
    )
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

        # Profiles with inner wires (holes or islands) are built via boolean
        # subtraction of each inner wire's extrusion from the outer profile's
        # extrusion. This keeps shared cylindrical surfaces originating from the
        # same underlying geometry so DAGMC imprint/merge can seal them exactly.
        # Both pads and pockets use the same semantics: inner wires represent
        # removed material relative to the outer profile.
        tool_shapes: list[Any] = []
        for face in faces:
            inner_wires = face.inner_wires()
            if inner_wires:
                try:
                    outer_face = bd.Face(face.outer_wire())
                except Exception as exc:
                    raise FeatureBuilderError(
                        f"feature '{feature_id}': could not build outer face for {feature_type}"
                    ) from exc
                try:
                    tool = bd.extrude(outer_face, amount=amount, dir=direction, both=both)
                except Exception as exc:
                    raise FeatureBuilderError(
                        f"feature '{feature_id}': {feature_type} extrusion failed"
                    ) from exc
                for hole_wire in inner_wires:
                    try:
                        hole_solid = bd.extrude(
                            bd.Face(hole_wire), amount=amount, dir=direction, both=both
                        )
                    except Exception as exc:
                        raise FeatureBuilderError(
                            f"feature '{feature_id}': {feature_type} hole extrusion failed"
                        ) from exc
                    try:
                        tool = tool - hole_solid
                    except Exception as exc:
                        raise FeatureBuilderError(
                            f"feature '{feature_id}': {feature_type} boolean subtraction failed"
                        ) from exc
                tool_shapes.append(tool)
            else:
                try:
                    tool_shapes.append(bd.extrude(face, amount=amount, dir=direction, both=both))
                except Exception as exc:
                    raise FeatureBuilderError(
                        f"feature '{feature_id}': {feature_type} extrusion failed"
                    ) from exc

        if len(tool_shapes) == 1:
            return tool_shapes[0]
        return bd.Compound(children=tool_shapes)

    # revolve / groove
    axis = params.get("axis")
    if axis not in _AXIS_VECTOR:
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

    # The revolve axis must lie in the sketch plane; a non-planar axis would
    # sweep the profile out of itself and produce an invalid or surprising solid.
    plane_normal = _extract_plane_normal(plane)
    axis_vector = _AXIS_VECTOR[axis]
    if abs(_dot(plane_normal, axis_vector)) > 1e-6:
        raise FeatureBuilderError(
            f"feature '{feature_id}': revolve/groove axis '{axis}' must lie in the sketch plane"
        )

    _ensure_build_axis()
    try:
        return bd.revolve(faces, axis=_BUILD_AXIS[axis], revolution_arc=float(angle))
    except Exception as exc:
        raise FeatureBuilderError(
            f"feature '{feature_id}': revolve/groove operation failed"
        ) from exc


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


def _bbox_overlaps_3d(a_bbox: Any, b_bbox: Any, tolerance: float = 1e-6) -> bool:
    """Return True if two build123d ``BoundBox`` instances overlap."""
    return (
        a_bbox.min.X <= b_bbox.max.X + tolerance
        and a_bbox.max.X >= b_bbox.min.X - tolerance
        and a_bbox.min.Y <= b_bbox.max.Y + tolerance
        and a_bbox.max.Y >= b_bbox.min.Y - tolerance
        and a_bbox.min.Z <= b_bbox.max.Z + tolerance
        and a_bbox.max.Z >= b_bbox.min.Z - tolerance
    )


def _combine_additive(a: Any, b: Any, feature_id: str = "<unknown>") -> Any:
    """Combine two additive tool shapes into a single ``Compound``.

    Using ``Compound(children=[...])`` instead of the ``+`` boolean union keeps
    touching-but-separate regions (e.g. fuel/clad/moderator) as distinct solids
    so they can be labeled independently.

    Overlapping additive tools would create non-manifold or duplicate-volume
    geometry, so a bbox prefilter plus boolean-common volume check raises
    ``FeatureBuilderError`` if the two solids occupy the same space. Cross-body
    overlaps are caught separately by the final overlap gate in
    ``build_document_shape``.
    """
    if bd is None:
        raise FeatureBuilderError("build123d is not available; cannot combine additive shapes")

    # Fast bbox rejection before invoking a boolean operation.
    if _bbox_overlaps_3d(a.bounding_box(), b.bounding_box()):
        try:
            common = a & b
        except Exception as exc:
            raise FeatureBuilderError(
                f"feature '{feature_id}': failed to check overlap between additive bodies: {exc}"
            ) from exc
        if common is not None and getattr(common, "volume", 0.0) > 1e-9:
            raise FeatureBuilderError(
                f"feature '{feature_id}': additive body overlaps an existing solid body"
            )

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


def _body_tip_feature_id(
    features: list[dict[str, Any]], body_id: str, before_index: int
) -> str | None:
    """Return the most recent feature targeting ``body_id`` before ``before_index``.

    The tip is the last feature in document order that references the body,
    regardless of suppression. Suppressed tips make dependent features stale
    during the build loop.
    """
    for i in range(before_index - 1, -1, -1):
        if features[i].get("body") == body_id:
            return features[i]["id"]
    return None


def _compute_implied_dependencies(
    features: list[dict[str, Any]],
) -> list[tuple[str, str]]:
    """Return implied dependency edges derived from body semantics.

    Edges are returned as ``(dependent_id, dependency_id)`` tuples. The caller
    injects them into each feature's ``dependsOn`` before topological sorting.

    Rules:
      * A feature depends on the previous feature (in document order) targeting
        the same body.
      * A boolean feature depends on the current tip feature of every tool body.
        The target body's tip is the same as the same-body previous feature, so
        it is not duplicated.
    """
    edges: list[tuple[str, str]] = []
    body_last_index: dict[str, int] = {}
    for i, feature in enumerate(features):
        body_id = feature.get("body")
        if isinstance(body_id, str) and body_id:
            prev_index = body_last_index.get(body_id)
            if prev_index is not None:
                edges.append((feature["id"], features[prev_index]["id"]))
            body_last_index[body_id] = i

    for i, feature in enumerate(features):
        if feature.get("type") not in ("booleanFuse", "booleanCut", "booleanCommon"):
            continue
        params = feature.get("params", {}) if isinstance(feature.get("params"), dict) else {}
        tool_bodies = params.get("toolBodies")
        if not isinstance(tool_bodies, list):
            continue
        for tool_body in tool_bodies:
            if not isinstance(tool_body, str):
                continue
            tip = _body_tip_feature_id(features, tool_body, i)
            if tip is not None and tip != feature["id"]:
                edges.append((feature["id"], tip))
    return edges


def _boolean_operation(target: Any, tools: list[Any], op: str) -> Any:
    """Apply an OCP boolean operation between a target and a list of tools."""
    if bd is None:
        raise FeatureBuilderError("build123d is not available; cannot apply boolean operations")
    if not tools:
        raise FeatureBuilderError("boolean operation requires at least one tool body")

    combined_tool = tools[0]
    for tool in tools[1:]:
        combined_tool = combined_tool + tool

    try:
        if op == "booleanFuse":
            return target + combined_tool
        if op == "booleanCut":
            return target - combined_tool
        if op == "booleanCommon":
            return target & combined_tool
    except Exception as exc:
        raise FeatureBuilderError(f"boolean {op} failed: {exc}") from exc
    raise FeatureBuilderError(f"unknown boolean operation '{op}'")


def _solid_count(shape: Any) -> int:
    """Return the number of solids in a build123d shape."""
    if shape is None:
        return 0
    return len(shape.solids())


def _check_cross_body_overlap(bodies: list[Any], body_ids: list[str]) -> None:
    """Raise FeatureBuilderError when non-consumed bodies overlap in space."""
    if bd is None:
        return
    for i in range(len(bodies)):
        for j in range(i + 1, len(bodies)):
            a = bodies[i]
            b = bodies[j]
            if a is None or b is None:
                continue
            if not _bbox_overlaps_3d(a.bounding_box(), b.bounding_box()):
                continue
            try:
                common = a & b
            except Exception as exc:
                raise FeatureBuilderError(
                    f"failed to check overlap between bodies '{body_ids[i]}' and '{body_ids[j]}': {exc}"
                ) from exc
            if common is not None and getattr(common, "volume", 0.0) > 1e-9:
                raise FeatureBuilderError(
                    f"bodies '{body_ids[i]}' and '{body_ids[j]}' overlap but are not merged by a boolean"
                )


def build_document_shape(
    document: dict[str, Any],
) -> dict[str, Any]:
    """Build the shape described by a ``.nuke-cad`` document.

    Returns a dict with:

        ``shape``
            The assembled build123d shape, or ``None`` if no additive feature
            succeeded.
        ``selectorMap``
            Mapping from body label to sorted 1-based solid indices.
        ``featureResults``
            List of ``{featureId, status, bodyId, error?, consumedBodyIds?}``
            records in build order.
        ``referenceResults``
            List of per-reference resolution status records.
        ``consumedBodies``
            Set of body ids consumed by boolean operations.
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
    raw_features = document.get("features", [])
    features = [
        dict(f) for f in raw_features if isinstance(f, dict) and isinstance(f.get("id"), str)
    ]

    # Inject implied dependencies so the topological sort respects body order
    # and boolean tool-body tips.
    implied = _compute_implied_dependencies(features)
    feature_map = {f["id"]: f for f in features}
    for dependent_id, dependency_id in implied:
        feature = feature_map.get(dependent_id)
        if feature is None or dependency_id in feature.get("dependsOn", []):
            continue
        feature.setdefault("dependsOn", []).append(dependency_id)

    order = topo_sort_features(features)

    bodies = document.get("bodies", [])
    body_ids = [b["id"] for b in bodies if isinstance(b, dict) and isinstance(b.get("id"), str)]
    body_labels = {
        b["id"]: b.get("label")
        for b in bodies
        if isinstance(b, dict)
        and isinstance(b.get("id"), str)
        and isinstance(b.get("label"), str)
        and b["label"]
    }

    accumulators: dict[str, Any] = {}
    selector_map: dict[str, list[int]] = {}
    feature_results: list[dict[str, Any]] = []
    reference_results: list[dict[str, Any]] = []
    stale_or_failed: set[str] = set()
    feature_shapes: dict[str, Any] = {}
    consumed_bodies: set[str] = set()

    for feature_id in order:
        feature = feature_map[feature_id]
        body_id = feature.get("body", "")

        if feature.get("suppressed"):
            feature_results.append({"featureId": feature_id, "bodyId": body_id, "status": "stale"})
            stale_or_failed.add(feature_id)
            continue

        dependency_status = (
            "stale" if any(dep in stale_or_failed for dep in feature.get("dependsOn", [])) else None
        )
        if dependency_status:
            feature_results.append({"featureId": feature_id, "bodyId": body_id, "status": "stale"})
            stale_or_failed.add(feature_id)
            continue

        feature_type = feature["type"]

        if feature_type in ("booleanFuse", "booleanCut", "booleanCommon"):
            params = feature.get("params", {}) if isinstance(feature.get("params"), dict) else {}
            target_body = params.get("targetBody", "")
            tool_bodies = params.get("toolBodies", [])
            keep_tools = bool(params.get("keepTools", False))
            error: str | None = None

            if not isinstance(target_body, str) or not target_body:
                error = f"feature '{feature_id}': boolean requires a targetBody"
            elif not isinstance(tool_bodies, list) or not tool_bodies:
                error = f"feature '{feature_id}': boolean requires at least one tool body"
            elif target_body not in accumulators:
                error = f"feature '{feature_id}': target body '{target_body}' has no geometry"
            elif any(tool not in accumulators for tool in tool_bodies):
                missing = [tool for tool in tool_bodies if tool not in accumulators]
                error = (
                    f"feature '{feature_id}': tool bodies have no geometry: {', '.join(missing)}"
                )
            elif any(tool not in body_ids for tool in tool_bodies):
                missing = [tool for tool in tool_bodies if tool not in body_ids]
                error = f"feature '{feature_id}': unknown tool bodies: {', '.join(missing)}"

            if error is not None:
                feature_results.append(
                    {"featureId": feature_id, "bodyId": body_id, "status": "failed", "error": error}
                )
                stale_or_failed.add(feature_id)
                continue

            target_shape = accumulators[target_body]
            tool_shapes = [accumulators[t] for t in tool_bodies]
            try:
                result_shape = _boolean_operation(target_shape, tool_shapes, feature_type)
            except Exception as exc:
                feature_results.append(
                    {
                        "featureId": feature_id,
                        "bodyId": body_id,
                        "status": "failed",
                        "error": str(exc),
                    }
                )
                stale_or_failed.add(feature_id)
                continue

            accumulators[target_body] = result_shape
            feature_shapes[feature_id] = getattr(result_shape, "wrapped", result_shape)
            consumed = [] if keep_tools else list(tool_bodies)
            if not keep_tools:
                consumed_bodies.update(tool_bodies)
            feature_results.append(
                {
                    "featureId": feature_id,
                    "bodyId": body_id,
                    "status": "built",
                    "consumedBodyIds": consumed,
                }
            )
            continue

        # Sketch-based solid feature (pad/pocket/revolve/groove).
        try:
            tool_shape = _build_feature_shape(
                feature, datums, sketches, feature_shapes, reference_results
            )
        except Exception as exc:
            feature_results.append(
                {"featureId": feature_id, "bodyId": body_id, "status": "failed", "error": str(exc)}
            )
            stale_or_failed.add(feature_id)
            continue

        previous_body = accumulators.get(body_id)

        try:
            if feature_type in ("pad", "revolve"):
                if previous_body is None:
                    accumulators[body_id] = tool_shape
                else:
                    accumulators[body_id] = _combine_additive(previous_body, tool_shape, feature_id)
            elif feature_type in ("pocket", "groove"):
                if previous_body is None:
                    raise FeatureBuilderError(
                        f"feature '{feature_id}': {feature_type} requires an existing solid body"
                    )
                accumulators[body_id] = previous_body - tool_shape
            else:
                raise FeatureBuilderError(
                    f"feature '{feature_id}': type '{feature_type}' is not supported yet"
                )
        except Exception as exc:
            feature_results.append(
                {"featureId": feature_id, "bodyId": body_id, "status": "failed", "error": str(exc)}
            )
            stale_or_failed.add(feature_id)
            continue

        current_body = accumulators[body_id]
        feature_shapes[feature_id] = getattr(current_body, "wrapped", current_body)
        feature_results.append({"featureId": feature_id, "bodyId": body_id, "status": "built"})

    # Final assembly: Compound of non-consumed bodies in document body order.
    final_children: list[Any] = []
    active_body_ids: list[str] = []
    active_body_shapes: list[Any] = []
    body_index_offset: dict[str, int] = {}
    current_solid_count = 0

    for body_id in body_ids:
        if body_id in consumed_bodies:
            continue
        shape = accumulators.get(body_id)
        if shape is None:
            continue
        body_index_offset[body_id] = current_solid_count
        count = _solid_count(shape)
        current_solid_count += count
        final_children.append(shape)
        active_body_ids.append(body_id)
        active_body_shapes.append(shape)

    if not final_children:
        return {
            "shape": None,
            "selectorMap": selector_map,
            "featureResults": feature_results,
            "referenceResults": reference_results,
            "consumedBodies": sorted(consumed_bodies),
            "solidBodyIds": [],
        }

    _check_cross_body_overlap(active_body_shapes, active_body_ids)

    assembled = (
        final_children[0] if len(final_children) == 1 else bd.Compound(children=final_children)
    )

    # Build selector map from body labels to 1-based solid indices in the final compound.
    solid_body_ids: list[str] = []
    for body_id in active_body_ids:
        label = body_labels.get(body_id)
        offset = body_index_offset[body_id]
        count = _solid_count(accumulators[body_id])
        indices = list(range(offset + 1, offset + count + 1))
        solid_body_ids.extend([body_id] * count)
        if label and indices:
            existing = selector_map.setdefault(label, [])
            for idx in indices:
                if idx not in existing:
                    existing.append(idx)
            existing.sort()

    return {
        "shape": assembled,
        "selectorMap": selector_map,
        "featureResults": feature_results,
        "referenceResults": reference_results,
        "consumedBodies": sorted(consumed_bodies),
        "solidBodyIds": solid_body_ids,
    }
