"""Tests for the nuke-cad meshing service."""

import sys
from pathlib import Path
from typing import Any

import geometry_service
import mesh_service
import pytest
from region_manifest import RegionManifest


def _requires_full_profile() -> None:
    """Skip a test if the full CAD/meshing dependency profile is unavailable."""
    pytest.importorskip("build123d", reason="build123d not installed")
    pytest.importorskip("gmsh", reason="gmsh not installed")
    pytest.importorskip("meshio", reason="meshio not installed")
    pytest.importorskip("netCDF4", reason="netCDF4 not installed")


def _read_exodus_names(h5m_path: Path, variable: str) -> list[str]:
    """Return string names stored in an ExodusII fixed-width char variable."""
    netCDF4 = pytest.importorskip("netCDF4", reason="netCDF4 not installed")
    names: list[str] = []
    with netCDF4.Dataset(str(h5m_path)) as ds:
        if variable not in ds.variables:
            return names
        var = ds.variables[variable]
        var.set_auto_mask(False)
        for row in var[:]:
            text = row.tobytes().decode("utf-8", errors="ignore").replace("\x00", "").strip()
            names.append(text)
    return names


def test_module_imports_without_heavy_deps(monkeypatch: Any) -> None:
    """mesh_service must be importable in the minimal pytest profile."""
    # Force the heavy dependencies to appear absent for this import.
    for name in ("gmsh", "meshio", "netCDF4", "netgen"):
        monkeypatch.setitem(sys.modules, name, None)

    import importlib

    import mesh_service as fresh_mesh_service

    importlib.reload(fresh_mesh_service)
    try:
        assert fresh_mesh_service.HAS_NUMPY is True
        assert fresh_mesh_service.HAS_GMSH is False
        assert fresh_mesh_service.HAS_MESHIO is False
        assert fresh_mesh_service.HAS_NETCDF4 is False
    finally:
        # Restore the real module state so subsequent full-profile tests work.
        monkeypatch.undo()
        importlib.reload(fresh_mesh_service)


def test_mesh_single_box(tmp_path: Path) -> None:
    """A single box produces a tetrahedral mesh and all output files."""
    _requires_full_profile()

    script = tmp_path / "box.py"
    script.write_text("from build123d import *\nmodel = Box(10, 10, 10)\n")
    service_result = geometry_service.build_geometry(
        str(script),
        output_dir=str(tmp_path),
        export_dagmc=False,
        mesh_size=3.0,
    )
    assert service_result["success"] is True, service_result.get("error", "")
    assert service_result["meshSuccess"] is True, service_result.get("meshError", "")

    report = service_result["meshReport"]
    assert report is not None
    assert report["elementCount"] > 0
    assert report["nodeCount"] > 0
    assert "tetra" in report["elementTypes"]
    assert report["quality"]["minDihedralDeg"] > 0
    assert report["quality"]["maxDihedralDeg"] > 0

    for key in ("meshPath", "exodusPath", "inpPath", "vtkPath", "meshReportPath"):
        assert Path(service_result[key]).exists(), f"{key} missing: {service_result[key]}"

    block_names = _read_exodus_names(Path(service_result["exodusPath"]), "eb_names")
    assert "block_1" in block_names


def test_manifest_names_become_exodus_blocks(tmp_path: Path) -> None:
    """Manifest volume names survive as ExodusII element block names."""
    _requires_full_profile()

    script = tmp_path / "boxes.py"
    script.write_text(
        "from build123d import *\n"
        "box1 = Box(10, 10, 10)\n"
        "box2 = Pos(10, 0, 0) * Box(10, 10, 10)\n"
        "model = Compound([box1, box2])\n"
    )
    service_result = geometry_service.build_geometry(
        str(script),
        output_dir=str(tmp_path),
        export_dagmc=False,
        mesh_size=3.0,
    )
    assert service_result["success"] is True, service_result.get("error", "")

    # Drive mesh_service directly with a manual selector map because build123d
    # label extraction is not available in the current cadquery-ocp pin.
    manifest = RegionManifest.from_dict(
        {
            "version": 1,
            "volumes": [
                {"selector": "left", "name": "left_block", "material": "mat1"},
                {"selector": "right", "name": "right_block", "material": "mat2"},
            ],
        }
    )
    mesh_result = mesh_service.mesh_step(
        service_result["stepPath"],
        output_dir=str(tmp_path),
        output_stem="named",
        manifest=manifest,
        selector_map={"left": [1], "right": [2]},
        mesh_size=3.0,
    )
    assert mesh_result["success"] is True, mesh_result.get("error", "")

    block_names = _read_exodus_names(Path(mesh_result["paths"]["e"]), "eb_names")
    assert "left_block" in block_names
    assert "right_block" in block_names

    report = mesh_result["report"]
    assert report is not None
    block_counts = {b["name"]: b["elementCount"] for b in report["blocks"]}
    assert "left_block" in block_counts
    assert "right_block" in block_counts
    assert block_counts["left_block"] + block_counts["right_block"] == report["elementCount"]


def test_exodus_geometry_round_trip(tmp_path: Path) -> None:
    """meshio can read back the geometry of a custom ExodusII file."""
    _requires_full_profile()

    script = tmp_path / "boxes.py"
    script.write_text(
        "from build123d import *\n"
        "box1 = Box(10, 10, 10)\n"
        "box2 = Pos(10, 0, 0) * Box(10, 10, 10)\n"
        "model = Compound([box1, box2])\n"
    )
    service_result = geometry_service.build_geometry(
        str(script),
        output_dir=str(tmp_path),
        export_dagmc=False,
        mesh_size=3.0,
    )
    assert service_result["meshSuccess"] is True, service_result.get("meshError", "")

    import meshio

    mesh = meshio.read(str(service_result["exodusPath"]))
    tet_blocks = [c for c in mesh.cells if c.type == "tetra"]
    assert len(tet_blocks) == 2
    assert sum(len(c.data) for c in tet_blocks) == service_result["meshReport"]["elementCount"]


def test_inp_block_names_round_trip(tmp_path: Path) -> None:
    """CalculiX/Abaqus block names round-trip through meshio."""
    _requires_full_profile()

    script = tmp_path / "boxes.py"
    script.write_text(
        "from build123d import *\n"
        "box1 = Box(10, 10, 10)\n"
        "box2 = Pos(10, 0, 0) * Box(10, 10, 10)\n"
        "model = Compound([box1, box2])\n"
    )
    service_result = geometry_service.build_geometry(
        str(script),
        output_dir=str(tmp_path),
        export_dagmc=False,
        mesh_size=3.0,
    )
    assert service_result["success"] is True

    manifest = RegionManifest.from_dict(
        {
            "version": 1,
            "volumes": [
                {"selector": "left", "name": "left_block", "material": "mat1"},
                {"selector": "right", "name": "right_block", "material": "mat2"},
            ],
        }
    )
    mesh_result = mesh_service.mesh_step(
        service_result["stepPath"],
        output_dir=str(tmp_path),
        output_stem="named",
        manifest=manifest,
        selector_map={"left": [1], "right": [2]},
        mesh_size=3.0,
    )
    assert mesh_result["success"] is True, mesh_result.get("error", "")

    import meshio

    mesh = meshio.read(mesh_result["paths"]["inp"])
    assert "left_block" in mesh.cell_sets
    assert "right_block" in mesh.cell_sets


def test_manifest_surface_becomes_sideset(tmp_path: Path) -> None:
    """Manifest surface selectors map to ExodusII side sets."""
    _requires_full_profile()

    script = tmp_path / "boxes.py"
    script.write_text(
        "from build123d import *\n"
        "box1 = Box(10, 10, 10)\n"
        "box2 = Pos(10, 0, 0) * Box(10, 10, 10)\n"
        "model = Compound([box1, box2])\n"
    )
    service_result = geometry_service.build_geometry(
        str(script),
        output_dir=str(tmp_path),
        export_dagmc=False,
        mesh_size=3.0,
    )
    assert service_result["success"] is True

    manifest = RegionManifest.from_dict(
        {
            "version": 1,
            "volumes": [
                {"selector": "left", "name": "left_block", "material": "mat1"},
                {"selector": "right", "name": "right_block", "material": "mat2"},
            ],
            "surfaces": [
                {"selector": "shared", "name": "shared_surface", "role": "interface"},
            ],
        }
    )
    mesh_result = mesh_service.mesh_step(
        service_result["stepPath"],
        output_dir=str(tmp_path),
        output_stem="sidesets",
        manifest=manifest,
        selector_map={"left": [1], "right": [2], "shared": [7]},
        mesh_size=3.0,
    )
    assert mesh_result["success"] is True, mesh_result.get("error", "")

    sideset_names = _read_exodus_names(Path(mesh_result["paths"]["e"]), "ss_names")
    assert "shared_surface" in sideset_names


def test_per_region_mesh_size_changes_element_count(tmp_path: Path) -> None:
    """A smaller per-region meshSize increases element count."""
    _requires_full_profile()

    script = tmp_path / "box.py"
    script.write_text("from build123d import *\nmodel = Box(10, 10, 10)\n")
    service_result = geometry_service.build_geometry(
        str(script),
        output_dir=str(tmp_path),
        export_dagmc=False,
        mesh_size=5.0,
    )
    assert service_result["success"] is True
    step_path = service_result["stepPath"]

    coarse = mesh_service.mesh_step(
        step_path,
        output_dir=str(tmp_path / "coarse"),
        output_stem="coarse",
        mesh_size=5.0,
    )
    assert coarse["success"] is True

    manifest = RegionManifest.from_dict(
        {
            "version": 1,
            "volumes": [{"selector": "box", "name": "box", "material": "M", "meshSize": 1.0}],
        }
    )
    fine = mesh_service.mesh_step(
        step_path,
        output_dir=str(tmp_path / "fine"),
        output_stem="fine",
        manifest=manifest,
        selector_map={"box": [1]},
        mesh_size=5.0,
        min_size=0.1,
    )
    assert fine["success"] is True

    assert fine["report"]["elementCount"] > coarse["report"]["elementCount"]


def test_no_mesh_export_skips_files(tmp_path: Path) -> None:
    """With export_mesh=False no mesh artifacts are produced."""
    _requires_full_profile()

    script = tmp_path / "box.py"
    script.write_text("from build123d import *\nmodel = Box(10, 10, 10)\n")
    service_result = geometry_service.build_geometry(
        str(script),
        output_dir=str(tmp_path),
        export_dagmc=False,
        export_mesh=False,
    )
    assert service_result["success"] is True
    assert Path(service_result["meshPath"]).exists() is False
    assert Path(service_result["exodusPath"]).exists() is False
