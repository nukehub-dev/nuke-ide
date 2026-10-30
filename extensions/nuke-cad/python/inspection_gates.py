"""Pre-export validation gates for nuke-cad.

Runs mass-property sanity checks (volume/COM/inertia) and mesh-vs-CAD
deviation checks as an overlap/gap detector before DAGMC export. Every gate
reports **warnings only** — gates never raise and never flip an export result
to failure; existing callers are unaffected.

The module stays importable in the minimal pytest profile (``pytest`` +
``numpy`` only). All OCP imports are function-local and guarded; the pure
helpers (:func:`check_mass_properties`, :func:`check_mesh_vs_cad`) need only
the standard library (+ numpy for the mesh-volume integration when available,
with a pure-python fallback).
"""

from __future__ import annotations

import math
from typing import Any

try:
    import numpy as np

    HAS_NUMPY = True
except ImportError:
    np = None  # type: ignore
    HAS_NUMPY = False

#: Relative mesh-vs-CAD volume deviation above which a volume is flagged as a
#: possible overlap/gap (or an under-resolved facet mesh).
DEFAULT_MESH_DEVIATION_TOL = 0.05

#: Absolute tolerance (model units) for the center-of-mass-inside-bbox check.
DEFAULT_COM_TOL = 1e-6


def _is_finite_number(value: Any) -> bool:
    """Return True for a finite real number (bools excluded)."""
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def check_mass_properties(entries: list[dict[str, Any]]) -> list[str]:
    """Sanity-check per-solid mass-property dicts; return warning strings.

    Each entry is expected to carry ``volume``, ``area``, ``bbox`` (``min`` /
    ``max`` triples) and ``centerOfMass`` (triple), matching the tessellation
    ``properties`` payload produced by ``geometry_service._solid_properties``.
    Missing keys are skipped (the property is best-effort); present-but-insane
    values produce one warning per solid per failed check.
    """
    warnings: list[str] = []
    try:
        items = list(enumerate(entries or []))
    except Exception:
        return []
    for position, entry in items:
        if not isinstance(entry, dict):
            continue
        solid_id = entry.get("solidId", position + 1)
        volume = entry.get("volume")
        if volume is not None:
            if not _is_finite_number(volume):
                warnings.append(f"Solid {solid_id} has a non-finite volume ({volume})")
            elif float(volume) <= 0.0:
                warnings.append(f"Solid {solid_id} has a non-positive volume ({volume})")
        area = entry.get("area")
        if area is not None:
            if not _is_finite_number(area):
                warnings.append(f"Solid {solid_id} has a non-finite surface area ({area})")
            elif float(area) <= 0.0:
                warnings.append(f"Solid {solid_id} has a non-positive surface area ({area})")
        bbox = entry.get("bbox")
        com = entry.get("centerOfMass")
        if isinstance(bbox, dict) and isinstance(com, (list, tuple)) and len(com) == 3:
            bmin = bbox.get("min")
            bmax = bbox.get("max")
            if (
                isinstance(bmin, (list, tuple))
                and isinstance(bmax, (list, tuple))
                and len(bmin) == 3
                and len(bmax) == 3
                and all(_is_finite_number(v) for v in (*bmin, *bmax))
            ):
                degenerate = any(float(bmax[i]) < float(bmin[i]) for i in range(3))
                if degenerate:
                    warnings.append(f"Solid {solid_id} has a degenerate bounding box")
                elif all(_is_finite_number(v) for v in com):
                    outside = any(
                        float(com[i]) < float(bmin[i]) - DEFAULT_COM_TOL
                        or float(com[i]) > float(bmax[i]) + DEFAULT_COM_TOL
                        for i in range(3)
                    )
                    if outside:
                        warnings.append(
                            f"Solid {solid_id} center of mass lies outside its bounding box"
                        )
                else:
                    warnings.append(
                        f"Solid {solid_id} has a non-finite center of mass ({list(com)})"
                    )
    return warnings


def solid_mass_report(shape: Any) -> list[dict[str, Any]]:
    """Compute per-solid mass-property dicts for an OCP shape.

    Returns ``[]`` when OCP is unavailable or a solid cannot be measured (the
    gate is best-effort). Never raises.
    """
    try:
        from OCP.Bnd import Bnd_Box
        from OCP.BRepBndLib import BRepBndLib
        from OCP.BRepGProp import BRepGProp
        from OCP.GProp import GProp_GProps
        from OCP.TopAbs import TopAbs_SOLID
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopoDS import TopoDS
        from ocp_compat import brep_bnd_lib_add, topods_solid
    except Exception:
        return []
    entries: list[dict[str, Any]] = []
    try:
        solid_id = 1
        exp = TopExp_Explorer(shape, TopAbs_SOLID)
        while exp.More():
            try:
                solid = topods_solid(TopoDS, exp.Current())
                volume_props = GProp_GProps()
                BRepGProp.VolumeProperties_s(solid, volume_props)
                surface_props = GProp_GProps()
                BRepGProp.SurfaceProperties_s(solid, surface_props)
                box = Bnd_Box()
                box.SetGap(0.0)
                brep_bnd_lib_add(BRepBndLib, solid, box)
                xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
                com = volume_props.CentreOfMass()
                entries.append(
                    {
                        "solidId": solid_id,
                        "volume": float(volume_props.Mass()),
                        "area": float(surface_props.Mass()),
                        "bbox": {
                            "min": [float(xmin), float(ymin), float(zmin)],
                            "max": [float(xmax), float(ymax), float(zmax)],
                        },
                        "centerOfMass": [float(com.X()), float(com.Y()), float(com.Z())],
                    }
                )
            except Exception:
                pass
            solid_id += 1
            exp.Next()
    except Exception:
        return []
    return entries


def check_solid_mass_properties(shape: Any) -> list[str]:
    """OCP-backed mass-property gate for a shape; warnings only, never raises."""
    try:
        return check_mass_properties(solid_mass_report(shape))
    except Exception as exc:
        return [f"Mass-property gate skipped: {exc}"]


def mesh_enclosed_volume(vertices: Any, triangles: Any) -> float:
    """Return the absolute enclosed volume of a closed triangle soup.

    Uses the divergence theorem (``V = sum(v0 . (v1 x v2)) / 6``). Accepts
    numpy arrays or plain nested sequences; falls back to pure python without
    numpy. Returns ``0.0`` for empty input. Never raises on well-formed input.
    """
    if triangles is None or len(triangles) == 0:
        return 0.0
    if HAS_NUMPY and np is not None:
        v = np.asarray(vertices, dtype=np.float64)
        t = np.asarray(triangles, dtype=np.int64)
        v0 = v[t[:, 0]]
        v1 = v[t[:, 1]]
        v2 = v[t[:, 2]]
        return float(abs(np.sum(np.einsum("ij,ij->i", v0, np.cross(v1, v2))) / 6.0))
    total = 0.0
    for tri in triangles:
        ax, ay, az = vertices[tri[0]]
        bx, by, bz = vertices[tri[1]]
        cx, cy, cz = vertices[tri[2]]
        total += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
    return abs(total) / 6.0


def check_mesh_vs_cad(
    cad_volumes: dict[int, float],
    mesh_volumes: dict[int, float],
    rel_tol: float = DEFAULT_MESH_DEVIATION_TOL,
) -> list[str]:
    """Compare per-volume mesh volumes against CAD volumes; return warnings.

    A relative deviation above ``rel_tol`` suggests an overlap/gap introduced
    by imprint/merge (or an under-resolved facet mesh). Volumes missing on
    either side, or with a non-finite/non-positive CAD reference, are skipped
    silently. Never raises.
    """
    warnings: list[str] = []
    try:
        for vol_id, cad_volume in cad_volumes.items():
            mesh_volume = mesh_volumes.get(vol_id)
            if mesh_volume is None:
                continue
            try:
                cad_v = float(cad_volume)
                mesh_v = float(mesh_volume)
            except (TypeError, ValueError):
                continue
            if not (math.isfinite(cad_v) and math.isfinite(mesh_v)) or cad_v <= 0.0:
                continue
            deviation = abs(mesh_v - cad_v) / cad_v
            if deviation > rel_tol:
                warnings.append(
                    f"Volume {vol_id} mesh-vs-CAD deviation {deviation:.1%} "
                    f"(mesh {mesh_v:.4g}, CAD {cad_v:.4g}); "
                    "possible overlap/gap or under-resolved facets"
                )
    except Exception as exc:
        warnings.append(f"Mesh-vs-CAD deviation gate skipped: {exc}")
    return warnings
