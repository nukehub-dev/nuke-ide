"""Analytic surface fitting algorithms for OpenMC CSG primitives."""

import math

from .core import (
    SurfaceFitResult,
    is_axis_aligned,
    normalize_vector,
)

try:
    import numpy as np

    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False
    np = None  # type: ignore


# ---------------------------------------------------------------------------
# Plane
# ---------------------------------------------------------------------------


def fit_plane(points: list[list[float]]) -> SurfaceFitResult | None:
    """Fit a plane to 3D points using PCA."""
    if len(points) < 3:
        return None

    if HAS_NUMPY:
        points_arr = np.array(points)
        centroid = np.mean(points_arr, axis=0)
        centered = points_arr - centroid
        cov = np.dot(centered.T, centered) / len(points)
        eigenvalues, eigenvectors = np.linalg.eigh(cov)
        normal = eigenvectors[:, 0]
        normal = normalize_vector(normal.tolist())

        if normal[2] < 0:
            normal = [-n for n in normal]

        d = np.dot(normal, centroid)
        deviations = [abs(np.dot(normal, p) - d) for p in points_arr]
        max_dev = float(max(deviations)) if deviations else 0.0

        return SurfaceFitResult(
            surface_type="plane",
            coefficients=[float(normal[0]), float(normal[1]), float(normal[2]), -float(d)],
            max_deviation=max_dev,
            center=centroid.tolist(),
            axis=normal,
        )
    else:
        n = len(points)
        cx = sum(p[0] for p in points) / n
        cy = sum(p[1] for p in points) / n
        cz = sum(p[2] for p in points) / n
        p1, p2, p3 = points[0], points[1], points[2]
        v1 = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]]
        v2 = [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]]
        nx = v1[1] * v2[2] - v1[2] * v2[1]
        ny = v1[2] * v2[0] - v1[0] * v2[2]
        nz = v1[0] * v2[1] - v1[1] * v2[0]
        normal = normalize_vector([nx, ny, nz])
        d = normal[0] * cx + normal[1] * cy + normal[2] * cz
        return SurfaceFitResult(
            surface_type="plane",
            coefficients=[normal[0], normal[1], normal[2], -d],
            max_deviation=0.001,
            center=[cx, cy, cz],
            axis=normal,
        )


# ---------------------------------------------------------------------------
# Sphere
# ---------------------------------------------------------------------------


def fit_sphere(points: list[list[float]]) -> SurfaceFitResult | None:
    """Fit a sphere using linear least squares."""
    if len(points) < 4 or not HAS_NUMPY:
        return None

    points_arr = np.array(points)
    A = np.column_stack(
        [2 * points_arr[:, 0], 2 * points_arr[:, 1], 2 * points_arr[:, 2], np.ones(len(points_arr))]
    )
    b = points_arr[:, 0] ** 2 + points_arr[:, 1] ** 2 + points_arr[:, 2] ** 2

    try:
        sol = np.linalg.lstsq(A, b, rcond=None)[0]
        center = [float(sol[0]), float(sol[1]), float(sol[2])]
        r = math.sqrt(sol[3] + center[0] ** 2 + center[1] ** 2 + center[2] ** 2)

        deviations = [
            abs(math.sqrt(sum((p[i] - center[i]) ** 2 for i in range(3))) - r) for p in points
        ]
        max_dev = max(deviations) if deviations else float("inf")

        return SurfaceFitResult(
            surface_type="sphere",
            coefficients=center + [float(r)],
            max_deviation=max_dev,
            center=center,
            radius=float(r),
        )
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Cylinder (axis-aligned and general)
# ---------------------------------------------------------------------------


def fit_cylinder(points: list[list[float]]) -> SurfaceFitResult | None:
    """Fit a right circular cylinder (general axis)."""
    if len(points) < 6 or not HAS_NUMPY:
        return None

    points_arr = np.array(points)
    centroid = np.mean(points_arr, axis=0)
    centered = points_arr - centroid
    cov = np.dot(centered.T, centered) / len(points)
    eigenvalues, eigenvectors = np.linalg.eigh(cov)

    # For a cylinder, the axis can be either the largest or smallest eigenvector
    # depending on aspect ratio. Try both and pick the best fit.
    best_result = None
    best_dev = float("inf")

    for axis_idx in [2, 0]:  # largest eigenvalue first, then smallest
        axis_vec = eigenvectors[:, axis_idx]
        axis_vec = normalize_vector(
            axis_vec.tolist() if hasattr(axis_vec, "tolist") else list(axis_vec)
        )

        # Build perpendicular basis
        u = np.cross(axis_vec, [1.0, 0.0, 0.0])
        if np.linalg.norm(u) < 0.1:
            u = np.cross(axis_vec, [0.0, 1.0, 0.0])
        u = normalize_vector(u.tolist() if hasattr(u, "tolist") else list(u))
        v = normalize_vector(
            np.cross(axis_vec, u).tolist()
            if hasattr(np.cross(axis_vec, u), "tolist")
            else list(np.cross(axis_vec, u))
        )

        projections = []
        for p in centered:
            pu = float(np.dot(p, u))
            pv = float(np.dot(p, v))
            projections.append([pu, pv])

        projections_arr = np.array(projections)
        A = np.column_stack(
            [projections_arr[:, 0], projections_arr[:, 1], np.ones(len(projections_arr))]
        )
        b = projections_arr[:, 0] ** 2 + projections_arr[:, 1] ** 2

        try:
            sol = np.linalg.lstsq(A, b, rcond=None)[0]
            cx, cy = sol[0] / 2.0, sol[1] / 2.0
            r = math.sqrt(float(sol[2]) + cx**2 + cy**2)

            if r <= 0 or math.isnan(r):
                continue

            center = centroid + cx * np.array(u) + cy * np.array(v)
            center = center.tolist()

            deviations = []
            for p in points_arr:
                to_point = p - np.array(center)
                proj_axis = float(np.dot(to_point, axis_vec))
                perp = to_point - proj_axis * np.array(axis_vec)
                dist = float(np.linalg.norm(perp))
                deviations.append(abs(dist - r))

            max_dev = max(deviations) if deviations else float("inf")

            if max_dev < best_dev:
                best_dev = max_dev
                best_result = SurfaceFitResult(
                    surface_type="cylinder",
                    coefficients=[
                        float(center[0]),
                        float(center[1]),
                        float(center[2]),
                        float(axis_vec[0]),
                        float(axis_vec[1]),
                        float(axis_vec[2]),
                        float(r),
                    ],
                    max_deviation=max_dev,
                    center=center,
                    axis=[float(a) for a in axis_vec],
                    radius=float(r),
                )
        except Exception:
            continue

    return best_result


def fit_general_cylinder(points: list[list[float]]) -> SurfaceFitResult | None:
    """Alias for fit_cylinder; returns general cylinder type."""
    result = fit_cylinder(points)
    if result is None:
        return None
    # The existing fit_cylinder already computes general axis; keep type as 'cylinder'
    result.surface_type = "cylinder"
    return result


# ---------------------------------------------------------------------------
# Cone
# ---------------------------------------------------------------------------


def fit_cone(points: list[list[float]]) -> SurfaceFitResult | None:
    """Fit a right circular cone.

    Returns x-cone, y-cone, or z-cone when axis-aligned,
    otherwise None (OpenMC has no general cone).
    """
    if len(points) < 8 or not HAS_NUMPY:
        return None

    points_arr = np.array(points)
    centroid = np.mean(points_arr, axis=0)
    centered = points_arr - centroid
    cov = np.dot(centered.T, centered) / len(points)
    eigenvalues, eigenvectors = np.linalg.eigh(cov)

    # Candidate axes: all three eigenvectors + coordinate axes
    candidates = []
    for i in range(3):
        v = eigenvectors[:, i]
        candidates.append(normalize_vector(v.tolist() if hasattr(v, "tolist") else list(v)))
    for coord in [[1, 0, 0], [0, 1, 0], [0, 0, 1]]:
        candidates.append(coord)

    best_result = None
    best_dev = float("inf")

    for axis_vec in candidates:
        # Build local coordinates: w along axis, u,v perpendicular
        w = np.array(axis_vec)
        u = np.cross(w, [1.0, 0.0, 0.0])
        if np.linalg.norm(u) < 0.1:
            u = np.cross(w, [0.0, 1.0, 0.0])
        u = normalize_vector(u.tolist() if hasattr(u, "tolist") else list(u))
        v = normalize_vector(
            (np.cross(w, u)).tolist() if hasattr(np.cross(w, u), "tolist") else list(np.cross(w, u))
        )
        u = np.array(u)
        v = np.array(v)

        # Project points into (h, ru, rv) where h is along axis, ru,rv perpendicular
        h_vals = []
        r_vals = []
        for p in centered:
            h = float(np.dot(p, w))
            ru = float(np.dot(p, u))
            rv = float(np.dot(p, v))
            r = math.sqrt(ru**2 + rv**2)
            h_vals.append(h)
            r_vals.append(r)

        h_vals = np.array(h_vals)
        r_vals = np.array(r_vals)

        # Cone relation: r = |k| * |h - h0|  where k = tan(alpha), h0 = apex position
        # For points on one nappe (all h on same side of h0), this is linear:
        # r = |k| * h - |k| * h0   (if h > h0)
        # Fit r = a * h + b  using linear least squares
        A = np.column_stack([h_vals, np.ones(len(h_vals))])
        try:
            sol = np.linalg.lstsq(A, r_vals, rcond=None)[0]
            a, b = float(sol[0]), float(sol[1])
        except Exception:
            continue

        if abs(a) < 1e-6:
            continue

        k = abs(a)
        h0 = -b / a

        # Compute predicted r and deviations
        pred_r = k * np.abs(h_vals - h0)
        devs = np.abs(r_vals - pred_r)
        max_dev = float(np.max(devs))

        if max_dev < best_dev:
            best_dev = max_dev
            apex = centroid + h0 * w
            apex = apex.tolist()
            r2 = k**2  # tan^2(alpha)

            aligned = is_axis_aligned(axis_vec, tol=0.05)
            if aligned == "x":
                surf_type = "x-cone"
            elif aligned == "y":
                surf_type = "y-cone"
            elif aligned == "z":
                surf_type = "z-cone"
            else:
                continue

            best_result = SurfaceFitResult(
                surface_type=surf_type,
                coefficients=[float(apex[0]), float(apex[1]), float(apex[2]), float(r2)],
                max_deviation=max_dev,
                center=apex,
                axis=[float(a) for a in axis_vec],
                metadata={"r2": float(r2), "half_angle_rad": math.atan(k)},
            )

    return best_result


# ---------------------------------------------------------------------------
# Torus
# ---------------------------------------------------------------------------


def fit_torus(points: list[list[float]]) -> SurfaceFitResult | None:
    """Fit a torus and map to x-torus, y-torus, or z-torus.

    Torus equation in local coords (axis = z):
    (sqrt(x^2 + y^2) - R)^2 + z^2 = r^2
    """
    if len(points) < 10 or not HAS_NUMPY:
        return None

    points_arr = np.array(points)
    centroid = np.mean(points_arr, axis=0)
    centered = points_arr - centroid
    cov = np.dot(centered.T, centered) / len(points)
    eigenvalues, eigenvectors = np.linalg.eigh(cov)

    # Axis is the direction of smallest variance for a torus
    axis = eigenvectors[:, 0]
    axis = normalize_vector(axis.tolist() if hasattr(axis, "tolist") else list(axis))

    w = np.array(axis)
    u = np.cross(w, [1.0, 0.0, 0.0])
    if np.linalg.norm(u) < 0.1:
        u = np.cross(w, [0.0, 1.0, 0.0])
    u = normalize_vector(u.tolist())
    v = normalize_vector(np.cross(w, u).tolist())
    u = np.array(u)
    v = np.array(v)

    # Project onto perpendicular plane
    pu_vals = []
    pv_vals = []
    h_vals = []
    for p in centered:
        pu = float(np.dot(p, u))
        pv = float(np.dot(p, v))
        ph = float(np.dot(p, w))
        pu_vals.append(pu)
        pv_vals.append(pv)
        h_vals.append(ph)

    pu_arr = np.array(pu_vals)
    pv_arr = np.array(pv_vals)
    h_arr = np.array(h_vals)

    # Fit circle in (pu, pv) plane: pu^2 + pv^2 + D*pu + E*pv + F = 0
    A_circle = np.column_stack([pu_arr, pv_arr, np.ones(len(pu_arr))])
    b_circle = -(pu_arr**2 + pv_arr**2)

    try:
        sol_circle = np.linalg.lstsq(A_circle, b_circle, rcond=None)[0]
        D, E, F = float(sol_circle[0]), float(sol_circle[1]), float(sol_circle[2])
        cx_plane = -D / 2.0
        cy_plane = -E / 2.0
        R = math.sqrt(cx_plane**2 + cy_plane**2 - F)

        if R <= 0 or math.isnan(R):
            return None

        # Center in 3D
        center = centroid + cx_plane * np.array(u) + cy_plane * np.array(v)
        center = center.tolist()

        # Compute minor radius r from 3D distances to major circle
        # s = d_perp^2 + h^2 where d_perp is distance from axis in perp plane
        # s should be linear in d_perp: s = 2*R*d_perp + (r^2 - R^2)
        d_perp_vals = np.sqrt((pu_arr - cx_plane) ** 2 + (pv_arr - cy_plane) ** 2)
        s_vals = d_perp_vals**2 + h_arr**2

        # Fit s = a * d_perp + b
        A_r = np.column_stack([d_perp_vals, np.ones(len(d_perp_vals))])
        sol_r = np.linalg.lstsq(A_r, s_vals, rcond=None)[0]
        a, b = float(sol_r[0]), float(sol_r[1])
        R_fit = a / 2.0
        r_minor_sq = b + R_fit**2
        if r_minor_sq <= 0:
            return None
        r_minor = math.sqrt(r_minor_sq)

        # Compute deviations
        deviations = []
        for i in range(len(points_arr)):
            p = points_arr[i] - np.array(center)
            h = float(np.dot(p, w))
            pu_i = float(np.dot(p, u))
            pv_i = float(np.dot(p, v))
            d_perp = math.sqrt((pu_i) ** 2 + (pv_i) ** 2)
            pred = math.sqrt((d_perp - R_fit) ** 2 + h**2)
            deviations.append(abs(pred - r_minor))

        max_dev = max(deviations) if deviations else float("inf")

        aligned = is_axis_aligned(axis, tol=0.05)
        if aligned == "x":
            surf_type = "x-torus"
        elif aligned == "y":
            surf_type = "y-torus"
        elif aligned == "z":
            surf_type = "z-torus"
        else:
            # OpenMC doesn't support general torus
            return None

        return SurfaceFitResult(
            surface_type=surf_type,
            coefficients=[
                float(center[0]),
                float(center[1]),
                float(center[2]),
                float(R_fit),
                float(r_minor),
                0.0,
            ],
            max_deviation=max_dev,
            center=center,
            axis=[float(a) for a in axis],
            radius=float(R_fit),
            metadata={"major_radius": float(R_fit), "minor_radius": float(r_minor)},
        )
    except Exception:
        return None


# ---------------------------------------------------------------------------
# General Quadric
# ---------------------------------------------------------------------------


def fit_quadric(points: list[list[float]]) -> SurfaceFitResult | None:
    """Fit a general quadric surface: ax^2 + by^2 + cz^2 + dxy + exz + fyz + gx + hy + iz + j = 0.

    Coefficients returned as [a, b, c, d, e, f, g, h, i, j].
    """
    if len(points) < 10 or not HAS_NUMPY:
        return None

    points_arr = np.array(points)
    x = points_arr[:, 0]
    y = points_arr[:, 1]
    z = points_arr[:, 2]

    # Build design matrix for homogeneous least squares
    M = np.column_stack([x**2, y**2, z**2, x * y, x * z, y * z, x, y, z, np.ones(len(x))])

    try:
        # SVD to find null-space / smallest singular value solution
        _, s, Vt = np.linalg.svd(M, full_matrices=False)
        coeffs = Vt[-1, :]

        # Normalize so that largest coefficient is 1.0 for stability
        max_c = np.max(np.abs(coeffs))
        if max_c > 1e-10:
            coeffs = coeffs / max_c

        coeffs_list = [float(c) for c in coeffs]

        # Compute deviation: evaluate quadric equation at each point
        deviations = []
        for p in points:
            val = (
                coeffs_list[0] * p[0] ** 2
                + coeffs_list[1] * p[1] ** 2
                + coeffs_list[2] * p[2] ** 2
                + coeffs_list[3] * p[0] * p[1]
                + coeffs_list[4] * p[0] * p[2]
                + coeffs_list[5] * p[1] * p[2]
                + coeffs_list[6] * p[0]
                + coeffs_list[7] * p[1]
                + coeffs_list[8] * p[2]
                + coeffs_list[9]
            )
            # Normalize by gradient magnitude for geometric distance approx
            grad = np.array(
                [
                    2 * coeffs_list[0] * p[0]
                    + coeffs_list[3] * p[1]
                    + coeffs_list[4] * p[2]
                    + coeffs_list[6],
                    2 * coeffs_list[1] * p[1]
                    + coeffs_list[3] * p[0]
                    + coeffs_list[5] * p[2]
                    + coeffs_list[7],
                    2 * coeffs_list[2] * p[2]
                    + coeffs_list[4] * p[0]
                    + coeffs_list[5] * p[1]
                    + coeffs_list[8],
                ]
            )
            grad_norm = np.linalg.norm(grad)
            if grad_norm > 1e-10:
                deviations.append(abs(float(val)) / float(grad_norm))
            else:
                deviations.append(abs(float(val)))

        max_dev = max(deviations) if deviations else float("inf")

        return SurfaceFitResult(
            surface_type="quadric",
            coefficients=coeffs_list,
            max_deviation=max_dev,
            metadata={"singular_value": float(s[-1])},
        )
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Classification dispatcher
# ---------------------------------------------------------------------------


def classify_and_fit(
    points: list[list[float]], gmsh_surface_type: str = "Unknown", tolerance: float = 0.001
) -> SurfaceFitResult | None:
    """Try to fit the best analytic surface to a set of points.

    If gmsh already tells us the surface type, we try that first.
    Otherwise we try plane -> sphere -> cylinder -> cone -> torus -> quadric.
    """
    if len(points) < 3:
        return None

    # If gmsh gives us a strong hint, try that specific fit first with looser tolerance
    type_order = []
    st = gmsh_surface_type.lower()
    if st == "plane":
        type_order = ["plane"]
    elif st == "sphere":
        type_order = ["sphere", "plane"]
    elif st == "cylinder":
        type_order = ["cylinder", "plane"]
    elif st == "cone":
        type_order = ["cone", "cylinder", "plane"]
    elif st == "torus":
        type_order = ["torus", "cylinder", "sphere", "plane"]
    else:
        type_order = ["plane", "sphere", "cylinder", "cone", "torus"]

    fitters = {
        "plane": fit_plane,
        "sphere": fit_sphere,
        "cylinder": fit_cylinder,
        "cone": fit_cone,
        "torus": fit_torus,
    }

    best = None

    for t in type_order:
        fitter = fitters.get(t)
        if fitter is None:
            continue
        result = fitter(points)
        if result is None:
            continue
        # For cones/torus, if axis not aligned, result is None already
        if result.max_deviation < tolerance:
            return result
        if best is None or result.max_deviation < best.max_deviation:
            best = result

    # If no good fit, try quadric as last resort
    quad = fit_quadric(points)
    if quad is not None and quad.max_deviation < tolerance * 2:
        return quad

    # Fallback: best analytic fit with a warning
    if best is not None:
        best.warning = (
            f"Non-{best.surface_type} surface approximated as {best.surface_type} "
            f"(deviation: {best.max_deviation:.6f})"
        )
        return best

    return None
