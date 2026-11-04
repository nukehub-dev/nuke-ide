"""End-to-end: build every nuclear component-template fixture.

Each fixture is the canonical GUI-authored document for a shipped nuclear
template. The test builds the document through the production document
pipeline (no DAGMC or mesh export) and checks the solid count, selector map,
feature status, and shipped default bounding box. It runs only in the
full-dependency profile; ``NUKE_TEST_PYTHON`` is the gate and the test skips
cleanly when it is unset.
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

# Fixture stem, selector labels, expected solid count, and shipped default span
# in cm. The hex-cell span is pointy-to-pointy x flat-to-flat x height.
_HEX_PITCH = 1.26
CASES = [
    (
        "gui_hex_cell",
        ("fuel", "clad", "moderator"),
        3,
        (2 * _HEX_PITCH / (3**0.5), _HEX_PITCH, 1.0),
    ),
    ("gui_control_rod_guide_tube", ("guide-tube",), 1, (1.2, 1.2, 30.0)),
    ("gui_assembly_grid_plate", ("grid-plate",), 1, (4.2, 4.2, 0.3)),
]


@pytest.mark.parametrize(("stem", "labels", "solid_count", "span"), CASES)
def test_nuclear_template_builds_expected_solids(
    stem: str,
    labels: tuple[str, ...],
    solid_count: int,
    span: tuple[float, float, float],
    tmp_path: Path,
) -> None:
    """The canonical nuclear fixture builds its shipped solid set and size."""
    document = _ASSETS / f"{stem}.nuke-cad"
    assert document.exists(), document

    result = geometry_service.build_document(
        str(document),
        output_dir=str(tmp_path),
        export_dagmc=False,
        export_mesh=False,
    )
    assert result["success"] is True, result.get("error", "")
    assert result["solidCount"] == solid_count, result.get("selectorMap")

    selector_map = result.get("selectorMap") or {}
    assert set(selector_map) == set(labels), selector_map
    assert sorted(index for indices in selector_map.values() for index in indices) == list(
        range(1, solid_count + 1)
    )

    feature_results = result.get("featureResults") or []
    assert feature_results, "no feature results"
    assert all(entry.get("status") == "built" for entry in feature_results), feature_results

    bbox = result["boundingBox"]
    measured = [bbox["max"][axis] - bbox["min"][axis] for axis in range(3)]
    for axis, expected in enumerate(span):
        assert measured[axis] == pytest.approx(expected, abs=0.01), (axis, measured, bbox)
