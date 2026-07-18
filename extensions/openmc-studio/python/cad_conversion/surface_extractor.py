"""Bridge between gmsh/OCCT geometry and surface fitters.

Extracts exact surface parameters when possible (via OCCT/OCP), otherwise
falls back to parametric sampling + fitting.
"""

import math
from pathlib import Path

from . import gmsh_utils
from .core import SurfaceFitResult, is_axis_aligned
from .surface_fitter import classify_and_fit

# Optional OCP/CadQuery import for exact parameter extraction
try:
    import cadquery as cq
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import (
        GeomAbs_Cone,
        GeomAbs_Cylinder,
        GeomAbs_Plane,
        GeomAbs_Sphere,
        GeomAbs_Torus,
    )
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    HAS_CADQUERY = True
except ImportError:
    HAS_CADQUERY = False


# Cache for OCCT exact parameters per file
_occ_cache: dict[str, list[SurfaceFitResult | None]] = {}


def _load_occ_params(file_path: str) -> list[SurfaceFitResult | None] | None:
    """Load exact surface parameters from OCCT via CadQuery.

    Returns a list indexed by gmsh face tag (1-based) of SurfaceFitResult
    or None for each face.  Returns None if CadQuery is unavailable or
    the file format is not supported.
    """
    if not HAS_CADQUERY:
        return None

    ext = Path(file_path).suffix.lower()
    if ext not in (".step", ".stp", ".brep", ".brp"):
        return None

    try:
        if ext in (".step", ".stp"):
            result = cq.importers.importStep(file_path)
        elif ext in (".brep", ".brp"):
            result = cq.importers.importBrep(file_path)
        else:
            return None

        compound = result.val().wrapped
        explorer = TopExp_Explorer(compound, TopAbs_FACE)

        params: list[SurfaceFitResult | None] = [None]  # index 0 unused

        while explorer.More():
            face = TopoDS.Face_s(explorer.Current())
            surf = BRepAdaptor_Surface(face)
            stype = surf.GetType()
            result_param = _occ_surface_to_fit_result(surf, stype)
            params.append(result_param)
            explorer.Next()

        return params

    except Exception:
        return None


def _occ_surface_to_fit_result(surf, stype: int) -> SurfaceFitResult | None:
    """Convert an OCCT BRepAdaptor_Surface to a SurfaceFitResult."""

    if stype == GeomAbs_Plane:
        pln = surf.Plane()
        loc = pln.Location()
        norm = pln.Axis().Direction()
        a, b, c = norm.X(), norm.Y(), norm.Z()
        d = a * loc.X() + b * loc.Y() + c * loc.Z()
        # Ensure consistent normal orientation
        if (
            a < -1e-6
            or (abs(a) < 1e-6 and b < -1e-6)
            or (abs(a) < 1e-6 and abs(b) < 1e-6 and c < -1e-6)
        ):
            a, b, c, d = -a, -b, -c, -d
        return SurfaceFitResult(
            surface_type="plane",
            coefficients=[a, b, c, d],
            max_deviation=0.0,
            center=[loc.X(), loc.Y(), loc.Z()],
            axis=[norm.X(), norm.Y(), norm.Z()],
        )

    elif stype == GeomAbs_Cylinder:
        cyl = surf.Cylinder()
        axis = cyl.Axis()
        center = [axis.Location().X(), axis.Location().Y(), axis.Location().Z()]
        axis_dir = [axis.Direction().X(), axis.Direction().Y(), axis.Direction().Z()]
        r = cyl.Radius()
        coeffs = center + axis_dir + [r]
        aligned = is_axis_aligned(axis_dir, tol=0.05)
        if aligned == "x":
            surf_type = "x-cylinder"
        elif aligned == "y":
            surf_type = "y-cylinder"
        elif aligned == "z":
            surf_type = "z-cylinder"
        else:
            surf_type = "cylinder"
        return SurfaceFitResult(
            surface_type=surf_type,
            coefficients=coeffs,
            max_deviation=0.0,
            center=center,
            axis=axis_dir,
            radius=r,
        )

    elif stype == GeomAbs_Cone:
        cone = surf.Cone()
        axis = cone.Axis()
        apex = [axis.Location().X(), axis.Location().Y(), axis.Location().Z()]
        axis_dir = [axis.Direction().X(), axis.Direction().Y(), axis.Direction().Z()]
        # OpenMC cone: r2 = tan^2(semi-angle)
        # OCCT semi-angle is returned in radians
        semi_angle = cone.SemiAngle()
        r2 = math.tan(semi_angle) ** 2
        aligned = is_axis_aligned(axis_dir, tol=0.05)
        if aligned == "x":
            surf_type = "x-cone"
        elif aligned == "y":
            surf_type = "y-cone"
        elif aligned == "z":
            surf_type = "z-cone"
        else:
            # OpenMC does not support general cones
            return None
        return SurfaceFitResult(
            surface_type=surf_type,
            coefficients=apex + [r2],
            max_deviation=0.0,
            center=apex,
            axis=axis_dir,
            metadata={"r2": r2, "half_angle_rad": semi_angle},
        )

    elif stype == GeomAbs_Sphere:
        sph = surf.Sphere()
        center = [sph.Location().X(), sph.Location().Y(), sph.Location().Z()]
        r = sph.Radius()
        return SurfaceFitResult(
            surface_type="sphere",
            coefficients=center + [r],
            max_deviation=0.0,
            center=center,
            radius=r,
        )

    elif stype == GeomAbs_Torus:
        tor = surf.Torus()
        axis = tor.Axis()
        center = [axis.Location().X(), axis.Location().Y(), axis.Location().Z()]
        axis_dir = [axis.Direction().X(), axis.Direction().Y(), axis.Direction().Z()]
        major_r = tor.MajorRadius()
        minor_r = tor.MinorRadius()
        aligned = is_axis_aligned(axis_dir, tol=0.05)
        if aligned == "x":
            surf_type = "x-torus"
        elif aligned == "y":
            surf_type = "y-torus"
        elif aligned == "z":
            surf_type = "z-torus"
        else:
            return None
        # OpenMC torus coeffs: [x0, y0, z0, a, b, c]
        # where a=major, b=minor, c=0 (not used)
        return SurfaceFitResult(
            surface_type=surf_type,
            coefficients=center + [major_r, minor_r, 0.0],
            max_deviation=0.0,
            center=center,
            axis=axis_dir,
            radius=major_r,
            metadata={"major_radius": major_r, "minor_radius": minor_r},
        )

    else:
        # NURBS, Bezier, Revolution, etc. - cannot extract exact CSG params
        return None


def _get_file_path_from_gmsh() -> str | None:
    """Get the currently open file path from gmsh."""
    if not gmsh_utils.HAS_GMSH:
        return None
    try:
        # gmsh does not expose current file path directly
        # We can try model name
        return None
    except Exception:
        return None


def extract_surface_from_entity(
    dim: int,
    tag: int,
    tolerance: float = 0.001,
    unit_factor: float = 1.0,
    file_path: str | None = None,
) -> SurfaceFitResult | None:
    """Extract surface parameters for a single 2D face entity.

    Returns a SurfaceFitResult with coefficients scaled by unit_factor.
    """
    # ------------------------------------------------------------------
    # Try OCCT exact extraction first
    # ------------------------------------------------------------------
    if HAS_CADQUERY and file_path is not None:
        cache_key = file_path
        if cache_key not in _occ_cache:
            _occ_cache[cache_key] = _load_occ_params(file_path)

        occ_params = _occ_cache.get(cache_key)
        if occ_params is not None and 0 < tag < len(occ_params):
            occ_result = occ_params[tag]
            if occ_result is not None:
                result = SurfaceFitResult(
                    surface_type=occ_result.surface_type,
                    coefficients=list(occ_result.coefficients),
                    max_deviation=occ_result.max_deviation,
                    center=list(occ_result.center) if occ_result.center else None,
                    axis=list(occ_result.axis) if occ_result.axis else None,
                    radius=occ_result.radius,
                    metadata=dict(occ_result.metadata) if occ_result.metadata else {},
                )
                _apply_scale(result, unit_factor)
                return result

    # ------------------------------------------------------------------
    # Fall back to sampling + fitting
    # ------------------------------------------------------------------
    gmsh_type = gmsh_utils.classify_gmsh_surface_type(dim, tag)
    points, _ = gmsh_utils.get_surface_points(dim, tag, tolerance)
    if len(points) < 3:
        return None

    result = classify_and_fit(points, gmsh_surface_type=gmsh_type, tolerance=tolerance)
    if result is not None:
        _apply_scale(result, unit_factor)
    return result


def _apply_scale(result: SurfaceFitResult, unit_factor: float) -> None:
    """Scale geometric coefficients by unit_factor in-place."""
    if unit_factor == 1.0:
        return

    c = result.coefficients
    t = result.surface_type

    if t == "plane":
        result.coefficients = [c[0], c[1], c[2], c[3] * unit_factor]
    elif t == "sphere":
        result.coefficients = [
            c[0] * unit_factor,
            c[1] * unit_factor,
            c[2] * unit_factor,
            c[3] * unit_factor,
        ]
    elif t == "cylinder":
        result.coefficients = [
            c[0] * unit_factor,
            c[1] * unit_factor,
            c[2] * unit_factor,
            c[3],
            c[4],
            c[5],
            c[6] * unit_factor,
        ]
    elif t in ("x-cylinder", "y-cylinder", "z-cylinder"):
        result.coefficients = [
            c[0] * unit_factor,
            c[1] * unit_factor,
            c[2] * unit_factor,
            c[3],
            c[4],
            c[5],
            c[6] * unit_factor,
        ]
    elif t in ("x-cone", "y-cone", "z-cone"):
        result.coefficients = [c[0] * unit_factor, c[1] * unit_factor, c[2] * unit_factor, c[3]]
    elif t in ("x-torus", "y-torus", "z-torus"):
        result.coefficients = [
            c[0] * unit_factor,
            c[1] * unit_factor,
            c[2] * unit_factor,
            c[3] * unit_factor,
            c[4] * unit_factor,
            c[5] * unit_factor,
        ]
    elif t == "quadric":
        s = unit_factor
        result.coefficients = [
            c[0],
            c[1],
            c[2],
            c[3],
            c[4],
            c[5],
            c[6] / s,
            c[7] / s,
            c[8] / s,
            c[9] / (s**2),
        ]

    if result.center is not None:
        result.center = [result.center[i] * unit_factor for i in range(3)]
    if result.radius is not None:
        result.radius *= unit_factor


def extract_all_surfaces(
    solid_dim: int,
    solid_tag: int,
    tolerance: float = 0.001,
    unit_factor: float = 1.0,
    file_path: str | None = None,
) -> list[tuple[int, str, SurfaceFitResult]]:
    """Extract all bounding surfaces of a solid.

    Returns list of (signed_tag, orientation, SurfaceFitResult).
    Orientation is '+' or '-' for the half-space sign.
    """
    results: list[tuple[int, str, SurfaceFitResult]] = []
    boundary = gmsh_utils.get_boundary((solid_dim, solid_tag), oriented=True, recursive=False)

    for surf_dim, signed_tag in boundary:
        if surf_dim != 2:
            continue
        surf_tag = abs(signed_tag)
        orientation = "-" if signed_tag > 0 else "+"  # gmsh sign convention

        result = extract_surface_from_entity(surf_dim, surf_tag, tolerance, unit_factor, file_path)
        if result is not None:
            results.append((signed_tag, orientation, result))

    return results
