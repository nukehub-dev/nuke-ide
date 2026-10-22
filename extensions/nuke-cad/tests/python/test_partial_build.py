#!/usr/bin/env python3
"""Partial (P2 result-cache) builds: partial == full equivalence.

Covers the partial-execution path in ``feature_builder`` against the real
``doc_cache`` zip sidecar: restore/write-back through ``_cache_read_feature``
/ ``_write_back_feature``, the pattern fast path (cached source tool xN,
disjoint-skip with zero booleans, fused GFOP fallback unchanged), and
suppression interplay. Tests assert partial == full solid-set equivalence on
synthetic documents plus the W7X count=3 document (opt-in via
``NUKE_CAD_W7X_GATE=1``, ``NUKE_CAD_W7X_GATE_COUNT``).

Minimal-profile tests exercise the pure state helpers only (the zip sidecar
is stdlib-only, so miss-path tests run there too); full-profile tests use a
throwaway sidecar under ``tmp_path``.
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

import json
import math
import os
from pathlib import Path
from typing import Any

import doc_cache as dc
import feature_builder as fb
import pytest
from doc_build_helpers import _by_id, _document, _feature, _rect_sketch

_W7X_GATE = os.environ.get("NUKE_CAD_W7X_GATE") == "1"
_W7X_COUNT = int(os.environ.get("NUKE_CAD_W7X_GATE_COUNT", "3"))
_W7X_CENTERLINE = (
    Path(__file__).resolve().parent.parent / "e2e" / "assets" / "w7x_coil_centerline.json"
)


def test_builder_version_is_int() -> None:
    """The cache-key version lives in doc_cache only (single source, C1)."""
    assert isinstance(dc.BUILDER_VERSION, int) and dc.BUILDER_VERSION >= 1
    assert not hasattr(fb, "BUILDER_VERSION")


def _zip_path(tmp_path: Path) -> str:
    """Throwaway sidecar path: the zip beside the document never leaves tmp."""
    return str(tmp_path / "test.nuke-cache.zip")


def test_cache_seam_misses_without_cache() -> None:
    """With no cache handle reads miss and writes no-op — never raise."""
    assert fb._cache_read_feature(None, "anything", "key") == (None, None, {})
    assert fb._cache_write_feature(None, "x", "key", b"body", None, {}, "fp") is False


def test_cache_seam_roundtrip_real_sidecar(tmp_path: Path) -> None:
    """Write-then-read through the real zip sidecar preserves blobs and meta."""
    import doc_cache

    cache = doc_cache.DocCache(_zip_path(tmp_path))
    assert fb._cache_write_feature(cache, "f", "k", b"body", b"tool", {"a": 1}, "fp") is True
    body, tool, meta = fb._cache_read_feature(cache, "f", "k")
    assert body == b"body" and tool == b"tool" and meta == {"a": 1}
    assert fb._cache_read_feature(cache, "f", "other-key") == (None, None, {})
    assert fb._cache_read_feature(cache, "missing", "k") == (None, None, {})


def _pattern_doc(spacing: float) -> dict[str, Any]:
    return _document(
        [
            _feature("base", "pad", {"length": 5.0}, "rect"),
            _feature(
                "pat",
                "linearPattern",
                {"source": "base", "count": 2, "spacing": spacing, "axis": "x"},
            ),
        ],
        [_rect_sketch()],
    )


def _solid_volumes(shape: Any) -> list[float]:
    return sorted(float(s.volume) for s in shape.solids())


def _assert_same_solids(full_shape: Any, part_shape: Any) -> None:
    assert part_shape is not None and full_shape is not None
    full_volumes = _solid_volumes(full_shape)
    part_volumes = _solid_volumes(part_shape)
    assert len(part_volumes) == len(full_volumes)
    for part_volume, full_volume in zip(part_volumes, full_volumes, strict=True):
        assert math.isclose(part_volume, full_volume, rel_tol=1e-9)


def test_partial_empty_cache_equals_full(tmp_path: Path) -> None:
    """With an empty cache the partial path degrades to the full build exactly."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _pattern_doc(spacing=30.0)
    full = fb.build_document_shape(doc)
    part = fb.build_document_shape_partial(doc, ["base", "pat"], cache_path=_zip_path(tmp_path))
    assert _by_id(part)["base"]["status"] == "built"
    assert _by_id(part)["pat"]["status"] == "built"
    _assert_same_solids(full["shape"], part["shape"])
    assert part["selectorMap"] == full["selectorMap"]
    # Both executions wrote their blobs back through the seam.
    import doc_cache

    assert sorted(doc_cache.DocCache(_zip_path(tmp_path)).feature_ids()) == ["base", "pat"]


def test_partial_dirty_pattern_reuses_cached_source(tmp_path: Path) -> None:
    """A dirty disjoint pattern transforms the cached source tool with zero rebuild."""
    pytest.importorskip("build123d", reason="build123d not installed")
    zip_path = _zip_path(tmp_path)
    fb.build_document_shape_partial(
        _pattern_doc(spacing=30.0), ["base", "pat"], cache_path=zip_path
    )
    edited = _pattern_doc(spacing=40.0)
    part = fb.build_document_shape_partial(edited, ["pat"], cache_path=zip_path)
    full = fb.build_document_shape(edited)
    assert _by_id(part)["base"]["status"] == "cached"
    assert _by_id(part)["pat"]["status"] == "built"
    _assert_same_solids(full["shape"], part["shape"])
    assert part["selectorMap"] == full["selectorMap"]


def test_partial_fused_pattern_equivalence(tmp_path: Path) -> None:
    """Overlapping (fused) patterns keep the GFOP-first/sequential path in partial builds."""
    pytest.importorskip("build123d", reason="build123d not installed")
    zip_path = _zip_path(tmp_path)
    fb.build_document_shape_partial(_pattern_doc(spacing=5.0), ["base", "pat"], cache_path=zip_path)
    edited = _pattern_doc(spacing=6.0)
    part = fb.build_document_shape_partial(edited, ["pat"], cache_path=zip_path)
    full = fb.build_document_shape(edited)
    assert len(_solid_volumes(full["shape"])) == 1
    _assert_same_solids(full["shape"], part["shape"])


def test_partial_suppression_interplay(tmp_path: Path) -> None:
    """Suppressing the pattern in a partial rebuild matches the full-build stale contract."""
    pytest.importorskip("build123d", reason="build123d not installed")
    zip_path = _zip_path(tmp_path)
    fb.build_document_shape_partial(
        _pattern_doc(spacing=30.0), ["base", "pat"], cache_path=zip_path
    )
    suppressed = _pattern_doc(spacing=30.0)
    suppressed["features"][1]["suppressed"] = True
    part = fb.build_document_shape_partial(suppressed, ["pat"], cache_path=zip_path)
    full = fb.build_document_shape(suppressed)
    assert _by_id(part)["pat"]["status"] == "stale"
    assert _by_id(full)["pat"]["status"] == "stale"
    _assert_same_solids(full["shape"], part["shape"])


def test_partial_boolean_consumed_restore(tmp_path: Path) -> None:
    """Boolean target/tool snapshots restore the consumed-body set from meta."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = _document(
        [
            _feature("f1", "pad", {"length": 5.0}, "rect", body="b1"),
            _feature("f2", "pad", {"length": 5.0}, "rect2", body="b2"),
            {
                "id": "fu",
                "name": "fu",
                "type": "booleanFuse",
                "body": "b1",
                "params": {"targetBody": "b1", "toolBodies": ["b2"]},
                "dependsOn": [],
                "suppressed": False,
            },
        ],
        [_rect_sketch(), _rect_sketch(10.0, 10.0, "rect2", dx=30.0)],
        bodies=[
            {"id": "b1", "name": "B1", "label": "l1"},
            {"id": "b2", "name": "B2", "label": "l2"},
        ],
    )
    zip_path = _zip_path(tmp_path)
    fb.build_document_shape_partial(doc, ["f1", "f2", "fu"], cache_path=zip_path)
    part = fb.build_document_shape_partial(doc, [], cache_path=zip_path)
    full = fb.build_document_shape(doc)
    assert all(r["status"] == "cached" for r in part["featureResults"])
    assert part["consumedBodies"] == full["consumedBodies"] == ["b2"]
    _assert_same_solids(full["shape"], part["shape"])
    assert part["selectorMap"] == full["selectorMap"]


def test_partial_unknown_feature_ids_raise(tmp_path: Path) -> None:
    """Naming an unknown feature is a hard error (fail fast on a stale TS plan)."""
    pytest.importorskip("build123d", reason="build123d not installed")
    with pytest.raises(fb.FeatureBuilderError, match="unknown features"):
        fb.build_document_shape_partial(
            _pattern_doc(spacing=30.0), ["nope"], cache_path=_zip_path(tmp_path)
        )


def test_partial_plumbing_unified_tessellation(tmp_path: Path) -> None:
    """`build_document_partial` returns the unified tessellation + feature results."""
    pytest.importorskip("build123d", reason="build123d not installed")
    import geometry_service

    doc_path = tmp_path / "partial.nuke-cad"
    doc_path.write_text(json.dumps(_pattern_doc(spacing=30.0)), encoding="utf-8")
    out_dir = tmp_path / "out"
    first = geometry_service.build_document_partial(
        str(doc_path),
        ["base", "pat"],
        cache_dir=str(tmp_path),
        output_dir=str(out_dir),
        export_dagmc=False,
        export_mesh=False,
    )
    assert first["success"], first.get("error")
    assert Path(first["tessPath"]).exists()
    second = geometry_service.build_document_partial(
        str(doc_path),
        ["pat"],
        cache_dir=str(tmp_path),
        output_dir=str(out_dir),
        export_dagmc=False,
        export_mesh=False,
    )
    assert second["success"], second.get("error")
    statuses = {r["featureId"]: r["status"] for r in second["featureResults"]}
    assert statuses == {"base": "cached", "pat": "built"}
    first_solids = first["selectorMap"]
    assert second["selectorMap"] == first_solids


def _w7x_document(count: int) -> dict[str, Any]:
    """One coil section swept along the committed centerline, circular-patterned."""
    samples = json.loads(_W7X_CENTERLINE.read_text(encoding="utf-8"))
    half = 0.37 / 2.0
    rectangle = {
        "id": "section",
        "name": "coil section",
        "datumId": "datum-xy",
        "primitives": [
            {"id": "p1", "type": "point", "x": -half, "y": -half},
            {"id": "p2", "type": "point", "x": half, "y": -half},
            {"id": "p3", "type": "point", "x": half, "y": half},
            {"id": "p4", "type": "point", "x": -half, "y": half},
            {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
            {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
            {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
            {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
        ],
        "constraints": [],
    }
    return {
        "version": 3,
        "name": "w7x-scale",
        "parameters": {},
        "bodies": [{"id": "coil-body", "label": "coil", "name": "coil"}],
        "datums": [{"id": "datum-xy", "kind": "XY", "offset": 0.0}],
        "sketches": [rectangle],
        "curves": [
            {
                "id": "w7x",
                "name": "coil centerline",
                "source": {"kind": "points"},
                "samples": [list(p) for p in samples],
            }
        ],
        "features": [
            {
                "id": "coil-sweep",
                "name": "coil sweep",
                "type": "sweep",
                "body": "coil-body",
                "sketchId": "section",
                "params": {"pathCurveId": "w7x", "orientation": "frenet"},
                "dependsOn": [],
                "suppressed": False,
            },
            {
                "id": "coil-pattern",
                "name": "circular pattern",
                "type": "circularPattern",
                "body": "coil-body",
                "params": {
                    "source": "coil-sweep",
                    "count": count,
                    "angle": 360.0,
                    "axis": "z",
                },
                "dependsOn": [],
                "suppressed": False,
            },
        ],
    }


@pytest.mark.skipif(not _W7X_GATE, reason="NUKE_CAD_W7X_GATE not set — opt-in W7X gate")
def test_partial_w7x_equivalence(tmp_path: Path) -> None:
    """W7X count=N: partial (pattern-dirty, cached sweep source) == full solid sets."""
    pytest.importorskip("build123d", reason="build123d not installed")
    import curve_builder

    doc = _w7x_document(_W7X_COUNT)
    curve_results = curve_builder.build_curves(doc)
    zip_path = _zip_path(tmp_path)
    fb.build_document_shape_partial(
        doc, ["coil-sweep", "coil-pattern"], curve_results=curve_results, cache_path=zip_path
    )
    part = fb.build_document_shape_partial(
        doc, ["coil-pattern"], curve_results=curve_results, cache_path=zip_path
    )
    full = fb.build_document_shape(doc, curve_results=curve_results)
    assert _by_id(part)["coil-sweep"]["status"] == "cached"
    assert _by_id(part)["coil-pattern"]["status"] == "built"
    full_solids = full["shape"].solids()
    part_solids = part["shape"].solids()
    assert len(part_solids) == len(full_solids) == _W7X_COUNT
    _assert_same_solids(full["shape"], part["shape"])
    assert part["selectorMap"] == full["selectorMap"] == {"coil": list(range(1, _W7X_COUNT + 1))}
