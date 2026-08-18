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
    """Minimal FRD result block parsing should recover DISP and TEMP."""
    frd = tmp_path / "result.frd"
    frd.write_text(
        "\n".join(
            [
                "1PSTEP",
                "2P ...",
                " -4DISP",
                " -5 D1      3    1    0",
                " -1      1 0.1 0.2 0.3",
                " -1      2 0.4 0.5 0.6",
                " -3",
                " -4TEMP",
                " -5 NDTEMP  1    1    0",
                " -1      1 300.0",
                " -1      2 310.0",
                " -3",
            ]
        ),
        encoding="utf-8",
    )
    results = fs._parse_frd_results(frd)
    assert "DISP" in results
    assert results["DISP"][1] == pytest.approx([0.1, 0.2, 0.3])
    assert "TEMP" in results
    assert results["TEMP"][2] == pytest.approx([310.0])


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
