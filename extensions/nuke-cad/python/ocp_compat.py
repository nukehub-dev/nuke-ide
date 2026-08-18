"""Compatibility shims for the OCP 7.8 vs 7.9 API split.

Mirrors the helper used by openmc-studio's cad_conversion package so that
nuke-cad works with either OCP flavor (conda-forge ``ocp`` or the PyPI
``cadquery-ocp`` wheel, in either version).
"""

import sys
from collections.abc import Callable
from typing import Any


def _resolve(klass: Any, base_name: str) -> Callable:
    """Return the callable for an OCP static/downcast method.

    Prefers the ``_s`` suffix variant (OCP 7.8 naming) and falls back to the
    non-suffixed name (OCP 7.9 removed the ``_s`` statics).
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


# TopoDS downcast statics removed from OCP 7.9 (see ensure_topo_ds_static_aliases).
_TOPO_DS_DOWNCAST_NAMES = (
    "Vertex",
    "Edge",
    "Wire",
    "Face",
    "Shell",
    "Solid",
    "CompSolid",
    "Compound",
)


def _apply_topo_ds_static_aliases(topods_class: Any) -> bool:
    """Re-attach missing ``<X>_s`` downcast aliases on a TopoDS-like class.

    Returns True when at least one alias was (re-)attached.
    """
    applied = False
    for name in _TOPO_DS_DOWNCAST_NAMES:
        suffixed = f"{name}_s"
        if not hasattr(topods_class, suffixed) and hasattr(topods_class, name):
            setattr(topods_class, suffixed, getattr(topods_class, name))
            applied = True
    return applied


def ensure_topo_ds_static_aliases() -> bool:
    """Re-attach the ``TopoDS.TopoDS.<X>_s`` downcast statics removed in OCP 7.9.

    OCP 7.8 (conda-forge ``ocp`` 7.8.x) exposes the downcast statics only
    under the ``_s`` suffix (``TopoDS.TopoDS.Solid_s``); OCP 7.9 (conda-forge
    ``ocp`` 7.9.x and the PyPI ``cadquery-ocp`` 7.9.x wheel) removed the
    ``_s`` variants and keeps only the non-suffixed callables
    (``TopoDS.TopoDS.Solid(shape)``), which still perform the downcast.
    build123d 0.9.x calls the ``_s`` names ~44 times, so it cannot run on
    OCP 7.9 unless the aliases are re-attached.

    This function is idempotent: on OCP 7.8 the aliases already exist and it
    is a no-op. Returns True when OCP was importable (aliases present or
    applied); returns False without raising when OCP is not installed.
    """
    try:
        from OCP import TopoDS
    except ImportError:
        return False
    _apply_topo_ds_static_aliases(TopoDS.TopoDS)
    return True


class _Build123dAliasFinder:
    """One-shot meta-path finder that applies the TopoDS aliases on build123d import.

    Never resolves anything itself (``find_spec`` always returns None); it
    only triggers :func:`ensure_topo_ds_static_aliases` as a side effect and
    then removes itself from ``sys.meta_path``.
    """

    def find_spec(self, fullname: str, path: Any = None, target: Any = None) -> None:
        if fullname != "build123d":
            return None
        ensure_topo_ds_static_aliases()
        try:
            sys.meta_path.remove(self)
        except ValueError:
            pass
        return None


_build123d_hook_installed = False


def install_build123d_import_hook() -> None:
    """Register the one-shot import hook that aliases TopoDS before build123d loads.

    Intended for container images: a site-packages ``.pth`` line
    (``import ocp_compat; ocp_compat.install_build123d_import_hook()``)
    activates the shim so that ``import build123d`` works on OCP 7.9 without
    paying the OCP import cost at every interpreter startup. Idempotent.
    """
    global _build123d_hook_installed
    if _build123d_hook_installed:
        return
    sys.meta_path.insert(0, _Build123dAliasFinder())
    _build123d_hook_installed = True
