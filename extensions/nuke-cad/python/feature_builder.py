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

import curve_builder
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
    normal. The normal follows the fingerprint convention (outward; REVERSED
    faces flip the underlying plane axis), so hole ``[u, v]`` centers and
    sketch-on-face coordinates agree with the frontend projection.
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


def _feature_sketch_ids(feature: dict[str, Any]) -> list[str]:
    """Sketch ids consumed by a feature: ``sketchId`` plus loft ``sectionSketchIds``.

    Loft stores its ordered section sketches in params because the single
    ``sketchId`` field cannot express ordering; both spellings name sketches
    the feature's geometry depends on.
    """
    ids: list[str] = []
    sketch_id = feature.get("sketchId")
    if isinstance(sketch_id, str) and sketch_id:
        ids.append(sketch_id)
    params = feature.get("params", {}) if isinstance(feature.get("params"), dict) else {}
    if feature.get("type") == "loft":
        section_ids = params.get("sectionSketchIds")
        if isinstance(section_ids, list):
            for sid in section_ids:
                if isinstance(sid, str) and sid and sid not in ids:
                    ids.append(sid)
    return ids


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

    for sketch_id in _feature_sketch_ids(feature):
        sketch = sketches.get(sketch_id)
        if sketch is None:
            continue
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
    """Return True for solid features backed by one or more document sketches.

    Loft is included even though it carries no ``sketchId``: its ordered
    section sketches live in ``params.sectionSketchIds``.
    """
    return feature_type in ("pad", "pocket", "revolve", "groove", "sweep", "loft", "helicalSweep")


def _is_solid_producer(feature_type: str) -> bool:
    """Return True for features whose tool shape is a solid usable as a pattern/mirror source.

    Unlike :func:`_is_sketch_based_solid` this includes ``pipe``, which has no
    sketch (its section is the schema-level circle) but still produces a solid.
    """
    return _is_sketch_based_solid(feature_type) or feature_type == "pipe"


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
    if not _is_solid_producer(source_type):
        raise FeatureBuilderError(
            f"feature '{feature_id}': source '{source_id}' must be a solid-producing feature "
            "(pad, pocket, revolve, groove, sweep, pipe, loft, or helicalSweep)"
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

    Additive sources merge instances into the body with a boolean union so that
    overlapping pattern instances fuse into a single solid rather than being
    rejected by the same-body additive overlap guard. Subtractive sources cut
    each instance from the body.
    """
    _require_build123d()
    if source_type in ("pad", "revolve", "sweep", "pipe", "loft", "helicalSweep"):
        result = body
        for instance in instances:
            result = result + instance
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


def _path_start_frame(spine_wire: Any) -> tuple[Any, Any]:
    """Return ``(start_point, start_tangent)`` of a spine wire."""
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.gp import gp_Dir, gp_Pnt, gp_Vec
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    exp = TopExp_Explorer(spine_wire, TopAbs_EDGE)
    if not exp.More():
        raise FeatureBuilderError("path curve has no edges")
    edge = TopoDS.Edge_s(exp.Current())
    curve = BRepAdaptor_Curve(edge)
    pnt = gp_Pnt()
    vec = gp_Vec()
    curve.D1(curve.FirstParameter(), pnt, vec)
    if vec.Magnitude() < 1e-12:
        raise FeatureBuilderError("path curve has a zero start tangent")
    start = gp_Pnt(pnt.X(), pnt.Y(), pnt.Z())
    tangent = gp_Dir(vec.X(), vec.Y(), vec.Z())
    return start, tangent


def _position_sections_at_path_start(
    faces: list[Any],
    plane: Any,
    start: Any,
    tangent: Any,
) -> list[Any]:
    """Move sketch-coordinate section faces to the path start frame.

    The sketch-plane origin lands on the path start point and the sketch
    normal aligns with the path start tangent; in-plane geometry relative to
    the sketch origin is preserved. This is the SolidWorks-style
    auto-positioning behavior: there is no requirement that the sketch plane
    be perpendicular to the path.
    """
    from OCP.gp import gp_Ax3, gp_Dir, gp_Pnt, gp_Trsf
    from OCP.TopLoc import TopLoc_Location

    origin = plane.origin
    source = gp_Ax3(
        gp_Pnt(origin.X, origin.Y, origin.Z),
        gp_Dir(plane.z_dir.X, plane.z_dir.Y, plane.z_dir.Z),
        gp_Dir(plane.x_dir.X, plane.x_dir.Y, plane.x_dir.Z),
    )
    x_dir = _deterministic_x_dir((tangent.X(), tangent.Y(), tangent.Z()))
    target = gp_Ax3(start, tangent, gp_Dir(*x_dir))
    transformation = gp_Trsf()
    transformation.SetTransformation(target, source)
    location = TopLoc_Location(transformation)
    return [face.wrapped.Moved(location) for face in faces]


def _spine_min_radius(spine_wire: Any, samples: int = 200) -> float:
    """Return the minimum radius of curvature of the spine wire.

    Straight sections (curvature ~0) are skipped. Returns ``inf`` for a
    perfectly straight spine.
    """
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.BRepLProp import BRepLProp_CLProps
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    best = math.inf
    exp = TopExp_Explorer(spine_wire, TopAbs_EDGE)
    while exp.More():
        edge = TopoDS.Edge_s(exp.Current())
        curve = BRepAdaptor_Curve(edge)
        first = curve.FirstParameter()
        last = curve.LastParameter()
        for i in range(samples):
            param = first + (last - first) * i / (samples - 1)
            try:
                props = BRepLProp_CLProps(curve, param, 2, 1e-9)
                curvature = props.Curvature()
            except Exception:
                continue
            if curvature > 1e-12:
                best = min(best, 1.0 / curvature)
        exp.Next()
    return best


def _section_reach(section_faces: list[Any]) -> float:
    """Return the max distance from a section face's centroid to its boundary vertices."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    from OCP.TopAbs import TopAbs_VERTEX
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    reach = 0.0
    for face in section_faces:
        props = GProp_GProps()
        BRepGProp.SurfaceProperties_s(face, props)
        cog = props.CentreOfMass()
        exp = TopExp_Explorer(face, TopAbs_VERTEX)
        while exp.More():
            vertex = TopoDS.Vertex_s(exp.Current())
            pnt = BRep_Tool.Pnt_s(vertex)
            distance = math.sqrt(
                (pnt.X() - cog.X()) ** 2 + (pnt.Y() - cog.Y()) ** 2 + (pnt.Z() - cog.Z()) ** 2
            )
            reach = max(reach, distance)
            exp.Next()
    return reach


def _sweep_params_or_raise(
    params: dict[str, Any], feature_id: str
) -> tuple[str, tuple[float, float, float] | None]:
    """Validate sweep/pipe orientation params and return ``(orientation, binormal)``."""
    orientation = params.get("orientation", "frenet")
    if orientation not in ("frenet", "fixedBinormal"):
        raise FeatureBuilderError(
            f"feature '{feature_id}': orientation must be 'frenet' or 'fixedBinormal'"
        )
    binormal = params.get("binormal")
    if orientation == "fixedBinormal":
        if (
            not isinstance(binormal, (list, tuple))
            or len(binormal) != 3
            or not all(
                isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                for v in binormal
            )
        ):
            raise FeatureBuilderError(
                f"feature '{feature_id}': fixedBinormal requires a finite binormal [x, y, z]"
            )
        return orientation, _normalized_vector(
            (float(binormal[0]), float(binormal[1]), float(binormal[2]))
        )
    return orientation, None


def _pipe_shell_solid(
    spine_wire: Any,
    section_faces: list[Any],
    params: dict[str, Any],
    feature_id: str,
    reach: float,
) -> Any:
    """Sweep the section faces along the spine wire into a single solid.

    Uses ``BRepOffsetAPI_MakePipeShell`` with a round-corner transition. The
    section is swept from its current position; callers position it at the
    path start first. A fast curvature pre-check rejects sections whose reach
    meets or exceeds the spine's minimum radius of curvature, which would
    self-intersect. All OCP failures are wrapped in ``FeatureBuilderError``.
    """
    _require_build123d()
    assert bd is not None
    from OCP.BRep import BRep_Tool
    from OCP.BRepBuilderAPI import BRepBuilderAPI_RoundCorner
    from OCP.BRepOffsetAPI import BRepOffsetAPI_MakePipeShell
    from OCP.gp import gp_Dir

    orientation, binormal = _sweep_params_or_raise(params, feature_id)
    closed_spine = BRep_Tool.IsClosed_s(spine_wire)

    min_radius = _spine_min_radius(spine_wire)
    if math.isfinite(min_radius) and reach >= min_radius:
        raise FeatureBuilderError(
            f"feature '{feature_id}': path curve is too tightly curved "
            f"(minimum radius {min_radius:.6g}) for the section reach {reach:.6g}; "
            "the sweep would self-intersect"
        )

    try:
        profile_solids: list[Any] = []
        for section_face in section_faces:
            face = bd.Face(section_face)
            wires = [face.outer_wire().wrapped] + [w.wrapped for w in face.inner_wires()]
            swept_wires: list[Any] = []
            for wire in wires:
                builder = BRepOffsetAPI_MakePipeShell(spine_wire)
                builder.SetTransitionMode(BRepBuilderAPI_RoundCorner)
                if orientation == "fixedBinormal":
                    assert binormal is not None
                    builder.SetMode(gp_Dir(*binormal))
                else:
                    builder.SetMode(True)
                builder.Add(wire, False, False)
                builder.Build()
                if not builder.IsDone():
                    raise FeatureBuilderError(f"feature '{feature_id}': sweep operation failed")
                if closed_spine:
                    swept_wires.append(
                        _closed_spine_sweep_solid(builder, spine_wire, wire, feature_id)
                    )
                else:
                    swept_wires.append(_pipe_shell_result(builder, feature_id))
            outer = bd.Solid(swept_wires[0])
            for inner in swept_wires[1:]:
                outer = outer.cut(bd.Solid(inner))
            profile_solids.append(outer)
        tool_shape = (
            profile_solids[0] if len(profile_solids) == 1 else bd.Compound(children=profile_solids)
        )
    except FeatureBuilderError:
        raise
    except Exception as exc:
        raise FeatureBuilderError(f"feature '{feature_id}': sweep failed: {exc}") from exc

    if _solid_count(tool_shape) != 1:
        raise FeatureBuilderError(f"feature '{feature_id}': sweep did not produce a single solid")
    # Wrap in a Compound so the tool behaves like a pad/revolve tool shape in
    # boolean combinations (``Solid + Solid`` returns a ShapeList in build123d,
    # which the additive/pattern paths cannot consume).
    return bd.Compound(children=[tool_shape])


def _pipe_shell_result(builder: Any, feature_id: str) -> Any:
    """Return the solid produced by a PipeShell builder on an open spine.

    ``MakeSolid`` caps the ends of an open spine. If that fails, the raw shell
    must be repaired before it becomes a solid: ``MakePipeShell`` can leave the
    lateral faces' seam edges unglued, so an unglued shell makes an invalid
    solid whose STEP round-trip degrades to bare faces — the DAGMC export
    pipeline then finds no volume in the exported STEP. ``ShapeFix_Shape``
    re-glues the seams (sewing alone leaves the solid invalid). Valid
    ``MakeSolid`` results return unchanged. Closed spines never reach this
    repair: they are rebuilt by ``_closed_spine_sweep_solid`` instead.
    """
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.ShapeFix import ShapeFix_Shape
    from OCP.TopAbs import TopAbs_SHELL, TopAbs_SOLID
    from OCP.TopoDS import TopoDS

    try:
        builder.MakeSolid()
        made = builder.Shape()
        if made.ShapeType() == TopAbs_SOLID and BRepCheck_Analyzer(made).IsValid():
            return made
    except Exception:
        pass

    raw = builder.Shape()
    if raw.ShapeType() not in (TopAbs_SHELL, TopAbs_SOLID):
        raise FeatureBuilderError(f"feature '{feature_id}': sweep failed to produce a solid")

    fixed = ShapeFix_Shape(raw)
    fixed.Perform()
    repaired = fixed.Shape()
    if repaired.ShapeType() == TopAbs_SOLID:
        return repaired
    if repaired.ShapeType() != TopAbs_SHELL:
        raise FeatureBuilderError(
            f"feature '{feature_id}': sweep shell repair did not produce a shell"
        )
    maker = BRepBuilderAPI_MakeSolid(TopoDS.Shell_s(repaired))
    return maker.Solid()


def _closed_spine_sweep_solid(
    builder: Any, spine_wire: Any, profile_wire: Any, feature_id: str
) -> Any:
    """Rebuild a closed-spine sweep as a watertight, STEP-durable solid.

    ``BRepOffsetAPI_MakePipeShell`` on a closed spine emits the correct lateral
    faces plus tiny inward sliver faces at the periodic seam, and leaves seam
    edges carrying tolerances of up to ~0.5 m. A solid sewn from those surfaces
    is valid in memory but degrades on STEP round-trip (bare faces, zero
    volume), so the DAGMC export pipeline finds no volumes. The lateral faces
    are exact sweep iso-curves, so the tube is rebuilt as a station loft
    through corner polygons sampled from the lateral faces' shared edges — the
    loft preserves the sweep's twist and uses fresh, default-tolerance
    geometry. Sections without lateral corners (circular pipes) instead fall
    back to a loft through fresh circle stations, which is exact for a circular
    section regardless of twist.
    """
    from OCP.TopAbs import TopAbs_SHELL, TopAbs_SOLID

    raw = builder.Shape()
    if raw.ShapeType() not in (TopAbs_SHELL, TopAbs_SOLID):
        raise FeatureBuilderError(f"feature '{feature_id}': closed-path sweep produced no shell")
    lateral: list[Any] = []
    try:
        lateral = _lateral_sweep_faces(raw, feature_id)
    except FeatureBuilderError:
        pass
    profile_edges = _wire_edge_count(profile_wire)
    spine_edges = _wire_edge_count(spine_wire)
    if spine_edges == 1 and len(lateral) >= 3 and len(lateral) == profile_edges:
        ring = _lateral_long_edge_ring(lateral, feature_id)
        if ring is not None:
            return _corner_station_loft(ring, feature_id)
    radius = _circular_section_radius(profile_wire)
    if spine_edges == 1 and radius is not None:
        return _circle_station_loft(spine_wire, radius, feature_id)
    raise FeatureBuilderError(
        f"feature '{feature_id}': closed-path sweep of this section shape is not supported"
    )


def _circular_section_radius(profile_wire: Any) -> float | None:
    """Return the radius when the section is a single full-circle edge."""
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.GeomAbs import GeomAbs_CurveType
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    edges = []
    exp = TopExp_Explorer(profile_wire, TopAbs_EDGE)
    while exp.More():
        edges.append(TopoDS.Edge_s(exp.Current()))
        exp.Next()
    if len(edges) != 1:
        return None
    curve = BRepAdaptor_Curve(edges[0])
    if curve.GetType() != GeomAbs_CurveType.GeomAbs_Circle:
        return None
    return float(curve.Circle().Radius())


def _wire_edge_count(wire: Any) -> int:
    """Return the number of edges in a wire."""
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopExp import TopExp_Explorer

    count = 0
    exp = TopExp_Explorer(wire, TopAbs_EDGE)
    while exp.More():
        count += 1
        exp.Next()
    return count


def _lateral_sweep_faces(raw: Any, feature_id: str) -> list[Any]:
    """Split a closed-spine PipeShell shell into lateral faces and seam slivers.

    Seam slivers are inward-facing faces with a small fraction of the largest
    lateral face's area. Structural guards in the caller (edge count vs. the
    profile, ring-walk checks) catch any misclassification instead of letting
    it silently change the section shape.
    """
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    faces = []
    exp = TopExp_Explorer(raw, TopAbs_FACE)
    while exp.More():
        faces.append(TopoDS.Face_s(exp.Current()))
        exp.Next()
    if len(faces) < 3:
        raise FeatureBuilderError(
            f"feature '{feature_id}': closed-path sweep produced a degenerate shell"
        )
    areas = []
    for face in faces:
        props = GProp_GProps()
        BRepGProp.SurfaceProperties_s(face, props)
        areas.append(props.Mass())
    largest = max(areas)
    return [face for face, area in zip(faces, areas, strict=True) if area >= 0.2 * largest]


def _lateral_long_edge_ring(lateral: list[Any], feature_id: str) -> list[Any] | None:
    """Order the long (spine-parallel) edges of the lateral faces into a ring.

    A long edge is shared by exactly two lateral faces; walking the lateral
    faces via their shared long edges yields the corner order around the
    section. Returns ``None`` when the topology does not form a single ring.
    """
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    face_edges = []
    for face in lateral:
        edges = []
        exp = TopExp_Explorer(face, TopAbs_EDGE)
        while exp.More():
            edges.append(TopoDS.Edge_s(exp.Current()))
            exp.Next()
        face_edges.append(edges)

    long_edges: list[Any] = []
    owners: list[list[int]] = []
    for face_index, edges in enumerate(face_edges):
        for edge in edges:
            shared = {face_index}
            for other_index, other_edges in enumerate(face_edges):
                if other_index != face_index and any(edge.IsSame(o) for o in other_edges):
                    shared.add(other_index)
            if len(shared) >= 2 and face_index == min(shared):
                long_edges.append(edge)
                owners.append(sorted(shared))
    if len(long_edges) != len(lateral):
        return None

    # pairs[face] = the two long-edge indices bounding that lateral face
    pairs: list[list[int]] = [[] for _ in lateral]
    for edge_index, faces_shared in enumerate(owners):
        if len(faces_shared) < 2:
            return None
        for face_index in faces_shared[:2]:
            pairs[face_index].append(edge_index)
    if any(len(pair) != 2 for pair in pairs):
        return None
    pairs_typed = [tuple(pair) for pair in pairs]

    order = [0]
    used = {0}
    while len(order) < len(pairs_typed):
        last = set(pairs_typed[order[-1]])
        nxt = None
        for face_index, pair in enumerate(pairs_typed):
            if face_index in used:
                continue
            if any(i in last for i in pair):
                nxt = face_index
                break
        if nxt is None:
            return None
        used.add(nxt)
        order.append(nxt)
    pairs_ordered = [pairs_typed[i] for i in order]
    ring_indices = [pairs_ordered[0][0], pairs_ordered[0][1]]
    for pair in pairs_ordered[1:]:
        prev = ring_indices[-1]
        ring_indices.append(pair[0] if pair[1] == prev else pair[1])
    ring_indices = ring_indices[:-1]
    if len(ring_indices) != len(long_edges) or len(set(ring_indices)) != len(ring_indices):
        return None
    return [long_edges[i] for i in ring_indices]


def _corner_station_loft(ring: list[Any], feature_id: str) -> Any:
    """Loft a fresh solid through corner polygons sampled along the long edges.

    The long edges are exact sweep iso-curves parameterized by the spine
    parameter, so evaluating all of them at the same fraction yields a section
    corner polygon at that station. A smoothing ThruSections loft through the
    stations rebuilds the tube with the sweep's own twist; the end stations
    are trimmed slightly off the periodic seam, where the raw shell's sliver
    faces leave the corner curves unreliable. Accuracy is approximately 1% in
    volume for the W7-X coil model (measured -1.2% at these settings).

    Stations stay numerous (480) and uniform in curve parameter: arc-length
    spacing at 120 stations measured -2.7% volume drift AND introduced
    sliver-prone UV parameterization, so neither accuracy nor mesh quality
    benefits from fewer stations.
    """
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeWire
    from OCP.BRepOffsetAPI import BRepOffsetAPI_ThruSections
    from OCP.gp import gp_Pnt

    stations = 480
    trim = 0.02

    def corner_polygon(t: float) -> list[Any]:
        points = []
        for edge in ring:
            curve = BRepAdaptor_Curve(edge)
            point = gp_Pnt()
            curve.D0(
                curve.FirstParameter() + (curve.LastParameter() - curve.FirstParameter()) * t,
                point,
            )
            points.append(point)
        return points

    wires = []
    for i in range(stations):
        t = trim + (1.0 - 2.0 * trim) * i / stations
        points = corner_polygon(t)
        maker = BRepBuilderAPI_MakeWire()
        for k, point in enumerate(points):
            nxt = points[(k + 1) % len(points)]
            maker.Add(BRepBuilderAPI_MakeEdge(point, nxt).Edge())
        wires.append(maker.Wire())
    loft = BRepOffsetAPI_ThruSections(True, False, 1e-4)
    loft.SetSmoothing(True)
    for wire in wires:
        loft.AddWire(wire)
    loft.AddWire(wires[0])
    loft.Build()
    if not loft.IsDone():
        raise FeatureBuilderError(f"feature '{feature_id}': closed-path sweep loft failed to build")
    return _require_single_valid_solid(loft.Shape(), feature_id)


def _require_single_valid_solid(shape: Any, feature_id: str) -> Any:
    """Return the single valid solid in a loft shape or raise a clear error."""
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    solids = []
    exp = TopExp_Explorer(shape, TopAbs_SOLID)
    while exp.More():
        solids.append(TopoDS.Solid_s(exp.Current()))
        exp.Next()
    if len(solids) != 1:
        raise FeatureBuilderError(
            f"feature '{feature_id}': closed-path sweep did not produce a single solid"
        )
    solid = solids[0]
    if not BRepCheck_Analyzer(solid).IsValid():
        raise FeatureBuilderError(
            f"feature '{feature_id}': closed-path sweep produced an invalid solid"
        )
    return solid


def _circle_station_loft(spine_wire: Any, radius: float, feature_id: str) -> Any:
    """Rebuild a circular-section closed-spine sweep as a station loft.

    Fallback for sections without lateral corners (circular pipes): fresh
    circle wires are built at stations along the spine and lofted. The twist
    of a circular section is irrelevant, so no frame transport is needed.
    """
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeWire
    from OCP.BRepOffsetAPI import BRepOffsetAPI_ThruSections
    from OCP.GC import GC_MakeCircle
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt, gp_Vec
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    spine_edges = []
    exp = TopExp_Explorer(spine_wire, TopAbs_EDGE)
    while exp.More():
        spine_edges.append(TopoDS.Edge_s(exp.Current()))
        exp.Next()
    if len(spine_edges) != 1:
        raise FeatureBuilderError(
            f"feature '{feature_id}': closed-path sweeps require a single-edge path curve"
        )
    curve = BRepAdaptor_Curve(spine_edges[0])
    first, last = curve.FirstParameter(), curve.LastParameter()

    stations = 96
    wires = []
    for i in range(stations):
        t = first + (last - first) * i / stations
        pnt = gp_Pnt()
        vec = gp_Vec()
        curve.D1(t, pnt, vec)
        if vec.Magnitude() < 1e-12:
            raise FeatureBuilderError(f"feature '{feature_id}': path curve has a zero tangent")
        circle = GC_MakeCircle(gp_Ax2(pnt, gp_Dir(vec.X(), vec.Y(), vec.Z())), radius).Value()
        edge = BRepBuilderAPI_MakeEdge(circle).Edge()
        wires.append(BRepBuilderAPI_MakeWire(edge).Wire())

    loft = BRepOffsetAPI_ThruSections(True, True, 1e-6)
    for wire in wires:
        loft.AddWire(wire)
    loft.AddWire(wires[0])
    loft.Build()
    if not loft.IsDone():
        raise FeatureBuilderError(f"feature '{feature_id}': closed-path sweep loft failed to build")
    return _require_single_valid_solid(loft.Shape(), feature_id)


def _build_sweep_tool(
    faces: list[Any],
    curve_entry: dict[str, Any],
    params: dict[str, Any],
    plane: Any,
    feature_id: str,
) -> Any:
    """Build the tool shape of a sweep feature: sketch section along a curve path."""
    spine_wire = curve_entry.get("wire")
    if spine_wire is None:
        raise FeatureBuilderError(f"feature '{feature_id}': path curve has no wire")
    start, tangent = _path_start_frame(spine_wire)
    sections = _position_sections_at_path_start(faces, plane, start, tangent)
    reach = _section_reach(sections)
    return _pipe_shell_solid(spine_wire, sections, params, feature_id, reach)


def _build_loft_tool(
    section_faces: list[Any],
    ruled: bool,
    feature_id: str,
) -> Any:
    """Loft single-profile section faces into a single solid.

    Sections are used as positioned in world space and added in document
    order to ``BRepOffsetAPI_ThruSections``. Ruled lofts between incompatible
    profiles fail at ``Build()``; the error points at ``ruled=false`` as the
    smooth alternative. All OCP failures are wrapped in ``FeatureBuilderError``
    naming the feature. The result is wrapped in a ``Compound`` so the tool
    behaves like a pad/revolve tool shape in boolean combinations.
    """
    _require_build123d()
    assert bd is not None
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid
    from OCP.BRepOffsetAPI import BRepOffsetAPI_ThruSections
    from OCP.TopAbs import TopAbs_SHELL, TopAbs_SOLID
    from OCP.TopoDS import TopoDS

    try:
        builder = BRepOffsetAPI_ThruSections(True, ruled, 1e-6)
        for face in section_faces:
            builder.AddWire(face.outer_wire().wrapped)
        builder.Build()
        if not builder.IsDone():
            raise FeatureBuilderError(f"feature '{feature_id}': loft operation failed")
        shape = builder.Shape()
        if shape.ShapeType() == TopAbs_SHELL:
            shape = BRepBuilderAPI_MakeSolid(TopoDS.Shell_s(shape)).Solid()
        if shape.ShapeType() != TopAbs_SOLID:
            raise FeatureBuilderError(
                f"feature '{feature_id}': loft did not produce a single solid"
            )
        tool_shape = bd.Compound(children=[bd.Solid(shape)])
    except FeatureBuilderError:
        raise
    except Exception as exc:
        hint = "; ruled loft requires compatible profiles; try ruled=false" if ruled else ""
        raise FeatureBuilderError(f"feature '{feature_id}': loft failed: {exc}{hint}") from exc
    return tool_shape


_HELICAL_AXIS_INDEX: dict[str, int] = {"X": 0, "Y": 1, "Z": 2}
_HELICAL_AXIS_UNIT: dict[str, tuple[float, float, float]] = {
    "X": (1.0, 0.0, 0.0),
    "Y": (0.0, 1.0, 0.0),
    "Z": (0.0, 0.0, 1.0),
}


def _helical_sweep_positive_param(params: dict[str, Any], name: str, feature_id: str) -> float:
    value = params.get(name)
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math.isfinite(value)
        or value <= 0
    ):
        raise FeatureBuilderError(
            f"feature '{feature_id}': helicalSweep requires a positive {name}"
        )
    return float(value)


def _build_helix_wire(params: dict[str, Any], feature_id: str) -> Any:
    """Sample the analytic helix described by helicalSweep params and fit a wire.

    The helix winds around the origin-aligned axis (theta in [0, 2*pi*turns],
    ``max(64, ceil(turns * 128))`` samples, the axial coordinate rising by
    ``pitch`` per turn, the winding sign flipped for ``leftHanded``). The
    samples are fitted by reusing :func:`curve_builder._fit_curve`'s
    interpolation path; the wire is open. The helix is derived from params and
    never stored as a document curve.
    """
    axis_name = params.get("axis")
    if axis_name not in _HELICAL_AXIS_INDEX:
        raise FeatureBuilderError(
            f"feature '{feature_id}': helicalSweep requires axis 'X', 'Y', or 'Z'"
        )
    start_radius = _helical_sweep_positive_param(params, "startRadius", feature_id)
    pitch = _helical_sweep_positive_param(params, "pitch", feature_id)
    turns = _helical_sweep_positive_param(params, "turns", feature_id)

    sample_count = max(64, math.ceil(turns * 128))
    axis_index = _HELICAL_AXIS_INDEX[axis_name]
    circular_axes = [i for i in range(3) if i != axis_index]
    hand = -1.0 if params.get("leftHanded", False) else 1.0
    points: list[tuple[float, float, float]] = []
    for i in range(sample_count):
        theta = 2.0 * math.pi * turns * i / (sample_count - 1)
        angle = hand * theta
        coords = [0.0, 0.0, 0.0]
        coords[circular_axes[0]] = start_radius * math.cos(angle)
        coords[circular_axes[1]] = start_radius * math.sin(angle)
        coords[axis_index] = pitch * theta / (2.0 * math.pi)
        points.append((coords[0], coords[1], coords[2]))

    try:
        fit = curve_builder._fit_curve(feature_id, "helix", {"kind": "parametric"}, points)
    except Exception as exc:
        raise FeatureBuilderError(
            f"feature '{feature_id}': helicalSweep helix fit failed: {exc}"
        ) from exc
    wire = fit.get("wire")
    if wire is None:
        raise FeatureBuilderError(
            f"feature '{feature_id}': helicalSweep helix fit produced no wire"
        )
    return wire


def _helical_sweep_effective_params(params: dict[str, Any], feature_id: str) -> dict[str, Any]:
    """Return sweep params for the helix path with helicalSweep defaults applied.

    The default orientation is ``fixedBinormal`` locked to the helix axis unit
    vector (spring-like, no roll); ``frenet`` is available for twisted
    sections. An explicit binormal always wins.
    """
    orientation = params.get("orientation", "fixedBinormal")
    if orientation not in ("frenet", "fixedBinormal"):
        raise FeatureBuilderError(
            f"feature '{feature_id}': orientation must be 'frenet' or 'fixedBinormal'"
        )
    effective = dict(params)
    effective["orientation"] = orientation
    if orientation == "fixedBinormal" and effective.get("binormal") is None:
        axis_name = params.get("axis")
        unit = _HELICAL_AXIS_UNIT.get(axis_name, (0.0, 0.0, 1.0))
        effective["binormal"] = list(unit)
    return effective


def _build_pipe_tool(
    feature: dict[str, Any],
    params: dict[str, Any],
    curve_results: dict[str, dict[str, Any]],
    tool_shapes: dict[str, Any],
) -> Any:
    """Build the tool shape of a pipe feature: circle section along a curve path."""
    _require_build123d()
    assert bd is not None
    from OCP.BRepBuilderAPI import (
        BRepBuilderAPI_MakeEdge,
        BRepBuilderAPI_MakeFace,
        BRepBuilderAPI_MakeWire,
    )
    from OCP.GC import GC_MakeCircle
    from OCP.gp import gp_Ax2

    feature_id = feature["id"]
    path_curve_id = params.get("pathCurveId")
    if not isinstance(path_curve_id, str) or not path_curve_id:
        raise FeatureBuilderError(f"feature '{feature_id}': pipe requires a pathCurveId")
    curve_entry = curve_results.get(path_curve_id)
    if curve_entry is None:
        raise FeatureBuilderError(
            f"feature '{feature_id}': path curve '{path_curve_id}' is unavailable"
        )
    radius = params.get("radius")
    if (
        not isinstance(radius, (int, float))
        or isinstance(radius, bool)
        or not math.isfinite(radius)
        or radius <= 0
    ):
        raise FeatureBuilderError(f"feature '{feature_id}': pipe requires a positive radius")

    spine_wire = curve_entry.get("wire")
    if spine_wire is None:
        raise FeatureBuilderError(f"feature '{feature_id}': path curve has no wire")
    start, tangent = _path_start_frame(spine_wire)
    circle = GC_MakeCircle(gp_Ax2(start, tangent), float(radius)).Value()
    section_wire = BRepBuilderAPI_MakeWire(BRepBuilderAPI_MakeEdge(circle).Edge()).Wire()
    section_face = BRepBuilderAPI_MakeFace(section_wire).Face()
    tool_shape = _pipe_shell_solid(spine_wire, [section_face], params, feature_id, float(radius))
    tool_shapes[feature_id] = tool_shape
    return tool_shape


def _build_feature_shape(
    feature: dict[str, Any],
    datums: dict[str, dict[str, Any]],
    sketches: dict[str, dict[str, Any]],
    feature_shapes: dict[str, Any],
    tool_shapes: dict[str, Any],
    reference_results: list[dict[str, Any]],
    curve_results: dict[str, dict[str, Any]] | None = None,
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

    if feature_type not in ("pad", "pocket", "revolve", "groove", "sweep", "loft", "helicalSweep"):
        raise FeatureBuilderError(
            f"feature '{feature_id}': type '{feature_type}' is not supported yet"
        )

    if feature_type == "loft":
        # Loft leaves FeatureDef.sketchId unset; the ordered section sketches
        # live in params and every entry must reference an existing sketch.
        section_sketch_ids = params.get("sectionSketchIds")
        if (
            not isinstance(section_sketch_ids, list)
            or len(section_sketch_ids) < 2
            or not all(isinstance(s, str) and s for s in section_sketch_ids)
        ):
            raise FeatureBuilderError(
                f"feature '{feature_id}' (loft) requires at least 2 section sketches"
            )
        for section_sketch_id in section_sketch_ids:
            if section_sketch_id not in sketches:
                raise FeatureBuilderError(
                    f"feature '{feature_id}' references unknown sketch '{section_sketch_id}'"
                )
    else:
        sketch_id = feature.get("sketchId")
        if not isinstance(sketch_id, str) or not sketch_id:
            raise FeatureBuilderError(
                f"feature '{feature_id}' ({feature_type}) requires a sketchId"
            )
        if sketch_id not in sketches:
            raise FeatureBuilderError(
                f"feature '{feature_id}' references unknown sketch '{sketch_id}'"
            )
        section_sketch_ids = [sketch_id]

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

    def build_section(section_sketch_id: str) -> tuple[Any, list[Any]]:
        """Build one section's sketch plane and faces through the sketch pipeline.

        Face datums use the resolved face; other datum kinds are handled by
        the sketch builder. External geometry is projected into the sketch
        plane as construction primitives.
        """
        section_sketch = sketches[section_sketch_id]
        plane: Any | None = None
        sketch_datum_id = section_sketch.get("datumId")
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
            if path.startswith(f"sketch.{section_sketch_id}.externalRefs["):
                idx = int(path[path.index("[") + 1 : path.index("]")])
                entity = entities[ref_path_to_index[path]]
                # Ensure we have a plane to project onto.
                if plane is None:
                    if sketch_datum is None:
                        raise FeatureBuilderError(
                            f"feature '{feature_id}': sketch '{section_sketch_id}' has no datum"
                        )
                    plane = sketch_builder._build_plane(sketch_datum)
                extra_primitives.extend(_project_entity_to_sketch(entity, plane, idx))

        plane, faces = build_sketch_faces(
            section_sketch, datums, plane=plane, extra_primitives=extra_primitives
        )
        if not faces:
            raise FeatureBuilderError(
                f"feature '{feature_id}': sketch '{section_sketch_id}' produced no faces"
            )
        return plane, faces

    if feature_type == "loft":
        # Sections are used as positioned in world space (no auto-positioning,
        # unlike sweep). Each section must be a single profile: one outer wire
        # with no inner wires.
        section_faces: list[Any] = []
        for section_sketch_id in section_sketch_ids:
            _section_plane, section = build_section(section_sketch_id)
            if len(section) != 1:
                raise FeatureBuilderError(
                    f"feature '{feature_id}': loft section sketch '{section_sketch_id}' must be a "
                    "single profile; multi-profile sections are not supported"
                )
            section_face = section[0]
            if section_face.inner_wires():
                raise FeatureBuilderError(
                    f"feature '{feature_id}': loft section sketch '{section_sketch_id}' has inner "
                    "loops (holes); loft sections with holes are not supported"
                )
            section_faces.append(section_face)
        tool_shape = _build_loft_tool(section_faces, bool(params.get("ruled", False)), feature_id)
        tool_shapes[feature_id] = tool_shape
        return tool_shape

    plane, faces = build_section(section_sketch_ids[0])

    if feature_type == "sweep":
        path_curve_id = params.get("pathCurveId")
        if not isinstance(path_curve_id, str) or not path_curve_id:
            raise FeatureBuilderError(f"feature '{feature_id}': sweep requires a pathCurveId")
        curve_entry = (curve_results or {}).get(path_curve_id)
        if curve_entry is None:
            raise FeatureBuilderError(
                f"feature '{feature_id}': path curve '{path_curve_id}' is unavailable"
            )
        tool_shape = _build_sweep_tool(faces, curve_entry, params, plane, feature_id)
        tool_shapes[feature_id] = tool_shape
        return tool_shape

    if feature_type == "helicalSweep":
        # The helix is derived from params (never a document curve); the sweep
        # machinery auto-positions the section at the helix start and applies
        # the fixedBinormal/frenet orientation with the axis-unit default.
        effective_params = _helical_sweep_effective_params(params, feature_id)
        helix_wire = _build_helix_wire(params, feature_id)
        tool_shape = _build_sweep_tool(
            faces, {"wire": helix_wire}, effective_params, plane, feature_id
        )
        tool_shapes[feature_id] = tool_shape
        return tool_shape

    if feature_type in ("pad", "pocket"):
        # upToFace/upToBody/angle are schema-accepted and validated, but the
        # builder does not implement them; reject explicitly instead of
        # silently ignoring them.
        unsupported = [
            name for name in ("upToFace", "upToBody", "angle") if params.get(name) is not None
        ]
        if unsupported:
            names = ", ".join(f"'{name}'" for name in unsupported)
            raise FeatureBuilderError(
                f"feature '{feature_id}': {feature_type} parameter(s) {names} "
                "are not yet supported; use a fixed length instead"
            )
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


def _require_cut_intersection(body: Any, tool: Any, feature_id: str, feature_type: str) -> None:
    """Raise when a subtractive tool is disjoint from the body.

    A boolean cut with a disjoint tool silently returns the unchanged body; the
    pocket/groove/hole contract is that the feature removes material, so a miss
    is a build error rather than a no-op success.
    """
    if bd is None:
        raise FeatureBuilderError("build123d is not available; cannot check cut intersection")
    if not _bbox_overlaps_3d(body.bounding_box(), tool.bounding_box()):
        raise FeatureBuilderError(
            f"feature '{feature_id}': {feature_type} tool does not intersect the body"
        )
    try:
        common = body & tool
    except ValueError as exc:
        if "empty compound" in str(exc).lower():
            raise FeatureBuilderError(
                f"feature '{feature_id}': {feature_type} tool does not intersect the body"
            ) from exc
        raise FeatureBuilderError(
            f"feature '{feature_id}': failed to check {feature_type} intersection: {exc}"
        ) from exc
    except Exception as exc:
        raise FeatureBuilderError(
            f"feature '{feature_id}': failed to check {feature_type} intersection: {exc}"
        ) from exc
    if common is None or getattr(common, "volume", 0.0) <= 1e-9:
        raise FeatureBuilderError(
            f"feature '{feature_id}': {feature_type} tool does not intersect the body"
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


def _sketch_topology_dependency_ids(
    sketch: dict[str, Any],
    datums: dict[str, dict[str, Any]],
) -> list[str]:
    """Feature ids a sketch's topology references: its face datum and external refs."""
    ids: list[str] = []
    datum_id = sketch.get("datumId")
    datum = datums.get(datum_id) if isinstance(datum_id, str) else None
    if isinstance(datum, dict) and datum.get("kind") == "face":
        ref = datum.get("reference")
        if isinstance(ref, dict) and isinstance(ref.get("featureId"), str):
            ids.append(ref["featureId"])
    external_refs = sketch.get("externalRefs", [])
    if isinstance(external_refs, list):
        for ref in external_refs:
            if isinstance(ref, dict) and isinstance(ref.get("featureId"), str):
                ids.append(ref["featureId"])
    return ids


def _compute_implied_dependencies(
    features: list[dict[str, Any]],
    sketches: dict[str, dict[str, Any]] | None = None,
    datums: dict[str, dict[str, Any]] | None = None,
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
      * A loft depends on the features its section sketches reference through
        topology (face datums and external geometry), so the sections' backing
        geometry is built (and kept fresh) before the loft — the same
        staleness discipline a sketch-based pad enjoys through its ``sketchId``.
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
        if feature_type == "loft" and sketches is not None:
            sketch_map = sketches
            datum_map = datums or {}
            section_sketch_ids = params.get("sectionSketchIds")
            if isinstance(section_sketch_ids, list):
                for sketch_id in section_sketch_ids:
                    section_sketch = (
                        sketch_map.get(sketch_id) if isinstance(sketch_id, str) else None
                    )
                    if section_sketch is None:
                        continue
                    for dependency_id in _sketch_topology_dependency_ids(section_sketch, datum_map):
                        if dependency_id != feature["id"]:
                            edges.append((feature["id"], dependency_id))
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


def _check_cross_body_overlap(bodies: list[Any], body_ids: list[str]) -> list[str]:
    """Detect non-consumed bodies that overlap in space and return warnings.

    Overlapping parts are valid in pure CAD assemblies (for example the tokamak
    demo model, where toroidal coils intentionally share space with poloidal
    coils in the STEP source). The builder therefore reports overlaps as
    warnings instead of failing, so callers that need a sealed model (DAGMC)
    can inspect them without blocking the B-rep build.
    """
    warnings: list[str] = []
    if bd is None:
        return warnings
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
            except ValueError as exc:
                if "empty compound" in str(exc).lower():
                    continue
                raise FeatureBuilderError(
                    f"failed to check overlap between bodies '{body_ids[i]}' and '{body_ids[j]}': {exc}"
                ) from exc
            except Exception as exc:
                raise FeatureBuilderError(
                    f"failed to check overlap between bodies '{body_ids[i]}' and '{body_ids[j]}': {exc}"
                ) from exc
            overlap_volume = getattr(common, "volume", 0.0)
            if common is not None and overlap_volume > 1e-9:
                warnings.append(
                    f"bodies '{body_ids[i]}' and '{body_ids[j]}' overlap "
                    f"(volume {overlap_volume:.6g} mm³) but are not merged by a boolean"
                )
    return warnings


def build_document_shape(
    document: dict[str, Any],
    curve_results: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build the shape described by a ``.nuke-cad`` document.

    ``curve_results`` maps curve ids to the fitted-wire result dicts from
    ``curve_builder.build_curves``; sweep/pipe features read their path wires
    from it. Direct callers may omit it (treated as an empty mapping).

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
        ``warnings``
            Non-fatal issues, e.g. cross-body overlaps reported by
            ``_check_cross_body_overlap`` (overlap volume included).
    """
    if bd is None:
        raise FeatureBuilderError("build123d is not available; cannot build document shape")

    curve_results = curve_results or {}

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
    implied = _compute_implied_dependencies(features, sketches, datums)
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
    overlap_warnings: list[str] = []

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
            # Datum references (pattern axis / mirror plane) resolve against the
            # referenced feature's historical shape, like the sketch path; the
            # hole placement face resolves against the body's current B-rep.
            datum_slots = [
                i for i, (path, _ref) in enumerate(refs_with_paths) if path.startswith("datum.")
            ]
            body_slots = [i for i in range(len(refs_with_paths)) if i not in datum_slots]
            entities: list[Any] = [None] * len(refs_with_paths)
            resolved_results: list[dict[str, Any] | None] = [None] * len(refs_with_paths)
            if datum_slots:
                datum_entities, datum_results = _resolve_document_refs(
                    [refs_with_paths[i] for i in datum_slots],
                    feature_shapes,
                    owner_feature_id=feature_id,
                )
                for slot, entity, result in zip(
                    datum_slots, datum_entities, datum_results, strict=True
                ):
                    entities[slot] = entity
                    resolved_results[slot] = result
            if body_slots:
                body_entities, body_results = _resolve_refs_against_shape(
                    [refs_with_paths[i] for i in body_slots],
                    previous_body.wrapped,
                    owner_feature_id=feature_id,
                )
                for slot, entity, result in zip(
                    body_slots, body_entities, body_results, strict=True
                ):
                    entities[slot] = entity
                    resolved_results[slot] = result
            ref_results = [r for r in resolved_results if r is not None]
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
                    _require_cut_intersection(previous_body, tool, feature_id, feature_type)
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

        # Sketch-based solid feature (pad/pocket/revolve/groove/sweep/loft/
        # helicalSweep) or pipe.
        if body_id in consumed_bodies:
            # The body was consumed by a boolean feature; adding to it would be
            # silently excluded from the final assembly.
            feature_results.append({"featureId": feature_id, "bodyId": body_id, "status": "stale"})
            stale_or_failed.add(feature_id)
            continue

        try:
            if feature_type == "pipe":
                params = (
                    feature.get("params", {}) if isinstance(feature.get("params"), dict) else {}
                )
                tool_shape = _build_pipe_tool(feature, params, curve_results, tool_shapes)
            else:
                tool_shape = _build_feature_shape(
                    feature,
                    datums,
                    sketches,
                    feature_shapes,
                    tool_shapes,
                    reference_results,
                    curve_results,
                )
        except Exception as exc:
            feature_results.append(
                {"featureId": feature_id, "bodyId": body_id, "status": "failed", "error": str(exc)}
            )
            stale_or_failed.add(feature_id)
            continue

        previous_body = accumulators.get(body_id)

        try:
            if feature_type in ("pad", "revolve", "sweep", "pipe", "loft", "helicalSweep"):
                if previous_body is None:
                    accumulators[body_id] = tool_shape
                else:
                    accumulators[body_id] = _combine_additive(previous_body, tool_shape, feature_id)
            elif feature_type in ("pocket", "groove"):
                if previous_body is None:
                    raise FeatureBuilderError(
                        f"feature '{feature_id}': {feature_type} requires an existing solid body"
                    )
                _require_cut_intersection(previous_body, tool_shape, feature_id, feature_type)
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
            "warnings": overlap_warnings,
        }

    overlap_warnings = _check_cross_body_overlap(active_body_shapes, active_body_ids)

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
        "warnings": overlap_warnings,
    }
