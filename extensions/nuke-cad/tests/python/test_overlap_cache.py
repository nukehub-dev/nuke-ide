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

"""Incremental cross-body overlap verdicts (partial-rebuild assembly gate).

Exact overlap checks are O(n²) booleans over whole bodies and dominate
assembly on multi-body documents (13.7 s of a 30 s tokamak build). Verdicts
are cached per body pair and reused while both bodies' content signatures
(feature cache keys, which fold in upstream inputs and versions) are unchanged.
The pure-signature and verdict-reuse tests run in the minimal profile; the
end-to-end partial-build test is build123d-gated.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import doc_cache as dc
import feature_builder as fb
import pytest
from doc_build_helpers import _document, _feature, _rect_sketch

# ---------------------------------------------------------------------------
# Content signatures (minimal profile).
# ---------------------------------------------------------------------------


def test_signatures_track_every_feature_that_shapes_a_body() -> None:
    doc = {
        "features": [
            {"id": "pad", "type": "pad", "body": "b1", "params": {}},
            {
                "id": "cut",
                "type": "booleanCut",
                "body": "b1",
                "params": {"targetBody": "b1", "toolBodies": ["b2"]},
            },
            {"id": "move", "type": "translate", "body": "b2", "params": {"vector": [0, 0, 1]}},
        ]
    }
    keys = {"pad": "k1", "cut": "k2", "move": "k3"}
    signatures = fb._body_overlap_signatures(doc, keys)
    assert set(signatures) == {"b1", "b2"}

    moved = {**keys, "move": "k3b"}
    moved_signatures = fb._body_overlap_signatures(doc, moved)
    assert moved_signatures["b1"] == signatures["b1"]
    assert moved_signatures["b2"] != signatures["b2"]

    changed_target = {**keys, "cut": "k2b"}
    assert fb._body_overlap_signatures(doc, changed_target)["b1"] != signatures["b1"]
    # Unknown/empty keys mean "cannot prove unchanged": no signature at all.
    assert fb._body_overlap_signatures(doc, {}) == {}


def test_signatures_are_order_independent() -> None:
    features = [
        {"id": "a", "type": "pad", "body": "b1", "params": {}},
        {"id": "b", "type": "pad", "body": "b1", "params": {}},
    ]
    keys = {"a": "ka", "b": "kb"}
    first = fb._body_overlap_signatures({"features": features}, keys)
    second = fb._body_overlap_signatures({"features": list(reversed(features))}, keys)
    assert first == second


# ---------------------------------------------------------------------------
# Verdict reuse (minimal profile, fake bodies: no OCP needed).
# ---------------------------------------------------------------------------


class _Point:
    def __init__(self, value: float) -> None:
        self.X = self.Y = self.Z = value


class _Box:
    def __init__(self) -> None:
        self.min = _Point(0.0)
        self.max = _Point(10.0)


class _Common:
    def __init__(self, volume: float) -> None:
        self.volume = volume


class _Body:
    """Minimal stand-in for a build123d Solid: bbox + ``&`` + volume."""

    def __init__(self, volume: float = 0.0) -> None:
        self._volume = volume
        self.intersections = 0

    def bounding_box(self) -> _Box:
        return _Box()

    def __and__(self, other: object) -> _Common:
        self.intersections += 1
        return _Common(self._volume)


def _cached(pairs: dict[tuple[str, str], tuple[str, str, float]]) -> dict[str, Any]:
    return {
        f"{min(a, b)}|{max(a, b)}": {"a": sa, "b": sb, "volume": volume}
        for (a, b), (sa, sb, volume) in pairs.items()
    }


def test_unchanged_pairs_reuse_verdicts_without_boolean_ops(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(fb, "bd", object())  # bypass the "no build123d" early return
    bodies = [_Body(volume=0.0), _Body(volume=0.0), _Body(volume=0.0)]
    ids = ["a", "b", "c"]
    signatures = {"a": "sa", "b": "sb", "c": "sc"}
    cached = _cached(
        {
            ("a", "b"): ("sa", "sb", 2.0),
            ("a", "c"): ("sa", "sc", 0.0),
            ("b", "c"): ("sb", "sc", 0.0),
        }
    )

    warnings, verdicts = fb._check_cross_body_overlap(bodies, ids, cached, signatures)

    assert bodies[0].intersections == bodies[1].intersections == bodies[2].intersections == 0
    assert verdicts == cached
    assert len(warnings) == 1
    assert "bodies 'a' and 'b' overlap" in warnings[0]


def test_changed_body_rechecks_only_its_pairs(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fb, "bd", object())
    a = _Body(volume=2.0)
    b = _Body(volume=0.0)
    c = _Body(volume=0.0)
    ids = ["a", "b", "c"]
    cached = _cached(
        {
            ("a", "b"): ("sa", "sb", 2.0),
            ("a", "c"): ("sa", "sc", 0.0),
            ("b", "c"): ("sb", "sc", 0.0),
        }
    )
    signatures = {"a": "sa", "b": "sb2", "c": "sc"}  # b changed

    warnings, verdicts = fb._check_cross_body_overlap([a, b, c], ids, cached, signatures)

    assert a.intersections == 1  # a x b recomputed
    assert b.intersections == 1  # b x c recomputed (same body object)
    assert c.intersections == 0
    assert verdicts["a|b"]["b"] == "sb2"
    assert verdicts["a|c"] == cached["a|c"]  # untouched pair reused
    assert len(warnings) == 1


def test_shape_list_intersection_volume_is_summed() -> None:
    """Cache-restored bodies make ``&`` return a ShapeList; volume must add up."""

    class _Component:
        def __init__(self, volume: float) -> None:
            self.volume = volume

    class _Result:
        def __init__(self, volumes: list[float]) -> None:
            self._volumes = volumes

        def __iter__(self):
            return iter(_Component(v) for v in self._volumes)

    assert fb._boolean_result_volume(None) == 0.0
    assert fb._boolean_result_volume(_Component(3.5)) == 3.5
    assert fb._boolean_result_volume(_Result([1.0, 2.5])) == 3.5
    assert fb._boolean_result_volume(_Result([])) == 0.0


def test_pair_identity_is_order_independent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fb, "bd", object())
    bodies = [_Body(), _Body()]
    signatures = {"a": "sa", "b": "sb"}
    cached = _cached({("a", "b"): ("sa", "sb", 4.0)})

    # Reordered body list must still hit the same verdict.
    warnings, _ = fb._check_cross_body_overlap(bodies, ["b", "a"], cached, signatures)

    assert bodies[0].intersections == bodies[1].intersections == 0
    assert len(warnings) == 1


# ---------------------------------------------------------------------------
# End-to-end: verdicts persist and warnings survive a partial rebuild.
# ---------------------------------------------------------------------------


def _overlap_doc(first_length: float = 5.0) -> dict[str, Any]:
    """Two bodies extruded from the same sketch occupy the same space."""
    return _document(
        [
            _feature("pad1", "pad", {"length": first_length}, "rect", body="body-1"),
            _feature("pad2", "pad", {"length": 5.0}, "rect", body="body-2"),
        ],
        [_rect_sketch()],
        bodies=[{"id": "body-1", "name": "Body 1"}, {"id": "body-2", "name": "Body 2"}],
    )


def test_partial_build_persists_and_reuses_overlap_verdicts(tmp_path: Path) -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    cache_path = str(tmp_path / "overlap.nuke-cache.zip")

    first = fb.build_document_shape_partial(_overlap_doc(), ["pad1", "pad2"], cache_path=cache_path)
    assert first["shape"] is not None
    assert any("overlap" in warning for warning in first["warnings"]), first["warnings"]
    with dc.DocCache(cache_path).batch() as batch:
        verdicts = batch.overlap_verdicts()
    assert "body-1|body-2" in verdicts
    assert verdicts["body-1|body-2"]["volume"] > 0
    assert verdicts["body-1|body-2"]["a"] and verdicts["body-1|body-2"]["b"]

    # A partial edit re-checks the changed pair and keeps the same warning.
    edited = _overlap_doc(first_length=6.0)
    second = fb.build_document_shape_partial(edited, ["pad1"], cache_path=cache_path)
    assert second["shape"] is not None
    assert any("overlap" in warning for warning in second["warnings"]), second["warnings"]
    statuses = {record["featureId"]: record.get("status") for record in second["featureResults"]}
    assert statuses == {"pad1": "built", "pad2": "cached"}
    with dc.DocCache(cache_path).batch() as batch:
        updated = batch.overlap_verdicts()
    assert updated["body-1|body-2"]["a"] != verdicts["body-1|body-2"]["a"]
    assert updated["body-1|body-2"]["volume"] > 0

    # Restoring BOTH bodies (zero dirty features) must still report the
    # overlap. Regression: cache-restored Solid wrappers make the boolean
    # intersection a ShapeList, whose missing ``volume`` used to read as 0.
    with dc.DocCache(cache_path).batch() as batch:
        batch.store_overlap_verdicts({})  # force a fresh check on restored bodies
    restored = fb.build_document_shape_partial(edited, [], cache_path=cache_path)
    assert restored["shape"] is not None
    assert any("overlap" in warning for warning in restored["warnings"]), restored["warnings"]
    assert all(record.get("status") == "cached" for record in restored["featureResults"])
