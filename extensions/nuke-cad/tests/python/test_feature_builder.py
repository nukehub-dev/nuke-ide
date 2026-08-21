#!/usr/bin/env python3
"""Tests for the nuke-cad feature builder.

Minimal-profile tests exercise the pure topological sort/error path.
Full-profile tests require build123d and verify solid modeling semantics.
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
import sys
from typing import Any

import feature_builder as fb
import pytest


def _rect_sketch(width: float = 40.0, height: float = 20.0) -> dict[str, Any]:
    return {
        "id": "rect",
        "name": "rectangle",
        "datumId": "dxy",
        "primitives": [
            {"id": "p1", "type": "point", "x": 0, "y": 0},
            {"id": "p2", "type": "point", "x": width, "y": 0},
            {"id": "p3", "type": "point", "x": width, "y": height},
            {"id": "p4", "type": "point", "x": 0, "y": height},
            {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
            {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
            {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
            {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
        ],
        "constraints": [],
    }


def _circle_sketch(x: float, y: float, radius: float, sid: str = "circle") -> dict[str, Any]:
    return {
        "id": sid,
        "name": sid,
        "datumId": "dxy",
        "primitives": [
            {"id": "c", "type": "point", "x": x, "y": y},
            {"id": "circ", "type": "circle", "c_id": "c", "radius": radius},
        ],
        "constraints": [],
    }


def _document(
    features: list[dict[str, Any]],
    sketches: list[dict[str, Any]] | None = None,
    bodies: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    body_list = bodies if bodies is not None else [{"id": "body-1", "name": "Body 1"}]
    body_ids = {b["id"] for b in body_list}

    def _default_body(feature: dict[str, Any]) -> str:
        if feature.get("type") in ("booleanFuse", "booleanCut", "booleanCommon"):
            params = feature.get("params", {})
            target = params.get("targetBody")
            if isinstance(target, str) and target in body_ids:
                return target
        return "body-1"

    features = [{**f, "body": f.get("body", _default_body(f))} for f in features]
    return {
        "version": 2,
        "name": "test",
        "parameters": {},
        "datums": [{"id": "dxy", "kind": "XY", "name": "XY"}],
        "bodies": body_list,
        "sketches": sketches if sketches is not None else [_rect_sketch()],
        "features": features,
    }


def test_topo_sort_chain() -> None:
    features = [
        {"id": "a", "dependsOn": []},
        {"id": "b", "dependsOn": ["a"]},
        {"id": "c", "dependsOn": ["b"]},
    ]
    order = fb.topo_sort_features(features)
    assert order == ["a", "b", "c"]


def test_topo_sort_diamond() -> None:
    features = [
        {"id": "a", "dependsOn": []},
        {"id": "b", "dependsOn": ["a"]},
        {"id": "c", "dependsOn": ["a"]},
        {"id": "d", "dependsOn": ["b", "c"]},
    ]
    order = fb.topo_sort_features(features)
    assert order.index("a") < order.index("b")
    assert order.index("a") < order.index("c")
    assert order.index("b") < order.index("d")
    assert order.index("c") < order.index("d")


def test_topo_sort_cycle_error() -> None:
    features = [
        {"id": "a", "dependsOn": ["c"]},
        {"id": "b", "dependsOn": ["a"]},
        {"id": "c", "dependsOn": ["b"]},
    ]
    with pytest.raises(fb.FeatureBuilderError, match="feature dependency cycle detected"):
        fb.topo_sort_features(features)


def test_unknown_dependency_error() -> None:
    features = [{"id": "a", "dependsOn": ["missing"]}]
    with pytest.raises(fb.FeatureBuilderError, match="unknown feature"):
        fb.topo_sort_features(features)


def test_build123d_absence_is_forced(monkeypatch: pytest.MonkeyPatch) -> None:
    """When build123d is unavailable, feature building raises a clear error."""
    monkeypatch.setitem(sys.modules, "build123d", None)
    monkeypatch.setattr(fb, "HAS_BUILD123D", False)
    monkeypatch.setattr(fb, "bd", None)
    doc = _document(
        [
            {
                "id": "f1",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
            }
        ]
    )
    with pytest.raises(fb.FeatureBuilderError, match="build123d is not available"):
        fb.build_document_shape(doc)


def test_pad_volume() -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            {
                "id": "f1",
                "name": "pad",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
            }
        ]
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    assert result["shape"].volume == pytest.approx(40.0 * 20.0 * 10.0, abs=1e-3)


def test_revolve_volume() -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    # Rectangle 1 x 1 in XY plane, y in [1, 2]; revolve around X axis -> torus-like.
    sketch = {
        "id": "rev",
        "name": "rev",
        "datumId": "dxy",
        "primitives": [
            {"id": "p1", "type": "point", "x": 0, "y": 1},
            {"id": "p2", "type": "point", "x": 1, "y": 1},
            {"id": "p3", "type": "point", "x": 1, "y": 2},
            {"id": "p4", "type": "point", "x": 0, "y": 2},
            {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
            {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
            {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
            {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
        ],
        "constraints": [],
    }
    doc = _document(
        [
            {
                "id": "f1",
                "name": "rev",
                "type": "revolve",
                "sketchId": "rev",
                "params": {"axis": "x", "angle": 360},
                "dependsOn": [],
                "suppressed": False,
            }
        ],
        sketches=[sketch],
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    expected = 2.0 * math.pi * 1.5 * 1.0
    assert result["shape"].volume == pytest.approx(expected, abs=1e-3)


def test_pocket_cuts_volume() -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "cut",
                "name": "cut",
                "type": "pocket",
                "sketchId": "hole",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
            },
        ],
        sketches=[_rect_sketch(), _circle_sketch(20, 10, 3, "hole")],
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    expected = 40.0 * 20.0 * 10.0 - math.pi * 9.0 * 10.0
    assert result["shape"].volume == pytest.approx(expected, abs=1e-3)


def test_pocket_without_body_fails_and_downstream_is_stale() -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            {
                "id": "bad",
                "name": "bad",
                "type": "pocket",
                "sketchId": "rect",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "next",
                "name": "next",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": 10},
                "dependsOn": ["bad"],
                "suppressed": False,
            },
        ]
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is None
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["bad"]["status"] == "failed"
    assert "existing solid body" in by_id["bad"]["error"].lower()
    assert by_id["next"]["status"] == "stale"


def test_labels_map_to_selector_indices() -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            {
                "id": "clad",
                "name": "clad",
                "type": "pad",
                "body": "body-clad",
                "sketchId": "rect",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "fuel",
                "name": "fuel",
                "type": "pad",
                "body": "body-fuel",
                "sketchId": "fuel",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
            },
        ],
        sketches=[_rect_sketch(), _circle_sketch(60, 10, 5, "fuel")],
        bodies=[
            {"id": "body-clad", "name": "clad", "label": "clad"},
            {"id": "body-fuel", "name": "fuel", "label": "fuel"},
        ],
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    assert len(result["shape"].solids()) == 2
    assert result["selectorMap"] == {"clad": [1], "fuel": [2]}


def test_suppressed_feature_is_stale() -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "skip",
                "name": "skip",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": True,
            },
            {
                "id": "next",
                "name": "next",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": 10},
                "dependsOn": ["skip"],
                "suppressed": False,
            },
        ]
    )
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["skip"]["status"] == "stale"
    assert by_id["next"]["status"] == "stale"


def test_overlapping_additive_pads_raise() -> None:
    """Two same-body additive pads that occupy the same space fail the second pad.

    Overlapping solids in one body would create duplicate-volume geometry, so the
    same-body combine check rejects them; the cross-body overlap gate separately
    handles overlaps between distinct bodies.
    """
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "overlap",
                "name": "overlap",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
            },
        ]
    )
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["base"]["status"] == "built"
    assert by_id["overlap"]["status"] == "failed"
    assert "overlap" in by_id["overlap"]["error"].lower()


def test_pocket_with_inner_wire_keeps_island() -> None:
    """A pocket sketch with an inner wire removes the inner region too."""
    pytest.importorskip("build123d", reason="build123d not installed")
    outer = _rect_sketch()
    inner = {
        "id": "island",
        "name": "island",
        "datumId": "dxy",
        "primitives": [
            {"id": "c", "type": "point", "x": 20, "y": 10},
            {"id": "circ", "type": "circle", "c_id": "c", "radius": 3.0},
        ],
        "constraints": [],
    }
    doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "pocket",
                "name": "pocket",
                "type": "pocket",
                "sketchId": "island",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
            },
        ],
        sketches=[outer, inner],
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    # The pocket removed the circular column, same as a pad with a hole.
    expected = 40.0 * 20.0 * 10.0 - math.pi * 9.0 * 10.0
    assert result["shape"].volume == pytest.approx(expected, abs=1e-3)


def test_revolve_axis_must_lie_in_sketch_plane() -> None:
    """A revolve axis not parallel to the sketch plane is rejected early."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            {
                "id": "f1",
                "name": "rev",
                "type": "revolve",
                "sketchId": "rect",
                "params": {"axis": "z", "angle": 360},
                "dependsOn": [],
                "suppressed": False,
            }
        ]
    )
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["f1"]["status"] == "failed"
    assert "must lie in the sketch plane" in by_id["f1"]["error"].lower()


def _face_ref(feature_id: str, topods_shape: Any, predicate: Any) -> dict[str, Any]:
    """Build a TopologyRef dict for the first face matching ``predicate``."""
    pytest.importorskip("build123d", reason="build123d not installed")
    import reference_resolver as rr

    faces = rr.extract_face_fingerprints(topods_shape)
    for face in faces:
        if predicate(face):
            return {"featureId": feature_id, "kind": "face", "fingerprint": face.to_dict()}
    raise AssertionError("no matching face found")


def _top_face_predicate() -> Any:
    """Return a predicate that selects the top (+Z) face of an extruded box."""
    import numpy as np

    def predicate(face: Any) -> bool:
        return (
            face.surface_type == "plane"
            and face.normal is not None
            and np.isclose(face.normal[2], 1.0)
        )

    return predicate


def _build_base_and_capture_top_face(length: float = 5.0) -> tuple[dict[str, Any], dict[str, Any]]:
    """Build a 10x10 extruded base pad and return ``(base_ref, base_doc)``."""
    base_doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": length},
                "dependsOn": [],
                "suppressed": False,
            }
        ],
        sketches=[_rect_sketch(width=10.0, height=10.0)],
    )
    base_result = fb.build_document_shape(base_doc)
    assert base_result["shape"] is not None
    top_ref = _face_ref("base", base_result["shape"].wrapped, _top_face_predicate())
    return top_ref, base_doc


def test_face_datum_sketch_builds_on_correct_plane() -> None:
    """A sketch placed on a referenced face builds on that face's workplane."""
    pytest.importorskip("build123d", reason="build123d not installed")
    top_ref, _base_doc = _build_base_and_capture_top_face(length=5.0)

    doc = {
        "version": 2,
        "name": "face-datum",
        "parameters": {},
        "datums": [
            {"id": "dxy", "kind": "XY", "name": "XY"},
            {"id": "face", "kind": "face", "name": "Top face", "reference": top_ref},
        ],
        "bodies": [{"id": "body-1", "name": "Body 1"}],
        "sketches": [
            _rect_sketch(width=10.0, height=10.0),
            {
                "id": "top",
                "name": "top",
                "datumId": "face",
                "primitives": [
                    {"id": "p1", "type": "point", "x": 0, "y": 0},
                    {"id": "p2", "type": "point", "x": 5, "y": 0},
                    {"id": "p3", "type": "point", "x": 5, "y": 5},
                    {"id": "p4", "type": "point", "x": 0, "y": 5},
                    {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
                    {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
                    {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
                    {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
                ],
                "constraints": [],
            },
        ],
        "features": [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "body": "body-1",
                "sketchId": "rect",
                "params": {"length": 5},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "top",
                "name": "top",
                "type": "pad",
                "body": "body-1",
                "sketchId": "top",
                "params": {"length": 2},
                "dependsOn": ["base"],
                "suppressed": False,
            },
        ],
    }
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    assert result["shape"].volume == pytest.approx(10.0 * 10.0 * 5.0 + 5.0 * 5.0 * 2.0, abs=1e-3)

    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["base"]["status"] == "built"
    assert by_id["top"]["status"] == "built"

    ref_results = [r for r in result["referenceResults"] if r["path"] == "datum.face.reference"]
    assert len(ref_results) == 1
    assert ref_results[0]["featureId"] == "top"
    assert ref_results[0]["status"] == "matched"
    assert ref_results[0]["candidateId"] is not None
    assert ref_results[0]["score"] > 0.9


def test_face_datum_offset_shifts_along_normal() -> None:
    """A face datum offset shifts the sketch plane along the face normal."""
    pytest.importorskip("build123d", reason="build123d not installed")
    top_ref, _base_doc = _build_base_and_capture_top_face(length=5.0)

    doc = {
        "version": 2,
        "name": "face-datum-offset",
        "parameters": {},
        "datums": [
            {"id": "dxy", "kind": "XY", "name": "XY"},
            {"id": "face", "kind": "face", "name": "Top face", "reference": top_ref, "offset": 3.0},
        ],
        "bodies": [{"id": "body-1", "name": "Body 1"}],
        "sketches": [
            _rect_sketch(width=10.0, height=10.0),
            {
                "id": "top",
                "name": "top",
                "datumId": "face",
                "primitives": [
                    {"id": "p1", "type": "point", "x": 0, "y": 0},
                    {"id": "p2", "type": "point", "x": 5, "y": 0},
                    {"id": "p3", "type": "point", "x": 5, "y": 5},
                    {"id": "p4", "type": "point", "x": 0, "y": 5},
                    {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
                    {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
                    {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
                    {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
                ],
                "constraints": [],
            },
        ],
        "features": [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "body": "body-1",
                "sketchId": "rect",
                "params": {"length": 5},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "top",
                "name": "top",
                "type": "pad",
                "body": "body-1",
                "sketchId": "top",
                "params": {"length": 2},
                "dependsOn": ["base"],
                "suppressed": False,
            },
        ],
    }
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    assert result["shape"].volume == pytest.approx(10.0 * 10.0 * 5.0 + 5.0 * 5.0 * 2.0, abs=1e-3)

    solids = result["shape"].solids()
    top_solid = max(solids, key=lambda s: s.bounding_box().max.Z)
    assert top_solid.bounding_box().min.Z == pytest.approx(8.0, abs=1e-3)
    assert top_solid.bounding_box().max.Z == pytest.approx(10.0, abs=1e-3)


def test_non_planar_face_datum_fails_clearly() -> None:
    """A face datum referencing a non-planar face reports a clear error."""
    pytest.importorskip("build123d", reason="build123d not installed")
    # Revolve a rectangle around Y to create a cylinder; the side face is curved.
    sketch = {
        "id": "profile",
        "name": "profile",
        "datumId": "dxy",
        "primitives": [
            {"id": "p1", "type": "point", "x": 2, "y": 0},
            {"id": "p2", "type": "point", "x": 3, "y": 0},
            {"id": "p3", "type": "point", "x": 3, "y": 5},
            {"id": "p4", "type": "point", "x": 2, "y": 5},
            {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
            {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
            {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
            {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
        ],
        "constraints": [],
    }
    base_doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "revolve",
                "sketchId": "profile",
                "params": {"axis": "y", "angle": 360},
                "dependsOn": [],
                "suppressed": False,
            }
        ],
        sketches=[sketch],
    )
    base_result = fb.build_document_shape(base_doc)
    assert base_result["shape"] is not None

    import numpy as np

    def side_face(face: Any) -> bool:
        return (
            face.surface_type == "cylinder"
            and face.radius is not None
            and np.isclose(face.radius, 3.0, rtol=0.05)
        )

    side_ref = _face_ref("base", base_result["shape"].wrapped, side_face)

    doc = {
        "version": 2,
        "name": "non-planar",
        "parameters": {},
        "datums": [
            {"id": "dxy", "kind": "XY", "name": "XY"},
            {"id": "face", "kind": "face", "name": "Side face", "reference": side_ref},
        ],
        "bodies": [{"id": "body-1", "name": "Body 1"}],
        "sketches": [
            sketch,
            {
                "id": "on_side",
                "name": "on_side",
                "datumId": "face",
                "primitives": [
                    {"id": "p1", "type": "point", "x": 0, "y": 0},
                    {"id": "p2", "type": "point", "x": 1, "y": 0},
                    {"id": "p3", "type": "point", "x": 1, "y": 1},
                    {"id": "p4", "type": "point", "x": 0, "y": 1},
                    {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
                    {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
                    {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
                    {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
                ],
                "constraints": [],
            },
        ],
        "features": [
            {
                "id": "base",
                "name": "base",
                "type": "revolve",
                "body": "body-1",
                "sketchId": "profile",
                "params": {"axis": "y", "angle": 360},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "on_side",
                "name": "on_side",
                "type": "pad",
                "body": "body-1",
                "sketchId": "on_side",
                "params": {"length": 1},
                "dependsOn": ["base"],
                "suppressed": False,
            },
        ],
    }
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["on_side"]["status"] == "failed"
    assert "not planar" in by_id["on_side"]["error"].lower()

    ref_results = [r for r in result["referenceResults"] if r["path"] == "datum.face.reference"]
    assert len(ref_results) == 1
    assert ref_results[0]["status"] == "matched"


def test_fingerprint_survives_pad_length_change() -> None:
    """A face reference remains matched after the upstream pad length changes."""
    pytest.importorskip("build123d", reason="build123d not installed")
    top_ref, _base_doc = _build_base_and_capture_top_face(length=5.0)

    def build_with_length(length: float) -> dict[str, Any]:
        doc = {
            "version": 2,
            "name": "survive",
            "parameters": {},
            "datums": [
                {"id": "dxy", "kind": "XY", "name": "XY"},
                {"id": "face", "kind": "face", "name": "Top face", "reference": top_ref},
            ],
            "bodies": [{"id": "body-1", "name": "Body 1"}],
            "sketches": [
                _rect_sketch(width=10.0, height=10.0),
                {
                    "id": "top",
                    "name": "top",
                    "datumId": "face",
                    "primitives": [
                        {"id": "p1", "type": "point", "x": 0, "y": 0},
                        {"id": "p2", "type": "point", "x": 5, "y": 0},
                        {"id": "p3", "type": "point", "x": 5, "y": 5},
                        {"id": "p4", "type": "point", "x": 0, "y": 5},
                        {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
                        {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
                        {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
                        {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
                    ],
                    "constraints": [],
                },
            ],
            "features": [
                {
                    "id": "base",
                    "name": "base",
                    "type": "pad",
                    "body": "body-1",
                    "sketchId": "rect",
                    "params": {"length": length},
                    "dependsOn": [],
                    "suppressed": False,
                },
                {
                    "id": "top",
                    "name": "top",
                    "type": "pad",
                    "body": "body-1",
                    "sketchId": "top",
                    "params": {"length": 2},
                    "dependsOn": ["base"],
                    "suppressed": False,
                },
            ],
        }
        return fb.build_document_shape(doc)

    first = build_with_length(5.0)
    assert first["shape"] is not None
    assert all(r["status"] == "built" for r in first["featureResults"])
    first_ref = [r for r in first["referenceResults"] if r["path"] == "datum.face.reference"][0]
    assert first_ref["status"] == "matched"

    second = build_with_length(8.0)
    assert second["shape"] is not None
    assert all(r["status"] == "built" for r in second["featureResults"])
    second_ref = [r for r in second["referenceResults"] if r["path"] == "datum.face.reference"][0]
    assert second_ref["status"] == "matched"
    assert second_ref["candidateId"] is not None

    # The top pad has shifted up with the new base length.
    solids = second["shape"].solids()
    top_solid = max(solids, key=lambda s: s.bounding_box().max.Z)
    assert top_solid.bounding_box().min.Z == pytest.approx(8.0, abs=1e-3)


def test_fingerprint_survives_sibling_feature_addition() -> None:
    """Adding another feature that depends on the same predecessor does not break a face ref."""
    pytest.importorskip("build123d", reason="build123d not installed")
    top_ref, _base_doc = _build_base_and_capture_top_face(length=5.0)

    doc = {
        "version": 2,
        "name": "sibling",
        "parameters": {},
        "datums": [
            {"id": "dxy", "kind": "XY", "name": "XY"},
            {"id": "face", "kind": "face", "name": "Top face", "reference": top_ref},
            {"id": "offset", "kind": "offset", "name": "Offset", "offset": 10.0},
        ],
        "bodies": [{"id": "body-1", "name": "Body 1"}],
        "sketches": [
            _rect_sketch(width=10.0, height=10.0),
            {
                "id": "top",
                "name": "top",
                "datumId": "face",
                "primitives": [
                    {"id": "p1", "type": "point", "x": 0, "y": 0},
                    {"id": "p2", "type": "point", "x": 5, "y": 0},
                    {"id": "p3", "type": "point", "x": 5, "y": 5},
                    {"id": "p4", "type": "point", "x": 0, "y": 5},
                    {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
                    {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
                    {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
                    {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
                ],
                "constraints": [],
            },
            _rect_sketch(width=10.0, height=10.0),
        ],
        "features": [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "body": "body-1",
                "sketchId": "rect",
                "params": {"length": 5},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "sibling",
                "name": "sibling",
                "type": "pad",
                "body": "body-1",
                "sketchId": "rect2",
                "params": {"length": 2},
                "dependsOn": ["base"],
                "suppressed": False,
            },
            {
                "id": "top",
                "name": "top",
                "type": "pad",
                "body": "body-1",
                "sketchId": "top",
                "params": {"length": 2},
                "dependsOn": ["base"],
                "suppressed": False,
            },
        ],
    }
    # The sibling sketch is the third sketch; rename it to "rect2" and place it
    # on the offset datum so it stacks above the base instead of overlapping it
    # (same-body additive overlaps are rejected by the combine check).
    doc["sketches"][2]["id"] = "rect2"
    doc["sketches"][2]["name"] = "rect2"
    doc["sketches"][2]["datumId"] = "offset"

    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["sibling"]["status"] == "built"
    assert by_id["top"]["status"] == "built"

    ref_results = [r for r in result["referenceResults"] if r["path"] == "datum.face.reference"]
    assert len(ref_results) == 1
    assert ref_results[0]["status"] == "matched"


def test_ambiguous_reference_reported_on_symmetric_edit() -> None:
    """A symmetric edit that creates two equally-good candidates is reported ambiguous."""
    pytest.importorskip("build123d", reason="build123d not installed")
    import numpy as np
    import reference_resolver as rr

    # Two tiny rectangles at x = +/-0.1 produce two solids whose top faces are
    # almost identical; referencing one should be ambiguous.
    tiny_sketch = {
        "id": "tiny",
        "name": "tiny",
        "datumId": "dxy",
        "primitives": [
            {"id": "pa", "type": "point", "x": 0.075, "y": -0.025},
            {"id": "pb", "type": "point", "x": 0.125, "y": -0.025},
            {"id": "pc", "type": "point", "x": 0.125, "y": 0.025},
            {"id": "pd", "type": "point", "x": 0.075, "y": 0.025},
            {"id": "la1", "type": "line", "p1_id": "pa", "p2_id": "pb"},
            {"id": "la2", "type": "line", "p1_id": "pb", "p2_id": "pc"},
            {"id": "la3", "type": "line", "p1_id": "pc", "p2_id": "pd"},
            {"id": "la4", "type": "line", "p1_id": "pd", "p2_id": "pa"},
            {"id": "qa", "type": "point", "x": -0.125, "y": -0.025},
            {"id": "qb", "type": "point", "x": -0.075, "y": -0.025},
            {"id": "qc", "type": "point", "x": -0.075, "y": 0.025},
            {"id": "qd", "type": "point", "x": -0.125, "y": 0.025},
            {"id": "lb1", "type": "line", "p1_id": "qa", "p2_id": "qb"},
            {"id": "lb2", "type": "line", "p1_id": "qb", "p2_id": "qc"},
            {"id": "lb3", "type": "line", "p1_id": "qc", "p2_id": "qd"},
            {"id": "lb4", "type": "line", "p1_id": "qd", "p2_id": "qa"},
        ],
        "constraints": [],
    }
    base_doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "sketchId": "tiny",
                "params": {"length": 5},
                "dependsOn": [],
                "suppressed": False,
            }
        ],
        sketches=[tiny_sketch],
    )
    base_result = fb.build_document_shape(base_doc)
    assert base_result["shape"] is not None

    faces = rr.extract_face_fingerprints(base_result["shape"].wrapped)
    right_faces = [
        f
        for f in faces
        if f.surface_type == "plane"
        and f.normal is not None
        and np.isclose(f.normal[2], 1.0)
        and f.center[0] > 0.0
    ]
    assert len(right_faces) == 1
    top_ref = {"featureId": "base", "kind": "face", "fingerprint": right_faces[0].to_dict()}

    doc = {
        "version": 2,
        "name": "ambiguous",
        "parameters": {},
        "datums": [
            {"id": "dxy", "kind": "XY", "name": "XY"},
            {"id": "face", "kind": "face", "name": "Top face", "reference": top_ref},
        ],
        "bodies": [{"id": "body-1", "name": "Body 1"}],
        "sketches": [
            tiny_sketch,
            {
                "id": "top",
                "name": "top",
                "datumId": "face",
                "primitives": [
                    {"id": "p1", "type": "point", "x": 0, "y": 0},
                    {"id": "p2", "type": "point", "x": 0.05, "y": 0},
                    {"id": "p3", "type": "point", "x": 0.05, "y": 0.05},
                    {"id": "p4", "type": "point", "x": 0, "y": 0.05},
                    {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
                    {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
                    {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
                    {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
                ],
                "constraints": [],
            },
        ],
        "features": [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "body": "body-1",
                "sketchId": "tiny",
                "params": {"length": 5},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "top",
                "name": "top",
                "type": "pad",
                "body": "body-1",
                "sketchId": "top",
                "params": {"length": 1},
                "dependsOn": ["base"],
                "suppressed": False,
            },
        ],
    }
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["top"]["status"] == "failed"
    assert "ambiguous" in by_id["top"]["error"].lower()

    ref_results = [r for r in result["referenceResults"] if r["path"] == "datum.face.reference"]
    assert len(ref_results) == 1
    assert ref_results[0]["status"] == "ambiguous"
    assert ref_results[0]["candidates"] is not None
    assert len(ref_results[0]["candidates"]) >= 2


def test_edge_reference_symmetric_edit_is_ambiguous() -> None:
    """A dress-up edge ref with two equally-good candidates fails as ambiguous.

    Edge references are the stress test for the fingerprint resolver: a fillet
    referencing a vertical edge of one of two mirrored solids must NOT silently
    pick the wrong one — it must report ``ambiguous`` and fail the feature.
    """
    pytest.importorskip("build123d", reason="build123d not installed")
    import reference_resolver as rr

    # Same mirrored tiny rectangles as the face ambiguity test above.
    tiny_sketch = {
        "id": "tiny",
        "name": "tiny",
        "datumId": "dxy",
        "primitives": [
            {"id": "pa", "type": "point", "x": 0.075, "y": -0.025},
            {"id": "pb", "type": "point", "x": 0.125, "y": -0.025},
            {"id": "pc", "type": "point", "x": 0.125, "y": 0.025},
            {"id": "pd", "type": "point", "x": 0.075, "y": 0.025},
            {"id": "la1", "type": "line", "p1_id": "pa", "p2_id": "pb"},
            {"id": "la2", "type": "line", "p1_id": "pb", "p2_id": "pc"},
            {"id": "la3", "type": "line", "p1_id": "pc", "p2_id": "pd"},
            {"id": "la4", "type": "line", "p1_id": "pd", "p2_id": "pa"},
            {"id": "qa", "type": "point", "x": -0.125, "y": -0.025},
            {"id": "qb", "type": "point", "x": -0.075, "y": -0.025},
            {"id": "qc", "type": "point", "x": -0.075, "y": 0.025},
            {"id": "qd", "type": "point", "x": -0.125, "y": 0.025},
            {"id": "lb1", "type": "line", "p1_id": "qa", "p2_id": "qb"},
            {"id": "lb2", "type": "line", "p1_id": "qb", "p2_id": "qc"},
            {"id": "lb3", "type": "line", "p1_id": "qc", "p2_id": "qd"},
            {"id": "lb4", "type": "line", "p1_id": "qd", "p2_id": "qa"},
        ],
        "constraints": [],
    }
    base_doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "sketchId": "tiny",
                "params": {"length": 5},
                "dependsOn": [],
                "suppressed": False,
            }
        ],
        sketches=[tiny_sketch],
    )
    base_result = fb.build_document_shape(base_doc)
    assert base_result["shape"] is not None

    # Capture a vertical edge of the right-hand solid (midpoint x > 0). Its
    # mirror on the left-hand solid is an equally-good fingerprint candidate.
    # (Line edges carry no ``center`` — that field is for circular edges.)
    edges = rr.extract_edge_fingerprints(base_result["shape"].wrapped)
    vertical = [
        e
        for e in edges
        if e.curve_type == "line"
        and abs(e.length - 5.0) < 1e-6
        and (e.start[0] + e.end[0]) / 2 > 0.0
        and abs((e.start[2] + e.end[2]) / 2 - 2.5) < 1e-6
    ]
    assert len(vertical) == 4
    edge_ref = {"featureId": "base", "kind": "edge", "fingerprint": vertical[0].to_dict()}

    doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "sketchId": "tiny",
                "params": {"length": 5},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "fillet1",
                "name": "fillet1",
                "type": "fillet",
                "params": {"edges": [edge_ref], "radius": 0.005},
                "dependsOn": ["base"],
                "suppressed": False,
            },
        ],
        sketches=[tiny_sketch],
    )
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["base"]["status"] == "built"
    assert by_id["fillet1"]["status"] == "failed"
    assert "ambiguous" in by_id["fillet1"]["error"].lower()

    ref_results = [
        r for r in result["referenceResults"] if r["path"] == "feature.fillet1.params.edges[0]"
    ]
    assert len(ref_results) == 1
    assert ref_results[0]["status"] == "ambiguous"
    assert ref_results[0]["candidates"] is not None
    assert len(ref_results[0]["candidates"]) >= 2


def test_unmatched_reference_clear_error() -> None:
    """A reference whose fingerprint no longer exists on the predecessor fails cleanly."""
    pytest.importorskip("build123d", reason="build123d not installed")
    # Reference a cylindrical face that can never exist on a box extrusion.
    top_ref = {
        "featureId": "base",
        "kind": "face",
        "fingerprint": {
            "surfaceType": "cylinder",
            "area": 1000.0,
            "center": [500.0, 500.0, 500.0],
            "radius": 10.0,
        },
    }

    doc = {
        "version": 2,
        "name": "unmatched",
        "parameters": {},
        "datums": [
            {"id": "dxy", "kind": "XY", "name": "XY"},
            {"id": "face", "kind": "face", "name": "Top face", "reference": top_ref},
        ],
        "bodies": [{"id": "body-1", "name": "Body 1"}],
        "sketches": [
            _rect_sketch(width=1.0, height=1.0),
            {
                "id": "top",
                "name": "top",
                "datumId": "face",
                "primitives": [
                    {"id": "p1", "type": "point", "x": 0, "y": 0},
                    {"id": "p2", "type": "point", "x": 1, "y": 0},
                    {"id": "p3", "type": "point", "x": 1, "y": 1},
                    {"id": "p4", "type": "point", "x": 0, "y": 1},
                    {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
                    {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
                    {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
                    {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
                ],
                "constraints": [],
            },
        ],
        "features": [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "body": "body-1",
                "sketchId": "rect",
                "params": {"length": 1},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "top",
                "name": "top",
                "type": "pad",
                "body": "body-1",
                "sketchId": "top",
                "params": {"length": 1},
                "dependsOn": ["base"],
                "suppressed": False,
            },
        ],
    }
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["top"]["status"] == "failed"
    assert "unmatched" in by_id["top"]["error"].lower()

    ref_results = [r for r in result["referenceResults"] if r["path"] == "datum.face.reference"]
    assert len(ref_results) == 1
    assert ref_results[0]["status"] == "unmatched"
    assert ref_results[0]["candidateId"] is None


def test_external_geometry_projection_correctness() -> None:
    """External edge references project into the sketch plane as construction geometry."""
    pytest.importorskip("build123d", reason="build123d not installed")
    import build123d as bd

    # Create a horizontal edge at z = 5 and project it onto the XY plane.
    edge = bd.Line((0.0, 0.0, 5.0), (10.0, 0.0, 5.0))
    plane = bd.Plane.XY
    primitives = fb._project_edge_to_sketch(edge.wrapped, plane, 0)
    assert len(primitives) == 3
    assert all(p.get("construction") is True for p in primitives)
    line = [p for p in primitives if p.get("type") == "line"][0]
    p1 = [p for p in primitives if p.get("id") == line["p1_id"]][0]
    p2 = [p for p in primitives if p.get("id") == line["p2_id"]][0]
    assert p1["x"] == pytest.approx(0.0, abs=1e-6)
    assert p1["y"] == pytest.approx(0.0, abs=1e-6)
    assert p2["x"] == pytest.approx(10.0, abs=1e-6)
    assert p2["y"] == pytest.approx(0.0, abs=1e-6)

    # A circle parallel to the sketch plane projects to a construction circle.
    circle_edge = bd.Circle(2.0).edge()
    # Move the circle to a plane parallel to XY at z = 3.
    circle_edge = bd.Location((5.0, 5.0, 3.0)) * circle_edge
    circ_primitives = fb._project_edge_to_sketch(circle_edge.wrapped, plane, 1)
    assert any(p.get("type") == "circle" for p in circ_primitives)
    circle = [p for p in circ_primitives if p.get("type") == "circle"][0]
    assert circle["radius"] == pytest.approx(2.0, abs=1e-6)
    center = [p for p in circ_primitives if p.get("id") == circle["c_id"]][0]
    assert center["x"] == pytest.approx(5.0, abs=1e-6)
    assert center["y"] == pytest.approx(5.0, abs=1e-6)

    # Construction-only extra primitives do not become sketch output edges.
    sketch = {
        "id": "only_external",
        "name": "only_external",
        "datumId": "dxy",
        "primitives": circ_primitives,
        "constraints": [],
    }
    from sketch_builder import SketchError, build_sketch_faces

    with pytest.raises(SketchError, match="no drawable edges"):
        build_sketch_faces(sketch, {"dxy": {"id": "dxy", "kind": "XY", "name": "XY"}})


def test_topology_refs_collected_for_face_datum_and_external_refs() -> None:
    """``_collect_topology_refs`` gathers face datums and sketch externalRefs."""
    datums = {
        "dxy": {"id": "dxy", "kind": "XY", "name": "XY"},
        "face": {"id": "face", "kind": "face", "name": "Face", "reference": {"featureId": "base"}},
    }
    sketches = {
        "sk": {
            "id": "sk",
            "name": "sk",
            "datumId": "face",
            "externalRefs": [
                {"featureId": "base", "kind": "edge"},
                {"featureId": "base", "kind": "face"},
            ],
            "primitives": [],
            "constraints": [],
        }
    }
    feature = {"id": "f1", "sketchId": "sk", "params": {"length": 1}}
    refs = fb._collect_topology_refs(feature, datums, sketches)
    paths = {path for path, _ref in refs}
    assert "datum.face.reference" in paths
    assert "sketch.sk.externalRefs[0]" in paths
    assert "sketch.sk.externalRefs[1]" in paths


def test_unresolved_reference_raises_when_resolver_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the resolver is unavailable, resolving a TopologyRef raises a clear error."""
    monkeypatch.setattr(fb, "HAS_REFERENCE_RESOLVER", False)
    monkeypatch.setattr(fb, "rr", None)
    refs_with_paths = [
        (
            "datum.face.reference",
            {
                "featureId": "base",
                "kind": "face",
                "fingerprint": {"surfaceType": "plane", "area": 1, "center": [0, 0, 0]},
            },
        )
    ]
    with pytest.raises(fb.FeatureBuilderError, match="reference resolution requires OCP"):
        fb._resolve_document_refs(refs_with_paths, {}, owner_feature_id="top")


def test_multi_body_touching_compound_has_distinct_solids() -> None:
    """Separate bodies that merely touch stay distinct solids in the final compound."""
    pytest.importorskip("build123d", reason="build123d not installed")
    left = _rect_sketch(width=10.0, height=10.0)
    left["id"] = "left_rect"
    right = {
        "id": "right_rect",
        "name": "right_rect",
        "datumId": "dxy",
        "primitives": [
            {"id": "p1", "type": "point", "x": 10, "y": 0},
            {"id": "p2", "type": "point", "x": 20, "y": 0},
            {"id": "p3", "type": "point", "x": 20, "y": 10},
            {"id": "p4", "type": "point", "x": 10, "y": 10},
            {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
            {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
            {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
            {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
        ],
        "constraints": [],
    }
    doc = _document(
        [
            {
                "id": "left",
                "name": "left",
                "type": "pad",
                "body": "body-left",
                "sketchId": "left_rect",
                "params": {"length": 5},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "right",
                "name": "right",
                "type": "pad",
                "body": "body-right",
                "sketchId": "right_rect",
                "params": {"length": 5},
                "dependsOn": [],
                "suppressed": False,
            },
        ],
        sketches=[left, right],
        bodies=[
            {"id": "body-left", "name": "left", "label": "left"},
            {"id": "body-right", "name": "right", "label": "right"},
        ],
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    assert len(result["shape"].solids()) == 2
    assert result["selectorMap"] == {"left": [1], "right": [2]}


def test_boolean_fuse_unites_touching_bodies() -> None:
    """A boolean fuse of two touching bodies produces a single fused solid."""
    pytest.importorskip("build123d", reason="build123d not installed")
    left = _rect_sketch(width=10.0, height=10.0)
    left["id"] = "left_rect"
    right = {
        "id": "right_rect",
        "name": "right_rect",
        "datumId": "dxy",
        "primitives": [
            {"id": "p1", "type": "point", "x": 10, "y": 0},
            {"id": "p2", "type": "point", "x": 20, "y": 0},
            {"id": "p3", "type": "point", "x": 20, "y": 10},
            {"id": "p4", "type": "point", "x": 10, "y": 10},
            {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
            {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
            {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
            {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
        ],
        "constraints": [],
    }
    doc = _document(
        [
            {
                "id": "left",
                "name": "left",
                "type": "pad",
                "body": "body-left",
                "sketchId": "left_rect",
                "params": {"length": 5},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "right",
                "name": "right",
                "type": "pad",
                "body": "body-right",
                "sketchId": "right_rect",
                "params": {"length": 5},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "fuse",
                "name": "fuse",
                "type": "booleanFuse",
                "body": "body-left",
                "params": {"targetBody": "body-left", "toolBodies": ["body-right"]},
                "dependsOn": ["left", "right"],
                "suppressed": False,
            },
        ],
        sketches=[left, right],
        bodies=[
            {"id": "body-left", "name": "left", "label": "merged"},
            {"id": "body-right", "name": "right"},
        ],
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    # The tool body is consumed, so the final compound has one fused solid.
    assert len(result["shape"].solids()) == 1
    assert result["shape"].volume == pytest.approx(20.0 * 10.0 * 5.0, abs=1e-3)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["fuse"]["consumedBodyIds"] == ["body-right"]
    assert result["selectorMap"].get("merged") == [1]


def test_boolean_cut_removes_tool_volume() -> None:
    """A boolean cut subtracts the tool body volume from the target."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "body": "body-base",
                "sketchId": "rect",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "tool",
                "name": "tool",
                "type": "pad",
                "body": "body-tool",
                "sketchId": "hole",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "cut",
                "name": "cut",
                "type": "booleanCut",
                "body": "body-base",
                "params": {"targetBody": "body-base", "toolBodies": ["body-tool"]},
                "dependsOn": ["base", "tool"],
                "suppressed": False,
            },
        ],
        sketches=[_rect_sketch(width=40.0, height=20.0), _circle_sketch(20, 10, 3, "hole")],
        bodies=[
            {"id": "body-base", "name": "base"},
            {"id": "body-tool", "name": "tool"},
        ],
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    expected = 40.0 * 20.0 * 10.0 - math.pi * 9.0 * 10.0
    assert result["shape"].volume == pytest.approx(expected, abs=1e-3)


def test_boolean_common_returns_intersection_volume() -> None:
    """A boolean common keeps only the intersection of target and tool."""
    pytest.importorskip("build123d", reason="build123d not installed")
    # Two identical pads occupying the same space.
    doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "body": "body-base",
                "sketchId": "rect",
                "params": {"length": 5},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "tool",
                "name": "tool",
                "type": "pad",
                "body": "body-tool",
                "sketchId": "rect",
                "params": {"length": 5},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "common",
                "name": "common",
                "type": "booleanCommon",
                "body": "body-base",
                "params": {"targetBody": "body-base", "toolBodies": ["body-tool"]},
                "dependsOn": ["base", "tool"],
                "suppressed": False,
            },
        ],
        sketches=[_rect_sketch(width=10.0, height=10.0)],
        bodies=[
            {"id": "body-base", "name": "base"},
            {"id": "body-tool", "name": "tool"},
        ],
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    assert result["shape"].volume == pytest.approx(10.0 * 10.0 * 5.0, abs=1e-3)


def test_keep_tools_preserves_tool_body_in_final_compound() -> None:
    """With keepTools=true the tool body remains in the final compound."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "body": "body-base",
                "sketchId": "rect",
                "params": {"length": 5},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "tool",
                "name": "tool",
                "type": "pad",
                "body": "body-tool",
                "sketchId": "rect",
                "params": {"length": 5},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "cut",
                "name": "cut",
                "type": "booleanCut",
                "body": "body-base",
                "params": {
                    "targetBody": "body-base",
                    "toolBodies": ["body-tool"],
                    "keepTools": True,
                },
                "dependsOn": ["base", "tool"],
                "suppressed": False,
            },
        ],
        sketches=[_rect_sketch(width=10.0, height=10.0)],
        bodies=[
            {"id": "body-base", "name": "base"},
            {"id": "body-tool", "name": "tool"},
        ],
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    # Identical target and tool: cut leaves nothing, but tool is kept.
    assert len(result["shape"].solids()) == 1
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["cut"].get("consumedBodyIds") == []


def test_cross_body_overlap_without_boolean_raises() -> None:
    """Two overlapping bodies that are not merged by a boolean raise FeatureBuilderError."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            {
                "id": "left",
                "name": "left",
                "type": "pad",
                "body": "body-left",
                "sketchId": "rect",
                "params": {"length": 5},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "right",
                "name": "right",
                "type": "pad",
                "body": "body-right",
                "sketchId": "rect",
                "params": {"length": 5},
                "dependsOn": [],
                "suppressed": False,
            },
        ],
        sketches=[_rect_sketch(width=10.0, height=10.0)],
        bodies=[
            {"id": "body-left", "name": "left"},
            {"id": "body-right", "name": "right"},
        ],
    )
    with pytest.raises(fb.FeatureBuilderError, match="overlap"):
        fb.build_document_shape(doc)


def test_reference_resolves_against_body_state_after_pocket() -> None:
    """A face reference on a body resolves against the post-pocket body state."""
    pytest.importorskip("build123d", reason="build123d not installed")
    base_doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "body": "body-base",
                "sketchId": "rect",
                "params": {"length": 5},
                "dependsOn": [],
                "suppressed": False,
            }
        ],
        sketches=[_rect_sketch(width=10.0, height=10.0)],
        bodies=[{"id": "body-base", "name": "base"}],
    )
    base_result = fb.build_document_shape(base_doc)
    assert base_result["shape"] is not None
    top_ref = _face_ref("base", base_result["shape"].wrapped, _top_face_predicate())

    doc = {
        "version": 2,
        "name": "pocketed-ref",
        "parameters": {},
        "datums": [
            {"id": "dxy", "kind": "XY", "name": "XY"},
            {"id": "face", "kind": "face", "name": "Top face", "reference": top_ref},
        ],
        "bodies": [
            {"id": "body-base", "name": "base"},
        ],
        "sketches": [
            _rect_sketch(width=10.0, height=10.0),
            {
                "id": "top",
                "name": "top",
                "datumId": "face",
                "primitives": [
                    {"id": "p1", "type": "point", "x": 0, "y": 0},
                    {"id": "p2", "type": "point", "x": 5, "y": 0},
                    {"id": "p3", "type": "point", "x": 5, "y": 5},
                    {"id": "p4", "type": "point", "x": 0, "y": 5},
                    {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
                    {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
                    {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
                    {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
                ],
                "constraints": [],
            },
            _circle_sketch(5, 5, 2, "hole"),
        ],
        "features": [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "body": "body-base",
                "sketchId": "rect",
                "params": {"length": 5},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "pocket",
                "name": "pocket",
                "type": "pocket",
                "body": "body-base",
                "sketchId": "hole",
                "params": {"length": 5},
                "dependsOn": ["base"],
                "suppressed": False,
            },
            {
                "id": "top",
                "name": "top",
                "type": "pad",
                "body": "body-base",
                "sketchId": "top",
                "params": {"length": 2},
                "dependsOn": ["pocket"],
                "suppressed": False,
            },
        ],
    }
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["top"]["status"] == "built"

    ref_results = [r for r in result["referenceResults"] if r["path"] == "datum.face.reference"]
    assert len(ref_results) == 1
    assert ref_results[0]["featureId"] == "top"
    assert ref_results[0]["status"] == "matched"


def _edge_ref(feature_id: str, topods_shape: Any, predicate: Any) -> dict[str, Any]:
    """Build a TopologyRef dict for the first edge matching ``predicate``."""
    pytest.importorskip("build123d", reason="build123d not installed")
    import reference_resolver as rr

    edges = rr.extract_edge_fingerprints(topods_shape)
    for edge in edges:
        if predicate(edge):
            return {"featureId": feature_id, "kind": "edge", "fingerprint": edge.to_dict()}
    raise AssertionError("no matching edge found")


def _vertical_edge_predicate() -> Any:
    """Return a predicate that selects a vertical edge of an extruded box."""
    import numpy as np

    def predicate(edge: Any) -> bool:
        if edge.curve_type != "line" or edge.start is None or edge.end is None:
            return False
        direction = np.array(edge.end) - np.array(edge.start)
        length = np.linalg.norm(direction)
        if length == 0:
            return False
        direction = direction / length
        return np.isclose(abs(direction[2]), 1.0)

    return predicate


def _build_base_box(
    width: float = 10.0, height: float = 10.0, length: float = 10.0
) -> tuple[Any, dict[str, Any]]:
    """Build a box pad and return ``(result, doc)``."""
    doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "body": "body-1",
                "sketchId": "rect",
                "params": {"length": length},
                "dependsOn": [],
                "suppressed": False,
            }
        ],
        sketches=[_rect_sketch(width=width, height=height)],
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    return result, doc


def test_fillet_reduces_volume_and_keeps_one_solid() -> None:
    """A fillet on a box edge rounds the corner and reduces volume."""
    pytest.importorskip("build123d", reason="build123d not installed")
    base_result, _ = _build_base_box()
    edge_ref = _edge_ref("base", base_result["shape"].wrapped, _vertical_edge_predicate())

    doc = {
        "version": 2,
        "name": "fillet",
        "parameters": {},
        "datums": [{"id": "dxy", "kind": "XY", "name": "XY"}],
        "bodies": [{"id": "body-1", "name": "Body 1"}],
        "sketches": [_rect_sketch(width=10.0, height=10.0)],
        "features": [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "body": "body-1",
                "sketchId": "rect",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "fillet",
                "name": "fillet",
                "type": "fillet",
                "body": "body-1",
                "params": {"edges": [edge_ref], "radius": 1},
                "dependsOn": ["base"],
                "suppressed": False,
            },
        ],
    }
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    assert len(result["shape"].solids()) == 1
    assert result["shape"].volume < 10.0 * 10.0 * 10.0
    assert result["shape"].volume > 0.0
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["fillet"]["status"] == "built"


def test_chamfer_symmetric_reduces_volume() -> None:
    """A symmetric chamfer on a box edge reduces volume."""
    pytest.importorskip("build123d", reason="build123d not installed")
    base_result, _ = _build_base_box()
    edge_ref = _edge_ref("base", base_result["shape"].wrapped, _vertical_edge_predicate())

    doc = {
        "version": 2,
        "name": "chamfer",
        "parameters": {},
        "datums": [{"id": "dxy", "kind": "XY", "name": "XY"}],
        "bodies": [{"id": "body-1", "name": "Body 1"}],
        "sketches": [_rect_sketch(width=10.0, height=10.0)],
        "features": [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "body": "body-1",
                "sketchId": "rect",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "chamfer",
                "name": "chamfer",
                "type": "chamfer",
                "body": "body-1",
                "params": {"edges": [edge_ref], "distance": 1},
                "dependsOn": ["base"],
                "suppressed": False,
            },
        ],
    }
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    assert result["shape"].volume == pytest.approx(
        10.0 * 10.0 * 10.0 - 0.5 * 1.0 * 1.0 * 10.0, abs=1e-2
    )


def test_chamfer_two_distances_and_distance_angle() -> None:
    """Chamfer supports two-distance and distance-angle modes."""
    pytest.importorskip("build123d", reason="build123d not installed")
    base_result, _ = _build_base_box()
    edge_ref = _edge_ref("base", base_result["shape"].wrapped, _vertical_edge_predicate())

    for mode, params in [
        ("two-distance", {"edges": [edge_ref], "distances": [1.0, 2.0]}),
        ("distance-angle", {"edges": [edge_ref], "distance": 1.0, "angle": 30.0}),
    ]:
        doc = {
            "version": 2,
            "name": f"chamfer-{mode}",
            "parameters": {},
            "datums": [{"id": "dxy", "kind": "XY", "name": "XY"}],
            "bodies": [{"id": "body-1", "name": "Body 1"}],
            "sketches": [_rect_sketch(width=10.0, height=10.0)],
            "features": [
                {
                    "id": "base",
                    "name": "base",
                    "type": "pad",
                    "body": "body-1",
                    "sketchId": "rect",
                    "params": {"length": 10},
                    "dependsOn": [],
                    "suppressed": False,
                },
                {
                    "id": "chamfer",
                    "name": "chamfer",
                    "type": "chamfer",
                    "body": "body-1",
                    "params": params,
                    "dependsOn": ["base"],
                    "suppressed": False,
                },
            ],
        }
        result = fb.build_document_shape(doc)
        assert result["shape"] is not None, f"{mode} chamfer produced no shape"
        assert result["shape"].volume > 0.0
        assert result["shape"].volume < 10.0 * 10.0 * 10.0


def _side_face_predicate() -> Any:
    """Return a predicate that selects a vertical side face of an extruded box."""
    import numpy as np

    def predicate(face: Any) -> bool:
        return (
            face.surface_type == "plane"
            and face.normal is not None
            and np.isclose(face.normal[2], 0.0)
        )

    return predicate


def test_draft_on_planar_face_changes_volume() -> None:
    """A draft applied to a side face of a box changes the volume."""
    pytest.importorskip("build123d", reason="build123d not installed")
    base_result, _ = _build_base_box()
    side_ref = _face_ref("base", base_result["shape"].wrapped, _side_face_predicate())

    doc = {
        "version": 2,
        "name": "draft",
        "parameters": {},
        "datums": [{"id": "dxy", "kind": "XY", "name": "XY"}],
        "bodies": [{"id": "body-1", "name": "Body 1"}],
        "sketches": [_rect_sketch(width=10.0, height=10.0)],
        "features": [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "body": "body-1",
                "sketchId": "rect",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "draft",
                "name": "draft",
                "type": "draft",
                "body": "body-1",
                "params": {"faces": [side_ref], "angle": 5, "pullDirection": [0, 0, 1]},
                "dependsOn": ["base"],
                "suppressed": False,
            },
        ],
    }
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["draft"]["status"] == "built"
    assert result["shape"].volume > 0.0


def test_shell_closed_hollows_volume() -> None:
    """A closed shell hollows the solid inward."""
    pytest.importorskip("build123d", reason="build123d not installed")

    doc = {
        "version": 2,
        "name": "shell",
        "parameters": {},
        "datums": [{"id": "dxy", "kind": "XY", "name": "XY"}],
        "bodies": [{"id": "body-1", "name": "Body 1"}],
        "sketches": [_rect_sketch(width=10.0, height=10.0)],
        "features": [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "body": "body-1",
                "sketchId": "rect",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "shell",
                "name": "shell",
                "type": "shell",
                "body": "body-1",
                "params": {"faces": [], "thickness": 1},
                "dependsOn": ["base"],
                "suppressed": False,
            },
        ],
    }
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    assert len(result["shape"].solids()) == 1
    # With no faces removed, BRepOffsetAPI_MakeThickSolid returns the inner
    # cavity (8x8x8 = 512), which we convert to a Solid so invariants hold.
    assert result["shape"].volume == pytest.approx(512.0, abs=1e-2)


def test_shell_removed_face_opens_shell() -> None:
    """Removing one face produces a lower volume than a closed shell."""
    pytest.importorskip("build123d", reason="build123d not installed")
    base_result, _ = _build_base_box()
    top_ref = _face_ref("base", base_result["shape"].wrapped, _top_face_predicate())

    doc = {
        "version": 2,
        "name": "shell-open",
        "parameters": {},
        "datums": [{"id": "dxy", "kind": "XY", "name": "XY"}],
        "bodies": [{"id": "body-1", "name": "Body 1"}],
        "sketches": [_rect_sketch(width=10.0, height=10.0)],
        "features": [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "body": "body-1",
                "sketchId": "rect",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "shell",
                "name": "shell",
                "type": "shell",
                "body": "body-1",
                "params": {"faces": [top_ref], "thickness": 1},
                "dependsOn": ["base"],
                "suppressed": False,
            },
        ],
    }
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    assert result["shape"].volume > 0.0
    # Removing a face yields a lower volume than the closed-shell cavity.
    assert result["shape"].volume < 512.0


def test_topology_refs_collected_for_dress_up_features() -> None:
    """``_collect_topology_refs`` gathers edge/face refs for dress-up features."""
    feature = {
        "id": "f1",
        "type": "fillet",
        "params": {
            "edges": [{"featureId": "base", "kind": "edge"}],
            "radius": 1,
        },
    }
    refs = fb._collect_topology_refs(feature, {}, {})
    assert any(path == "feature.f1.params.edges[0]" for path, _ref in refs)

    feature["type"] = "shell"
    feature["params"] = {"faces": [{"featureId": "base", "kind": "face"}], "thickness": 1}
    refs = fb._collect_topology_refs(feature, {}, {})
    assert any(path == "feature.f1.params.faces[0]" for path, _ref in refs)


def test_dress_up_on_consumed_body_is_stale() -> None:
    """A dress-up targeting a body consumed by a boolean is marked stale."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "body": "body-base",
                "sketchId": "rect",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "tool",
                "name": "tool",
                "type": "pad",
                "body": "body-tool",
                "sketchId": "rect",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "fuse",
                "name": "fuse",
                "type": "booleanFuse",
                "body": "body-base",
                "params": {"targetBody": "body-base", "toolBodies": ["body-tool"]},
                "dependsOn": ["base", "tool"],
                "suppressed": False,
            },
            {
                "id": "fillet",
                "name": "fillet",
                "type": "fillet",
                "body": "body-tool",
                "params": {"edges": [], "radius": 1},
                "dependsOn": ["fuse"],
                "suppressed": False,
            },
        ],
        sketches=[_rect_sketch(width=10.0, height=10.0)],
        bodies=[
            {"id": "body-base", "name": "base"},
            {"id": "body-tool", "name": "tool"},
        ],
    )
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["fillet"]["status"] == "stale"


def test_dress_up_without_existing_body_fails() -> None:
    """A dress-up on a body with no prior solid feature fails cleanly."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            {
                "id": "fillet",
                "name": "fillet",
                "type": "fillet",
                "body": "body-1",
                "params": {"edges": [], "radius": 1},
                "dependsOn": [],
                "suppressed": False,
            }
        ]
    )
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["fillet"]["status"] == "failed"
    assert "existing solid body" in by_id["fillet"]["error"].lower()
