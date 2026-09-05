#!/usr/bin/env python3
"""Datum-placed additive primitives (box/cylinder/sphere/cone/torus)."""

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
    _feature,
    _rect_sketch,
)


def test_primitive_volumes() -> None:
    """One primitive per shape builds the exact analytic volume on XY."""
    pytest.importorskip("build123d", reason="build123d not installed")
    cases = [
        ("box", [4.0, 6.0, 8.0], 192.0),
        ("cylinder", [2.0, 5.0], math.pi * 4.0 * 5.0),
        ("sphere", [3.0], 4.0 / 3.0 * math.pi * 27.0),
        ("cone", [2.0, 6.0], math.pi * 4.0 * 6.0 / 3.0),
        ("torus", [5.0, 1.0], 2.0 * math.pi**2 * 5.0),
    ]
    for shape, dimensions, expected in cases:
        doc = _document(
            [_feature("p", "primitive", {"shape": shape, "dimensions": dimensions})], []
        )
        result = fb.build_document_shape(doc)
        assert _by_id(result)["p"]["status"] == "built", shape
        assert result["shape"] is not None
        assert math.isclose(result["shape"].volume, expected, rel_tol=1e-6), shape


def test_primitive_box_centered_on_datum() -> None:
    """Box dimensions center the box on the datum origin along the normal."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [_feature("p", "primitive", {"shape": "box", "dimensions": [4.0, 4.0, 2.0]})], []
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["p"]["status"] == "built"
    assert result["shape"] is not None
    bbox = result["shape"].bounding_box()
    assert math.isclose(bbox.min.X, -2.0, abs_tol=1e-9)
    assert math.isclose(bbox.max.Z, 1.0, abs_tol=1e-9)


def test_primitive_on_face_datum() -> None:
    """A primitive builds on a face datum workplane like a pad sketch."""
    pytest.importorskip("build123d", reason="build123d not installed")
    top_ref, _shape = _build_base_and_capture_top_face(length=5.0)
    datums = [
        {"id": "dxy", "kind": "XY", "name": "XY"},
        {"id": "top", "kind": "face", "name": "Top", "reference": top_ref},
    ]
    doc = _document(
        [
            _feature("base", "pad", {"length": 5.0}, "rect"),
            _feature(
                "p",
                "primitive",
                {"shape": "box", "dimensions": [4.0, 4.0, 2.0], "datumId": "top"},
                body="body-2",
            ),
        ],
        [_rect_sketch()],
        bodies=[{"id": "body-1", "name": "B1"}, {"id": "body-2", "name": "B2"}],
        datums=datums,
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["p"]["status"] == "built"
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 500.0 + 32.0, rel_tol=1e-6)


def test_primitive_errors() -> None:
    """Wrong arity, bad dimensions, and unknown datums are build errors."""
    pytest.importorskip("build123d", reason="build123d not installed")
    cases = [
        ({"shape": "box", "dimensions": [1.0, 2.0]}, "requires 3"),
        ({"shape": "sphere", "dimensions": [1.0, 2.0]}, "requires 1"),
        ({"shape": "box", "dimensions": [1.0, -2.0, 3.0]}, "positive"),
        ({"shape": "pyramid", "dimensions": [1.0]}, "unknown primitive shape"),
        ({"shape": "box", "dimensions": [1.0, 1.0, 1.0], "datumId": "nope"}, "unknown datum"),
    ]
    for params, message in cases:
        doc = _document([_feature("p", "primitive", params)], [])
        result = fb.build_document_shape(doc)
        assert _by_id(result)["p"]["status"] == "failed", params
        assert message in _by_id(result)["p"]["error"].lower(), params


def test_primitive_missing_default_datum_fails() -> None:
    """Without datumId and without an XY datum the primitive cannot place."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [_feature("p", "primitive", {"shape": "box", "dimensions": [1.0, 1.0, 1.0]})],
        [],
        datums=[{"id": "off", "kind": "offset", "name": "O", "offset": 3.0}],
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["p"]["status"] == "failed"
    assert "datum" in _by_id(result)["p"]["error"].lower()


def test_primitive_as_pattern_source() -> None:
    """Patterns accept primitives as solid-producing sources."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            _feature("p", "primitive", {"shape": "box", "dimensions": [4.0, 4.0, 4.0]}),
            _feature(
                "lin",
                "linearPattern",
                {"source": "p", "count": 2, "spacing": 20.0, "axis": "x"},
            ),
        ],
        [],
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["lin"]["status"] == "built"
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 2.0 * 64.0, rel_tol=1e-6)
