"""Tests for mesh repair for DAGMC prep (mesh_repair + --repair wiring).

Numeric tests use synthetic meshes and need numpy only, so they run in the
minimal pytest profile. Dependency-absence guards are forced via monkeypatch
(they must pass in the full profile too). Full-pipeline tests reuse the
geometry/mesh service fixtures and skip cleanly without the CAD toolchain.
"""

import importlib
import sys
from pathlib import Path
from typing import Any

import mesh_repair
import mesh_service
import pytest
from mesh_repair import RepairError
from region_manifest import RegionManifest


def _requires_numpy() -> Any:
    """Return numpy, skipping when it is unavailable."""
    return pytest.importorskip("numpy", reason="numpy not installed")


def _tet_surface() -> Any:
    """Four triangles of a tetrahedron (closed, no boundary)."""
    np = _requires_numpy()
    return np.array([[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]], dtype=np.int64)


def _tet_points() -> Any:
    """Tetrahedron corners inscribed in a cube."""
    np = _requires_numpy()
    return np.array(
        [
            [1.0, 1.0, 1.0],
            [1.0, -1.0, -1.0],
            [-1.0, 1.0, -1.0],
            [-1.0, -1.0, 1.0],
        ],
        dtype=float,
    )


def _open_tet() -> Any:
    """Tetrahedron surface missing one face (one triangular hole)."""
    np = _requires_numpy()
    return np.array([[0, 1, 2], [0, 1, 3], [0, 2, 3]], dtype=np.int64)


def test_normalize_repair_ops() -> None:
    """Op specs parse, strip, dedupe; unknown names fail naming the op."""
    assert mesh_repair.normalize_repair_ops(None) == []
    assert mesh_repair.normalize_repair_ops("") == []
    assert mesh_repair.normalize_repair_ops("smooth_laplacian") == ["smooth_laplacian"]
    assert mesh_repair.normalize_repair_ops(" fill_holes , smooth_laplacian ") == [
        "fill_holes",
        "smooth_laplacian",
    ]
    assert mesh_repair.normalize_repair_ops(["decimate", "decimate"]) == ["decimate"]
    assert mesh_repair.normalize_repair_ops(list(mesh_repair.SUPPORTED_OPS)) == list(
        mesh_repair.SUPPORTED_OPS
    )

    with pytest.raises(RepairError, match="bogus_op"):
        mesh_repair.normalize_repair_ops("smooth_laplacian,bogus_op")
    with pytest.raises(RepairError, match="bogus_op"):
        mesh_repair.normalize_repair_ops(["bogus_op"])


def test_remove_duplicate_facets() -> None:
    """Exact duplicates and degenerate facets are removed and counted."""
    np = _requires_numpy()
    tris = np.vstack([_tet_surface(), [[0, 2, 1], [0, 0, 1]]])

    unique, membership, stats = mesh_repair.remove_duplicate_facets(tris)
    assert membership is None
    assert stats["facets_in"] == 6
    assert stats["facets_removed"] == 1
    assert stats["degenerate_removed"] == 1
    assert stats["facets_out"] == 4
    assert len(unique) == 4

    # Idempotent: a second run removes nothing.
    _, _, rerun = mesh_repair.remove_duplicate_facets(unique)
    assert rerun["facets_removed"] == 0
    assert rerun["degenerate_removed"] == 0


def test_remove_duplicate_facets_unions_membership() -> None:
    """Duplicate folding unions surface names instead of dropping coverage."""
    np = _requires_numpy()
    tris = np.array([[0, 1, 2], [2, 1, 0]], dtype=np.int64)
    membership = [{"left"}, {"right"}]

    unique, new_membership, stats = mesh_repair.remove_duplicate_facets(tris, membership)
    assert stats["facets_removed"] == 1
    assert len(unique) == 1
    assert new_membership == [{"left", "right"}]


def test_find_boundary_loops() -> None:
    """Closed surfaces have no loops; an open tet has one triangular rim."""
    assert mesh_repair.find_boundary_loops(_tet_surface()) == []
    loops = mesh_repair.find_boundary_loops(_open_tet())
    assert len(loops) == 1
    nodes, closed = loops[0]
    assert closed is True
    assert sorted(nodes) == [1, 2, 3]


def test_fill_holes_open_tet() -> None:
    """A missing tet face is fan-filled with one centroid + three facets."""
    points = _tet_points()

    new_points, new_tris, stats = mesh_repair.fill_holes(points, _open_tet())
    assert stats["holes_found"] == 1
    assert stats["holes_filled"] == 1
    assert stats["holes_skipped"] == 0
    assert stats["facets_added"] == 3
    assert stats["nodes_added"] == 1
    assert len(new_points) == 5
    assert len(new_tris) == 6
    # The repaired surface is closed again.
    assert mesh_repair.find_boundary_loops(new_tris) == []


def test_fill_holes_respects_loop_cap() -> None:
    """Oversized loops are left unfilled and reported, never silently capped."""
    points = _tet_points()
    stats = mesh_repair.fill_holes(points, _open_tet(), max_loop_size=2)[2]
    assert stats["holes_found"] == 1
    assert stats["holes_filled"] == 0
    assert stats["holes_skipped"] == 1
    assert stats["skipped_loop_sizes"] == [3]
    assert stats["facets_added"] == 0

    new_tris = mesh_repair.fill_holes(points, _open_tet(), max_loop_size=2)[1]
    assert len(new_tris) == 3


def test_fill_holes_skips_single_face_perimeters() -> None:
    """A lone triangle's border is its own perimeter, not a hole — never filled."""
    np = _requires_numpy()
    points = np.zeros((5, 3), dtype=float)
    # Two triangles sharing only node 2: each triangle's perimeter is a closed
    # boundary loop, but every rim edge shares one owner, so neither is a hole.
    tris = np.array([[0, 1, 2], [2, 3, 4]], dtype=np.int64)

    new_points, new_tris, stats = mesh_repair.fill_holes(points, tris)
    assert stats["holes_found"] == 2
    assert stats["holes_filled"] == 0
    assert stats["degenerate_loops"] == 2
    assert stats["facets_added"] == 0
    assert len(new_tris) == 2
    assert len(new_points) == 5


def test_fill_holes_reports_open_chains() -> None:
    """Non-manifold fins leave open chains: reported, never fan-filled."""
    np = _requires_numpy()
    # Three triangles sharing edge (0, 1): one quad rim closes (fillable),
    # the third fin leaves an open chain behind.
    points = np.array(
        [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.5, 1.0, 0.0],
            [0.5, -1.0, 0.0],
            [0.5, 0.0, 1.0],
        ],
        dtype=float,
    )
    tris = np.array([[0, 1, 2], [0, 1, 3], [0, 1, 4]], dtype=np.int64)

    new_points, new_tris, stats = mesh_repair.fill_holes(points, tris)
    assert stats["holes_found"] == 1
    assert stats["holes_filled"] == 1
    assert stats["open_chains"] == 1
    assert stats["facets_added"] == 4
    assert stats["nodes_added"] == 1
    assert len(new_tris) == 7
    assert len(new_points) == 6


def test_smooth_laplacian_moves_interior_pins_boundary() -> None:
    """Interior nodes relax; rim nodes never move; deviation is reported."""
    np = _requires_numpy()
    # A tented square: center node raised, four rim nodes pinned by boundary.
    points = np.array(
        [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.5, 0.5, 1.0],
        ],
        dtype=float,
    )
    tris = np.array([[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]], dtype=np.int64)

    new_points, stats = mesh_repair.smooth_laplacian(points, tris, iterations=10, rate=0.5)
    assert stats["iterations_applied"] == 10
    assert stats["iterations_clamped"] == 0
    assert stats["nodes_smoothed"] == 1
    assert stats["nodes_pinned"] == 4
    # Rim nodes are bit-identical; the center relaxed toward the plane.
    assert np.array_equal(new_points[:4], points[:4])
    assert new_points[4, 2] < 1.0
    assert stats["max_deviation"] == pytest.approx(1.0 - new_points[4, 2])
    assert stats["max_deviation"] > 0.0


def test_smooth_laplacian_clamps_iterations() -> None:
    """Absurd iteration requests clamp to the fixed cap and say so."""
    points = _tet_points()
    _, stats = mesh_repair.smooth_laplacian(
        points, _tet_surface(), iterations=mesh_repair.MAX_SMOOTH_ITERATIONS + 50
    )
    assert stats["iterations_requested"] == mesh_repair.MAX_SMOOTH_ITERATIONS + 50
    assert stats["iterations_applied"] == mesh_repair.MAX_SMOOTH_ITERATIONS
    assert stats["iterations_clamped"] == 50


def test_smooth_laplacian_rejects_bad_params() -> None:
    """Bad iteration/rate values fail naming the op."""
    points = _tet_points()
    tris = _tet_surface()
    with pytest.raises(RepairError, match="smooth_laplacian"):
        mesh_repair.smooth_laplacian(points, tris, iterations=-1)
    with pytest.raises(RepairError, match="smooth_laplacian"):
        mesh_repair.smooth_laplacian(points, tris, rate=0.0)
    with pytest.raises(RepairError, match="smooth_laplacian"):
        mesh_repair.smooth_laplacian(points, tris, rate=1.5)


def _grid_surface(n: int = 6) -> tuple[Any, Any]:
    """A flat n*n-vertex grid (deterministic, triangulated)."""
    np = _requires_numpy()
    xs = np.linspace(0.0, 1.0, n)
    points = np.array([[x, y, 0.0] for y in xs for x in xs], dtype=float)
    tris = []
    for j in range(n - 1):
        for i in range(n - 1):
            a = j * n + i
            tris.append([a, a + 1, a + n])
            tris.append([a + 1, a + n + 1, a + n])
    return points, np.array(tris, dtype=np.int64)


def test_decimate_reaches_target() -> None:
    """Edge-collapse decimation meets the target reduction and reports it."""
    points, tris = _grid_surface()
    assert len(tris) == 50

    out, _, stats = mesh_repair.decimate_surface(points, tris, target_reduction=0.5)
    assert stats["facets_in"] == 50
    assert stats["target_triangle_count"] == 25
    assert stats["target_met"] is True
    assert len(out) == stats["facets_out"]
    assert len(out) <= 25
    assert stats["facets_removed"] == 50 - len(out)
    assert stats["achieved_reduction"] == pytest.approx((50 - len(out)) / 50)
    assert stats["collapsed_edges"] > 0
    assert stats["passes"] >= 1


def test_decimate_reports_unmet_target(monkeypatch: Any) -> None:
    """An exhausted pass budget misses the target loudly instead of silently."""
    monkeypatch.setattr(mesh_repair, "_DECIMATE_MAX_PASSES", 0)
    points, tris = _grid_surface()
    out, _, stats = mesh_repair.decimate_surface(points, tris, target_reduction=0.5)
    assert stats["target_triangle_count"] == 25
    assert stats["target_met"] is False
    assert stats["achieved_reduction"] == 0.0
    assert stats["passes"] == 0
    assert len(out) == 50


def test_decimate_unions_membership() -> None:
    """Collapsed duplicates keep the union of their surface names."""
    np = _requires_numpy()
    points = np.zeros((4, 3), dtype=float)
    points[1, 0] = 1.0
    points[2, 1] = 1.0
    points[3, 0] = 0.5
    tris = np.array([[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]], dtype=np.int64)
    membership = [{"a"}, {"b"}, {"c"}, {"d"}]

    out, new_membership, stats = mesh_repair.decimate_surface(
        points, tris, target_reduction=0.9, membership=membership
    )
    assert new_membership is not None
    assert len(new_membership) == len(out)
    assert stats["facets_removed"] >= 0


def test_decimate_rejects_bad_reduction() -> None:
    """Non-fractional reductions fail naming the op."""
    points, tris = _grid_surface(3)
    for bad in (0.0, 1.0, -0.5, 2.0):
        with pytest.raises(RepairError, match="decimate"):
            mesh_repair.decimate_surface(points, tris, target_reduction=bad)


def _fake_mesh_data(
    np: Any, with_tets: bool = False, quadratic: bool = False
) -> tuple[Any, Any, Any, Any, Any]:
    """Minimal meshio-shaped components (no meshio import needed)."""
    points = np.array(
        [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.5, 0.5, 1.0],
        ],
        dtype=float,
    )
    tri_type = "triangle6" if quadratic else "triangle"
    tri_data = (
        np.array(
            [[0, 1, 4, 0, 0, 0], [1, 2, 4, 0, 0, 0], [2, 3, 4, 0, 0, 0], [3, 0, 4, 0, 0, 0]],
            dtype=np.int64,
        )
        if quadratic
        else np.array([[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]], dtype=np.int64)
    )
    cells: list[tuple[str, Any]] = [(tri_type, tri_data)]
    if with_tets:
        cells.insert(0, ("tetra", np.array([[0, 1, 2, 4], [1, 2, 3, 4]], dtype=np.int64)))
    n_blocks = len(cells)
    tri_pos = next(i for i, (t, _) in enumerate(cells) if t.startswith("triangle"))
    cell_sets = {
        "patch": [
            np.empty((0,), dtype=np.int64) if i != tri_pos else np.array([0, 1], dtype=np.int64)
            for i in range(n_blocks)
        ]
    }
    cell_data = {
        "gmsh:physical": [
            (np.zeros(len(d), dtype=np.int64) if i != tri_pos else np.array([7, 7, 8, 8]))
            for i, (_, d) in enumerate(cells)
        ],
        "gmsh:geometrical": [np.zeros(len(d), dtype=np.int64) for _, d in cells],
    }
    field_data = {"patch": np.array([7, 2])}
    return points, cells, cell_sets, cell_data, field_data


def test_repair_mesh_data_smooth_round_trip() -> None:
    """The mesh-level adapter preserves blocks, sets, and tags on smooth-only runs."""
    np = _requires_numpy()
    points, cells, cell_sets, cell_data, field_data = _fake_mesh_data(np)

    new_points, new_cells, new_sets, new_data, stats = mesh_repair.repair_mesh_data(
        points, cells, cell_sets, cell_data, field_data, ["smooth_laplacian"]
    )
    assert stats["ops"] == ["smooth_laplacian"]
    assert set(stats["per_op"]) == {"smooth_laplacian"}
    assert stats["per_op"]["smooth_laplacian"]["nodes_smoothed"] == 1
    assert stats["nodes_removed"] == 0
    assert stats["cell_data_reset"] == []
    assert stats["warnings"] == []
    # Topology identical: same blocks, same sets, same tags.
    assert [t for t, _ in new_cells] == ["triangle"]
    assert np.array_equal(new_cells[0][1], cells[0][1])
    assert np.array_equal(new_sets["patch"][0], np.array([0, 1]))
    assert np.array_equal(new_data["gmsh:physical"][0], np.array([7, 7, 8, 8]))


def test_repair_mesh_data_dedupe_rebuilds_sets() -> None:
    """Dedupe unions named coverage and rebuilds physical tags from field data."""
    np = _requires_numpy()
    points = np.zeros((3, 3), dtype=float)
    cells = [("triangle", np.array([[0, 1, 2], [2, 1, 0]], dtype=np.int64))]
    cell_sets = {"left": [np.array([0])], "right": [np.array([1])]}
    cell_data = {"gmsh:physical": [np.array([3, 5])]}
    field_data = {"left": np.array([3, 2]), "right": np.array([5, 2])}

    _, new_cells, new_sets, new_data, stats = mesh_repair.repair_mesh_data(
        points, cells, cell_sets, cell_data, field_data, ["remove_duplicate_facets"]
    )
    assert stats["per_op"]["remove_duplicate_facets"]["facets_removed"] == 1
    assert len(new_cells[0][1]) == 1
    # The survivor belongs to both surfaces; its tag is the lower one.
    assert new_sets["left"][0].tolist() == [0]
    assert new_sets["right"][0].tolist() == [0]
    assert new_data["gmsh:physical"][0].tolist() == [3]


def test_repair_mesh_data_unknown_op_fails_loudly() -> None:
    """Unknown ops fail naming the op, never silently skip."""
    np = _requires_numpy()
    points, cells, cell_sets, cell_data, field_data = _fake_mesh_data(np)
    with pytest.raises(RepairError, match="bogus_op"):
        mesh_repair.repair_mesh_data(points, cells, cell_sets, cell_data, field_data, ["bogus_op"])


def test_repair_mesh_data_decimate_refuses_volumes() -> None:
    """Decimate on a volume mesh fails loudly instead of dropping volumes."""
    np = _requires_numpy()
    points, cells, cell_sets, cell_data, field_data = _fake_mesh_data(np, with_tets=True)
    with pytest.raises(RepairError, match="decimate"):
        mesh_repair.repair_mesh_data(points, cells, cell_sets, cell_data, field_data, ["decimate"])


def test_repair_mesh_data_refuses_quadratic_triangles() -> None:
    """Quadratic boundaries fail loudly naming the op."""
    np = _requires_numpy()
    points, cells, cell_sets, cell_data, field_data = _fake_mesh_data(np, quadratic=True)
    with pytest.raises(RepairError, match="smooth_laplacian"):
        mesh_repair.repair_mesh_data(
            points, cells, cell_sets, cell_data, field_data, ["smooth_laplacian"]
        )


def test_repair_mesh_data_decimate_surface_only() -> None:
    """Decimate runs on surface-only meshes and compacts orphaned nodes."""
    _requires_numpy()
    points, tris = _grid_surface()
    cells = [("triangle", tris)]
    cell_sets: dict[str, list[Any]] = {}
    cell_data: dict[str, list[Any]] = {}

    new_points, new_cells, _, _, stats = mesh_repair.repair_mesh_data(
        points, cells, cell_sets, cell_data, {}, ["decimate"]
    )
    assert stats["per_op"]["decimate"]["target_met"] is True
    assert len(new_cells[0][1]) <= 25
    assert len(new_points) <= len(points)
    assert stats["nodes_removed"] >= 0
    # Every surviving index resolves.
    assert int(new_cells[0][1].max()) < len(new_points)


def test_module_imports_without_heavy_deps(monkeypatch: Any) -> None:
    """mesh_repair stays importable with meshio/gmsh absent; core still works."""
    for name in ("meshio", "gmsh"):
        monkeypatch.setitem(sys.modules, name, None)

    importlib.reload(mesh_repair)
    try:
        assert mesh_repair.HAS_NUMPY is True
        assert mesh_repair.HAS_MESHIO is False
        assert mesh_repair.HAS_GMSH is False
        # NOTE: RepairError is rebound by reload — reference it via the module.
        with pytest.raises(mesh_repair.RepairError, match="meshio"):
            mesh_repair.require_meshio("fill_holes")
        with pytest.raises(mesh_repair.RepairError, match="gmsh"):
            mesh_repair.require_gmsh("decimate")
        # Numpy-only core is unaffected by the missing I/O deps.
        unique, _, stats = mesh_repair.remove_duplicate_facets(_tet_surface())
        assert stats["facets_removed"] == 0
        assert len(unique) == 4
    finally:
        monkeypatch.undo()
        importlib.reload(mesh_repair)


def test_mesh_step_rejects_unknown_repair_without_heavy_deps() -> None:
    """Unknown repair ops fail fast naming the op (no CAD deps needed)."""
    result = mesh_service.mesh_step(
        "/nonexistent/model.step", output_dir="/tmp", repairs=["bogus_op"]
    )
    assert result["success"] is False
    assert "bogus_op" in result["error"]
    assert "traceback" not in result


def test_mesh_step_missing_step_with_valid_repair() -> None:
    """Valid repair ops still report a missing STEP file (ordering check)."""
    result = mesh_service.mesh_step(
        "/nonexistent/model.step",
        output_dir="/tmp",
        repairs=["remove_duplicate_facets"],
    )
    assert result["success"] is False
    assert "not found" in result["error"]


def _requires_full_profile() -> None:
    """Skip a test if the full CAD/meshing dependency profile is unavailable."""
    pytest.importorskip("build123d", reason="build123d not installed")
    pytest.importorskip("gmsh", reason="gmsh not installed")
    pytest.importorskip("meshio", reason="meshio not installed")
    pytest.importorskip("netCDF4", reason="netCDF4 not installed")


def _box_step(tmp_path: Path) -> str:
    """Build a single box via geometry_service and return its STEP path."""
    import geometry_service

    script = tmp_path / "box.py"
    script.write_text("from build123d import *\nmodel = Box(10, 10, 10)\n")
    service_result = geometry_service.build_geometry(
        str(script),
        output_dir=str(tmp_path),
        export_dagmc=False,
        export_mesh=False,
    )
    assert service_result["success"] is True, service_result.get("error", "")
    return service_result["stepPath"]


def test_repair_counts_land_in_report(tmp_path: Path) -> None:
    """--repair ops run before the report; per-op counts certify the mesh."""
    _requires_full_profile()
    step_path = _box_step(tmp_path)

    # A manifest surface forces boundary triangles into the .msh artifact so
    # the repairs have real facets to act on (tag discovered by geometry,
    # never hardcoded).
    gmsh = pytest.importorskip("gmsh", reason="gmsh not installed")
    gmsh.initialize()
    left: int | None = None
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.open(step_path)
        gmsh.model.occ.synchronize()
        for dim, tag in gmsh.model.getEntities(2):
            com = gmsh.model.occ.getCenterOfMass(dim, tag)
            if abs(com[0] + 5.0) < 1e-6:
                left = int(tag)
    finally:
        gmsh.finalize()
    assert left is not None
    manifest = RegionManifest.from_dict(
        {
            "version": 1,
            "surfaces": [{"selector": "left", "name": "left_face", "role": "boundary"}],
        }
    )

    result = mesh_service.mesh_step(
        step_path,
        output_dir=str(tmp_path),
        output_stem="repaired",
        mesh_size=3.0,
        manifest=manifest,
        selector_map={"left": [left]},
        repairs=["remove_duplicate_facets", "smooth_laplacian"],
    )
    assert result["success"] is True, result.get("error", "")
    report = result["report"]
    assert report is not None
    assert report["elementCount"] > 0
    repairs = report["repairs"]
    assert repairs["ops"] == ["remove_duplicate_facets", "smooth_laplacian"]
    assert set(repairs["per_op"]) == {"remove_duplicate_facets", "smooth_laplacian"}
    dedupe = repairs["per_op"]["remove_duplicate_facets"]
    assert dedupe["facets_in"] > 0
    assert dedupe["facets_removed"] >= 0
    smooth = repairs["per_op"]["smooth_laplacian"]
    assert smooth["nodes_smoothed"] > 0
    assert smooth["max_deviation"] > 0.0
    assert "cell_sets_dropped" in repairs
    assert "nodes_removed" in repairs

    # The rewritten .msh matches the certified report.
    import meshio

    mesh = meshio.read(result["paths"]["msh"])
    assert len(mesh.points) == report["nodeCount"]


def test_repair_fill_holes_end_to_end(tmp_path: Path) -> None:
    """fill_holes runs on a real mesh and reports its (empty) hole census."""
    _requires_full_profile()
    step_path = _box_step(tmp_path)

    result = mesh_service.mesh_step(
        step_path,
        output_dir=str(tmp_path),
        output_stem="filled",
        mesh_size=3.0,
        repairs=["fill_holes"],
    )
    assert result["success"] is True, result.get("error", "")
    fill_stats = result["report"]["repairs"]["per_op"]["fill_holes"]
    assert fill_stats["holes_filled"] >= 0
    assert "holes_skipped" in fill_stats


def test_repair_decimate_fails_loudly_on_volumes(tmp_path: Path) -> None:
    """Decimate through mesh_step fails naming the op, volumes intact."""
    _requires_full_profile()
    step_path = _box_step(tmp_path)

    result = mesh_service.mesh_step(
        step_path,
        output_dir=str(tmp_path),
        output_stem="decimated",
        mesh_size=3.0,
        repairs=["decimate"],
    )
    assert result["success"] is False
    assert "decimate" in result["error"]
    assert "traceback" not in result


def test_pincell_mesh_smoke_with_repair(tmp_path: Path) -> None:
    """Pincell build123d model meshes with repairs; the report shows counts."""
    _requires_full_profile()
    import geometry_service

    script = tmp_path / "pincell.py"
    script.write_text(
        "from build123d import *\n"
        "fuel = Cylinder(radius=0.40, height=1.0)\n"
        "clad = Cylinder(radius=0.50, height=1.0) - Cylinder(radius=0.40, height=1.0)\n"
        "moderator = Box(1.26, 1.26, 1.0) - Cylinder(radius=0.50, height=1.0)\n"
        "model = Compound(children=[fuel, clad, moderator])\n"
    )
    service_result = geometry_service.build_geometry(
        str(script),
        output_dir=str(tmp_path),
        export_dagmc=False,
        export_mesh=False,
    )
    assert service_result["success"] is True, service_result.get("error", "")

    result = mesh_service.mesh_step(
        service_result["stepPath"],
        output_dir=str(tmp_path),
        output_stem="pincell_repaired",
        mesh_size=0.3,
        repairs=["remove_duplicate_facets", "fill_holes", "smooth_laplacian"],
    )
    assert result["success"] is True, result.get("error", "")
    report = result["report"]
    assert report["elementCount"] > 0
    assert report["repairs"]["ops"] == [
        "remove_duplicate_facets",
        "fill_holes",
        "smooth_laplacian",
    ]
    for key in ("msh", "e", "inp", "vtk", "report"):
        assert Path(result["paths"][key]).exists(), f"{key} missing"
