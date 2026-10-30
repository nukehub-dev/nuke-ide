#!/usr/bin/env python3
# Copyright (C) 2026 NukeHub and others.
# SPDX-License-Identifier: BSD-2-Clause
"""Mesh repair for DAGMC prep (mesh-only surface-triangle repairs).

``dagmc_export`` reports seal diagnostics (holes, non-manifold edges) but
offers no way to fix a defective mesh short of rebuilding CAD. This module is
the repair half: four mesh-only ops that run on the triangle boundary of a
generated mesh after generation and before the ``.mesh.report.json`` quality
report, so the report certifies the repaired mesh.

Ops (mesh data only — never B-rep, never documents):

- ``remove_duplicate_facets``: drop exact-duplicate and degenerate triangles.
- ``fill_holes``: fan-fill closed boundary loops (capped loop size).
- ``smooth_laplacian``: Laplacian smoothing with boundary preservation.
- ``decimate``: deterministic target-reduction of the triangle count.

The core operates on plain numpy arrays so it stays testable in the minimal
pytest profile (pytest + numpy only); ``meshio``/``gmsh`` imports follow the
same guarded pattern as ``mesh_service`` (the module stays importable without
them). Every op reports per-op counts, and any op failure raises
:exc:`RepairError` naming the op — repairs never silently skip.
"""

from __future__ import annotations

from typing import Any

# Optional heavy dependencies. The module must remain importable without them.
try:
    import numpy as np

    HAS_NUMPY = True
except ImportError:
    np = None  # type: ignore
    HAS_NUMPY = False

try:
    import meshio

    HAS_MESHIO = True
except ImportError:
    meshio = None  # type: ignore
    HAS_MESHIO = False

try:
    import gmsh

    HAS_GMSH = True
except ImportError:
    gmsh = None  # type: ignore
    HAS_GMSH = False


SUPPORTED_OPS: tuple[str, ...] = (
    "remove_duplicate_facets",
    "fill_holes",
    "smooth_laplacian",
    "decimate",
)

# Boundary loops longer than this are left unfilled (and reported) by
# ``fill_holes``: a huge fan fill is almost certainly a missing patch, not a
# pinhole, and silently capping it with a giant fan would corrupt the model.
MAX_FILL_LOOP_SIZE = 32

# Hard cap on Laplacian iterations: smoothing always converges in a handful
# of passes, so anything beyond the cap is a caller bug, not a need.
MAX_SMOOTH_ITERATIONS = 100
DEFAULT_SMOOTH_ITERATIONS = 10
DEFAULT_SMOOTH_RATE = 0.5

# Default fraction of triangles ``decimate`` removes (0 < reduction < 1).
DEFAULT_TARGET_REDUCTION = 0.5

# Decimate rewrites the mesh at most this many collapse passes; each pass
# strictly reduces the triangle count (every merged edge degenerates at
# least its source triangle), so the cap is a backstop, not the exit.
_DECIMATE_MAX_PASSES = 8

# A closed surface needs at least 4 triangles (tetrahedron); decimate never
# targets fewer, whatever reduction was requested.
_DECIMATE_MIN_TRIANGLES = 4

_LINEAR_TRIANGLE_TYPES = frozenset({"triangle", "triangle3"})
_TETRA_TYPES = frozenset({"tetra", "tetra4", "tetra10"})


class RepairError(Exception):
    """A mesh repair op failed. The message always names the op."""


def _require_numpy(op: str) -> None:
    """Raise a loud op-named error when numpy is unavailable."""
    if not HAS_NUMPY or np is None:
        raise RepairError(f"{op}: numpy is required for mesh repair")


def require_meshio(op: str) -> None:
    """Raise a loud op-named error when meshio is unavailable."""
    if not HAS_MESHIO or meshio is None:
        raise RepairError(f"{op}: meshio is required for mesh repair I/O")


def require_gmsh(op: str) -> None:
    """Raise a loud op-named error when gmsh is unavailable."""
    if not HAS_GMSH or gmsh is None:
        raise RepairError(f"{op}: gmsh is required for this repair path")


def normalize_repair_ops(ops: str | list[str] | None) -> list[str]:
    """Validate and normalize a repair op selection to an ordered op list.

    Accepts the ``--repair <op,...>`` CLI string, a list of op names, or
    ``None`` (no repairs). Unknown names raise :exc:`RepairError` naming the
    offender; repeats run once (order preserved).
    """
    if ops is None:
        return []
    items = ops.split(",") if isinstance(ops, str) else list(ops)
    normalized: list[str] = []
    for raw in items:
        name = str(raw).strip()
        if not name:
            continue
        if name not in SUPPORTED_OPS:
            raise RepairError(
                f"Unknown mesh repair op '{name}' (supported: {', '.join(SUPPORTED_OPS)})"
            )
        if name not in normalized:
            normalized.append(name)
    return normalized


def _as_triangles(triangles: Any, op: str) -> Any:
    """Validate a triangle array to ``(M, 3)`` int64, or raise naming ``op``."""
    _require_numpy(op)
    assert np is not None
    try:
        arr = np.asarray(triangles, dtype=np.int64).reshape(-1, 3)
    except (TypeError, ValueError) as exc:
        raise RepairError(f"{op}: expected an (M, 3) triangle array") from exc
    if arr.ndim != 2 or arr.shape[1] != 3:
        raise RepairError(f"{op}: expected an (M, 3) triangle array")
    return arr


def _check_triangle_indices(points: Any, triangles: Any, op: str) -> None:
    """Raise naming ``op`` when triangle indices fall outside ``points``."""
    assert np is not None
    if triangles.size == 0 or len(points) == 0:
        return
    if int(triangles.min()) < 0 or int(triangles.max()) >= len(points):
        raise RepairError(f"{op}: triangle indices fall outside the point array")


def remove_duplicate_facets(
    triangles: Any, membership: list[set[str]] | None = None
) -> tuple[Any, list[set[str]] | None, dict[str, Any]]:
    """Drop exact-duplicate and degenerate triangles.

    Duplicates share the same three corner nodes (any winding); degenerate
    facets repeat a node within one triangle (zero area). The first
    occurrence of each duplicate group survives, so the surviving row keeps
    the lowest original index. When ``membership`` (one name-set per row) is
    given, the survivor inherits the union of its whole duplicate group, so
    no named surface silently loses coverage.

    Returns ``(unique_triangles, new_membership_or_None, stats)`` with
    ``facets_removed`` / ``degenerate_removed`` counts.
    """
    op = "remove_duplicate_facets"
    tris = _as_triangles(triangles, op)
    assert np is not None
    facets_in = len(tris)

    if membership is not None and len(membership) != facets_in:
        raise RepairError(f"{op}: membership length does not match the triangle count")

    survivor_of: dict[tuple[int, int, int], int] = {}
    keep_rows: list[int] = []
    merged_members: dict[int, set[str]] = {}
    degenerate_removed = 0
    for row_idx in range(facets_in):
        row = (int(tris[row_idx, 0]), int(tris[row_idx, 1]), int(tris[row_idx, 2]))
        if len(set(row)) < 3:
            degenerate_removed += 1
            continue
        key = tuple(sorted(row))
        if key in survivor_of:
            if membership is not None:
                merged_members[survivor_of[key]].update(membership[row_idx])
        else:
            survivor_of[key] = len(keep_rows)
            keep_rows.append(row_idx)
            if membership is not None:
                merged_members[len(keep_rows) - 1] = set(membership[row_idx])

    unique = tris[np.array(keep_rows, dtype=np.int64)] if keep_rows else np.empty((0, 3), np.int64)
    new_membership = None
    if membership is not None:
        new_membership = [merged_members[i] for i in range(len(keep_rows))]
    facets_removed = (facets_in - degenerate_removed) - len(keep_rows)
    stats = {
        "facets_in": int(facets_in),
        "facets_out": int(len(keep_rows)),
        "facets_removed": int(facets_removed),
        "degenerate_removed": int(degenerate_removed),
    }
    return unique, new_membership, stats


def find_boundary_loops(triangles: Any) -> list[tuple[list[int], bool]]:
    """Find boundary-edge chains in a triangle mesh.

    Boundary edges are used by exactly one triangle. Returns a list of
    ``(nodes, closed)`` entries: ``closed`` loops are hole rims, non-closed
    entries are open chains (dangling or non-manifold junctions) that fan
    filling must not touch.
    """
    op = "repair"
    tris = _as_triangles(triangles, op)
    if len(tris) == 0:
        return []

    def _key(u: int, v: int) -> tuple[int, int]:
        return (u, v) if u < v else (v, u)

    edge_count: dict[tuple[int, int], int] = {}
    for row_idx in range(len(tris)):
        corners = (int(tris[row_idx, 0]), int(tris[row_idx, 1]), int(tris[row_idx, 2]))
        for u, v in ((corners[0], corners[1]), (corners[1], corners[2]), (corners[2], corners[0])):
            key = _key(u, v)
            edge_count[key] = edge_count.get(key, 0) + 1

    boundary = [edge for edge, count in edge_count.items() if count == 1]
    if not boundary:
        return []

    adj: dict[int, list[int]] = {}
    for u, v in boundary:
        adj.setdefault(u, []).append(v)
        adj.setdefault(v, []).append(u)

    visited: set[tuple[int, int]] = set()
    loops: list[tuple[list[int], bool]] = []
    for u0, v0 in boundary:
        if _key(u0, v0) in visited:
            continue
        visited.add(_key(u0, v0))
        path = [u0]
        cur = v0
        closed = False
        while True:
            path.append(cur)
            if cur == u0:
                closed = True
                break
            nxt = None
            for candidate in adj.get(cur, []):
                if _key(cur, candidate) not in visited:
                    nxt = candidate
                    break
            if nxt is None:
                break
            visited.add(_key(cur, nxt))
            cur = nxt
        loops.append((path[:-1] if closed else path, closed))
    return loops


def _polygon_normal(loop_points: Any) -> Any:
    """Newell's-method normal for a loop polygon (unnormalized)."""
    assert np is not None
    normal = np.zeros(3, dtype=float)
    count = len(loop_points)
    for i in range(count):
        p = loop_points[i]
        q = loop_points[(i + 1) % count]
        normal[0] += (p[1] - q[1]) * (p[2] + q[2])
        normal[1] += (p[2] - q[2]) * (p[0] + q[0])
        normal[2] += (p[0] - q[0]) * (p[1] + q[1])
    return normal


def _dsu_find(parent: dict[int, int], x: int) -> int:
    """Disjoint-set find with path compression (decimate node merges)."""
    root = x
    while parent.get(root, root) != root:
        root = parent[root]
    while parent.get(x, x) != root:
        parent[x], x = root, parent[x]
    return root


def _triangle_normal(points: Any, tri: Any) -> Any:
    """Unit normal of one triangle (zero vector when degenerate)."""
    assert np is not None
    a, b, c = points[tri[0]], points[tri[1]], points[tri[2]]
    normal = np.cross(b - a, c - a)
    length = float(np.linalg.norm(normal))
    if length <= 0.0:
        return normal
    return normal / length


def fill_holes(
    points: Any, triangles: Any, max_loop_size: int = MAX_FILL_LOOP_SIZE
) -> tuple[Any, Any, dict[str, Any]]:
    """Fan-fill closed boundary loops (hole rims) in a triangle mesh.

    Each filled loop gains one centroid node (appended to ``points``) plus
    one fan triangle per rim edge. Fan winding follows the neighboring
    surface: the fill normal is flipped to agree with the area-weighted rim
    normals. Loops larger than ``max_loop_size``, self-touching loops, and
    open chains are left unfilled and reported — never silently capped or
    skipped. New fill triangles carry no surface membership (they are new
    geometry); the counts report exactly what was added.

    Returns ``(new_points, new_triangles, stats)``.
    """
    op = "fill_holes"
    _require_numpy(op)
    assert np is not None
    pts = np.asarray(points, dtype=float)
    tris = _as_triangles(triangles, op)
    _check_triangle_indices(pts, tris, op)

    loops = find_boundary_loops(tris)
    holes_found = sum(1 for _, closed in loops if closed)
    open_chains = sum(1 for _, closed in loops if not closed)

    # Rim edge -> owning triangle, for fill-orientation reference normals.
    rim_owner: dict[tuple[int, int], int] = {}
    for row_idx in range(len(tris)):
        corners = (int(tris[row_idx, 0]), int(tris[row_idx, 1]), int(tris[row_idx, 2]))
        for u, v in ((corners[0], corners[1]), (corners[1], corners[2]), (corners[2], corners[0])):
            key = (u, v) if u < v else (v, u)
            rim_owner[key] = row_idx

    holes_filled = 0
    holes_skipped = 0
    degenerate_loops = 0
    skipped_loop_sizes: list[int] = []
    new_point_rows: list[Any] = []
    new_tri_rows: list[tuple[int, int, int]] = []

    for nodes, closed in loops:
        if not closed:
            continue
        if len(set(nodes)) != len(nodes) or len(nodes) < 3:
            degenerate_loops += 1
            continue
        rim_keys = []
        for i in range(len(nodes)):
            u, v = nodes[i], nodes[(i + 1) % len(nodes)]
            rim_keys.append((u, v) if u < v else (v, u))
        if len({rim_owner.get(key) for key in rim_keys}) == 1:
            # The loop is one face's own perimeter, not a hole rim: a genuine
            # hole is rimmed by the faces around the missing patch, so every
            # edge sharing a single owner cannot border missing geometry.
            # Filling it would glue a coplanar fan onto the face.
            degenerate_loops += 1
            continue
        if len(nodes) > max_loop_size:
            holes_skipped += 1
            skipped_loop_sizes.append(len(nodes))
            continue

        loop_points = pts[np.array(nodes, dtype=np.int64)]
        centroid = loop_points.mean(axis=0)
        ref = np.zeros(3, dtype=float)
        for i in range(len(nodes)):
            u, v = nodes[i], nodes[(i + 1) % len(nodes)]
            key = (u, v) if u < v else (v, u)
            owner = rim_owner.get(key)
            if owner is not None:
                ref += _triangle_normal(pts, tris[owner])
        center_index = len(pts) + len(new_point_rows)
        new_point_rows.append(centroid)
        fan_normal = _polygon_normal(np.vstack([loop_points, centroid.reshape(1, 3)]))
        flip = bool(np.dot(fan_normal, ref) < 0.0) if float(np.linalg.norm(ref)) > 0.0 else False
        for i in range(len(nodes)):
            u, v = nodes[i], nodes[(i + 1) % len(nodes)]
            new_tri_rows.append((center_index, v, u) if flip else (center_index, u, v))
        holes_filled += 1

    if new_point_rows:
        new_points = np.vstack([pts] + [row.reshape(1, 3) for row in new_point_rows])
    else:
        new_points = pts.copy() if isinstance(pts, np.ndarray) else np.asarray(points, dtype=float)
    if new_tri_rows:
        added = np.array(new_tri_rows, dtype=np.int64)
        new_triangles = np.vstack([tris, added]) if len(tris) else added
    else:
        new_triangles = tris.copy()

    stats = {
        "holes_found": int(holes_found),
        "holes_filled": int(holes_filled),
        "holes_skipped": int(holes_skipped),
        "skipped_loop_sizes": [int(s) for s in skipped_loop_sizes],
        "degenerate_loops": int(degenerate_loops),
        "open_chains": int(open_chains),
        "facets_added": int(len(new_tri_rows)),
        "nodes_added": int(len(new_point_rows)),
    }
    return new_points, new_triangles, stats


def smooth_laplacian(
    points: Any,
    triangles: Any,
    iterations: int = DEFAULT_SMOOTH_ITERATIONS,
    rate: float = DEFAULT_SMOOTH_RATE,
) -> tuple[Any, dict[str, Any]]:
    """Laplacian-smooth surface nodes with boundary preservation.

    Each iteration moves every non-boundary surface node toward the mean of
    its triangle neighbors by ``rate`` (Jacobi updates: simultaneous, hence
    deterministic). Nodes on boundary edges (hole rims, open borders) are
    pinned — smoothing must never drag a seal out of place. Volume-interior
    nodes (unreferenced by any triangle) are untouched. Requests beyond
    :data:`MAX_SMOOTH_ITERATIONS` are clamped and reported, never applied
    silently. Topology is unchanged; only positions move.

    Returns ``(new_points, stats)`` with ``max_deviation`` (the deviation
    introduced, in model units) and smoothed/pinned node counts.
    """
    op = "smooth_laplacian"
    _require_numpy(op)
    assert np is not None
    if isinstance(iterations, bool) or not isinstance(iterations, (int, np.integer)):
        raise RepairError(f"{op}: iterations must be a non-negative integer (got {iterations!r})")
    if int(iterations) < 0:
        raise RepairError(f"{op}: iterations must be a non-negative integer (got {iterations!r})")
    if isinstance(rate, bool) or not isinstance(rate, (int, float, np.floating)):
        raise RepairError(f"{op}: rate must be a number in (0, 1] (got {rate!r})")
    if not 0.0 < float(rate) < 1.0 + 1e-12 or float(rate) <= 0.0:
        raise RepairError(f"{op}: rate must be a number in (0, 1] (got {rate!r})")

    requested = int(iterations)
    applied = min(requested, MAX_SMOOTH_ITERATIONS)
    pts = np.asarray(points, dtype=float)
    tris = _as_triangles(triangles, op)
    _check_triangle_indices(pts, tris, op)
    new_points = pts.copy()

    stats: dict[str, Any] = {
        "iterations_requested": int(requested),
        "iterations_applied": int(applied),
        "iterations_clamped": int(requested - applied),
        "nodes_smoothed": 0,
        "nodes_pinned": 0,
        "max_deviation": 0.0,
    }
    if applied == 0 or len(tris) == 0 or len(pts) == 0:
        return new_points, stats

    edge_count: dict[tuple[int, int], int] = {}
    neighbors: dict[int, set[int]] = {}
    for row_idx in range(len(tris)):
        corners = [int(tris[row_idx, 0]), int(tris[row_idx, 1]), int(tris[row_idx, 2])]
        for u, v in ((corners[0], corners[1]), (corners[1], corners[2]), (corners[2], corners[0])):
            key = (u, v) if u < v else (v, u)
            edge_count[key] = edge_count.get(key, 0) + 1
        for u, v in ((corners[0], corners[1]), (corners[1], corners[2]), (corners[2], corners[0])):
            neighbors.setdefault(u, set()).add(v)
            neighbors.setdefault(v, set()).add(u)

    pinned = {node for edge, count in edge_count.items() if count == 1 for node in edge}
    surface = set(neighbors)
    stats["nodes_pinned"] = int(len(surface & pinned))
    free = sorted(surface - pinned)
    stats["nodes_smoothed"] = int(len(free))
    if applied > 0 and free:
        free_pos = {node: pos for pos, node in enumerate(free)}
        rows: list[int] = []
        cols: list[int] = []
        for node in free:
            for other in neighbors[node]:
                rows.append(free_pos[node])
                cols.append(other)
        row_arr = np.array(rows, dtype=np.int64)
        col_arr = np.array(cols, dtype=np.int64)
        counts = np.bincount(row_arr, minlength=len(free)).astype(float)
        cur = new_points
        step = float(rate)
        for _ in range(applied):
            sums = np.zeros((len(free), 3), dtype=float)
            np.add.at(sums, row_arr, cur[col_arr])
            avg = sums / counts[:, None]
            cur[np.array(free, dtype=np.int64)] = cur[np.array(free, dtype=np.int64)] + step * (
                avg - cur[np.array(free, dtype=np.int64)]
            )
        disp = np.linalg.norm(cur - pts, axis=1)
        stats["max_deviation"] = float(disp.max()) if disp.size else 0.0
    return new_points, stats


def decimate_surface(
    points: Any,
    triangles: Any,
    target_reduction: float = DEFAULT_TARGET_REDUCTION,
    membership: list[set[str]] | None = None,
) -> tuple[Any, list[set[str]] | None, dict[str, Any]]:
    """Reduce the triangle count toward ``target_reduction`` (surface only).

    Algorithm (settled): iterative shortest-edge collapse in pure numpy.
    Each pass sorts the unique edges by length, greedily merges higher node
    ids into lower ones (disjoint-set union, fully deterministic) with a
    per-pass merge budget of roughly the remaining overshoot (an unbounded
    pass on a uniform grid would fold the whole mesh at once), rewrites
    the triangles, and drops the degenerate/duplicate rows each merge
    creates. Passes repeat until the target count is met, no edge merges, or
    the pass backstop is hit.

    Deliberately NOT gmsh remeshing (repair is mesh-only: there is no B-rep
    to remesh from, and gmsh is an optional guarded dependency) and NOT a
    quadric-error-metric collapse (that would need per-vertex matrices and a
    heap with lazy invalidation — heavier machinery with no better guarantee
    for a repair-time reduction). Shortest-edge-first minimizes shape change
    per removed triangle, which is what DAGMC-prep decimation wants.

    Volumetric cells are never touched: this function sees triangles only,
    and the mesh-level adapter refuses volume meshes loudly instead of
    orphaning tetrahedra (see :func:`repair_mesh_data`).

    When ``membership`` (one name-set per row) is given, surviving rows keep
    the union of the duplicate rows each collapse folds together, so no
    named surface silently loses coverage.

    Returns ``(new_triangles, new_membership_or_None, stats)``; points are
    unchanged (collapsed nodes become unreferenced — the adapter compacts
    them and reports the count).
    """
    op = "decimate"
    _require_numpy(op)
    assert np is not None
    if (
        isinstance(target_reduction, bool)
        or not isinstance(target_reduction, (int, float, np.floating))
        or not 0.0 < float(target_reduction) < 1.0
    ):
        raise RepairError(
            f"{op}: target_reduction must be a fraction in (0, 1) (got {target_reduction!r})"
        )
    pts = np.asarray(points, dtype=float)
    tris = _as_triangles(triangles, op)
    _check_triangle_indices(pts, tris, op)

    rows: list[tuple[int, int, int]] = [(int(r[0]), int(r[1]), int(r[2])) for r in tris.tolist()]
    facets_in = len(rows)
    if membership is not None and len(membership) != facets_in:
        raise RepairError(f"{op}: membership length does not match the triangle count")
    row_members: list[set[str]] = (
        [set(m) for m in membership] if membership is not None else [set() for _ in rows]
    )
    stats: dict[str, Any] = {
        "facets_in": int(facets_in),
        "facets_out": int(facets_in),
        "facets_removed": 0,
        "target_reduction": float(target_reduction),
        "target_triangle_count": 0,
        "achieved_reduction": 0.0,
        "collapsed_edges": 0,
        "passes": 0,
        "target_met": True,
    }
    if facets_in == 0:
        return np.empty((0, 3), dtype=np.int64), membership, stats

    target = max(_DECIMATE_MIN_TRIANGLES, int(facets_in * (1.0 - float(target_reduction))))
    stats["target_triangle_count"] = int(target)
    collapsed_edges = 0
    passes = 0

    while len(rows) > target and passes < _DECIMATE_MAX_PASSES:
        passes += 1
        parent: dict[int, int] = {}

        edges: dict[tuple[int, int], float] = {}
        for a, b, c in rows:
            for u, v in ((a, b), (b, c), (c, a)):
                ru, rv = _dsu_find(parent, u), _dsu_find(parent, v)
                if ru == rv:
                    continue
                key = (ru, rv) if ru < rv else (rv, ru)
                if key not in edges:
                    diff = pts[key[0]] - pts[key[1]]
                    edges[key] = float(np.dot(diff, diff))
        ordered = sorted(edges.items(), key=lambda item: (item[1], item[0][0], item[0][1]))

        merges = 0
        # Budget merges per pass to roughly the remaining overshoot: every
        # merge degenerates at least its source triangle, so an unbounded
        # pass on a uniform grid would fold the whole mesh at once and
        # overshoot the target (down to zero rows). The budget approaches
        # the target geometrically instead.
        merge_budget = max(1, len(rows) - target)
        for (u, v), _length in ordered:
            if merges >= merge_budget:
                break
            ru, rv = _dsu_find(parent, u), _dsu_find(parent, v)
            if ru == rv:
                continue
            parent[max(ru, rv)] = min(ru, rv)
            merges += 1
        if merges == 0:
            break
        collapsed_edges += merges

        rewritten: list[tuple[int, int, int]] = []
        rewritten_members: list[set[str]] = []
        seen: set[tuple[int, int, int]] = set()
        for (a, b, c), members in zip(rows, row_members, strict=True):
            t = (_dsu_find(parent, a), _dsu_find(parent, b), _dsu_find(parent, c))
            if len(set(t)) < 3:
                continue
            key = tuple(sorted(t))
            if key in seen:
                continue
            seen.add(key)
            rewritten.append(t)
            rewritten_members.append(set(members))
        rows = rewritten
        row_members = rewritten_members

    out = np.array(rows, dtype=np.int64).reshape(-1, 3) if rows else np.empty((0, 3), np.int64)
    removed = facets_in - len(rows)
    stats.update(
        {
            "facets_out": int(len(rows)),
            "facets_removed": int(removed),
            "achieved_reduction": float(removed / facets_in) if facets_in else 0.0,
            "collapsed_edges": int(collapsed_edges),
            "passes": int(passes),
            "target_met": bool(len(rows) <= target),
        }
    )
    new_membership = row_members if membership is not None else None
    return out, new_membership, stats


def _as_index_array(entry: Any, size: int, name: str, op: str) -> Any:
    """Normalize one cell-set entry to a dense int index array (loud on garbage)."""
    assert np is not None
    if entry is None:
        return np.empty((0,), dtype=np.int64)
    arr = np.asarray(entry)
    if arr.dtype == bool:
        flat = arr.ravel()
        if len(flat) != size:
            raise RepairError(f"{op}: cell set '{name}' mask length does not match its block")
        return np.nonzero(flat)[0].astype(np.int64)
    flat = arr.ravel().astype(np.int64)
    if len(flat) and (int(flat.min()) < 0 or int(flat.max()) >= size):
        raise RepairError(f"{op}: cell set '{name}' holds indices outside its block")
    return flat


def _is_triangle_type(cell_type: str) -> bool:
    """Return True for any triangular face element type."""
    return cell_type in _LINEAR_TRIANGLE_TYPES or str(cell_type).startswith("triangle")


def repair_mesh_data(
    points: Any,
    cells: list[tuple[str, Any]],
    cell_sets: dict[str, list[Any]] | None = None,
    cell_data: dict[str, list[Any]] | None = None,
    field_data: dict[str, Any] | None = None,
    ops: str | list[str] | None = None,
    *,
    max_loop_size: int = MAX_FILL_LOOP_SIZE,
    smooth_iterations: int = DEFAULT_SMOOTH_ITERATIONS,
    smooth_rate: float = DEFAULT_SMOOTH_RATE,
    target_reduction: float = DEFAULT_TARGET_REDUCTION,
) -> tuple[Any, list[tuple[str, Any]], dict[str, list[Any]], dict[str, list[Any]], dict[str, Any]]:
    """Apply repair ops to mesh arrays and return the repaired components.

    Args:
        points: ``(N, 3)`` node coordinates.
        cells: list of ``(cell_type, data)`` blocks (meshio cell-block form).
        cell_sets: name -> per-block index arrays (meshio ``cell_sets`` form).
        cell_data: name -> per-block data arrays (meshio ``cell_data`` form).
        field_data: name -> ``[tag, dim]`` physical-group mapping (passed
            through; reused to rebuild gmsh physical tags).
        ops: ordered repair ops (CLI string, list, or None).
        max_loop_size/smooth_iterations/smooth_rate/target_reduction: per-op
            tuning (defaults are the module constants).

    Tetrahedral (and any other non-triangle) blocks pass through untouched:
    repairs only ever rewrite triangle rows and point positions, and node
    compaction remaps every block uniformly. ``decimate`` on a mesh holding
    tetrahedra raises :exc:`RepairError` naming the op instead of orphaning
    volumes. Quadratic ``triangle6`` boundaries are likewise refused loudly
    (mid-edge nodes have no linear-collapse image).

    Returns ``(points, cells, cell_sets, cell_data, stats)`` where ``stats``
    holds ``ops``, per-op counts under ``per_op``, ``nodes_removed``,
    ``cell_data_reset`` (non-gmsh per-triangle arrays zero-filled for realigned
    blocks), ``cell_sets_dropped`` (``gmsh:``-prefixed reader metadata that
    cannot realign), and ``warnings`` (unfilled holes, unmet targets, clamped
    iterations — for the caller to surface).
    """
    ops_list = normalize_repair_ops(ops)
    op_context = ops_list[0] if ops_list else "repair"
    _require_numpy(op_context)
    assert np is not None

    if not ops_list:
        return (
            points,
            cells,
            dict(cell_sets or {}),
            dict(cell_data or {}),
            {
                "ops": [],
                "per_op": {},
                "nodes_removed": 0,
                "cell_data_reset": [],
                "warnings": [],
            },
        )

    pts = np.asarray(points, dtype=float)
    block_types = [str(cell_type) for cell_type, _ in cells]
    block_data = [np.asarray(data) for _, data in cells]

    tri_positions = [i for i, t in enumerate(block_types) if t in _LINEAR_TRIANGLE_TYPES]
    for _i, t in enumerate(block_types):
        if _is_triangle_type(t) and t not in _LINEAR_TRIANGLE_TYPES:
            raise RepairError(
                f"{op_context}: triangle cell type '{t}' is not supported "
                "(quadratic boundaries have no linear repair image); "
                "repair a linear mesh instead"
            )
    tet_total = sum(len(block_data[i]) for i, t in enumerate(block_types) if t in _TETRA_TYPES)

    if "decimate" in ops_list and tet_total > 0:
        raise RepairError(
            "decimate: refusing to decimate a volume mesh holding "
            f"{tet_total} tetrahedra — collapsing surface nodes would orphan "
            "volume elements and silently drop volumes. Run decimate on a "
            "surface-only mesh instead"
        )

    # Combine triangle blocks; track each row's named-surface membership so
    # duplicate folding unions coverage instead of dropping it.
    combined_tris = (
        np.vstack([block_data[i].reshape(-1, 3) for i in tri_positions]).astype(np.int64)
        if tri_positions
        else np.empty((0, 3), dtype=np.int64)
    )
    _check_triangle_indices(pts, combined_tris, op_context)
    membership: list[set[str]] = [set() for _ in range(len(combined_tris))]
    sets_in = dict(cell_sets or {})
    gmsh_sets_dropped: list[str] = []
    for name, entries in sets_in.items():
        if name.startswith("gmsh:"):
            # meshio reader metadata (e.g. gmsh:bounding_entities holds entity
            # tags, not cell indices): stale after any row rewrite, unused by
            # the report/Exodus/INP/VTK pipeline, so drop it and report it.
            gmsh_sets_dropped.append(name)
            continue
        entry_list = list(entries) if isinstance(entries, (list, tuple)) else []
        if len(entry_list) != len(cells):
            raise RepairError(
                f"{op_context}: cell set '{name}' does not align with the cell blocks"
            )
        offset = 0
        for block_pos in tri_positions:
            idx = _as_index_array(
                entry_list[block_pos], len(block_data[block_pos]), name, op_context
            )
            for local in idx.tolist():
                membership[offset + int(local)].add(name)
            offset += len(block_data[block_pos])

    cur_points, cur_tris, cur_membership = pts, combined_tris, membership
    per_op: dict[str, dict[str, Any]] = {}
    topo_changed = False
    for op in ops_list:
        try:
            if op == "remove_duplicate_facets":
                cur_tris, mem_out, op_stats = remove_duplicate_facets(cur_tris, cur_membership)
                cur_membership = mem_out if mem_out is not None else cur_membership
                topo_changed |= bool(op_stats["facets_removed"] or op_stats["degenerate_removed"])
            elif op == "fill_holes":
                cur_points, cur_tris, op_stats = fill_holes(
                    cur_points, cur_tris, max_loop_size=max_loop_size
                )
                cur_membership = cur_membership + [set() for _ in range(op_stats["facets_added"])]
                topo_changed |= bool(op_stats["facets_added"])
            elif op == "smooth_laplacian":
                cur_points, op_stats = smooth_laplacian(
                    cur_points, cur_tris, iterations=smooth_iterations, rate=smooth_rate
                )
            elif op == "decimate":
                collapsed, mem_out, op_stats = decimate_surface(
                    cur_points,
                    cur_tris,
                    target_reduction=target_reduction,
                    membership=cur_membership,
                )
                cur_membership = mem_out if mem_out is not None else cur_membership
                cur_tris = collapsed
                topo_changed |= bool(op_stats["facets_removed"])
            else:  # Unreachable: normalize_repair_ops validates names.
                raise RepairError(f"Unknown mesh repair op '{op}'")
        except RepairError:
            raise
        except Exception as exc:
            raise RepairError(f"{op} failed: {exc}")
        per_op[op] = op_stats

    # Rebuild cells: non-triangle blocks pass through in order; triangle
    # blocks merge into one block at the first triangle position.
    new_cells: list[tuple[str, Any]] = []
    new_block_origin: list[int | str] = []
    tri_emitted = False
    for pos, (cell_type, _) in enumerate(cells):
        if pos in tri_positions:
            if not tri_emitted:
                new_cells.append(("triangle", cur_tris))
                new_block_origin.append("merged_triangles")
                tri_emitted = True
            continue
        new_cells.append((cell_type, block_data[pos]))
        new_block_origin.append(pos)
    if tri_positions == [] and len(cur_tris) > 0:
        new_cells.append(("triangle", cur_tris))
        new_block_origin.append("merged_triangles")

    tet_after = sum(
        len(data)
        for (cell_type, data), _ in zip(new_cells, new_block_origin, strict=True)
        if cell_type in _TETRA_TYPES
    )
    if tet_after != tet_total:
        raise RepairError(
            f"{ops_list[-1]} failed: tetrahedral element count changed "
            f"({tet_total} -> {tet_after}); volumes must never change under repair"
        )

    # Compact nodes orphaned by facet removal/collapse; remap every block.
    nodes_removed = 0
    if len(cur_points) > 0 and new_cells:
        used = np.zeros(len(cur_points), dtype=bool)
        for _, data in new_cells:
            flat = np.asarray(data).ravel()
            valid = flat[(flat >= 0) & (flat < len(cur_points))]
            used[np.unique(valid)] = True
        if not bool(used.all()):
            remap = np.full(len(cur_points), -1, dtype=np.int64)
            remap[used] = np.arange(int(used.sum()), dtype=np.int64)
            remapped_cells: list[tuple[str, Any]] = []
            for cell_type, data in new_cells:
                arr = np.asarray(data)
                remapped_cells.append((cell_type, remap[arr]))
            new_cells = remapped_cells
            cur_points = cur_points[used]
            nodes_removed = int(len(used) - int(used.sum()))

    # Rebuild cell sets: volume/other entries pass through; the merged
    # triangle block gets recomputed membership (names never disappear —
    # emptied sets stay present with empty arrays).
    rows_by_name: dict[str, list[int]] = {}
    for row_idx, names in enumerate(cur_membership):
        for name in names:
            rows_by_name.setdefault(name, []).append(row_idx)
    new_sets: dict[str, list[Any]] = {}
    for name, entries in sets_in.items():
        if name.startswith("gmsh:"):
            continue
        entry_list = list(entries) if isinstance(entries, (list, tuple)) else []
        rebuilt: list[Any] = []
        for origin in new_block_origin:
            if origin == "merged_triangles":
                rebuilt.append(np.array(rows_by_name.get(name, []), dtype=np.int64).reshape(-1))
            elif isinstance(origin, int) and len(entry_list) == len(cells):
                rebuilt.append(
                    _as_index_array(entry_list[origin], len(block_data[origin]), name, op_context)
                )
            else:
                rebuilt.append(np.empty((0,), dtype=np.int64))
        new_sets[name] = rebuilt

    # Rebuild cell data: non-triangle entries pass through. Triangle entries
    # pass through only when the triangle rows are byte-identical to a single
    # original block (e.g. smoothing-only runs); otherwise gmsh physical /
    # geometrical tags are rebuilt from field_data and any other per-triangle
    # array is zero-filled and reported (it cannot realign meaningfully).
    data_in = dict(cell_data or {})
    fields = dict(field_data or {})
    single_tri_passthrough = (
        not topo_changed
        and len(tri_positions) == 1
        and len(cur_tris) == len(block_data[tri_positions[0]])
    )
    new_data: dict[str, list[Any]] = {}
    cell_data_reset: list[str] = []
    for key, entries in data_in.items():
        entry_list = list(entries) if isinstance(entries, (list, tuple)) else []
        rebuilt = []
        for origin in new_block_origin:
            if origin == "merged_triangles":
                if single_tri_passthrough and len(entry_list) == len(cells):
                    rebuilt.append(np.asarray(entry_list[tri_positions[0]]))
                elif key == "gmsh:physical":
                    tags = np.zeros(len(cur_tris), dtype=np.int64)
                    for row_idx, names in enumerate(cur_membership):
                        row_tags = [
                            int(np.asarray(fields[n]).ravel()[0])
                            for n in sorted(names)
                            if n in fields
                        ]
                        tags[row_idx] = min(row_tags) if row_tags else 0
                    rebuilt.append(tags)
                elif key == "gmsh:geometrical":
                    rebuilt.append(np.zeros(len(cur_tris), dtype=np.int64))
                else:
                    rebuilt.append(np.zeros(len(cur_tris), dtype=np.int64))
                    if key not in cell_data_reset:
                        cell_data_reset.append(key)
            elif isinstance(origin, int) and len(entry_list) == len(cells):
                rebuilt.append(np.asarray(entry_list[origin]))
            else:
                rebuilt.append(np.empty((0,), dtype=np.int64))
        new_data[key] = rebuilt

    warnings: list[str] = []
    fill_stats = per_op.get("fill_holes")
    if fill_stats and (fill_stats["holes_skipped"] or fill_stats["degenerate_loops"]):
        warnings.append(
            f"fill_holes left {fill_stats['holes_skipped']} oversized loop(s) unfilled "
            f"(sizes {fill_stats['skipped_loop_sizes']}, cap {max_loop_size}) and "
            f"skipped {fill_stats['degenerate_loops']} degenerate loop(s)"
        )
    if fill_stats and fill_stats["open_chains"]:
        warnings.append(
            f"fill_holes found {fill_stats['open_chains']} open boundary chain(s) "
            "(dangling/non-manifold) that fan filling must not touch"
        )
    smooth_stats = per_op.get("smooth_laplacian")
    if smooth_stats and smooth_stats["iterations_clamped"]:
        warnings.append(
            f"smooth_laplacian clamped iterations {smooth_stats['iterations_requested']} "
            f"to the {MAX_SMOOTH_ITERATIONS}-iteration cap"
        )
    decimate_stats = per_op.get("decimate")
    if decimate_stats and not decimate_stats["target_met"]:
        warnings.append(
            f"decimate missed its target ({decimate_stats['facets_out']} triangles vs "
            f"target {decimate_stats['target_triangle_count']}); achieved "
            f"{decimate_stats['achieved_reduction']:.2f} reduction"
        )

    stats = {
        "ops": list(ops_list),
        "per_op": per_op,
        "nodes_removed": int(nodes_removed),
        "cell_data_reset": cell_data_reset,
        "cell_sets_dropped": gmsh_sets_dropped,
        "warnings": warnings,
    }
    return cur_points, new_cells, new_sets, new_data, stats
