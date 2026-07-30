"""Compatibility shims for cadquery-ocp vs conda-forge OCP API differences.

cadquery-ocp (the PyPI wheel) exposes many static OpenCASCADE methods with a
``_s`` suffix (e.g. ``TopoDS.Solid_s``), while the conda-forge ``ocp`` package
exposes the same methods without the suffix (e.g. ``TopoDS.Solid``). This
module hides the difference so the CAD conversion code works with either
installation.
"""

from collections.abc import Callable
from typing import Any


def _resolve(klass: Any, base_name: str) -> Callable:
    """Return the callable for an OCP static/downcast method.

    Prefers the cadquery-ocp ``_s`` variant and falls back to the conda-forge
    name when the suffix variant is absent.
    """
    suffixed = f"{base_name}_s"
    if hasattr(klass, suffixed):
        return getattr(klass, suffixed)
    return getattr(klass, base_name)


def topods_solid(topods_class: Any, shape: Any) -> Any:
    """Downcast a TopoDS_Shape to a TopoDS_Solid."""
    return _resolve(topods_class, "Solid")(shape)


def topods_face(topods_class: Any, shape: Any) -> Any:
    """Downcast a TopoDS_Shape to a TopoDS_Face."""
    return _resolve(topods_class, "Face")(shape)


def brep_tool_triangulation(brep_tool_class: Any, face: Any, loc: Any) -> Any:
    """Return the triangulation for a face (with location)."""
    return _resolve(brep_tool_class, "Triangulation")(face, loc)


def brep_bnd_lib_add(brep_bnd_lib_class: Any, shape: Any, bbox: Any) -> None:
    """Add a shape's bounding box to a Bnd_Box."""
    return _resolve(brep_bnd_lib_class, "Add")(shape, bbox)
