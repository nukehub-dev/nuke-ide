"""End-to-end: build every mechanical component-template fixture.

Each fixture is the canonical GUI-authored document for a shipped mechanical
template. The test builds the document through the production document pipeline
(no DAGMC or mesh export) and checks the solid count, selector label, feature
results, and shipped default bounding box. It runs only in the full-dependency
profile; ``NUKE_TEST_PYTHON`` is the gate and the test skips cleanly when it is
unset.
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

import os
from pathlib import Path

import pytest

pytestmark = pytest.mark.e2e

# Env gate (repo convention: no machine-specific defaults; skip cleanly).
if not os.environ.get("NUKE_TEST_PYTHON"):
    pytest.skip(
        "NUKE_TEST_PYTHON not set — e2e requires the full-dependency Python environment",
        allow_module_level=True,
    )

pytest.importorskip("build123d", reason="e2e requires build123d")

import geometry_service  # noqa: E402

_ASSETS = Path(__file__).parent / "assets"

# Fixture stem, selector label, shipped default span in cm, and feature ids.
EXPECTED_FACES = {
    "gui_l_bracket": 10,
    "gui_l_bracket_3_holes": 11,
    "gui_flange": 10,
    "gui_flange_8_bolts": 12,
    "gui_stepped_shaft": 5,
    "gui_pipe_with_bore": 4,
    "gui_bolt_circle_plate": 7,
    "gui_bolt_circle_plate_6_holes": 9,
}

CASES = [
    ("gui_l_bracket", "l-bracket", (8.0, 8.0, 0.6), ["l-bracket-sweep"]),
    (
        "gui_flange",
        "flange",
        (12.0, 12.0, 1.0),
        ["flange-outer", "flange-bore", "flange-bolt-hole", "flange-bolt-pattern"],
    ),
    ("gui_stepped_shaft", "stepped-shaft", (4.0, 4.0, 12.0), ["stepped-shaft-revolve"]),
    ("gui_pipe_with_bore", "pipe", (6.0, 6.0, 10.0), ["pipe-outer", "pipe-bore"]),
    (
        "gui_bolt_circle_plate",
        "bolt-circle-plate",
        (10.0, 10.0, 0.8),
        ["bolt-circle-plate-base", "bolt-circle-plate-hole", "bolt-circle-plate-pattern"],
    ),
    ("gui_l_bracket_3_holes", "l-bracket", (8.0, 8.0, 0.6), ["l-bracket-sweep"]),
    (
        "gui_flange_8_bolts",
        "flange",
        (12.0, 12.0, 1.0),
        ["flange-outer", "flange-bore", "flange-bolt-hole", "flange-bolt-pattern"],
    ),
    (
        "gui_bolt_circle_plate_6_holes",
        "bolt-circle-plate",
        (10.0, 10.0, 0.8),
        ["bolt-circle-plate-base", "bolt-circle-plate-hole", "bolt-circle-plate-pattern"],
    ),
]


@pytest.mark.parametrize(("stem", "label", "span", "feature_ids"), CASES)
def test_mechanical_template_builds_one_solid(
    stem: str,
    label: str,
    span: tuple[float, float, float],
    feature_ids: list[str],
    tmp_path: Path,
) -> None:
    """The canonical mechanical fixture builds one solid at its shipped size."""
    document = _ASSETS / f"{stem}.nuke-cad"
    assert document.exists(), document

    result = geometry_service.build_document(
        str(document),
        output_dir=str(tmp_path),
        export_dagmc=False,
        export_mesh=False,
    )
    assert result["success"] is True, result.get("error", "")
    assert result["solidCount"] == 1, result.get("selectorMap")
    assert result["faceCount"] == EXPECTED_FACES[stem], (stem, result["faceCount"])

    selector_map = result.get("selectorMap") or {}
    assert set(selector_map) == {label}, selector_map
    assert sorted(index for indices in selector_map.values() for index in indices) == [1]

    feature_results = result.get("featureResults") or []
    assert [entry.get("featureId") for entry in feature_results] == feature_ids, feature_results
    assert all(entry.get("status") == "built" for entry in feature_results), feature_results

    bbox = result["boundingBox"]
    measured = [bbox["max"][axis] - bbox["min"][axis] for axis in range(3)]
    for axis, expected in enumerate(span):
        assert measured[axis] == pytest.approx(expected, abs=0.01), (axis, measured, bbox)
