#!/usr/bin/env python3
"""Datum-lite planes and axes (threePoint/midplane/line2Point).

Minimal-profile tests exercise the pure frame helpers and error paths;
full-profile tests resolve datums through the backend builders.
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
from doc_build_helpers import _by_id, _document, _face_ref, _feature, _rect_sketch


def test_three_point_datum_sketch_builds() -> None:
    """A sketch on a threePoint datum builds on the plane through the points."""
    pytest.importorskip("build123d", reason="build123d not installed")
    datums = [
        {"id": "dxy", "kind": "XY", "name": "XY"},
        {
            "id": "tp",
            "kind": "threePoint",
            "name": "TP",
            "points": [[0.0, 0.0, 10.0], [10.0, 0.0, 10.0], [0.0, 10.0, 10.0]],
        },
    ]
    sketches = [_rect_sketch(), _rect_sketch(4.0, 4.0, "sq", datum_id="tp")]
    doc = _document([_feature("p", "pad", {"length": 2.0}, "sq")], sketches, datums=datums)
    result = fb.build_document_shape(doc)
    assert _by_id(result)["p"]["status"] == "built"
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 32.0, rel_tol=1e-6)
    assert math.isclose(result["shape"].bounding_box().min.Z, 10.0, abs_tol=1e-6)
    assert math.isclose(result["shape"].bounding_box().max.Z, 12.0, abs_tol=1e-6)


def test_three_point_collinear_fails() -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    datums = [
        {"id": "dxy", "kind": "XY", "name": "XY"},
        {
            "id": "tp",
            "kind": "threePoint",
            "name": "TP",
            "points": [[0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [2.0, 2.0, 2.0]],
        },
    ]
    sketches = [_rect_sketch(), _rect_sketch(4.0, 4.0, "sq", datum_id="tp")]
    doc = _document([_feature("p", "pad", {"length": 2.0}, "sq")], sketches, datums=datums)
    result = fb.build_document_shape(doc)
    assert _by_id(result)["p"]["status"] == "failed"
    assert "collinear" in _by_id(result)["p"]["error"].lower()


def test_midplane_datum_sketch_builds_midway() -> None:
    """A sketch on a midplane datum builds halfway between the two faces."""
    pytest.importorskip("build123d", reason="build123d not installed")
    base_doc = _document([_feature("base", "pad", {"length": 10.0}, "rect")], [_rect_sketch()])
    base_result = fb.build_document_shape(base_doc)
    assert base_result["shape"] is not None
    bottom = _face_ref(
        "base",
        base_result["shape"].wrapped,
        lambda f: f.surface_type == "plane" and f.normal is not None and f.normal[2] < -0.9,
    )
    top = _face_ref(
        "base",
        base_result["shape"].wrapped,
        lambda f: f.surface_type == "plane" and f.normal is not None and f.normal[2] > 0.9,
    )
    datums = [
        {"id": "dxy", "kind": "XY", "name": "XY"},
        {"id": "mp", "kind": "midplane", "name": "MP", "faces": [bottom, top]},
    ]
    sketches = [_rect_sketch(), _rect_sketch(4.0, 4.0, "sq", datum_id="mp", dx=3.0, dy=3.0)]
    doc = _document(
        [
            _feature("base", "pad", {"length": 10.0}, "rect"),
            _feature("boss", "pad", {"length": 2.0}, "sq", body="body-2"),
        ],
        sketches,
        bodies=[{"id": "body-1", "name": "B1"}, {"id": "body-2", "name": "B2"}],
        datums=datums,
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["boss"]["status"] == "built"
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 1000.0 + 32.0, rel_tol=1e-6)
    matched = [r for r in result["referenceResults"] if r["path"] == "datum.mp.faces[0]"]
    assert matched and matched[0]["status"] == "matched"


def test_midplane_non_parallel_faces_fail() -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    base_doc = _document([_feature("base", "pad", {"length": 10.0}, "rect")], [_rect_sketch()])
    base_result = fb.build_document_shape(base_doc)
    assert base_result["shape"] is not None
    top = _face_ref(
        "base",
        base_result["shape"].wrapped,
        lambda f: f.surface_type == "plane" and f.normal is not None and f.normal[2] > 0.9,
    )
    side = _face_ref(
        "base",
        base_result["shape"].wrapped,
        lambda f: f.surface_type == "plane" and f.normal is not None and f.normal[0] > 0.9,
    )
    datums = [
        {"id": "dxy", "kind": "XY", "name": "XY"},
        {"id": "mp", "kind": "midplane", "name": "MP", "faces": [top, side]},
    ]
    sketches = [_rect_sketch(), _rect_sketch(4.0, 4.0, "sq", datum_id="mp")]
    doc = _document(
        [
            _feature("base", "pad", {"length": 10.0}, "rect"),
            _feature("p", "pad", {"length": 2.0}, "sq"),
        ],
        sketches,
        datums=datums,
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["p"]["status"] == "failed"
    assert "not parallel" in _by_id(result)["p"]["error"].lower()


def test_midplane_non_planar_face_fails() -> None:
    """A midplane over a cylindrical face reports a clear non-planar error."""
    pytest.importorskip("build123d", reason="build123d not installed")
    profile = {
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
    revolve_doc = _document(
        [_feature("rev", "revolve", {"axis": "y", "angle": 360.0}, "profile")], [profile]
    )
    revolve_result = fb.build_document_shape(revolve_doc)
    assert revolve_result["shape"] is not None
    wall = _face_ref(
        "rev",
        revolve_result["shape"].wrapped,
        lambda f: f.surface_type == "cylinder",
    )
    cap = _face_ref(
        "rev",
        revolve_result["shape"].wrapped,
        lambda f: f.surface_type == "plane" and f.normal is not None and abs(f.normal[1]) > 0.9,
    )
    datums = [
        {"id": "dxy", "kind": "XY", "name": "XY"},
        {"id": "mp", "kind": "midplane", "name": "MP", "faces": [wall, cap]},
    ]
    doc = _document(
        [
            _feature("rev", "revolve", {"axis": "y", "angle": 360.0}, "profile"),
            _feature("p", "pad", {"length": 2.0}, "sq"),
        ],
        [profile, _rect_sketch(4.0, 4.0, "sq", datum_id="mp")],
        datums=datums,
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["p"]["status"] == "failed"
    assert "not planar" in _by_id(result)["p"]["error"].lower()


def test_line2_point_axis_for_circular_pattern() -> None:
    """A line2Point datum supplies the circularPattern rotation axis."""
    pytest.importorskip("build123d", reason="build123d not installed")
    datums = [
        {"id": "dxy", "kind": "XY", "name": "XY"},
        {
            "id": "lp",
            "kind": "line2Point",
            "name": "LP",
            "points": [[0.0, 0.0, 0.0], [0.0, 0.0, 10.0]],
        },
    ]
    sketches = [_rect_sketch(10.0, 10.0, "off", dx=15.0)]
    doc = _document(
        [
            _feature("pad", "pad", {"length": 5.0}, "off"),
            _feature(
                "circ",
                "circularPattern",
                {"source": "pad", "count": 2, "angle": 180.0, "axisDatumId": "lp"},
            ),
        ],
        sketches,
        datums=datums,
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["circ"]["status"] == "built"
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 2.0 * 500.0, rel_tol=1e-6)


def test_line_datum_sketch_placement_fails() -> None:
    """A line datum cannot place a sketch; the builder reports a clear error."""
    pytest.importorskip("build123d", reason="build123d not installed")
    datums = [
        {"id": "dxy", "kind": "XY", "name": "XY"},
        {
            "id": "lp",
            "kind": "line2Point",
            "name": "LP",
            "points": [[0.0, 0.0, 0.0], [0.0, 0.0, 10.0]],
        },
    ]
    sketches = [_rect_sketch(), _rect_sketch(4.0, 4.0, "sq", datum_id="lp")]
    doc = _document([_feature("p", "pad", {"length": 2.0}, "sq")], sketches, datums=datums)
    result = fb.build_document_shape(doc)
    assert _by_id(result)["p"]["status"] == "failed"
    assert "line" in _by_id(result)["p"]["error"].lower()


def test_line_datum_mirror_plane_fails() -> None:
    """planeDatumId stays plane-only; a line datum is a build error."""
    pytest.importorskip("build123d", reason="build123d not installed")
    datums = [
        {"id": "dxy", "kind": "XY", "name": "XY"},
        {
            "id": "lp",
            "kind": "line2Point",
            "name": "LP",
            "points": [[0.0, 0.0, 0.0], [0.0, 0.0, 10.0]],
        },
    ]
    doc = _document(
        [
            _feature("pad", "pad", {"length": 5.0}, "rect"),
            _feature("mirror", "mirror", {"source": "pad", "planeDatumId": "lp"}),
        ],
        [_rect_sketch()],
        datums=datums,
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["mirror"]["status"] == "failed"
    assert "cannot be used as a plane" in _by_id(result)["mirror"]["error"].lower()


def test_linear_pattern_scale() -> None:
    """Each instance scales about its own bbox center after its transform."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            _feature("pad", "pad", {"length": 5.0}, "rect"),
            _feature(
                "lin",
                "linearPattern",
                {"source": "pad", "count": 2, "spacing": 30.0, "axis": "x", "scale": 2.0},
            ),
        ],
        [_rect_sketch()],
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["lin"]["status"] == "built"
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 500.0 + 8.0 * 500.0, rel_tol=1e-6)
    assert math.isclose(result["shape"].bounding_box().max.X, 45.0, abs_tol=1e-6)


def test_three_point_frame_pure() -> None:
    """Three-point frame math is exact; degenerate inputs raise clearly."""
    origin, x_dir, normal = fb._three_point_frame(
        [(0.0, 0.0, 10.0), (10.0, 0.0, 10.0), (0.0, 10.0, 10.0)], "f", "tp"
    )
    assert origin == (0.0, 0.0, 10.0)
    assert normal == pytest.approx((0.0, 0.0, 1.0))
    with pytest.raises(fb.FeatureBuilderError, match="collinear"):
        fb._three_point_frame([(0.0, 0.0, 0.0), (1.0, 1.0, 1.0), (2.0, 2.0, 2.0)], "f", "tp")
    with pytest.raises(fb.FeatureBuilderError, match="coincident"):
        fb._three_point_frame([(1.0, 1.0, 1.0), (1.0, 1.0, 1.0), (0.0, 0.0, 1.0)], "f", "tp")
    # A near-collinear triangle above the 1e-9 area threshold still defines a plane.
    _origin, _x, _normal = fb._three_point_frame(
        [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.5, 1e-4, 0.0)], "f", "tp"
    )


def test_midplane_frame_pure() -> None:
    """Parallel faces average; skewed faces raise; opposed normals align."""
    origin, normal = fb._midplane_frame_from_normals(
        (0.0, 0.0, 0.0), (0.0, 0.0, -1.0), (0.0, 0.0, 10.0), (0.0, 0.0, 1.0), "f", "mp"
    )
    assert origin == pytest.approx((0.0, 0.0, 5.0))
    assert normal == pytest.approx((0.0, 0.0, 1.0))
    with pytest.raises(fb.FeatureBuilderError, match="not parallel"):
        fb._midplane_frame_from_normals(
            (0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 0.0, 10.0), (0.0, 0.0, 1.0), "f", "mp"
        )
    # The 1-degree dihedral tolerance accepts a half-degree tilt ...
    tilt = math.sin(math.radians(0.5)), 0.0, math.cos(math.radians(0.5))
    _origin, _normal = fb._midplane_frame_from_normals(
        (0.0, 0.0, 0.0), (0.0, 0.0, 1.0), (0.0, 0.0, 10.0), tilt, "f", "mp"
    )
    # ... but rejects a two-degree tilt.
    tilt2 = math.sin(math.radians(2.0)), 0.0, math.cos(math.radians(2.0))
    with pytest.raises(fb.FeatureBuilderError, match="not parallel"):
        fb._midplane_frame_from_normals(
            (0.0, 0.0, 0.0), (0.0, 0.0, 1.0), (0.0, 0.0, 10.0), tilt2, "f", "mp"
        )
