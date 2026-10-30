#!/usr/bin/env python3
"""Topological reference (toponaming) tests at tokamak-document scale.

The committed tokamak demo document (``tokamak_with_divertor.nuke-cad``)
carries no ``TopologyRef`` entries of its own, so these tests derive one from
the built assembly instead: a face fingerprint is extracted from the built
``pf_coil_1`` body with the production extraction path
(``reference_resolver.extract_face_fingerprints``), wrapped in a
``TopologyRef``, and used by a hole feature appended to an in-memory copy of
the document. The hole's placement face must resolve ``matched`` in
``referenceResults`` and the hole must cut material.

The second half is the core toponaming promise: an upstream dimension edit
(the coil's outer radius) moves the referenced face, and the fingerprint must
still resolve ``matched`` against the rebuilt body.

The fixture JSON is drift-checked byte-identically by the GUI driver test and
is never modified; all edits happen on in-memory copies. Each module-scoped
fixture rebuilds the document once (~30 s per build).
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

import copy
import json
from pathlib import Path
from typing import Any

import feature_builder
import pytest
import reference_resolver as rr

_FIXTURE = Path(__file__).parent.parent / "e2e" / "assets" / "tokamak_with_divertor.nuke-cad"

# The hole targets the pf_coil_1 body (body-2): a single-feature 180-degree
# revolve whose two 20x20 mm sector-cap faces are planar with their centroid
# on the material, so a hole centered at [0, 0] in face-workplane coordinates
# always intersects the body. (The annular top/bottom faces have centroids in
# the coil bore and would produce a disjoint cut.)
_TARGET_BODY_ID = "body-2"
_TARGET_BODY_LABEL = "pf_coil_1"
_TARGET_FEATURE_ID = "pf-coil-1"
_TARGET_SKETCH_ID = "pf-coil-1-sketch"
_HOLE_FEATURE_ID = "pf-coil-1-drain-hole"
_HOLE_REF_PATH = f"feature.{_HOLE_FEATURE_ID}.params.face"
_HOLE_DIAMETER = 8.0

# Upstream dimension edit: outer radius of the coil cross-section 740 -> 741.
# Topology is preserved (same face count/types); the referenced cap face moves
# 0.5 mm radially and its area grows, exercising fingerprint tolerance without
# breaking the match.
_EDITED_POINT_IDS = ("point-2", "point-3")
_EDITED_OUTER_RADIUS = 741.0


@pytest.fixture(scope="module")
def tokamak_document() -> dict[str, Any]:
    return json.loads(_FIXTURE.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def baseline_result(tokamak_document: dict[str, Any]) -> dict[str, Any]:
    pytest.importorskip("build123d", reason="build123d not installed")
    return feature_builder.build_document_shape(tokamak_document)


def _body_solid(result: dict[str, Any], label: str) -> Any:
    indices = result["selectorMap"][label]
    assert len(indices) == 1, f"expected one solid for '{label}', got {indices}"
    return result["shape"].solids()[indices[0] - 1]


def _side_cap_ref(result: dict[str, Any]) -> dict[str, Any]:
    """Derive a face ``TopologyRef`` for the +X sector cap face of the target body."""
    solid = _body_solid(result, _TARGET_BODY_LABEL)
    for fingerprint in rr.extract_face_fingerprints(solid.wrapped):
        if (
            fingerprint.surface_type == "plane"
            and fingerprint.normal is not None
            and abs(fingerprint.normal[1]) > 0.999
            and fingerprint.center[0] > 0.0
        ):
            return {
                "featureId": _TARGET_FEATURE_ID,
                "kind": "face",
                "fingerprint": fingerprint.to_dict(),
            }
    raise AssertionError(f"no +X sector cap face found on '{_TARGET_BODY_LABEL}'")


def _hole_feature(face_ref: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": _HOLE_FEATURE_ID,
        "name": _HOLE_FEATURE_ID,
        "type": "hole",
        "body": _TARGET_BODY_ID,
        "params": {"face": face_ref, "center": [0.0, 0.0], "diameter": _HOLE_DIAMETER},
        "dependsOn": [_TARGET_FEATURE_ID],
        "suppressed": False,
    }


@pytest.fixture(scope="module")
def hole_variant_result(
    tokamak_document: dict[str, Any], baseline_result: dict[str, Any]
) -> dict[str, Any]:
    """The fixture plus a hole placed by face reference; rebuilt once."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = copy.deepcopy(tokamak_document)
    doc["features"].append(_hole_feature(_side_cap_ref(baseline_result)))
    return feature_builder.build_document_shape(doc)


@pytest.fixture(scope="module")
def edited_hole_variant_result(
    tokamak_document: dict[str, Any], baseline_result: dict[str, Any]
) -> dict[str, Any]:
    """The fixture plus the hole, with the coil's outer radius edited upstream."""
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = copy.deepcopy(tokamak_document)
    sketch = next(s for s in doc["sketches"] if s["id"] == _TARGET_SKETCH_ID)
    for primitive in sketch["primitives"]:
        if primitive["id"] in _EDITED_POINT_IDS:
            primitive["x"] = _EDITED_OUTER_RADIUS
    doc["features"].append(_hole_feature(_side_cap_ref(baseline_result)))
    return feature_builder.build_document_shape(doc)


def _hole_ref_result(result: dict[str, Any]) -> dict[str, Any]:
    matches = [r for r in result["referenceResults"] if r["path"] == _HOLE_REF_PATH]
    assert len(matches) == 1, f"expected one reference result for '{_HOLE_REF_PATH}'"
    return matches[0]


def _feature_result(result: dict[str, Any], feature_id: str) -> dict[str, Any]:
    by_id = {r["featureId"]: r for r in result["featureResults"]}
    assert feature_id in by_id, f"feature '{feature_id}' missing from featureResults"
    return by_id[feature_id]


def test_fixture_itself_carries_no_topology_refs(baseline_result: dict[str, Any]) -> None:
    """Baseline sanity: the committed document builds and exercises zero references."""
    assert baseline_result["shape"] is not None
    assert len(baseline_result["shape"].solids()) == 22
    assert baseline_result["referenceResults"] == []


def test_hole_reference_matches_and_cuts_material(
    baseline_result: dict[str, Any], hole_variant_result: dict[str, Any]
) -> None:
    """A hole placed by face fingerprint resolves matched and removes material."""
    ref = _hole_ref_result(hole_variant_result)
    assert ref["kind"] == "face"
    assert ref["status"] == "matched"
    assert ref["candidateId"]
    assert ref["score"] > 0.99
    assert ref["score"] - ref["runnerUpScore"] > 0.05

    assert _feature_result(hole_variant_result, _HOLE_FEATURE_ID)["status"] == "built"
    assert len(hole_variant_result["shape"].solids()) == 22

    baseline_volume = float(_body_solid(baseline_result, _TARGET_BODY_LABEL).volume)
    variant_volume = float(_body_solid(hole_variant_result, _TARGET_BODY_LABEL).volume)
    removed = baseline_volume - variant_volume
    # The 8 mm through-hole cuts a chord through the coil cross-section; the
    # removed volume must be well above numerical noise and well below the
    # whole body.
    assert 0.005 * baseline_volume < removed < 0.05 * baseline_volume


def test_hole_reference_survives_upstream_dimension_edit(
    edited_hole_variant_result: dict[str, Any],
) -> None:
    """The fingerprint still resolves after the coil's outer radius changes."""
    ref = _hole_ref_result(edited_hole_variant_result)
    assert ref["status"] == "matched"
    assert ref["candidateId"]
    # The edit moved the referenced face, so the match is no longer exact, but
    # it stays far above the ambiguity band.
    assert 0.8 < ref["score"] < 0.999
    assert ref["score"] - ref["runnerUpScore"] > 0.05

    assert _feature_result(edited_hole_variant_result, _HOLE_FEATURE_ID)["status"] == "built"
    assert len(edited_hole_variant_result["shape"].solids()) == 22
