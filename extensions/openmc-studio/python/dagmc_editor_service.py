#!/usr/bin/env python3
"""DAGMC Editor Service.

Backend service for DAGMC file editing using pydagmc.
Provides CLI commands to load models, assign materials, and manage
groups within DAGMC .h5m files.
"""

import json
import os
import shutil
import sys
from pathlib import Path

try:
    from pydagmc import Model
except ImportError:
    import site

    for site_path in site.getsitepackages():
        if os.path.exists(os.path.join(site_path, "pydagmc")):
            sys.path.insert(0, site_path)
            break
    from pydagmc import Model

import numpy as np

# Ensure cad_conversion is importable (same dir layout as cad_importer.py)
_SCRIPT_DIR = Path(__file__).parent.resolve()
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from cad_conversion.ocp_compat import (
    brep_tool_triangulation,
    topods_face,
    topods_solid,
)


def _read_faceting_tolerance(model) -> float:
    """Read the FACETING_TOL tag from a pydagmc Model.

    Returns the tolerance value, or 0.001 as a default if not found.
    """
    try:
        import pymoab

        tag = model.faceting_tol_tag
        # Try root set first
        try:
            root = model.mb.get_root_set()
            data = model.mb.tag_get_data(tag, [root])
            if data is not None and len(data) > 0:
                return float(data[0][0])
        except Exception:
            pass
        # Fall back to entity sets
        ents = model.mb.get_entities_by_type_and_tag(0, pymoab.types.MBENTITYSET, [tag], [None])
        for e in ents:
            try:
                data = model.mb.tag_get_data(tag, [e])
                if data is not None and len(data) > 0:
                    return float(data[0][0])
            except Exception:
                pass
    except Exception:
        pass
    return 0.001


def _volume_bounding_box(vol) -> tuple[list[float], list[float]] | tuple[None, None]:
    """Compute the axis-aligned bounding box of a pydagmc Volume.

    Returns (min, max) corner coordinates, or (None, None) if the volume
    has no readable geometry.
    """
    all_coords = []
    for surf in vol.surfaces:
        try:
            conn, coords = surf.get_triangle_conn_and_coords()
            if coords is not None and len(coords) > 0:
                arr = np.asarray(coords)
                if arr.ndim == 2:
                    all_coords.append(arr)
        except Exception:
            continue
    if not all_coords:
        return None, None
    stacked = np.vstack(all_coords)
    return stacked.min(axis=0).tolist(), stacked.max(axis=0).tolist()


def _bbox_contains(
    outer: tuple[list[float], list[float]],
    inner: tuple[list[float], list[float]],
    padding: float = 1e-3,
) -> bool:
    """Check whether ``outer`` bounds fully enclose ``inner`` bounds."""
    omin, omax = outer
    imin, imax = inner
    return (
        omin[0] <= imin[0] + padding
        and omin[1] <= imin[1] + padding
        and omin[2] <= imin[2] + padding
        and omax[0] >= imax[0] - padding
        and omax[1] >= imax[1] - padding
        and omax[2] >= imax[2] - padding
    )


def detect_graveyard(file_path: str) -> dict:
    """Detect whether a DAGMC file has a properly tagged graveyard.

    Three outcomes are distinguished:

    1. A volume is already tagged ``mat:graveyard`` → no action needed.
    2. No graveyard exists and no enclosing candidate is found → the caller
       can safely create a new bounding-box graveyard.
    3. An existing volume encloses the model but is not tagged graveyard →
       the caller may create a new bounding-box graveyard (preferred) or
       re-tag the enclosing volume (destroys its original material).

    Args:
        file_path: Path to the DAGMC .h5m file.

    Returns:
        Dictionary with ``success``, ``needsTag``, ``canCreate``, optional
        ``volumeId`` / ``material``, and model ``bounds`` when creation is
        possible.
    """
    try:
        model = Model(file_path)

        # Already properly tagged?
        for vol in model.volumes:
            if vol.material and vol.material.lower() == "graveyard":
                return {
                    "success": True,
                    "needsTag": False,
                    "canCreate": False,
                    "message": "A graveyard volume is already present.",
                }
        if "mat:graveyard" in model.group_names:
            return {
                "success": True,
                "needsTag": False,
                "canCreate": False,
                "message": "A graveyard group is already present.",
            }

        try:
            mn, mx = _model_bounding_box(model)
            model_bounds = {"min": mn.tolist(), "max": mx.tolist()}
        except Exception:
            model_bounds = None

        bboxes = {}
        for vol in model.volumes:
            mn, mx = _volume_bounding_box(vol)
            if mn is not None:
                bboxes[vol.id] = (mn, mx)

        candidate_id = None
        candidate_material = None
        if len(bboxes) >= 2:
            for outer_id, outer_bbox in bboxes.items():
                if all(
                    _bbox_contains(outer_bbox, bboxes[inner_id])
                    for inner_id in bboxes
                    if inner_id != outer_id
                ):
                    candidate_id = outer_id
                    candidate_material = model.volumes_by_id[outer_id].material
                    break

        if candidate_id is not None:
            return {
                "success": True,
                "needsTag": True,
                "canCreate": True,
                "volumeId": int(candidate_id),
                "material": candidate_material,
                "bounds": model_bounds,
                "suggestedPadding": 0.1,
                "message": (
                    f"Volume {candidate_id} encloses the model but is not tagged as graveyard. "
                    "Tagging it will turn that volume into a particle sink."
                ),
            }

        if model_bounds is None:
            return {
                "success": True,
                "needsTag": False,
                "canCreate": False,
                "message": "Could not read model geometry; a graveyard cannot be created.",
            }

        return {
            "success": True,
            "needsTag": False,
            "canCreate": True,
            "bounds": model_bounds,
            "suggestedPadding": 0.1,
            "message": "No graveyard found. You can create a bounding-box graveyard.",
        }
    except Exception as e:
        import traceback

        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}


def tag_graveyard(file_path: str, volume_id: int | None = None) -> dict:
    """Tag a volume as the DAGMC graveyard.

    If ``volume_id`` is omitted, the enclosing volume is auto-detected.
    The volume's material is set to ``graveyard`` and the file is saved.

    Args:
        file_path: Path to the DAGMC .h5m file.
        volume_id: Optional volume ID to tag. If None, auto-detect.

    Returns:
        Operation result with the tagged volume ID.
    """
    try:
        model = Model(file_path)

        if volume_id is None:
            detect = detect_graveyard(file_path)
            if not detect["success"]:
                return detect
            if not detect.get("needsTag"):
                return {
                    "success": True,
                    "message": detect.get("message", "No graveyard tag needed."),
                }
            volume_id = detect["volumeId"]

        volume = model.volumes_by_id.get(volume_id)
        if volume is None:
            return {"success": False, "error": f"Volume {volume_id} not found"}

        old_material = volume.material
        volume.material = "graveyard"
        model.mb.write_file(file_path)

        return {
            "success": True,
            "volumeId": int(volume_id),
            "oldMaterial": old_material,
            "message": f'Re-tagged existing volume {volume_id} as graveyard (was "{old_material}").',
        }
    except Exception as e:
        import traceback

        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}


def _model_bounding_box(model) -> tuple[np.ndarray, np.ndarray]:
    """Compute the axis-aligned bounding box of all triangles in a model."""
    all_coords = []
    for vol in model.volumes:
        for surf in vol.surfaces:
            try:
                conn, coords = surf.get_triangle_conn_and_coords()
                if coords is not None and len(coords) > 0:
                    arr = np.asarray(coords)
                    if arr.ndim == 2:
                        all_coords.append(arr)
            except Exception:
                continue
    if not all_coords:
        raise ValueError("Model has no readable triangle coordinates")
    stacked = np.vstack(all_coords)
    return stacked.min(axis=0), stacked.max(axis=0)


def create_graveyard_box(
    file_path: str, padding: float = 0.1, output_path: str | None = None
) -> dict:
    """Create a new axis-aligned hollow-shell graveyard volume.

    A proper DAGMC graveyard is a finite-thickness shell around the model: the
    space between an inner box (just outside the model) and an outer box. The
    inner box separates the model world from the graveyard; the outer box
    separates the graveyard from external void. All shell surfaces are oriented
    so the graveyard volume is their forward sense.

    Args:
        file_path: Path to the input DAGMC .h5m file.
        padding: Fraction of the largest model dimension to add as total shell
            thickness. The inner wall is placed at ``padding/2`` and the outer
            wall at ``padding`` beyond the model bbox.
        output_path: Optional output path. Defaults to overwriting ``file_path``.

    Returns:
        Operation result with the created volume ID and bounding box.
    """
    try:
        from pymoab import types

        model = Model(file_path)

        mn, mx = _model_bounding_box(model)
        center = (mn + mx) * 0.5
        size = float((mx - mn).max())
        if size <= 0.0:
            size = 1.0

        # Inner wall just clears the model; outer wall forms the external boundary.
        inner_half = size * (1.0 + padding * 0.5) * 0.5
        outer_half = size * (1.0 + padding) * 0.5
        inner_min = center - inner_half
        inner_max = center + inner_half
        outer_min = center - outer_half
        outer_max = center + outer_half

        def make_box_vertices(bmin, bmax):
            return np.array(
                [
                    [bmin[0], bmin[1], bmin[2]],  # 0
                    [bmax[0], bmin[1], bmin[2]],  # 1
                    [bmax[0], bmax[1], bmin[2]],  # 2
                    [bmin[0], bmax[1], bmin[2]],  # 3
                    [bmin[0], bmin[1], bmax[2]],  # 4
                    [bmax[0], bmin[1], bmax[2]],  # 5
                    [bmax[0], bmax[1], bmax[2]],  # 6
                    [bmin[0], bmax[1], bmax[2]],  # 7
                ],
                dtype=np.float64,
            )

        inner_verts = model.mb.create_vertices(make_box_vertices(inner_min, inner_max))
        outer_verts = model.mb.create_vertices(make_box_vertices(outer_min, outer_max))

        # For each box face (corner indices in CCW order when viewed from outside),
        # split into two triangles.
        outer_face_ccw = [
            [(0, 1, 2), (0, 2, 3)],  # bottom (z=min)
            [(4, 5, 6), (4, 6, 7)],  # top (z=max)
            [(0, 1, 5), (0, 5, 4)],  # front (y=min)
            [(2, 3, 7), (2, 7, 6)],  # back (y=max)
            [(0, 3, 7), (0, 7, 4)],  # left (x=min)
            [(1, 2, 6), (1, 6, 5)],  # right (x=max)
        ]
        # The inner box uses the same corner indexing but its normals must point
        # outward (toward the graveyard), so CCW winding is used directly.
        inner_face_ccw = outer_face_ccw
        # The outer box normals must point inward (toward the graveyard), so its
        # faces are wound clockwise (reverse of CCW).
        outer_face_cw = [
            [(0, 3, 2), (0, 2, 1)],  # bottom
            [(4, 7, 6), (4, 6, 5)],  # top
            [(0, 4, 5), (0, 5, 1)],  # front
            [(2, 6, 7), (2, 7, 3)],  # back
            [(0, 7, 3), (0, 4, 7)],  # left
            [(1, 5, 6), (1, 6, 2)],  # right
        ]

        max_surf_id = max((s.id for s in model.surfaces), default=0)
        max_vol_id = max((v.id for v in model.volumes), default=0)

        graveyard_vol = model.create_volume(global_id=max_vol_id + 1)

        surf_id = max_surf_id + 1

        def add_surface(verts, tri_indices, global_id):
            surf = model.create_surface(global_id=global_id)
            for tri in tri_indices:
                tri_verts = (verts[tri[0]], verts[tri[1]], verts[tri[2]])
                mb_tri = model.mb.create_element(types.MBTRI, tri_verts)
                model.mb.add_entity(surf.handle, mb_tri)
            surf.senses = [graveyard_vol, None]
            return surf

        # Inner shell surfaces: normals point outward -> forward = graveyard.
        for tri_indices in inner_face_ccw:
            add_surface(inner_verts, tri_indices, surf_id)
            surf_id += 1

        # Outer shell surfaces: normals point inward -> forward = graveyard.
        for tri_indices in outer_face_cw:
            add_surface(outer_verts, tri_indices, surf_id)
            surf_id += 1

        graveyard_vol.material = "graveyard"

        out_path = output_path or file_path
        model.write_file(out_path)

        return {
            "success": True,
            "volumeId": int(graveyard_vol.id),
            "message": f"Created graveyard shell (volume {graveyard_vol.id}).",
            "bounds": {"min": outer_min.tolist(), "max": outer_max.tolist()},
        }
    except Exception as e:
        import traceback

        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}


def load_model(file_path: str) -> dict:
    """Load a DAGMC file and return structured model information.

    Args:
        file_path: Path to the DAGMC .h5m file.

    Returns:
        Dictionary with success flag and data including volumes,
        materials, groups, bounding box, and file metadata.
    """
    try:
        model = Model(file_path)

        # Build volumes list
        volumes = []
        total_triangles = 0
        skipped_volumes = 0

        for vol in model.volumes:
            try:
                # Get bounding box (simplified - use first surface's coords)
                bbox_min = [0, 0, 0]
                bbox_max = [0, 0, 0]
                if vol.surfaces:
                    try:
                        # Just get bbox from first surface for speed
                        surf = vol.surfaces[0]
                        conn, coords = surf.get_triangle_conn_and_coords()
                        if coords:
                            coords_array = np.array(coords)
                            bbox_min = coords_array.min(axis=0).tolist()
                            bbox_max = coords_array.max(axis=0).tolist()
                    except Exception:
                        pass

                volumes.append(
                    {
                        "id": int(vol.id),
                        "material": vol.material,
                        "numTriangles": int(vol.num_triangles),
                        "boundingBox": {
                            "min": [float(x) for x in bbox_min],
                            "max": [float(x) for x in bbox_max],
                        },
                    }
                )
                total_triangles += vol.num_triangles
            except Exception as e:
                # Skip volumes that can't be read (e.g. MB_INDEX_OUT_OF_RANGE)
                skipped_volumes += 1
                print(f"[DAGMC Editor] Warning: skipped volume {vol.id}: {e}", file=sys.stderr)

        # Build materials map
        materials = {}
        for mat_name, vols in model.volumes_by_material.items():
            materials[mat_name] = {
                "volumeCount": int(len(vols)),
                "volumes": [int(v.id) for v in vols],
            }

        # Build groups list
        groups = []
        for group in model.groups:
            group_type = (
                "material"
                if group.name.startswith("mat:")
                else "boundary"
                if group.name.startswith("boundary:")
                else "other"
            )
            groups.append(
                {
                    "name": group.name,
                    "type": group_type,
                    "volumeCount": int(len(group.volumes)),
                    "volumes": [int(v.id) for v in group.volumes],
                }
            )

        # Get file size
        file_size_mb = os.path.getsize(file_path) / (1024 * 1024)

        return {
            "success": True,
            "data": {
                "filePath": file_path,
                "fileName": Path(file_path).name,
                "fileSizeMB": round(file_size_mb, 2),
                "volumeCount": len(model.volumes),
                "surfaceCount": len(model.surfaces),
                "vertices": total_triangles,
                "materials": materials,
                "volumes": volumes,
                "groups": groups,
                "boundingBox": {"min": [-25, -25, -25], "max": [25, 25, 25]},  # Default for now
            },
        }
    except Exception as e:
        import traceback

        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}


def assign_material(file_path: str, volume_id: int, material_name: str) -> dict:
    """Assign a material to a volume and persist the change.

    Args:
        file_path: Path to the DAGMC .h5m file.
        volume_id: ID of the volume to modify.
        material_name: Name of the material to assign. An empty string
            removes the existing material assignment.

    Returns:
        Dictionary with success flag and confirmation message.
    """
    try:
        model = Model(file_path)

        volume = model.volumes_by_id.get(volume_id)
        if volume is None:
            return {"success": False, "error": f"Volume {volume_id} not found"}

        # Assign material (empty string means remove)
        if material_name:
            volume.material = material_name
        else:
            volume.material = None

        # Save
        model.mb.write_file(file_path)

        return {
            "success": True,
            "message": f'Assigned material "{material_name}" to volume {volume_id}',
        }
    except Exception as e:
        import traceback

        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}


def replace_material(file_path: str, old_name: str, new_name: str) -> dict:
    """Reassign all volumes with one material to another material.

    This is the by-name equivalent of :func:`assign_material` (OpenMC's
    ``DAGMCUniverse.add_material_override`` semantics applied across the file).

    Args:
        file_path: Path to the DAGMC .h5m file.
        old_name: Material name to replace (empty string matches unassigned volumes).
        new_name: Material name to assign instead (empty string removes the assignment).

    Returns:
        Dictionary with success flag and the number of volumes updated.
    """
    try:
        model = Model(file_path)

        old = old_name or None
        new = new_name or None

        updated = 0
        for volume in model.volumes_by_id.values():
            current = volume.material or None
            if current == old:
                volume.material = new
                updated += 1

        if updated == 0:
            return {
                "success": False,
                "error": f'No volumes with material "{old_name}" found',
            }

        # Save
        model.mb.write_file(file_path)

        return {
            "success": True,
            "updated": updated,
            "message": f'Replaced material "{old_name}" with "{new_name}" on {updated} volume(s)',
        }
    except Exception as e:
        import traceback

        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}


def create_group(file_path: str, group_name: str, volume_ids: list = None) -> dict:
    """Create a new DAGMC group with optional volumes.

    Args:
        file_path: Path to the DAGMC .h5m file.
        group_name: Name for the new group.
        volume_ids: Optional list of volume IDs to add to the group.

    Returns:
        Dictionary with success flag and confirmation message.
    """
    try:
        model = Model(file_path)

        if group_name in model.group_names:
            return {"success": False, "error": f'Group "{group_name}" already exists'}

        from pymoab import types

        new_group_handle = model.mb.create_meshset(types.MBENTITYSET)

        model.mb.tag_set_data(model.category_tag, new_group_handle, "Group")
        model.mb.tag_set_data(model.name_tag, new_group_handle, group_name)

        if volume_ids:
            for vid in volume_ids:
                vol = model.volumes_by_id.get(vid)
                if vol:
                    model.mb.add_entities(new_group_handle, [vol.handle])

        model.mb.write_file(file_path)

        return {"success": True, "message": f'Created group "{group_name}"'}
    except Exception as e:
        import traceback

        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}


def delete_group(file_path: str, group_name: str) -> dict:
    """Delete a group from the DAGMC model.

    Removes the group meshset but leaves the underlying volumes intact.

    Args:
        file_path: Path to the DAGMC .h5m file.
        group_name: Name of the group to delete.

    Returns:
        Dictionary with success flag and confirmation message.
    """
    try:
        model = Model(file_path)

        group = model.groups_by_name.get(group_name)
        if group is None:
            return {"success": False, "error": f'Group "{group_name}" not found'}

        # Delete the group meshset (this removes the group but not the volumes)
        model.mb.delete_entities([group.handle])
        model.mb.write_file(file_path)

        return {"success": True, "message": f'Deleted group "{group_name}"'}
    except Exception as e:
        import traceback

        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}


def add_volumes_to_group(file_path: str, group_name: str, volume_ids: list) -> dict:
    """Add volumes to an existing group.

    Args:
        file_path: Path to the DAGMC .h5m file.
        group_name: Name of the target group.
        volume_ids: List of volume IDs to add.

    Returns:
        Dictionary with success flag and confirmation message.
    """
    try:
        model = Model(file_path)

        group = model.groups_by_name.get(group_name)
        if group is None:
            return {"success": False, "error": f'Group "{group_name}" not found'}

        for vid in volume_ids:
            vol = model.volumes_by_id.get(vid)
            if vol:
                model.mb.add_entities(group.handle, [vol.handle])

        model.mb.write_file(file_path)

        return {
            "success": True,
            "message": f'Added {len(volume_ids)} volumes to group "{group_name}"',
        }
    except Exception as e:
        import traceback

        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}


def remove_volumes_from_group(file_path: str, group_name: str, volume_ids: list) -> dict:
    """Remove volumes from a group.

    Args:
        file_path: Path to the DAGMC .h5m file.
        group_name: Name of the target group.
        volume_ids: List of volume IDs to remove.

    Returns:
        Dictionary with success flag and confirmation message.
    """
    try:
        model = Model(file_path)

        group = model.groups_by_name.get(group_name)
        if group is None:
            return {"success": False, "error": f'Group "{group_name}" not found'}

        for vid in volume_ids:
            vol = model.volumes_by_id.get(vid)
            if vol:
                model.mb.remove_entities(group.handle, [vol.handle])

        model.mb.write_file(file_path)

        return {
            "success": True,
            "message": f'Removed {len(volume_ids)} volumes from group "{group_name}"',
        }
    except Exception as e:
        import traceback

        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}


def get_faceting_params(file_path: str) -> dict:
    """Read faceting tolerance and triangle count from a DAGMC file.

    Args:
        file_path: Path to the DAGMC .h5m file.

    Returns:
        Dictionary with success flag and faceting parameters.
    """
    try:
        model = Model(file_path)
        tolerance = _read_faceting_tolerance(model)
        total_triangles = sum(v.num_triangles for v in model.volumes)
        num_surfaces = len(model.surfaces)

        return {
            "success": True,
            "data": {
                "facetingTolerance": tolerance,
                "totalTriangles": int(total_triangles),
                "volumeCount": len(model.volumes),
                "surfaceCount": num_surfaces,
            },
        }
    except Exception as e:
        import traceback

        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}


def estimate_triangles(file_path: str, new_tolerance: float) -> dict:
    """Estimate triangle count for a given faceting tolerance.

    Uses a bounded scaling heuristic that accounts for the fact that
    geometric feature sizes and curvature constraints prevent extreme
    coarsening or refinement.

    For coarsening (larger tolerance):  N_new ≈ N_old * (tol_old / tol_new)^0.5
    For refinement (smaller tolerance): N_new ≈ N_old * (tol_old / tol_new)^1.5

    The estimate is clamped to a geometry-aware floor and a reasonable ceiling.

    Args:
        file_path: Path to the DAGMC .h5m file.
        new_tolerance: Proposed new faceting tolerance.

    Returns:
        Dictionary with current and estimated triangle counts.
    """
    try:
        current = get_faceting_params(file_path)
        if not current["success"]:
            return current

        current_tol = current["data"]["facetingTolerance"]
        current_tri = current["data"]["totalTriangles"]
        num_volumes = current["data"]["volumeCount"]
        num_surfaces = current["data"]["surfaceCount"]

        # Avoid division by zero
        if current_tol <= 0 or new_tolerance <= 0:
            return {"success": False, "error": "Tolerance must be positive"}

        ratio = current_tol / new_tolerance

        if ratio < 1:
            # Coarsening (larger tolerance): sub-quadratic scaling.
            # Curvature and feature-size constraints prevent the full 1/tol^2 reduction.
            # Use square-root scaling, capped at a 50x reduction.
            scale = max(ratio**0.5, 0.02)
        else:
            # Refinement (smaller tolerance): super-linear but capped at 100x increase.
            scale = min(ratio**1.5, 100.0)

        estimated = int(current_tri * scale)

        # Geometry-aware floor: even very coarse meshes need a minimum number of
        # triangles to represent the shape (roughly 200/volume or 20/surface).
        min_estimate = max(num_volumes * 200, num_surfaces * 20, 1000)
        estimated = max(estimated, min_estimate)

        # Sanity ceiling: don't estimate more than 100x the current count.
        max_estimate = max(current_tri * 100, 1000000)
        estimated = min(estimated, max_estimate)

        return {
            "success": True,
            "data": {
                "currentTolerance": current_tol,
                "newTolerance": new_tolerance,
                "currentTriangles": current_tri,
                "estimatedTriangles": estimated,
                "volumeCount": num_volumes,
                "surfaceCount": num_surfaces,
            },
        }
    except Exception as e:
        import traceback

        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}


def _write_dagmc_streaming(
    moab_core,
    tag_gid,
    tag_gdim,
    tag_cat,
    tag_name,
    tag_sense,
    tag_facet_tol,
    moab_verts,
    node_tag_to_idx,
    material_map,
    tolerance,
    length_scale=1.0,
) -> tuple[dict, dict, dict]:
    """Stream mesh data from gmsh directly into pymoab without holding all triangles in memory.

    Processes one volume at a time, extracting surface triangles from gmsh and
    immediately creating pymoab entities.

    Returns:
        Tuple of (volume_sets, surface_sets, group_sets) dictionaries.
    """
    import gmsh
    from pymoab import types

    face_to_volumes: dict = {}
    volume_sets: dict = {}
    surface_sets: dict = {}
    group_sets: dict = {}

    # Map faces to volumes for GEOM_SENSE_2
    volumes = gmsh.model.getEntities(3)
    for vol_dim, vol_tag in volumes:
        boundary = gmsh.model.getBoundary([(vol_dim, vol_tag)], oriented=False, recursive=False)
        for face_dim, face_tag in boundary:
            if face_dim != 2:
                continue
            if face_tag not in face_to_volumes:
                face_to_volumes[face_tag] = []
            face_to_volumes[face_tag].append(vol_tag)

    # Process volumes one at a time
    for idx, (vol_dim, vol_tag) in enumerate(volumes):
        # Create volume meshset
        vset = moab_core.create_meshset()
        moab_core.tag_set_data(tag_gid, vset, int(vol_tag))
        moab_core.tag_set_data(tag_gdim, vset, 3)
        moab_core.tag_set_data(tag_cat, vset, "Volume")
        volume_sets[vol_tag] = vset

        # Get boundary surfaces
        boundary = gmsh.model.getBoundary([(vol_dim, vol_tag)], oriented=False, recursive=False)

        for face_dim, face_tag in boundary:
            if face_dim != 2:
                continue

            # Create surface meshset if not already created
            if face_tag not in surface_sets:
                sset = moab_core.create_meshset()
                moab_core.tag_set_data(tag_gid, sset, int(face_tag))
                moab_core.tag_set_data(tag_gdim, sset, 2)
                moab_core.tag_set_data(tag_cat, sset, "Surface")
                surface_sets[face_tag] = sset

                # Extract triangles for this surface directly from gmsh
                elem_types, elem_tags, elem_node_tags = gmsh.model.mesh.getElements(
                    face_dim, face_tag
                )

                for etype, _etags, enodes in zip(
                    elem_types, elem_tags, elem_node_tags, strict=True
                ):
                    if etype == 2:  # 3-node triangle
                        for i in range(0, len(enodes), 3):
                            tri_verts = (
                                moab_verts[node_tag_to_idx[int(enodes[i])]],
                                moab_verts[node_tag_to_idx[int(enodes[i + 1])]],
                                moab_verts[node_tag_to_idx[int(enodes[i + 2])]],
                            )
                            mb_tri = moab_core.create_element(types.MBTRI, tri_verts)
                            moab_core.add_entity(surface_sets[face_tag], mb_tri)
                    elif etype == 3:  # 4-node quadrilateral -> split into 2 triangles
                        for i in range(0, len(enodes), 4):
                            q = [
                                int(enodes[i]),
                                int(enodes[i + 1]),
                                int(enodes[i + 2]),
                                int(enodes[i + 3]),
                            ]
                            for tri in ([q[0], q[1], q[2]], [q[0], q[2], q[3]]):
                                tri_verts = (
                                    moab_verts[node_tag_to_idx[tri[0]]],
                                    moab_verts[node_tag_to_idx[tri[1]]],
                                    moab_verts[node_tag_to_idx[tri[2]]],
                                )
                                mb_tri = moab_core.create_element(types.MBTRI, tri_verts)
                                moab_core.add_entity(surface_sets[face_tag], mb_tri)

            # Link volume to surface
            moab_core.add_parent_child(volume_sets[vol_tag], surface_sets[face_tag])

        # Create material group for this volume using actual material from old model
        mat_name = material_map.get(vol_tag, f"mat_{idx}")
        if mat_name is None:
            mat_name = f"mat_{idx}"
        gset = moab_core.create_meshset()
        moab_core.tag_set_data(tag_cat, gset, "Group")
        moab_core.tag_set_data(tag_gdim, gset, 4)
        moab_core.tag_set_data(tag_name, gset, f"mat:{mat_name}")
        moab_core.tag_set_data(tag_gid, gset, int(vol_tag))
        moab_core.add_entity(gset, volume_sets[vol_tag])
        group_sets[vol_tag] = gset

    # Set GEOM_SENSE_2 on surfaces
    for face_tag, vols in face_to_volumes.items():
        if face_tag not in surface_sets:
            continue
        sset = surface_sets[face_tag]
        if len(vols) == 2 and vols[0] in volume_sets and vols[1] in volume_sets:
            sense_data = np.array([volume_sets[vols[0]], volume_sets[vols[1]]], dtype=np.uint64)
        elif len(vols) >= 1 and vols[0] in volume_sets:
            sense_data = np.array([volume_sets[vols[0]], 0], dtype=np.uint64)
        else:
            continue
        moab_core.tag_set_data(tag_sense, sset, sense_data)

    # Set faceting tolerance on root set
    root = moab_core.get_root_set()
    moab_core.tag_set_data(tag_facet_tol, root, float(tolerance))

    return volume_sets, surface_sets, group_sets


def _step_to_dagmc_ocp(
    step_path: str, h5m_path: str, tolerance: float, material_map: dict = None
) -> tuple:
    """STEP→DAGMC conversion using OpenCASCADE BRepMesh.

    Uses OCP.BRepMesh_IncrementalMesh for faceting-tolerance-based
    tessellation directly from the CAD geometry.

    Returns:
        Tuple of (num_volumes, num_vertices, num_triangles).
    """
    from OCP.BRep import BRep_Tool
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.STEPControl import STEPControl_Reader
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS
    from pymoab import core as moab_core
    from pymoab import types

    # 1. Load STEP and tessellate with OpenCASCADE
    reader = STEPControl_Reader()
    status = reader.ReadFile(step_path)
    if status != 1:
        raise RuntimeError(f"Failed to read STEP file, status={status}")
    reader.TransferRoot()
    shape = reader.OneShape()
    BRepMesh_IncrementalMesh(shape, tolerance, False, 0.5, True)

    # 2. Extract geometry (two-pass: collect vertices first, then build MOAB)
    global_vertices = {}
    vertex_coords = []
    volume_faces = []  # list of (vol_id, [face_hash, ...])
    face_to_volumes = {}  # face_hash -> [vol_id, ...]
    face_hashes = {}  # face_hash -> list of [v0,v1,v2] triangles

    solid_exp = TopExp_Explorer(shape, TopAbs_SOLID)
    vol_id = 1
    while solid_exp.More():
        solid = topods_solid(TopoDS, solid_exp.Current())
        faces = []
        face_exp = TopExp_Explorer(solid, TopAbs_FACE)
        while face_exp.More():
            face = topods_face(TopoDS, face_exp.Current())
            loc = face.Location()
            tri = brep_tool_triangulation(BRep_Tool, face, loc)
            if tri is None or tri.NbTriangles() == 0:
                face_exp.Next()
                continue

            face_hash = hash(face.TShape().__hash__())
            if face_hash not in face_to_volumes:
                face_to_volumes[face_hash] = []
            face_to_volumes[face_hash].append(vol_id)

            if face_hash not in face_hashes:
                trsf = loc.Transformation()
                local_to_global = {}
                for i in range(1, tri.NbNodes() + 1):
                    pnt = tri.Node(i)
                    pnt.Transform(trsf)
                    key = (round(pnt.X(), 9), round(pnt.Y(), 9), round(pnt.Z(), 9))
                    if key not in global_vertices:
                        global_vertices[key] = len(vertex_coords)
                        vertex_coords.append([pnt.X(), pnt.Y(), pnt.Z()])
                    local_to_global[i] = global_vertices[key]

                face_tris = []
                for i in range(1, tri.NbTriangles() + 1):
                    t = tri.Triangle(i)
                    face_tris.append(
                        [
                            local_to_global[t.Value(1)],
                            local_to_global[t.Value(2)],
                            local_to_global[t.Value(3)],
                        ]
                    )
                face_hashes[face_hash] = face_tris

            faces.append(face_hash)
            face_exp.Next()

        if faces:
            volume_faces.append((vol_id, faces))
            vol_id += 1
        solid_exp.Next()

    # 3. Build MOAB with proper DAGMC tags
    mb = moab_core.Core()
    tag_cat = mb.tag_get_handle(
        types.CATEGORY_TAG_NAME,
        types.CATEGORY_TAG_SIZE,
        types.MB_TYPE_OPAQUE,
        types.MB_TAG_SPARSE,
        create_if_missing=True,
    )
    tag_name = mb.tag_get_handle(
        types.NAME_TAG_NAME,
        types.NAME_TAG_SIZE,
        types.MB_TYPE_OPAQUE,
        types.MB_TAG_SPARSE,
        create_if_missing=True,
    )
    tag_gdim = mb.tag_get_handle(
        types.GEOM_DIMENSION_TAG_NAME,
        1,
        types.MB_TYPE_INTEGER,
        types.MB_TAG_DENSE,
        create_if_missing=True,
    )
    tag_gid = mb.tag_get_handle(types.GLOBAL_ID_TAG_NAME)
    tag_sense = mb.tag_get_handle(
        "GEOM_SENSE_2", 2, types.MB_TYPE_HANDLE, types.MB_TAG_SPARSE, create_if_missing=True
    )
    tag_facet_tol = mb.tag_get_handle(
        "FACETING_TOL", 1, types.MB_TYPE_DOUBLE, types.MB_TAG_SPARSE, create_if_missing=True
    )

    verts_array = np.array(vertex_coords, dtype=np.float64)
    moab_verts = mb.create_vertices(verts_array)

    surface_sets = {}
    surf_id = 1
    for face_hash in face_hashes:
        sset = mb.create_meshset()
        mb.tag_set_data(tag_gid, sset, surf_id)
        mb.tag_set_data(tag_gdim, sset, 2)
        mb.tag_set_data(tag_cat, sset, "Surface")
        surface_sets[face_hash] = sset

        for tri_idx in face_hashes[face_hash]:
            tri_verts = (
                moab_verts[tri_idx[0]],
                moab_verts[tri_idx[1]],
                moab_verts[tri_idx[2]],
            )
            mb_tri = mb.create_element(types.MBTRI, tri_verts)
            mb.add_entity(sset, mb_tri)
        surf_id += 1

    volume_sets = {}
    for vol_id, face_hash_list in volume_faces:
        vset = mb.create_meshset()
        mb.tag_set_data(tag_gid, vset, vol_id)
        mb.tag_set_data(tag_gdim, vset, 3)
        mb.tag_set_data(tag_cat, vset, "Volume")
        volume_sets[vol_id] = vset

        for fh in face_hash_list:
            mb.add_parent_child(vset, surface_sets[fh])

        mat_name = (
            material_map.get(vol_id, f"mat_{vol_id - 1}") if material_map else f"mat_{vol_id - 1}"
        )
        if mat_name is None:
            mat_name = f"mat_{vol_id - 1}"
        gset = mb.create_meshset()
        mb.tag_set_data(tag_cat, gset, "Group")
        mb.tag_set_data(tag_gdim, gset, 4)
        mb.tag_set_data(tag_name, gset, f"mat:{mat_name}")
        mb.tag_set_data(tag_gid, gset, vol_id)
        mb.add_entity(gset, vset)

    for face_hash, vols in face_to_volumes.items():
        if face_hash not in surface_sets:
            continue
        sset = surface_sets[face_hash]
        if len(vols) == 2 and vols[0] in volume_sets and vols[1] in volume_sets:
            sense_data = np.array([volume_sets[vols[0]], volume_sets[vols[1]]], dtype=np.uint64)
        elif len(vols) >= 1 and vols[0] in volume_sets:
            sense_data = np.array([volume_sets[vols[0]], 0], dtype=np.uint64)
        else:
            continue
        mb.tag_set_data(tag_sense, sset, sense_data)

    # The OpenCASCADE-based refacet creates independent surface shells per
    # volume, so every surface is effectively an exterior surface. Tag them
    # all as boundary:vacuum so OpenMC has a boundary condition to apply.
    boundary_group = mb.create_meshset()
    mb.tag_set_data(tag_cat, boundary_group, "Group")
    mb.tag_set_data(tag_gdim, boundary_group, 4)
    mb.tag_set_data(tag_name, boundary_group, "boundary:vacuum")
    mb.tag_set_data(tag_gid, boundary_group, int(vol_id + 1))
    for sset in surface_sets.values():
        mb.add_entity(boundary_group, sset)

    root = mb.get_root_set()
    mb.tag_set_data(tag_facet_tol, root, float(tolerance))
    mb.write_file(h5m_path)

    total_tris = sum(sum(len(face_hashes[fh]) for fh in fl) for _, fl in volume_faces)
    return len(volume_faces), len(vertex_coords), total_tris


def refacet(existing_h5m: str, source_cad_path: str, tolerance: float) -> dict:
    """Re-export a DAGMC file from source CAD with a new faceting tolerance.

    Uses OpenCASCADE BRepMesh_IncrementalMesh for tessellation.
    Triangle count scales with tolerance because we tessellate based on
    linear deflection from the true CAD surface.

    Args:
        existing_h5m: Path to the current DAGMC .h5m file.
        source_cad_path: Path to the source CAD file (STEP/STP/BREP/IGES).
        tolerance: Desired faceting tolerance (linear deflection in cm).

    Returns:
        Dictionary with success flag and output file path.
    """
    import tempfile

    try:
        from pymoab import core as moab_core  # noqa: F401  # availability probe
        from pymoab import types  # noqa: F401  # availability probe
    except ImportError:
        return {"success": False, "error": "pymoab is not installed"}

    try:
        # 1. Extract material assignments from existing H5M, then free it immediately
        old_model = Model(existing_h5m)
        old_materials = {}
        for vol in old_model.volumes:
            old_materials[vol.id] = vol.material
        old_vol_count = len(old_model.volumes)
        del old_model
        import gc

        gc.collect()

        # 2. Fast OCP-based conversion
        fd, temp_h5m = tempfile.mkstemp(suffix=".h5m")
        os.close(fd)

        n_vols, n_verts, n_tris = _step_to_dagmc_ocp(
            source_cad_path, temp_h5m, tolerance, material_map=old_materials
        )

        warnings = []
        if old_vol_count != n_vols:
            warnings.append(
                f"Volume count mismatch: old={old_vol_count}, new={n_vols}. "
                f"Materials mapped by volume tag where possible."
            )

        # 3. Move to output path
        output_dir = Path(existing_h5m).parent
        base_name = Path(existing_h5m).stem
        output_path = str(output_dir / f"{base_name}_refaceted.h5m")

        if os.path.exists(output_path):
            os.unlink(output_path)
        shutil.move(temp_h5m, output_path)

        return {
            "success": True,
            "data": {
                "outputPath": output_path,
                "message": f"Re-faceted geometry saved to {Path(output_path).name} "
                f"({n_vols} volumes, {n_tris:,} triangles)",
            },
            "warnings": warnings,
        }
    except Exception as e:
        import traceback

        return {"success": False, "error": str(e), "traceback": traceback.format_exc()}


def main():
    """Main entry point for CLI usage.

    Dispatches to the appropriate editor function based on the
    first command-line argument.
    """
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No command specified"}))
        sys.exit(1)

    command = sys.argv[1]

    if command == "load":
        if len(sys.argv) < 3:
            print(json.dumps({"success": False, "error": "No file path specified"}))
            sys.exit(1)
        result = load_model(sys.argv[2])
        print(json.dumps(result))

    elif command == "detect_graveyard":
        if len(sys.argv) < 3:
            print(json.dumps({"success": False, "error": "No file path specified"}))
            sys.exit(1)
        result = detect_graveyard(sys.argv[2])
        print(json.dumps(result))

    elif command == "tag_graveyard":
        if len(sys.argv) < 3:
            print(json.dumps({"success": False, "error": "No file path specified"}))
            sys.exit(1)
        file_path = sys.argv[2]
        volume_id = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else None
        result = tag_graveyard(file_path, volume_id)
        print(json.dumps(result))

    elif command == "create_graveyard":
        if len(sys.argv) < 3:
            print(json.dumps({"success": False, "error": "No file path specified"}))
            sys.exit(1)
        file_path = sys.argv[2]
        padding = float(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else 0.1
        result = create_graveyard_box(file_path, padding=padding)
        print(json.dumps(result))

    elif command == "assign_material":
        if len(sys.argv) < 5:
            print(json.dumps({"success": False, "error": "Insufficient arguments"}))
            sys.exit(1)
        file_path = sys.argv[2]
        volume_id = int(sys.argv[3])
        material_name = sys.argv[4]
        result = assign_material(file_path, volume_id, material_name)
        print(json.dumps(result))

    elif command == "replace_material":
        if len(sys.argv) < 5:
            print(json.dumps({"success": False, "error": "Insufficient arguments"}))
            sys.exit(1)
        file_path = sys.argv[2]
        old_name = sys.argv[3]
        new_name = sys.argv[4]
        result = replace_material(file_path, old_name, new_name)
        print(json.dumps(result))

    elif command == "create_group":
        if len(sys.argv) < 4:
            print(json.dumps({"success": False, "error": "Insufficient arguments"}))
            sys.exit(1)
        file_path = sys.argv[2]
        group_name = sys.argv[3]
        volume_ids = (
            [int(v) for v in sys.argv[4].split(",")] if len(sys.argv) > 4 and sys.argv[4] else None
        )
        result = create_group(file_path, group_name, volume_ids)
        print(json.dumps(result))

    elif command == "delete_group":
        if len(sys.argv) < 4:
            print(json.dumps({"success": False, "error": "Insufficient arguments"}))
            sys.exit(1)
        file_path = sys.argv[2]
        group_name = sys.argv[3]
        result = delete_group(file_path, group_name)
        print(json.dumps(result))

    elif command == "add_to_group":
        if len(sys.argv) < 5:
            print(json.dumps({"success": False, "error": "Insufficient arguments"}))
            sys.exit(1)
        file_path = sys.argv[2]
        group_name = sys.argv[3]
        volume_ids = [int(v) for v in sys.argv[4].split(",")] if sys.argv[4] else []
        result = add_volumes_to_group(file_path, group_name, volume_ids)
        print(json.dumps(result))

    elif command == "remove_from_group":
        if len(sys.argv) < 5:
            print(json.dumps({"success": False, "error": "Insufficient arguments"}))
            sys.exit(1)
        file_path = sys.argv[2]
        group_name = sys.argv[3]
        volume_ids = [int(v) for v in sys.argv[4].split(",")] if sys.argv[4] else []
        result = remove_volumes_from_group(file_path, group_name, volume_ids)
        print(json.dumps(result))

    elif command == "get_faceting_params":
        if len(sys.argv) < 3:
            print(json.dumps({"success": False, "error": "No file path specified"}))
            sys.exit(1)
        result = get_faceting_params(sys.argv[2])
        print(json.dumps(result))

    elif command == "estimate_triangles":
        if len(sys.argv) < 4:
            print(json.dumps({"success": False, "error": "Insufficient arguments"}))
            sys.exit(1)
        result = estimate_triangles(sys.argv[2], float(sys.argv[3]))
        print(json.dumps(result))

    elif command == "refacet":
        if len(sys.argv) < 5:
            print(json.dumps({"success": False, "error": "Insufficient arguments"}))
            sys.exit(1)
        result = refacet(sys.argv[2], sys.argv[3], float(sys.argv[4]))
        print(json.dumps(result))

    else:
        print(json.dumps({"success": False, "error": f"Unknown command: {command}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
