# Copyright (C) 2026 NukeHub and others.
# SPDX-License-Identifier: BSD-2-Clause
"""Pure-numpy analysis helpers for the base visualizer.

Backs the headless ``base.integrate``, ``base.describe`` and
``base.mesh-quality`` commands. This module never imports ``vtk``: the
helpers operate on plain sequences so they stay unit-testable in the
minimal pytest + numpy profile, while command handlers feed them arrays
read from VTK datasets.

Conventions:

- Values and measures are 1-D sequences. Measures (cell/point volumes or
  areas) must be non-negative.
- Non-finite values (NaN/inf) are excluded from every statistic and
  counted in ``nanCount``.
- Public helpers return plain Python dicts/lists, so results are
  JSON-safe by construction. ``mesh_quality_triangles`` /
  ``mesh_quality_tets`` accept ``as_lists=False`` for the vectorized
  command path.
- Degenerate *cells* are data, not errors: a zero-area triangle reports
  ``area == 0``, ``min_angle == 0`` and ``aspect_ratio == inf``. Empty
  input, mismatched shapes, negative measures, or a zero total measure
  raise :class:`AnalysisError`.

All public helpers raise :class:`AnalysisError` with a human-readable
message on failure.
"""

import numpy as np


class AnalysisError(Exception):
    """Raised for analysis helper failures (bad shape, empty data, zero measure)."""


def _as_1d(values, label):
    """Return ``values`` as a 1-D float array or raise :class:`AnalysisError`."""
    array = np.asarray(values, dtype=float)
    if array.ndim == 0:
        return array.reshape(1)
    if array.ndim == 1:
        return array
    if array.ndim == 2 and 1 in array.shape:
        return array.reshape(-1)
    raise AnalysisError(f"{label} must be a 1-D array (got shape {array.shape})")


def _integration_stats(values, measures, label):
    """Weighted integration shared by the cell and point entry points."""
    values = _as_1d(values, f"{label} values")
    measures = _as_1d(measures, f"{label} measures")
    if values.size == 0:
        raise AnalysisError(f"cannot integrate {label}: values are empty")
    if values.size != measures.size:
        raise AnalysisError(
            f"cannot integrate {label}: values ({values.size}) and measures "
            f"({measures.size}) must have the same length"
        )
    finite_measures = measures[np.isfinite(measures)]
    if np.any(finite_measures < 0):
        raise AnalysisError(f"cannot integrate {label}: measures must be non-negative")

    finite = np.isfinite(values) & np.isfinite(measures)
    excluded = int(values.size - np.count_nonzero(finite))
    if not np.any(finite):
        raise AnalysisError(f"cannot integrate {label}: no finite values")

    values = values[finite]
    measures = measures[finite]
    measure = float(measures.sum())
    if not np.isfinite(measure) or measure <= 0.0:
        raise AnalysisError(f"cannot integrate {label}: total measure is zero or non-finite")
    total = float(np.dot(values, measures))
    if not np.isfinite(total):
        raise AnalysisError(f"cannot integrate {label}: total is non-finite")
    return {
        "total": total,
        "mean": total / measure,
        "measure": measure,
        "count": int(values.size),
        "nanCount": excluded,
    }


def integrate_cell_values(values, cell_volumes):
    """Volume/area-weighted integral of per-cell values.

    Input: ``values`` (one scalar per cell) and ``cell_volumes`` (the
    matching cell volumes for ``--volume`` or areas for ``--surface``).
    Output: JSON-safe dict with ``total = sum(value * measure)``,
    ``mean = total / sum(measure)``, the summed ``measure``, the number
    of finite values (``count``) and the number of excluded non-finite
    entries (``nanCount``). Raises :class:`AnalysisError` for empty or
    mismatched input, negative measures, or a zero total measure.
    """
    return _integration_stats(values, cell_volumes, "cell")


def integrate_point_values(values, point_volumes):
    """Volume/area-weighted integral of per-point values.

    ``point_volumes`` is the lumped measure of each point (typically a
    cell measure divided evenly over its points). This is the same
    weighted integral as :func:`integrate_cell_values`: the result mean is
    the volume/area-weighted average, and ``total`` is that mean times the
    total measure. Raises :class:`AnalysisError` on the same conditions.
    """
    return _integration_stats(values, point_volumes, "point")


def describe_values(values):
    """Descriptive statistics of a scalar array with non-finite values excluded.

    Output: JSON-safe dict with ``min``, ``q1``, ``median``, ``q3``,
    ``max``, ``mean``, population ``std``, ``count`` (finite entries) and
    ``nanCount`` (excluded NaN/inf entries). Quartiles use numpy's linear
    interpolation. Raises :class:`AnalysisError` when the array is empty
    or every entry is non-finite.
    """
    array = _as_1d(values, "values")
    if array.size == 0:
        raise AnalysisError("cannot describe values: array is empty")
    finite = array[np.isfinite(array)]
    excluded = int(array.size - finite.size)
    if finite.size == 0:
        raise AnalysisError("cannot describe values: all values are non-finite")
    q1, median, q3 = np.percentile(finite, [25.0, 50.0, 75.0])
    return {
        "min": float(finite.min()),
        "q1": float(q1),
        "median": float(median),
        "q3": float(q3),
        "max": float(finite.max()),
        "mean": float(finite.mean()),
        "std": float(finite.std()),
        "count": int(finite.size),
        "nanCount": excluded,
    }


def _as_points(positions, label="positions"):
    """Validate an ``(n, 3)`` coordinate array."""
    points = np.asarray(positions, dtype=float)
    if points.size == 0:
        raise AnalysisError(f"{label} are empty")
    if points.ndim != 2 or points.shape[1] != 3:
        raise AnalysisError(f"{label} must be an (n, 3) array")
    if not np.all(np.isfinite(points)):
        raise AnalysisError(f"{label} contain non-finite coordinates")
    return points


def _as_connectivity(cells, width, point_count, label):
    """Validate an ``(n, width)`` integer connectivity array."""
    raw = np.asarray(cells)
    if raw.size == 0:
        raise AnalysisError(f"mesh has no {label}")
    if raw.ndim != 2 or raw.shape[1] != width:
        raise AnalysisError(f"{label} must be an (n, {width}) index array")
    if raw.dtype.kind in "fc" and not np.all(raw == np.floor(raw)):
        raise AnalysisError(f"{label} must contain integer point indices")
    indices = raw.astype(np.int64)
    if np.any(indices < 0) or np.any(indices >= point_count):
        raise AnalysisError(f"{label} reference point indices outside positions")
    return indices


def _triangle_areas(a, b, c):
    """Vectorized triangle areas for ``(n, 3)`` vertex arrays."""
    return 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)


def _angle_degrees(u, v):
    """Vectorized angle between row vectors in degrees (0 for zero-length rows)."""
    lengths = np.linalg.norm(u, axis=1) * np.linalg.norm(v, axis=1)
    dots = np.sum(u * v, axis=1)
    cosine = np.ones_like(lengths)
    np.divide(dots, lengths, out=cosine, where=lengths > 0.0)
    return np.degrees(np.arccos(np.clip(cosine, -1.0, 1.0)))


def _triangle_quality_arrays(points, triangles, include_skew):
    """Compute triangle quality arrays (numpy, not JSON-safe)."""
    a = points[triangles[:, 0]]
    b = points[triangles[:, 1]]
    c = points[triangles[:, 2]]
    ab = b - a
    ac = c - a
    area = _triangle_areas(a, b, c)
    edge_ab = np.linalg.norm(ab, axis=1)
    edge_ac = np.linalg.norm(ac, axis=1)
    edge_bc = np.linalg.norm(c - b, axis=1)
    perimeter = edge_ab + edge_ac + edge_bc

    angles = np.stack(
        [
            _angle_degrees(ab, ac),
            _angle_degrees(-ab, c - b),
            _angle_degrees(-ac, b - c),
        ],
        axis=1,
    )
    min_angle = angles.min(axis=1)
    max_angle = angles.max(axis=1)

    # Circumradius over twice the inradius: 1 for an equilateral triangle,
    # unbounded as the triangle degenerates (R / (2r) = abc * perimeter / (16 A^2)).
    edge_product = edge_ab * edge_ac * edge_bc
    with np.errstate(divide="ignore", invalid="ignore"):
        aspect_ratio = np.where(
            area > 0.0,
            edge_product * perimeter / (16.0 * area * area),
            np.inf,
        )

    quality = {
        "area": area,
        "min_angle": min_angle,
        "aspect_ratio": aspect_ratio,
    }
    if include_skew:
        # 0 at the ideal 60 degree angle, 1 at a fully collapsed triangle.
        skew = np.maximum((max_angle - 60.0) / 120.0, (60.0 - min_angle) / 60.0)
        quality["skew"] = np.clip(skew, 0.0, 1.0)
    return quality


def mesh_quality_triangles(positions, triangles, include_skew=True, as_lists=True):
    """Per-triangle quality metrics for a triangle mesh.

    Input: ``positions`` as ``(n_points, 3)`` and ``triangles`` as
    ``(n_triangles, 3)`` point indices. Output: dict with ``area``,
    ``min_angle`` (degrees), ``aspect_ratio`` (circumradius / twice the
    inradius; 1 for equilateral), optional ``skew`` (clipped to ``0..1``),
    and ``count``. Degenerate segments/areas yield ``area == 0``,
    ``min_angle == 0``, ``aspect_ratio == inf``; empty or malformed input
    raises :class:`AnalysisError`.

    ``as_lists`` defaults to True so the result is JSON-safe; pass
    ``as_lists=False`` for the vectorized numpy arrays used internally by
    the command handlers.
    """
    points = _as_points(positions)
    cells = _as_connectivity(triangles, 3, points.shape[0], "triangles")
    quality = _triangle_quality_arrays(points, cells, include_skew)
    quality["count"] = int(cells.shape[0])
    if not as_lists:
        return quality
    return {
        key: value if key == "count" else [float(item) for item in value]
        for key, value in quality.items()
    }


def _tet_quality_arrays(points, tets):
    """Compute tetrahedron quality arrays (numpy, not JSON-safe)."""
    a = points[tets[:, 0]]
    b = points[tets[:, 1]]
    c = points[tets[:, 2]]
    d = points[tets[:, 3]]
    volume = np.abs(np.linalg.det(np.stack([b - a, c - a, d - a], axis=-1))) / 6.0
    surface_area = (
        _triangle_areas(a, b, c)
        + _triangle_areas(a, b, d)
        + _triangle_areas(a, c, d)
        + _triangle_areas(b, c, d)
    )
    edges = np.stack(
        [
            np.linalg.norm(b - a, axis=1),
            np.linalg.norm(c - a, axis=1),
            np.linalg.norm(d - a, axis=1),
            np.linalg.norm(c - b, axis=1),
            np.linalg.norm(d - b, axis=1),
            np.linalg.norm(d - c, axis=1),
        ],
        axis=1,
    )
    longest_edge = edges.max(axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        inradius = np.where(surface_area > 0.0, 3.0 * volume / surface_area, 0.0)
        aspect_ratio = np.where(
            (volume > 0.0) & (surface_area > 0.0),
            longest_edge / (2.0 * np.sqrt(6.0) * inradius),
            np.inf,
        )
    return {
        "volume": volume,
        "surface_area": surface_area,
        "aspect_ratio": aspect_ratio,
    }


def mesh_quality_tets(positions, tets, as_lists=True):
    """Per-tetrahedron quality metrics.

    Input: ``positions`` as ``(n_points, 3)`` and ``tets`` as
    ``(n_tets, 4)`` point indices. Output: dict with ``volume``,
    ``surface_area``, ``aspect_ratio`` (longest edge / (2 * sqrt(6) * r);
    1 for a regular tetrahedron) and ``count``. Degenerate (coplanar)
    tets report ``volume == 0`` and ``aspect_ratio == inf``; empty or
    malformed input raises :class:`AnalysisError`.

    ``as_lists`` defaults to True so the result is JSON-safe; pass
    ``as_lists=False`` for the vectorized numpy arrays.
    """
    points = _as_points(positions)
    cells = _as_connectivity(tets, 4, points.shape[0], "tets")
    quality = _tet_quality_arrays(points, cells)
    quality["count"] = int(cells.shape[0])
    if not as_lists:
        return quality
    return {
        key: value if key == "count" else [float(item) for item in value]
        for key, value in quality.items()
    }
