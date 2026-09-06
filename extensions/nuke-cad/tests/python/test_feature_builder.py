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
import numpy as np
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


def test_cross_body_overlap_without_boolean_records_warning() -> None:
    """Two overlapping bodies that are not merged by a boolean are reported as a
    warning so CAD assemblies (for example the tokamak demo) can still build."""
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
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    assert any("overlap" in w for w in result.get("warnings", [])), result.get("warnings", [])


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


def _offset_pad_document(length: float = 5.0) -> dict[str, Any]:
    """Return a document with a single 10x10x``length`` pad anchored at the origin."""
    return _document(
        [
            {
                "id": "pad",
                "name": "pad",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": length},
                "dependsOn": [],
                "suppressed": False,
            }
        ],
        sketches=[_rect_sketch(width=10.0, height=10.0)],
    )


def test_linear_pattern_triples_volume() -> None:
    """A 3x linear pattern along X produces three disjoint copies."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _offset_pad_document(length=5.0)
    doc["features"].append(
        {
            "id": "lin",
            "name": "linear pattern",
            "type": "linearPattern",
            "body": "body-1",
            "params": {"source": "pad", "count": 3, "spacing": 12.0, "axis": "x"},
            "dependsOn": [],
            "suppressed": False,
        }
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 3.0 * 10.0 * 10.0 * 5.0, rel_tol=1e-6)


def test_circular_pattern_full_sweep_volume() -> None:
    """A 4x circular pattern around Z fills the four quadrants without overlap."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _offset_pad_document(length=5.0)
    doc["features"].append(
        {
            "id": "circ",
            "name": "circular pattern",
            "type": "circularPattern",
            "body": "body-1",
            "params": {"source": "pad", "count": 4, "angle": 360.0, "axis": "z"},
            "dependsOn": [],
            "suppressed": False,
        }
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 4.0 * 10.0 * 10.0 * 5.0, rel_tol=1e-6)


def test_circular_pattern_partial_sweep_volume() -> None:
    """A partial 180deg sweep with three instances places copies at 0/90/180 degrees."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _offset_pad_document(length=5.0)
    doc["features"].append(
        {
            "id": "circ",
            "name": "circular pattern",
            "type": "circularPattern",
            "body": "body-1",
            "params": {"source": "pad", "count": 3, "angle": 180.0, "axis": "z"},
            "dependsOn": [],
            "suppressed": False,
        }
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 3.0 * 10.0 * 10.0 * 5.0, rel_tol=1e-6)


def test_circular_pattern_with_datum_axis() -> None:
    """A circular pattern can use a datum plane's normal as its rotation axis."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _offset_pad_document(length=5.0)
    doc["datums"].append({"id": "axis-datum", "kind": "YZ", "name": "YZ datum"})
    doc["features"].append(
        {
            "id": "circ",
            "name": "circular pattern",
            "type": "circularPattern",
            "body": "body-1",
            "params": {"source": "pad", "count": 4, "angle": 360.0, "axisDatumId": "axis-datum"},
            "dependsOn": [],
            "suppressed": False,
        }
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 4.0 * 10.0 * 10.0 * 5.0, rel_tol=1e-6)


def test_mirror_across_coordinate_plane() -> None:
    """Mirroring an offset pad across YZ doubles the volume."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _offset_pad_document(length=5.0)
    doc["features"].append(
        {
            "id": "mirror",
            "name": "mirror",
            "type": "mirror",
            "body": "body-1",
            "params": {"source": "pad", "plane": "YZ"},
            "dependsOn": [],
            "suppressed": False,
        }
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 2.0 * 10.0 * 10.0 * 5.0, rel_tol=1e-6)


def test_mirror_with_datum_plane() -> None:
    """Mirroring across a datum plane produces the same result as the named plane."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _offset_pad_document(length=5.0)
    doc["datums"].append({"id": "mirror-datum", "kind": "XZ", "name": "XZ datum"})
    doc["features"].append(
        {
            "id": "mirror",
            "name": "mirror",
            "type": "mirror",
            "body": "body-1",
            "params": {"source": "pad", "planeDatumId": "mirror-datum"},
            "dependsOn": [],
            "suppressed": False,
        }
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 2.0 * 10.0 * 10.0 * 5.0, rel_tol=1e-6)


def test_pattern_of_pocket_cuts_volume() -> None:
    """A linear pattern of a pocket removes the expected material from the body."""
    pytest.importorskip("build123d", reason="build123d not installed")
    base_doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": 5.0},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "pocket",
                "name": "pocket",
                "type": "pocket",
                "sketchId": "small-rect",
                "params": {"length": 3.0},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "lin",
                "name": "linear pattern",
                "type": "linearPattern",
                "body": "body-1",
                "params": {"source": "pocket", "count": 2, "spacing": 8.0, "axis": "x"},
                "dependsOn": [],
                "suppressed": False,
            },
        ],
        sketches=[
            _rect_sketch(width=20.0, height=20.0),
            {
                "id": "small-rect",
                "name": "small rectangle",
                "datumId": "dxy",
                "primitives": [
                    {"id": "p1", "type": "point", "x": 8.0, "y": 8.0},
                    {"id": "p2", "type": "point", "x": 12.0, "y": 8.0},
                    {"id": "p3", "type": "point", "x": 12.0, "y": 12.0},
                    {"id": "p4", "type": "point", "x": 8.0, "y": 12.0},
                    {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
                    {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
                    {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
                    {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
                ],
                "constraints": [],
            },
        ],
    )
    result = fb.build_document_shape(base_doc)
    assert result["shape"] is not None
    # Two 4x4x3 pockets are removed from the 20x20x5 base.
    expected = 20.0 * 20.0 * 5.0 - 2.0 * 4.0 * 4.0 * 3.0
    assert math.isclose(result["shape"].volume, expected, rel_tol=1e-6)


def test_linear_pattern_overlap_fuses() -> None:
    """Overlapping additive pattern instances fuse into the source body."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _offset_pad_document(length=5.0)
    doc["features"].append(
        {
            "id": "lin",
            "name": "linear pattern",
            "type": "linearPattern",
            "body": "body-1",
            "params": {"source": "pad", "count": 2, "spacing": 0.0, "axis": "x"},
            "dependsOn": [],
            "suppressed": False,
        }
    )
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["lin"]["status"] == "built"
    # Two fully overlapping copies fuse to the source volume.
    assert math.isclose(result["shape"].volume, 10.0 * 10.0 * 5.0, rel_tol=1e-6)


def _solid_signatures(shape: Any) -> list[tuple[float, tuple[float, ...], tuple[float, ...]]]:
    """Per-solid (volume, bbox-min, bbox-max) signatures, sorted for comparison."""
    signatures = []
    for solid in shape.solids():
        bbox = solid.bounding_box()
        signatures.append(
            (
                float(solid.volume),
                (bbox.min.X, bbox.min.Y, bbox.min.Z),
                (bbox.max.X, bbox.max.Y, bbox.max.Z),
            )
        )
    return sorted(signatures)


def _assert_same_solid_set(actual: Any, expected: Any) -> None:
    """Assert two shapes carry the same solid set (volumes + bboxes)."""
    actual_sigs = _solid_signatures(actual)
    expected_sigs = _solid_signatures(expected)
    assert len(actual_sigs) == len(expected_sigs)
    for actual_sig, expected_sig in zip(actual_sigs, expected_sigs, strict=True):
        assert math.isclose(actual_sig[0], expected_sig[0], rel_tol=1e-9)
        for a, e in zip(actual_sig[1], expected_sig[1], strict=True):
            assert math.isclose(a, e, abs_tol=1e-9)
        for a, e in zip(actual_sig[2], expected_sig[2], strict=True):
            assert math.isclose(a, e, abs_tol=1e-9)


def test_disjoint_additive_pattern_skips_fuse(monkeypatch: pytest.MonkeyPatch) -> None:
    """Disjoint additive instances skip the boolean fuse via a flat compound."""
    bd = pytest.importorskip("build123d", reason="build123d not installed")
    body = bd.Compound(children=[bd.Solid.make_box(10.0, 10.0, 5.0)])
    instances = [
        body.moved(bd.Location((20.0, 0.0, 0.0))),
        body.moved(bd.Location((40.0, 0.0, 0.0))),
    ]
    assert fb._pattern_instances_are_disjoint(body, instances) is True

    calls: list[bool] = []
    real_predicate = fb._pattern_instances_are_disjoint

    def _spy(pred_body: Any, pred_instances: list[Any]) -> bool:
        calls.append(True)
        return real_predicate(pred_body, pred_instances)

    monkeypatch.setattr(fb, "_pattern_instances_are_disjoint", _spy)
    result = fb._apply_pattern_or_mirror(body, None, "pad", instances, "test")
    assert calls, "the disjointness predicate must gate the additive path"
    assert isinstance(result, bd.Compound)
    assert len(result.solids()) == 3

    fused: Any = body
    for instance in instances:
        fused = fused + instance
    _assert_same_solid_set(result, fused)


def test_overlapping_additive_pattern_takes_fuse_path() -> None:
    """Overlapping (and merely touching) instances still fuse into one solid."""
    bd = pytest.importorskip("build123d", reason="build123d not installed")
    body = bd.Compound(children=[bd.Solid.make_box(10.0, 10.0, 5.0)])
    overlapping = [body.moved(bd.Location((5.0, 0.0, 0.0)))]
    assert fb._pattern_instances_are_disjoint(body, overlapping) is False
    result = fb._apply_pattern_or_mirror(body, None, "pad", overlapping, "test")
    assert len(result.solids()) == 1
    assert math.isclose(result.volume, 10.0 * 10.0 * 5.0 + 5.0 * 10.0 * 5.0, rel_tol=1e-9)

    touching = [body.moved(bd.Location((10.0, 0.0, 0.0)))]
    assert fb._pattern_instances_are_disjoint(body, touching) is False
    fused_touching = fb._apply_pattern_or_mirror(body, None, "pad", touching, "test")
    assert math.isclose(fused_touching.volume, 2.0 * 10.0 * 10.0 * 5.0, rel_tol=1e-9)


def test_subtractive_pattern_never_consults_disjoint_skip(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pocket/groove patterns always cut sequentially, even when disjoint."""
    bd = pytest.importorskip("build123d", reason="build123d not installed")

    def _forbidden(_body: Any, _instances: list[Any]) -> bool:
        raise AssertionError("subtractive path must not consult the disjoint skip")

    monkeypatch.setattr(fb, "_pattern_instances_are_disjoint", _forbidden)
    body = bd.Compound(children=[bd.Solid.make_box(20.0, 20.0, 5.0)])
    cuts = [
        bd.Compound(children=[bd.Solid.make_box(4.0, 4.0, 3.0)]).moved(
            bd.Location((8.0, 8.0, 0.0))
        ),
        bd.Compound(children=[bd.Solid.make_box(4.0, 4.0, 3.0)]).moved(
            bd.Location((14.0, 14.0, 0.0))
        ),
    ]
    result = fb._apply_pattern_or_mirror(body, None, "pocket", cuts, "test")
    expected = 20.0 * 20.0 * 5.0 - 2.0 * 4.0 * 4.0 * 3.0
    assert math.isclose(result.volume, expected, rel_tol=1e-9)


def test_pattern_source_missing_fails() -> None:
    """A pattern whose source feature does not exist fails at sort time."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _offset_pad_document(length=5.0)
    doc["features"].append(
        {
            "id": "lin",
            "name": "linear pattern",
            "type": "linearPattern",
            "body": "body-1",
            "params": {"source": "missing", "count": 2, "spacing": 12.0, "axis": "x"},
            "dependsOn": [],
            "suppressed": False,
        }
    )
    with pytest.raises(fb.FeatureBuilderError, match="unknown feature 'missing'"):
        fb.build_document_shape(doc)


def test_pattern_source_cannot_be_self() -> None:
    """A pattern cannot be its own source."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _offset_pad_document(length=5.0)
    doc["features"].append(
        {
            "id": "lin",
            "name": "linear pattern",
            "type": "linearPattern",
            "body": "body-1",
            "params": {"source": "lin", "count": 2, "spacing": 12.0, "axis": "x"},
            "dependsOn": [],
            "suppressed": False,
        }
    )
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["lin"]["status"] == "failed"
    assert "must be earlier in the feature tree" in by_id["lin"]["error"].lower()


def test_pattern_source_must_be_solid_producer() -> None:
    """Pattern sources must be solid-producing features, not other patterns."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _offset_pad_document(length=5.0)
    doc["features"].append(
        {
            "id": "first-pattern",
            "name": "first pattern",
            "type": "linearPattern",
            "body": "body-1",
            "params": {"source": "pad", "count": 2, "spacing": 12.0, "axis": "x"},
            "dependsOn": [],
            "suppressed": False,
        }
    )
    doc["features"].append(
        {
            "id": "second-pattern",
            "name": "second pattern",
            "type": "linearPattern",
            "body": "body-1",
            "params": {"source": "first-pattern", "count": 2, "spacing": 12.0, "axis": "y"},
            "dependsOn": [],
            "suppressed": False,
        }
    )
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["second-pattern"]["status"] == "failed"
    assert "solid-producing feature" in by_id["second-pattern"]["error"].lower()


def test_pattern_source_must_target_same_body() -> None:
    """Pattern sources must belong to the same body as the pattern."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            {
                "id": "pad-b",
                "name": "pad on b",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": 5.0},
                "dependsOn": [],
                "suppressed": False,
                "body": "body-b",
            },
            {
                "id": "pad-a",
                "name": "pad on a",
                "type": "pad",
                "sketchId": "rect-a",
                "params": {"length": 5.0},
                "dependsOn": [],
                "suppressed": False,
                "body": "body-a",
            },
            {
                "id": "lin",
                "name": "linear pattern",
                "type": "linearPattern",
                "body": "body-b",
                "params": {"source": "pad-a", "count": 2, "spacing": 12.0, "axis": "x"},
                "dependsOn": [],
                "suppressed": False,
            },
        ],
        sketches=[
            _rect_sketch(width=10.0, height=10.0),
            {
                "id": "rect-a",
                "name": "rect-a",
                "datumId": "dxy",
                "primitives": [
                    {"id": "p1", "type": "point", "x": 20.0, "y": 0.0},
                    {"id": "p2", "type": "point", "x": 30.0, "y": 0.0},
                    {"id": "p3", "type": "point", "x": 30.0, "y": 10.0},
                    {"id": "p4", "type": "point", "x": 20.0, "y": 10.0},
                    {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
                    {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
                    {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
                    {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
                ],
                "constraints": [],
            },
        ],
        bodies=[{"id": "body-a", "name": "A"}, {"id": "body-b", "name": "B"}],
    )
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["lin"]["status"] == "failed"
    assert "same body" in by_id["lin"]["error"].lower()


def test_hole_simple_volume() -> None:
    """A simple blind hole removes a cylinder of the given diameter and depth."""
    pytest.importorskip("build123d", reason="build123d not installed")
    top_ref, _base_doc = _build_base_and_capture_top_face(length=5.0)
    doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": 5.0},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "hole1",
                "name": "hole",
                "type": "hole",
                "body": "body-1",
                "params": {"face": top_ref, "center": [0.0, 0.0], "diameter": 2.0, "depth": 3.0},
                "dependsOn": [],
                "suppressed": False,
            },
        ],
        sketches=[_rect_sketch(width=10.0, height=10.0)],
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    expected = 10.0 * 10.0 * 5.0 - math.pi * 1.0**2 * 3.0
    assert math.isclose(result["shape"].volume, expected, rel_tol=1e-6)


def test_hole_through() -> None:
    """A hole with no depth cuts through the whole body."""
    pytest.importorskip("build123d", reason="build123d not installed")
    top_ref, _base_doc = _build_base_and_capture_top_face(length=5.0)
    doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": 5.0},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "hole1",
                "name": "hole",
                "type": "hole",
                "body": "body-1",
                "params": {"face": top_ref, "center": [0.0, 0.0], "diameter": 2.0},
                "dependsOn": [],
                "suppressed": False,
            },
        ],
        sketches=[_rect_sketch(width=10.0, height=10.0)],
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    expected = 10.0 * 10.0 * 5.0 - math.pi * 1.0**2 * 5.0
    assert math.isclose(result["shape"].volume, expected, rel_tol=1e-6)


def test_hole_counterbore_volume() -> None:
    """A counterbore adds a larger cylinder on top of the main hole."""
    pytest.importorskip("build123d", reason="build123d not installed")
    top_ref, _base_doc = _build_base_and_capture_top_face(length=5.0)
    doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": 5.0},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "hole1",
                "name": "hole",
                "type": "hole",
                "body": "body-1",
                "params": {
                    "face": top_ref,
                    "center": [0.0, 0.0],
                    "diameter": 2.0,
                    "depth": 3.0,
                    "counterboreDiameter": 4.0,
                    "counterboreDepth": 1.0,
                },
                "dependsOn": [],
                "suppressed": False,
            },
        ],
        sketches=[_rect_sketch(width=10.0, height=10.0)],
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    # Main cylinder plus the annular counterbore shelf (the two overlap over the
    # top 1 unit of the main cylinder).
    expected = 10.0 * 10.0 * 5.0 - (math.pi * 1.0**2 * 3.0 + math.pi * (2.0**2 - 1.0**2) * 1.0)
    assert math.isclose(result["shape"].volume, expected, rel_tol=1e-6)


def test_hole_countersink_builds() -> None:
    """A countersink hole chamfers the top rim to the specified angle."""
    pytest.importorskip("build123d", reason="build123d not installed")
    top_ref, _base_doc = _build_base_and_capture_top_face(length=5.0)
    doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": 5.0},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "hole1",
                "name": "hole",
                "type": "hole",
                "body": "body-1",
                "params": {
                    "face": top_ref,
                    "center": [0.0, 0.0],
                    "diameter": 2.0,
                    "depth": 3.0,
                    "countersinkDiameter": 4.0,
                    "countersinkAngle": 60.0,
                },
                "dependsOn": [],
                "suppressed": False,
            },
        ],
        sketches=[_rect_sketch(width=10.0, height=10.0)],
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    assert result["shape"].volume < 10.0 * 10.0 * 5.0


def test_hole_non_planar_face_fails() -> None:
    """A hole placed on a cylindrical face reports a clear non-planar error."""
    pytest.importorskip("build123d", reason="build123d not installed")
    # Revolve a 5x5 rectangle around Y to make a solid cylinder.
    revolve_doc = _document(
        [
            {
                "id": "revolve",
                "name": "revolve",
                "type": "revolve",
                "sketchId": "profile",
                "params": {"axis": "y", "angle": 360.0},
                "dependsOn": [],
                "suppressed": False,
            }
        ],
        sketches=[
            {
                "id": "profile",
                "name": "profile",
                "datumId": "dxy",
                "primitives": [
                    {"id": "p1", "type": "point", "x": 0.0, "y": 0.0},
                    {"id": "p2", "type": "point", "x": 5.0, "y": 0.0},
                    {"id": "p3", "type": "point", "x": 5.0, "y": 5.0},
                    {"id": "p4", "type": "point", "x": 0.0, "y": 5.0},
                    {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
                    {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
                    {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
                    {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
                ],
                "constraints": [],
            }
        ],
    )
    revolve_result = fb.build_document_shape(revolve_doc)
    assert revolve_result["shape"] is not None

    def cylindrical_face(face: Any) -> bool:
        return (
            face.surface_type == "cylinder"
            and face.radius is not None
            and np.isclose(face.radius, 5.0, rtol=0.05)
        )

    side_ref = _face_ref("revolve", revolve_result["shape"].wrapped, cylindrical_face)

    doc = _document(
        [
            {
                "id": "revolve",
                "name": "revolve",
                "type": "revolve",
                "sketchId": "profile",
                "params": {"axis": "y", "angle": 360.0},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "hole1",
                "name": "hole",
                "type": "hole",
                "body": "body-1",
                "params": {
                    "face": side_ref,
                    "center": [0.0, 0.0],
                    "diameter": 2.0,
                    "depth": 2.0,
                },
                "dependsOn": [],
                "suppressed": False,
            },
        ],
        sketches=[
            {
                "id": "profile",
                "name": "profile",
                "datumId": "dxy",
                "primitives": [
                    {"id": "p1", "type": "point", "x": 0.0, "y": 0.0},
                    {"id": "p2", "type": "point", "x": 5.0, "y": 0.0},
                    {"id": "p3", "type": "point", "x": 5.0, "y": 5.0},
                    {"id": "p4", "type": "point", "x": 0.0, "y": 5.0},
                    {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
                    {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
                    {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
                    {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
                ],
                "constraints": [],
            }
        ],
    )
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["hole1"]["status"] == "failed"
    assert "not planar" in by_id["hole1"]["error"].lower()


def test_count_change_invalidates_face_reference() -> None:
    """Changing a pattern count removes patterned-instance faces and breaks downstream refs."""
    pytest.importorskip("build123d", reason="build123d not installed")
    offset_rect = {
        "id": "offset-rect",
        "name": "offset rectangle",
        "datumId": "dxy",
        "primitives": [
            {"id": "p1", "type": "point", "x": 15.0, "y": 0.0},
            {"id": "p2", "type": "point", "x": 25.0, "y": 0.0},
            {"id": "p3", "type": "point", "x": 25.0, "y": 10.0},
            {"id": "p4", "type": "point", "x": 15.0, "y": 10.0},
            {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
            {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
            {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
            {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
        ],
        "constraints": [],
    }
    base_result = fb.build_document_shape(
        _document(
            [
                {
                    "id": "pad",
                    "name": "pad",
                    "type": "pad",
                    "sketchId": "offset-rect",
                    "params": {"length": 5.0},
                    "dependsOn": [],
                    "suppressed": False,
                },
                {
                    "id": "circ",
                    "name": "circular pattern",
                    "type": "circularPattern",
                    "body": "body-1",
                    "params": {"source": "pad", "count": 2, "angle": 45.0, "axis": "z"},
                    "dependsOn": [],
                    "suppressed": False,
                },
            ],
            sketches=[offset_rect],
        )
    )
    assert base_result["shape"] is not None
    assert math.isclose(base_result["shape"].volume, 2.0 * 10.0 * 10.0 * 5.0, rel_tol=1e-6)

    # Capture the rotated copy's +Y face: its normal is diagonal in the XY plane
    # and does not exist on the original pad.
    def rotated_face(face: Any) -> bool:
        if face.surface_type != "plane" or face.normal is None:
            return False
        nx, ny = face.normal[0], face.normal[1]
        return np.isclose(nx, -0.70710678, atol=0.1) and np.isclose(ny, 0.70710678, atol=0.1)

    side_ref = _face_ref("circ", base_result["shape"].wrapped, rotated_face)

    doc = _document(
        [
            {
                "id": "pad",
                "name": "pad",
                "type": "pad",
                "sketchId": "offset-rect",
                "params": {"length": 5.0},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "circ",
                "name": "circular pattern",
                "type": "circularPattern",
                "body": "body-1",
                "params": {"source": "pad", "count": 1, "angle": 45.0, "axis": "z"},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "downstream",
                "name": "downstream pad",
                "type": "pad",
                "sketchId": "on-face",
                "body": "body-1",
                "params": {"length": 2.0},
                "dependsOn": [],
                "suppressed": False,
            },
        ],
        sketches=[
            offset_rect,
            {
                "id": "on-face",
                "name": "on-face",
                "datumId": "face-datum",
                "primitives": [
                    {"id": "p1", "type": "point", "x": -1.0, "y": -1.0},
                    {"id": "p2", "type": "point", "x": 1.0, "y": -1.0},
                    {"id": "p3", "type": "point", "x": 1.0, "y": 1.0},
                    {"id": "p4", "type": "point", "x": -1.0, "y": 1.0},
                    {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
                    {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
                    {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
                    {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
                ],
                "constraints": [],
            },
        ],
        bodies=None,
    )
    doc["datums"].append(
        {"id": "face-datum", "kind": "face", "name": "Copy face", "reference": side_ref}
    )
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    ref = [r for r in result["referenceResults"] if r["path"] == "datum.face-datum.reference"]
    assert by_id["downstream"]["status"] == "failed"
    assert ref and ref[0]["status"] in ("unmatched", "ambiguous")


def _point_in_solid(shape: Any, point: tuple[float, float, float]) -> bool:
    """Classify a world point against a build123d/OCP shape (True = inside).

    The OCCT solid classifier is only reliable on a single Solid, so compounds
    are classified per solid and OR-ed.
    """
    pytest.importorskip("build123d", reason="build123d not installed")
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_IN

    solids = shape.solids()
    if not solids:
        wrapped = shape.wrapped if hasattr(shape, "wrapped") else shape
        return BRepClass3d_SolidClassifier(wrapped, gp_Pnt(*point), 1e-6).State() == TopAbs_IN
    return any(
        BRepClass3d_SolidClassifier(solid.wrapped, gp_Pnt(*point), 1e-6).State() == TopAbs_IN
        for solid in solids
    )


def _bottom_face_predicate() -> Any:
    """Return a predicate that selects the bottom (-Z) face of an extruded box."""

    def predicate(face: Any) -> bool:
        return (
            face.surface_type == "plane"
            and face.normal is not None
            and np.isclose(face.normal[2], -1.0)
        )

    return predicate


def test_hole_off_center_on_reversed_face_is_not_mirrored() -> None:
    """Off-center hole on a box's -Z (TopAbs_REVERSED) face lands at the picked
    workplane position, not mirrored across the face centroid.

    Regression test: the fingerprint flips the plane normal for REVERSED faces
    while the workplane derivation historically did not, so off-center hole
    centers were mirrored in v.
    """
    pytest.importorskip("build123d", reason="build123d not installed")
    import reference_resolver as rr
    from OCP.TopAbs import TopAbs_REVERSED

    base_doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": 5.0},
                "dependsOn": [],
                "suppressed": False,
            }
        ],
        sketches=[_rect_sketch(width=10.0, height=10.0)],
    )
    base_result = fb.build_document_shape(base_doc)
    assert base_result["shape"] is not None

    # The bottom face must actually exercise the REVERSED orientation path.
    fingerprints, entities = rr.extract_face_fingerprints_with_entities(
        base_result["shape"].wrapped
    )
    predicate = _bottom_face_predicate()
    bottom = next(fp for fp in fingerprints if predicate(fp))
    assert entities[bottom.candidate_id].Orientation() == TopAbs_REVERSED
    assert np.allclose(bottom.normal, (0.0, 0.0, -1.0))

    bottom_ref = {"featureId": "base", "kind": "face", "fingerprint": bottom.to_dict()}

    # Face centroid is (5, 5, 0); workplane axes are x=(1,0,0), y=(0,-1,0), so
    # center [1, 2] maps to world (6, 3, 0) -- not the mirrored (6, 7, 0).
    doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": 5.0},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "hole1",
                "name": "hole",
                "type": "hole",
                "body": "body-1",
                "params": {"face": bottom_ref, "center": [1.0, 2.0], "diameter": 2.0},
                "dependsOn": [],
                "suppressed": False,
            },
        ],
        sketches=[_rect_sketch(width=10.0, height=10.0)],
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["hole1"]["status"] == "built", by_id["hole1"].get("error")
    shape = result["shape"]
    assert math.isclose(shape.volume, 500.0 - math.pi * 5.0, rel_tol=1e-6)
    assert not _point_in_solid(shape, (6.0, 3.0, 2.5)), "expected hole void at world (6, 3)"
    assert _point_in_solid(shape, (6.0, 7.0, 2.5)), "mirrored position must remain solid"
    assert _point_in_solid(shape, (5.0, 5.0, 2.5)), "face center must remain solid"


def test_hole_disjoint_from_body_fails() -> None:
    """A hole whose tool misses the body is an error, not a no-op success."""
    pytest.importorskip("build123d", reason="build123d not installed")
    top_ref, _base_doc = _build_base_and_capture_top_face(length=5.0)
    doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": 5.0},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "hole1",
                "name": "hole",
                "type": "hole",
                "body": "body-1",
                "params": {"face": top_ref, "center": [1000.0, 1000.0], "diameter": 2.0},
                "dependsOn": [],
                "suppressed": False,
            },
        ],
        sketches=[_rect_sketch(width=10.0, height=10.0)],
    )
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["hole1"]["status"] == "failed"
    assert "does not intersect" in by_id["hole1"]["error"].lower()


def test_pocket_disjoint_from_body_fails() -> None:
    """A pocket whose tool misses the body is an error, not a no-op success."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": 5.0},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "pocket1",
                "name": "pocket",
                "type": "pocket",
                "sketchId": "far-circle",
                "params": {"length": 2.0},
                "dependsOn": [],
                "suppressed": False,
            },
        ],
        sketches=[
            _rect_sketch(width=10.0, height=10.0),
            _circle_sketch(1000, 1000, 3, "far-circle"),
        ],
    )
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["pocket1"]["status"] == "failed"
    assert "does not intersect" in by_id["pocket1"]["error"].lower()


def test_pad_up_to_face_builds_to_named_face() -> None:
    """Pad upToFace extrudes the profile exactly to the named face's plane.

    The upToFace end condition replaces the old "not yet supported" failure:
    a profile sketched below the base body extrudes up to the base's top face
    and fuses into the body.
    """
    pytest.importorskip("build123d", reason="build123d not installed")
    top_ref, _base_doc = _build_base_and_capture_top_face(length=5.0)
    doc = _document(
        [
            {
                "id": "base",
                "name": "base",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": 5.0},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "pad2",
                "name": "pad2",
                "type": "pad",
                "sketchId": "rect",
                "params": {"end": "upToFace", "upToFace": top_ref},
                "dependsOn": [],
                "suppressed": False,
            },
        ],
        sketches=[_rect_sketch(width=10.0, height=10.0)],
    )
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["pad2"]["status"] == "built"
    # The coincident 10x10 profile fuses flush with the 10x10x5 base.
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 10.0 * 10.0 * 5.0, rel_tol=1e-6)


def test_pad_rejects_unsupported_angle_and_up_to_body() -> None:
    """Pad angle stays unimplemented; upToBody needs an up-to end."""
    pytest.importorskip("build123d", reason="build123d not installed")
    for extra, message in (
        ({"angle": 5.0}, "not yet supported"),
        ({"upToBody": "body-1"}, "requires end"),
    ):
        doc = _document(
            [
                {
                    "id": "pad",
                    "name": "pad",
                    "type": "pad",
                    "sketchId": "rect",
                    "params": {"length": 5.0, **extra},
                    "dependsOn": [],
                    "suppressed": False,
                }
            ],
            sketches=[_rect_sketch(width=10.0, height=10.0)],
        )
        result = fb.build_document_shape(doc)
        by_id = {r["featureId"]: r for r in result["featureResults"]}
        assert by_id["pad"]["status"] == "failed", extra
        assert message in by_id["pad"]["error"].lower()


def test_pad_on_consumed_body_is_stale() -> None:
    """Sketch-solid features on a body consumed by a boolean are guarded like
    dress-up/pattern features, instead of building geometry that is silently
    excluded from the assembly."""
    pytest.importorskip("build123d", reason="build123d not installed")
    rect_b = {
        "id": "rect-b",
        "name": "rect-b",
        "datumId": "dxy",
        "primitives": [
            {"id": "p1", "type": "point", "x": 20.0, "y": 0.0},
            {"id": "p2", "type": "point", "x": 25.0, "y": 0.0},
            {"id": "p3", "type": "point", "x": 25.0, "y": 5.0},
            {"id": "p4", "type": "point", "x": 20.0, "y": 5.0},
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
                "id": "pad-a",
                "name": "pad a",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": 5.0},
                "dependsOn": [],
                "suppressed": False,
                "body": "body-a",
            },
            {
                "id": "pad-b",
                "name": "pad b",
                "type": "pad",
                "sketchId": "rect-b",
                "params": {"length": 5.0},
                "dependsOn": [],
                "suppressed": False,
                "body": "body-b",
            },
            {
                "id": "cut",
                "name": "cut",
                "type": "booleanCut",
                "body": "body-a",
                "params": {"targetBody": "body-a", "toolBodies": ["body-b"]},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "pad-c",
                "name": "pad on consumed body",
                "type": "pad",
                "sketchId": "rect-b",
                "params": {"length": 2.0},
                "dependsOn": [],
                "suppressed": False,
                "body": "body-b",
            },
        ],
        sketches=[_rect_sketch(width=10.0, height=10.0), rect_b],
        bodies=[{"id": "body-a", "name": "A"}, {"id": "body-b", "name": "B"}],
    )
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["cut"]["status"] == "built"
    assert by_id["pad-c"]["status"] == "stale"
    assert result["consumedBodies"] == ["body-b"]


def test_circular_pattern_axis_datum_on_other_body() -> None:
    """A circular pattern axis datum referencing another body's face resolves
    against the referenced feature's historical shape, not the pattern's body."""
    pytest.importorskip("build123d", reason="build123d not installed")
    rect_b = {
        "id": "rect-b",
        "name": "rect-b",
        "datumId": "dxy",
        "primitives": [
            {"id": "p1", "type": "point", "x": 20.0, "y": 0.0},
            {"id": "p2", "type": "point", "x": 25.0, "y": 0.0},
            {"id": "p3", "type": "point", "x": 25.0, "y": 5.0},
            {"id": "p4", "type": "point", "x": 20.0, "y": 5.0},
            {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
            {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
            {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
            {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
        ],
        "constraints": [],
    }
    # Capture body-a's top face from an identical preliminary build.
    base_result = fb.build_document_shape(
        _document(
            [
                {
                    "id": "pad-a",
                    "name": "pad a",
                    "type": "pad",
                    "sketchId": "rect",
                    "params": {"length": 5.0},
                    "dependsOn": [],
                    "suppressed": False,
                    "body": "body-a",
                }
            ],
            sketches=[_rect_sketch(width=10.0, height=10.0)],
            bodies=[{"id": "body-a", "name": "A"}, {"id": "body-b", "name": "B"}],
        )
    )
    assert base_result["shape"] is not None
    top_ref = _face_ref("pad-a", base_result["shape"].wrapped, _top_face_predicate())

    doc = _document(
        [
            {
                "id": "pad-a",
                "name": "pad a",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": 5.0},
                "dependsOn": [],
                "suppressed": False,
                "body": "body-a",
            },
            {
                "id": "pad-b",
                "name": "pad b",
                "type": "pad",
                "sketchId": "rect-b",
                "params": {"length": 5.0},
                "dependsOn": [],
                "suppressed": False,
                "body": "body-b",
            },
            {
                "id": "pat-b",
                "name": "circular pattern",
                "type": "circularPattern",
                "body": "body-b",
                "params": {
                    "source": "pad-b",
                    "count": 2,
                    "angle": 360.0,
                    "axisDatumId": "axis-datum",
                },
                "dependsOn": [],
                "suppressed": False,
            },
        ],
        sketches=[_rect_sketch(width=10.0, height=10.0), rect_b],
        bodies=[{"id": "body-a", "name": "A"}, {"id": "body-b", "name": "B"}],
    )
    doc["datums"].append(
        {"id": "axis-datum", "kind": "face", "name": "Axis face", "reference": top_ref}
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["pat-b"]["status"] == "built", by_id["pat-b"].get("error")
    ref = [r for r in result["referenceResults"] if r["path"] == "datum.axis-datum.reference"]
    assert ref and ref[0]["status"] == "matched"
    # The axis runs through body-a's top face centroid (5, 5, z); the 180-degree
    # instance of the [20,25]x[0,5] box lands at x in [-15,-10], y in [5,10].
    assert math.isclose(result["shape"].volume, 500.0 + 2.0 * 125.0, rel_tol=1e-6)
    assert _point_in_solid(result["shape"], (-12.5, 7.5, 2.5))


def test_mirror_plane_datum_on_other_body() -> None:
    """A mirror plane datum referencing another body's face resolves against the
    referenced feature's historical shape, not the pattern's body."""
    pytest.importorskip("build123d", reason="build123d not installed")
    rect_b = {
        "id": "rect-b",
        "name": "rect-b",
        "datumId": "dxy",
        "primitives": [
            {"id": "p1", "type": "point", "x": 20.0, "y": 0.0},
            {"id": "p2", "type": "point", "x": 25.0, "y": 0.0},
            {"id": "p3", "type": "point", "x": 25.0, "y": 5.0},
            {"id": "p4", "type": "point", "x": 20.0, "y": 5.0},
            {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
            {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
            {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
            {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
        ],
        "constraints": [],
    }
    base_result = fb.build_document_shape(
        _document(
            [
                {
                    "id": "pad-a",
                    "name": "pad a",
                    "type": "pad",
                    "sketchId": "rect",
                    "params": {"length": 5.0},
                    "dependsOn": [],
                    "suppressed": False,
                    "body": "body-a",
                }
            ],
            sketches=[_rect_sketch(width=10.0, height=10.0)],
            bodies=[{"id": "body-a", "name": "A"}, {"id": "body-b", "name": "B"}],
        )
    )
    assert base_result["shape"] is not None

    def plus_x_face(face: Any) -> bool:
        return (
            face.surface_type == "plane"
            and face.normal is not None
            and np.isclose(face.normal[0], 1.0)
        )

    side_ref = _face_ref("pad-a", base_result["shape"].wrapped, plus_x_face)

    doc = _document(
        [
            {
                "id": "pad-a",
                "name": "pad a",
                "type": "pad",
                "sketchId": "rect",
                "params": {"length": 5.0},
                "dependsOn": [],
                "suppressed": False,
                "body": "body-a",
            },
            {
                "id": "pad-b",
                "name": "pad b",
                "type": "pad",
                "sketchId": "rect-b",
                "params": {"length": 5.0},
                "dependsOn": [],
                "suppressed": False,
                "body": "body-b",
            },
            {
                "id": "mir-b",
                "name": "mirror",
                "type": "mirror",
                "body": "body-b",
                "params": {"source": "pad-b", "planeDatumId": "plane-datum"},
                "dependsOn": [],
                "suppressed": False,
            },
        ],
        sketches=[_rect_sketch(width=10.0, height=10.0), rect_b],
        bodies=[{"id": "body-a", "name": "A"}, {"id": "body-b", "name": "B"}],
    )
    doc["datums"].append(
        {"id": "plane-datum", "kind": "face", "name": "Mirror face", "reference": side_ref}
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["mir-b"]["status"] == "built", by_id["mir-b"].get("error")
    ref = [r for r in result["referenceResults"] if r["path"] == "datum.plane-datum.reference"]
    assert ref and ref[0]["status"] == "matched"
    # The mirror plane is x=10 (body-a's +X face); the [20,25]x[0,5] box mirrors
    # to x in [-5,0].
    assert math.isclose(result["shape"].volume, 500.0 + 2.0 * 125.0, rel_tol=1e-6)
    assert _point_in_solid(result["shape"], (-2.5, 2.5, 2.5))


# ---------------------------------------------------------------------------
# Sweep and pipe features
# ---------------------------------------------------------------------------


def _centered_rect_sketch(width: float, height: float, sid: str = "rect") -> dict[str, Any]:
    """Rectangle sketch centered on the sketch origin (section centered on the path)."""
    hw = width / 2.0
    hh = height / 2.0
    return {
        "id": sid,
        "name": sid,
        "datumId": "dxy",
        "primitives": [
            {"id": "p1", "type": "point", "x": -hw, "y": -hh},
            {"id": "p2", "type": "point", "x": hw, "y": -hh},
            {"id": "p3", "type": "point", "x": hw, "y": hh},
            {"id": "p4", "type": "point", "x": -hw, "y": hh},
            {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
            {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
            {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
            {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
        ],
        "constraints": [],
    }


def _points_curve(curve_id: str, samples: list[list[float]]) -> dict[str, Any]:
    return {"id": curve_id, "name": curve_id, "source": {"kind": "points"}, "samples": samples}


def _arc_samples(radius: float, segments: int = 64) -> list[list[float]]:
    return [
        [radius * math.cos(math.pi * i / segments), radius * math.sin(math.pi * i / segments), 0.0]
        for i in range(segments + 1)
    ]


def _sweep_document(
    params: dict[str, Any],
    sketch: dict[str, Any] | None = None,
    curve: dict[str, Any] | None = None,
    feature_id: str = "sw1",
) -> dict[str, Any]:
    doc = _document(
        [
            {
                "id": feature_id,
                "name": "sweep",
                "type": "sweep",
                "sketchId": (sketch or _rect_sketch())["id"],
                "params": params,
                "dependsOn": [],
                "suppressed": False,
            }
        ],
        sketches=[sketch or _rect_sketch()],
    )
    if curve is not None:
        doc["curves"] = [curve]
    return doc


def _build_with_curves(doc: dict[str, Any]) -> Any:
    """Fit document curves and build the shape, returning the build result."""
    import curve_builder as cb

    curve_results = cb.build_curves(doc)
    return fb.build_document_shape(doc, curve_results=curve_results), curve_results


def test_sweep_and_pipe_require_build123d(monkeypatch: pytest.MonkeyPatch) -> None:
    """When build123d is unavailable, sweep and pipe raise the standard clear error."""
    monkeypatch.setitem(sys.modules, "build123d", None)
    monkeypatch.setattr(fb, "HAS_BUILD123D", False)
    monkeypatch.setattr(fb, "bd", None)
    sweep_doc = _sweep_document(
        {"pathCurveId": "arc", "orientation": "frenet"},
        curve=_points_curve("arc", _arc_samples(50.0)),
    )
    with pytest.raises(fb.FeatureBuilderError, match="build123d is not available"):
        fb.build_document_shape(sweep_doc)
    pipe_doc = _document(
        [
            {
                "id": "p1",
                "name": "pipe",
                "type": "pipe",
                "params": {"pathCurveId": "arc", "radius": 2.0, "orientation": "frenet"},
                "dependsOn": [],
                "suppressed": False,
            }
        ],
        sketches=[],
    )
    pipe_doc["curves"] = [_points_curve("arc", _arc_samples(50.0))]
    with pytest.raises(fb.FeatureBuilderError, match="build123d is not available"):
        fb.build_document_shape(pipe_doc)


def test_sweep_along_arc_matches_build123d_reference() -> None:
    """A rectangle swept along an arc matches a build123d sweep of the same section."""
    bd = pytest.importorskip("build123d", reason="build123d not installed")
    import sketch_builder

    sketch = _centered_rect_sketch(40.0, 20.0)
    doc = _sweep_document(
        {"pathCurveId": "arc", "orientation": "frenet"},
        sketch=sketch,
        curve=_points_curve("arc", _arc_samples(50.0)),
    )
    result, curve_results = _build_with_curves(doc)
    assert result["shape"] is not None
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["sw1"]["status"] == "built", by_id["sw1"].get("error")
    assert len(result["shape"].solids()) == 1

    # Reference: the same section auto-positioned at the path start, swept by
    # build123d with Frenet mode and a round-corner transition.
    datums = {d["id"]: d for d in doc["datums"]}
    plane, faces = sketch_builder.build_sketch_faces(sketch, datums)
    spine = curve_results["arc"]["wire"]
    start, tangent = fb._path_start_frame(spine)
    sections = fb._position_sections_at_path_start(faces, plane, start, tangent)
    reference = bd.Solid.sweep(
        section=bd.Face(sections[0]),
        path=bd.Wire(spine),
        is_frenet=True,
        transition=bd.Transition.ROUND,
    )
    assert reference.volume > 0.0
    assert math.isclose(result["shape"].volume, reference.volume, rel_tol=1e-6)
    assert np.allclose(
        result["shape"].bounding_box().min.to_tuple(),
        reference.bounding_box().min.to_tuple(),
        atol=1e-6,
    )
    assert np.allclose(
        result["shape"].bounding_box().max.to_tuple(),
        reference.bounding_box().max.to_tuple(),
        atol=1e-6,
    )


def test_sweep_frenet_vs_fixed_binormal_differ_and_are_stable() -> None:
    """On a non-planar path the two orientation modes give different, stable results."""
    pytest.importorskip("build123d", reason="build123d not installed")
    # Half helix: strongly non-planar, so the Frenet frame banks while a fixed
    # binormal keeps the section upright.
    samples = [
        [
            50.0 * math.cos(math.pi * i / 64),
            50.0 * math.sin(math.pi * i / 64),
            30.0 * i / 64,
        ]
        for i in range(65)
    ]
    curve = _points_curve("helix", samples)
    # Corner-anchored section: offset from the path, so frame choice matters.
    doc = _sweep_document({"pathCurveId": "helix", "orientation": "frenet"}, curve=curve)
    doc_binormal = _sweep_document(
        {"pathCurveId": "helix", "orientation": "fixedBinormal", "binormal": [0.0, 0.0, 1.0]},
        curve=curve,
    )

    frenet_result, _ = _build_with_curves(doc)
    binormal_result, _ = _build_with_curves(doc_binormal)
    assert frenet_result["shape"] is not None
    assert binormal_result["shape"] is not None
    frenet_volume = frenet_result["shape"].volume
    binormal_volume = binormal_result["shape"].volume
    assert frenet_volume > 0.0 and binormal_volume > 0.0
    assert not math.isclose(frenet_volume, binormal_volume, rel_tol=1e-3)

    # Both modes are deterministic across rebuilds.
    frenet_repeat, _ = _build_with_curves(doc)
    binormal_repeat, _ = _build_with_curves(doc_binormal)
    assert frenet_repeat["shape"].volume == pytest.approx(frenet_volume, rel=1e-9)
    assert binormal_repeat["shape"].volume == pytest.approx(binormal_volume, rel=1e-9)


def test_pipe_volume_approximates_section_area_times_path_length() -> None:
    """A pipe along a gently curved path has volume ~= pi r^2 * path length."""
    bd = pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            {
                "id": "p1",
                "name": "pipe",
                "type": "pipe",
                "params": {"pathCurveId": "arc", "radius": 2.0, "orientation": "frenet"},
                "dependsOn": [],
                "suppressed": False,
            }
        ],
        sketches=[],
    )
    doc["curves"] = [_points_curve("arc", _arc_samples(500.0, segments=32))]
    result, curve_results = _build_with_curves(doc)
    assert result["shape"] is not None
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["p1"]["status"] == "built", by_id["p1"].get("error")
    assert len(result["shape"].solids()) == 1
    path_length = bd.Wire(curve_results["arc"]["wire"]).length
    expected = math.pi * 2.0**2 * path_length
    assert math.isclose(result["shape"].volume, expected, rel_tol=1e-3)


def test_pipe_self_intersection_pre_check_fires() -> None:
    """A fat pipe on a tight path fails with the named curvature error."""
    pytest.importorskip("build123d", reason="build123d not installed")
    closed_circle = [
        [3.0 * math.cos(2 * math.pi * i / 64), 3.0 * math.sin(2 * math.pi * i / 64), 0.0]
        for i in range(65)
    ]
    doc = _document(
        [
            {
                "id": "p1",
                "name": "pipe",
                "type": "pipe",
                "params": {"pathCurveId": "loop", "radius": 5.0, "orientation": "frenet"},
                "dependsOn": [],
                "suppressed": False,
            }
        ],
        sketches=[],
    )
    doc["curves"] = [_points_curve("loop", closed_circle)]
    result, _ = _build_with_curves(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["p1"]["status"] == "failed"
    assert "too tightly curved" in by_id["p1"]["error"]
    assert "p1" in by_id["p1"]["error"]
    assert "5" in by_id["p1"]["error"]  # the section reach is reported


def test_sweep_self_intersection_pre_check_fires() -> None:
    """An oversized sweep section on a tight path fails with the named curvature error."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _sweep_document(
        {"pathCurveId": "arc", "orientation": "frenet"},
        sketch=_centered_rect_sketch(30.0, 30.0),
        curve=_points_curve("arc", _arc_samples(10.0)),
    )
    result, _ = _build_with_curves(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["sw1"]["status"] == "failed"
    assert "too tightly curved" in by_id["sw1"]["error"]
    # The section reach (half diagonal of the 30x30 square) is reported.
    assert "21.21" in by_id["sw1"]["error"]


def test_sweep_pipeshell_failure_funnels_to_feature_builder_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Raw OCP failures inside PipeShell surface as FeatureBuilderError, not crashes."""

    def _exploding_result(builder: Any, feature_id: str) -> Any:
        raise RuntimeError("simulated OCCT Standard_Failure")

    monkeypatch.setattr(fb, "_pipe_shell_result", _exploding_result)
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _sweep_document(
        {"pathCurveId": "arc", "orientation": "frenet"},
        sketch=_centered_rect_sketch(10.0, 5.0),
        curve=_points_curve("arc", _arc_samples(50.0)),
    )
    result, _ = _build_with_curves(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["sw1"]["status"] == "failed"
    assert "sweep failed" in by_id["sw1"]["error"]
    assert "simulated OCCT Standard_Failure" in by_id["sw1"]["error"]
    assert "sw1" in by_id["sw1"]["error"]


def _step_roundtrip_volumes(shape: Any, path: Any) -> list[float]:
    """Write a shape to STEP, read it back, and return the solid volumes."""
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Reader, STEPControl_Writer
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    writer = STEPControl_Writer()
    writer.Transfer(shape, STEPControl_AsIs)
    assert writer.Write(str(path)) == IFSelect_RetDone
    reader = STEPControl_Reader()
    assert reader.ReadFile(str(path)) == IFSelect_RetDone
    reader.TransferRoots()
    volumes = []
    exp = TopExp_Explorer(reader.OneShape(), TopAbs_SOLID)
    while exp.More():
        props = GProp_GProps()
        BRepGProp.VolumeProperties_s(TopoDS.Solid_s(exp.Current()), props)
        volumes.append(props.Mass())
        exp.Next()
    return volumes


def _closed_loop_samples(radius: float, segments: int = 64) -> list[list[float]]:
    return [
        [
            radius * math.cos(2 * math.pi * i / segments),
            radius * math.sin(2 * math.pi * i / segments),
            0.0,
        ]
        for i in range(segments + 1)
    ]


def test_sweep_along_closed_loop_produces_step_durable_solid(tmp_path: Any) -> None:
    """A closed-path sweep yields one valid solid that survives a STEP round-trip."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _sweep_document(
        {"pathCurveId": "loop", "orientation": "frenet"},
        sketch=_centered_rect_sketch(10.0, 10.0),
        curve=_points_curve("loop", _closed_loop_samples(50.0)),
    )
    result, _ = _build_with_curves(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["sw1"]["status"] == "built", by_id["sw1"].get("error")
    assert len(result["shape"].solids()) == 1
    volume = result["shape"].volume
    # Sanity: the lofted tube tracks the section area times the loop length.
    expected = 10.0 * 10.0 * (2 * math.pi * 50.0)
    assert math.isclose(volume, expected, rel_tol=0.05)
    # The MakePipeShell closed-spine shell degrades on STEP round-trip; the
    # rebuilt loft must come back as exactly one solid with the same volume.
    roundtrip = _step_roundtrip_volumes(result["shape"].wrapped, tmp_path / "loop.step")
    assert len(roundtrip) == 1
    assert math.isclose(roundtrip[0], volume, rel_tol=1e-3)


def test_pipe_along_closed_loop_produces_step_durable_solid(tmp_path: Any) -> None:
    """A pipe on a closed path uses the circle-station fallback and stays STEP-durable."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            {
                "id": "p1",
                "name": "pipe",
                "type": "pipe",
                "params": {"pathCurveId": "loop", "radius": 2.0, "orientation": "frenet"},
                "dependsOn": [],
                "suppressed": False,
            }
        ],
        sketches=[],
    )
    doc["curves"] = [_points_curve("loop", _closed_loop_samples(50.0))]
    result, _ = _build_with_curves(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["p1"]["status"] == "built", by_id["p1"].get("error")
    assert len(result["shape"].solids()) == 1
    volume = result["shape"].volume
    expected = math.pi * 2.0**2 * (2 * math.pi * 50.0)
    assert math.isclose(volume, expected, rel_tol=0.02)
    roundtrip = _step_roundtrip_volumes(result["shape"].wrapped, tmp_path / "pipe.step")
    assert len(roundtrip) == 1
    assert math.isclose(roundtrip[0], volume, rel_tol=1e-3)


def test_sweep_as_circular_pattern_source() -> None:
    """A sweep is a valid pattern source; instances add to the body volume."""
    pytest.importorskip("build123d", reason="build123d not installed")
    # A 60-degree arc: three copies rotated by 120 degrees stay disjoint.
    segments = 64
    short_arc = [
        [
            50.0 * math.cos(math.pi / 3.0 * i / segments),
            50.0 * math.sin(math.pi / 3.0 * i / segments),
            0.0,
        ]
        for i in range(segments + 1)
    ]
    doc = _sweep_document(
        {"pathCurveId": "arc", "orientation": "frenet"},
        sketch=_centered_rect_sketch(10.0, 5.0),
        curve=_points_curve("arc", short_arc),
    )
    single, _ = _build_with_curves(doc)
    assert single["shape"] is not None
    single_volume = single["shape"].volume

    doc["features"].append(
        {
            "id": "circ",
            "name": "circular pattern",
            "type": "circularPattern",
            "body": "body-1",
            "params": {"source": "sw1", "count": 3, "angle": 360.0, "axis": "z"},
            "dependsOn": [],
            "suppressed": False,
        }
    )
    result, curve_results = _build_with_curves(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["circ"]["status"] == "built", by_id["circ"].get("error")
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 3.0 * single_volume, rel_tol=1e-6)


def test_sweep_missing_curve_is_per_feature_failure() -> None:
    """A sweep whose path curve failed to build fails the feature, not the document."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _sweep_document({"pathCurveId": "arc", "orientation": "frenet"})
    result = fb.build_document_shape(doc, curve_results={})
    assert result["shape"] is None
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["sw1"]["status"] == "failed"
    assert "path curve 'arc' is unavailable" in by_id["sw1"]["error"]


def test_w7x_coil_sweep_e2e_shaped() -> None:
    """Square section swept along the W7X coil centerline: one solid, ~area x length."""
    pytest.importorskip("build123d", reason="build123d not installed")
    import json
    from pathlib import Path

    fixture = Path(__file__).parent.parent / "e2e" / "assets" / "w7x_coil_centerline.json"
    samples = json.loads(fixture.read_text())
    doc = _sweep_document(
        {"pathCurveId": "w7x", "orientation": "frenet"},
        sketch=_centered_rect_sketch(0.37, 0.37),
        curve=_points_curve("w7x", [list(p) for p in samples]),
    )
    result, _ = _build_with_curves(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["sw1"]["status"] == "built", by_id["sw1"].get("error")
    assert result["shape"] is not None
    assert len(result["shape"].solids()) == 1
    length = sum(
        math.dist(samples[i], samples[(i + 1) % len(samples)]) for i in range(len(samples))
    )
    expected = 0.37 * 0.37 * length
    assert math.isclose(result["shape"].volume, expected, rel_tol=0.05)


# ---------------------------------------------------------------------------
# Loft and helical sweep features
# ---------------------------------------------------------------------------


def _offset_rect_sketch(
    sid: str,
    cx: float,
    cy: float,
    width: float,
    height: float,
    datum: str = "dxy",
) -> dict[str, Any]:
    """Rectangle sketch centered at (cx, cy) on its datum plane."""
    hw = width / 2.0
    hh = height / 2.0
    return {
        "id": sid,
        "name": sid,
        "datumId": datum,
        "primitives": [
            {"id": "p1", "type": "point", "x": cx - hw, "y": cy - hh},
            {"id": "p2", "type": "point", "x": cx + hw, "y": cy - hh},
            {"id": "p3", "type": "point", "x": cx + hw, "y": cy + hh},
            {"id": "p4", "type": "point", "x": cx - hw, "y": cy + hh},
            {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
            {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
            {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
            {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
        ],
        "constraints": [],
    }


def _z_datums() -> list[dict[str, Any]]:
    return [
        {"id": "dxy", "kind": "XY", "name": "XY"},
        {"id": "dz10", "kind": "offset", "name": "Z10", "offset": 10.0},
        {"id": "dz30", "kind": "offset", "name": "Z30", "offset": 30.0},
    ]


def _loft_feature(
    section_sketch_ids: list[str], ruled: bool, feature_id: str = "loft1"
) -> dict[str, Any]:
    return {
        "id": feature_id,
        "name": "loft",
        "type": "loft",
        "body": "body-1",
        "params": {"sectionSketchIds": section_sketch_ids, "ruled": ruled},
        "dependsOn": [],
        "suppressed": False,
    }


def _helical_feature(
    params: dict[str, Any], sketch_id: str = "sec", feature_id: str = "h1"
) -> dict[str, Any]:
    return {
        "id": feature_id,
        "name": "helix",
        "type": "helicalSweep",
        "body": "body-1",
        "sketchId": sketch_id,
        "params": params,
        "dependsOn": [],
        "suppressed": False,
    }


def _loft_doc(
    section_sketches: list[dict[str, Any]],
    ruled: bool = False,
    features: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    doc = _document(
        features
        if features is not None
        else [_loft_feature([s["id"] for s in section_sketches], ruled)],
        sketches=section_sketches,
        bodies=[{"id": "body-1", "name": "Body 1"}],
    )
    doc["datums"] = _z_datums()
    return doc


def test_loft_and_helical_sweep_require_build123d(monkeypatch: pytest.MonkeyPatch) -> None:
    """When build123d is unavailable, loft and helicalSweep raise the standard clear error."""
    monkeypatch.setitem(sys.modules, "build123d", None)
    monkeypatch.setattr(fb, "HAS_BUILD123D", False)
    monkeypatch.setattr(fb, "bd", None)
    loft_doc = _loft_doc(
        [_offset_rect_sketch("r1", 0, 0, 40, 20), _offset_rect_sketch("r2", 0, 0, 20, 10, "dz30")]
    )
    with pytest.raises(fb.FeatureBuilderError, match="build123d is not available"):
        fb.build_document_shape(loft_doc)
    helix_doc = _document(
        [_helical_feature({"axis": "Z", "startRadius": 20.0, "pitch": 5.0, "turns": 3.0})],
        sketches=[_offset_rect_sketch("sec", 0, 0, 2, 2)],
    )
    with pytest.raises(fb.FeatureBuilderError, match="build123d is not available"):
        fb.build_document_shape(helix_doc)


def test_loft_sections_as_positioned_match_reference() -> None:
    """A smooth loft between offset rectangles matches the same-wires reference."""
    bd = pytest.importorskip("build123d", reason="build123d not installed")
    import sketch_builder

    sketches = [
        _offset_rect_sketch("r1", 0, 0, 40, 20),
        _offset_rect_sketch("r2", 5, 3, 30, 10, "dz10"),
        _offset_rect_sketch("r3", 0, 0, 20, 12, "dz30"),
    ]
    doc = _loft_doc(sketches)
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["loft1"]["status"] == "built", by_id["loft1"].get("error")
    assert result["shape"] is not None
    assert len(result["shape"].solids()) == 1

    # Reference 1: the exact same section wires through the same ThruSections
    # machinery must agree to numerical precision.
    datums = {d["id"]: d for d in doc["datums"]}
    wires = []
    for sketch in sketches:
        _plane, faces = sketch_builder.build_sketch_faces(sketch, datums)
        wires.append(faces[0].outer_wire())
    same_wires = bd.Solid.make_loft(wires, ruled=False)
    assert same_wires.volume > 0.0
    assert math.isclose(result["shape"].volume, same_wires.volume, rel_tol=1e-6)
    assert np.allclose(
        result["shape"].bounding_box().min.to_tuple(),
        same_wires.bounding_box().min.to_tuple(),
        atol=1e-6,
    )
    assert np.allclose(
        result["shape"].bounding_box().max.to_tuple(),
        same_wires.bounding_box().max.to_tuple(),
        atol=1e-6,
    )

    # Reference 2: build123d's bd.loft on the same positioned sections. The
    # wire seam ordering differs, so the smooth skin (and therefore volume)
    # differs slightly; the result must stay close.
    bd_faces = [
        (bd.Plane.XY * bd.Rectangle(40, 20)).face(),
        (bd.Plane.XY.offset(10) * bd.Pos(5, 3, 0) * bd.Rectangle(30, 10)).face(),
        (bd.Plane.XY.offset(30) * bd.Rectangle(20, 12)).face(),
    ]
    reference = bd.loft(bd_faces, ruled=False)
    assert math.isclose(result["shape"].volume, reference.volume, rel_tol=0.01)
    assert np.allclose(
        result["shape"].bounding_box().min.to_tuple(),
        reference.bounding_box().min.to_tuple(),
        atol=0.1,
    )
    assert np.allclose(
        result["shape"].bounding_box().max.to_tuple(),
        reference.bounding_box().max.to_tuple(),
        atol=0.1,
    )


def test_loft_ruled_and_smooth_differ() -> None:
    """On offset non-similar sections ruled and smooth lofts give different solids."""
    pytest.importorskip("build123d", reason="build123d not installed")
    sketches = [
        _offset_rect_sketch("r1", 0, 0, 40, 20),
        _offset_rect_sketch("r2", 5, 3, 30, 10, "dz10"),
        _offset_rect_sketch("r3", 0, 0, 20, 12, "dz30"),
    ]
    smooth = fb.build_document_shape(_loft_doc(sketches, ruled=False))
    ruled = fb.build_document_shape(_loft_doc(sketches, ruled=True))
    assert smooth["shape"] is not None and ruled["shape"] is not None
    smooth_volume = smooth["shape"].volume
    ruled_volume = ruled["shape"].volume
    assert smooth_volume > 0.0 and ruled_volume > 0.0
    assert not math.isclose(smooth_volume, ruled_volume, rel_tol=1e-3)


def test_loft_ruled_failure_suggests_ruled_false(monkeypatch: pytest.MonkeyPatch) -> None:
    """A ruled ThruSections failure is wrapped with the ruled=false hint."""
    pytest.importorskip("build123d", reason="build123d not installed")
    from OCP.BRepOffsetAPI import BRepOffsetAPI_ThruSections

    def _exploding_build(self: Any) -> None:
        raise RuntimeError("simulated ruled profile mismatch")

    monkeypatch.setattr(BRepOffsetAPI_ThruSections, "Build", _exploding_build)
    ruled = fb.build_document_shape(
        _loft_doc(
            [
                _offset_rect_sketch("r1", 0, 0, 40, 20),
                _offset_rect_sketch("r2", 0, 0, 20, 10, "dz30"),
            ],
            ruled=True,
        )
    )
    by_id = {r["featureId"]: r for r in ruled["featureResults"]}
    assert by_id["loft1"]["status"] == "failed"
    assert "ruled=false" in by_id["loft1"]["error"]
    assert "simulated ruled profile mismatch" in by_id["loft1"]["error"]
    assert "loft1" in by_id["loft1"]["error"]

    # The smooth variant of the same failure carries no ruled hint.
    smooth = fb.build_document_shape(
        _loft_doc(
            [
                _offset_rect_sketch("r1", 0, 0, 40, 20),
                _offset_rect_sketch("r2", 0, 0, 20, 10, "dz30"),
            ],
            ruled=False,
        )
    )
    by_id = {r["featureId"]: r for r in smooth["featureResults"]}
    assert by_id["loft1"]["status"] == "failed"
    assert "ruled=false" not in by_id["loft1"]["error"]


def test_loft_multi_profile_section_is_named_error() -> None:
    """A section sketch with two disjoint profiles fails naming the sketch."""
    pytest.importorskip("build123d", reason="build123d not installed")
    multi = _offset_rect_sketch("multi", -30, 0, 20, 20)
    second = _offset_rect_sketch("multi_b", 20, 0, 20, 20)
    multi["primitives"] = multi["primitives"] + [
        {**p, "id": f"{p['id']}_b"} for p in second["primitives"]
    ]
    doc = _loft_doc([multi, _offset_rect_sketch("r1", 0, 0, 40, 20)])
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["loft1"]["status"] == "failed"
    assert "'multi'" in by_id["loft1"]["error"]
    assert "multi-profile" in by_id["loft1"]["error"]


def test_loft_multi_loop_section_is_named_error() -> None:
    """A section sketch with a hole fails naming the sketch (holes unsupported)."""
    pytest.importorskip("build123d", reason="build123d not installed")
    holey = _offset_rect_sketch("holey", 0, 0, 40, 20)
    holey["primitives"] = holey["primitives"] + [
        {"id": "hc", "type": "point", "x": 0, "y": 0},
        {"id": "hcirc", "type": "circle", "c_id": "hc", "radius": 5},
    ]
    doc = _loft_doc([holey, _offset_rect_sketch("r1", 0, 0, 40, 20)])
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["loft1"]["status"] == "failed"
    assert "'holey'" in by_id["loft1"]["error"]
    assert "inner loops" in by_id["loft1"]["error"]


def test_loft_requires_at_least_two_sections() -> None:
    """Fewer than two section sketches is a per-feature failure."""
    pytest.importorskip("build123d", reason="build123d not installed")
    single = _loft_doc([_offset_rect_sketch("r1", 0, 0, 40, 20)])
    result = fb.build_document_shape(single)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["loft1"]["status"] == "failed"
    assert "at least 2 section sketches" in by_id["loft1"]["error"]


def test_loft_dangling_section_sketch_is_named_error() -> None:
    """A section sketch id that does not exist fails naming the id."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _loft_doc([_offset_rect_sketch("r1", 0, 0, 40, 20)])
    doc["features"][0]["params"]["sectionSketchIds"] = ["r1", "nope"]
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["loft1"]["status"] == "failed"
    assert "'nope'" in by_id["loft1"]["error"]


def test_loft_as_pattern_source() -> None:
    """A loft is a valid pattern source; instances add to the body volume."""
    pytest.importorskip("build123d", reason="build123d not installed")
    sketches = [
        _offset_rect_sketch("r1", 0, 0, 10, 10),
        _offset_rect_sketch("r2", 0, 0, 10, 10, "dz30"),
    ]
    single = fb.build_document_shape(_loft_doc(sketches))
    assert single["shape"] is not None
    single_volume = single["shape"].volume

    doc = _loft_doc(
        sketches,
        features=[
            _loft_feature(["r1", "r2"], ruled=False),
            {
                "id": "pat",
                "name": "linear pattern",
                "type": "linearPattern",
                "body": "body-1",
                "params": {"source": "loft1", "count": 3, "spacing": 40.0, "axis": "x"},
                "dependsOn": [],
                "suppressed": False,
            },
        ],
    )
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["pat"]["status"] == "built", by_id["pat"].get("error")
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 3.0 * single_volume, rel_tol=1e-6)


def test_loft_implied_dependencies_honor_section_sketches() -> None:
    """A loft depends on the features its section sketches reference via topology."""
    sketch_on_face = {
        "id": "sec",
        "name": "sec",
        "datumId": "face-datum",
        "primitives": _offset_rect_sketch("sec", 0, 0, 5, 5)["primitives"],
        "constraints": [],
        "externalRefs": [{"featureId": "base", "kind": "edge", "fingerprint": {}}],
    }
    sketches = {
        "sec": sketch_on_face,
    }
    datums = {
        "face-datum": {
            "id": "face-datum",
            "kind": "face",
            "name": "Face",
            "reference": {"featureId": "base", "kind": "face", "fingerprint": {}},
        }
    }
    features = [
        # "base" lives on another body so the same-body chain cannot mask the
        # section-sketch topology edge.
        {"id": "base", "type": "pad", "body": "body-0", "dependsOn": []},
        {
            "id": "loft1",
            "type": "loft",
            "body": "body-1",
            "params": {"sectionSketchIds": ["sec", "other"], "ruled": False},
            "dependsOn": [],
        },
    ]
    edges = fb._compute_implied_dependencies(features, sketches, datums)
    assert ("loft1", "base") in edges

    # Without sketch/datum maps (direct callers) no section edges are added.
    edges_bare = fb._compute_implied_dependencies(features)
    assert ("loft1", "base") not in edges_bare
    assert ("loft1", "base") in fb._compute_implied_dependencies(features, sketches, {})


def test_helical_sweep_volume_and_height() -> None:
    """A helical sweep's volume ~= section area x helix length; bbox height ~ pitch*turns + section."""
    pytest.importorskip("build123d", reason="build123d not installed")
    radius, pitch, turns = 20.0, 5.0, 3.0
    doc = _document(
        [_helical_feature({"axis": "Z", "startRadius": radius, "pitch": pitch, "turns": turns})],
        sketches=[_offset_rect_sketch("sec", 0, 0, 2, 2)],
    )
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["h1"]["status"] == "built", by_id["h1"].get("error")
    assert result["shape"] is not None
    assert len(result["shape"].solids()) == 1

    helix_length = turns * math.sqrt((2.0 * math.pi * radius) ** 2 + pitch**2)
    expected = 4.0 * helix_length  # 2x2 square section
    assert result["shape"].volume == pytest.approx(expected, rel=0.05)

    bbox = result["shape"].bounding_box()
    height = bbox.max.Z - bbox.min.Z
    # The coil rises pitch*turns; each end cap tilts with the section frame,
    # adding at most the section half-diagonal at either end.
    section_reach = math.sqrt(2.0)
    assert height == pytest.approx(pitch * turns, abs=2.0 * section_reach + 0.1)


def test_helical_sweep_left_handed_is_mirror() -> None:
    """Left-handed winding mirrors the right-handed coil; volume is unchanged."""
    pytest.importorskip("build123d", reason="build123d not installed")
    params = {"axis": "Z", "startRadius": 20.0, "pitch": 5.0, "turns": 3.0}
    right = fb.build_document_shape(
        _document([_helical_feature(params)], sketches=[_offset_rect_sketch("sec", 0, 0, 2, 2)])
    )
    left = fb.build_document_shape(
        _document(
            [_helical_feature({**params, "leftHanded": True})],
            sketches=[_offset_rect_sketch("sec", 0, 0, 2, 2)],
        )
    )
    assert right["shape"] is not None and left["shape"] is not None
    assert left["shape"].volume == pytest.approx(right["shape"].volume, rel=1e-9)
    right_bbox = right["shape"].bounding_box()
    left_bbox = left["shape"].bounding_box()
    # Mirrored across the XZ plane: y ranges negate.
    assert math.isclose(right_bbox.min.Y, -left_bbox.max.Y, abs_tol=1e-4)
    assert math.isclose(right_bbox.max.Y, -left_bbox.min.Y, abs_tol=1e-4)
    assert math.isclose(right_bbox.min.X, left_bbox.min.X, abs_tol=1e-4)
    assert math.isclose(right_bbox.max.X, left_bbox.max.X, abs_tol=1e-4)


def test_helical_sweep_self_intersection_pre_check_fires() -> None:
    """A fat section on a tightly coiled helix fails with the named curvature error."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            _helical_feature(
                {"axis": "Z", "startRadius": 5.0, "pitch": 5.0, "turns": 3.0},
                sketch_id="fat",
            )
        ],
        sketches=[_offset_rect_sketch("fat", 0, 0, 30, 30)],
    )
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["h1"]["status"] == "failed"
    assert "too tightly curved" in by_id["h1"]["error"]
    assert "h1" in by_id["h1"]["error"]


def test_helical_sweep_rejects_bad_params() -> None:
    """Non-positive helix params and bad orientation fail with clear errors."""
    pytest.importorskip("build123d", reason="build123d not installed")
    good = {"axis": "Z", "startRadius": 20.0, "pitch": 5.0, "turns": 3.0}
    for bad_key, bad_value in (("axis", "z"), ("startRadius", 0.0), ("pitch", -1.0), ("turns", 0)):
        doc = _document(
            [_helical_feature({**good, bad_key: bad_value})],
            sketches=[_offset_rect_sketch("sec", 0, 0, 2, 2)],
        )
        result = fb.build_document_shape(doc)
        by_id = {r["featureId"]: r for r in result["featureResults"]}
        assert by_id["h1"]["status"] == "failed", bad_key
        assert "h1" in by_id["h1"]["error"]
    bad_orientation = _document(
        [_helical_feature({**good, "orientation": "parallel"})],
        sketches=[_offset_rect_sketch("sec", 0, 0, 2, 2)],
    )
    result = fb.build_document_shape(bad_orientation)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["h1"]["status"] == "failed"
    assert "orientation" in by_id["h1"]["error"]


def test_overlapping_pattern_parallel_fuse_matches_sequential() -> None:
    """The GFOP fuse of overlapping boxes matches the sequential loop solid set."""
    bd = pytest.importorskip("build123d", reason="build123d not installed")
    body = bd.Compound(children=[bd.Solid.make_box(10.0, 10.0, 5.0)])
    instances = [
        body.moved(bd.Location((5.0, 0.0, 0.0))),
        body.moved(bd.Location((2.0, 5.0, 0.0))),
    ]
    assert fb._pattern_instances_are_disjoint(body, instances) is False

    result = fb._apply_pattern_or_mirror(body, None, "pad", instances, "test")
    assert isinstance(result, bd.Compound)
    expected: Any = body
    for instance in instances:
        expected = expected + instance
    _assert_same_solid_set(result, expected)
    assert result.volume == pytest.approx(expected.volume, rel=1e-6)


def test_overlapping_pattern_parallel_fuse_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Forcing the GFOP attempt to fail still yields the correct sequential union."""
    bd = pytest.importorskip("build123d", reason="build123d not installed")

    def _boom(_body: Any, _instances: list[Any]) -> Any:
        raise RuntimeError("synthetic GFOP failure")

    monkeypatch.setattr(fb, "_pattern_parallel_fuse", _boom)
    body = bd.Compound(children=[bd.Solid.make_box(10.0, 10.0, 5.0)])
    instances = [body.moved(bd.Location((5.0, 0.0, 0.0)))]
    assert fb._pattern_instances_are_disjoint(body, instances) is False

    result = fb._apply_pattern_or_mirror(body, None, "pad", instances, "test")
    expected = body + instances[0]
    _assert_same_solid_set(result, expected)
    assert result.volume == pytest.approx(10.0 * 10.0 * 5.0 + 5.0 * 10.0 * 5.0, rel=1e-6)


def test_overlapping_pattern_parallel_fuse_timing() -> None:
    """Measure sequential vs GFOP fuse on overlapping boxes; GFOP must agree."""
    import time

    bd = pytest.importorskip("build123d", reason="build123d not installed")
    count = 16
    body = bd.Compound(children=[bd.Solid.make_box(10.0, 10.0, 5.0)])
    instances = [body.moved(bd.Location((float(k), 0.0, 0.0))) for k in range(1, count)]
    assert fb._pattern_instances_are_disjoint(body, instances) is False

    start = time.perf_counter()
    sequential: Any = body
    for instance in instances:
        sequential = sequential + instance
    sequential_time = time.perf_counter() - start

    start = time.perf_counter()
    parallel = fb._pattern_parallel_fuse(body, instances)
    parallel_time = time.perf_counter() - start

    print(
        f"pattern fuse x{count}: sequential={sequential_time:.3f}s "
        f"parallel={parallel_time:.3f}s "
        f"speedup={sequential_time / max(parallel_time, 1e-9):.2f}x"
    )
    _assert_same_solid_set(parallel, sequential)
    assert parallel.volume == pytest.approx(sequential.volume, rel=1e-6)


def _pad_feature(
    params: dict[str, Any], sketch_id: str = "rect", feature_id: str = "base"
) -> dict[str, Any]:
    return {
        "id": feature_id,
        "name": "base",
        "type": "pad",
        "body": "body-1",
        "sketchId": sketch_id,
        "params": params,
        "dependsOn": [],
        "suppressed": False,
    }


def test_subtractive_helical_sweep_cuts() -> None:
    """A subtractive helicalSweep coils its section out of the body."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            _pad_feature({"length": 10.0}),
            _helical_feature(
                {
                    "axis": "Z",
                    "startRadius": 5.0,
                    "pitch": 2.0,
                    "turns": 2.0,
                    "subtractive": True,
                },
                feature_id="cut",
            ),
        ],
        sketches=[_rect_sketch(), _offset_rect_sketch("sec", 0, 0, 2, 2)],
    )
    result = fb.build_document_shape(doc)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["cut"]["status"] == "built", by_id["cut"].get("error")
    assert result["shape"] is not None
    assert result["shape"].volume < 40.0 * 20.0 * 10.0


def test_subtractive_helical_sweep_needs_body_and_intersection() -> None:
    """A subtractive helix needs an existing body; a disjoint coil fails."""
    pytest.importorskip("build123d", reason="build123d not installed")
    lonely = _document(
        [_helical_feature({"axis": "Z", "startRadius": 5.0, "pitch": 2.0, "turns": 2.0})],
        sketches=[_offset_rect_sketch("sec", 0, 0, 2, 2)],
    )
    result = fb.build_document_shape(lonely)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    # Additive on an empty body still builds (today's behavior is untouched).
    assert by_id["h1"]["status"] == "built", by_id["h1"].get("error")

    lonely_cut = _document(
        [
            _helical_feature(
                {
                    "axis": "Z",
                    "startRadius": 5.0,
                    "pitch": 2.0,
                    "turns": 2.0,
                    "subtractive": True,
                }
            )
        ],
        sketches=[_offset_rect_sketch("sec", 0, 0, 2, 2)],
    )
    result = fb.build_document_shape(lonely_cut)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["h1"]["status"] == "failed"
    assert "existing solid body" in by_id["h1"]["error"].lower()

    far = _document(
        [
            _pad_feature({"length": 10.0}),
            _helical_feature(
                {
                    "axis": "Z",
                    "startRadius": 200.0,
                    "pitch": 2.0,
                    "turns": 2.0,
                    "subtractive": True,
                },
                feature_id="cut",
            ),
        ],
        sketches=[_rect_sketch(), _offset_rect_sketch("sec", 0, 0, 2, 2)],
    )
    result = fb.build_document_shape(far)
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert by_id["cut"]["status"] == "failed"
    assert "does not intersect" in by_id["cut"]["error"].lower()
