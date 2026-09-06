#!/usr/bin/env python3
"""Pad/pocket end conditions (blind/upToFirst/upToLast/upToFace/throughAll/twoSided).

Blind is the default; non-blind ends terminate on the target body and a
missed end fails with the existing "does not intersect" error.
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

import feature_builder as fb
import pytest
from doc_build_helpers import (
    _build_base_and_capture_top_face,
    _by_id,
    _document,
    _face_ref,
    _feature,
    _rect_sketch,
    _slab_setup,
)


def test_pad_up_to_first_bridges_gap() -> None:
    """upToFirst extrudes to the nearest intersection with the body."""
    pytest.importorskip("build123d", reason="build123d not installed")
    datums, sketches, features = _slab_setup()
    features.append(_feature("bridge", "pad", {"end": "upToFirst"}, "r3"))
    result = fb.build_document_shape(_document(features, sketches, datums=datums))
    assert _by_id(result)["bridge"]["status"] == "built"
    # 500 + 200 base slabs plus the 4x4x3 gap bridge (z 5..8).
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 748.0, rel_tol=1e-6)


def test_pad_up_to_last_reaches_far_face() -> None:
    """upToLast extrudes to the farthest intersection with the body.

    Three slabs separate First from Last: the far segment crosses a second
    empty gap, so Last adds both bridges while First adds only the first.
    """
    pytest.importorskip("build123d", reason="build123d not installed")
    datums, sketches, features = _slab_setup()
    datums.append({"id": "off15", "kind": "offset", "name": "offset 15", "offset": 15.0})
    sketches.append(_rect_sketch(10.0, 10.0, "r4", datum_id="off15"))
    features.append(_feature("s3", "pad", {"length": 2.0}, "r4"))
    features.append(_feature("bridge", "pad", {"end": "upToLast"}, "r3"))
    result = fb.build_document_shape(_document(features, sketches, datums=datums))
    assert _by_id(result)["bridge"]["status"] == "built"
    # Slabs 500 + 200 + 200 plus both 4x4 bridges (z 5..8 and z 10..15).
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 1028.0, rel_tol=1e-6)


def test_pad_up_to_first_stops_before_far_slab() -> None:
    """First and Last differ exactly by the far gap on the three-slab body."""
    pytest.importorskip("build123d", reason="build123d not installed")
    datums, sketches, features = _slab_setup()
    datums.append({"id": "off15", "kind": "offset", "name": "offset 15", "offset": 15.0})
    sketches.append(_rect_sketch(10.0, 10.0, "r4", datum_id="off15"))
    features.append(_feature("s3", "pad", {"length": 2.0}, "r4"))
    features.append(_feature("bridge", "pad", {"end": "upToFirst"}, "r3"))
    result = fb.build_document_shape(_document(features, sketches, datums=datums))
    assert _by_id(result)["bridge"]["status"] == "built"
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 948.0, rel_tol=1e-6)


def test_pad_through_all_spans_body() -> None:
    """throughAll spans the body's bbox diagonal along the direction."""
    pytest.importorskip("build123d", reason="build123d not installed")
    datums, sketches, features = _slab_setup()
    datums.append({"id": "off15", "kind": "offset", "name": "offset 15", "offset": 15.0})
    sketches.append(_rect_sketch(10.0, 10.0, "r4", datum_id="off15"))
    features.append(_feature("s3", "pad", {"length": 2.0}, "r4"))
    features.append(_feature("bridge", "pad", {"end": "throughAll"}, "r3"))
    result = fb.build_document_shape(_document(features, sketches, datums=datums))
    assert _by_id(result)["bridge"]["status"] == "built"
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 1028.0, rel_tol=1e-6)


def test_pocket_through_all_cuts_column() -> None:
    """A throughAll pocket removes the full footprint column."""
    pytest.importorskip("build123d", reason="build123d not installed")
    datums = [
        {"id": "dxy", "kind": "XY", "name": "XY"},
        {"id": "offm2", "kind": "offset", "name": "offset -2", "offset": -2.0},
    ]
    sketches = [
        _rect_sketch(10.0, 10.0, "r1"),
        _rect_sketch(4.0, 4.0, "rp", datum_id="offm2", dx=3.0, dy=3.0),
    ]
    doc = _document(
        [
            _feature("base", "pad", {"length": 5.0}, "r1"),
            _feature("cut", "pocket", {"end": "throughAll"}, "rp"),
        ],
        sketches,
        datums=datums,
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["cut"]["status"] == "built"
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 500.0 - 80.0, rel_tol=1e-6)


def test_pocket_up_to_last_matches_through_cut() -> None:
    """A bottom-up upToLast pocket removes the same column as throughAll here."""
    pytest.importorskip("build123d", reason="build123d not installed")
    datums = [
        {"id": "dxy", "kind": "XY", "name": "XY"},
        {"id": "offm2", "kind": "offset", "name": "offset -2", "offset": -2.0},
    ]
    sketches = [
        _rect_sketch(10.0, 10.0, "r1"),
        _rect_sketch(4.0, 4.0, "rp", datum_id="offm2", dx=3.0, dy=3.0),
    ]
    doc = _document(
        [
            _feature("base", "pad", {"length": 5.0}, "r1"),
            _feature("cut", "pocket", {"end": "upToLast"}, "rp"),
        ],
        sketches,
        datums=datums,
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["cut"]["status"] == "built"
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 420.0, rel_tol=1e-6)


def test_pocket_up_to_face_stops_at_named_face() -> None:
    """upToFace stops the cut at the named face, leaving farther slabs whole."""
    pytest.importorskip("build123d", reason="build123d not installed")
    datums = [
        {"id": "dxy", "kind": "XY", "name": "XY"},
        {"id": "off7", "kind": "offset", "name": "offset 7", "offset": 7.0},
        {"id": "offm2", "kind": "offset", "name": "offset -2", "offset": -2.0},
    ]
    sketches = [
        _rect_sketch(10.0, 10.0, "r1"),
        _rect_sketch(10.0, 10.0, "r2", datum_id="off7"),
        _rect_sketch(4.0, 4.0, "rp", datum_id="offm2", dx=3.0, dy=3.0),
    ]
    pre = fb.build_document_shape(
        _document(
            [
                _feature("s1", "pad", {"length": 5.0}, "r1"),
                _feature("s2", "pad", {"length": 3.0}, "r2"),
            ],
            sketches,
            datums=datums,
        )
    )
    assert pre["shape"] is not None
    slab2_bottom = _face_ref(
        "s2",
        pre["shape"].wrapped,
        lambda f: (
            f.surface_type == "plane"
            and f.normal is not None
            and f.normal[2] < -0.9
            and abs(f.center[2] - 7.0) < 0.1
        ),
    )
    doc = _document(
        [
            _feature("s1", "pad", {"length": 5.0}, "r1"),
            _feature("s2", "pad", {"length": 3.0}, "r2"),
            _feature("cut", "pocket", {"end": "upToFace", "upToFace": slab2_bottom}, "rp"),
        ],
        sketches,
        datums=datums,
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["cut"]["status"] == "built"
    # Only the lower slab's 4x4 column is removed; the upper slab is untouched.
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 720.0, rel_tol=1e-6)


def test_pad_up_to_face_cross_body_uses_historical_shape() -> None:
    """upToFace works as the first feature on a body via the predecessor shape."""
    pytest.importorskip("build123d", reason="build123d not installed")
    top_ref, _shape = _build_base_and_capture_top_face(length=5.0)
    doc = _document(
        [
            _feature("base", "pad", {"length": 5.0}, "rect"),
            _feature(
                "bridge",
                "pad",
                {"end": "upToFace", "upToFace": top_ref},
                "small",
                body="body-2",
            ),
        ],
        [_rect_sketch(), _rect_sketch(4.0, 4.0, "small", dx=3.0, dy=3.0)],
        bodies=[{"id": "body-1", "name": "B1"}, {"id": "body-2", "name": "B2"}],
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["bridge"]["status"] == "built"
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 500.0 + 80.0, rel_tol=1e-6)


def test_pad_up_to_face_lenient_without_end() -> None:
    """Legacy docs carrying upToFace without end upgrade to upToFace mode."""
    pytest.importorskip("build123d", reason="build123d not installed")
    top_ref, _shape = _build_base_and_capture_top_face(length=5.0)
    doc = _document(
        [
            _feature("base", "pad", {"length": 5.0}, "rect"),
            _feature("pad2", "pad", {"length": 2.0, "upToFace": top_ref}, "rect"),
        ],
        [_rect_sketch()],
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["pad2"]["status"] == "built"
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 500.0, rel_tol=1e-6)


def test_two_sided_blind_matches_symmetric() -> None:
    """twoSided splits length equally both ways, like symmetric."""
    pytest.importorskip("build123d", reason="build123d not installed")
    symmetric = fb.build_document_shape(
        _document(
            [_feature("pad", "pad", {"length": 6.0, "symmetric": True}, "rect")],
            [_rect_sketch()],
        )
    )
    two_sided = fb.build_document_shape(
        _document(
            [_feature("pad", "pad", {"length": 6.0, "twoSided": True}, "rect")],
            [_rect_sketch()],
        )
    )
    assert symmetric["shape"] is not None and two_sided["shape"] is not None
    assert math.isclose(two_sided["shape"].volume, 600.0, rel_tol=1e-6)
    assert math.isclose(two_sided["shape"].volume, symmetric["shape"].volume, rel_tol=1e-9)
    assert math.isclose(two_sided["shape"].bounding_box().min.Z, -3.0, abs_tol=1e-9)
    assert math.isclose(two_sided["shape"].bounding_box().max.Z, 3.0, abs_tol=1e-9)


def test_up_to_end_without_intersection_fails() -> None:
    """A footprint that misses the body is a does-not-intersect error."""
    pytest.importorskip("build123d", reason="build123d not installed")
    far = {
        "id": "far",
        "name": "far",
        "datumId": "dxy",
        "primitives": [
            {"id": "c", "type": "point", "x": 1000.0, "y": 1000.0},
            {"id": "circ", "type": "circle", "c_id": "c", "radius": 3.0},
        ],
        "constraints": [],
    }
    doc = _document(
        [
            _feature("base", "pad", {"length": 5.0}, "rect"),
            _feature("bridge", "pad", {"end": "upToLast"}, "far"),
        ],
        [_rect_sketch(), far],
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["bridge"]["status"] == "failed"
    assert "does not intersect" in _by_id(result)["bridge"]["error"].lower()


def test_up_to_end_on_empty_body_fails() -> None:
    """First/Last/ThroughAll with no body B-rep is a does-not-intersect error."""
    pytest.importorskip("build123d", reason="build123d not installed")
    for end in ("upToFirst", "upToLast", "throughAll"):
        doc = _document(
            [_feature("pad", "pad", {"end": end}, "rect", body="body-2")],
            [_rect_sketch()],
            bodies=[{"id": "body-1", "name": "B1"}, {"id": "body-2", "name": "B2"}],
        )
        result = fb.build_document_shape(doc)
        assert _by_id(result)["pad"]["status"] == "failed", end
        assert "does not intersect" in _by_id(result)["pad"]["error"].lower(), end


def test_symmetric_and_two_sided_require_blind() -> None:
    """Splitting length both ways is meaningless for measured ends."""
    pytest.importorskip("build123d", reason="build123d not installed")
    for extra in ({"symmetric": True}, {"twoSided": True}):
        doc = _document(
            [_feature("pad", "pad", {"length": 5.0, "end": "throughAll", **extra}, "rect")],
            [_rect_sketch()],
        )
        result = fb.build_document_shape(doc)
        assert _by_id(result)["pad"]["status"] == "failed", extra
        assert "blind" in _by_id(result)["pad"]["error"].lower(), extra


def test_unknown_end_fails() -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [_feature("pad", "pad", {"end": "sideways"}, "rect")],
        [_rect_sketch()],
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["pad"]["status"] == "failed"
    assert "unknown" in _by_id(result)["pad"]["error"].lower()


def test_pocket_up_to_face_without_body_fails() -> None:
    """A pocket still needs an existing body even when the face resolves."""
    pytest.importorskip("build123d", reason="build123d not installed")
    top_ref, _shape = _build_base_and_capture_top_face(length=5.0)
    doc = _document(
        [
            _feature("base", "pad", {"length": 5.0}, "rect"),
            _feature(
                "cut",
                "pocket",
                {"end": "upToFace", "upToFace": top_ref},
                "rect",
                body="body-2",
            ),
        ],
        [_rect_sketch()],
        bodies=[{"id": "body-1", "name": "B1"}, {"id": "body-2", "name": "B2"}],
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["cut"]["status"] == "failed"
    assert "existing solid body" in _by_id(result)["cut"]["error"].lower()


def _revolve_doc(extra_params: dict, y0: float = 2.0, dx: float = 20.0, dy: float = 20.0) -> dict:
    """Pad base plus a second-feature revolve over the 1x1 profile at y0..y0+1.

    The default base sits at (20, 20) so the small ring around the X axis
    stays disjoint from it (blind additive revolve rejects overlaps); the
    groove test overrides placement so its tool intersects the base instead.
    """
    sketch = {
        "id": "rev",
        "name": "rev",
        "datumId": "dxy",
        "primitives": [
            {"id": "p1", "type": "point", "x": 0, "y": y0},
            {"id": "p2", "type": "point", "x": 1, "y": y0},
            {"id": "p3", "type": "point", "x": 1, "y": y0 + 1},
            {"id": "p4", "type": "point", "x": 0, "y": y0 + 1},
            {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
            {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
            {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
            {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
        ],
        "constraints": [],
    }
    params = {"axis": "x", "angle": 360}
    params.update(extra_params)
    return _document(
        [
            _feature("base", "pad", {"length": 5.0}, "rect"),
            {
                "id": "rev",
                "name": "rev",
                "type": "revolve",
                "sketchId": "rev",
                "body": "body-1",
                "params": params,
                "dependsOn": [],
                "suppressed": False,
            },
        ],
        [_rect_sketch(10.0, 10.0, "rect", dx=dx, dy=dy), sketch],
    )


def test_revolve_end_validation_pure() -> None:
    """Revolve ends accept only blind/throughAll; the UpTo set stays pad-only."""
    assert fb._revolve_end_mode({}, "r") == "blind"
    assert fb._revolve_end_mode({"end": None}, "r") == "blind"
    assert fb._revolve_end_mode({"end": "throughAll"}, "r") == "throughAll"
    for bad in ("upToFirst", "upToLast", "upToFace", "sideways", 42):
        with pytest.raises(fb.FeatureBuilderError, match="blind.*throughAll"):
            fb._revolve_end_mode({"end": bad}, "r")
    for stray in ("upToFace", "upToBody"):
        with pytest.raises(fb.FeatureBuilderError, match="not yet supported"):
            fb._validate_revolve_params({"end": "blind", stray: {"a": 1}}, "r")
    assert fb._is_revolve_through_all({"type": "revolve", "params": {"end": "throughAll"}})
    assert not fb._is_revolve_through_all({"type": "revolve", "params": {}})
    assert not fb._is_revolve_through_all({"type": "groove", "params": {"end": "throughAll"}})
    assert not fb._is_revolve_through_all({"type": "pad", "params": {"end": "throughAll"}})


def test_revolve_through_all_spans_body_diagonal() -> None:
    """A throughAll revolve fuses the blind tool plus the diagonal slab."""
    pytest.importorskip("build123d", reason="build123d not installed")
    blind = fb.build_document_shape(_revolve_doc({}))
    assert _by_id(blind)["rev"]["status"] == "built"
    through = fb.build_document_shape(_revolve_doc({"end": "throughAll"}))
    assert _by_id(through)["rev"]["status"] == "built"
    assert through["shape"] is not None and blind["shape"] is not None
    assert through["shape"].volume > blind["shape"].volume
    # The 10x10x5 pad has bbox diagonal 15: the slab spans z -15..15, so the
    # fused compound reaches z = 15 while the blind build stops at the pad's
    # z = 5 (the small ring only reaches z = 3).
    bbox = through["shape"].bounding_box()
    assert bbox.max.Z == pytest.approx(15.0, abs=1e-6)
    assert blind["shape"].bounding_box().max.Z == pytest.approx(5.0, abs=1e-6)


def test_revolve_through_all_without_body_fails() -> None:
    """A throughAll revolve on an empty body misses like a pad throughAll."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            {
                "id": "rev",
                "name": "rev",
                "type": "revolve",
                "sketchId": "rev",
                "body": "body-1",
                "params": {"axis": "x", "angle": 360, "end": "throughAll"},
                "dependsOn": [],
                "suppressed": False,
            }
        ],
        [_revolve_doc({})["sketches"][1]],
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["rev"]["status"] == "failed"
    assert "does not intersect" in _by_id(result)["rev"]["error"].lower()


def test_groove_through_all_cuts() -> None:
    """A throughAll groove cuts the revolve tool plus the spanning slab."""
    pytest.importorskip("build123d", reason="build123d not installed")
    # The groove profile sits over the origin-anchored pad (y 4..5) so the
    # tool intersects.
    doc = _revolve_doc({}, y0=4.0, dx=0.0, dy=0.0)
    groove = {
        "id": "rev",
        "name": "rev",
        "type": "groove",
        "sketchId": "rev",
        "body": "body-1",
        "params": {"axis": "x", "angle": 360, "end": "throughAll"},
        "dependsOn": [],
        "suppressed": False,
    }
    doc["features"] = [doc["features"][0], groove]
    result = fb.build_document_shape(doc)
    assert _by_id(result)["rev"]["status"] == "built"
    assert result["shape"] is not None
    # The slab column (1x1 through the 5-thick pad) plus the ring are gone.
    assert result["shape"].volume < 500.0


def _two_body_bridge_doc(end: str, use_up_to_body: str | None) -> dict:
    """Base slabs on two bodies plus a body-1 bridge measuring body-2."""
    datums = [
        {"id": "dxy", "kind": "XY", "name": "XY"},
        {"id": "off8", "kind": "offset", "name": "offset 8", "offset": 8.0},
        {"id": "off5", "kind": "offset", "name": "offset 5", "offset": 5.0},
    ]
    sketches = [
        _rect_sketch(10.0, 10.0, "r1"),
        _rect_sketch(10.0, 10.0, "r2", datum_id="off8"),
        _rect_sketch(4.0, 4.0, "r3", datum_id="off5", dx=3.0, dy=3.0),
    ]
    params: dict = {"end": end}
    if use_up_to_body is not None:
        params["upToBody"] = use_up_to_body
    features = [
        _feature("s1", "pad", {"length": 5.0}, "r1", body="body-1"),
        _feature("s2", "pad", {"length": 2.0}, "r2", body="body-2"),
        # The target body's tip must precede the dependent (same predecessor
        # discipline as boolean tool bodies); the implied edge then pins the
        # order for the topological sort.
        _feature("bridge", "pad", params, "r3", body="body-1"),
    ]
    return _document(
        features,
        sketches,
        bodies=[{"id": "body-1", "name": "B1"}, {"id": "body-2", "name": "B2"}],
        datums=datums,
    )


def test_up_to_body_first_measures_other_body() -> None:
    """upToFirst + upToBody terminates at the other body's nearest extent."""
    pytest.importorskip("build123d", reason="build123d not installed")
    result = fb.build_document_shape(_two_body_bridge_doc("upToFirst", "body-2"))
    assert _by_id(result)["bridge"]["status"] == "built"
    assert result["shape"] is not None
    # 500 + 200 slabs plus the 4x4x3 gap bridge (z 5..8).
    assert math.isclose(result["shape"].volume, 748.0, rel_tol=1e-6)


def test_up_to_body_last_measures_other_body() -> None:
    """upToLast + upToBody terminates at the other body's farthest extent."""
    pytest.importorskip("build123d", reason="build123d not installed")
    result = fb.build_document_shape(_two_body_bridge_doc("upToLast", "body-2"))
    assert _by_id(result)["bridge"]["status"] == "built"
    assert result["shape"] is not None
    # The bridge spans z 5..10 through the second slab's far face.
    assert math.isclose(result["shape"].volume, 500.0 + 200.0 + 80.0, rel_tol=1e-6)


def test_up_to_body_unknown_body_fails() -> None:
    """A missing upToBody target is a clear validation error, not a miss."""
    pytest.importorskip("build123d", reason="build123d not installed")
    result = fb.build_document_shape(_two_body_bridge_doc("upToFirst", "body-9"))
    assert _by_id(result)["bridge"]["status"] == "failed"
    assert "unknown body" in _by_id(result)["bridge"]["error"].lower()


def test_up_to_body_resolution_pure() -> None:
    """Target resolution needs no geometry kernel: shapes stay opaque."""
    own, other = object(), object()
    shapes = {"body-1": own, "body-2": other}
    ids = ["body-1", "body-2"]
    assert fb._resolve_up_to_body_target({}, "upToFirst", "f", "pad", "body-1", shapes, ids) is own
    assert (
        fb._resolve_up_to_body_target(
            {"upToBody": "body-2"}, "upToLast", "f", "pad", "body-1", shapes, ids
        )
        is other
    )
    with pytest.raises(fb.FeatureBuilderError, match="unknown body"):
        fb._resolve_up_to_body_target(
            {"upToBody": "body-9"}, "upToFirst", "f", "pad", "body-1", shapes, ids
        )
    with pytest.raises(fb.FeatureBuilderError, match="no geometry"):
        fb._resolve_up_to_body_target(
            {"upToBody": "body-2"}, "upToFirst", "f", "pad", "body-1", {"body-1": own}, ids
        )
    with pytest.raises(fb.FeatureBuilderError, match="body id string"):
        fb._resolve_up_to_body_target(
            {"upToBody": 42}, "upToFirst", "f", "pad", "body-1", shapes, ids
        )
    for end in ("blind", "throughAll", "upToFace"):
        with pytest.raises(fb.FeatureBuilderError, match="requires end"):
            fb._resolve_up_to_body_target(
                {"upToBody": "body-2"}, end, "f", "pocket", "body-1", shapes, ids
            )
