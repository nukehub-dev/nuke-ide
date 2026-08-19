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
    features: list[dict[str, Any]], sketches: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    return {
        "version": 1,
        "name": "test",
        "parameters": {},
        "datums": [{"id": "dxy", "kind": "XY", "name": "XY"}],
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
                "sketchId": "rect",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
                "label": "clad",
            },
            {
                "id": "fuel",
                "name": "fuel",
                "type": "pad",
                "sketchId": "fuel",
                "params": {"length": 10},
                "dependsOn": [],
                "suppressed": False,
                "label": "fuel",
            },
        ],
        sketches=[_rect_sketch(), _circle_sketch(60, 10, 5, "fuel")],
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
