#!/usr/bin/env python3
"""Additional branch coverage for the nuke-cad feature builder.

These tests target validation/error branches, pure layout helpers, and the
result-cache seam that the end-to-end document tests do not reach. They reuse
the shared ``doc_build_helpers`` document builders and build123d is gated per
test so the file stays importable in the minimal pytest profile.
"""

# *****************************************************************************
# Copyright (C) 2024 NukeHub and others.
#
# Redistribution and use in source and binary forms, with or without
# modification, are permitted provided that the following conditions are met:
#
# 1. Redistributions of source code must retain the above copyright notice,
#    this list of conditions and the following disclaimer.
#
# 2. Redistributions in binary form must reproduce the above copyright notice,
#    this list of conditions and the following disclaimer in the documentation
#    and/or other materials provided with the distribution.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
# AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
# IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
# ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
# LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
# CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
# SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
# INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
# CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
# ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
# POSSIBILITY OF SUCH DAMAGE.
# SPDX-License-Identifier: BSD-2-Clause
# *****************************************************************************

from __future__ import annotations

import math
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import feature_builder as fb
import pytest
from doc_build_helpers import (
    _build_base_and_capture_top_face,
    _by_id,
    _document,
    _feature,
    _rect_sketch,
)


def _bd() -> Any:
    return pytest.importorskip("build123d", reason="build123d not installed")


def _annulus_sketch(
    width: float = 20.0, height: float = 10.0, radius: float = 2.0, sid: str = "annulus"
) -> dict[str, Any]:
    base = _rect_sketch(width=width, height=height, sid=sid)
    base["primitives"].append(
        {"id": "hole_c", "type": "point", "x": width / 2.0, "y": height / 2.0}
    )
    base["primitives"].append({"id": "hole", "type": "circle", "c_id": "hole_c", "radius": radius})
    return base


def _state(
    *,
    features: list[dict[str, Any]] | None = None,
    datums: dict[str, dict[str, Any]] | None = None,
    order: list[str] | None = None,
    accumulators: dict[str, Any] | None = None,
    tool_shapes: dict[str, Any] | None = None,
) -> fb._BuildState:
    feature_list = features or []
    state = fb._BuildState(
        datums=datums or {},
        sketches={},
        features=feature_list,
        feature_map={f["id"]: f for f in feature_list},
        order=order or [f["id"] for f in feature_list],
        body_ids=["body-1"],
        body_labels={"body-1": "Body 1"},
        curve_results={},
    )
    state.accumulators.update(accumulators or {})
    state.tool_shapes.update(tool_shapes or {})
    return state


def _top_face(shape: Any) -> Any:
    """Return the raw +Z planar face of a box-like solid."""
    for face in shape.faces():
        normal = face.normal_at()
        if abs(normal.Z - 1.0) < 1e-9:
            return face.wrapped
    raise AssertionError("no top face")


def _nonplanar_face(shape: Any) -> Any:
    import reference_resolver as rr
    from OCP.BRepAdaptor import BRepAdaptor_Surface

    for face in shape.faces():
        if rr._surface_type_string(BRepAdaptor_Surface(face.wrapped)) != "plane":
            return face.wrapped
    raise AssertionError("no non-planar face")


# ---------------------------------------------------------------------------
# End-condition and direction validation.
# ---------------------------------------------------------------------------


def test_extrude_end_mode_defaults_and_validation() -> None:
    assert fb._extrude_end_mode({}, "f", "pad") == "blind"
    assert fb._extrude_end_mode({"end": None}, "f", "pad") == "blind"
    assert fb._extrude_end_mode({"end": "throughAll"}, "f", "pad") == "throughAll"
    # Legacy upToFace documents carry no explicit end and upgrade leniently.
    assert fb._extrude_end_mode({"upToFace": {"kind": "face"}}, "f", "pad") == "upToFace"
    with pytest.raises(fb.FeatureBuilderError, match="unknown pad end"):
        fb._extrude_end_mode({"end": "sideways"}, "f", "pad")
    with pytest.raises(fb.FeatureBuilderError, match="symmetric requires the blind end"):
        fb._extrude_end_mode({"end": "throughAll", "symmetric": True}, "f", "pad")
    with pytest.raises(fb.FeatureBuilderError, match="twoSided requires the blind end"):
        fb._extrude_end_mode({"end": "upToFirst", "twoSided": True}, "f", "pad")


def test_revolve_end_mode_and_unsupported_params() -> None:
    assert fb._revolve_end_mode({}, "f") == "blind"
    assert fb._revolve_end_mode({"end": None}, "f") == "blind"
    assert fb._validate_revolve_params({"end": "throughAll"}, "f") == "throughAll"
    with pytest.raises(fb.FeatureBuilderError, match="must be 'blind' or 'throughAll'"):
        fb._revolve_end_mode({"end": "upToFirst"}, "f")
    with pytest.raises(
        fb.FeatureBuilderError, match="'upToFace', 'upToBody' are not yet supported"
    ):
        fb._validate_revolve_params({"upToFace": {"kind": "face"}, "upToBody": "body-2"}, "f")


def test_extrude_and_revolve_predicates() -> None:
    assert fb._is_up_to_extrude({"type": "fillet", "params": {"end": "throughAll"}}) is False
    assert fb._is_up_to_extrude({"type": "pad", "params": {"end": "upToLast"}}) is True
    assert (
        fb._is_up_to_extrude({"type": "pocket", "params": {"upToFace": {"kind": "face"}}}) is True
    )
    assert fb._is_up_to_extrude({"type": "pad", "params": {}}) is False
    assert fb._is_revolve_through_all({"type": "pad", "params": {"end": "throughAll"}}) is False
    assert fb._is_revolve_through_all({"type": "revolve", "params": {}}) is False
    assert fb._is_revolve_through_all({"type": "revolve", "params": {"end": "throughAll"}}) is True


def test_extrude_direction_axis_validation() -> None:
    bd = _bd()
    with pytest.raises(fb.FeatureBuilderError, match="unknown axis 'w'"):
        fb._extrude_direction(bd.Plane.XY, "w", "feature 'f'")
    with pytest.raises(fb.FeatureBuilderError, match="is not aligned with the sketch plane"):
        fb._extrude_direction(bd.Plane.XY, "x", "feature 'f'")
    vector = fb._extrude_direction(bd.Plane.XY, "z", "feature 'f'")
    assert vector.Z == pytest.approx(1.0)


def test_normalized_vector_rejects_zero() -> None:
    with pytest.raises(fb.FeatureBuilderError, match="zero-length direction"):
        fb._normalized_vector((0.0, 0.0, 0.0))
    assert fb._normalized_vector((0.0, 3.0, 4.0)) == pytest.approx((0.0, 0.6, 0.8))


def test_point_and_datum_validation() -> None:
    with pytest.raises(fb.FeatureBuilderError, match="finite \\[x, y, z\\] point"):
        fb._as_point3((1.0, 2.0), "ctx")
    with pytest.raises(fb.FeatureBuilderError, match="finite \\[x, y, z\\] point"):
        fb._as_point3((1.0, 2.0, True), "ctx")
    with pytest.raises(fb.FeatureBuilderError, match="finite \\[x, y, z\\] point"):
        fb._as_point3((1.0, 2.0, math.nan), "ctx")
    assert fb._as_point3([1, 2, 3], "ctx") == (1.0, 2.0, 3.0)
    with pytest.raises(fb.FeatureBuilderError, match="requires exactly 2 points"):
        fb._datum_points({"id": "d", "points": [[0, 0, 0]]}, 2, "f")


def test_three_point_frame_rejects_degenerate_triangles() -> None:
    with pytest.raises(fb.FeatureBuilderError, match="coincident points"):
        fb._three_point_frame([(0, 0, 0), (0, 0, 0), (1, 0, 0)], "f", "d")
    with pytest.raises(fb.FeatureBuilderError, match="points are collinear"):
        fb._three_point_frame([(0, 0, 0), (1, 0, 0), (2, 0, 0)], "f", "d")
    origin, x_dir, normal = fb._three_point_frame([(0, 0, 0), (1, 0, 0), (0, 1, 0)], "f", "d")
    assert origin == (0, 0, 0)
    assert x_dir == pytest.approx((1.0, 0.0, 0.0))
    assert normal == pytest.approx((0.0, 0.0, 1.0))


def test_midplane_frame_parallel_and_orientation() -> None:
    with pytest.raises(fb.FeatureBuilderError, match="faces are not parallel"):
        fb._midplane_frame_from_normals((0, 0, 0), (0, 0, 1), (0, 0, 10), (1, 0, 0), "f", "d")
    origin, normal = fb._midplane_frame_from_normals(
        (0, 0, 0), (0, 0, 1), (0, 0, 10), (0, 0, -1), "f", "d"
    )
    assert origin == (0.0, 0.0, 5.0)
    assert normal == pytest.approx((0.0, 0.0, 1.0))
    # A plane normal pointing away from the second face flips toward it.
    _origin, flipped = fb._midplane_frame_from_normals(
        (0, 0, 0), (0, 0, 1), (0, 0, -10), (0, 0, -1), "f", "d"
    )
    assert flipped == pytest.approx((0.0, 0.0, -1.0))


def test_datum_midplane_faces_requires_two_refs() -> None:
    with pytest.raises(fb.FeatureBuilderError, match="requires exactly 2 face references"):
        fb._datum_midplane_faces({"id": "d", "faces": [{"kind": "face"}]}, "f")


def test_plane_from_datum_invalid_branches() -> None:
    bd = _bd()
    assert fb._plane_from_datum({"kind": "offset", "offset": "3"}, "f").origin.Z == pytest.approx(
        0.0
    )
    with pytest.raises(fb.FeatureBuilderError, match="face datum has no resolved face"):
        fb._plane_from_datum({"kind": "face", "id": "d"}, "f")
    box = bd.Solid.make_box(10, 10, 10)
    top = _top_face(box)
    plane = fb._plane_from_datum({"kind": "face", "id": "d", "offset": "bad"}, "f", top)
    assert plane.origin.Z == pytest.approx(10.0)
    with pytest.raises(fb.FeatureBuilderError, match="midplane datum 'd' has no resolved faces"):
        fb._plane_from_datum({"kind": "midplane", "id": "d"}, "f")
    with pytest.raises(fb.FeatureBuilderError, match="is a line and cannot be used as a plane"):
        fb._plane_from_datum({"kind": "line2Point", "id": "d"}, "f")
    with pytest.raises(fb.FeatureBuilderError, match="unsupported datum kind 'cone'"):
        fb._plane_from_datum({"kind": "cone", "id": "d"}, "f")


def test_axis_from_two_points_requires_distinct_points() -> None:
    _bd()
    with pytest.raises(fb.FeatureBuilderError, match="points must be distinct"):
        fb._axis_from_two_points((1, 1, 1), (1, 1, 1), "f", "d")
    axis = fb._axis_from_two_points((0, 0, 0), (2, 0, 0), "f", "d")
    assert axis.direction.X == pytest.approx(1.0)


def test_datum_entity_lookup_errors() -> None:
    _bd()
    with pytest.raises(fb.FeatureBuilderError, match="unknown datum 'nope'"):
        fb._datum_entities_for_axis_or_plane("nope", {}, [], {}, "f")
    datum = {"id": "d", "kind": "midplane", "faces": [{"kind": "face"}, {"kind": "face"}]}
    entity_a, entity_b = object(), object()
    entities = [entity_a, entity_b]
    index = {"datum.d.faces[0]": 0, "datum.d.faces[1]": 1}
    found, face, midplane = fb._datum_entities_for_axis_or_plane(
        "d", {"d": datum}, entities, index, "f"
    )
    assert found is datum
    assert face is None
    assert midplane == (entity_a, entity_b)


def test_pattern_axis_and_mirror_plane_reject_unknown_names() -> None:
    _bd()
    with pytest.raises(fb.FeatureBuilderError, match="unknown axis 'w'"):
        fb._resolve_circular_pattern_axis({"axis": "w"}, {}, [], {}, "f")
    with pytest.raises(fb.FeatureBuilderError, match="unknown mirror plane 'AB'"):
        fb._resolve_mirror_plane({"plane": "AB"}, {}, [], {}, "f")
    assert fb._resolve_circular_pattern_axis({}, {}, [], {}, "f").direction.Z == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# Pattern / multiTransform helpers.
# ---------------------------------------------------------------------------


def test_pattern_copy_operations_builds_rotations_and_mirrors() -> None:
    bd = _bd()
    box = bd.Solid.make_box(10, 10, 10)
    circular = {
        "type": "circularPattern",
        "params": {"count": 3, "angle": 360.0, "axis": "z"},
    }
    ops = fb._pattern_copy_operations(circular, {}, [], {}, "pat")
    assert len(ops) == 2
    rotated = ops[0](box)
    assert rotated.volume == pytest.approx(box.volume)
    assert rotated.bounding_box().max.X != pytest.approx(box.bounding_box().max.X)

    mirror = {"type": "mirror", "params": {"plane": "YZ"}}
    mirror_ops = fb._pattern_copy_operations(mirror, {}, [], {}, "mir")
    mirrored = mirror_ops[0](box)
    assert mirrored.bounding_box().min.X == pytest.approx(-10.0)

    with pytest.raises(fb.FeatureBuilderError, match="is not a pattern or mirror feature"):
        fb._pattern_copy_operations({"type": "pad", "params": {}}, {}, [], {}, "bad")


def test_multitransform_reference_validation() -> None:
    body = "body-1"
    feature_map = {
        "multi": {"id": "multi", "type": "multiTransform", "body": body},
        "first": {"id": "first", "type": "linearPattern", "body": body},
        "second": {"id": "second", "type": "pad", "body": body},
        "other": {"id": "other", "type": "mirror", "body": "body-2"},
    }
    order = {"first": 0, "other": 1, "second": 2, "multi": 3}
    with pytest.raises(fb.FeatureBuilderError, match="multiTransform 'first' is required"):
        fb._valid_multitransform_reference("multi", None, "first", body, feature_map, order)
    with pytest.raises(fb.FeatureBuilderError, match="'first' feature 'missing' not found"):
        fb._valid_multitransform_reference("multi", "missing", "first", body, feature_map, order)
    with pytest.raises(fb.FeatureBuilderError, match="must be earlier in the feature tree"):
        fb._valid_multitransform_reference("multi", "multi", "first", body, feature_map, order)
    with pytest.raises(fb.FeatureBuilderError, match="must be a pattern or mirror feature"):
        fb._valid_multitransform_reference("multi", "second", "second", body, feature_map, order)
    with pytest.raises(fb.FeatureBuilderError, match="must target the same body"):
        fb._valid_multitransform_reference("multi", "other", "other", body, feature_map, order)
    assert (
        fb._valid_multitransform_reference("multi", "first", "first", body, feature_map, order)[
            "id"
        ]
        == "first"
    )


def test_multitransform_datum_refs_collects_face_and_midplane() -> None:
    face_ref = {"featureId": "base", "kind": "face", "fingerprint": {}}
    midplane_refs = [face_ref, face_ref]
    datums = {
        "dface": {"id": "dface", "kind": "face", "reference": face_ref},
        "dmid": {"id": "dmid", "kind": "midplane", "faces": midplane_refs},
    }
    role = {
        "type": "linearPattern",
        "params": {"axisDatumId": "dface", "planeDatumId": "dmid"},
    }
    refs = fb._multitransform_datum_refs("first", role, "multi", datums)
    paths = [path for path, _ref in refs]
    assert paths == [
        "feature.multi.params.first.datum.dface.reference",
        "feature.multi.params.first.datum.dmid.faces[0]",
        "feature.multi.params.first.datum.dmid.faces[1]",
    ]


# ---------------------------------------------------------------------------
# Topology reference collection and resolution.
# ---------------------------------------------------------------------------


def test_collect_topology_refs_pattern_and_lattice_datums() -> None:
    face_ref = {"featureId": "base", "kind": "face"}
    datums = {
        "dface": {"id": "dface", "kind": "face", "reference": face_ref},
        "dmid": {"id": "dmid", "kind": "midplane", "faces": [face_ref, face_ref]},
    }
    cases = [
        ("circularPattern", {"axisDatumId": "dface"}),
        ("circularPattern", {"axisDatumId": "dmid"}),
        ("linearPattern", {"axisDatumId": "dface"}),
        ("linearPattern", {"axisDatumId": "dmid"}),
        ("mirror", {"planeDatumId": "dface"}),
        ("mirror", {"planeDatumId": "dmid"}),
        ("primitive", {"datumId": "dface"}),
        ("primitive", {"datumId": "dmid"}),
        ("lattice", {"datumId": "dface"}),
        ("lattice", {"datumId": "dmid"}),
    ]
    for feature_type, params in cases:
        refs = fb._collect_topology_refs(
            {"id": "f", "type": feature_type, "params": params}, datums, {}
        )
        assert refs, feature_type
        assert all(ref is face_ref for _path, ref in refs)
    # A missing sketch is skipped instead of raising.
    assert (
        fb._collect_topology_refs(
            {"id": "f", "type": "pad", "sketchId": "gone", "params": {}}, datums, {}
        )
        == []
    )


def test_collect_topology_refs_dress_up_and_hole_paths() -> None:
    edge_ref = {"featureId": "base", "kind": "edge"}
    face_ref = {"featureId": "base", "kind": "face"}
    fillet = {"id": "f", "type": "fillet", "params": {"edges": [edge_ref]}}
    assert fb._collect_topology_refs(fillet, {}, {}) == [("feature.f.params.edges[0]", edge_ref)]
    draft = {
        "id": "d",
        "type": "draft",
        "params": {"faces": [face_ref], "neutralPlane": face_ref},
    }
    assert [path for path, _ in fb._collect_topology_refs(draft, {}, {})] == [
        "feature.d.params.faces[0]",
        "feature.d.params.neutralPlane",
    ]
    hole = {"id": "h", "type": "hole", "params": {"face": face_ref}}
    assert fb._collect_topology_refs(hole, {}, {}) == [("feature.h.params.face", face_ref)]


def test_resolve_document_refs_reports_unmatched_for_missing_feature_shape() -> None:
    shape = _bd().Solid.make_box(10, 10, 10)
    refs = [("p", {"featureId": "absent", "kind": "face", "fingerprint": {}})]
    entities, results = fb._resolve_document_refs(refs, {"present": shape}, owner_feature_id="own")
    assert entities == [None]
    assert results[0]["status"] == "unmatched"
    assert results[0]["featureId"] == "own"
    assert results[0]["path"] == "p"


def test_resolve_document_refs_wraps_resolver_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bd = _bd()
    shape = bd.Solid.make_box(10, 10, 10)
    ref = {"featureId": "base", "kind": "face", "fingerprint": {}}

    def explode(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("resolver exploded")

    monkeypatch.setattr(fb.rr, "resolve_references_with_entities", explode)
    _entities, results = fb._resolve_document_refs(
        [("p", ref)], {"base": shape}, owner_feature_id="own"
    )
    assert results[0]["status"] == "unmatched"
    assert results[0]["error"] == "resolver exploded"
    _entities, results = fb._resolve_refs_against_shape([("p", ref)], shape, owner_feature_id="own")
    assert results[0]["status"] == "unmatched"
    assert results[0]["error"] == "resolver exploded"


def test_workplane_and_projection_require_build123d(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fb, "bd", None)
    with pytest.raises(fb.FeatureBuilderError, match="cannot build face workplane"):
        fb._workplane_from_face(object())
    with pytest.raises(fb.FeatureBuilderError, match="cannot project geometry"):
        fb._project_point_to_plane((0, 0, 0), object())
    with pytest.raises(fb.FeatureBuilderError, match="cannot project geometry"):
        fb._project_edge_to_sketch(object(), object(), 0)
    with pytest.raises(fb.FeatureBuilderError, match="cannot compute extrude direction"):
        fb._extrude_direction(object(), None, "feature 'f'")
    monkeypatch.setattr(fb, "_BUILD_AXIS", {})
    fb._ensure_build_axis()
    assert fb._BUILD_AXIS == {}


# ---------------------------------------------------------------------------
# Dress-up / translate / defeature branches.
# ---------------------------------------------------------------------------


def test_fillet_and_chamfer_require_edges() -> None:
    bd = _bd()
    box = bd.Solid.make_box(10, 10, 10)
    with pytest.raises(fb.FeatureBuilderError, match="fillet requires at least one edge"):
        fb._apply_fillet(box, [], 1.0, "f")
    with pytest.raises(fb.FeatureBuilderError, match="chamfer requires at least one edge"):
        fb._apply_chamfer(box, [], {}, "f")


def test_chamfer_parameter_combinations() -> None:
    bd = _bd()
    box = bd.Solid.make_box(10, 10, 10)
    edge = box.edges()[0].wrapped
    with pytest.raises(fb.FeatureBuilderError, match="both distance and distances"):
        fb._apply_chamfer(box, [edge], {"distance": 1.0, "distances": [1.0, 2.0]}, "f")
    with pytest.raises(fb.FeatureBuilderError, match="cannot specify angle with distances"):
        fb._apply_chamfer(box, [edge], {"distances": [1.0, 2.0], "angle": 30.0}, "f")
    with pytest.raises(fb.FeatureBuilderError, match="requires distance, distances"):
        fb._apply_chamfer(box, [edge], {}, "f")
    ch = fb._apply_chamfer(box, [edge], {"distances": [1.0, 2.0]}, "f")
    assert 0.0 < ch.volume < box.volume


def test_shell_failure_is_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    bd = _bd()
    box = bd.Solid.make_box(10, 10, 10)

    class _NotDone:
        def MakeThickSolidByJoin(self, *_args: Any) -> None:
            pass

        def Build(self) -> None:
            pass

        def IsDone(self) -> bool:
            return False

    import OCP.BRepOffsetAPI as brepoff

    monkeypatch.setattr(brepoff, "BRepOffsetAPI_MakeThickSolid", _NotDone)
    with pytest.raises(fb.FeatureBuilderError, match="shell operation failed"):
        fb._apply_shell(box, [], 1.0, "f")

    class _Exploding:
        def MakeThickSolidByJoin(self, *_args: Any) -> None:
            raise RuntimeError("thick solid failed")

    monkeypatch.setattr(brepoff, "BRepOffsetAPI_MakeThickSolid", _Exploding)
    with pytest.raises(fb.FeatureBuilderError, match="shell failed"):
        fb._apply_shell(box, [], 1.0, "f")


class _FakeDefeaturing:
    def __init__(self, shape: Any, done: bool) -> None:
        self._shape = shape
        self._done = done

    def SetShape(self, _shape: Any) -> None:
        pass

    def AddFaceToRemove(self, _face: Any) -> None:
        pass

    def Build(self) -> None:
        pass

    def IsDone(self) -> bool:
        return self._done

    def Shape(self) -> Any:
        return self._shape


def test_defeature_failure_and_result_shape_branches(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bd = _bd()
    box = bd.Solid.make_box(10, 10, 10)
    monkeypatch.setattr(fb, "_DefeaturingOp", lambda: _FakeDefeaturing(box.wrapped, False))
    with pytest.raises(fb.FeatureBuilderError, match="defeature operation failed"):
        fb._apply_defeature(box, [box.faces()[0].wrapped], "f")

    empty = bd.Shell(box.faces())
    monkeypatch.setattr(fb, "_DefeaturingOp", lambda: _FakeDefeaturing(empty.wrapped, True))
    with pytest.raises(fb.FeatureBuilderError, match="removed all material"):
        fb._apply_defeature(box, [box.faces()[0].wrapped], "f")

    two = bd.Compound(
        children=[
            bd.Solid.make_box(1, 1, 1),
            bd.Solid.make_box(1, 1, 1).moved(bd.Location((5, 0, 0))),
        ]
    )
    monkeypatch.setattr(fb, "_DefeaturingOp", lambda: _FakeDefeaturing(two.wrapped, True))
    result = fb._apply_defeature(box, [box.faces()[0].wrapped], "f")
    assert len(result.solids()) == 2


def test_defeature_wraps_unexpected_operation_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bd = _bd()
    box = bd.Solid.make_box(10, 10, 10)

    class _Exploding(_FakeDefeaturing):
        def Shape(self) -> Any:
            raise RuntimeError("shape exploded")

    monkeypatch.setattr(fb, "_DefeaturingOp", lambda: _Exploding(box.wrapped, True))
    with pytest.raises(fb.FeatureBuilderError, match="defeature failed: shape exploded"):
        fb._apply_defeature(box, [box.faces()[0].wrapped], "f")


def test_translate_rejects_invalid_vectors() -> None:
    bd = _bd()
    box = bd.Solid.make_box(10, 10, 10)
    with pytest.raises(fb.FeatureBuilderError, match="translate requires vector"):
        fb._apply_translate(box, [1.0, 2.0], "f")
    with pytest.raises(fb.FeatureBuilderError, match="translate failed"):
        fb._apply_translate(object(), [1.0, 2.0, 3.0], "f")
    moved = fb._apply_translate(box, [5.0, 0.0, 0.0], "f")
    assert moved.bounding_box().min.X == pytest.approx(5.0)


def test_neutral_plane_rejects_non_planar_and_unreadable_faces() -> None:
    bd = _bd()
    cylinder = bd.Solid.make_cylinder(5, 10)
    side = _nonplanar_face(cylinder)
    with pytest.raises(fb.FeatureBuilderError, match="neutralPlane face is not planar"):
        fb._neutral_plane_from_face(side, "f")
    with pytest.raises(fb.FeatureBuilderError, match="neutralPlane face is not planar"):
        fb._neutral_plane_from_face(object(), "f")


def test_body_diagonal_and_inward_normal() -> None:
    bd = _bd()
    box = bd.Solid.make_box(10, 10, 10)
    assert fb._body_bounding_box_diagonal(object()) == pytest.approx(1e6)
    assert fb._body_bounding_box_diagonal(box) == pytest.approx(math.sqrt(300.0))
    top = _top_face(box)
    # Passing the already-inward normal lands the probe inside the solid.
    assert fb._inward_normal(box, top, (0.0, 0.0, -1.0)) == pytest.approx((0.0, 0.0, -1.0))
    assert fb._inward_normal(box, top, (0.0, 0.0, 1.0)) == pytest.approx((0.0, 0.0, -1.0))


def test_orient_along_inward_rotates_and_flips() -> None:
    bd = _bd()
    cyl = bd.Solid.make_cylinder(1.0, 10.0)
    tilted = fb._orient_along_inward(cyl, (1.0, 0.0, 0.0))
    bbox = tilted.bounding_box()
    assert bbox.max.X == pytest.approx(10.0, abs=1e-6)
    flipped = fb._orient_along_inward(cyl, (0.0, 0.0, -1.0))
    assert flipped.bounding_box().min.Z == pytest.approx(-10.0, abs=1e-6)


def test_find_top_rim_edge_selects_highest_circle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bd = _bd()
    # The production helper calls ``rr._edge_curve``; shim it here so the edge
    # selection logic itself can be exercised independently of the resolver API.
    from OCP.BRepAdaptor import BRepAdaptor_Curve

    monkeypatch.setattr(fb.rr, "_edge_curve", BRepAdaptor_Curve, raising=False)
    cylinder = bd.Cylinder(radius=2.0, height=6.0)
    rim = fb._find_top_rim_edge(cylinder, (0.0, 0.0, -3.0), (0.0, 0.0, 1.0))
    assert rim is not None
    with pytest.raises(fb.FeatureBuilderError, match="could not find top rim edge"):
        fb._find_top_rim_edge(bd.Solid.make_box(10, 10, 10), (0.0, 0.0, 0.0), (0.0, 0.0, 1.0))


def test_modeled_thread_validation_edges(monkeypatch: pytest.MonkeyPatch) -> None:
    assert fb._validate_modeled_thread("f", {"thread": "cosmetic"}) is None
    with pytest.raises(fb.FeatureBuilderError, match="requires a positive hole diameter"):
        fb._validate_modeled_thread("f", {"thread": "modeled", "depth": 10.0, "diameter": 0})
    monkeypatch.setattr(fb, "HAS_FASTENER_DATA", False)
    with pytest.raises(fb.FeatureBuilderError, match="requires the fastener tables"):
        fb._validate_modeled_thread("f", {"thread": "modeled", "depth": 10.0, "diameter": 6.0})


def test_modeled_thread_helix_fit_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    _bd()
    spec = fb._coarse_thread_for_diameter(6.0, "f")

    def explode(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("fit failed")

    monkeypatch.setattr(fb.curve_builder, "_fit_curve", explode)
    with pytest.raises(fb.FeatureBuilderError, match="modeled thread helix fit failed"):
        fb._build_modeled_thread_tool((0, 0, 0), (0, 0, 1), 10.0, spec, "f")
    monkeypatch.setattr(fb.curve_builder, "_fit_curve", lambda *_a, **_k: {})
    with pytest.raises(fb.FeatureBuilderError, match="modeled thread helix fit produced no wire"):
        fb._build_modeled_thread_tool((0, 0, 0), (0, 0, 1), 10.0, spec, "f")


def test_path_start_frame_requires_an_edge() -> None:
    bd = _bd()
    vertex = bd.Vertex(0, 0, 0)
    with pytest.raises(fb.FeatureBuilderError, match="path curve has no edges"):
        fb._path_start_frame(vertex.wrapped)


def test_sweep_orientation_validation() -> None:
    with pytest.raises(fb.FeatureBuilderError, match="orientation must be 'frenet'"):
        fb._sweep_params_or_raise({"orientation": "twisted"}, "f")
    with pytest.raises(fb.FeatureBuilderError, match="fixedBinormal requires a finite binormal"):
        fb._sweep_params_or_raise({"orientation": "fixedBinormal", "binormal": [1, 0]}, "f")
    orientation, binormal = fb._sweep_params_or_raise(
        {"orientation": "fixedBinormal", "binormal": [0, 0, 4]}, "f"
    )
    assert orientation == "fixedBinormal"
    assert binormal == pytest.approx((0.0, 0.0, 1.0))


def test_pipe_tool_validation_branches() -> None:
    _bd()
    feature = {"id": "p"}
    with pytest.raises(fb.FeatureBuilderError, match="pipe requires a pathCurveId"):
        fb._build_pipe_tool(feature, {}, {}, {})
    with pytest.raises(fb.FeatureBuilderError, match="path curve 'c' is unavailable"):
        fb._build_pipe_tool(feature, {"pathCurveId": "c"}, {}, {})
    with pytest.raises(fb.FeatureBuilderError, match="pipe requires a positive radius"):
        fb._build_pipe_tool(feature, {"pathCurveId": "c", "radius": 0}, {"c": {}}, {})
    with pytest.raises(fb.FeatureBuilderError, match="path curve has no wire"):
        fb._build_pipe_tool(feature, {"pathCurveId": "c", "radius": 1}, {"c": {}}, {})


def test_circular_section_radius_detection() -> None:
    bd = _bd()
    rect_wire = bd.Wire.make_rect(10, 5)
    assert fb._circular_section_radius(rect_wire.wrapped) is None
    line_wire = bd.Wire([bd.Edge.make_line((0, 0, 0), (10, 0, 0))])
    assert fb._circular_section_radius(line_wire.wrapped) is None
    circle_wire = bd.Wire.make_circle(3.0)
    assert fb._circular_section_radius(circle_wire.wrapped) == pytest.approx(3.0)


def test_coil_sweep_helper_validation() -> None:
    _bd()
    with pytest.raises(fb.FeatureBuilderError, match="coilSweep params must be an object"):
        fb._coil_sweep_params([], "f")
    with pytest.raises(fb.FeatureBuilderError, match="coilSweep rotation-minimizing frame"):
        fb._coil_sweep_unit((0.0, 0.0, 0.0), "f", "rotation-minimizing frame")
    frames, holonomy = fb._coil_sweep_frames([(0.0, 0.0, 1.0)], False, "f")
    assert holonomy == 0.0
    assert frames[0] == pytest.approx((0.0, -1.0, 0.0))
    frames, _holonomy = fb._coil_sweep_frames([(0.0, 0.0, 1.0), (0.0, -1.0, 0.0)], False, "f")
    assert frames[1] == pytest.approx((1.0, 0.0, 0.0))


def test_coil_sweep_stations_falls_back_to_parameter_samples(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bd = _bd()

    def unavailable(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("no abscissa")

    import OCP.GCPnts as gpnts

    monkeypatch.setattr(gpnts, "GCPnts_UniformAbscissa", unavailable)
    wire = bd.Wire([bd.Edge.make_line((0, 0, 0), (10, 0, 0))])
    points, tangents = fb._coil_sweep_stations(wire.wrapped, 3, "f")
    assert points == [
        pytest.approx((0.0, 0.0, 0.0)),
        pytest.approx((5.0, 0.0, 0.0)),
        pytest.approx((10.0, 0.0, 0.0)),
    ]
    assert all(tangent == pytest.approx((1.0, 0.0, 0.0)) for tangent in tangents)


# ---------------------------------------------------------------------------
# Lattice pure helpers.
# ---------------------------------------------------------------------------


def test_lattice_integer_helpers() -> None:
    with pytest.raises(fb.FeatureBuilderError, match="must be an integer"):
        fb._lattice_int("2", "ctx")
    with pytest.raises(fb.FeatureBuilderError, match="must be an integer"):
        fb._lattice_int(True, "ctx")
    assert fb._lattice_int(2, "ctx") == 2
    assert fb._lattice_cell_count({"rows": 0, "cols": 2}) is None
    assert fb._lattice_cell_count({"rings": "1"}) is None
    assert fb._lattice_cell_count({"rows": 2, "cols": 3}) == 6


def test_lattice_validation_edges() -> None:
    with pytest.raises(fb.FeatureBuilderError, match="params must be an object"):
        fb._validate_lattice_params([], "lat")
    with pytest.raises(fb.FeatureBuilderError, match="rings must be an integer >= 0"):
        fb._validate_lattice_params(
            {"source": "pin", "latticeType": "hexagonal", "rings": -1, "pitch": 1.0}, "lat"
        )
    layout = fb._validate_lattice_params(
        {
            "source": "pin",
            "latticeType": "rectangular",
            "rows": 2,
            "cols": 2,
            "pitch": 3.0,
            "pitchY": 4.0,
        },
        "lat",
    )
    assert layout["pitchY"] == pytest.approx(4.0)
    layout = fb._validate_lattice_params(
        {
            "source": "pin",
            "latticeType": "hexagonal",
            "rings": 1,
            "pitch": 3.0,
            "orientation": "flatTop",
        },
        "lat",
    )
    assert layout["orientation"] == "flatTop"
    with pytest.raises(fb.FeatureBuilderError, match="datumId must be a non-empty string"):
        fb._validate_lattice_params(
            {
                "source": "pin",
                "latticeType": "rectangular",
                "rows": 1,
                "cols": 1,
                "pitch": 1.0,
                "datumId": "",
            },
            "lat",
        )


def test_lattice_flat_top_ring_offsets() -> None:
    cells = fb._lattice_cell_offsets(
        {"latticeType": "hexagonal", "rings": 1, "pitch": 2.0, "orientation": "flatTop"}
    )
    by_cell = {(row, col): (dx, dy) for (dx, dy), (row, col) in cells}
    assert by_cell[(0, 0)] == pytest.approx((0.0, 0.0))
    assert by_cell[(1, 0)] == pytest.approx((0.0, 2.0 * math.sqrt(3.0)))
    assert len(cells) == 7


# ---------------------------------------------------------------------------
# Shape-count / volume / overlap helpers.
# ---------------------------------------------------------------------------


def test_solid_count_and_shape_volume_fallbacks() -> None:
    bd = _bd()
    box = bd.Solid.make_box(10, 10, 10)
    assert fb._solid_count(None) == 0
    assert fb._solid_count(SimpleNamespace(wrapped=box.wrapped)) == 1
    assert fb._solid_count(object()) == 0
    assert fb._shape_volume(None) == 0.0
    assert fb._shape_volume(SimpleNamespace(volume=-1.0, wrapped=box.wrapped)) == pytest.approx(
        1000.0
    )
    assert fb._shape_volume(object()) == 0.0
    assert fb._boolean_result_volume(None) == 0.0
    assert fb._boolean_result_volume([box, box]) == pytest.approx(2000.0)
    assert fb._boolean_result_volume(object()) == 0.0


def test_body_overlap_signatures_filters_and_boolean_targets() -> None:
    document = {
        "features": [
            "not-a-feature",
            {"id": 7},
            {"id": "pad", "body": "body-1"},
            {"id": "cut", "params": {"targetBody": "body-2"}},
            {"id": "uncached"},
        ]
    }
    keys = {"pad": "k-pad", "cut": "k-cut", "uncached": ""}
    signatures = fb._body_overlap_signatures(document, keys)
    assert set(signatures) == {"body-1", "body-2"}
    assert fb._body_overlap_signatures({"features": "nope"}, keys) == {}


def test_cross_body_overlap_skips_without_build123d(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(fb, "bd", None)
    assert fb._check_cross_body_overlap([], [], None, None) == ([], {})


def test_cross_body_overlap_reuses_cached_volume_and_handles_none_body() -> None:
    bd = _bd()
    box = bd.Solid.make_box(10, 10, 10)
    signatures = {"a": "sa", "b": "sb"}
    warnings, verdicts = fb._check_cross_body_overlap(
        [box, box],
        ["b", "a"],
        {"a|b": {"a": "sa", "b": "sb", "volume": "not-a-number"}},
        signatures,
    )
    assert warnings
    assert verdicts["a|b"]["volume"] == pytest.approx(1000.0)
    warnings, verdicts = fb._check_cross_body_overlap([None, box], ["a", "b"], None, None)
    assert warnings == []
    assert verdicts == {}


def test_cross_body_overlap_wraps_boolean_failures() -> None:
    box = _bd().Solid.make_box(10, 10, 10)

    class _BadAnd:
        def __init__(self, exc: Exception) -> None:
            self._exc = exc

        def bounding_box(self) -> Any:
            return box.bounding_box()

        def __and__(self, _other: Any) -> Any:
            raise self._exc

    for exc, message in [
        (ValueError("empty compound"), None),
        (ValueError("plain failure"), "failed to check overlap"),
        (RuntimeError("runtime failure"), "failed to check overlap"),
    ]:
        body = _BadAnd(exc)
        if message is None:
            warnings, verdicts = fb._check_cross_body_overlap(
                [body, _BadAnd(RuntimeError("unused"))], ["a", "b"], None, None
            )
            assert warnings == []
            assert verdicts == {}
        else:
            with pytest.raises(fb.FeatureBuilderError, match=message):
                fb._check_cross_body_overlap([body, _BadAnd(exc)], ["a", "b"], None, None)


def test_cut_intersection_and_combine_guards(monkeypatch: pytest.MonkeyPatch) -> None:
    bd = _bd()
    box = bd.Solid.make_box(10, 10, 10)
    monkeypatch.setattr(fb, "bd", None)
    with pytest.raises(fb.FeatureBuilderError, match="cannot check cut intersection"):
        fb._require_cut_intersection(box, box, "f", "pocket")
    with pytest.raises(fb.FeatureBuilderError, match="cannot combine additive shapes"):
        fb._combine_additive(box, box, "f")
    with pytest.raises(fb.FeatureBuilderError, match="cannot apply boolean operations"):
        fb._boolean_operation(box, [box], "booleanFuse")
    monkeypatch.setattr(fb, "bd", bd)

    class _BadAnd:
        def __init__(self, exc: Exception) -> None:
            self._exc = exc

        def bounding_box(self) -> Any:
            return box.bounding_box()

        def __and__(self, _other: Any) -> Any:
            raise self._exc

    with pytest.raises(fb.FeatureBuilderError, match="tool does not intersect the body"):
        fb._require_cut_intersection(_BadAnd(ValueError("empty compound")), box, "f", "pocket")
    with pytest.raises(fb.FeatureBuilderError, match="failed to check pocket intersection"):
        fb._require_cut_intersection(_BadAnd(ValueError("boom")), box, "f", "pocket")
    with pytest.raises(fb.FeatureBuilderError, match="failed to check pocket intersection"):
        fb._require_cut_intersection(_BadAnd(RuntimeError("boom")), box, "f", "pocket")
    with pytest.raises(fb.FeatureBuilderError, match="failed to check overlap"):
        fb._combine_additive(_BadAnd(RuntimeError("boom")), box, "f")


def test_boolean_operation_requires_tools_and_wraps_unknown_ops() -> None:
    bd = _bd()
    box = bd.Solid.make_box(10, 10, 10)
    with pytest.raises(fb.FeatureBuilderError, match="requires at least one tool body"):
        fb._boolean_operation(box, [], "booleanFuse")
    fused = fb._boolean_operation(
        box, [bd.Solid.make_box(1, 1, 1), bd.Solid.make_box(1, 1, 1)], "booleanFuse"
    )
    assert fused is not None
    with pytest.raises(fb.FeatureBuilderError, match="unknown boolean operation"):
        fb._boolean_operation(box, [box], "booleanXor")

    class _BadAdd:
        def __add__(self, _other: Any) -> Any:
            raise RuntimeError("union failed")

    with pytest.raises(fb.FeatureBuilderError, match="boolean booleanFuse failed"):
        fb._boolean_operation(_BadAdd(), [box], "booleanFuse")


def test_import_placement_validation_errors() -> None:
    bd = _bd()
    box = bd.Solid.make_box(10, 10, 10)
    assert fb._apply_import_placement(box, None, "f") is box
    with pytest.raises(fb.FeatureBuilderError, match="placement must be an object"):
        fb._apply_import_placement(box, "top", "f")
    with pytest.raises(fb.FeatureBuilderError, match="import rotateDegrees failed"):
        fb._apply_import_placement(object(), {"rotateDegrees": [10, 0, 0]}, "f")
    with pytest.raises(fb.FeatureBuilderError, match="import translate failed"):
        fb._apply_import_placement(object(), {"translate": [1, 0, 0]}, "f")
    rotated = fb._apply_import_placement(box, {"rotateDegrees": [0, 0, 90]}, "f")
    assert rotated.bounding_box().min.X == pytest.approx(-10.0)


# ---------------------------------------------------------------------------
# Result-cache seam.
# ---------------------------------------------------------------------------


def test_shape_fingerprint_guards(monkeypatch: pytest.MonkeyPatch) -> None:
    bd = _bd()
    box = bd.Solid.make_box(10, 10, 10)
    assert fb._shape_fingerprint(box.wrapped)  # normal path, non-empty
    monkeypatch.setattr(fb, "HAS_REFERENCE_RESOLVER", False)
    assert fb._shape_fingerprint(box.wrapped) == ""
    monkeypatch.setattr(fb, "HAS_REFERENCE_RESOLVER", True)

    def explode(_shape: Any) -> Any:
        raise RuntimeError("no fingerprints")

    monkeypatch.setattr(fb.rr, "extract_face_fingerprints", explode)
    assert fb._shape_fingerprint(box.wrapped) == ""


def test_shape_brep_bytes_guards(monkeypatch: pytest.MonkeyPatch) -> None:
    bd = _bd()
    box = bd.Solid.make_box(10, 10, 10)
    assert fb._shape_to_brep_bytes(None) is None
    monkeypatch.setattr(fb, "HAS_OCP_COMPAT_IO", False)
    assert fb._shape_to_brep_bytes(box) is None
    monkeypatch.setattr(fb, "HAS_OCP_COMPAT_IO", True)
    monkeypatch.setattr(fb, "_brep_tools_write", lambda *_args: False)
    assert fb._shape_to_brep_bytes(box) is None

    def explode(*_args: Any) -> Any:
        raise RuntimeError("write failed")

    monkeypatch.setattr(fb, "_brep_tools_write", explode)
    assert fb._shape_to_brep_bytes(box) is None


def test_shape_brep_bytes_remove_failure_is_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    bd = _bd()
    box = bd.Solid.make_box(10, 10, 10)
    monkeypatch.setattr(fb, "_brep_tools_write", lambda *_args: False)

    def remove_fails(_path: str) -> None:
        raise OSError("cannot remove")

    monkeypatch.setattr("os.remove", remove_fails)
    assert fb._shape_to_brep_bytes(box) is None


def test_shape_from_brep_bytes_guards(monkeypatch: pytest.MonkeyPatch) -> None:
    _bd()
    with pytest.raises(fb.FeatureBuilderError, match="cached feature blob is empty"):
        fb._shape_from_brep_bytes(b"")
    monkeypatch.setattr(fb, "HAS_OCP_COMPAT_IO", False)
    with pytest.raises(fb.FeatureBuilderError, match="require OCP BREP IO"):
        fb._shape_from_brep_bytes(b"data")
    monkeypatch.setattr(fb, "HAS_OCP_COMPAT_IO", True)
    monkeypatch.setattr(fb, "_brep_tools_read", lambda *_args: False)
    with pytest.raises(fb.FeatureBuilderError, match="failed BREP IO"):
        fb._shape_from_brep_bytes(b"data")


def test_open_cache_size_cap_and_failure(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    assert fb._open_cache(None) is None
    cache = fb._open_cache(str(tmp_path / "c.nuke-cache.zip"), size_cap_bytes=128)
    assert cache is not None
    assert cache.size_cap_bytes == 128

    def explode(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("cannot open")

    monkeypatch.setattr(fb._doc_cache, "DocCache", explode)
    assert fb._open_cache(str(tmp_path / "c.nuke-cache.zip")) is None


def test_cache_read_and_write_guards() -> None:
    assert fb._cache_read_feature(None, "f", "k") == (None, None, {})

    class _BadCache:
        def lookup(self, *_args: Any) -> Any:
            raise RuntimeError("lookup failed")

        def store(self, *_args: Any, **_kwargs: Any) -> Any:
            raise RuntimeError("store failed")

    assert fb._cache_read_feature(_BadCache(), "f", "k") == (None, None, {})

    entry = SimpleNamespace(brep_bytes=None, tool_bytes=None, meta={})
    cache = SimpleNamespace(lookup=lambda *_args: entry)
    assert fb._cache_read_feature(cache, "f", "k") == (None, None, {})
    assert fb._cache_write_feature(None, "f", "k", b"b", None, {}, "") is False
    assert fb._cache_write_feature(_BadCache(), "f", "k", b"b", None, {}, "") is False


def _cache_entry(body: bytes | None, tool: bytes | None = None, meta: Any = None) -> Any:
    return SimpleNamespace(brep_bytes=body, tool_bytes=tool, meta={} if meta is None else meta)


def test_restore_cached_feature_rejects_inconsistent_entries() -> None:
    _bd()
    state = _state()
    lattice = {"id": "lat", "type": "lattice"}
    assert fb._restore_cached_feature(state, lattice, None, "k") is False
    empty_cache = SimpleNamespace(lookup=lambda *_args: _cache_entry(None))
    assert (
        fb._restore_cached_feature(state, {"id": "pad", "type": "pad"}, empty_cache, "k") is False
    )
    case_cache = SimpleNamespace(lookup=lambda *_args: _cache_entry(b"data", None, {}))
    assert (
        fb._restore_cached_feature(
            state, {"id": "bool", "type": "booleanFuse", "params": {}}, case_cache, "k"
        )
        is False
    )
    assert (
        fb._restore_cached_feature(
            state,
            {"id": "bool", "type": "booleanFuse", "params": {"targetBody": "b1"}},
            SimpleNamespace(lookup=lambda *_args: _cache_entry(b"data", None, {"target": "b2"})),
            "k",
        )
        is False
    )
    assert (
        fb._restore_cached_feature(
            state,
            {"id": "pad", "type": "pad", "body": ""},
            case_cache,
            "k",
        )
        is False
    )
    bad_brep = SimpleNamespace(lookup=lambda *_args: _cache_entry(b"garbage", None, {}))
    assert (
        fb._restore_cached_feature(
            state, {"id": "pad", "type": "pad", "body": "body-1"}, bad_brep, "k"
        )
        is False
    )


def test_write_back_feature_guards(monkeypatch: pytest.MonkeyPatch) -> None:
    bd = _bd()
    box = bd.Solid.make_box(10, 10, 10)
    cache = SimpleNamespace(store=lambda *_args, **_kwargs: None)
    state = _state(accumulators={"body-1": box})
    feature = {"id": "pad", "type": "pad", "body": "body-1"}
    assert fb._write_back_feature(state, feature, cache, "k") is False
    state.feature_results.append({"featureId": "pad", "status": "stale"})
    assert fb._write_back_feature(state, feature, cache, "k") is False
    state.feature_results[-1] = {"featureId": "pad", "status": "built"}
    bad_boolean = {"id": "bool", "type": "booleanFuse", "params": {"targetBody": ""}}
    state.feature_results[-1] = {"featureId": "bool", "status": "built"}
    assert fb._write_back_feature(state, bad_boolean, cache, "k") is False
    bad_body = {"id": "pad", "type": "pad", "body": ""}
    state.feature_results[-1] = {"featureId": "pad", "status": "built"}
    assert fb._write_back_feature(state, bad_body, cache, "k") is False
    missing_shape = _state()
    assert fb._write_back_feature(missing_shape, feature, cache, "k") is False

    def explode(_shape: Any) -> Any:
        raise RuntimeError("cannot serialize")

    monkeypatch.setattr(fb, "_shape_to_brep_bytes", explode)
    assert fb._write_back_feature(state, feature, cache, "k") is False
    monkeypatch.setattr(fb, "_shape_to_brep_bytes", lambda _shape: None)
    assert fb._write_back_feature(state, feature, cache, "k") is False


def test_must_execute_partial_guards() -> None:
    state = _state()
    assert fb._must_execute_partial(state, {"id": "a", "suppressed": True}) is True
    state.stale_or_failed.add("dep")
    assert fb._must_execute_partial(state, {"id": "a", "dependsOn": ["dep"]}) is True
    state.consumed_bodies.add("body-1")
    assert fb._must_execute_partial(state, {"id": "a", "body": "body-1"}) is True
    assert (
        fb._must_execute_partial(state, {"id": "b", "type": "booleanFuse", "body": "body-1"})
        is False
    )


def test_partial_build_cache_error_branches(monkeypatch: pytest.MonkeyPatch) -> None:
    _bd()
    doc = _document([_feature("base", "pad", {"length": 5.0}, "rect")], [_rect_sketch()])
    with pytest.raises(fb.FeatureBuilderError, match="partial build names unknown features"):
        fb.build_document_shape_partial(doc, ["missing"])

    class _BadCache:
        def __init__(self) -> None:
            self.overlap_verdicts = self._raise_read

        def _raise_read(self) -> Any:
            raise RuntimeError("read")

        def store_overlap_verdicts(self, _verdicts: Any) -> None:
            raise RuntimeError("store")

        def lookup(self, *_args: Any) -> Any:
            return None

        def store(self, *_args: Any, **_kwargs: Any) -> None:
            pass

    monkeypatch.setattr(fb, "_content_keys_for_document", lambda _doc: {"base": "k"})
    result = fb.build_document_shape_partial(doc, ["base"], cache=_BadCache(), size_cap_bytes=None)
    assert result["shape"] is not None
    assert _by_id(result)["base"]["status"] == "built"

    monkeypatch.setattr(
        fb,
        "_content_keys_for_document",
        lambda _doc: (_ for _ in ()).throw(RuntimeError("keys")),
    )
    result = fb.build_document_shape_partial(doc, ["base"], cache=_BadCache())
    assert result["shape"] is not None


def test_partial_build_requires_build123d(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fb, "bd", None)
    with pytest.raises(fb.FeatureBuilderError, match="build123d is not available"):
        fb.build_document_shape_partial({"features": []}, [])
    with pytest.raises(fb.FeatureBuilderError, match="build123d is not available"):
        fb.build_document_shape({"features": []})


def test_content_keys_requires_cache_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fb, "HAS_DOC_CACHE", False)
    with pytest.raises(fb.FeatureBuilderError, match="result-cache backend is unavailable"):
        fb._content_keys_for_document({"features": []})


def test_flush_lattice_selector_entries_guards() -> None:
    bd = _bd()
    box = bd.Solid.make_box(1, 1, 1)
    state = SimpleNamespace(
        lattice_cells=[
            {"body_id": "absent", "labels": ["x"]},
            {"body_id": "body-1", "labels": []},
            {
                "body_id": "body-1",
                "labels": ["cell"],
                "local": "not-a-dict",
                "prev_count": 0,
            },
        ],
        accumulators={"body-1": box},
    )
    selector_map: dict[str, list[int]] = {}
    fb._flush_lattice_selector_entries(state, selector_map, {"body-1": 0})
    assert selector_map == {"cell": [1]}


# ---------------------------------------------------------------------------
# Document-level validation branches.
# ---------------------------------------------------------------------------


def test_boolean_feature_validation_errors() -> None:
    _bd()
    base = _feature("base", "pad", {"length": 5.0}, "rect")
    bodies = [{"id": "body-1", "name": "Body 1"}, {"id": "body-2", "name": "Body 2"}]

    def run(features: list[dict[str, Any]]) -> dict[str, Any]:
        return _by_id(fb.build_document_shape(_document(features, [_rect_sketch()], bodies=bodies)))

    missing_target = run([_feature("b", "booleanFuse", {"toolBodies": ["body-2"]})])
    assert "requires a targetBody" in missing_target["b"]["error"]

    missing_tools = run([_feature("b", "booleanCut", {"targetBody": "body-1"})])
    assert "at least one tool body" in missing_tools["b"]["error"]

    no_target_geometry = run(
        [_feature("b", "booleanFuse", {"targetBody": "body-1", "toolBodies": ["body-2"]})]
    )
    assert "has no geometry" in no_target_geometry["b"]["error"]

    no_tool_geometry = run(
        [
            base,
            _feature("b", "booleanFuse", {"targetBody": "body-1", "toolBodies": ["body-2"]}),
        ]
    )
    assert "tool bodies have no geometry: body-2" in no_tool_geometry["b"]["error"]

    ghost = run(
        [
            base,
            _feature("ghost", "pad", {"length": 1.0}, "rect", body="ghost"),
            _feature("b", "booleanFuse", {"targetBody": "body-1", "toolBodies": ["ghost"]}),
        ]
    )
    assert "unknown tool bodies: ghost" in ghost["b"]["error"]


def test_boolean_operation_failure_is_recorded(monkeypatch: pytest.MonkeyPatch) -> None:
    _bd()
    bodies = [{"id": "body-1", "name": "Body 1"}, {"id": "body-2", "name": "Body 2"}]
    doc = _document(
        [
            _feature("base", "pad", {"length": 5.0}, "rect"),
            _feature("tool", "pad", {"length": 5.0}, "rect", body="body-2"),
            _feature("b", "booleanFuse", {"targetBody": "body-1", "toolBodies": ["body-2"]}),
        ],
        [_rect_sketch()],
        bodies=bodies,
    )

    def explode(*_args: Any) -> Any:
        raise RuntimeError("boolean blew up")

    monkeypatch.setattr(fb, "_boolean_operation", explode)
    by_id = _by_id(fb.build_document_shape(doc))
    assert by_id["b"]["status"] == "failed"
    assert "boolean blew up" in by_id["b"]["error"]


def test_dress_up_validation_errors() -> None:
    _bd()
    base = _feature("base", "pad", {"length": 5.0}, "rect")

    def run(feature: dict[str, Any]) -> dict[str, Any]:
        return _by_id(fb.build_document_shape(_document([base, feature], [_rect_sketch()])))

    bad_fillet = run(_feature("f", "fillet", {"radius": 0}))
    assert "fillet requires a positive radius" in bad_fillet["f"]["error"]

    missing_pull = run(_feature("d", "draft", {"angle": 5.0}))
    assert "draft requires pullDirection" in missing_pull["d"]["error"]

    bad_angle = run(_feature("d", "draft", {"pullDirection": [0, 0, 1], "angle": "wide"}))
    assert "draft requires a finite angle" in bad_angle["d"]["error"]

    bad_shell = run(_feature("s", "shell", {"thickness": 0}))
    assert "shell requires a positive thickness" in bad_shell["s"]["error"]


def test_pattern_without_source_is_reported() -> None:
    _bd()
    doc = _document(
        [
            _feature("base", "pad", {"length": 5.0}, "rect"),
            _feature("pat", "linearPattern", {"count": 2, "spacing": 20.0}),
        ],
        [_rect_sketch()],
    )
    by_id = _by_id(fb.build_document_shape(doc))
    assert by_id["pat"]["status"] == "failed"
    assert "source feature id is required" in by_id["pat"]["error"]


def test_hole_rejects_invalid_center() -> None:
    top_ref, _shape = _build_base_and_capture_top_face(length=5.0)
    doc = _document(
        [
            _feature("base", "pad", {"length": 5.0}, "rect"),
            _feature(
                "h",
                "hole",
                {"face": top_ref, "center": [0.0], "diameter": 2.0, "depth": 2.0},
            ),
        ],
        [_rect_sketch()],
    )
    by_id = _by_id(fb.build_document_shape(doc))
    assert by_id["h"]["status"] == "failed"
    assert "hole center must be [u, v]" in by_id["h"]["error"]


def test_pad_and_revolve_parameter_validation() -> None:
    _bd()
    bodies = [{"id": "body-1", "name": "Body 1"}]

    def run(feature: dict[str, Any]) -> dict[str, Any]:
        return _by_id(
            fb.build_document_shape(_document([feature], [_rect_sketch()], bodies=bodies))
        )

    bad_length = run(_feature("p", "pad", {"length": 0}, "rect"))
    assert "requires a positive length" in bad_length["p"]["error"]

    bad_axis = run(_feature("r", "revolve", {"axis": "w", "angle": 360.0}, "rect"))
    assert "requires axis 'x', 'y', or 'z'" in bad_axis["r"]["error"]

    bad_angle = run(_feature("r", "revolve", {"axis": "x", "angle": 0}, "rect"))
    assert "revolve angle must be in (0, 360]" in bad_angle["r"]["error"]


def test_feature_shape_requires_a_known_sketch() -> None:
    _bd()
    missing_id = _by_id(
        fb.build_document_shape(
            _document([_feature("p", "pad", {"length": 1.0})], [_rect_sketch()])
        )
    )
    assert "requires a sketchId" in missing_id["p"]["error"]
    unknown = _by_id(
        fb.build_document_shape(
            _document([_feature("p", "pad", {"length": 1.0}, "nope")], [_rect_sketch()])
        )
    )
    assert "references unknown sketch 'nope'" in unknown["p"]["error"]


def test_sweep_without_path_curve_is_reported() -> None:
    _bd()
    by_id = _by_id(
        fb.build_document_shape(
            _document(
                [_feature("s", "sweep", {"length": 1.0}, "rect")],
                [_rect_sketch()],
            )
        )
    )
    assert "sweep requires a pathCurveId" in by_id["s"]["error"]


def test_revolve_operation_failure_is_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    bd = _bd()

    def explode(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("revolve blew up")

    monkeypatch.setattr(bd, "revolve", explode)
    by_id = _by_id(
        fb.build_document_shape(
            _document(
                [_feature("r", "revolve", {"axis": "x", "angle": 90.0}, "rect")],
                [_rect_sketch()],
            )
        )
    )
    assert "revolve/groove operation failed" in by_id["r"]["error"]


def test_feature_shape_unsupported_type_and_absence(monkeypatch: pytest.MonkeyPatch) -> None:
    _bd()
    with pytest.raises(fb.FeatureBuilderError, match="type 'fillet' is not supported yet"):
        fb._build_feature_shape({"id": "x", "type": "fillet", "params": {}}, {}, {}, {}, {}, [])
    monkeypatch.setattr(fb, "bd", None)
    with pytest.raises(fb.FeatureBuilderError, match="build123d is not available"):
        fb._build_feature_shape({"id": "x", "type": "pad", "params": {}}, {}, {}, {}, {}, [])


def test_annular_pad_extrudes_inner_wire() -> None:
    _bd()
    doc = _document(
        [_feature("p", "pad", {"length": 5.0}, "annulus")],
        [_annulus_sketch()],
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    expected = 20.0 * 10.0 * 5.0 - math.pi * 4.0 * 5.0
    assert result["shape"].volume == pytest.approx(expected, rel=1e-6)


def test_extrude_profiles_span_multi_face_and_guard_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bd = _bd()
    face_a = bd.Face(bd.Wire.make_rect(10, 10))
    face_b = bd.Face(bd.Wire.make_rect(10, 10)).moved(bd.Location((20, 0, 0)))
    direction = bd.Vector(0, 0, 1)
    combined = fb._extrude_profiles_span([face_a, face_b], direction, 5.0, 0.0, "f", "pad")
    assert len(combined.children) == 2

    def face_fails(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("face failed")

    monkeypatch.setattr(bd, "Face", face_fails)
    with pytest.raises(fb.FeatureBuilderError, match="could not build outer face"):
        fb._extrude_profiles_span([face_a], direction, 5.0, 0.0, "f", "pad")
    monkeypatch.undo()

    def extrude_fails(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("extrude failed")

    monkeypatch.setattr(bd, "extrude", extrude_fails)
    with pytest.raises(fb.FeatureBuilderError, match="pad extrusion failed"):
        fb._extrude_profiles_span([face_a], direction, 5.0, 0.0, "f", "pad")
    monkeypatch.undo()

    def back_extrude_fails(*_args: Any, dir: Any = None, **_kwargs: Any) -> Any:
        if dir is not None and dir.Z < 0:
            raise RuntimeError("back extrusion failed")
        return bd.Solid.make_box(1, 1, 1)

    monkeypatch.setattr(bd, "extrude", back_extrude_fails)
    with pytest.raises(fb.FeatureBuilderError, match="pad extrusion failed"):
        fb._extrude_profiles_span([face_a], direction, 5.0, 2.0, "f", "pad")


def test_extrude_profiles_span_inner_wire_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bd = _bd()
    outer = bd.Wire.make_rect(20, 10)
    inner = bd.Wire.make_circle(2)
    annular = bd.Face(outer, [inner])
    direction = bd.Vector(0, 0, 1)
    real_face = bd.Face

    calls = {"count": 0}

    def face_fails_on_hole(wire: Any) -> Any:
        calls["count"] += 1
        if calls["count"] > 1:
            raise RuntimeError("hole face failed")
        return real_face(wire)

    monkeypatch.setattr(bd, "Face", face_fails_on_hole)
    with pytest.raises(fb.FeatureBuilderError, match="could not build hole face"):
        fb._extrude_profiles_span([annular], direction, 5.0, 0.0, "f", "pad")
    monkeypatch.undo()

    class _SubtractFails:
        def __sub__(self, _other: Any) -> Any:
            raise RuntimeError("subtraction failed")

    monkeypatch.setattr(bd, "extrude", lambda *_a, **_k: _SubtractFails())
    with pytest.raises(fb.FeatureBuilderError, match="boolean subtraction failed"):
        fb._extrude_profiles_span([annular], direction, 5.0, 0.0, "f", "pad")


def test_extrude_profiles_span_union_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    bd = _bd()
    face = bd.Face(bd.Wire.make_rect(10, 10))

    class _AddFails:
        def __add__(self, _other: Any) -> Any:
            raise RuntimeError("union failed")

    monkeypatch.setattr(bd, "extrude", lambda *_a, **_k: _AddFails())
    with pytest.raises(fb.FeatureBuilderError, match="boolean union failed"):
        fb._extrude_profiles_span([face], bd.Vector(0, 0, 1), 5.0, 2.0, "f", "pad")


def test_primitive_tool_validation_and_wrapped_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bd = _bd()
    datums = {"dxy": {"id": "dxy", "kind": "XY"}}

    def build(params: dict[str, Any], datum_map: dict[str, Any] | None = None) -> Any:
        return fb._build_primitive_tool(
            {"id": "p", "type": "primitive", "params": params},
            params,
            datum_map if datum_map is not None else datums,
            {},
            {},
            {},
            [],
        )

    unknown_face_ref = {
        "id": "dface",
        "kind": "face",
        "reference": {"featureId": "missing", "kind": "face", "fingerprint": {}},
    }
    with pytest.raises(fb.FeatureBuilderError, match="unresolved topological references"):
        build(
            {"shape": "box", "dimensions": [1, 1, 1], "datumId": "dface"},
            {"dface": unknown_face_ref},
        )
    with pytest.raises(fb.FeatureBuilderError, match="has no reference"):
        build(
            {"shape": "box", "dimensions": [1, 1, 1], "datumId": "dface"},
            {"dface": {"id": "dface", "kind": "face"}},
        )

    def explode(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("primitive build failed")

    monkeypatch.setattr(bd.Solid, "make_box", explode)
    with pytest.raises(fb.FeatureBuilderError, match="primitive 'box' build failed"):
        build({"shape": "box", "dimensions": [1, 1, 1]})


def test_build_lattice_result_requires_source_tool_and_datum() -> None:
    bd = _bd()
    pin = _feature("pin", "primitive", {"shape": "cylinder", "dimensions": [1.0, 5.0]})
    lat = _feature(
        "lat",
        "lattice",
        {"source": "pin", "latticeType": "rectangular", "rows": 1, "cols": 1, "pitch": 1.0},
    )
    state = _state(features=[pin, lat], datums={"dxy": {"id": "dxy", "kind": "XY"}})
    with pytest.raises(fb.FeatureBuilderError, match="tool shape is unavailable"):
        fb._build_lattice_result(state, lat, lat["params"], [], {})

    state.tool_shapes["pin"] = bd.Solid.make_box(1, 1, 1)
    state.datums = {}
    with pytest.raises(fb.FeatureBuilderError, match="references unknown datum"):
        fb._build_lattice_result(state, lat, lat["params"], [], {})

    state.datums = {"dxy": {"id": "dxy", "kind": "XY"}}
    with pytest.raises(fb.FeatureBuilderError, match="requires an existing solid body"):
        fb._build_lattice_result(state, lat, lat["params"], [], {})


def test_build_lattice_result_face_datum_uses_workplane() -> None:
    bd = _bd()
    box = bd.Solid.make_box(10, 10, 10)
    top = _top_face(box)
    face_datum = {
        "id": "dface",
        "kind": "face",
        "reference": {"featureId": "base", "kind": "face", "fingerprint": {}},
    }
    pin = _feature("pin", "primitive", {"shape": "cylinder", "dimensions": [1.0, 2.0]})
    lat = _feature(
        "lat",
        "lattice",
        {
            "source": "pin",
            "latticeType": "rectangular",
            "rows": 1,
            "cols": 1,
            "pitch": 2.0,
            "datumId": "dface",
        },
    )
    state = _state(
        features=[pin, lat],
        datums={"dface": face_datum},
        accumulators={"body-1": box},
        tool_shapes={"pin": bd.Solid.make_cylinder(0.5, 2.0).moved(bd.Location((0, 0, 10)))},
    )
    entities = [top]
    refs = {"datum.dface.reference": 0}
    result = fb._build_lattice_result(state, lat, lat["params"], entities, refs)
    assert result is not None
    assert "lat" in state.tool_shapes


def test_multitransform_error_branches() -> None:
    bd = _bd()
    box = bd.Solid.make_box(10, 10, 10)
    pin = _feature("pin", "pad", {"length": 1.0})
    first = {
        "id": "first",
        "type": "linearPattern",
        "body": "body-1",
        "params": {"source": "pin", "count": 2, "spacing": 20.0},
    }
    second = {
        "id": "second",
        "type": "mirror",
        "body": "body-1",
        "params": {"source": "pin", "plane": "YZ"},
    }
    multi = {
        "id": "multi",
        "type": "multiTransform",
        "body": "body-1",
        "params": {"first": "first", "second": "second"},
    }
    state = _state(
        features=[pin, first, second, multi],
        accumulators={"body-1": box},
    )
    fb._execute_feature(state, "multi")
    record = _by_id({"featureResults": state.feature_results})["multi"]
    assert "tool shape is unavailable" in record["error"]

    state.feature_results.clear()
    state.tool_shapes["pin"] = box
    state.feature_map["second"]["params"]["source"] = "gone"
    fb._execute_feature(state, "multi")
    record = _by_id({"featureResults": state.feature_results})["multi"]
    assert "source tool shape is unavailable" in record["error"]

    state.feature_results.clear()
    state.feature_map["second"]["params"]["source"] = "pin"
    state.feature_map["first"]["params"]["axisDatumId"] = "dface"
    state.datums["dface"] = {
        "id": "dface",
        "kind": "face",
        "reference": {"featureId": "missing", "kind": "face", "fingerprint": {}},
    }
    fb._execute_feature(state, "multi")
    record = _by_id({"featureResults": state.feature_results})["multi"]
    assert "unresolved topological references" in record["error"]


# ---------------------------------------------------------------------------
# Hole tool branches and remaining execution paths.
# ---------------------------------------------------------------------------


def _face_with_normal(shape: Any, target: tuple[float, float, float]) -> Any:
    for face in shape.faces():
        normal = face.normal_at()
        if all(
            abs(getattr(normal, axis) - value) < 1e-9
            for axis, value in zip("XYZ", target, strict=True)
        ):
            return face.wrapped
    raise AssertionError(f"no face with normal {target}")


def test_countersink_hole_tool_builds_with_resolver_shim(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bd = _bd()
    from OCP.BRepAdaptor import BRepAdaptor_Curve

    monkeypatch.setattr(fb.rr, "_edge_curve", BRepAdaptor_Curve, raising=False)
    box = bd.Solid.make_box(10, 10, 10)
    top = _top_face(box)
    plane = fb._workplane_from_face(top)
    tool = fb._build_hole_tool(
        plane,
        (0.0, 0.0),
        2.0,
        3.0,
        box,
        top,
        "h",
        countersink_diameter=4.0,
        countersink_angle=60.0,
    )
    assert tool.volume > 0.0
    with pytest.raises(fb.FeatureBuilderError, match="countersinkDiameter must exceed diameter"):
        fb._build_hole_tool(
            plane,
            (0.0, 0.0),
            2.0,
            3.0,
            box,
            top,
            "h",
            countersink_diameter=1.0,
            countersink_angle=60.0,
        )
    with pytest.raises(fb.FeatureBuilderError, match="countersinkAngle must be positive"):
        fb._build_hole_tool(
            plane,
            (0.0, 0.0),
            2.0,
            3.0,
            box,
            top,
            "h",
            countersink_diameter=4.0,
            countersink_angle=0.0,
        )


def test_counterbore_on_side_face_rotates_stepped_cut() -> None:
    bd = _bd()
    box = bd.Solid.make_box(10, 10, 10)
    side = _face_with_normal(box, (1.0, 0.0, 0.0))
    plane = fb._workplane_from_face(side)
    tool = fb._build_hole_tool(
        plane,
        (0.0, 0.0),
        2.0,
        3.0,
        box,
        side,
        "h",
        counterbore_diameter=4.0,
        counterbore_depth=1.0,
    )
    bbox = tool.bounding_box()
    assert bbox.max.X == pytest.approx(10.0)
    assert tool.volume > math.pi * 1.0**2 * 3.0


def test_find_top_rim_edge_rejects_off_axis_centers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bd = _bd()
    from OCP.BRepAdaptor import BRepAdaptor_Curve

    monkeypatch.setattr(fb.rr, "_edge_curve", BRepAdaptor_Curve, raising=False)
    cylinder = bd.Cylinder(radius=2.0, height=6.0)
    with pytest.raises(fb.FeatureBuilderError, match="could not find top rim edge"):
        fb._find_top_rim_edge(cylinder, (100.0, 0.0, -3.0), (0.0, 0.0, 1.0))


def test_helix_wire_fit_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    _bd()
    params = {"axis": "Z", "startRadius": 1.0, "pitch": 1.0, "turns": 1.0}

    def explode(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("helix fit failed")

    monkeypatch.setattr(fb.curve_builder, "_fit_curve", explode)
    with pytest.raises(fb.FeatureBuilderError, match="helicalSweep helix fit failed"):
        fb._build_helix_wire(params, "f")
    monkeypatch.setattr(fb.curve_builder, "_fit_curve", lambda *_a, **_k: {})
    with pytest.raises(fb.FeatureBuilderError, match="helicalSweep helix fit produced no wire"):
        fb._build_helix_wire(params, "f")


def test_coil_sweep_tool_requires_a_wire() -> None:
    _bd()
    state = _state()
    state.curve_results["c"] = {}
    feature = {"id": "coil", "type": "coilSweep"}
    params = {"pathCurveId": "c", "width": 1.0, "height": 1.0}
    with pytest.raises(fb.FeatureBuilderError, match="has no wire"):
        fb._build_coil_sweep_tool(feature, params, state)


def test_closed_spine_sweep_and_solid_guards() -> None:
    bd = _bd()
    line = bd.Wire([bd.Edge.make_line((0, 0, 0), (10, 0, 0))])
    rect = bd.Wire.make_rect(2, 2)
    box = bd.Solid.make_box(10, 10, 10)

    class _VertexBuilder:
        def Shape(self) -> Any:
            return bd.Vertex(0, 0, 0).wrapped

    with pytest.raises(fb.FeatureBuilderError, match="closed-path sweep produced no shell"):
        fb._closed_spine_sweep_solid(_VertexBuilder(), line.wrapped, rect.wrapped, "f")

    class _BoxBuilder:
        def Shape(self) -> Any:
            return box.wrapped

    with pytest.raises(fb.FeatureBuilderError, match="closed-path sweep of this section shape"):
        fb._closed_spine_sweep_solid(_BoxBuilder(), line.wrapped, rect.wrapped, "f")
    with pytest.raises(fb.FeatureBuilderError, match="did not produce a single solid"):
        fb._require_single_valid_solid(
            bd.Compound(
                children=[
                    bd.Solid.make_box(1, 1, 1),
                    bd.Solid.make_box(1, 1, 1).moved(bd.Location((5, 0, 0))),
                ]
            ).wrapped,
            "f",
        )
    polygon = bd.Wire.make_polygon([(0, 0, 0), (5, 0, 0), (5, 5, 0)])
    with pytest.raises(fb.FeatureBuilderError, match="require a single-edge path curve"):
        fb._circle_station_loft(polygon.wrapped, 1.0, "f")


def test_pattern_on_consumed_body_is_stale() -> None:
    _bd()
    bodies = [{"id": "body-1", "name": "Body 1"}, {"id": "body-2", "name": "Body 2"}]
    doc = _document(
        [
            _feature("pad1", "pad", {"length": 5.0}, "rect"),
            _feature("pad2", "pad", {"length": 5.0}, "rect", body="body-2"),
            _feature("cut", "booleanCut", {"targetBody": "body-1", "toolBodies": ["body-2"]}),
            {
                "id": "zpat",
                "type": "linearPattern",
                "body": "body-2",
                "params": {"source": "pad2", "count": 2, "spacing": 20.0},
                "dependsOn": ["cut"],
                "suppressed": False,
            },
        ],
        [_rect_sketch()],
        bodies=bodies,
    )
    by_id = _by_id(fb.build_document_shape(doc))
    assert by_id["zpat"]["status"] == "stale"


def test_pattern_unresolved_datum_reference_fails() -> None:
    top_ref, _shape = _build_base_and_capture_top_face(length=5.0)
    broken_ref = {"featureId": "base", "kind": "face", "fingerprint": {}}
    datums = [
        {"id": "dxy", "kind": "XY", "name": "XY"},
        {"id": "dface", "kind": "face", "name": "top", "reference": broken_ref},
    ]
    doc = _document(
        [
            _feature("base", "pad", {"length": 5.0}, "rect"),
            {
                "id": "pat",
                "type": "linearPattern",
                "body": "body-1",
                "params": {
                    "source": "base",
                    "count": 2,
                    "spacing": 20.0,
                    "axisDatumId": "dface",
                },
                "dependsOn": ["base"],
                "suppressed": False,
            },
        ],
        [_rect_sketch()],
        datums=datums,
    )
    by_id = _by_id(fb.build_document_shape(doc))
    assert by_id["pat"]["status"] == "failed"
    assert "unresolved topological references" in by_id["pat"]["error"]


def test_pattern_source_tool_unavailable_is_reported() -> None:
    bd = _bd()
    box = bd.Solid.make_box(10, 10, 10)
    pin = _feature("pin", "pad", {"length": 1.0})
    pat = {
        "id": "pat",
        "type": "linearPattern",
        "body": "body-1",
        "params": {"source": "pin", "count": 2, "spacing": 20.0},
    }
    state = _state(features=[pin, pat], accumulators={"body-1": box})
    fb._execute_feature(state, "pat")
    record = _by_id({"featureResults": state.feature_results})["pat"]
    assert "tool shape is unavailable" in record["error"]


def test_find_cycle_direct_guards() -> None:
    assert fb._find_cycle([{"id": "a", "dependsOn": ["missing"]}]) == ["a"]
    assert fb._find_cycle([]) == ["<unknown>"]


def test_selector_indices_for_tool() -> None:
    bd = _bd()
    box = bd.Solid.make_box(1, 1, 1)
    assert fb._selector_indices_for_tool(box, 0) == [1]
    assert fb._selector_indices_for_tool(None, 3) == []


def test_datum_dependency_ids_ignore_non_dicts() -> None:
    assert fb._datum_topology_dependency_ids(None) == []
    edges = fb._compute_implied_dependencies(
        [
            {"id": "pad", "type": "pad", "body": "body-1"},
            {
                "id": "bool",
                "type": "booleanFuse",
                "body": "body-1",
                "params": {"targetBody": "body-1", "toolBodies": [1, "body-2"]},
            },
        ],
        {},
        {},
    )
    assert ("bool", "pad") in edges


def test_shape_volume_numeric_attribute_is_used() -> None:
    _bd()
    assert fb._shape_volume(SimpleNamespace(volume=12.5)) == pytest.approx(12.5)


# ---------------------------------------------------------------------------
# Remaining cache/partial-build branches.
# ---------------------------------------------------------------------------


def test_restore_cached_feature_rejects_malformed_consumed_list() -> None:
    _bd()
    state = _state()
    entry = SimpleNamespace(
        brep_bytes=b"data", tool_bytes=None, meta={"target": "body-1", "consumed": "nope"}
    )
    cache = SimpleNamespace(lookup=lambda *_args: entry)
    feature = {
        "id": "bool",
        "type": "booleanFuse",
        "params": {"targetBody": "body-1"},
    }
    assert fb._restore_cached_feature(state, feature, cache, "k") is False


def test_write_back_feature_without_body_shape_returns_false() -> None:
    _bd()
    state = _state()
    state.feature_results.append({"featureId": "pad", "status": "built"})
    feature = {"id": "pad", "type": "pad", "body": "body-1"}
    cache = SimpleNamespace(store=lambda *_args, **_kwargs: None)
    assert fb._write_back_feature(state, feature, cache, "k") is False


def test_partial_build_clean_miss_executes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _bd()
    doc = _document([_feature("base", "pad", {"length": 5.0}, "rect")], [_rect_sketch()])
    monkeypatch.setattr(fb, "_content_keys_for_document", lambda _doc: {"base": "k"})

    class _MissCache:
        def lookup(self, *_args: Any) -> Any:
            return None

        def store(self, *_args: Any, **_kwargs: Any) -> None:
            pass

    result = fb.build_document_shape_partial(doc, [], cache=_MissCache())
    assert _by_id(result)["base"]["status"] == "built"


def test_partial_build_swallows_verdict_store_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _bd()
    doc = _document([_feature("base", "pad", {"length": 5.0}, "rect")], [_rect_sketch()])

    class _VerdictCache:
        def lookup(self, *_args: Any) -> Any:
            return None

        def store(self, *_args: Any, **_kwargs: Any) -> None:
            pass

        def store_overlap_verdicts(self, _verdicts: Any) -> None:
            raise RuntimeError("store verdicts")

    monkeypatch.setattr(fb, "_content_keys_for_document", lambda _doc: {"base": "k"})
    monkeypatch.setattr(
        fb,
        "_assemble_final_shape",
        lambda *_args, **_kwargs: {
            "featureResults": [],
            "referenceResults": [],
            "consumedBodies": [],
            "selectorMap": {},
            "solidBodyIds": [],
            "warnings": [],
            "overlapCache": {"a|b": {"a": "sa", "b": "sb", "volume": 1.0}},
        },
    )
    result = fb.build_document_shape_partial(doc, [], cache=_VerdictCache())
    assert "overlapCache" not in result


def test_import_tool_read_errors(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _bd()
    import exchange_reader as er

    source = tmp_path / "source.step"
    source.write_text("not really a step file", encoding="utf-8")
    params = {
        "sourcePath": str(source),
        "sourceHash": "a" * 64,
        "selection": {"mode": "all"},
    }
    feature = {"id": "imp", "type": "import"}

    def raising(exc: Exception) -> Any:
        def read(*_args: Any, **_kwargs: Any) -> Any:
            raise exc

        return read

    cases = [
        (er.ExchangeReadError("bad geometry"), "could not be read: bad geometry"),
        (ValueError("unknown unit"), "has invalid units: unknown unit"),
        (RuntimeError("reader crashed"), "could not be read: reader crashed"),
    ]
    for exc, match in cases:
        monkeypatch.setattr(er, "read_import_source", raising(exc))
        with pytest.raises(fb.FeatureBuilderError, match=match):
            fb._build_import_tool(feature, params, _state())

    monkeypatch.setattr(
        er,
        "read_import_source",
        lambda *_args, **_kwargs: SimpleNamespace(digest="a" * 64, solids=[]),
    )
    monkeypatch.setattr(er, "select_solids", lambda *_args, **_kwargs: [object()])
    with pytest.raises(fb.FeatureBuilderError, match="could not be assembled"):
        fb._build_import_tool(feature, params, _state())
