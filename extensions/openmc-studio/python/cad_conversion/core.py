"""Core utilities and types for CAD conversion."""

import math
from dataclasses import dataclass, field
from typing import Any


@dataclass
class SurfaceFitResult:
    """Result of fitting a surface to sampled points."""

    surface_type: str  # e.g. 'plane', 'sphere', 'cylinder', 'cone', 'torus', 'quadric', ...
    coefficients: list[float]
    max_deviation: float
    center: list[float] | None = None
    axis: list[float] | None = None
    radius: float | None = None
    warning: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class TopologyInfo:
    """Topology information for a CAD assembly."""

    solid_count: int
    face_count: int
    edge_count: int
    vertex_count: int
    adjacency: dict[int, list[int]] = field(default_factory=dict)
    shared_faces: dict[tuple[int, int], list[int]] = field(default_factory=dict)


def normalize_vector(v: list[float]) -> list[float]:
    """Normalize a 3D vector to unit length."""
    length = math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)
    if length < 1e-10:
        return [0.0, 0.0, 1.0]
    return [v[0] / length, v[1] / length, v[2] / length]


def cross_product(a: list[float], b: list[float]) -> list[float]:
    """Compute cross product of two 3D vectors."""
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]


def dot_product(a: list[float], b: list[float]) -> float:
    """Compute dot product of two 3D vectors."""
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def distance_point_to_line(
    point: list[float], line_point: list[float], line_dir: list[float]
) -> float:
    """Compute perpendicular distance from point to line."""
    dx = point[0] - line_point[0]
    dy = point[1] - line_point[1]
    dz = point[2] - line_point[2]
    # Cross product of (P - A) and direction
    cx = dy * line_dir[2] - dz * line_dir[1]
    cy = dz * line_dir[0] - dx * line_dir[2]
    cz = dx * line_dir[1] - dy * line_dir[0]
    cross_len = math.sqrt(cx**2 + cy**2 + cz**2)
    dir_len = math.sqrt(line_dir[0] ** 2 + line_dir[1] ** 2 + line_dir[2] ** 2)
    if dir_len < 1e-10:
        return math.sqrt(dx**2 + dy**2 + dz**2)
    return cross_len / dir_len


def vector_subtract(a: list[float], b: list[float]) -> list[float]:
    """Subtract two vectors."""
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]


def vector_add(a: list[float], b: list[float]) -> list[float]:
    """Add two vectors."""
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]


def vector_scale(v: list[float], s: float) -> list[float]:
    """Scale a vector."""
    return [v[0] * s, v[1] * s, v[2] * s]


def is_axis_aligned(axis: list[float], tol: float = 0.05) -> str | None:
    """Check if an axis is aligned with x, y, or z. Returns 'x', 'y', 'z' or None."""
    ax = abs(axis[0])
    ay = abs(axis[1])
    az = abs(axis[2])
    if ax > 1 - tol and ay < tol and az < tol:
        return "x"
    if ay > 1 - tol and ax < tol and az < tol:
        return "y"
    if az > 1 - tol and ax < tol and ay < tol:
        return "z"
    return None


def ransac_fit(
    points: list[list[float]],
    fit_fn,
    evaluate_fn,
    sample_size: int,
    max_iterations: int = 100,
    inlier_threshold: float = 0.01,
) -> tuple[Any | None, list[int]]:
    """Generic RANSAC robust fitting wrapper.

    Args:
        points: List of 3D points.
        fit_fn: Function that takes a list of points and returns a model or None.
        evaluate_fn: Function(model, point) -> residual distance.
        sample_size: Number of points to sample for initial fit.
        max_iterations: Max RANSAC iterations.
        inlier_threshold: Residual threshold to count as inlier.

    Returns:
        (best_model, best_inlier_indices)
    """
    import random

    if len(points) < sample_size:
        return None, list(range(len(points)))

    best_model = None
    best_inliers = []

    for _ in range(max_iterations):
        sample = random.sample(points, sample_size)
        model = fit_fn(sample)
        if model is None:
            continue

        inliers = []
        for i, p in enumerate(points):
            try:
                residual = evaluate_fn(model, p)
                if residual < inlier_threshold:
                    inliers.append(i)
            except Exception:
                pass

        if len(inliers) > len(best_inliers):
            best_inliers = inliers
            # Refit with all inliers
            inlier_points = [points[i] for i in inliers]
            refit = fit_fn(inlier_points)
            if refit is not None:
                best_model = refit

    return best_model, best_inliers
