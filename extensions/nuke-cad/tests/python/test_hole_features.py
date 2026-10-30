#!/usr/bin/env python3
"""Hole wizard expansion (counterdrill/taper/drill-point/thread).

New parameters must leave existing hole geometry byte-identical when
absent; exclusivity and ranges are validated.
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

import feature_builder as fb
import pytest
from doc_build_helpers import _by_id, _hole_doc


def test_hole_counterdrill_matches_counterbore() -> None:
    """A counterdrill is a stepped cut with a flat seat: same volume as counterbore."""
    pytest.importorskip("build123d", reason="build123d not installed")
    drill = fb.build_document_shape(
        _hole_doc({"counterdrillDiameter": 4.0, "counterdrillDepth": 1.0})
    )
    bore = fb.build_document_shape(_hole_doc({"counterboreDiameter": 4.0, "counterboreDepth": 1.0}))
    assert _by_id(drill)["h"]["status"] == "built"
    assert drill["shape"] is not None and bore["shape"] is not None
    assert math.isclose(drill["shape"].volume, bore["shape"].volume, rel_tol=1e-9)
    expected = 600.0 - (math.pi * 1.0**2 * 4.0 + math.pi * (2.0**2 - 1.0**2) * 1.0)
    assert math.isclose(drill["shape"].volume, expected, rel_tol=1e-6)


def test_hole_taper_volume() -> None:
    """A taper widens the mouth at the taper half-angle; the deep end stays nominal."""
    pytest.importorskip("build123d", reason="build123d not installed")
    result = fb.build_document_shape(_hole_doc({"taperAngle": 10.0}))
    assert _by_id(result)["h"]["status"] == "built"
    top_radius = 1.0 + 4.0 * math.tan(math.radians(10.0))
    frustum = math.pi * 4.0 / 3.0 * (top_radius**2 + top_radius * 1.0 + 1.0)
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 600.0 - frustum, rel_tol=1e-6)


def test_hole_drill_point_blind_volume() -> None:
    """A blind hole with a drill point gains a cone tip below the cylinder."""
    pytest.importorskip("build123d", reason="build123d not installed")
    result = fb.build_document_shape(_hole_doc({"drillPointAngle": 118.0}))
    assert _by_id(result)["h"]["status"] == "built"
    tip_height = 1.0 / math.tan(math.radians(118.0 / 2.0))
    removed = math.pi * 1.0**2 * 4.0 + math.pi * 1.0**2 * tip_height / 3.0
    assert result["shape"] is not None
    assert math.isclose(result["shape"].volume, 600.0 - removed, rel_tol=1e-6)


def test_hole_drill_point_ignored_for_through_holes() -> None:
    """A drill point on a through-hole changes nothing."""
    pytest.importorskip("build123d", reason="build123d not installed")
    plain = fb.build_document_shape(_hole_doc({}, depth=None, base_length=5.0))
    tipped = fb.build_document_shape(
        _hole_doc({"drillPointAngle": 118.0}, depth=None, base_length=5.0)
    )
    assert _by_id(plain)["h"]["status"] == "built"
    assert plain["shape"] is not None and tipped["shape"] is not None
    assert math.isclose(tipped["shape"].volume, plain["shape"].volume, rel_tol=1e-9)
    assert math.isclose(plain["shape"].volume, 500.0 - math.pi * 1.0**2 * 5.0, rel_tol=1e-6)


def test_hole_thread_is_stored_only() -> None:
    """A cosmetic thread leaves the hole geometry byte-identical."""
    pytest.importorskip("build123d", reason="build123d not installed")
    plain = fb.build_document_shape(_hole_doc({}))
    threaded = fb.build_document_shape(_hole_doc({"thread": "cosmetic"}))
    assert _by_id(threaded)["h"]["status"] == "built"
    assert plain["shape"] is not None and threaded["shape"] is not None
    assert math.isclose(threaded["shape"].volume, plain["shape"].volume, rel_tol=1e-9)


def test_hole_expansion_validation() -> None:
    """Taper/drill ranges and the stepped-cut exclusivity are build errors."""
    pytest.importorskip("build123d", reason="build123d not installed")
    cases = [
        ({"taperAngle": 0.0}, "taperangle"),
        ({"taperAngle": 46.0}, "taperangle"),
        ({"drillPointAngle": 0.0}, "drillpointangle"),
        ({"drillPointAngle": 180.0}, "drillpointangle"),
        (
            {
                "counterboreDiameter": 4.0,
                "counterboreDepth": 1.0,
                "counterdrillDiameter": 4.0,
                "counterdrillDepth": 1.0,
            },
            "mutually exclusive",
        ),
        (
            {
                "countersinkDiameter": 4.0,
                "countersinkAngle": 60.0,
                "counterdrillDiameter": 4.0,
                "counterdrillDepth": 1.0,
            },
            "mutually exclusive",
        ),
    ]
    for extra, message in cases:
        result = fb.build_document_shape(_hole_doc(extra))
        assert _by_id(result)["h"]["status"] == "failed", extra
        assert message in _by_id(result)["h"]["error"].lower(), extra


def test_hole_thread_values_validate_pure() -> None:
    """Thread values validate without the geometry kernel."""
    assert fb._validate_modeled_thread("h", {}) is None
    assert fb._validate_modeled_thread("h", {"thread": None}) is None
    assert fb._validate_modeled_thread("h", {"thread": "none"}) is None
    assert fb._validate_modeled_thread("h", {"thread": "cosmetic"}) is None
    with pytest.raises(fb.FeatureBuilderError, match="unknown hole thread"):
        fb._validate_modeled_thread("h", {"thread": "left-handed"})
    with pytest.raises(fb.FeatureBuilderError, match="blind hole"):
        fb._validate_modeled_thread("h", {"thread": "modeled", "diameter": 10.0})
    with pytest.raises(fb.FeatureBuilderError, match="simple holes"):
        fb._validate_modeled_thread(
            "h",
            {"thread": "modeled", "diameter": 10.0, "depth": 6.0, "counterboreDiameter": 12.0},
        )
    with pytest.raises(fb.FeatureBuilderError, match="taperAngle"):
        fb._validate_modeled_thread(
            "h", {"thread": "modeled", "diameter": 10.0, "depth": 6.0, "taperAngle": 5.0}
        )
    with pytest.raises(fb.FeatureBuilderError, match="no ISO"):
        fb._validate_modeled_thread("h", {"thread": "modeled", "diameter": 7.3, "depth": 6.0})
    with pytest.raises(fb.FeatureBuilderError, match="no full turn"):
        fb._validate_modeled_thread("h", {"thread": "modeled", "diameter": 10.0, "depth": 1.0})
    spec = fb._validate_modeled_thread("h", {"thread": "modeled", "diameter": 10.0, "depth": 6.0})
    assert spec is not None
    assert spec.designation == "M10x1.5"
    assert spec.pitch_mm == 1.5
    assert spec.tap_drill_mm == 8.5
    assert spec.diameter_mm == 10.0


def test_modeled_thread_section_pure() -> None:
    """The groove section spans tap-to-nominal with a P/4 root flat."""
    corners = fb._modeled_thread_section(4.25, 5.0, 1.5)
    assert len(corners) == 4
    inner = [c for c in corners if c[0] < 4.25]
    outer = [c for c in corners if c[0] > 5.0]
    assert len(inner) == 2 and len(outer) == 2
    # P/4 root flat at the tap radius (5% pitch overshoot each side).
    assert inner[0][0] == inner[1][0] == 4.25 - 0.075
    assert abs(abs(inner[0][1] - inner[1][1]) - 2 * (3.0 * 1.5 / 8.0)) < 1e-12


def test_modeled_thread_cuts_helix_and_warns() -> None:
    """A modeled thread removes the helical groove and warns about facets."""
    pytest.importorskip("build123d", reason="build123d not installed")
    plain = fb.build_document_shape(_hole_doc({}))
    assert _by_id(plain)["h"]["status"] == "built"
    threaded = fb.build_document_shape(_hole_doc({"thread": "modeled"}))
    assert _by_id(threaded)["h"]["status"] == "built", _by_id(threaded)["h"].get("error")
    assert threaded["shape"] is not None and plain["shape"] is not None
    # M2x0.4 over a 4-deep hole: ten groove turns remove extra material.
    assert threaded["shape"].volume < plain["shape"].volume
    assert any("modeled thread" in w for w in threaded["warnings"])


def test_modeled_thread_rejects_combos() -> None:
    """Modeled threads on counterbore/taper/through holes fail clearly."""
    pytest.importorskip("build123d", reason="build123d not installed")
    bored = fb.build_document_shape(
        _hole_doc({"thread": "modeled", "counterboreDiameter": 4.0, "counterboreDepth": 1.0})
    )
    assert _by_id(bored)["h"]["status"] == "failed"
    assert "simple holes" in _by_id(bored)["h"]["error"].lower()
    through = fb.build_document_shape(_hole_doc({"thread": "modeled"}, depth=None))
    assert _by_id(through)["h"]["status"] == "failed"
    assert "blind hole" in _by_id(through)["h"]["error"].lower()
