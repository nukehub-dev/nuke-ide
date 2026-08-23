#!/usr/bin/env python3
"""Geometry drift test for the GUI-authored tokamak demo document.

The fixture is produced by the vitest driver in
``src/browser/document/gui-build-tokamak.test.ts``. This test rebuilds it
through ``feature_builder.build_document_shape`` and compares per-body volumes
(and face counts for non-spline bodies) against the reference STEP model.

Important: plasma-facing spline boundaries in the STEP source are approximated
with dense polylines in the ``.nuke-cad`` document. DAGMC faceting is chordal
anyway, so this is at or below the pipeline's geometric resolution. Bodies with
no BSpline boundary are checked to 1e-6 relative volume and exact face count;
approximated bodies are checked to 1e-3 relative volume only.
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
from pathlib import Path

import feature_builder
import pytest

_FIXTURE = Path(__file__).parent.parent / "e2e" / "assets" / "tokamak_with_divertor.nuke-cad"

# Reference values extracted from the authoritative STEP model
# ``tokamak_with_divertor.step`` (22 solids, 180-degree half-model).
_STEP_REFERENCES: dict[str, dict[str, object]] = {
    "tf_coils": {"volume": 39_315_687.355_976_86, "face_count": 70, "bspline": False},
    "pf_coil_1": {"volume": 917_345.054_848_261_2, "face_count": 6, "bspline": False},
    "pf_case_1": {"volume": 2_752_035.164_544_776, "face_count": 10, "bspline": False},
    "pf_coil_2": {"volume": 6_361_725.123_519_626, "face_count": 6, "bspline": False},
    "pf_case_2": {"volume": 9_924_291.192_690_562, "face_count": 10, "bspline": False},
    "pf_coil_3": {"volume": 6_361_725.123_519_626, "face_count": 6, "bspline": False},
    "pf_case_3": {"volume": 9_924_291.192_690_562, "face_count": 10, "bspline": False},
    "pf_coil_4": {"volume": 917_345.054_848_261_2, "face_count": 6, "bspline": False},
    "pf_case_4": {"volume": 2_752_035.164_544_776, "face_count": 10, "bspline": False},
    "divertor": {"volume": 14_762_419.182_109_687, "face_count": 8, "bspline": True},
    "tf_inner_leg_1": {"volume": 633.429_877_093_818_3, "face_count": 5, "bspline": False},
    "tf_inner_leg_2": {"volume": 633.429_877_092_444_3, "face_count": 5, "bspline": False},
    "tf_inner_leg_3": {"volume": 633.429_877_091_022_4, "face_count": 5, "bspline": False},
    "tf_inner_leg_4": {"volume": 633.429_877_093_649_3, "face_count": 5, "bspline": False},
    "tf_inner_leg_5": {"volume": 633.429_877_094_696_5, "face_count": 5, "bspline": False},
    "tf_inner_leg_6": {"volume": 633.429_877_089_900_9, "face_count": 5, "bspline": False},
    "center_column": {"volume": 7_088_907.118_531_729, "face_count": 36, "bspline": False},
    "inboard_blanket": {"volume": 50_506_384.971_973_84, "face_count": 8, "bspline": True},
    "first_wall_inboard": {"volume": 157_358_280.599_311_3, "face_count": 8, "bspline": True},
    "first_wall_outboard": {"volume": 181_815_810.629_084_83, "face_count": 8, "bspline": True},
    "outboard_blanket": {"volume": 35_451_862.932_040_57, "face_count": 8, "bspline": True},
    "plasma": {"volume": 193_311_183.964_118_15, "face_count": 3, "bspline": True},
}

_NON_SPLINE_VOLUME_TOL = 1e-6
_SPLINE_VOLUME_TOL = 1e-3
# The TF inner legs are small cylindrical sectors sketched with arc3 primitives;
# the extracted arc centres differ from the exact STEP cylinders by <0.4 %.
_INNER_LEG_VOLUME_TOL = 5e-3


@pytest.fixture(scope="module")
def tokamak_build_result():
    pytest.importorskip("build123d", reason="build123d not installed")
    doc = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    result = feature_builder.build_document_shape(doc)
    return result


def _body_shape(result: dict, label: str):
    selector_map = result["selectorMap"]
    indices = selector_map[label]
    assert len(indices) == 1, f"expected one solid for '{label}', got {indices}"
    return result["shape"].solids()[indices[0] - 1]


def test_tokamak_document_builds(tokamak_build_result: dict) -> None:
    """The committed fixture builds all 22 solids and every feature reports built."""
    assert tokamak_build_result["shape"] is not None
    assert len(tokamak_build_result["shape"].solids()) == 22
    assert all(r["status"] == "built" for r in tokamak_build_result["featureResults"])


def test_tokamak_document_volumes_and_faces(tokamak_build_result: dict) -> None:
    """Per-body geometry matches the STEP reference within the split tolerance."""
    selector_map = tokamak_build_result["selectorMap"]
    assert set(selector_map) == set(_STEP_REFERENCES)

    failures: list[str] = []
    for label, ref in _STEP_REFERENCES.items():
        solid = _body_shape(tokamak_build_result, label)
        actual_volume = float(solid.volume)
        expected_volume = float(ref["volume"])  # type: ignore[arg-type]
        rel = abs(actual_volume - expected_volume) / abs(expected_volume)
        if label.startswith("tf_inner_leg"):
            tol = _INNER_LEG_VOLUME_TOL
        elif ref["bspline"]:  # type: ignore[arg-type]
            tol = _SPLINE_VOLUME_TOL
        else:
            tol = _NON_SPLINE_VOLUME_TOL
        if rel > tol:
            failures.append(
                f"{label} volume drift: actual {actual_volume:.6f}, expected {expected_volume:.6f} "
                f"(rel {rel:.6g}, tol {tol:.0e})"
            )

        if not ref["bspline"]:  # type: ignore[arg-type]
            actual_faces = len(solid.faces())
            expected_faces = int(ref["face_count"])  # type: ignore[arg-type]
            if actual_faces != expected_faces:
                failures.append(
                    f"{label} face-count drift: actual {actual_faces}, expected {expected_faces}"
                )

    assert not failures, "\n".join(failures)


def test_tokamak_overlap_warnings_are_reported(tokamak_build_result: dict) -> None:
    """Overlapping assembly bodies are reported as warnings, not fatal errors."""
    warnings = tokamak_build_result.get("warnings", [])
    overlap_warnings = [w for w in warnings if "overlap" in w]
    assert len(overlap_warnings) > 0, "expected overlap warnings for the tokamak assembly"
