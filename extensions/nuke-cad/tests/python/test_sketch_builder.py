#!/usr/bin/env python3
"""Tests for the nuke-cad sketch builder.

Minimal-profile tests exercise the pure parsing/error path. Full-profile tests
require build123d and verify actual face geometry.
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

import pytest
import sketch_builder as sb


def _xy_datum() -> dict[str, Any]:
    return {"id": "dxy", "kind": "XY", "name": "XY"}


def _rect_sketch() -> dict[str, Any]:
    return {
        "id": "rect",
        "name": "rectangle",
        "datumId": "dxy",
        "primitives": [
            {"id": "p1", "type": "point", "x": 0, "y": 0},
            {"id": "p2", "type": "point", "x": 40, "y": 0},
            {"id": "p3", "type": "point", "x": 40, "y": 20},
            {"id": "p4", "type": "point", "x": 0, "y": 20},
            {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
            {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
            {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
            {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
        ],
        "constraints": [],
    }


def test_parse_all_primitive_types() -> None:
    primitives = [
        {"id": "p1", "type": "point", "x": 1.0, "y": 2.0},
        {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
        {"id": "c1", "type": "circle", "c_id": "p1", "radius": 5.0},
        {
            "id": "a1",
            "type": "arc",
            "c_id": "p1",
            "radius": 3.0,
            "start_angle": 0.0,
            "end_angle": math.pi / 2,
            "start_id": "p1",
            "end_id": "p2",
        },
    ]
    parsed = sb.parse_sketch_primitives(primitives)
    assert len(parsed) == 4
    assert isinstance(parsed[0], sb.SketchPoint) and parsed[0].x == 1.0
    assert isinstance(parsed[1], sb.SketchLine) and parsed[1].p1_id == "p1"
    assert isinstance(parsed[2], sb.SketchCircle) and parsed[2].radius == 5.0
    assert isinstance(parsed[3], sb.SketchArc) and parsed[3].end_angle == math.pi / 2


def test_parse_accepts_camel_case_aliases() -> None:
    primitives = [
        {"id": "p1", "type": "point", "x": 0, "y": 0},
        {"id": "l1", "type": "line", "p1Id": "p1", "p2Id": "p2"},
        {"id": "c1", "type": "circle", "centerId": "p1", "radius": 1.0},
        {
            "id": "a1",
            "type": "arc",
            "centerId": "p1",
            "radius": 1.0,
            "startAngle": 0.0,
            "endAngle": 1.0,
            "startId": "p1",
            "endId": "p2",
        },
    ]
    parsed = sb.parse_sketch_primitives(primitives)
    assert isinstance(parsed[1], sb.SketchLine)
    assert parsed[1].p1_id == "p1"
    assert isinstance(parsed[2], sb.SketchCircle)
    assert parsed[2].center_id == "p1"
    assert isinstance(parsed[3], sb.SketchArc)
    assert parsed[3].start_angle == 0.0


def test_construction_geometry_is_parsed_but_skipped() -> None:
    primitives = [
        {"id": "p1", "type": "point", "x": 0, "y": 0},
        {"id": "p2", "type": "point", "x": 1, "y": 0},
        {"id": "p3", "type": "point", "x": 1, "y": 1},
        {"id": "p4", "type": "point", "x": 0, "y": 1},
        {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
        {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
        {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
        {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
        {"id": "diag", "type": "line", "p1_id": "p1", "p2_id": "p3", "construction": True},
    ]
    parsed = sb.parse_sketch_primitives(primitives)
    lines = [p for p in parsed if isinstance(p, sb.SketchLine)]
    assert sum(1 for line in lines if line.construction) == 1
    pytest.importorskip("build123d", reason="build123d not installed")
    plane, faces = sb.build_sketch_faces(
        {"id": "s", "name": "s", "datumId": "dxy", "primitives": primitives, "constraints": []},
        {"dxy": _xy_datum()},
    )
    assert len(faces) == 1
    assert faces[0].area == pytest.approx(1.0, abs=1e-9)


def test_parse_rejects_unknown_type() -> None:
    with pytest.raises(sb.SketchError, match="unknown or missing type"):
        sb.parse_sketch_primitives([{"id": "x", "type": "spline"}])


def test_parse_rejects_missing_id() -> None:
    with pytest.raises(sb.SketchError, match="missing required string field 'id'"):
        sb.parse_sketch_primitives([{"type": "point", "x": 0, "y": 0}])


def test_parse_rejects_non_finite_radius() -> None:
    with pytest.raises(sb.SketchError, match="must be a finite number"):
        sb.parse_sketch_primitives(
            [
                {"id": "p", "type": "point", "x": 0, "y": 0},
                {"id": "c", "type": "circle", "c_id": "p", "radius": "big"},
            ]
        )


def test_open_wire_raises() -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    sketch = {
        "id": "open",
        "name": "open",
        "datumId": "dxy",
        "primitives": [
            {"id": "p1", "type": "point", "x": 0, "y": 0},
            {"id": "p2", "type": "point", "x": 1, "y": 0},
            {"id": "p3", "type": "point", "x": 1, "y": 1},
            {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
            {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
        ],
        "constraints": [],
    }
    with pytest.raises(sb.SketchError, match="open wire"):
        sb.build_sketch_faces(sketch, {"dxy": _xy_datum()})


def test_build123d_absence_is_forced(monkeypatch: pytest.MonkeyPatch) -> None:
    """When build123d is unavailable, geometry construction raises a clear error."""
    monkeypatch.setitem(sys.modules, "build123d", None)
    monkeypatch.setattr(sb, "HAS_BUILD123D", False)
    monkeypatch.setattr(sb, "bd", None)
    with pytest.raises(sb.SketchError, match="build123d is not available"):
        sb.build_sketch_faces(_rect_sketch(), {"dxy": _xy_datum()})


def test_rectangle_face_area() -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    plane, faces = sb.build_sketch_faces(_rect_sketch(), {"dxy": _xy_datum()})
    assert len(faces) == 1
    assert faces[0].area == pytest.approx(800.0, abs=1e-6)


def test_circle_face_area() -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    sketch = {
        "id": "circ",
        "name": "circ",
        "datumId": "dxy",
        "primitives": [
            {"id": "c", "type": "point", "x": 0, "y": 0},
            {"id": "circle", "type": "circle", "c_id": "c", "radius": 5.0},
        ],
        "constraints": [],
    }
    plane, faces = sb.build_sketch_faces(sketch, {"dxy": _xy_datum()})
    assert len(faces) == 1
    assert faces[0].area == pytest.approx(math.pi * 25.0, abs=1e-6)


def test_arc_closed_profile_area() -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    sketch = {
        "id": "arc",
        "name": "arc",
        "datumId": "dxy",
        "primitives": [
            {"id": "c", "type": "point", "x": 0, "y": 0},
            {"id": "s", "type": "point", "x": 5, "y": 0},
            {"id": "e", "type": "point", "x": -5, "y": 0},
            {
                "id": "arc",
                "type": "arc",
                "c_id": "c",
                "radius": 5.0,
                "start_angle": 0.0,
                "end_angle": math.pi,
                "start_id": "s",
                "end_id": "e",
            },
            {"id": "line", "type": "line", "p1_id": "e", "p2_id": "s"},
        ],
        "constraints": [],
    }
    plane, faces = sb.build_sketch_faces(sketch, {"dxy": _xy_datum()})
    assert len(faces) == 1
    assert faces[0].area == pytest.approx(math.pi * 25.0 / 2.0, abs=1e-6)


def test_offset_datum_placement() -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    datums = {"dz": {"id": "dz", "kind": "offset", "name": "off", "offset": 5.0}}
    sketch = {
        "id": "rect",
        "name": "rect",
        "datumId": "dz",
        "primitives": _rect_sketch()["primitives"],
        "constraints": [],
    }
    plane, faces = sb.build_sketch_faces(sketch, datums)
    assert plane.origin.Z == pytest.approx(5.0, abs=1e-9)


def test_hole_in_rectangle_face_area() -> None:
    pytest.importorskip("build123d", reason="build123d not installed")
    sketch = {
        "id": "hole",
        "name": "hole",
        "datumId": "dxy",
        "primitives": [
            {"id": "p1", "type": "point", "x": 0, "y": 0},
            {"id": "p2", "type": "point", "x": 10, "y": 0},
            {"id": "p3", "type": "point", "x": 10, "y": 10},
            {"id": "p4", "type": "point", "x": 0, "y": 10},
            {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
            {"id": "l2", "type": "line", "p1_id": "p2", "p2_id": "p3"},
            {"id": "l3", "type": "line", "p1_id": "p3", "p2_id": "p4"},
            {"id": "l4", "type": "line", "p1_id": "p4", "p2_id": "p1"},
            {"id": "cc", "type": "point", "x": 5, "y": 5},
            {"id": "hole", "type": "circle", "c_id": "cc", "radius": 2.0},
        ],
        "constraints": [],
    }
    plane, faces = sb.build_sketch_faces(sketch, {"dxy": _xy_datum()})
    assert len(faces) == 1
    assert faces[0].area == pytest.approx(100.0 - math.pi * 4.0, abs=1e-6)


def test_arc_sweep_normalization_via_fmod() -> None:
    """A sweep > 360 deg is normalized before building the build123d arc."""
    pytest.importorskip("build123d", reason="build123d not installed")
    # 45 degree sector: arc from 0 to 405 deg should normalize to 0..45 deg.
    sketch = {
        "id": "sector",
        "name": "sector",
        "datumId": "dxy",
        "primitives": [
            {"id": "c", "type": "point", "x": 0, "y": 0},
            {"id": "s", "type": "point", "x": 5, "y": 0},
            {
                "id": "e",
                "type": "point",
                "x": 5 * math.cos(math.radians(45)),
                "y": 5 * math.sin(math.radians(45)),
            },
            {
                "id": "arc",
                "type": "arc",
                "c_id": "c",
                "radius": 5.0,
                "start_angle": 0.0,
                "end_angle": math.radians(405.0),
                "start_id": "s",
                "end_id": "e",
            },
            {"id": "l1", "type": "line", "p1_id": "c", "p2_id": "s"},
            {"id": "l2", "type": "line", "p1_id": "e", "p2_id": "c"},
        ],
        "constraints": [],
    }
    plane, faces = sb.build_sketch_faces(sketch, {"dxy": _xy_datum()})
    assert len(faces) == 1
    assert faces[0].area == pytest.approx(math.pi * 25.0 * 45.0 / 360.0, abs=1e-6)
