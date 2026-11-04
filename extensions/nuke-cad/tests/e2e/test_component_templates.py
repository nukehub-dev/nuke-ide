"""End-to-end: build every primitive component-template fixture.

Each fixture is the canonical GUI-authored document for a shipped primitive. The
test builds the document through the production document pipeline (no DAGMC or
mesh export) and checks that it produces exactly one solid with the shipped
default dimensions. It runs only in the full-dependency profile;
``NUKE_TEST_PYTHON`` is the gate and the test skips cleanly when it is unset.
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

# Fixture stem, expected selector label, and the shipped default span in cm.
CASES = [
    ("gui_box", "box", (10.0, 6.0, 4.0)),
    ("gui_cylinder", "cylinder", (5.0, 5.0, 8.0)),
    ("gui_tube", "tube", (6.0, 6.0, 6.0)),
    ("gui_sphere", "sphere", (6.0, 6.0, 6.0)),
    ("gui_cone", "cone", (6.0, 6.0, 6.0)),
    ("gui_plate_with_hole", "plate", (12.0, 8.0, 0.6)),
]


@pytest.mark.parametrize(("stem", "label", "span"), CASES)
def test_primitive_template_builds_one_solid(
    stem: str, label: str, span: tuple[float, float, float], tmp_path: Path
) -> None:
    """The canonical primitive fixture builds one solid at its shipped size."""
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

    selector_map = result.get("selectorMap") or {}
    assert set(selector_map) == {label}, selector_map
    assert sorted(index for indices in selector_map.values() for index in indices) == [1]

    feature_results = result.get("featureResults") or []
    assert feature_results, "no feature results"
    assert all(entry.get("status") == "built" for entry in feature_results), feature_results

    bbox = result["boundingBox"]
    measured = [bbox["max"][axis] - bbox["min"][axis] for axis in range(3)]
    for axis, expected in enumerate(span):
        assert measured[axis] == pytest.approx(expected, abs=0.01), (axis, measured, bbox)
