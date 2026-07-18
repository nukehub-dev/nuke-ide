"""CAD Conversion Package for OpenMC Studio.

Provides CAD-to-CSG and CAD-to-DAGMC conversion utilities.
"""

__version__ = "1.0.0"

from .core import SurfaceFitResult, TopologyInfo, distance_point_to_line, normalize_vector
from .nurbs_handler import convert_to_dagmc, get_nurbs_summary, has_nurbs_surfaces
from .surface_extractor import extract_all_surfaces, extract_surface_from_entity
from .surface_fitter import (
    classify_and_fit,
    fit_cone,
    fit_cylinder,
    fit_general_cylinder,
    fit_plane,
    fit_quadric,
    fit_sphere,
    fit_torus,
)
from .topology import analyze_assembly, merge_coplanar_surfaces

__all__ = [
    "SurfaceFitResult",
    "TopologyInfo",
    "normalize_vector",
    "distance_point_to_line",
    "fit_plane",
    "fit_sphere",
    "fit_cylinder",
    "fit_cone",
    "fit_torus",
    "fit_general_cylinder",
    "fit_quadric",
    "classify_and_fit",
    "extract_all_surfaces",
    "extract_surface_from_entity",
    "has_nurbs_surfaces",
    "convert_to_dagmc",
    "get_nurbs_summary",
    "analyze_assembly",
    "merge_coplanar_surfaces",
]
