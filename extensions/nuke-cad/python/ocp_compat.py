"""Compatibility shims for cadquery-ocp vs conda-forge OCP API differences.

Mirrors the helper used by openmc-studio's cad_conversion package so that
nuke-cad works with either the PyPI ``cadquery-ocp`` wheel or the conda-forge
``ocp`` package.
"""

from collections.abc import Callable
from typing import Any


def _resolve(klass: Any, base_name: str) -> Callable:
    """Return the callable for an OCP static/downcast method.

    Prefers the cadquery-ocp ``_s`` suffix variant and falls back to the
    conda-forge name when the suffix variant is absent.
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


def brep_gprop_volume_properties(brep_gprop_class: Any, shape: Any, props: Any) -> None:
    """Compute volume properties of a shape."""
    return _resolve(brep_gprop_class, "VolumeProperties")(shape, props)


def interface_static_set_cval(static_class: Any, key: str, value: str) -> None:
    """Set a string-valued STEP writer static parameter."""
    return _resolve(static_class, "SetCVal")(key, value)


def brep_tools_write(brep_tools_class: Any, shape: Any, file_path: str) -> bool:
    """Write a shape to a BREP file; returns True on success."""
    return bool(_resolve(brep_tools_class, "Write")(shape, file_path))


def brep_tools_read(brep_tools_class: Any, shape: Any, builder: Any, file_path: str) -> bool:
    """Read a BREP file into ``shape`` using ``builder``; returns True on success."""
    return bool(_resolve(brep_tools_class, "Read")(shape, file_path, builder))
