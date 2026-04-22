"""CAD Conversion Package for OpenMC Studio.

Provides CAD-to-CSG and CAD-to-DAGMC conversion utilities.
"""

__version__ = "1.0.0"

from .core import SurfaceFitResult, TopologyInfo, normalize_vector, distance_point_to_line
from .surface_fitter import (
    fit_plane, fit_sphere, fit_cylinder, fit_cone,
    fit_torus, fit_general_cylinder, fit_quadric, classify_and_fit
)
from .surface_extractor import extract_all_surfaces, extract_surface_from_entity
from .nurbs_handler import has_nurbs_surfaces, convert_to_dagmc, get_nurbs_summary
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
