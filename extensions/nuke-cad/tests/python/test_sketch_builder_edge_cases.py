#!/usr/bin/env python3
"""Edge-case and error-path tests for the sketch builder.

Covers malformed primitive validation, every datum kind the builder rejects,
the direct edge/face helper error paths, and the guarded heavy-import branches.
Geometry assertions use build123d; the guard tests load a private copy of the
module with the import blocked, so the shared module state stays untouched.
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

import builtins
import importlib.util
import math
import sys
import types
from collections.abc import Callable
from typing import Any

import pytest
import sketch_builder as sb

pytest.importorskip("build123d")


def _load_module_with_blocked_import(
    monkeypatch: pytest.MonkeyPatch,
    module_name: str,
    blocked: Callable[[str], bool],
) -> Any:
    """Execute a private copy of sketch_builder with selected imports blocked."""
    real_import = builtins.__import__

    def guarded(
        name: str,
        globals: dict[str, Any] | None = None,
        locals: dict[str, Any] | None = None,
        fromlist: tuple[str, ...] = (),
        level: int = 0,
    ) -> Any:
        if blocked(name):
            raise ImportError(f"blocked import {name}")
        return real_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", guarded)
    spec = importlib.util.spec_from_file_location(module_name, sb.__file__)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # ``dataclasses`` looks the owning module up in ``sys.modules``.
    monkeypatch.setitem(sys.modules, module_name, module)
    spec.loader.exec_module(module)
    return module


def _xy_datum() -> dict[str, Any]:
    return {"id": "dxy", "kind": "XY", "name": "XY"}


def _rect_sketch() -> dict[str, Any]:
    return {
        "id": "rect",
        "name": "rect",
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
        ],
        "constraints": [],
    }


def _point(pid: str, x: float, y: float) -> sb.SketchPoint:
    return sb.SketchPoint(id=pid, x=x, y=y, construction=False)


def _edges(primitives: list[dict[str, Any]], points: dict[str, sb.SketchPoint]) -> list[Any]:
    parsed = sb.parse_sketch_primitives(primitives)
    return sb._edges_from_primitives(parsed, points, sb.bd.Plane.XY)


# ---------------------------------------------------------------------------
# Guarded heavy imports.
# ---------------------------------------------------------------------------


def test_build123d_absence_degrades_to_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without build123d the module imports, reports the gap, and refuses planes."""
    module = _load_module_with_blocked_import(
        monkeypatch,
        "sketch_builder_no_build123d",
        lambda name: name == "build123d" or name.startswith("build123d."),
    )
    assert module.HAS_BUILD123D is False
    assert module.bd is None
    with pytest.raises(module.SketchError, match="build123d is not available"):
        module._build_plane({"kind": "XY"})


def test_ocp_absence_degrades_to_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without OCP the B-spline helper raises a clear error."""
    module = _load_module_with_blocked_import(
        monkeypatch,
        "sketch_builder_no_ocp",
        lambda name: name == "OCP" or name.startswith("OCP."),
    )
    assert module.HAS_OCP is False
    assert module.BRepBuilderAPI_MakeEdge is None
    with pytest.raises(module.SketchError, match="OCP is not available"):
        module._bspline_edge([(0.0, 0.0), (1.0, 1.0)], (0.0, 1.0), (3, 3), 2)


# ---------------------------------------------------------------------------
# Primitive validation.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("primitive", "match"),
    [
        ({"id": "p", "type": "point", "x": 0, "y": 0, "construction": "yes"}, "expected a boolean"),
        (
            {
                "id": "b",
                "type": "bspline",
                "pole_ids": [],
                "weights": [1.0],
                "knots": [0.0],
                "mult": [2],
                "degree": 1,
            },
            "non-empty list of point ids",
        ),
        (
            {
                "id": "b",
                "type": "bspline",
                "pole_ids": ["p1", 3],
                "weights": [1.0, 1.0],
                "knots": [0.0],
                "mult": [3],
                "degree": 1,
            },
            "entries must be non-empty strings",
        ),
        (
            {
                "id": "b",
                "type": "bspline",
                "pole_ids": ["p1", "p2"],
                "weights": [],
                "knots": [0.0],
                "mult": [3],
                "degree": 1,
            },
            "non-empty list of numbers",
        ),
        (
            {
                "id": "b",
                "type": "bspline",
                "pole_ids": ["p1", "p2"],
                "weights": [1.0, 1.0],
                "knots": [0.0],
                "mult": [],
                "degree": 1,
            },
            "non-empty list of integers",
        ),
        (
            {
                "id": "b",
                "type": "bspline",
                "pole_ids": ["p1", "p2"],
                "weights": [1.0, 1.0],
                "knots": [0.0],
                "mult": [0, 4],
                "degree": 1,
            },
            "positive integers",
        ),
    ],
)
def test_parse_rejects_malformed_fields(primitive: dict[str, Any], match: str) -> None:
    with pytest.raises(sb.SketchError, match=match):
        sb.parse_sketch_primitives([primitive])


def test_parse_rejects_non_object_and_duplicate_ids() -> None:
    with pytest.raises(sb.SketchError, match=r"primitives\[0\] must be an object"):
        sb.parse_sketch_primitives([42])  # type: ignore[list-item]
    with pytest.raises(sb.SketchError, match="duplicate primitive id 'p1'"):
        sb.parse_sketch_primitives(
            [
                {"id": "p1", "type": "point", "x": 0, "y": 0},
                {"id": "p1", "type": "point", "x": 1, "y": 1},
            ]
        )


# ---------------------------------------------------------------------------
# Datum planes.
# ---------------------------------------------------------------------------


def test_build_plane_supports_yz_and_xz() -> None:
    assert sb._build_plane({"id": "dyz", "kind": "YZ"}).z_dir.X == pytest.approx(1.0)
    assert sb._build_plane({"id": "dxz", "kind": "XZ"}).z_dir.Y == pytest.approx(-1.0)


def test_build_plane_from_three_points() -> None:
    plane = sb._build_plane(
        {
            "id": "d3",
            "kind": "threePoint",
            "points": [[10.0, 20.0, 30.0], [11.0, 20.0, 30.0], [10.0, 21.0, 30.0]],
        }
    )
    assert plane.origin.X == pytest.approx(10.0)
    assert plane.origin.Y == pytest.approx(20.0)
    assert plane.origin.Z == pytest.approx(30.0)
    assert plane.z_dir.Z == pytest.approx(1.0)


@pytest.mark.parametrize(
    ("datum", "match"),
    [
        ({"id": "d", "kind": "threePoint", "points": [[0, 0, 0]]}, "exactly 3 points"),
        (
            {"id": "d", "kind": "threePoint", "points": [[0, 0, 0], [1, 0, 0], [0, "x", 0]]},
            "finite \\[x, y, z\\]",
        ),
        (
            {"id": "d", "kind": "threePoint", "points": [[0, 0, 0], [0, 0, 0], [1, 0, 0]]},
            "coincident points",
        ),
        (
            {"id": "d", "kind": "threePoint", "points": [[0, 0, 0], [1, 0, 0], [2, 0, 0]]},
            "points are collinear",
        ),
        ({"id": "d", "kind": "face"}, "must be resolved to a workplane"),
        ({"id": "d", "kind": "midplane"}, "must be resolved to a workplane"),
        ({"id": "d", "kind": "line2Point"}, "is a line and cannot be used"),
        ({"id": "d", "kind": "polar"}, "unknown datum kind 'polar'"),
    ],
)
def test_build_plane_rejects_unsupported_datums(datum: dict[str, Any], match: str) -> None:
    with pytest.raises(sb.SketchError, match=match):
        sb._build_plane(datum)


def test_resolve_datum_rejects_unknown_id() -> None:
    with pytest.raises(sb.SketchError, match="unknown datum 'ghost'"):
        sb._resolve_datum("ghost", {"dxy": _xy_datum()})


# ---------------------------------------------------------------------------
# B-spline edge helper.
# ---------------------------------------------------------------------------


def test_bspline_edge_validates_pole_count() -> None:
    with pytest.raises(sb.SketchError, match="needs at least 3 poles"):
        sb._bspline_edge([(0.0, 0.0), (1.0, 1.0)], (0.0, 1.0), (3, 3), 2)


def test_bspline_edge_validates_knots_and_multiplicities() -> None:
    poles = [(0.0, 0.0), (1.0, 1.0), (2.0, 0.0)]
    with pytest.raises(sb.SketchError, match="knots length 2 does not match mult length 1"):
        sb._bspline_edge(poles, (0.0, 1.0), (3,), 2)
    with pytest.raises(sb.SketchError, match="multiplicities sum to 5"):
        sb._bspline_edge(poles, (0.0, 1.0), (2, 3), 2)


def test_bspline_edge_wraps_ocp_failure() -> None:
    """Non-increasing knots pass validation but fail inside OpenCASCADE."""
    poles = [(0.0, 0.0), (1.0, 1.0), (2.0, 0.0)]
    with pytest.raises(sb.SketchError, match="could not build bspline edge"):
        sb._bspline_edge(poles, (1.0, 0.0), (3, 3), 2)


# ---------------------------------------------------------------------------
# Edge construction error paths.
# ---------------------------------------------------------------------------


def test_edges_require_build123d(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sb, "bd", None)
    with pytest.raises(sb.SketchError, match="build123d is not available"):
        sb._edges_from_primitives([], {}, None)


def test_unknown_primitive_records_are_skipped() -> None:
    """Defensive branch for a record outside the known primitive union."""
    fake = types.SimpleNamespace(construction=False)
    assert sb._edges_from_primitives([fake], {}, sb.bd.Plane.XY) == []  # type: ignore[list-item]


@pytest.mark.parametrize(
    ("primitives", "points", "match"),
    [
        (
            [
                {"id": "p1", "type": "point", "x": 0, "y": 0},
                {"id": "l1", "type": "line", "p1_id": "p1", "p2_id": "p2"},
            ],
            {},
            "line 'l1' references unknown point 'p1'",
        ),
        (
            [{"id": "c1", "type": "circle", "c_id": "missing", "radius": 1.0}],
            {},
            "circle 'c1' references unknown center point 'missing'",
        ),
        (
            [
                {
                    "id": "a1",
                    "type": "arc",
                    "c_id": "missing",
                    "radius": 1.0,
                    "start_angle": 0.0,
                    "end_angle": 1.0,
                    "start_id": "s",
                    "end_id": "e",
                }
            ],
            {},
            "arc 'a1' references unknown center point 'missing'",
        ),
        (
            [{"id": "e1", "type": "ellipse", "c_id": "missing", "focus1_id": "f", "radmin": 1.0}],
            {},
            "ellipse 'e1' references unknown center point 'missing'",
        ),
        (
            [{"id": "e1", "type": "ellipse", "c_id": "c", "focus1_id": "missing", "radmin": 1.0}],
            {"c": _point("c", 0.0, 0.0)},
            "ellipse 'e1' references unknown focus point 'missing'",
        ),
    ],
)
def test_edges_reject_unknown_point_references(
    primitives: list[dict[str, Any]], points: dict[str, sb.SketchPoint], match: str
) -> None:
    with pytest.raises(sb.SketchError, match=match):
        _edges(primitives, points)


@pytest.mark.parametrize(
    ("primitive", "points", "match"),
    [
        (
            {
                "id": "l1",
                "type": "line",
                "p1_id": "p1",
                "p2_id": "p2",
            },
            {"p1": _point("p1", 0.0, 0.0), "p2": _point("p2", 0.0, 0.0)},
            "could not build line 'l1'",
        ),
        (
            {"id": "c1", "type": "circle", "c_id": "c", "radius": -1.0},
            {"c": _point("c", 0.0, 0.0)},
            "could not build circle 'c1'",
        ),
        (
            {
                "id": "a1",
                "type": "arc",
                "c_id": "c",
                "radius": -1.0,
                "start_angle": 0.0,
                "end_angle": math.pi / 2,
                "start_id": "s",
                "end_id": "e",
            },
            {"c": _point("c", 0.0, 0.0)},
            "could not build arc 'a1'",
        ),
        (
            {"id": "e1", "type": "ellipse", "c_id": "c", "focus1_id": "f", "radmin": -1.0},
            {"c": _point("c", 0.0, 0.0), "f": _point("f", 3.0, 0.0)},
            "could not build ellipse 'e1'",
        ),
    ],
)
def test_edges_wrap_build123d_failures(
    primitive: dict[str, Any], points: dict[str, sb.SketchPoint], match: str
) -> None:
    with pytest.raises(sb.SketchError, match=match):
        _edges([primitive], points)


def test_full_circle_arc_keeps_360_degree_sweep() -> None:
    """A positive 360-degree sweep collapses to 0 under fmod and is restored."""
    primitives = [
        {
            "id": "a1",
            "type": "arc",
            "c_id": "c",
            "radius": 2.0,
            "start_angle": 0.0,
            "end_angle": 2 * math.pi,
            "start_id": "s",
            "end_id": "e",
        }
    ]
    edges = _edges(primitives, {"c": _point("c", 0.0, 0.0)})
    assert edges[0].length == pytest.approx(2 * math.pi * 2.0)


def test_arc_sweep_defensive_normalization(monkeypatch: pytest.MonkeyPatch) -> None:
    """The +/-360 defensive branches run when fmod returns an out-of-range sweep."""
    primitives = [
        {
            "id": "a1",
            "type": "arc",
            "c_id": "c",
            "radius": 1.0,
            "start_angle": 0.0,
            "end_angle": math.pi / 2,
            "start_id": "s",
            "end_id": "e",
        }
    ]
    points = {"c": _point("c", 0.0, 0.0)}
    monkeypatch.setattr(sb.math, "fmod", lambda _value, _mod: -400.0)
    negative = _edges(primitives, points)
    assert negative[0].length == pytest.approx(math.radians(40.0))
    monkeypatch.setattr(sb.math, "fmod", lambda _value, _mod: 400.0)
    positive = _edges(primitives, points)
    assert positive[0].length == pytest.approx(math.radians(40.0))


# ---------------------------------------------------------------------------
# Wire/face assembly error paths.
# ---------------------------------------------------------------------------


def test_build_sketch_faces_requires_datum_id() -> None:
    sketch = {"id": "s", "name": "s", "primitives": []}
    with pytest.raises(sb.SketchError, match="has no datumId"):
        sb.build_sketch_faces(sketch, {"dxy": _xy_datum()}, plane=sb.bd.Plane.XY)


def test_build_sketch_faces_rejects_non_object_primitives() -> None:
    """A non-list primitives value is coerced, then rejected by the parser."""
    sketch = {"id": "s", "name": "s", "datumId": "dxy", "primitives": "not-a-list"}
    with pytest.raises(sb.SketchError, match=r"primitives\[0\] must be an object"):
        sb.build_sketch_faces(sketch, {"dxy": _xy_datum()}, plane=sb.bd.Plane.XY)


def test_extra_primitives_are_appended_but_not_drawn() -> None:
    extra = [
        {"id": "aux", "type": "point", "x": 5.0, "y": 5.0},
        {
            "id": "diag",
            "type": "line",
            "p1_id": "p1",
            "p2_id": "p3",
            "construction": True,
        },
    ]
    plane, faces = sb.build_sketch_faces(
        _rect_sketch(), {"dxy": _xy_datum()}, extra_primitives=extra
    )
    assert len(faces) == 1
    assert faces[0].area == pytest.approx(100.0)


def test_sketch_with_only_points_has_no_edges() -> None:
    sketch = {
        "id": "dots",
        "name": "dots",
        "datumId": "dxy",
        "primitives": [{"id": "p1", "type": "point", "x": 1.0, "y": 2.0}],
        "constraints": [],
    }
    with pytest.raises(sb.SketchError, match="contains no drawable edges"):
        sb.build_sketch_faces(sketch, {"dxy": _xy_datum()})


def test_wire_combine_failure_is_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(_edges: Any) -> Any:
        raise RuntimeError("combine failed")

    monkeypatch.setattr(sb.bd.Wire, "combine", boom)
    with pytest.raises(sb.SketchError, match="could not combine edges"):
        sb.build_sketch_faces(_rect_sketch(), {"dxy": _xy_datum()})


def test_build_faces_requires_build123d(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sb, "bd", None)
    with pytest.raises(sb.SketchError, match="build123d is not available"):
        sb._build_faces_from_wires([], "s")


def test_build_faces_wraps_face_construction_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    def broken_face(_wire: Any) -> Any:
        raise RuntimeError("no face")

    monkeypatch.setattr(sb.bd, "Face", broken_face)
    wires = [types.SimpleNamespace(is_closed=True)]
    with pytest.raises(sb.SketchError, match="could not build face from wire"):
        sb._build_faces_from_wires(wires, "s")


def test_containment_probe_failures_leave_wires_as_outer_profiles(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failing is_inside probe skips classification instead of aborting."""

    class ExplodingFace:
        area = 1.0

        def center(self) -> tuple[float, float]:
            return (0.0, 0.0)

        def is_inside(self, _point: Any) -> bool:
            raise RuntimeError("probe failed")

    wires = [types.SimpleNamespace(is_closed=True), types.SimpleNamespace(is_closed=True)]
    faces_by_wire = {id(wires[0]): ExplodingFace(), id(wires[1]): ExplodingFace()}
    monkeypatch.setattr(sb.bd, "Face", lambda wire: faces_by_wire[id(wire)])
    faces = sb._build_faces_from_wires(wires, "s")
    assert len(faces) == 2


def test_face_with_holes_failure_is_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeFace:
        def __init__(self, area: float, contains: bool) -> None:
            self.area = area
            self._contains = contains

        def center(self) -> tuple[float, float]:
            return (0.0, 0.0)

        def is_inside(self, _point: Any) -> bool:
            return self._contains

    outer_wire = types.SimpleNamespace(is_closed=True)
    inner_wire = types.SimpleNamespace(is_closed=True)
    faces_by_wire = {id(outer_wire): FakeFace(100.0, True), id(inner_wire): FakeFace(1.0, False)}

    def fake_face(wire: Any, holes: Any = None) -> Any:
        if holes is not None:
            raise RuntimeError("hole cut failed")
        return faces_by_wire[id(wire)]

    monkeypatch.setattr(sb.bd, "Face", fake_face)
    with pytest.raises(sb.SketchError, match="could not build face with holes"):
        sb._build_faces_from_wires([outer_wire, inner_wire], "s")
