"""Safe gmsh wrappers and CAD traversal utilities."""

from contextlib import contextmanager

try:
    import gmsh

    HAS_GMSH = True
except ImportError:
    HAS_GMSH = False
    gmsh = None  # type: ignore


try:
    import numpy as np

    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False
    np = None  # type: ignore


@contextmanager
def gmsh_session():
    """Context manager for safe gmsh initialize/finalize."""
    if not HAS_GMSH:
        raise RuntimeError("gmsh is not installed")
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        yield gmsh
    finally:
        gmsh.finalize()


def open_model(file_path: str) -> None:
    """Open a CAD file in gmsh."""
    if not HAS_GMSH:
        raise RuntimeError("gmsh is not installed")
    gmsh.open(file_path)


def get_all_entities() -> list[tuple[int, int]]:
    """Return all geometric entities as list of (dim, tag)."""
    if not HAS_GMSH:
        return []
    return gmsh.model.getEntities()


def get_solids() -> list[tuple[int, int]]:
    """Return all 3D solid entities."""
    return [(d, t) for d, t in get_all_entities() if d == 3]


def get_faces() -> list[tuple[int, int]]:
    """Return all 2D face entities."""
    return [(d, t) for d, t in get_all_entities() if d == 2]


def get_edges() -> list[tuple[int, int]]:
    """Return all 1D edge entities."""
    return [(d, t) for d, t in get_all_entities() if d == 1]


def get_bounding_box(
    dim: int = -1, tag: int = -1
) -> tuple[float, float, float, float, float, float]:
    """Return (xmin, ymin, zmin, xmax, ymax, zmax)."""
    if not HAS_GMSH:
        return (0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    return gmsh.model.getBoundingBox(dim, tag)


def get_boundary(
    dimtag: tuple[int, int], oriented: bool = True, recursive: bool = False
) -> list[tuple[int, int]]:
    """Get boundary entities of a geometric entity."""
    if not HAS_GMSH:
        return []
    return gmsh.model.getBoundary([dimtag], oriented=oriented, recursive=recursive)


def get_surface_type(dim: int, tag: int) -> str:
    """Return gmsh surface type string (e.g. 'Plane', 'Cylinder', 'Sphere', ...)."""
    if not HAS_GMSH:
        return "Unknown"
    try:
        return gmsh.model.getType(dim, tag)
    except Exception:
        return "Unknown"


def sample_surface_parametric(dim: int, tag: int, num_samples: int = 15) -> list[list[float]]:
    """Sample points on a surface using parametric coordinates.

    Returns list of [x, y, z] points.
    """
    points: list[list[float]] = []
    if not HAS_GMSH:
        return points

    try:
        param_bounds = gmsh.model.getParametrizationBounds(dim, tag)
        if not param_bounds or len(param_bounds) < 2:
            return points

        u_min, u_max = float(param_bounds[0][0]), float(param_bounds[0][1])
        v_min, v_max = float(param_bounds[1][0]), float(param_bounds[1][1])

        for i in range(num_samples):
            for j in range(num_samples):
                u = u_min + (u_max - u_min) * i / max(num_samples - 1, 1)
                v = v_min + (v_max - v_min) * j / max(num_samples - 1, 1)
                try:
                    coord = gmsh.model.getValue(dim, tag, [u, v])
                    if coord is not None and hasattr(coord, "__len__") and len(coord) == 3:
                        points.append([float(coord[0]), float(coord[1]), float(coord[2])])
                except Exception:
                    pass

        # Denser center sampling if too few points
        if 0 < len(points) < 9:
            for i in range(5):
                for j in range(5):
                    u = u_min + (u_max - u_min) * (0.3 + 0.4 * i / 4)
                    v = v_min + (v_max - v_min) * (0.3 + 0.4 * j / 4)
                    try:
                        coord = gmsh.model.getValue(dim, tag, [u, v])
                        if coord is not None and hasattr(coord, "__len__") and len(coord) == 3:
                            pt = [float(coord[0]), float(coord[1]), float(coord[2])]
                            if not _has_nearby_point(pt, points, tol=1e-6):
                                points.append(pt)
                    except Exception:
                        pass
    except Exception:
        pass

    return points


def sample_surface_from_curves(
    dim: int, tag: int, samples_per_curve: int = 10
) -> list[list[float]]:
    """Sample points from a surface's boundary curves."""
    points: list[list[float]] = []
    if not HAS_GMSH:
        return points

    try:
        boundary = gmsh.model.getBoundary([(dim, tag)], oriented=False, recursive=False)
        for curve_dim, curve_tag in boundary:
            if curve_dim != 1:
                continue
            try:
                param_bounds = gmsh.model.getParametrizationBounds(curve_dim, curve_tag)
                if not param_bounds or len(param_bounds) < 1:
                    continue
                t_min, t_max = float(param_bounds[0][0]), float(param_bounds[0][1])
                for i in range(samples_per_curve):
                    t = t_min + (t_max - t_min) * i / max(samples_per_curve - 1, 1)
                    try:
                        coord = gmsh.model.getValue(curve_dim, curve_tag, [t])
                        if coord is not None and hasattr(coord, "__len__") and len(coord) == 3:
                            pt = [float(coord[0]), float(coord[1]), float(coord[2])]
                            if not _has_nearby_point(pt, points, tol=1e-6):
                                points.append(pt)
                    except Exception:
                        pass
            except Exception:
                pass
    except Exception:
        pass

    return points


def _has_nearby_point(pt: list[float], points: list[list[float]], tol: float = 1e-6) -> bool:
    """Check if a near-duplicate point already exists."""
    for p in points:
        if abs(p[0] - pt[0]) < tol and abs(p[1] - pt[1]) < tol and abs(p[2] - pt[2]) < tol:
            return True
    return False


def classify_gmsh_surface_type(dim: int, tag: int) -> str:
    """Classify surface type from gmsh metadata.

    Returns one of:
        'Plane', 'Cylinder', 'Sphere', 'Cone', 'Torus',
        'BSpline', 'Bezier', 'NURBS', 'SurfaceOfRevolution',
        'Unknown'
    """
    raw = get_surface_type(dim, tag)
    raw_lower = raw.lower()

    # Gmsh typically returns exact strings for analytic surfaces
    if raw_lower in ("plane", "cylinder", "sphere", "cone", "torus"):
        return raw_lower

    # Free-form surfaces
    if "bspline" in raw_lower or "b-spline" in raw_lower:
        return "BSpline"
    if "bezier" in raw_lower:
        return "Bezier"
    if "nurbs" in raw_lower or "spline" in raw_lower:
        return "NURBS"
    if "surface of revolution" in raw_lower:
        return "SurfaceOfRevolution"

    return "Unknown"


def has_freeform_boundary_curves(dim: int, tag: int) -> bool:
    """Check if a surface has any BSpline, Bezier, or NURBS boundary curves."""
    if not HAS_GMSH:
        return False
    try:
        boundary = get_boundary((dim, tag), oriented=False, recursive=False)
        for curve_dim, curve_tag in boundary:
            if curve_dim != 1:
                continue
            ctype = gmsh.model.getType(curve_dim, curve_tag)
            c_lower = ctype.lower()
            if (
                "bspline" in c_lower
                or "bezier" in c_lower
                or "nurbs" in c_lower
                or "spline" in c_lower
            ):
                return True
    except Exception:
        pass
    return False


def is_nurbs_like_surface(dim: int, tag: int) -> bool:
    """Determine if a surface is NURBS-like and cannot be exactly represented in CSG.

    Checks both the surface type and, for surfaces of revolution,
    whether the generating curve is free-form.
    """
    stype = classify_gmsh_surface_type(dim, tag)

    if stype in ("BSpline", "Bezier", "NURBS"):
        return True

    if stype == "SurfaceOfRevolution":
        # Surfaces of revolution with analytic generating curves (line, circle)
        # can sometimes be represented as cones/cylinders/tori. But if the
        # generating curve is free-form, it's effectively a NURBS surface.
        return has_freeform_boundary_curves(dim, tag)

    return False


def get_surface_points(
    dim: int, tag: int, tolerance: float = 0.001
) -> tuple[list[list[float]], str]:
    """Get sampled points and surface type for a face entity.

    Returns (points, surf_type_string).
    """
    surf_type = classify_gmsh_surface_type(dim, tag)
    points = sample_surface_parametric(dim, tag, 15)
    if len(points) < 9:
        curve_points = sample_surface_from_curves(dim, tag)
        for pt in curve_points:
            if not _has_nearby_point(pt, points):
                points.append(pt)
    return points, surf_type
