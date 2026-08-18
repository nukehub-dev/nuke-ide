"""Tests for the nuke-cad meshing service."""

import math
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


def _find_gmsh_tag_by_com(
    step_path: str,
    dim: int,
    target_com: tuple[float, float, float],
    tol: float = 1e-6,
) -> int | None:
    """Return the tag of the gmsh entity whose center of mass is ``target_com``.

    Replicates ``mesh_service._load_step_into_gmsh`` (including the fragment
    step for multi-volume models) so the discovered tags are the ones the
    meshing service will actually see — no hardcoded entity tags.
    """
    gmsh = pytest.importorskip("gmsh", reason="gmsh not installed")
    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.open(step_path)
        gmsh.model.occ.synchronize()
        volumes = gmsh.model.getEntities(3)
        if len(volumes) > 1:
            gmsh.model.occ.fragment(volumes, volumes)
            gmsh.model.occ.synchronize()
        for entity_dim, tag in gmsh.model.getEntities(dim):
            com = gmsh.model.occ.getCenterOfMass(entity_dim, tag)
            if all(abs(c - t) < tol for c, t in zip(com, target_com, strict=True)):
                return int(tag)
        return None
    finally:
        gmsh.finalize()


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

    # Discover entity tags by geometry instead of hardcoding gmsh tags.
    left = _find_gmsh_tag_by_com(service_result["stepPath"], 3, (0.0, 0.0, 0.0))
    right = _find_gmsh_tag_by_com(service_result["stepPath"], 3, (10.0, 0.0, 0.0))
    shared = _find_gmsh_tag_by_com(service_result["stepPath"], 2, (5.0, 0.0, 0.0))
    assert left is not None and right is not None and shared is not None

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
        selector_map={"left": [left], "right": [right], "shared": [shared]},
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


def test_regular_tet_dihedral_angle() -> None:
    """A regular tetrahedron must measure ~70.53 degrees, not 109.47."""
    np = pytest.importorskip("numpy", reason="numpy not installed")

    # Regular tetrahedron inscribed in a cube.
    points = np.array(
        [
            [1.0, 1.0, 1.0],
            [1.0, -1.0, -1.0],
            [-1.0, 1.0, -1.0],
            [-1.0, -1.0, 1.0],
        ],
        dtype=float,
    )
    dmin, dmax = mesh_service._tet_dihedral_angles(points, np.array([0, 1, 2, 3]))
    expected = math.degrees(math.acos(1.0 / 3.0))  # 70.5288 deg
    assert dmin == pytest.approx(expected, abs=1e-6)
    assert dmax == pytest.approx(expected, abs=1e-6)


def test_mesh_report_dihedral_min_max_genuine() -> None:
    """minDihedralDeg/maxDihedralDeg must be the true extrema across tets."""
    np = pytest.importorskip("numpy", reason="numpy not installed")

    points = np.array(
        [
            # Regular tetrahedron (all dihedrals ~70.53 deg).
            [1.0, 1.0, 1.0],
            [1.0, -1.0, -1.0],
            [-1.0, 1.0, -1.0],
            [-1.0, -1.0, 1.0],
            # Sliver tetrahedron: apex just above the base centroid, giving
            # dihedrals near 0 deg and near 180 deg.
            [0.0, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [0.0, 2.0, 0.0],
            [0.5, 0.5, 0.01],
        ],
        dtype=float,
    )
    tets = np.array([[0, 1, 2, 3], [4, 5, 6, 7]], dtype=np.int32)
    blocks = {"block_1": np.array([0, 1], dtype=int)}
    report = mesh_service._compute_mesh_report(points, tets, blocks)

    regular = math.degrees(math.acos(1.0 / 3.0))
    quality = report["quality"]
    assert quality["minDihedralDeg"] < regular
    assert quality["maxDihedralDeg"] > 170.0
    assert quality["minDihedralDeg"] <= quality["maxDihedralDeg"]


def test_mesh_report_quadratic_tet_element_type() -> None:
    """Quadratic tets must be reported as tetra10, not tetra."""
    np = pytest.importorskip("numpy", reason="numpy not installed")

    corners = np.array(
        [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ]
    )
    midpoints = np.array(
        [
            0.5 * (corners[0] + corners[1]),
            0.5 * (corners[1] + corners[2]),
            0.5 * (corners[0] + corners[2]),
            0.5 * (corners[0] + corners[3]),
            0.5 * (corners[1] + corners[3]),
            0.5 * (corners[2] + corners[3]),
        ]
    )
    points = np.vstack([corners, midpoints])
    tets = np.array([list(range(10))], dtype=np.int32)
    blocks = {"block_1": np.array([0], dtype=int)}
    report = mesh_service._compute_mesh_report(points, tets, blocks)
    assert report["elementTypes"] == {"tetra10": 1}


def test_netgen_engine_returns_structured_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A missing netgen install yields a clean structured error, no traceback."""
    monkeypatch.setattr(mesh_service, "HAS_GMSH", True)
    monkeypatch.setattr(mesh_service, "HAS_MESHIO", True)
    monkeypatch.setattr(mesh_service, "HAS_NETCDF4", True)
    monkeypatch.setattr(mesh_service, "HAS_NETGEN", False)
    step = tmp_path / "dummy.step"
    step.write_text("ISO-10303-21;\n", encoding="utf-8")

    result = mesh_service.mesh_step(str(step), output_dir=str(tmp_path), engine="netgen")
    assert result["success"] is False
    assert result["error"] is not None
    assert "netgen" in result["error"].lower()
    assert "traceback" not in result


def _requires_netgen() -> None:
    """Skip a test if netgen (or the full CAD/meshing profile) is unavailable."""
    _requires_full_profile()
    pytest.importorskip("netgen.occ", reason="netgen not installed")


def test_netgen_mesh_single_box(tmp_path: Path) -> None:
    """engine='netgen' meshes a box and produces all output files."""
    _requires_netgen()

    script = tmp_path / "box.py"
    script.write_text("from build123d import *\nmodel = Box(10, 10, 10)\n")
    service_result = geometry_service.build_geometry(
        str(script),
        output_dir=str(tmp_path),
        export_dagmc=False,
        export_mesh=False,
    )
    assert service_result["success"] is True, service_result.get("error", "")

    mesh_result = mesh_service.mesh_step(
        service_result["stepPath"],
        output_dir=str(tmp_path),
        output_stem="netgen_box",
        engine="netgen",
        mesh_size=4.0,
        order=2,  # unsupported: must fall back to linear with a warning
    )
    assert mesh_result["success"] is True, mesh_result.get("error", "")
    assert any("order" in w for w in mesh_result["warnings"])

    report = mesh_result["report"]
    assert report is not None
    assert report["elementCount"] > 0
    assert report["nodeCount"] > 0
    assert "tetra" in report["elementTypes"]
    quality = report["quality"]
    assert 0.0 < quality["minDihedralDeg"] <= quality["maxDihedralDeg"] <= 180.0
    assert quality["minAspectRatio"] >= 1.0
    assert quality["minAspectRatio"] <= quality["meanAspectRatio"]

    for key in ("msh", "e", "inp", "vtk", "report"):
        assert Path(mesh_result["paths"][key]).exists(), f"{key} missing"

    block_names = _read_exodus_names(Path(mesh_result["paths"]["e"]), "eb_names")
    assert "block_1" in block_names


def test_netgen_manifest_blocks_and_sidesets(tmp_path: Path) -> None:
    """Manifest names become Exodus blocks/sidesets with engine='netgen'."""
    _requires_netgen()

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
        export_mesh=False,
    )
    assert service_result["success"] is True, service_result.get("error", "")

    # Discover entity tags by geometry instead of hardcoding gmsh tags.
    left = _find_gmsh_tag_by_com(service_result["stepPath"], 3, (0.0, 0.0, 0.0))
    right = _find_gmsh_tag_by_com(service_result["stepPath"], 3, (10.0, 0.0, 0.0))
    shared = _find_gmsh_tag_by_com(service_result["stepPath"], 2, (5.0, 0.0, 0.0))
    assert left is not None and right is not None and shared is not None

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
        output_stem="netgen_named",
        engine="netgen",
        manifest=manifest,
        selector_map={"left": [left], "right": [right], "shared": [shared]},
        mesh_size=4.0,
    )
    assert mesh_result["success"] is True, mesh_result.get("error", "")

    block_names = _read_exodus_names(Path(mesh_result["paths"]["e"]), "eb_names")
    assert "left_block" in block_names
    assert "right_block" in block_names
    sideset_names = _read_exodus_names(Path(mesh_result["paths"]["e"]), "ss_names")
    assert "shared_surface" in sideset_names

    report = mesh_result["report"]
    assert report is not None
    block_counts = {b["name"]: b["elementCount"] for b in report["blocks"]}
    assert "left_block" in block_counts
    assert "right_block" in block_counts
    assert block_counts["left_block"] + block_counts["right_block"] == report["elementCount"]

    # The Exodus file round-trips through meshio with one block per box.
    import meshio

    mesh = meshio.read(mesh_result["paths"]["e"])
    tet_blocks = [c for c in mesh.cells if c.type == "tetra"]
    assert len(tet_blocks) == 2
    assert sum(len(c.data) for c in tet_blocks) == report["elementCount"]


def test_netgen_per_region_mesh_size_changes_element_count(tmp_path: Path) -> None:
    """A smaller per-region meshSize increases the netgen element count."""
    _requires_netgen()

    script = tmp_path / "box.py"
    script.write_text("from build123d import *\nmodel = Box(10, 10, 10)\n")
    service_result = geometry_service.build_geometry(
        str(script),
        output_dir=str(tmp_path),
        export_dagmc=False,
        export_mesh=False,
    )
    assert service_result["success"] is True, service_result.get("error", "")
    step_path = service_result["stepPath"]

    coarse = mesh_service.mesh_step(
        step_path,
        output_dir=str(tmp_path / "coarse"),
        output_stem="coarse",
        engine="netgen",
        mesh_size=5.0,
    )
    assert coarse["success"] is True, coarse.get("error", "")

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
        engine="netgen",
        manifest=manifest,
        selector_map={"box": [1]},
        mesh_size=5.0,
    )
    assert fine["success"] is True, fine.get("error", "")

    assert fine["report"]["elementCount"] > coarse["report"]["elementCount"]


def test_exodus_sideset_side_numbers_match_geometry(tmp_path: Path) -> None:
    """Exodus side indices must follow the SEACAS TETRA(4) face convention.

    Writes a box mesh with a side set on the x = -5 face, reads the Exodus
    file back with raw netCDF4, and asserts that for every (element, side)
    entry the face selected by the SEACAS side-number-to-node-set mapping is
    exactly the geometric face lying on the x = -5 plane.
    """
    _requires_full_profile()

    script = tmp_path / "box.py"
    script.write_text("from build123d import *\nmodel = Box(10, 10, 10)\n")
    service_result = geometry_service.build_geometry(
        str(script),
        output_dir=str(tmp_path),
        export_dagmc=False,
        mesh_size=4.0,
    )
    assert service_result["success"] is True

    left = _find_gmsh_tag_by_com(service_result["stepPath"], 2, (-5.0, 0.0, 0.0))
    assert left is not None, "could not locate the x=-5 face by center of mass"

    manifest = RegionManifest.from_dict(
        {
            "version": 1,
            "surfaces": [{"selector": "left", "name": "left_face", "role": "boundary"}],
        }
    )
    mesh_result = mesh_service.mesh_step(
        service_result["stepPath"],
        output_dir=str(tmp_path),
        output_stem="sideset_geom",
        manifest=manifest,
        selector_map={"left": [left]},
        mesh_size=4.0,
        write_inp=False,
        write_vtk=False,
    )
    assert mesh_result["success"] is True, mesh_result.get("error", "")

    import netCDF4

    # SEACAS TETRA(4): side 1 = {1,2,4}, side 2 = {2,3,4}, side 3 = {1,4,3},
    # side 4 = {1,3,2} (1-based local numbering) -> 0-based corner indices.
    seacas_faces = {1: (0, 1, 3), 2: (1, 2, 3), 3: (0, 2, 3), 4: (0, 1, 2)}

    with netCDF4.Dataset(str(mesh_result["paths"]["e"])) as ds:
        # The single unnamed volume produces exactly one block whose
        # connectivity rows map 1:1 onto the combined tet array.
        assert "connect1" in ds.variables
        assert "connect2" not in ds.variables
        connect = ds.variables["connect1"][:] - 1  # to 0-based node ids
        coords = ds.variables["coord"][:]  # (num_dim, num_nodes)
        elems = ds.variables["elem_ss1"][:] - 1  # to 0-based element ids
        sides = ds.variables["side_ss1"][:]

        assert len(elems) > 0
        for elem_id, side in zip(elems, sides, strict=True):
            tet = connect[int(elem_id)]
            face_nodes = [int(tet[i]) for i in seacas_faces[int(side)]]
            xs = coords[0, face_nodes]
            assert all(abs(float(x) + 5.0) < 1e-6 for x in xs), (
                f"side {int(side)} of element {int(elem_id) + 1} does not lie on x=-5"
            )
