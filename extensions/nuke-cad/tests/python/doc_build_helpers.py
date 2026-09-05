#!/usr/bin/env python3
"""Shared document builders for the nuke-cad backend pytest suite.

Small in-memory ``.nuke-cad`` documents (rect sketches, pad bases, face
references) used across the feature-area test modules.
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

from typing import Any

import feature_builder as fb
import pytest


def _rect_sketch(
    width: float = 10.0,
    height: float = 10.0,
    sid: str = "rect",
    datum_id: str = "dxy",
    dx: float = 0.0,
    dy: float = 0.0,
) -> dict[str, Any]:
    return {
        "id": sid,
        "name": sid,
        "datumId": datum_id,
        "primitives": [
            {"id": "p1", "type": "point", "x": dx, "y": dy},
            {"id": "p2", "type": "point", "x": dx + width, "y": dy},
            {"id": "p3", "type": "point", "x": dx + width, "y": dy + height},
            {"id": "p4", "type": "point", "x": dx, "y": dy + height},
            {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
            {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
            {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
            {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
        ],
        "constraints": [],
    }


def _feature(
    fid: str,
    ftype: str,
    params: dict[str, Any],
    sketch: str | None = None,
    body: str = "body-1",
) -> dict[str, Any]:
    feature: dict[str, Any] = {
        "id": fid,
        "name": fid,
        "type": ftype,
        "body": body,
        "params": params,
        "dependsOn": [],
        "suppressed": False,
    }
    if sketch is not None:
        feature["sketchId"] = sketch
    return feature


def _document(
    features: list[dict[str, Any]],
    sketches: list[dict[str, Any]],
    bodies: list[dict[str, Any]] | None = None,
    datums: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "version": 3,
        "name": "doc",
        "parameters": {},
        "datums": datums if datums is not None else [{"id": "dxy", "kind": "XY", "name": "XY"}],
        "bodies": bodies if bodies is not None else [{"id": "body-1", "name": "Body 1"}],
        "sketches": sketches,
        "features": features,
    }


def _face_ref(feature_id: str, topods_shape: Any, predicate: Any) -> dict[str, Any]:
    """Build a TopologyRef dict for the first face matching ``predicate``."""
    pytest.importorskip("build123d", reason="build123d not installed")
    import reference_resolver as rr

    faces = rr.extract_face_fingerprints(topods_shape)
    for face in faces:
        if predicate(face):
            return {"featureId": feature_id, "kind": "face", "fingerprint": face.to_dict()}
    raise AssertionError("no matching face found")


def _top_face(topods_shape: Any, feature_id: str = "base") -> dict[str, Any]:
    return _face_ref(
        feature_id,
        topods_shape,
        lambda f: f.surface_type == "plane" and f.normal is not None and f.normal[2] > 0.9,
    )


def _build_base_and_capture_top_face(length: float = 5.0) -> tuple[dict[str, Any], Any]:
    """Build a 10x10 extruded base pad and return ``(top_face_ref, shape)``."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [_feature("base", "pad", {"length": length}, "rect")],
        [_rect_sketch()],
    )
    result = fb.build_document_shape(doc)
    assert result["shape"] is not None
    return _top_face(result["shape"].wrapped), result["shape"]


def _by_id(result: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {r["featureId"]: r for r in result["featureResults"]}


def _slab_setup() -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Two-slab body (z 0..5 and z 8..10) plus a 4x4 bridge sketch at z=5."""
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
    features = [
        _feature("s1", "pad", {"length": 5.0}, "r1"),
        _feature("s2", "pad", {"length": 2.0}, "r2"),
    ]
    return datums, sketches, features


def _hole_doc(extra: dict[str, Any], depth: Any = 4.0, base_length: float = 6.0) -> Any:
    top_ref, _shape = _build_base_and_capture_top_face(length=base_length)
    params: dict[str, Any] = {"face": top_ref, "center": [0.0, 0.0], "diameter": 2.0}
    if depth is not None:
        params["depth"] = depth
    params.update(extra)
    return _document(
        [
            _feature("base", "pad", {"length": base_length}, "rect"),
            _feature("h", "hole", params),
        ],
        [_rect_sketch()],
    )


def _holed_base() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Base block with a blind hole; returns (top_ref, wall_ref, bottom_ref)."""
    top_ref, _shape = _build_base_and_capture_top_face(length=5.0)
    holed = _document(
        [
            _feature("base", "pad", {"length": 5.0}, "rect"),
            _feature(
                "h", "hole", {"face": top_ref, "center": [0.0, 0.0], "diameter": 2.0, "depth": 3.0}
            ),
        ],
        [_rect_sketch()],
    )
    result = fb.build_document_shape(holed)
    assert result["shape"] is not None
    wall = _face_ref("h", result["shape"].wrapped, lambda f: f.surface_type == "cylinder")
    bottom = _face_ref(
        "h",
        result["shape"].wrapped,
        lambda f: (
            f.surface_type == "plane"
            and f.normal is not None
            and f.normal[2] > 0.9
            and f.area < 50.0
        ),
    )
    return top_ref, wall, bottom
