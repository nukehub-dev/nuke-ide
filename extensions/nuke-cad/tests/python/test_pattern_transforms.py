#!/usr/bin/env python3
"""Per-instance pattern scale and multiTransform chaining.

Minimal-profile tests exercise the pure layout/validation helpers;
full-profile tests verify solid modeling semantics.
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
from typing import Any

import feature_builder as fb
import pytest
from doc_build_helpers import _by_id, _document, _feature, _rect_sketch, _top_face


def test_mirror_scale() -> None:
    """The mirrored copy scales about its own center; the original is untouched."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            _feature("pad", "pad", {"length": 5.0}, "off"),
            _feature("mirror", "mirror", {"source": "pad", "plane": "YZ", "scale": 2.0}),
        ],
        [_rect_sketch(10.0, 10.0, "off", dx=15.0)],
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["mirror"]["status"] == "built"
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 500.0 + 8.0 * 500.0, rel_tol=1e-6)


def test_pattern_scale_validation() -> None:
    """Non-positive scales are build errors."""
    pytest.importorskip("build123d", reason="build123d not installed")
    for scale in (0.0, -1.0):
        doc = _document(
            [
                _feature("pad", "pad", {"length": 5.0}, "rect"),
                _feature(
                    "lin",
                    "linearPattern",
                    {"source": "pad", "count": 2, "spacing": 30.0, "axis": "x", "scale": scale},
                ),
            ],
            [_rect_sketch()],
        )
        result = fb.build_document_shape(doc)
        assert _by_id(result)["lin"]["status"] == "failed", scale
        assert "scale" in _by_id(result)["lin"]["error"].lower(), scale


def test_multi_transform_grid_volume() -> None:
    """multiTransform builds the cartesian product through the union path."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            _feature("pad", "pad", {"length": 5.0}, "off"),
            _feature(
                "linx",
                "linearPattern",
                {"source": "pad", "count": 2, "spacing": 20.0, "axis": "x"},
            ),
            _feature(
                "liny",
                "linearPattern",
                {"source": "pad", "count": 2, "spacing": 20.0, "axis": "y"},
            ),
            _feature("multi", "multiTransform", {"first": "linx", "second": "liny"}),
        ],
        [_rect_sketch(10.0, 10.0, "off", dx=15.0)],
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["multi"]["status"] == "built"
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 4.0 * 500.0, rel_tol=1e-6)
    assert len(result["shape"].solids()) == 4


def test_multi_transform_subtractive_second_cuts_product() -> None:
    """A subtractive second pattern cuts each product shape sequentially."""
    pytest.importorskip("build123d", reason="build123d not installed")
    top_ref_holder: list[dict[str, Any]] = []
    base_doc = _document(
        [_feature("base", "pad", {"length": 5.0}, "base")],
        [_rect_sketch(30.0, 20.0, "base")],
    )
    base_result = fb.build_document_shape(base_doc)
    assert base_result["shape"] is not None
    top_ref_holder.append(_top_face(base_result["shape"].wrapped, "base"))

    pocket = _rect_sketch(4.0, 4.0, "pk", dx=2.0, dy=8.0)
    # Boss sketch is centered on the top face workplane: [-3..1] x [-1..3]
    # maps to [20..24] x [8..12] in world coordinates.
    boss = _rect_sketch(4.0, 4.0, "boss", datum_id="fd", dx=-3.0, dy=-1.0)
    datums = [
        {"id": "dxy", "kind": "XY", "name": "XY"},
        {"id": "fd", "kind": "face", "name": "FD", "reference": top_ref_holder[0]},
    ]
    doc = _document(
        [
            _feature("base", "pad", {"length": 5.0}, "base"),
            _feature("boss", "pad", {"length": 2.0}, "boss"),
            _feature("cut", "pocket", {"length": 3.0}, "pk"),
            _feature(
                "linB",
                "linearPattern",
                {"source": "boss", "count": 2, "spacing": 8.0, "axis": "x"},
            ),
            _feature(
                "linP",
                "linearPattern",
                {"source": "cut", "count": 2, "spacing": 8.0, "axis": "x"},
            ),
            _feature("multi", "multiTransform", {"first": "linB", "second": "linP"}),
        ],
        [_rect_sketch(30.0, 20.0, "base"), pocket, boss],
        datums=datums,
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["multi"]["status"] == "built"
    # Base 3000, two pocket cuts (96), two bosses (64), and the product cut
    # removes the second boss copy (32); the far product copy misses cleanly.
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 3000.0 - 96.0 + 64.0 - 32.0, rel_tol=1e-6)


def test_multi_transform_validation() -> None:
    """Sources must be same-body patterns; unknown ids fail at sort time."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            _feature("pad", "pad", {"length": 5.0}, "off"),
            _feature(
                "lin",
                "linearPattern",
                {"source": "pad", "count": 2, "spacing": 20.0, "axis": "x"},
            ),
            _feature("multi", "multiTransform", {"first": "lin", "second": "pad"}),
        ],
        [_rect_sketch(10.0, 10.0, "off", dx=15.0)],
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["multi"]["status"] == "failed"
    assert "pattern or mirror" in _by_id(result)["multi"]["error"].lower()

    other_body = _document(
        [
            _feature("pad", "pad", {"length": 5.0}, "off"),
            _feature(
                "lin",
                "linearPattern",
                {"source": "pad", "count": 2, "spacing": 20.0, "axis": "x"},
            ),
            _feature("other", "pad", {"length": 1.0}, "off", body="body-2"),
            _feature("multi", "multiTransform", {"first": "lin", "second": "lin"}, body="body-2"),
        ],
        [_rect_sketch(10.0, 10.0, "off", dx=15.0)],
        bodies=[{"id": "body-1", "name": "B1"}, {"id": "body-2", "name": "B2"}],
    )
    other_result = fb.build_document_shape(other_body)
    assert _by_id(other_result)["multi"]["status"] == "failed"
    assert "same body" in _by_id(other_result)["multi"]["error"].lower()


def test_multi_transform_unknown_source_fails_at_sort() -> None:
    """An unknown multiTransform source is an unknown-dependency sort error."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            _feature("pad", "pad", {"length": 5.0}, "rect"),
            _feature("multi", "multiTransform", {"first": "missing", "second": "missing"}),
        ],
        [_rect_sketch()],
    )
    with pytest.raises(fb.FeatureBuilderError, match="unknown feature 'missing'"):
        fb.build_document_shape(doc)


def test_multi_transform_cannot_be_pattern_source() -> None:
    """Patterns only accept solid producers; multiTransform stores no tool."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            _feature("pad", "pad", {"length": 5.0}, "off"),
            _feature(
                "linx",
                "linearPattern",
                {"source": "pad", "count": 2, "spacing": 20.0, "axis": "x"},
            ),
            _feature(
                "liny",
                "linearPattern",
                {"source": "pad", "count": 2, "spacing": 20.0, "axis": "y"},
            ),
            _feature("multi", "multiTransform", {"first": "linx", "second": "liny"}),
            _feature(
                "again",
                "linearPattern",
                {"source": "multi", "count": 2, "spacing": 5.0, "axis": "x"},
            ),
        ],
        [_rect_sketch(10.0, 10.0, "off", dx=15.0)],
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["again"]["status"] == "failed"
    assert "solid-producing feature" in _by_id(result)["again"]["error"].lower()


def test_pattern_layout_helpers_pure() -> None:
    """Instance layouts include the identity first, matching the builders."""
    assert fb._linear_pattern_offsets(3, 12.0, "x") == [
        (0.0, 0.0, 0.0),
        (12.0, 0.0, 0.0),
        (24.0, 0.0, 0.0),
    ]
    assert fb._circular_pattern_angles(4, 360.0) == [0.0, 90.0, 180.0, 270.0]
    assert fb._circular_pattern_angles(3, 180.0) == [0.0, 90.0, 180.0]
    assert fb._circular_pattern_angles(1, 360.0) == [0.0]


def test_pattern_scale_validation_pure() -> None:
    """Scale defaults to 1; non-positive or non-finite scales raise."""
    assert fb._pattern_scale({}, "f") == 1.0
    assert fb._pattern_scale({"scale": None}, "f") == 1.0
    assert fb._pattern_scale({"scale": 2}, "f") == 2.0
    for bad in (0, 0.0, -1.0, float("nan"), float("inf"), "2", True):
        with pytest.raises(fb.FeatureBuilderError, match="scale"):
            fb._pattern_scale({"scale": bad}, "f")
