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

_PLANE_MAP: dict[str, str] = {
    "XY": "XY",
    "YZ": "YZ",
    "XZ": "XZ",
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


def _face_centroid(topods_face: Any) -> tuple[float, float, float]:
    """Return the centroid of a ``TopoDS_Face`` (the trimmed face's centre of mass)."""
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(topods_face, props)
    cog = props.CentreOfMass()
    return (float(cog.X()), float(cog.Y()), float(cog.Z()))


def _workplane_from_face(topods_face: Any, offset: float = 0.0) -> Any:
    """Build a build123d ``Plane`` from a planar ``TopoDS_Face``.

    The origin is the face centroid so that ``[0, 0]`` in workplane coordinates
    is always at the centre of the face, regardless of where the underlying
    surface's reference point lies. ``offset`` shifts the origin along the face
    normal.
    """
    if bd is None:
        raise FeatureBuilderError("build123d is not available; cannot build face workplane")
    _require_reference_resolver()

    origin = _face_centroid(topods_face)
    _normal = rr.face_plane_origin_normal(topods_face)[1]
    normal = _normalized_vector(_normal)
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

    feature_type = feature.get("type")
    if feature_type in ("fillet", "chamfer"):
        edges = params.get("edges")
        if isinstance(edges, list):
            for i, ref in enumerate(edges):
                if isinstance(ref, dict):
                    refs.append((f"feature.{fid}.params.edges[{i}]", ref))
    elif feature_type in ("draft", "shell"):
        faces = params.get("faces")
        if isinstance(faces, list):
            for i, ref in enumerate(faces):
                if isinstance(ref, dict):
                    refs.append((f"feature.{fid}.params.faces[{i}]", ref))
    elif feature_type == "hole":
        face_ref = params.get("face")
        if isinstance(face_ref, dict):
            refs.append((f"feature.{fid}.params.face", face_ref))
    elif feature_type == "circularPattern":
        axis_datum_id = params.get("axisDatumId")
        if isinstance(axis_datum_id, str):
            datum = datums.get(axis_datum_id)
            if isinstance(datum, dict) and datum.get("kind") == "face":
                ref = datum.get("reference")
                if isinstance(ref, dict):
                    refs.append((f"datum.{axis_datum_id}.reference", ref))
    elif feature_type == "mirror":
        plane_datum_id = params.get("planeDatumId")
        if isinstance(plane_datum_id, str):
            datum = datums.get(plane_datum_id)
            if isinstance(datum, dict) and datum.get("kind") == "face":
                ref = datum.get("reference")
                if isinstance(ref, dict):
                    refs.append((f"datum.{plane_datum_id}.reference", ref))

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


def _resolve_refs_against_shape(
    refs_with_paths: list[tuple[str, dict[str, Any]]],
    shape: Any,
    *,
    owner_feature_id: str,
    tolerance_scale: float = DEFAULT_TOLERANCE_SCALE,
    ambiguity_margin: float = 0.05,
) -> tuple[list[Any], list[dict[str, Any]]]:
    """Resolve all ``TopologyRef`` objects against a single shape.

    This is used by dress-up features whose references must resolve against the
    current body state rather than the historical shape recorded at pick time.
    """
    _require_reference_resolver()
    assert rr is not None

    if not refs_with_paths:
        return [], []

    fingerprints = [rr.topology_ref_to_fingerprint(ref) for _, ref in refs_with_paths]
    try:
        match_result, entity_map = rr.resolve_references_with_entities(
            fingerprints,
            shape,
            tolerance_scale=tolerance_scale,
            ambiguity_margin=ambiguity_margin,
        )
    except Exception as exc:
        results = [
            {
                "featureId": owner_feature_id,
                "path": path,
                "kind": ref.get("kind", "face"),
                "status": "unmatched",
                "candidateId": None,
                "score": 0.0,
                "runnerUpScore": 0.0,
                "candidates": None,
                "error": str(exc),
            }
            for path, ref in refs_with_paths
        ]
        return [None] * len(refs_with_paths), results

    entities: list[Any] = []
    results: list[dict[str, Any]] = []
    for (path, ref), match in zip(refs_with_paths, match_result.matches, strict=True):
        entity = entity_map.get(match.candidate_id) if match.candidate_id else None
        entities.append(entity)
        results.append(
            {
                "featureId": owner_feature_id,
                "path": path,
                "kind": ref.get("kind", "face"),
                "status": match.status,
                "candidateId": match.candidate_id,
                "score": match.score,
                "runnerUpScore": match.runner_up_score,
                "candidates": [c.to_dict() for c in match.candidates] if match.candidates else None,
            }
        )

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


def _require_build123d() -> None:
    """Raise a clear error when build123d is required but unavailable."""
    if bd is None or not HAS_BUILD123D:
        raise FeatureBuilderError("build123d is not available; cannot build feature shapes")


def _apply_fillet(body: Any, edges: list[Any], radius: float, feature_id: str) -> Any:
    """Apply a fillet to ``edges`` of ``body`` with the given radius."""
    _require_build123d()
    if not edges:
        raise FeatureBuilderError(f"feature '{feature_id}': fillet requires at least one edge")
    try:
        bd_edges = []
        for edge in edges:
            be = bd.Edge(edge)
            be.topo_parent = body
            bd_edges.append(be)
        return bd.fillet(bd_edges, radius)
    except Exception as exc:
        raise FeatureBuilderError(f"feature '{feature_id}': fillet failed: {exc}") from exc


def _apply_chamfer(body: Any, edges: list[Any], params: dict[str, Any], feature_id: str) -> Any:
    """Apply a chamfer to ``edges`` of ``body``.

    Supports three mutually exclusive modes:
      * symmetric: ``distance``
      * two-distance: ``distances`` tuple
      * distance+angle: ``distance`` + ``angle`` (angle in degrees)
    """
    _require_build123d()
    if not edges:
        raise FeatureBuilderError(f"feature '{feature_id}': chamfer requires at least one edge")

    distance = params.get("distance")
    distances = params.get("distances")
    angle = params.get("angle")

    try:
        bd_edges = []
        for edge in edges:
            be = bd.Edge(edge)
            be.topo_parent = body
            bd_edges.append(be)
        if isinstance(distances, (list, tuple)) and len(distances) == 2:
            if distance is not None:
                raise FeatureBuilderError(
                    f"feature '{feature_id}': chamfer cannot specify both distance and distances"
                )
            if angle is not None:
                raise FeatureBuilderError(
                    f"feature '{feature_id}': chamfer cannot specify angle with distances"
                )
            return bd.chamfer(bd_edges, distances[0], distances[1])
        if distance is not None and angle is not None:
            return bd.chamfer(bd_edges, distance, angle=angle)
        if distance is not None:
            return bd.chamfer(bd_edges, distance)
        raise FeatureBuilderError(
            f"feature '{feature_id}': chamfer requires distance, distances, or distance+angle"
        )
    except FeatureBuilderError:
        raise
    except Exception as exc:
        raise FeatureBuilderError(f"feature '{feature_id}': chamfer failed: {exc}") from exc


def _apply_draft(
    body: Any,
    faces: list[Any],
    pull_direction: tuple[float, float, float],
    angle: float,
    feature_id: str,
) -> Any:
    """Apply a draft angle to ``faces`` of ``body``.

    The neutral plane for each face passes through the face centroid and is
    perpendicular to ``pull_direction``.
    """
    _require_build123d()
    if not faces:
        raise FeatureBuilderError(f"feature '{feature_id}': draft requires at least one face")

    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepGProp import BRepGProp
    from OCP.BRepOffsetAPI import BRepOffsetAPI_DraftAngle
    from OCP.gp import gp_Dir, gp_Pln, gp_Pnt
    from OCP.GProp import GProp_GProps

    _require_reference_resolver()
    assert rr is not None
    direction = gp_Dir(*_normalized_vector(pull_direction))
    shape = body.wrapped if hasattr(body, "wrapped") else body
    draft = BRepOffsetAPI_DraftAngle(shape)
    for face in faces:
        surf = BRepAdaptor_Surface(face)
        if rr._surface_type_string(surf) != "plane":
            raise FeatureBuilderError(f"feature '{feature_id}': draft only supports planar faces")
        props = GProp_GProps()
        BRepGProp.SurfaceProperties_s(face, props)
        com = props.CentreOfMass()
        # Neutral plane is perpendicular to the pull direction and passes
        # through the face centroid.
        neutral = gp_Pln(gp_Pnt(com.X(), com.Y(), com.Z()), direction)
        draft.Add(face, direction, math.radians(angle), neutral)
        if not draft.AddDone():
            raise FeatureBuilderError(f"feature '{feature_id}': draft could not be applied to face")
    draft.Build()
    if not draft.IsDone():
        raise FeatureBuilderError(f"feature '{feature_id}': draft operation failed")
    return bd.Solid(draft.Shape())


def _apply_shell(body: Any, faces: list[Any], thickness: float, feature_id: str) -> Any:
    """Apply a shell operation to ``body``.

    Positive ``thickness`` hollows inward; ``faces`` are the faces removed to
    open the shell. An empty ``faces`` list produces a closed hollow solid.
    """
    _require_build123d()
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid
    from OCP.BRepOffsetAPI import BRepOffsetAPI_MakeThickSolid
    from OCP.TopAbs import TopAbs_SHELL
    from OCP.TopoDS import TopoDS
    from OCP.TopTools import TopTools_ListOfShape

    try:
        removed = TopTools_ListOfShape()
        for face in faces:
            removed.Append(face)
        shell = BRepOffsetAPI_MakeThickSolid()
        shape = body.wrapped if hasattr(body, "wrapped") else body
        # Negative offset grows material inward for a positive user thickness.
        shell.MakeThickSolidByJoin(shape, removed, -thickness, 1e-6)
        shell.Build()
        if not shell.IsDone():
            raise FeatureBuilderError(f"feature '{feature_id}': shell operation failed")
        result = shell.Shape()

        # When no faces are removed, OCCT returns a closed Shell. Convert it
        # to a Solid so downstream solid-count invariants hold.
        if result.ShapeType() == TopAbs_SHELL:
            shell_shape = TopoDS.Shell_s(result)
            maker = BRepBuilderAPI_MakeSolid(shell_shape)
            result = maker.Solid()
        return bd.Solid(result)
    except FeatureBuilderError:
        raise
    except Exception as exc:
        raise FeatureBuilderError(f"feature '{feature_id}': shell failed: {exc}") from exc


def _is_sketch_based_solid(feature_type: str) -> bool:
    return feature_type in ("pad", "pocket", "revolve", "groove")


def _valid_source_feature(
    feature_id: str,
    source_id: str,
    feature_type: str,
    body_id: str,
    feature_map: dict[str, dict[str, Any]],
    order_index: dict[str, int],
) -> dict[str, Any]:
    """Validate a pattern/mirror source feature and return it."""
    source = feature_map.get(source_id)
    if source is None:
        raise FeatureBuilderError(f"feature '{feature_id}': source '{source_id}' not found")
    if order_index.get(source_id, -1) >= order_index.get(feature_id, -1):
        raise FeatureBuilderError(
            f"feature '{feature_id}': source '{source_id}' must be earlier in the feature tree"
        )
    source_type = source.get("type")
    if not _is_sketch_based_solid(source_type):
        raise FeatureBuilderError(
            f"feature '{feature_id}': source '{source_id}' must be a pad, pocket, revolve, or groove"
        )
    if source.get("body") != body_id:
        raise FeatureBuilderError(
            f"feature '{feature_id}': source '{source_id}' must target the same body"
        )
    if feature_id == source_id:
        raise FeatureBuilderError(f"feature '{feature_id}': source cannot be the feature itself")
    return source


def _plane_from_datum(
    datum: dict[str, Any],
    feature_id: str,
    entity: Any | None = None,
) -> Any:
    """Return a build123d Plane from a datum definition.

    Coordinate datums use their canonical plane. Face datums require the
    resolved face entity.
    """
    _require_build123d()
    assert bd is not None
    kind = datum.get("kind")
    if kind == "XY":
        return bd.Plane.XY
    if kind == "YZ":
        return bd.Plane.YZ
    if kind == "XZ":
        return bd.Plane.XZ
    if kind == "offset":
        offset = datum.get("offset", 0.0)
        if not isinstance(offset, (int, float)) or isinstance(offset, bool):
            offset = 0.0
        return bd.Plane.XY.offset(offset)
    if kind == "face":
        if entity is None:
            raise FeatureBuilderError(f"feature '{feature_id}': face datum has no resolved face")
        offset = datum.get("offset", 0.0)
        if not isinstance(offset, (int, float)) or isinstance(offset, bool):
            offset = 0.0
        return _workplane_from_face(entity, offset)
    raise FeatureBuilderError(f"feature '{feature_id}': unsupported datum kind '{kind}'")


def _axis_from_datum(
    datum: dict[str, Any],
    feature_id: str,
    entity: Any | None = None,
) -> Any:
    """Return a build123d Axis from a datum definition (normal through origin)."""
    _require_build123d()
    assert bd is not None
    plane = _plane_from_datum(datum, feature_id, entity)
    return bd.Axis(plane.origin, plane.z_dir)


def _linear_pattern_instances(
    tool: Any,
    count: int,
    spacing: float,
    axis: str,
) -> list[Any]:
    """Return transformed copies of ``tool`` for a linear pattern.

    Instance k (1 <= k < count) is at k*spacing along the axis.
    """
    _require_build123d()
    assert bd is not None
    vector = _AXIS_VECTOR.get(axis, (0.0, 0.0, 1.0))
    instances: list[Any] = []
    for k in range(1, count):
        offset = (vector[0] * spacing * k, vector[1] * spacing * k, vector[2] * spacing * k)
        instances.append(tool.moved(bd.Location(offset)))
    return instances


def _circular_pattern_instances(
    tool: Any,
    count: int,
    angle: float,
    axis: Any,
) -> list[Any]:
    """Return rotated copies of ``tool`` for a circular pattern.

    Instance k (1 <= k < count) is rotated by k*step around ``axis``. A count of
    one is a no-op and returns no instances.
    """
    _require_build123d()
    assert bd is not None
    if count <= 1:
        return []
    if angle == 360.0:
        step = 360.0 / count
    else:
        step = angle / (count - 1)
    instances: list[Any] = []
    for k in range(1, count):
        instances.append(tool.rotate(axis, step * k))
    return instances


def _mirror_shape(tool: Any, plane: Any) -> Any:
    """Return the mirror of ``tool`` across ``plane``."""
    _require_build123d()
    return tool.mirror(plane)


def _apply_pattern_or_mirror(
    body: Any,
    source_tool: Any,
    source_type: str,
    instances: list[Any],
    feature_id: str,
) -> Any:
    """Apply pattern/mirror instances to a body.

    Additive sources append instances via the same-body combine path; subtractive
    sources cut each instance from the body.
    """
    _require_build123d()
    if source_type in ("pad", "revolve"):
        result = body
        for instance in instances:
            result = _combine_additive(result, instance, feature_id)
        return result
    # pocket / groove
    result = body
    for instance in instances:
        result = result - instance
    return result


def _body_bounding_box_diagonal(shape: Any) -> float:
    """Return a safe diagonal length for a body bounding box."""
    try:
        bbox = shape.bounding_box()
        return float(
            math.sqrt(
                (bbox.max.X - bbox.min.X) ** 2
                + (bbox.max.Y - bbox.min.Y) ** 2
                + (bbox.max.Z - bbox.min.Z) ** 2
            )
        )
    except Exception:
        return 1e6


def _inward_normal(
    body: Any,
    face_entity: Any,
    outward_normal: tuple[float, float, float],
) -> tuple[float, float, float]:
    """Return the face normal that points into the given solid body.

    The test point is sampled from the face centroid rather than the surface's
    reference point, which can lie on a vertex or edge and mislead the solid
    classifier.
    """
    _require_reference_resolver()
    assert rr is not None
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_IN

    shape = body.wrapped if hasattr(body, "wrapped") else body
    centroid = _face_centroid(face_entity)
    nx, ny, nz = _normalized_vector(outward_normal)
    # Scale the probe offset with the body size so tiny models do not vanish
    # into classifier tolerance and large models still probe well inside.
    offset = max(1e-4, _body_bounding_box_diagonal(body) * 1e-4)
    test = (centroid[0] + nx * offset, centroid[1] + ny * offset, centroid[2] + nz * offset)
    classifier = BRepClass3d_SolidClassifier(shape, gp_Pnt(*test), 1e-6)
    if classifier.State() == TopAbs_IN:
        return (nx, ny, nz)
    return (-nx, -ny, -nz)


def _find_top_rim_edge(
    tool: Any, center: tuple[float, float, float], axis: tuple[float, float, float]
) -> Any:
    """Find the rim edge of a cylinder tool that lies nearest the top face.

    The top face is the end of the cylinder in the positive axis direction.
    """
    _require_reference_resolver()
    assert rr is not None
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    wrapped = tool.wrapped if hasattr(tool, "wrapped") else tool
    ax, ay, az = axis
    cx, cy, cz = center

    best_edge = None
    best_score = -1e18
    exp = TopExp_Explorer(wrapped, TopAbs_EDGE)
    while exp.More():
        edge = TopoDS.Edge_s(exp.Current())
        try:
            curve = rr._curve_type_string(rr._edge_curve(edge))
        except Exception:
            curve = "other"
        if curve != "circle":
            exp.Next()
            continue
        try:
            from OCP.BRepAdaptor import BRepAdaptor_Curve

            adaptor = BRepAdaptor_Curve(edge)
            circ = adaptor.Circle()
            ec = circ.Location()
            edge_center = (ec.X(), ec.Y(), ec.Z())
            radius = float(circ.Radius())
        except Exception:
            exp.Next()
            continue
        # Project edge center onto axis from center point.
        dx = edge_center[0] - cx
        dy = edge_center[1] - cy
        dz = edge_center[2] - cz
        along = dx * ax + dy * ay + dz * az
        perp_sq = dx * dx + dy * dy + dz * dz - along * along
        if perp_sq > 1e-4 or radius < 1e-4:
            exp.Next()
            continue
        if along > best_score:
            best_score = along
            best_edge = edge
        exp.Next()
    if best_edge is None:
        raise FeatureBuilderError("could not find top rim edge for countersink")
    return best_edge


def _build_hole_tool(
    plane: Any,
    center: tuple[float, float],
    diameter: float,
    depth: float | None,
    body: Any,
    face_entity: Any,
    feature_id: str,
    counterbore_diameter: float | None = None,
    counterbore_depth: float | None = None,
    countersink_diameter: float | None = None,
    countersink_angle: float | None = None,
) -> Any:
    """Build the subtractive tool shape for the hole wizard."""
    _require_build123d()
    assert bd is not None

    origin = plane.origin
    x_dir = plane.x_dir
    y_dir = plane.y_dir
    center_3d = (
        origin.X + center[0] * x_dir.X + center[1] * y_dir.X,
        origin.Y + center[0] * x_dir.Y + center[1] * y_dir.Y,
        origin.Z + center[0] * x_dir.Z + center[1] * y_dir.Z,
    )
    z_dir = plane.z_dir
    axis = (float(z_dir.X), float(z_dir.Y), float(z_dir.Z))
    inward = _inward_normal(body, face_entity, axis)

    if depth is None or depth <= 0:
        cut_length = _body_bounding_box_diagonal(body) * 1.1
    else:
        cut_length = depth

    radius = diameter / 2.0
    # Build the main cylinder along the inward direction.
    cylinder = bd.Cylinder(radius=radius, height=cut_length)
    # Align cylinder so its central axis points along the inward normal.
    # Cylinder defaults to Z; rotate to inward axis.
    target = bd.Vector(inward)
    source = bd.Vector(0, 0, 1)
    dot = source.dot(target)
    cross = source.cross(target)
    if cross.length > 1e-9:
        angle = math.degrees(math.atan2(cross.length, dot))
        cylinder = cylinder.rotate(bd.Axis((0, 0, 0), cross), angle)
    elif dot < 0:
        # 180-degree rotation around world X.
        cylinder = cylinder.rotate(bd.Axis((0, 0, 0), (1, 0, 0)), 180)
    cylinder = cylinder.moved(
        bd.Location(
            (
                center_3d[0] + inward[0] * cut_length / 2.0,
                center_3d[1] + inward[1] * cut_length / 2.0,
                center_3d[2] + inward[2] * cut_length / 2.0,
            )
        )
    )

    if counterbore_diameter is not None and counterbore_depth is not None:
        cb_radius = counterbore_diameter / 2.0
        cb_depth = counterbore_depth
        counterbore = bd.Cylinder(radius=cb_radius, height=cb_depth)
        target = bd.Vector(inward)
        source = bd.Vector(0, 0, 1)
        dot = source.dot(target)
        cross = source.cross(target)
        if cross.length > 1e-9:
            angle = math.degrees(math.atan2(cross.length, dot))
            counterbore = counterbore.rotate(bd.Axis((0, 0, 0), cross), angle)
        elif dot < 0:
            counterbore = counterbore.rotate(bd.Axis((0, 0, 0), (1, 0, 0)), 180)
        cb_center = (
            center_3d[0] + inward[0] * cb_depth / 2.0,
            center_3d[1] + inward[1] * cb_depth / 2.0,
            center_3d[2] + inward[2] * cb_depth / 2.0,
        )
        counterbore = counterbore.moved(bd.Location(cb_center))
        return cylinder + counterbore

    if countersink_diameter is not None and countersink_angle is not None:
        # Chamfer the top rim edge to create the countersink cone.
        edge = _find_top_rim_edge(cylinder, center_3d, inward)
        be = bd.Edge(edge)
        be.topo_parent = cylinder
        # distance along the cylinder wall.
        delta_radius = (countersink_diameter - diameter) / 2.0
        if delta_radius <= 0:
            raise FeatureBuilderError(
                f"feature '{feature_id}': countersinkDiameter must exceed diameter"
            )
        angle_rad = math.radians(countersink_angle)
        if angle_rad <= 0:
            raise FeatureBuilderError(f"feature '{feature_id}': countersinkAngle must be positive")
        distance = delta_radius / math.tan(angle_rad)
        return bd.chamfer(be, distance, angle=countersink_angle)

    return cylinder


def _build_feature_shape(
    feature: dict[str, Any],
    datums: dict[str, dict[str, Any]],
    sketches: dict[str, dict[str, Any]],
    feature_shapes: dict[str, Any],
    tool_shapes: dict[str, Any],
    reference_results: list[dict[str, Any]],
) -> Any:
    """Build the tool shape produced by a single sketch-based feature.

    Returns a build123d ``Shape`` (typically a ``Solid`` or ``Part``). The
    tool shape is also stored in ``tool_shapes`` so pattern/mirror features
    can transform copies of it without rebuilding the source sketch.
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
        profile_tools: list[Any] = []
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
                profile_tools.append(tool)
            else:
                try:
                    profile_tools.append(bd.extrude(face, amount=amount, dir=direction, both=both))
                except Exception as exc:
                    raise FeatureBuilderError(
                        f"feature '{feature_id}': {feature_type} extrusion failed"
                    ) from exc

        if len(profile_tools) == 1:
            tool_shape = profile_tools[0]
        else:
            tool_shape = bd.Compound(children=profile_tools)
        tool_shapes[feature_id] = tool_shape
        return tool_shape

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
        tool_shape = bd.revolve(faces, axis=_BUILD_AXIS[axis], revolution_arc=float(angle))
    except Exception as exc:
        raise FeatureBuilderError(
            f"feature '{feature_id}': revolve/groove operation failed"
        ) from exc
    tool_shapes[feature_id] = tool_shape
    return tool_shape


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
        feature_type = feature.get("type")
        params = feature.get("params", {}) if isinstance(feature.get("params"), dict) else {}
        if feature_type in ("booleanFuse", "booleanCut", "booleanCommon"):
            tool_bodies = params.get("toolBodies")
            if isinstance(tool_bodies, list):
                for tool_body in tool_bodies:
                    if not isinstance(tool_body, str):
                        continue
                    tip = _body_tip_feature_id(features, tool_body, i)
                    if tip is not None and tip != feature["id"]:
                        edges.append((feature["id"], tip))
        if feature_type in ("linearPattern", "circularPattern", "mirror"):
            source = params.get("source")
            if isinstance(source, str) and source != feature["id"]:
                edges.append((feature["id"], source))
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
    try:
        return len(shape.solids())
    except Exception:
        pass
    # Fall back to an OCP explorer for shapes that build123d does not expose
    # as solids (e.g., hollow shells produced by BRepOffsetAPI_MakeThickSolid).
    try:
        from OCP.TopAbs import TopAbs_SOLID
        from OCP.TopExp import TopExp_Explorer

        wrapped = shape.wrapped if hasattr(shape, "wrapped") else shape
        count = 0
        exp = TopExp_Explorer(wrapped, TopAbs_SOLID)
        while exp.More():
            count += 1
            exp.Next()
        return count
    except Exception:
        return 0


def _shape_volume(shape: Any) -> float:
    """Return the volume of a build123d shape, falling back to OCP."""
    if shape is None:
        return 0.0
    try:
        vol = getattr(shape, "volume", None)
        if isinstance(vol, (int, float)) and vol > 0:
            return float(vol)
    except Exception:
        pass
    try:
        from OCP.BRepGProp import BRepGProp
        from OCP.GProp import GProp_GProps

        wrapped = shape.wrapped if hasattr(shape, "wrapped") else shape
        props = GProp_GProps()
        BRepGProp.VolumeProperties_s(wrapped, props)
        return float(props.Mass())
    except Exception:
        return 0.0


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
    tool_shapes: dict[str, Any] = {}
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
            boolean_tool_shapes = [accumulators[t] for t in tool_bodies]
            try:
                result_shape = _boolean_operation(target_shape, boolean_tool_shapes, feature_type)
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

        if feature_type in ("fillet", "chamfer", "draft", "shell"):
            if body_id in consumed_bodies:
                feature_results.append(
                    {"featureId": feature_id, "bodyId": body_id, "status": "stale"}
                )
                stale_or_failed.add(feature_id)
                continue
            previous_body = accumulators.get(body_id)
            if previous_body is None:
                feature_results.append(
                    {
                        "featureId": feature_id,
                        "bodyId": body_id,
                        "status": "failed",
                        "error": f"feature '{feature_id}': {feature_type} requires an existing solid body",
                    }
                )
                stale_or_failed.add(feature_id)
                continue

            refs_with_paths = _collect_topology_refs(feature, datums, sketches)
            entities, ref_results = _resolve_refs_against_shape(
                refs_with_paths, previous_body.wrapped, owner_feature_id=feature_id
            )
            reference_results.extend(ref_results)
            broken = [r for r in ref_results if r["status"] in ("unmatched", "ambiguous")]
            if broken:
                details = "; ".join(
                    f"{r['path']} is {r['status']} (score {r['score']:.3f})" for r in broken
                )
                feature_results.append(
                    {
                        "featureId": feature_id,
                        "bodyId": body_id,
                        "status": "failed",
                        "error": f"feature '{feature_id}' has unresolved topological references: {details}",
                    }
                )
                stale_or_failed.add(feature_id)
                continue

            params = feature.get("params", {}) if isinstance(feature.get("params"), dict) else {}
            try:
                if feature_type == "fillet":
                    radius = params.get("radius")
                    if (
                        not isinstance(radius, (int, float))
                        or isinstance(radius, bool)
                        or not math.isfinite(radius)
                        or radius <= 0
                    ):
                        raise FeatureBuilderError(
                            f"feature '{feature_id}': fillet requires a positive radius"
                        )
                    result_shape = _apply_fillet(previous_body, entities, float(radius), feature_id)
                elif feature_type == "chamfer":
                    result_shape = _apply_chamfer(previous_body, entities, params, feature_id)
                elif feature_type == "draft":
                    pull_direction = params.get("pullDirection")
                    if not isinstance(pull_direction, (list, tuple)) or len(pull_direction) != 3:
                        raise FeatureBuilderError(
                            f"feature '{feature_id}': draft requires pullDirection [x, y, z]"
                        )
                    angle = params.get("angle")
                    if (
                        not isinstance(angle, (int, float))
                        or isinstance(angle, bool)
                        or not math.isfinite(angle)
                    ):
                        raise FeatureBuilderError(
                            f"feature '{feature_id}': draft requires a finite angle"
                        )
                    result_shape = _apply_draft(
                        previous_body, entities, tuple(pull_direction), float(angle), feature_id
                    )
                elif feature_type == "shell":
                    thickness = params.get("thickness")
                    if (
                        not isinstance(thickness, (int, float))
                        or isinstance(thickness, bool)
                        or not math.isfinite(thickness)
                        or thickness <= 0
                    ):
                        raise FeatureBuilderError(
                            f"feature '{feature_id}': shell requires a positive thickness"
                        )
                    result_shape = _apply_shell(
                        previous_body, entities, float(thickness), feature_id
                    )
                else:
                    raise FeatureBuilderError(
                        f"feature '{feature_id}': type '{feature_type}' is not supported yet"
                    )
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

            accumulators[body_id] = result_shape
            feature_shapes[feature_id] = getattr(result_shape, "wrapped", result_shape)
            feature_results.append({"featureId": feature_id, "bodyId": body_id, "status": "built"})
            continue

        if feature_type in ("linearPattern", "circularPattern", "mirror", "hole"):
            if body_id in consumed_bodies:
                feature_results.append(
                    {"featureId": feature_id, "bodyId": body_id, "status": "stale"}
                )
                stale_or_failed.add(feature_id)
                continue
            previous_body = accumulators.get(body_id)
            if previous_body is None:
                feature_results.append(
                    {
                        "featureId": feature_id,
                        "bodyId": body_id,
                        "status": "failed",
                        "error": f"feature '{feature_id}': {feature_type} requires an existing solid body",
                    }
                )
                stale_or_failed.add(feature_id)
                continue

            refs_with_paths = _collect_topology_refs(feature, datums, sketches)
            entities, ref_results = _resolve_refs_against_shape(
                refs_with_paths, previous_body.wrapped, owner_feature_id=feature_id
            )
            reference_results.extend(ref_results)
            broken = [r for r in ref_results if r["status"] in ("unmatched", "ambiguous")]
            if broken:
                details = "; ".join(
                    f"{r['path']} is {r['status']} (score {r['score']:.3f})" for r in broken
                )
                feature_results.append(
                    {
                        "featureId": feature_id,
                        "bodyId": body_id,
                        "status": "failed",
                        "error": f"feature '{feature_id}' has unresolved topological references: {details}",
                    }
                )
                stale_or_failed.add(feature_id)
                continue

            ref_path_to_index = {path: i for i, (path, _) in enumerate(refs_with_paths)}
            params = feature.get("params", {}) if isinstance(feature.get("params"), dict) else {}

            try:
                if feature_type in ("linearPattern", "circularPattern", "mirror"):
                    source_id = params.get("source")
                    if not isinstance(source_id, str) or not source_id:
                        raise FeatureBuilderError(
                            f"feature '{feature_id}': source feature id is required"
                        )
                    order_index = {fid: idx for idx, fid in enumerate(order)}
                    source = _valid_source_feature(
                        feature_id, source_id, feature_type, body_id, feature_map, order_index
                    )
                    source_tool = tool_shapes.get(source_id)
                    if source_tool is None:
                        raise FeatureBuilderError(
                            f"feature '{feature_id}': source '{source_id}' tool shape is unavailable"
                        )

                    if feature_type == "linearPattern":
                        count = int(params.get("count", 1))
                        spacing = float(params.get("spacing", 0.0))
                        axis = str(params.get("axis", "z"))
                        instances = _linear_pattern_instances(source_tool, count, spacing, axis)
                        result_shape = _apply_pattern_or_mirror(
                            previous_body, source_tool, source["type"], instances, feature_id
                        )
                    elif feature_type == "circularPattern":
                        count = int(params.get("count", 1))
                        angle = float(params.get("angle", 360.0))
                        axis_datum_id = params.get("axisDatumId")
                        if isinstance(axis_datum_id, str) and axis_datum_id:
                            datum = datums.get(axis_datum_id)
                            if not isinstance(datum, dict):
                                raise FeatureBuilderError(
                                    f"feature '{feature_id}': unknown axis datum '{axis_datum_id}'"
                                )
                            entity = None
                            if datum.get("kind") == "face":
                                ref_path = f"datum.{axis_datum_id}.reference"
                                entity = entities[ref_path_to_index[ref_path]]
                            pattern_axis = _axis_from_datum(datum, feature_id, entity)
                        else:
                            axis_name = str(params.get("axis", "z"))
                            if axis_name not in _AXIS_VECTOR:
                                raise FeatureBuilderError(
                                    f"feature '{feature_id}': unknown axis '{axis_name}'"
                                )
                            vector = _AXIS_VECTOR[axis_name]
                            pattern_axis = bd.Axis((0, 0, 0), vector)
                        instances = _circular_pattern_instances(
                            source_tool, count, angle, pattern_axis
                        )
                        result_shape = _apply_pattern_or_mirror(
                            previous_body, source_tool, source["type"], instances, feature_id
                        )
                    else:  # mirror
                        plane_datum_id = params.get("planeDatumId")
                        if isinstance(plane_datum_id, str) and plane_datum_id:
                            datum = datums.get(plane_datum_id)
                            if not isinstance(datum, dict):
                                raise FeatureBuilderError(
                                    f"feature '{feature_id}': unknown plane datum '{plane_datum_id}'"
                                )
                            entity = None
                            if datum.get("kind") == "face":
                                ref_path = f"datum.{plane_datum_id}.reference"
                                entity = entities[ref_path_to_index[ref_path]]
                            mirror_plane = _plane_from_datum(datum, feature_id, entity)
                        else:
                            plane_name = str(params.get("plane", "XY"))
                            if plane_name not in _PLANE_MAP:
                                raise FeatureBuilderError(
                                    f"feature '{feature_id}': unknown mirror plane '{plane_name}'"
                                )
                            mirror_plane = getattr(bd.Plane, _PLANE_MAP[plane_name])
                        mirrored = _mirror_shape(source_tool, mirror_plane)
                        result_shape = _apply_pattern_or_mirror(
                            previous_body, source_tool, source["type"], [mirrored], feature_id
                        )
                else:  # hole
                    face_path = f"feature.{feature_id}.params.face"
                    face_entity = entities[ref_path_to_index[face_path]]
                    hole_plane = _workplane_from_face(face_entity)
                    center = params.get("center")
                    if not isinstance(center, (list, tuple)) or len(center) != 2:
                        raise FeatureBuilderError(
                            f"feature '{feature_id}': hole center must be [u, v]"
                        )
                    tool = _build_hole_tool(
                        plane=hole_plane,
                        center=(float(center[0]), float(center[1])),
                        diameter=float(params.get("diameter", 0.0)),
                        depth=params.get("depth"),
                        body=previous_body,
                        face_entity=face_entity,
                        feature_id=feature_id,
                        counterbore_diameter=params.get("counterboreDiameter"),
                        counterbore_depth=params.get("counterboreDepth"),
                        countersink_diameter=params.get("countersinkDiameter"),
                        countersink_angle=params.get("countersinkAngle"),
                    )
                    result_shape = previous_body - tool

                accumulators[body_id] = result_shape
                feature_shapes[feature_id] = getattr(result_shape, "wrapped", result_shape)
                feature_results.append(
                    {"featureId": feature_id, "bodyId": body_id, "status": "built"}
                )
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

        # Sketch-based solid feature (pad/pocket/revolve/groove).
        try:
            tool_shape = _build_feature_shape(
                feature, datums, sketches, feature_shapes, tool_shapes, reference_results
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
