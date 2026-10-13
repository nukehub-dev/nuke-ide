#!/usr/bin/env python3
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
"""Tests for FEM breadth: pressure/temperature BCs, step types, results.

Covers ``fem_service`` pressure BCs (surface name to element-face ``*DLOAD``
loads), ``temperature`` BCs (``*TEMPERATURE`` cards), ``*STATIC`` /
``*HEAT TRANSFER`` step selection, von Mises + max-principal derivation
from synthetic FRD ``STRESS`` blocks, and the safety-factor (``yield /
mises``) VTK array fed by the ``yield`` card field. Pure numpy + stdlib
throughout — no gmsh, no CalculiX binary — so this runs in the minimal
pytest profile; the no-ccx path is asserted with forced absence guards
(never an assumed environment).
"""

from __future__ import annotations

import shutil
from pathlib import Path

import fem_service as fs
import pytest
from region_manifest import CURRENT_VERSION, RegionManifest


@pytest.fixture
def breadth_mesh() -> fs.MeshData:
    """Return a tiny two-tet mesh with one block and one surface set."""
    points = [
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [1.0, 1.0, 1.0],
    ]
    elements = [
        {"tag": 1, "dim": 3, "parentTag": 1, "nodes": [0, 1, 2, 3], "block": "block_1"},
        {"tag": 2, "dim": 3, "parentTag": 1, "nodes": [1, 2, 3, 4], "block": "block_1"},
    ]
    surface_elems = [{"tag": 10, "dim": 2, "parentTag": 1, "nodes": [0, 1, 2], "block": "bottom"}]
    return fs.MeshData(
        fs.np.array(points, dtype=float),
        elements,
        {"block_1": fs.np.array([0, 1], dtype=int)},
        {"bottom": {"indices": fs.np.array([0], dtype=int), "elements": surface_elems}},
    )


def _write_inp_text(
    mesh: fs.MeshData, tmp_path: Path, bcs: list[dict[str, object]], step: dict[str, object]
) -> str:
    """Write a deck for ``bcs``/``step`` and return its text."""
    inp_path = tmp_path / "breadth.inp"
    fs.write_inp(mesh, inp_path, {}, bcs, step)
    return inp_path.read_text(encoding="utf-8")


def test_pressure_bc_emits_dload_face(breadth_mesh: fs.MeshData, tmp_path: Path) -> None:
    """Pressure must load element faces via *DLOAD, not nodal *Cload."""
    text = _write_inp_text(
        breadth_mesh,
        tmp_path,
        [{"type": "pressure", "surfaceName": "bottom", "magnitude": 1e6}],
        {"stepType": "static"},
    )
    assert "*Dload" in text
    # The bottom triangle (nodes 1,2,3) is face 1 of deck element 1.
    assert f"1, P1, {1e6:.12g}" in text
    assert "*Cload" not in text


def test_pressure_bc_vector_is_normal_traction(breadth_mesh: fs.MeshData, tmp_path: Path) -> None:
    """A pressure ``vector`` must not leak direction into the deck: traction acts normal."""
    text = _write_inp_text(
        breadth_mesh,
        tmp_path,
        [
            {
                "type": "pressure",
                "surfaceName": "bottom",
                "magnitude": 5.0,
                "vector": [1.0, 0.0, 0.0],
            }
        ],
        {"stepType": "static"},
    )
    assert "1, P1, 5" in text
    assert "*Cload" not in text


def test_pressure_bc_unknown_surface_skipped(breadth_mesh: fs.MeshData, tmp_path: Path) -> None:
    """Pressure on an unknown surface emits no load card (existing skip pattern)."""
    text = _write_inp_text(
        breadth_mesh,
        tmp_path,
        [{"type": "pressure", "surfaceName": "nosuch", "magnitude": 5.0}],
        {"stepType": "static"},
    )
    assert "*Dload" not in text


def test_temperature_bc_emits_temperature_card(breadth_mesh: fs.MeshData, tmp_path: Path) -> None:
    """Temperature BCs must prescribe nodal values via *TEMPERATURE."""
    text = _write_inp_text(
        breadth_mesh,
        tmp_path,
        [{"type": "temperature", "surfaceName": "bottom", "temperature": 300.0}],
        {"stepType": "static"},
    )
    assert "*Temperature" in text
    for node_id in (1, 2, 3):
        assert f"{node_id}, 300" in text
    assert "11, 11" not in text


def test_step_heat_transfer_selected(breadth_mesh: fs.MeshData, tmp_path: Path) -> None:
    """stepType heatTransfer must select the *Heat Transfer procedure."""
    text = _write_inp_text(breadth_mesh, tmp_path, [], {"stepType": "heatTransfer"})
    assert "*Heat Transfer" in text
    assert "*Node File\nNT" in text


def test_step_defaults_to_static(breadth_mesh: fs.MeshData, tmp_path: Path) -> None:
    """Today's step type stays default: an empty step dict means *Static."""
    text = _write_inp_text(breadth_mesh, tmp_path, [], {})
    assert "*Static" in text


def _write_stress_frd(path: Path, rows: dict[int, list[float]], ncomps: int = 6) -> None:
    """Write a synthetic FRD file with one STRESS block in fixed-width format."""
    comp_names = ["SXX", "SYY", "SZZ", "SXY", "SYZ", "SXZ"][:ncomps]
    lines = [" -4  STRESS      6    1"]
    lines += [f" -5  {name:<10}1    2    1    0" for name in comp_names]
    lines.append(" -5  ALL         1    2    0    0    1ALL")
    for node_id, values in rows.items():
        lines.append(f" -1{node_id:10d}" + "".join(f"{v:12.5E}" for v in values))
    lines.append(" -3")
    path.write_text("\n".join(lines), encoding="utf-8")


def test_parse_frd_derives_mises_uniaxial(tmp_path: Path) -> None:
    """Uniaxial tension: von Mises and max-principal both equal Sxx."""
    frd = tmp_path / "stress.frd"
    _write_stress_frd(frd, {1: [100e6, 0.0, 0.0, 0.0, 0.0, 0.0]})
    results = fs._parse_frd_results(frd)
    assert results["MISES"][1] == pytest.approx([100e6])
    assert results["MAXPRIN"][1] == pytest.approx([100e6])


def test_parse_frd_derives_mises_multiaxial(tmp_path: Path) -> None:
    """Biaxial, shear, and hydrostatic states derive exact textbook values."""
    frd = tmp_path / "stress.frd"
    _write_stress_frd(
        frd,
        {
            1: [100.0, 50.0, 0.0, 0.0, 0.0, 0.0],  # biaxial
            2: [0.0, 0.0, 0.0, 50.0, 0.0, 0.0],  # pure shear
            3: [100.0, 100.0, 100.0, 0.0, 0.0, 0.0],  # hydrostatic
        },
    )
    results = fs._parse_frd_results(frd)
    assert results["MISES"][1] == pytest.approx([(100.0**2 - 100.0 * 50.0 + 50.0**2) ** 0.5])
    assert results["MAXPRIN"][1] == pytest.approx([100.0])
    assert results["MISES"][2] == pytest.approx([(3.0 * 50.0**2) ** 0.5])
    assert results["MAXPRIN"][2] == pytest.approx([50.0])
    assert results["MISES"][3] == pytest.approx([0.0])
    assert results["MAXPRIN"][3] == pytest.approx([100.0])


def test_parse_frd_short_stress_has_no_derived(tmp_path: Path) -> None:
    """STRESS blocks without six components parse raw with no derived keys."""
    frd = tmp_path / "stress.frd"
    _write_stress_frd(frd, {1: [1.0, 2.0, 3.0]}, ncomps=3)
    results = fs._parse_frd_results(frd)
    assert results["STRESS"][1] == pytest.approx([1.0, 2.0, 3.0])
    assert "MISES" not in results
    assert "MAXPRIN" not in results


def test_parse_frd_derived_needs_numpy(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Without numpy the raw blocks still parse; only derivation is skipped."""
    monkeypatch.setattr(fs, "np", None)
    frd = tmp_path / "stress.frd"
    _write_stress_frd(frd, {1: [100.0, 0.0, 0.0, 0.0, 0.0, 0.0]})
    results = fs._parse_frd_results(frd)
    assert results["STRESS"][1][0] == pytest.approx(100.0)
    assert "MISES" not in results


def test_card_to_fem_material_carries_yield() -> None:
    """A card ``yield`` becomes ``yieldStrength`` on the resolved material."""
    props = fs._card_to_fem_material("my_alloy", {"E": 200e9, "yield": 250e6})
    assert props["yieldStrength"] == pytest.approx(250e6)


def test_card_to_fem_material_omits_absent_yield() -> None:
    """Cards without ``yield`` carry no strength key (never defaulted)."""
    props = fs._card_to_fem_material("my_alloy", {"E": 200e9})
    assert "yieldStrength" not in props


def test_manifest_accepts_yield_field() -> None:
    """The additive ``yield`` field validates in manifest cards (shared field table)."""
    manifest = RegionManifest.from_dict(
        {
            "version": CURRENT_VERSION,
            "volumes": [{"selector": "fuel", "material": "my_alloy"}],
            "materials": {"my_alloy": {"E": 200e9, "yield": 250e6}},
        }
    )
    assert manifest.material_card_for("my_alloy") == {"E": 200e9, "yield": 250e6}


def test_node_yield_map_min_wins_and_reports_missing() -> None:
    """Shared nodes take the minimum yield; blocks without one are reported."""
    points = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
    elements = [{"tag": 1, "dim": 3, "parentTag": 1, "nodes": [0, 1, 2, 3], "block": "a"}]
    mesh = fs.MeshData(
        fs.np.array(points, dtype=float),
        elements,
        {"a": fs.np.array([0], dtype=int), "b": fs.np.array([0], dtype=int)},
        {},
    )
    materials = {"a": {"name": "A", "yieldStrength": 100.0}, "b": {"name": "B"}}
    node_yield, missing = fs._node_yield_map(mesh, materials)
    # Block b reuses element 0 but carries no yield: shared nodes keep a's 100.
    assert node_yield == {1: 100.0, 2: 100.0, 3: 100.0, 4: 100.0}
    assert missing == ["B"]


def test_write_vtk_legacy_emits_derived_and_safety(
    breadth_mesh: fs.MeshData, tmp_path: Path
) -> None:
    """MISES/MAXPRIN reach VTK as color-by arrays with a yield/mises column."""
    vtk_path = tmp_path / "out.vtk"
    frd_results = {
        "MISES": {1: [100.0], 2: [200.0], 3: [0.0]},
        "MAXPRIN": {1: [100.0], 2: [200.0], 3: [50.0]},
    }
    fs._write_vtk_legacy(
        breadth_mesh, frd_results, vtk_path, node_yield={1: 250.0, 2: 500.0, 3: 100.0}
    )
    text = vtk_path.read_text(encoding="utf-8")
    assert "SCALARS von_mises float 1" in text
    assert "SCALARS max_principal float 1" in text
    assert "SCALARS safety_factor float 1" in text
    safety = _scalar_block(text, "safety_factor")
    assert safety[:3] == pytest.approx([2.5, 2.5, float("inf")])
    # Nodes 4-5 have no known yield: NaN (omitted, never defaulted).
    assert all(v != v for v in safety[3:])


def test_write_vtk_legacy_omits_safety_without_yield(
    breadth_mesh: fs.MeshData, tmp_path: Path
) -> None:
    """Without a yield map there is no safety-factor array (never defaulted)."""
    vtk_path = tmp_path / "out.vtk"
    fs._write_vtk_legacy(breadth_mesh, {"MISES": {1: [100.0]}}, vtk_path)
    text = vtk_path.read_text(encoding="utf-8")
    assert "SCALARS von_mises float 1" in text
    assert "safety_factor" not in text


def _scalar_block(text: str, name: str) -> list[float]:
    """Read back the values of a VTK SCALARS block by name."""
    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if line == f"SCALARS {name} float 1")
    values: list[float] = []
    for line in lines[start + 2 :]:
        if not line or line.startswith(("SCALARS", "VECTORS", "CELL", "POINT")):
            break
        values.append(float(line.split()[0]))
    return values


def test_run_fem_new_bcs_without_ccx_structured_error(
    monkeypatch: pytest.MonkeyPatch, breadth_mesh: fs.MeshData, tmp_path: Path
) -> None:
    """New BCs without ccx present fail as a structured error, never a traceback."""
    monkeypatch.setattr(fs, "_require_deps", lambda: None)
    monkeypatch.setattr(fs, "_read_gmsh_mesh", lambda _path: breadth_mesh)
    # Force ccx absence: no env override, nothing on PATH.
    monkeypatch.delenv("NUKE_CCX", raising=False)
    monkeypatch.setattr(shutil, "which", lambda _name: None)
    msh = tmp_path / "mesh.msh"
    msh.write_text("stub", encoding="utf-8")
    result = fs.run_fem(
        str(msh),
        output_dir=str(tmp_path),
        materials={"block_1": "structural_steel"},
        boundary_conditions=[
            {"type": "pressure", "surfaceName": "bottom", "magnitude": 1e6},
            {"type": "temperature", "surfaceName": "bottom", "temperature": 300.0},
        ],
        step={"stepType": "static"},
        run=True,
    )
    assert result["success"] is False
    assert "ccx" in result["error"].lower()
    # The failure surfaces through the existing result-dict error channel
    # (the same uniform handler as every other setup failure) — no exception
    # ever propagates to the caller.
    assert isinstance(result, dict)
    # The deck (with both new cards) was still written before the ccx lookup.
    text = Path(result["inpPath"]).read_text(encoding="utf-8")
    assert "*Dload" in text
    assert "*Temperature" in text


def test_run_fem_reports_missing_yield_and_emits_safety(
    monkeypatch: pytest.MonkeyPatch, breadth_mesh: fs.MeshData, tmp_path: Path
) -> None:
    """End-to-end wiring (fake ccx): omission warnings plus the SF array."""
    frd = tmp_path / "job.frd"
    _write_stress_frd(frd, {i: [100e6, 0.0, 0.0, 0.0, 0.0, 0.0] for i in range(1, 6)})
    monkeypatch.setattr(fs, "_require_deps", lambda: None)
    monkeypatch.setattr(fs, "_read_gmsh_mesh", lambda _path: breadth_mesh)
    monkeypatch.setattr(fs, "_find_ccx", lambda _path=None: "/nonexistent/ccx")
    monkeypatch.setattr(
        fs,
        "_run_ccx",
        lambda _inp, _ccx, **_kw: {
            "success": True,
            "frdPath": str(frd),
            "datPath": str(tmp_path / "job.dat"),
            "logPath": str(tmp_path / "job.ccx.log"),
            "stdout": "",
            "stderr": "",
            "error": None,
        },
    )
    msh = tmp_path / "mesh.msh"
    msh.write_text("stub", encoding="utf-8")

    plain = fs.run_fem(
        str(msh),
        output_dir=str(tmp_path),
        output_stem="plain",
        materials={"block_1": "structural_steel"},
        run=True,
    )
    assert plain["success"] is True, plain.get("error", "")
    assert any("Safety factor omitted" in w for w in plain["warnings"])
    assert "safety_factor" not in Path(plain["vtkPath"]).read_text(encoding="utf-8")

    yielded = fs.run_fem(
        str(msh),
        output_dir=str(tmp_path),
        output_stem="yielded",
        materials={"block_1": "my_alloy"},
        material_cards={"my_alloy": {"E": 200e9, "yield": 250e6}},
        run=True,
    )
    assert yielded["success"] is True, yielded.get("error", "")
    assert not any("Safety factor omitted" in w for w in yielded["warnings"])
    safety = _scalar_block(Path(yielded["vtkPath"]).read_text(encoding="utf-8"), "safety_factor")
    assert safety == pytest.approx([2.5] * 5)
