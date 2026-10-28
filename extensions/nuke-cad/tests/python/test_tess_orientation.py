#!/usr/bin/env python3
"""Outward triangle winding for tessellated solids.

``geometry_service._tessellate_shape`` must emit outward-wound triangles. OCCT
triangulations follow each face's natural surface orientation, so faces a shell
stores ``TopAbs_REVERSED`` (e.g. one of a cylinder's two caps) would otherwise
mesh inward. Signed volume computed from the emitted triangles is the
regression signal: it must be positive and match OCCT's B-rep volume. On a
convex box every face's area-weighted normal must additionally point away from
the solid centroid.

OCP-gated: the minimal profile (pytest + numpy only) skips this module.
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

from typing import Any

import numpy as np
import pytest

pytest.importorskip("OCP", reason="OCP not installed")

import geometry_service  # noqa: E402

TOLERANCE = 0.001
VOLUME_TOLERANCE = 0.01
# Deliberately off-origin: a reversed face lying in a plane through the origin
# contributes zero to the signed volume either way, which would mask the bug.
ORIGIN = (2.0, 3.0, 5.0)


def _box(
    dx: float = 10.0,
    dy: float = 6.0,
    dz: float = 4.0,
    origin: tuple[float, float, float] = ORIGIN,
) -> Any:
    """Axis-aligned OCP box with its minimum corner at ``origin``."""
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt

    ox, oy, oz = origin
    return BRepPrimAPI_MakeBox(gp_Pnt(ox, oy, oz), gp_Pnt(ox + dx, oy + dy, oz + dz)).Shape()


def _occt_solids(shape: Any) -> list[Any]:
    """Solid sub-shapes in the explorer order ``_tessellate_shape`` walks."""
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    solids: list[Any] = []
    explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    while explorer.More():
        solids.append(TopoDS.Solid_s(explorer.Current()))
        explorer.Next()
    return solids


def _occt_mass_properties(solid: Any) -> tuple[float, np.ndarray]:
    """B-rep volume and centre of mass of one solid (ground truth for the mesh)."""
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(solid, props)
    com = props.CentreOfMass()
    return float(props.Mass()), np.array([com.X(), com.Y(), com.Z()])


def _triangles(face: dict[str, Any]) -> np.ndarray:
    """``(n, 3, 3)`` array of triangle corner coordinates for one tessellated face."""
    nodes = np.asarray(face["nodes"], dtype=float)
    indices = np.asarray(face["triangles"], dtype=int)
    return nodes[indices]


def _solid_triangles(solid: dict[str, Any]) -> np.ndarray:
    corners = [_triangles(face) for face in solid["faces"] if face["triangles"]]
    assert corners, "tessellated solid carries no triangles"
    return np.concatenate(corners, axis=0)


def _signed_volume(corners: np.ndarray) -> float:
    """Divergence-theorem volume: ``sum(dot(a, cross(b, c)) / 6)``."""
    a, b, c = corners[:, 0], corners[:, 1], corners[:, 2]
    return float(np.sum(np.einsum("ij,ij->i", a, np.cross(b, c))) / 6.0)


def _face_normal_and_centre(face: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    """Area-weighted normal and area-weighted centre of one tessellated face."""
    corners = _triangles(face)
    cross = np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0])
    areas = 0.5 * np.linalg.norm(cross, axis=1)
    assert areas.sum() > 0.0
    centre = (areas[:, None] * corners.mean(axis=1)).sum(axis=0) / areas.sum()
    return cross.sum(axis=0), centre


def _assert_outward_volume(shape: Any) -> None:
    """Every solid must have a positive mesh volume matching its B-rep volume."""
    solids = geometry_service._tessellate_shape(shape, TOLERANCE)
    occt_solids = _occt_solids(shape)
    assert len(solids) == len(occt_solids) > 0

    for solid, occt_solid in zip(solids, occt_solids, strict=True):
        mesh_volume = _signed_volume(_solid_triangles(solid))
        brep_volume, _ = _occt_mass_properties(occt_solid)
        assert mesh_volume > 0.0, f"solid {solid['solidId']} tessellated inward"
        assert mesh_volume == pytest.approx(brep_volume, rel=VOLUME_TOLERANCE)


def _cut_shape() -> Any:
    """Larger box minus a corner-intersecting smaller box (open boolean notch)."""
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut

    outer = _box(12.0, 12.0, 12.0)
    tool = _box(8.0, 8.0, 8.0, origin=(8.0, 9.0, 11.0))
    operation = BRepAlgoAPI_Cut(outer, tool)
    operation.Build()
    assert operation.IsDone()
    return operation.Shape()


def test_box_triangles_are_outward_wound() -> None:
    """Convex box: signed volume matches the B-rep and every normal points out."""
    shape = _box()
    solids = geometry_service._tessellate_shape(shape, TOLERANCE)
    brep_volume, center = _occt_mass_properties(_occt_solids(shape)[0])
    assert len(solids) == 1

    mesh_volume = _signed_volume(_solid_triangles(solids[0]))
    assert mesh_volume > 0.0
    assert mesh_volume == pytest.approx(brep_volume, rel=VOLUME_TOLERANCE)
    assert mesh_volume == pytest.approx(240.0, rel=VOLUME_TOLERANCE)

    for face in solids[0]["faces"]:
        normal, face_centre = _face_normal_and_centre(face)
        assert float(np.dot(normal, face_centre - center)) > 0.0


def test_cylinder_caps_are_outward_wound() -> None:
    """The reported shape: one of the two cylinder caps is stored reversed."""
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt

    axis = gp_Ax2(gp_Pnt(*ORIGIN), gp_Dir(0.0, 0.0, 1.0))
    shape = BRepPrimAPI_MakeCylinder(axis, 5.0, 10.0).Shape()
    solids = geometry_service._tessellate_shape(shape, TOLERANCE)
    brep_volume, _ = _occt_mass_properties(_occt_solids(shape)[0])
    assert len(solids) == 1

    mesh_volume = _signed_volume(_solid_triangles(solids[0]))
    assert mesh_volume > 0.0
    assert mesh_volume == pytest.approx(brep_volume, rel=VOLUME_TOLERANCE)


def test_boolean_cut_triangles_are_outward_wound() -> None:
    """Boolean result keeps outward winding (the regression that caught R-B)."""
    shape = _cut_shape()
    _assert_outward_volume(shape)

    solids = geometry_service._tessellate_shape(shape, TOLERANCE)
    _, center = _occt_mass_properties(_occt_solids(shape)[0])
    mesh_volume = _signed_volume(_solid_triangles(solids[0]))
    assert mesh_volume == pytest.approx(1512.0, rel=VOLUME_TOLERANCE)
    # The notch's newly created walls must still face away from the bulk.
    for face in solids[0]["faces"]:
        normal, face_centre = _face_normal_and_centre(face)
        assert float(np.dot(normal, face_centre - center)) > 0.0
