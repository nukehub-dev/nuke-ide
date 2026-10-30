"""Tests for the nuke-cad FEM service.

The full FEM pipeline needs gmsh, CalculiX, and a real mesh, so these tests
focus on importability, material resolution, FRD parsing, and graceful
failures in the minimal pytest profile.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import fem_service as fs
import pytest


@pytest.fixture
def dummy_mesh() -> fs.MeshData:
    """Return a tiny two-tet mesh with one block and one surface set."""
    points = [
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [1.0, 1.0, 1.0],
    ]
    elements = [
        {
            "tag": 1,
            "dim": 3,
            "parentTag": 1,
            "nodes": [0, 1, 2, 3],
            "block": "block_1",
        },
        {
            "tag": 2,
            "dim": 3,
            "parentTag": 1,
            "nodes": [1, 2, 3, 4],
            "block": "block_1",
        },
    ]
    blocks = {"block_1": fs.np.array([0, 1], dtype=int)}
    surface_elems = [
        {
            "tag": 10,
            "dim": 2,
            "parentTag": 1,
            "nodes": [0, 1, 2],
            "block": "bottom",
        }
    ]
    surface_sets = {
        "bottom": {
            "indices": fs.np.array([0], dtype=int),
            "elements": surface_elems,
        }
    }
    return fs.MeshData(
        fs.np.array(points, dtype=float),
        elements,
        blocks,
        surface_sets,
    )


def test_module_imports_without_gmsh() -> None:
    """The module must be importable even when gmsh is unavailable."""
    assert hasattr(fs, "run_fem")
    assert hasattr(fs, "_builtin_materials")


def test_builtin_materials_contains_steel() -> None:
    """Built-in material database must include structural steel."""
    mats = fs._builtin_materials()
    assert "structural_steel" in mats
    steel = mats["structural_steel"]
    assert steel["youngsModulus"] > 0
    assert steel["poissonsRatio"] > 0
    assert steel["density"] > 0


def test_resolve_materials_builtin_key() -> None:
    """Resolving a string reference should return the built-in material."""
    resolved = fs._resolve_materials({"block_1": "structural_steel"})
    assert resolved["block_1"]["name"] == "Structural Steel"


def test_resolve_materials_custom_dict() -> None:
    """Resolving a custom dict should return it unchanged."""
    custom = {"name": "Foo", "youngsModulus": 1e9, "poissonsRatio": 0.25, "density": 1000}
    resolved = fs._resolve_materials({"block_1": custom})
    assert resolved["block_1"] is custom


def test_resolve_materials_unknown_reference() -> None:
    """An unknown material string must raise ValueError."""
    with pytest.raises(ValueError):
        fs._resolve_materials({"block_1": "not_a_material"})


def test_surface_node_set(dummy_mesh: fs.MeshData) -> None:
    """Surface node set should collect corner nodes of surface triangles."""
    nodes = fs._surface_node_set(dummy_mesh, "bottom")
    assert nodes == {0, 1, 2}


def test_surface_area_and_normal(dummy_mesh: fs.MeshData) -> None:
    """Area of the unit right-triangle should be 0.5."""
    area, normal = fs._surface_area_and_normal(dummy_mesh, "bottom")
    assert pytest.approx(area, abs=1e-9) == 0.5
    # Normal should be approximately +Z for the bottom face orientation.
    assert abs(normal[2]) > 0.9


def test_write_inp_creates_file(dummy_mesh: fs.MeshData, tmp_path: Path) -> None:
    """write_inp should create a non-empty CalculiX input file."""
    inp_path = tmp_path / "test.inp"
    materials = fs._resolve_materials({"block_1": "structural_steel"})
    bcs: list[dict[str, object]] = [{"type": "fixed", "surfaceName": "bottom"}]
    step = {"stepType": "static"}
    warnings = fs.write_inp(dummy_mesh, inp_path, materials, bcs, step)
    assert inp_path.exists()
    text = inp_path.read_text(encoding="utf-8")
    assert "*Node" in text
    assert "*Element, type=C3D4, elset=block_1" in text
    assert "*Material, name=Structural Steel" in text
    assert "*Boundary" in text
    assert "*Step" in text
    assert "*End Step" in text
    # Default material fallback should not trigger for this block.
    assert not any("default structural steel" in w for w in warnings)


def test_write_inp_fallback_material(dummy_mesh: fs.MeshData, tmp_path: Path) -> None:
    """Blocks without a material should fall back to the default steel."""
    inp_path = tmp_path / "test.inp"
    bcs: list[dict[str, object]] = []
    step = {"stepType": "static"}
    warnings = fs.write_inp(dummy_mesh, inp_path, {}, bcs, step)
    text = inp_path.read_text(encoding="utf-8")
    assert "*Material, name=Structural Steel" in text
    assert any("default structural steel" in w for w in warnings)


def test_parse_frd_results(tmp_path: Path) -> None:
    """Real-format fixed-width FRD bytes must parse into exact node values.

    Layout mirrors genuine ccx output (see the CalculiX test suite, e.g.
    beamfrdwrite.frd / masterII.frd): padded ``-4`` name fields, one ``-5``
    record per component plus an ``ALL`` magnitude pseudo-record, and 12-char
    fixed-width value columns that may concatenate without blanks.
    """
    frd = tmp_path / "result.frd"
    frd.write_text(
        "\n".join(
            [
                "    1PSTEP",
                "  100CL  1011.00000000          2                     1    1",
                " -4  DISP        4    1",
                " -5  D1          1    2    1    0",
                " -5  D2          1    2    2    0",
                " -5  D3          1    2    3    0",
                " -5  ALL         1    2    0    0    1ALL",
                " -1         1 1.00000E-01 2.00000E-01 3.00000E-01",
                " -1         2-1.23456E-03-2.34567E-04 3.50000E+00",
                " -3",
                " -4  NDTEMP      1    1",
                " -5  T           1    1    0    0",
                " -1         1 3.00000E+02",
                " -1         2 3.10000E+02",
                " -3",
            ]
        ),
        encoding="utf-8",
    )
    results = fs._parse_frd_results(frd)
    assert set(results) == {"DISP", "NDTEMP"}
    assert results["DISP"][1] == pytest.approx([0.1, 0.2, 0.3])
    assert results["DISP"][2] == pytest.approx([-1.23456e-3, -2.34567e-4, 3.5])
    assert results["NDTEMP"][1] == pytest.approx([300.0])
    assert results["NDTEMP"][2] == pytest.approx([310.0])


def test_parse_frd_results_last_increment_wins(tmp_path: Path) -> None:
    """When a result name appears in several increments, keep the last one."""
    frd = tmp_path / "result.frd"
    frd.write_text(
        "\n".join(
            [
                " -4  NDTEMP      1    1",
                " -5  T           1    1    0    0",
                " -1         1 1.00000E+02",
                " -3",
                " -4  NDTEMP      1    1",
                " -5  T           1    1    0    0",
                " -1         1 2.00000E+02",
                " -3",
            ]
        ),
        encoding="utf-8",
    )
    results = fs._parse_frd_results(frd)
    assert results["NDTEMP"][1] == pytest.approx([200.0])


def test_run_fem_missing_mesh(monkeypatch: pytest.MonkeyPatch) -> None:
    """run_fem should return a clean error when the mesh file is missing."""
    monkeypatch.setattr(fs, "HAS_GMSH", True)
    result = fs.run_fem("/nonexistent/mesh.msh")
    assert result["success"] is False
    assert "Mesh file not found" in result["error"]


def test_run_fem_missing_deps(monkeypatch: pytest.MonkeyPatch) -> None:
    """run_fem should fail gracefully if gmsh/numpy are unavailable."""
    monkeypatch.setattr(fs, "HAS_GMSH", False)
    result = fs.run_fem("/nonexistent/mesh.msh")
    assert result["success"] is False
    assert "gmsh" in result["error"]


def test_cli_list_materials() -> None:
    """The --list-materials CLI should print JSON materials."""
    script = Path(__file__).parents[2] / "python" / "fem_service.py"
    proc = subprocess.run(
        [sys.executable, str(script), "--list-materials"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0
    data = json.loads(proc.stdout)
    assert "structural_steel" in data


def test_parse_frd_results_glued_name(tmp_path: Path) -> None:
    """A -4 name glued to the record key must still parse as the bare name."""
    frd = tmp_path / "result.frd"
    frd.write_text(
        "\n".join(
            [
                "-4DISP         1    1",
                "-5D1          1    1    0    0",
                "-1         1 1.00000E+00",
                "-3",
            ]
        ),
        encoding="utf-8",
    )
    results = fs._parse_frd_results(frd)
    assert list(results) == ["DISP"]
    assert results["DISP"][1] == pytest.approx([1.0])


def test_write_inp_fixed_bc_uses_ccx_dof_range(dummy_mesh: fs.MeshData, tmp_path: Path) -> None:
    """The 'fixed' BC must emit node-set dof ranges, not Abaqus ENCASTRE."""
    inp_path = tmp_path / "test.inp"
    bcs: list[dict[str, object]] = [{"type": "fixed", "surfaceName": "bottom"}]
    fs.write_inp(dummy_mesh, inp_path, {}, bcs, {"stepType": "static"})
    text = inp_path.read_text(encoding="utf-8")
    assert "ENCASTRE" not in text
    # The surface nset is written once and referenced from *Boundary.
    assert "*Nset, nset=bottom" in text
    boundary_lines = [line for line in text.splitlines() if line.strip().startswith("bottom,")]
    assert boundary_lines == ["bottom, 1, 3"]


def test_write_inp_displacement_bc_dof_range(dummy_mesh: fs.MeshData, tmp_path: Path) -> None:
    """Displacement BCs must use explicit dof ranges with magnitudes."""
    inp_path = tmp_path / "test.inp"
    bcs: list[dict[str, object]] = [
        {
            "type": "displacement",
            "surfaceName": "bottom",
            "vector": [0.0, 0.0, -1.0],
            "magnitude": 0.5,
        }
    ]
    fs.write_inp(dummy_mesh, inp_path, {}, bcs, {"stepType": "static"})
    text = inp_path.read_text(encoding="utf-8")
    # Nodes 1, 2, 3 (0-based 0, 1, 2) constrained in dof 3 with value -0.5.
    for node_id in (1, 2, 3):
        assert f"{node_id}, 3, 3, -0.5" in text


def test_write_vtk_legacy_uses_ndtemp(dummy_mesh: fs.MeshData, tmp_path: Path) -> None:
    """ccx nodal temperatures arrive as NDTEMP and must reach the VTK file."""
    vtk_path = tmp_path / "out.vtk"
    frd_results = {
        "DISP": {i: [0.1, 0.2, 0.3] for i in range(1, 6)},
        "NDTEMP": {i: [300.0 + i] for i in range(1, 6)},
    }
    fs._write_vtk_legacy(dummy_mesh, frd_results, vtk_path)
    text = vtk_path.read_text(encoding="utf-8")
    assert "VECTORS displacement float" in text
    assert "SCALARS temperature float 1" in text
    assert "305" in text  # node 5 temperature survived


def _write_fake_ccx(tmp_path: Path, body: str) -> Path:
    """Create an executable shell script standing in for the ccx binary."""
    fake = tmp_path / "ccx_fake"
    fake.write_text(f"#!/bin/sh\n{body}\n", encoding="utf-8")
    fake.chmod(0o755)
    return fake


def test_run_ccx_timeout(tmp_path: Path) -> None:
    """A hanging ccx must be killed after the configured timeout."""
    fake = _write_fake_ccx(tmp_path, "sleep 60")
    inp = tmp_path / "job.inp"
    inp.write_text("*Heading\n", encoding="utf-8")
    result = fs._run_ccx(inp, str(fake), timeout=1.0)
    assert result["success"] is False
    assert result["error"] is not None
    assert "timed out" in result["error"]


def test_run_ccx_output_tail_capped(tmp_path: Path) -> None:
    """Only a bounded tail of ccx output lands in the JSON result."""
    fake = _write_fake_ccx(tmp_path, f"{sys.executable} -c \"print('x' * 5000)\"")
    inp = tmp_path / "job.inp"
    inp.write_text("*Heading\n", encoding="utf-8")
    result = fs._run_ccx(inp, str(fake), timeout=30.0, max_output_bytes=100)
    assert result["success"] is True, result.get("error", "")
    assert len(result["stdout"]) <= 100
    # The full output is preserved in the log file.
    log_text = Path(result["logPath"]).read_text(encoding="utf-8")
    assert len(log_text) >= 5000


def test_run_fem_generates_deck_from_real_mesh(tmp_path: Path) -> None:
    """Full profile: mesh a box and produce a CalculiX deck from the .msh."""
    pytest.importorskip("build123d", reason="build123d not installed")
    pytest.importorskip("gmsh", reason="gmsh not installed")
    pytest.importorskip("meshio", reason="meshio not installed")
    pytest.importorskip("netCDF4", reason="netCDF4 not installed")

    import geometry_service
    import mesh_service

    script = tmp_path / "box.py"
    script.write_text("from build123d import *\nmodel = Box(10, 10, 10)\n")
    service_result = geometry_service.build_geometry(
        str(script),
        output_dir=str(tmp_path),
        export_dagmc=False,
        mesh_size=4.0,
    )
    assert service_result["success"] is True

    mesh_result = mesh_service.mesh_step(
        service_result["stepPath"],
        output_dir=str(tmp_path),
        output_stem="fem",
        mesh_size=4.0,
        write_exodus=False,
        write_inp=False,
        write_vtk=False,
    )
    assert mesh_result["success"] is True, mesh_result.get("error", "")

    result = fs.run_fem(
        mesh_result["paths"]["msh"],
        output_dir=str(tmp_path),
        run=False,
    )
    assert result["success"] is True, result.get("error", "")
    text = Path(result["inpPath"]).read_text(encoding="utf-8")
    # Exactly one fallback element block for the unnamed volume.
    assert text.count("*Element, type=C3D4") == 1
    assert "*Element, type=C3D4, elset=block_1" in text
    assert "*Elset, elset=AllElements, generate" in text
    assert "*Solid Section, elset=block_1" in text
