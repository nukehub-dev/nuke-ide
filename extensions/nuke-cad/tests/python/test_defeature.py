#!/usr/bin/env python3
"""Face-delete defeaturing for pre-mesh cleanup."""

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
from doc_build_helpers import _by_id, _document, _face_ref, _feature, _holed_base, _rect_sketch


def test_defeature_fills_hole() -> None:
    """Defeaturing a hole's wall and bottom faces restores the block volume."""
    pytest.importorskip("build123d", reason="build123d not installed")
    top_ref, wall, bottom = _holed_base()
    doc = _document(
        [
            _feature("base", "pad", {"length": 5.0}, "rect"),
            _feature(
                "h", "hole", {"face": top_ref, "center": [0.0, 0.0], "diameter": 2.0, "depth": 3.0}
            ),
            _feature("d", "defeature", {"faces": [wall, bottom]}),
        ],
        [_rect_sketch()],
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["d"]["status"] == "built"
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 500.0, rel_tol=1e-6)


def test_defeature_requires_faces() -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            _feature("base", "pad", {"length": 5.0}, "rect"),
            _feature("d", "defeature", {"faces": []}),
        ],
        [_rect_sketch()],
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["d"]["status"] == "failed"
    assert "at least one face" in _by_id(result)["d"]["error"].lower()


def test_defeature_without_binding_fails_clearly(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without BRepAlgoAPI_Defeaturing the backend fails with a clear error."""
    monkeypatch.setattr(fb, "HAS_DEFEATURING", False)
    monkeypatch.setattr(fb, "_DefeaturingOp", None)
    with pytest.raises(fb.FeatureBuilderError, match="not supported with this OCP"):
        fb._apply_defeature(object(), [], "d")


# ---------------------------------------------------------------------------
# Draft neutral plane (face-picked, grouped with defeature as authored)
# ---------------------------------------------------------------------------


def test_draft_neutral_plane_builds() -> None:
    """A draft about a shared neutral-plane face builds and shifts volume."""
    pytest.importorskip("build123d", reason="build123d not installed")
    base_doc = _document([_feature("base", "pad", {"length": 10.0}, "rect")], [_rect_sketch()])
    base_result = fb.build_document_shape(base_doc)
    assert base_result["shape"] is not None
    side = _face_ref(
        "base",
        base_result["shape"].wrapped,
        lambda f: f.surface_type == "plane" and f.normal is not None and f.normal[0] > 0.9,
    )
    top = _face_ref(
        "base",
        base_result["shape"].wrapped,
        lambda f: f.surface_type == "plane" and f.normal is not None and f.normal[2] > 0.9,
    )
    centroid_doc = _document(
        [
            _feature("base", "pad", {"length": 10.0}, "rect"),
            _feature("dr", "draft", {"faces": [side], "angle": 5.0, "pullDirection": [0, 0, 1]}),
        ],
        [_rect_sketch()],
    )
    neutral_doc = _document(
        [
            _feature("base", "pad", {"length": 10.0}, "rect"),
            _feature(
                "dr",
                "draft",
                {"faces": [side], "angle": 5.0, "pullDirection": [0, 0, 1], "neutralPlane": top},
            ),
        ],
        [_rect_sketch()],
    )
    centroid_result = fb.build_document_shape(centroid_doc)
    neutral_result = fb.build_document_shape(neutral_doc)
    assert _by_id(centroid_result)["dr"]["status"] == "built"
    assert _by_id(neutral_result)["dr"]["status"] == "built"
    assert centroid_result["shape"] is not None and neutral_result["shape"] is not None
    # The shared top neutral plane tapers asymmetrically; the centroid neutral
    # plane is symmetric and preserves the volume.
    assert abs(neutral_result["shape"].volume - centroid_result["shape"].volume) > 1.0
    neutral_refs = [
        r
        for r in neutral_result["referenceResults"]
        if r["path"] == "feature.dr.params.neutralPlane"
    ]
    assert len(neutral_refs) == 1
    assert neutral_refs[0]["status"] == "matched"


def test_draft_neutral_plane_non_planar_fails() -> None:
    """A non-planar neutralPlane face is a clear build error."""
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
    wall = _face_ref("rev", revolve_result["shape"].wrapped, lambda f: f.surface_type == "cylinder")
    cap = _face_ref(
        "rev",
        revolve_result["shape"].wrapped,
        lambda f: f.surface_type == "plane" and f.normal is not None and abs(f.normal[1]) > 0.9,
    )
    doc = _document(
        [
            _feature("rev", "revolve", {"axis": "y", "angle": 360.0}, "profile"),
            _feature(
                "dr",
                "draft",
                {"faces": [cap], "angle": 5.0, "pullDirection": [0, 1, 0], "neutralPlane": wall},
            ),
        ],
        [profile],
    )
    result = fb.build_document_shape(doc)
    assert _by_id(result)["dr"]["status"] == "failed"
    assert "not planar" in _by_id(result)["dr"]["error"].lower()
