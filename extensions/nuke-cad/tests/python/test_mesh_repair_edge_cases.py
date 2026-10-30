"""Edge-case tests for mesh repair: guards, fallbacks, and mesh-level adaptation.

Complements ``test_mesh_repair.py`` with the error branches a real repair run
hits only on malformed input (bad triangle arrays, mismatched block metadata),
the deterministic decimate backstops (degenerate edges, duplicate collapse
rows, exhausted passes), and the mesh-level warning/repair-metadata contract.
Numeric tests need numpy only, so they run in the minimal pytest profile;
dependency-absence guards reload the module and restore it afterwards.
"""

from typing import Any

import mesh_repair
import pytest


def _numpy() -> Any:
    """Return numpy, skipping when it is unavailable."""
    return pytest.importorskip("numpy", reason="numpy not installed")


def _tet_points() -> Any:
    np = _numpy()
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
    np = _numpy()
    return np.array([[0, 1, 2], [0, 1, 3], [0, 2, 3]], dtype=np.int64)


def _quad_mesh() -> tuple[Any, Any]:
    """Five points; four triangles around a raised centre node."""
    np = _numpy()
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
    return points, tris


def _grid_surface(n: int = 6) -> tuple[Any, Any]:
    np = _numpy()
    xs = np.linspace(0.0, 1.0, n)
    points = np.array([[x, y, 0.0] for y in xs for x in xs], dtype=float)
    tris = []
    for j in range(n - 1):
        for i in range(n - 1):
            a = j * n + i
            tris.append([a, a + 1, a + n])
            tris.append([a + 1, a + n + 1, a + n])
    return points, np.array(tris, dtype=np.int64)


def _raise(exc: Exception, *args: Any, **kwargs: Any) -> Any:
    """Tiny callable that raises, for injecting an internal failure."""
    raise exc


# ---------------------------------------------------------------------------
# Dependency-absence and triangle-array guards.
# ---------------------------------------------------------------------------


def test_numpy_absence_fails_loudly(monkeypatch: Any) -> None:
    """Without numpy the module reports the dependency by name."""
    monkeypatch.setattr(mesh_repair, "HAS_NUMPY", False)
    monkeypatch.setattr(mesh_repair, "np", None)
    with pytest.raises(mesh_repair.RepairError, match="numpy is required"):
        mesh_repair._require_numpy("fill_holes")
    with pytest.raises(mesh_repair.RepairError, match="numpy is required"):
        mesh_repair.fill_holes([[0.0, 0.0, 0.0]], [[0, 0, 0]])


def test_as_triangles_rejects_non_triplet_rows(monkeypatch: Any) -> None:
    """A non-(M, 3) array errors naming the op instead of reshaping blindly."""
    _numpy()

    class _WrongShape:
        ndim = 2
        shape = (2, 2)

        def reshape(self, *args: Any) -> Any:
            return self

    class _FakeNumpy:
        int64 = "int64"

        @staticmethod
        def asarray(*args: Any, **kwargs: Any) -> Any:
            return _WrongShape()

    monkeypatch.setattr(mesh_repair, "np", _FakeNumpy)
    with pytest.raises(mesh_repair.RepairError, match=r"expected an \(M, 3\) triangle array"):
        mesh_repair._as_triangles([[0, 1, 2]], "repair")


def test_triangle_indices_outside_point_array_fail() -> None:
    """Both a too-large and a negative index fail naming fill_holes."""
    np = _numpy()
    points = np.zeros((4, 3), dtype=float)
    for bad in (np.array([[0, 1, 4]]), np.array([[-1, 0, 1]])):
        with pytest.raises(mesh_repair.RepairError, match="outside the point array"):
            mesh_repair.fill_holes(points, bad)


def test_as_triangles_wraps_a_non_multiple_row_count() -> None:
    """A flat array that cannot reshape to (M, 3) raises the op-named error."""
    with pytest.raises(
        mesh_repair.RepairError, match="repair: expected an \\(M, 3\\) triangle array"
    ):
        mesh_repair._as_triangles([1, 2, 3, 4], "repair")


def test_remove_duplicate_facets_rejects_membership_length_mismatch() -> None:
    np = _numpy()
    with pytest.raises(mesh_repair.RepairError, match="membership length"):
        mesh_repair.remove_duplicate_facets(np.array([[0, 1, 2]]), [set(), set()])


def test_dsu_find_compresses_a_chain() -> None:
    """A node behind an intermediate link is repointed straight at the root."""
    parent = {3: 2, 2: 1}
    assert mesh_repair._dsu_find(parent, 3) == 1
    assert parent[3] == 1
    assert parent[2] == 1


def test_triangle_normal_degenerate_is_zero_vector() -> None:
    """A zero-area triangle returns the (zero) cross product unnormalized."""
    np = _numpy()
    flat = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [2.0, 0.0, 0.0]], dtype=float)
    normal = mesh_repair._triangle_normal(flat, np.array([0, 1, 2]))
    assert np.allclose(normal, np.zeros(3))

    unit = mesh_repair._triangle_normal(
        np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]),
        np.array([0, 1, 2]),
    )
    assert np.allclose(unit, np.array([0.0, 0.0, 1.0]))


def test_fill_holes_reports_degenerate_boundary_loops(monkeypatch: Any) -> None:
    """Repeated-node and too-short loops are counted, never fan-filled."""
    np = _numpy()
    monkeypatch.setattr(
        mesh_repair,
        "find_boundary_loops",
        lambda tris: [([0, 1, 1], True), ([0, 1], True)],
    )
    points = np.zeros((3, 3), dtype=float)
    tris = np.array([[0, 1, 2]], dtype=np.int64)

    new_points, new_tris, stats = mesh_repair.fill_holes(points, tris)
    assert stats["holes_found"] == 2
    assert stats["holes_filled"] == 0
    assert stats["degenerate_loops"] == 2
    assert stats["facets_added"] == 0
    assert len(new_points) == 3
    assert len(new_tris) == 1


# ---------------------------------------------------------------------------
# Parameter guards and decimate backstops.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("kwargs", "match"),
    [
        ({"iterations": 2.5}, "iterations"),
        ({"iterations": True}, "iterations"),
        ({"rate": "fast"}, "rate"),
        ({"rate": True}, "rate"),
    ],
)
def test_smooth_laplacian_rejects_non_numeric_params(kwargs: dict[str, Any], match: str) -> None:
    points = _tet_points()
    with pytest.raises(mesh_repair.RepairError, match=match):
        mesh_repair.smooth_laplacian(points, _open_tet(), **kwargs)


def test_decimate_rejects_membership_length_mismatch() -> None:
    points, tris = _grid_surface(3)
    with pytest.raises(mesh_repair.RepairError, match="membership length"):
        mesh_repair.decimate_surface(points, tris, membership=[set()])


def test_decimate_empty_mesh_returns_empty_without_passes() -> None:
    np = _numpy()
    out, membership, stats = mesh_repair.decimate_surface(
        np.empty((0, 3), dtype=float),
        np.empty((0, 3), dtype=np.int64),
        membership=[],
    )
    assert out.shape == (0, 3)
    assert membership == []
    assert stats["facets_in"] == 0
    assert stats["target_met"] is True
    assert stats["passes"] == 0


def test_decimate_ignores_degenerate_triangle_edges() -> None:
    """A zero-length edge inside a degenerate row is skipped, not collapsed."""
    np = _numpy()
    points, tris = _grid_surface()
    with_degenerate = np.vstack([tris, np.array([[0, 0, 1]], dtype=np.int64)])

    out, _, stats = mesh_repair.decimate_surface(points, with_degenerate, target_reduction=0.5)
    assert stats["facets_in"] == 51
    assert stats["target_met"] is True
    assert len(out) <= 25
    assert all(len(set(row)) == 3 for row in out.tolist())


def test_decimate_stops_when_no_edge_can_collapse() -> None:
    """A mesh of only degenerate rows exits after one no-merge pass."""
    np = _numpy()
    degenerate = np.zeros((8, 3), dtype=np.int64)
    out, _, stats = mesh_repair.decimate_surface(
        np.zeros((1, 3), dtype=float), degenerate, target_reduction=0.5
    )
    assert stats["passes"] == 1
    assert stats["collapsed_edges"] == 0
    assert stats["target_met"] is False
    assert len(out) == 8


def test_decimate_drops_rows_that_collapse_to_duplicates() -> None:
    """Distinct rows folding onto the same corners keep one survivor each."""
    np = _numpy()
    points = np.array(
        [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.01, 1.0, 0.0],
            [5.0, 5.0, 5.0],
            [6.0, 5.0, 5.0],
            [5.0, 6.0, 5.0],
            [6.0, 6.0, 5.0],
        ],
        dtype=float,
    )
    tris = np.array(
        [
            [0, 1, 2],
            [0, 1, 3],
            [4, 5, 6],
            [5, 6, 7],
            [4, 5, 7],
            [4, 6, 7],
            [0, 1, 2],
            [0, 2, 3],
        ],
        dtype=np.int64,
    )

    out, _, stats = mesh_repair.decimate_surface(points, tris, target_reduction=0.5)
    keys = [tuple(sorted(row)) for row in out.tolist()]
    assert len(keys) == len(set(keys))
    assert stats["collapsed_edges"] >= 2
    assert stats["facets_removed"] == 8 - len(out)


# ---------------------------------------------------------------------------
# Mesh-level cell-set and cell-data normalization.
# ---------------------------------------------------------------------------


def test_as_index_array_none_mask_and_bounds() -> None:
    np = _numpy()
    assert mesh_repair._as_index_array(None, 4, "patch", "repair").tolist() == []

    mask = np.array([True, False, True, False])
    assert mesh_repair._as_index_array(mask, 4, "patch", "repair").tolist() == [0, 2]
    assert mesh_repair._as_index_array([2, 0], 4, "patch", "repair").tolist() == [2, 0]

    with pytest.raises(mesh_repair.RepairError, match="mask length"):
        mesh_repair._as_index_array(np.array([True]), 4, "patch", "repair")
    with pytest.raises(mesh_repair.RepairError, match="outside its block"):
        mesh_repair._as_index_array(np.array([0, 4]), 4, "patch", "repair")


def test_repair_mesh_data_without_ops_passes_everything_through() -> None:
    np = _numpy()
    points, tris = _quad_mesh()
    cells = [("triangle", tris)]
    cell_sets = {"patch": [np.array([0, 1], dtype=np.int64)]}
    cell_data = {"tag": [np.array([4, 4, 5, 5], dtype=np.int64)]}

    result = mesh_repair.repair_mesh_data(points, cells, cell_sets, cell_data, None, None)
    new_points, new_cells, new_sets, new_data, stats = result
    assert new_points is points
    assert new_cells is cells
    assert list(new_sets) == ["patch"]
    assert np.array_equal(new_sets["patch"][0], cell_sets["patch"][0])
    assert list(new_data) == ["tag"]
    assert stats == {
        "ops": [],
        "per_op": {},
        "nodes_removed": 0,
        "cell_data_reset": [],
        "warnings": [],
    }


def test_repair_mesh_data_rejects_cell_set_block_misalignment() -> None:
    np = _numpy()
    points, tris = _quad_mesh()
    cells = [("triangle", tris), ("tetra", np.array([[0, 1, 2, 4]], dtype=np.int64))]
    with pytest.raises(mesh_repair.RepairError, match="does not align"):
        mesh_repair.repair_mesh_data(
            points, cells, {"patch": [np.array([0])]}, {}, {}, ["smooth_laplacian"]
        )


def test_repair_mesh_data_rejects_cell_set_index_outside_block() -> None:
    np = _numpy()
    points, tris = _quad_mesh()
    with pytest.raises(mesh_repair.RepairError, match="outside its block"):
        mesh_repair.repair_mesh_data(
            points,
            [("triangle", tris)],
            {"patch": [np.array([0, 99])]},
            {},
            {},
            ["smooth_laplacian"],
        )


def test_repair_mesh_data_accepts_boolean_cell_set_masks() -> None:
    np = _numpy()
    points, tris = _quad_mesh()
    _, _, new_sets, _, _ = mesh_repair.repair_mesh_data(
        points,
        [("triangle", tris)],
        {"top": [np.array([True, False, True, False])]},
        {},
        {},
        ["smooth_laplacian"],
    )
    assert new_sets["top"][0].tolist() == [0, 2]


def test_repair_mesh_data_rejects_wrong_length_cell_set_mask() -> None:
    np = _numpy()
    points, tris = _quad_mesh()
    with pytest.raises(mesh_repair.RepairError, match="mask length"):
        mesh_repair.repair_mesh_data(
            points,
            [("triangle", tris)],
            {"top": [np.array([True, False])]},
            {},
            {},
            ["smooth_laplacian"],
        )


def test_repair_mesh_data_none_cell_set_entry_is_empty() -> None:
    """A None entry for a volume block rebuilds as an empty index array."""
    np = _numpy()
    points, tris = _quad_mesh()
    cells = [("tetra", np.array([[0, 1, 2, 4]], dtype=np.int64)), ("triangle", tris)]
    _, _, new_sets, _, _ = mesh_repair.repair_mesh_data(
        points,
        cells,
        {"patch": [None, np.array([0, 1])]},
        {},
        {},
        ["smooth_laplacian"],
    )
    assert new_sets["patch"][0].size == 0
    assert new_sets["patch"][1].tolist() == [0, 1]


def test_repair_mesh_data_rebuilds_all_cell_data_kinds() -> None:
    """Topology changes rebuild physical tags, zero geometrical/custom arrays."""
    np = _numpy()
    points, tris = _quad_mesh()
    duplicated = np.vstack([tris, tris[:1]])
    cells = [("triangle", duplicated)]
    cell_sets = {"surf": [np.array([0, 1, 2, 3, 4])]}
    cell_data = {
        "gmsh:physical": [np.array([4, 4, 5, 5, 6])],
        "gmsh:geometrical": [np.arange(5, dtype=np.int64)],
        "material": [np.arange(5, dtype=np.int64)],
    }
    field_data = {"surf": np.array([9, 2])}

    _, new_cells, new_sets, new_data, stats = mesh_repair.repair_mesh_data(
        points, cells, cell_sets, cell_data, field_data, ["remove_duplicate_facets"]
    )
    assert len(new_cells[0][1]) == 4
    assert new_data["gmsh:physical"][0].tolist() == [9, 9, 9, 9]
    assert new_data["gmsh:geometrical"][0].tolist() == [0, 0, 0, 0]
    assert new_data["material"][0].tolist() == [0, 0, 0, 0]
    assert stats["cell_data_reset"] == ["material"]
    assert new_sets["surf"][0].tolist() == [0, 1, 2, 3]


def test_repair_mesh_data_empties_misaligned_non_triangle_cell_data() -> None:
    np = _numpy()
    points, tris = _quad_mesh()
    cells = [("tetra", np.array([[0, 1, 2, 4]], dtype=np.int64)), ("triangle", tris)]
    _, _, _, new_data, stats = mesh_repair.repair_mesh_data(
        points,
        cells,
        {},
        {"quality": [np.array([1, 2], dtype=np.int64)]},
        {},
        ["smooth_laplacian"],
    )
    assert new_data["quality"][0].size == 0
    assert new_data["quality"][1].tolist() == [0, 0, 0, 0]
    assert stats["cell_data_reset"] == ["quality"]


# ---------------------------------------------------------------------------
# Warning census and loud failure paths.
# ---------------------------------------------------------------------------


def test_repair_mesh_data_warns_about_skipped_and_degenerate_loops() -> None:
    _numpy()
    points = _tet_points()
    _, _, _, _, stats = mesh_repair.repair_mesh_data(
        points, [("triangle", _open_tet())], {}, {}, {}, ["fill_holes"], max_loop_size=2
    )
    assert len(stats["warnings"]) == 1
    assert "oversized" in stats["warnings"][0]
    assert "[3]" in stats["warnings"][0]


def test_repair_mesh_data_warns_about_open_chains() -> None:
    np = _numpy()
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
    _, _, _, _, stats = mesh_repair.repair_mesh_data(
        points, [("triangle", tris)], {}, {}, {}, ["fill_holes"]
    )
    assert any("open boundary chain" in warning for warning in stats["warnings"])


def test_repair_mesh_data_warns_about_clamped_smoothing() -> None:
    points, tris = _quad_mesh()
    _, _, _, _, stats = mesh_repair.repair_mesh_data(
        points,
        [("triangle", tris)],
        {},
        {},
        {},
        ["smooth_laplacian"],
        smooth_iterations=mesh_repair.MAX_SMOOTH_ITERATIONS + 7,
    )
    assert len(stats["warnings"]) == 1
    assert "clamped iterations" in stats["warnings"][0]


def test_repair_mesh_data_warns_about_missed_decimate_target(monkeypatch: Any) -> None:
    _numpy()
    monkeypatch.setattr(mesh_repair, "_DECIMATE_MAX_PASSES", 0)
    points, tris = _grid_surface()
    _, _, _, _, stats = mesh_repair.repair_mesh_data(
        points, [("triangle", tris)], {}, {}, {}, ["decimate"]
    )
    assert len(stats["warnings"]) == 1
    assert "decimate missed its target" in stats["warnings"][0]


def test_repair_mesh_data_wraps_unexpected_op_failure(monkeypatch: Any) -> None:
    _numpy()
    points, tris = _quad_mesh()
    monkeypatch.setattr(
        mesh_repair, "fill_holes", lambda *args, **kwargs: _raise(RuntimeError("boom"))
    )
    with pytest.raises(mesh_repair.RepairError, match="fill_holes failed: boom"):
        mesh_repair.repair_mesh_data(points, [("triangle", tris)], {}, {}, {}, ["fill_holes"])


def test_repair_mesh_data_rejects_op_outside_the_validated_set(monkeypatch: Any) -> None:
    """Defense in depth: an op list that bypassed normalization still fails."""
    _numpy()
    points, tris = _quad_mesh()
    monkeypatch.setattr(mesh_repair, "normalize_repair_ops", lambda ops: ["bogus_op"])
    with pytest.raises(mesh_repair.RepairError, match="Unknown mesh repair op 'bogus_op'"):
        mesh_repair.repair_mesh_data(points, [("triangle", tris)], {}, {}, {}, ["bogus_op"])


def test_repair_mesh_data_emits_triangle_block_from_volume_only_input(monkeypatch: Any) -> None:
    """A repair that produces triangles on a volume-only mesh keeps the block."""
    np = _numpy()
    points, _ = _quad_mesh()
    cells = [("tetra", np.array([[0, 1, 2, 4]], dtype=np.int64))]
    monkeypatch.setattr(
        mesh_repair,
        "fill_holes",
        lambda pts, tris, max_loop_size=0: (
            pts,
            np.array([[0, 1, 2]], dtype=np.int64),
            {
                "holes_skipped": 0,
                "degenerate_loops": 0,
                "open_chains": 0,
                "skipped_loop_sizes": [],
                "facets_added": 0,
            },
        ),
    )
    _, new_cells, _, _, _ = mesh_repair.repair_mesh_data(points, cells, {}, {}, {}, ["fill_holes"])
    assert [cell_type for cell_type, _ in new_cells] == ["tetra", "triangle"]


def test_repair_mesh_data_guards_tetrahedral_counts(monkeypatch: Any) -> None:
    """A repair that changes the volume-element census fails loudly."""
    np = _numpy()
    points = np.zeros((3, 3), dtype=float)
    tris = np.array([[0, 1, 2], [2, 1, 0]], dtype=np.int64)
    monkeypatch.setattr(mesh_repair, "_TETRA_TYPES", frozenset({"tetra", "triangle"}))
    with pytest.raises(mesh_repair.RepairError, match="tetrahedral element count changed"):
        mesh_repair.repair_mesh_data(
            points, [("triangle", tris)], {}, {}, {}, ["remove_duplicate_facets"]
        )
