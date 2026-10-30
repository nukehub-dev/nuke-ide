#!/usr/bin/env python3
"""Edge-case and error-path tests for the pre-export inspection gates.

Covers warning-only validation branches (non-finite area/COM, malformed
entries), the OCP-backed mass-property gate's best-effort failure paths, the
numpy-free mesh-volume integration, and the never-raise wrapper around the
mesh-vs-CAD comparison. The numpy-free test loads a private copy of the module
with the import blocked.
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
from collections.abc import Callable
from typing import Any

import inspection_gates as ig
import pytest

_UNIT_CUBE_VERTICES = [
    [0.0, 0.0, 0.0],
    [1.0, 0.0, 0.0],
    [1.0, 1.0, 0.0],
    [0.0, 1.0, 0.0],
    [0.0, 0.0, 1.0],
    [1.0, 0.0, 1.0],
    [1.0, 1.0, 1.0],
    [0.0, 1.0, 1.0],
]
_UNIT_CUBE_TRIANGLES = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 0, 4],
    [3, 4, 7],
]


def _load_module_with_blocked_import(
    monkeypatch: pytest.MonkeyPatch, module_name: str, blocked: Callable[[str], bool]
) -> Any:
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
    spec = importlib.util.spec_from_file_location(module_name, ig.__file__)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, module_name, module)
    spec.loader.exec_module(module)
    return module


def test_mesh_volume_falls_back_to_pure_python(monkeypatch: pytest.MonkeyPatch) -> None:
    module = _load_module_with_blocked_import(
        monkeypatch,
        "inspection_gates_no_numpy",
        lambda name: name == "numpy" or name.startswith("numpy."),
    )
    assert module.HAS_NUMPY is False
    assert module.np is None
    volume = module.mesh_enclosed_volume(_UNIT_CUBE_VERTICES, _UNIT_CUBE_TRIANGLES)
    assert volume == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# Mass-property validation.
# ---------------------------------------------------------------------------


def test_mass_properties_skips_non_dict_entries() -> None:
    assert ig.check_mass_properties([None, "solid", 3]) == []  # type: ignore[list-item]


def test_mass_properties_enumerate_failure_returns_empty() -> None:
    class ExplodingEntries(list[Any]):
        def __bool__(self) -> bool:
            raise RuntimeError("boom")

    assert ig.check_mass_properties(ExplodingEntries()) == []


def test_mass_properties_flags_non_finite_area() -> None:
    warnings = ig.check_mass_properties([{"solidId": 7, "area": float("inf")}])
    assert warnings == ["Solid 7 has a non-finite surface area (inf)"]


def test_mass_properties_flags_non_finite_center_of_mass() -> None:
    warnings = ig.check_mass_properties(
        [
            {
                "solidId": 3,
                "bbox": {"min": [0.0, 0.0, 0.0], "max": [1.0, 1.0, 1.0]},
                "centerOfMass": [0.5, float("nan"), 0.5],
            }
        ]
    )
    assert warnings == ["Solid 3 has a non-finite center of mass ([0.5, nan, 0.5])"]


def test_mass_properties_accepts_boundary_center_of_mass() -> None:
    entries = [
        {
            "solidId": 1,
            "bbox": {"min": [0.0, 0.0, 0.0], "max": [1.0, 1.0, 1.0]},
            "centerOfMass": [0.0, 1.0, 0.5],
        }
    ]
    assert ig.check_mass_properties(entries) == []


# ---------------------------------------------------------------------------
# OCP-backed mass report.
# ---------------------------------------------------------------------------


def test_solid_mass_report_returns_empty_when_ocp_import_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(sys.modules, "OCP.Bnd", None)
    assert ig.solid_mass_report(object()) == []


def test_solid_mass_report_returns_empty_for_non_shape() -> None:
    pytest.importorskip("OCP", reason="OCP not installed")
    assert ig.solid_mass_report(None) == []


def test_solid_mass_report_skips_solids_that_fail_measurement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bd = pytest.importorskip("build123d", reason="build123d not installed")
    import ocp_compat

    def boom(*_args: Any, **_kwargs: Any) -> None:
        raise RuntimeError("measurement failed")

    monkeypatch.setattr(ocp_compat, "brep_bnd_lib_add", boom)
    box = bd.Box(1, 1, 1)
    assert ig.solid_mass_report(box.wrapped) == []


def test_check_solid_mass_properties_reports_clean_shape() -> None:
    bd = pytest.importorskip("build123d", reason="build123d not installed")
    assert ig.check_solid_mass_properties(bd.Box(2, 2, 2).wrapped) == []


def test_check_solid_mass_properties_wraps_unexpected_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def boom(_shape: Any) -> list[dict[str, Any]]:
        raise RuntimeError("report failed")

    monkeypatch.setattr(ig, "solid_mass_report", boom)
    assert ig.check_solid_mass_properties(object()) == ["Mass-property gate skipped: report failed"]


# ---------------------------------------------------------------------------
# Mesh-vs-CAD gate.
# ---------------------------------------------------------------------------


def test_mesh_vs_cad_uses_custom_tolerance() -> None:
    assert ig.check_mesh_vs_cad({1: 100.0}, {1: 104.0}, rel_tol=0.05) == []
    warnings = ig.check_mesh_vs_cad({1: 100.0}, {1: 104.0}, rel_tol=0.01)
    assert len(warnings) == 1


def test_mesh_vs_cad_wraps_iteration_failure() -> None:
    class ExplodingVolumes(dict[int, float]):
        def items(self) -> Any:
            raise RuntimeError("boom")

    warnings = ig.check_mesh_vs_cad(ExplodingVolumes(), {})
    assert warnings == ["Mesh-vs-CAD deviation gate skipped: boom"]


def test_mesh_enclosed_volume_empty_and_single_triangle() -> None:
    assert ig.mesh_enclosed_volume(_UNIT_CUBE_VERTICES, None) == 0.0
    # A single triangle encloses no volume in absolute terms.
    assert ig.mesh_enclosed_volume(_UNIT_CUBE_VERTICES, [[0, 1, 2]]) == 0.0
    assert math.isclose(
        ig.mesh_enclosed_volume(_UNIT_CUBE_VERTICES, _UNIT_CUBE_TRIANGLES), 1.0, abs_tol=1e-9
    )
