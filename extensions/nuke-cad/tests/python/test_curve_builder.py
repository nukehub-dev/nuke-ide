#!/usr/bin/env python3
"""Tests for the nuke-cad curve builder.

Minimal-profile tests exercise parsing and error paths plus the forced-absence
guard. Full-profile tests require OCP and verify B-spline wire construction.
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
from pathlib import Path
from typing import Any

import curve_builder as cb
import pytest


def _document_with_curve(curve: dict[str, Any]) -> dict[str, Any]:
    return {"version": 3, "name": "test", "curves": [curve]}


def _circle_samples(count: int) -> list[tuple[float, float, float]]:
    # Include the closing point so the curve is detected as closed.
    return [
        (math.cos(2 * math.pi * i / count), math.sin(2 * math.pi * i / count), 0.0)
        for i in range(count + 1)
    ]


def test_requires_at_least_four_samples() -> None:
    doc = _document_with_curve(
        {
            "id": "c1",
            "name": "Short",
            "source": {"kind": "points"},
            "samples": [(0, 0, 0), (1, 0, 0), (2, 0, 0)],
        }
    )
    with pytest.raises(cb.CurveBuildError, match="at least 4 samples"):
        cb.build_curves(doc)


def test_rejects_non_numeric_samples() -> None:
    doc = _document_with_curve(
        {
            "id": "c1",
            "name": "Bad",
            "source": {"kind": "points"},
            "samples": [(0, 0, 0), (1, 0, 0), ("x", 0, 0), (3, 0, 0)],
        }
    )
    with pytest.raises(cb.CurveBuildError, match="non-numeric"):
        cb.build_curves(doc)


def test_rejects_malformed_samples() -> None:
    doc = _document_with_curve(
        {
            "id": "c1",
            "name": "Bad",
            "source": {"kind": "points"},
            "samples": [(0, 0, 0), (1, 0, 0), (2, 0), (3, 0, 0)],
        }
    )
    with pytest.raises(cb.CurveBuildError, match="sample must be"):
        cb.build_curves(doc)


def test_closed_detection_for_near_coincident_endpoints() -> None:
    samples = _circle_samples(32)
    assert cb._is_closed(samples) is True


def test_open_detection_for_distant_endpoints() -> None:
    samples = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (2, 1, 0)]
    assert cb._is_closed(samples) is False


def test_average_spacing() -> None:
    samples = [(0, 0, 0), (1, 0, 0), (3, 0, 0)]
    assert cb._average_spacing(samples) == pytest.approx(1.5)


def test_closed_detection_tolerates_noisy_closing_point() -> None:
    # A noisy import may land the closing point a few percent of a sample
    # spacing away from the start; that must still count as closed (the old
    # bbox-relative tolerance would have called this open).
    samples = [
        (1000.0 * math.cos(2 * math.pi * i / 256), 1000.0 * math.sin(2 * math.pi * i / 256), 0.0)
        for i in range(256)
    ]
    first = samples[0]
    samples[-1] = (first[0] + 1.2, first[1], first[2])
    assert cb._is_closed(samples) is True


def test_open_detection_for_arc_with_nearby_endpoints() -> None:
    # An almost-full-turn open arc: the endpoint gap is a small fraction of the
    # bounding box yet about two sample spacings, so it must stay open.
    count = 64
    sweep = math.radians(359.0)
    samples = [
        (math.cos(sweep * i / (count - 1)), math.sin(sweep * i / (count - 1)), 0.0)
        for i in range(count)
    ]
    assert cb._is_closed(samples) is False


def test_forced_ocp_absence_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """When OCP is unavailable, curve building raises a clear error."""
    monkeypatch.setattr(cb, "HAS_OCP", False)
    doc = _document_with_curve(
        {
            "id": "c1",
            "name": "Circle",
            "source": {"kind": "points"},
            "samples": _circle_samples(8),
        }
    )
    with pytest.raises(cb.CurveBuildError, match="requires OCP"):
        cb.build_curves(doc)


def _max_sample_to_wire_distance(wire: Any, points: list[tuple[float, float, float]]) -> float:
    """Maximum distance from each sample point to the wire (full profile only)."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    from OCP.gp import gp_Pnt

    worst = 0.0
    for x, y, z in points:
        vertex = BRepBuilderAPI_MakeVertex(gp_Pnt(x, y, z)).Vertex()
        extrema = BRepExtrema_DistShapeShape(vertex, wire)
        assert extrema.IsDone()
        worst = max(worst, extrema.Value())
    return worst


def test_parametric_circle_interpolation_exactness() -> None:
    """Interpolated parametric samples lie on the fitted wire."""
    pytest.importorskip("OCP", reason="OCP not installed")
    doc = _document_with_curve(
        {
            "id": "c1",
            "name": "Circle",
            "source": {
                "kind": "parametric",
                "x": "cos(t)",
                "y": "sin(t)",
                "z": "0",
                "tStart": 0,
                "tEnd": 2 * math.pi,
                "sampleCount": 64,
            },
            "samples": _circle_samples(64),
        }
    )
    results = cb.build_curves(doc)
    assert "c1" in results
    assert results["c1"]["closed"] is True
    assert results["c1"]["wire"] is not None
    # Interpolation passes through every sample, so each point lies on the wire.
    max_deviation = _max_sample_to_wire_distance(results["c1"]["wire"], results["c1"]["points"])
    assert max_deviation < 1e-9


def test_points_source_uses_approximation_with_tolerance() -> None:
    """A points-sourced curve deviates from its samples by at most the fit tolerance."""
    pytest.importorskip("OCP", reason="OCP not installed")
    samples = [(0, 0, 0), (1, 0.1, 0), (2, -0.1, 0), (3, 0, 0)]
    doc = _document_with_curve(
        {
            "id": "c1",
            "name": "Noisy line",
            "source": {"kind": "points"},
            "samples": samples,
        }
    )
    results = cb.build_curves(doc)
    assert "c1" in results
    assert results["c1"]["closed"] is False
    # Mirror the tolerance curve_builder._approximate derives from the sample spacing.
    tolerance = max(1e-6, cb._average_spacing(samples) * 0.05)
    max_deviation = _max_sample_to_wire_distance(results["c1"]["wire"], results["c1"]["points"])
    assert max_deviation <= tolerance


def test_fourier_source_sanity() -> None:
    """A Fourier-series circle reconstructs a closed wire."""
    pytest.importorskip("OCP", reason="OCP not installed")
    doc = _document_with_curve(
        {
            "id": "c1",
            "name": "Fourier circle",
            "source": {
                "kind": "fourier",
                "nfp": 1,
                "order": 1,
                "cosX": [0, 1],
                "sinX": [0, 0],
                "cosY": [0, 0],
                "sinY": [0, 1],
                "cosZ": [0, 0],
                "sinZ": [0, 0],
                "sampleCount": 64,
            },
            "samples": _circle_samples(64),
        }
    )
    results = cb.build_curves(doc)
    assert "c1" in results
    assert results["c1"]["closed"] is True


def test_w7x_fixture_round_trip() -> None:
    """The committed W7X coil centerline builds as a closed wire."""
    pytest.importorskip("OCP", reason="OCP not installed")
    fixture = Path(__file__).parent.parent / "e2e" / "assets" / "w7x_coil_centerline.json"
    assert fixture.exists(), f"missing fixture {fixture}"
    samples = json.loads(fixture.read_text())
    assert isinstance(samples, list) and len(samples) >= 4
    doc = _document_with_curve(
        {
            "id": "w7x",
            "name": "W7X coil centerline",
            "source": {"kind": "points"},
            "samples": [tuple(p) for p in samples],
        }
    )
    results = cb.build_curves(doc)
    assert "w7x" in results
    assert results["w7x"]["closed"] is True
    # The polyline is explicitly closed, so the first/last sample distance is
    # essentially zero; interpolation should preserve that.
    first = samples[0]
    last = samples[-1]
    assert math.dist(first, last) < 1e-9
