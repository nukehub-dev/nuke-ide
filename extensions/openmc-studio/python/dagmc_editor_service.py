#!/usr/bin/env python3
"""DAGMC Editor Service.

Backend service for DAGMC file editing using pydagmc.
Provides CLI commands to load models, assign materials, and manage
groups within DAGMC .h5m files.
"""

import sys
import json
import os
import shutil
from pathlib import Path

try:
    from pydagmc import Model
except ImportError:
    import site
    for site_path in site.getsitepackages():
        if os.path.exists(os.path.join(site_path, 'pydagmc')):
            sys.path.insert(0, site_path)
            break
    from pydagmc import Model

import numpy as np

# Ensure cad_conversion is importable (same dir layout as cad_importer.py)
_SCRIPT_DIR = Path(__file__).parent.resolve()
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))


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

                volumes.append({
                    'id': int(vol.id),
                    'material': vol.material,
                    'numTriangles': int(vol.num_triangles),
                    'boundingBox': {
                        'min': [float(x) for x in bbox_min],
                        'max': [float(x) for x in bbox_max]
                    }
                })
                total_triangles += vol.num_triangles
            except Exception as e:
                # Skip volumes that can't be read (e.g. MB_INDEX_OUT_OF_RANGE)
                skipped_volumes += 1
                print(f"[DAGMC Editor] Warning: skipped volume {vol.id}: {e}", file=sys.stderr)

        # Build materials map
        materials = {}
        for mat_name, vols in model.volumes_by_material.items():
            materials[mat_name] = {
                'volumeCount': int(len(vols)),
                'volumes': [int(v.id) for v in vols]
            }

        # Build groups list
        groups = []
        for group in model.groups:
            group_type = 'material' if group.name.startswith('mat:') else \
                        'boundary' if group.name.startswith('boundary:') else 'other'
            groups.append({
                'name': group.name,
                'type': group_type,
                'volumeCount': int(len(group.volumes)),
                'volumes': [int(v.id) for v in group.volumes]
            })

        # Get file size
        file_size_mb = os.path.getsize(file_path) / (1024 * 1024)

        return {
            'success': True,
            'data': {
                'filePath': file_path,
                'fileName': Path(file_path).name,
                'fileSizeMB': round(file_size_mb, 2),
                'volumeCount': len(model.volumes),
                'surfaceCount': len(model.surfaces),
                'vertices': total_triangles,
                'materials': materials,
                'volumes': volumes,
                'groups': groups,
                'boundingBox': {'min': [-25, -25, -25], 'max': [25, 25, 25]}  # Default for now
            }
        }
    except Exception as e:
        import traceback
        return {
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc()
        }


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
            return {'success': False, 'error': f'Volume {volume_id} not found'}

        # Assign material (empty string means remove)
        if material_name:
            volume.material = material_name
        else:
            volume.material = None

        # Save
        model.mb.write_file(file_path)

        return {
            'success': True,
            'message': f'Assigned material "{material_name}" to volume {volume_id}'
        }
    except Exception as e:
        import traceback
        return {'success': False, 'error': str(e), 'traceback': traceback.format_exc()}


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
            return {'success': False, 'error': f'Group "{group_name}" already exists'}

        from pymoab import types
        new_group_handle = model.mb.create_meshset(types.MBENTITYSET)

        model.mb.tag_set_data(model.category_tag, new_group_handle, 'Group')
        model.mb.tag_set_data(model.name_tag, new_group_handle, group_name)

        if volume_ids:
            for vid in volume_ids:
                vol = model.volumes_by_id.get(vid)
                if vol:
                    model.mb.add_entities(new_group_handle, [vol.handle])

        model.mb.write_file(file_path)

        return {'success': True, 'message': f'Created group "{group_name}"'}
    except Exception as e:
        import traceback
        return {'success': False, 'error': str(e), 'traceback': traceback.format_exc()}


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
            return {'success': False, 'error': f'Group "{group_name}" not found'}

        # Delete the group meshset (this removes the group but not the volumes)
        model.mb.delete_entities([group.handle])
        model.mb.write_file(file_path)

        return {'success': True, 'message': f'Deleted group "{group_name}"'}
    except Exception as e:
        import traceback
        return {'success': False, 'error': str(e), 'traceback': traceback.format_exc()}


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
            return {'success': False, 'error': f'Group "{group_name}" not found'}

        for vid in volume_ids:
            vol = model.volumes_by_id.get(vid)
            if vol:
                model.mb.add_entities(group.handle, [vol.handle])

        model.mb.write_file(file_path)

        return {'success': True, 'message': f'Added {len(volume_ids)} volumes to group "{group_name}"'}
    except Exception as e:
        import traceback
        return {'success': False, 'error': str(e), 'traceback': traceback.format_exc()}


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
            return {'success': False, 'error': f'Group "{group_name}" not found'}

        for vid in volume_ids:
            vol = model.volumes_by_id.get(vid)
            if vol:
                model.mb.remove_entities(group.handle, [vol.handle])

        model.mb.write_file(file_path)

        return {'success': True, 'message': f'Removed {len(volume_ids)} volumes from group "{group_name}"'}
    except Exception as e:
        import traceback
        return {'success': False, 'error': str(e), 'traceback': traceback.format_exc()}


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

        return {
            'success': True,
            'data': {
                'facetingTolerance': tolerance,
                'totalTriangles': int(total_triangles),
                'volumeCount': len(model.volumes)
            }
        }
    except Exception as e:
        import traceback
        return {'success': False, 'error': str(e), 'traceback': traceback.format_exc()}


def estimate_triangles(file_path: str, new_tolerance: float) -> dict:
    """Estimate triangle count for a given faceting tolerance.

    Uses the heuristic: triangle count scales roughly as (1/tolerance)^2.

    Args:
        file_path: Path to the DAGMC .h5m file.
        new_tolerance: Proposed new faceting tolerance.

    Returns:
        Dictionary with current and estimated triangle counts.
    """
    try:
        current = get_faceting_params(file_path)
        if not current['success']:
            return current

        current_tol = current['data']['facetingTolerance']
        current_tri = current['data']['totalTriangles']

        # Avoid division by zero
        if current_tol <= 0 or new_tolerance <= 0:
            return {'success': False, 'error': 'Tolerance must be positive'}

        # Heuristic: N ∝ 1/tol^2
        estimated = int(current_tri * (current_tol / new_tolerance) ** 2)

        return {
            'success': True,
            'data': {
                'currentTolerance': current_tol,
                'newTolerance': new_tolerance,
                'currentTriangles': current_tri,
                'estimatedTriangles': estimated
            }
        }
    except Exception as e:
        import traceback
        return {'success': False, 'error': str(e), 'traceback': traceback.format_exc()}


def _write_dagmc_streaming(
    moab_core,
    tag_gid,
    tag_gdim,
    tag_cat,
    tag_name,
    tag_sense,
    tag_facet_tol,
    moab_verts,
    material_tags,
    tolerance,
    length_scale=1.0,
) -> str:
    """Stream mesh data from gmsh directly into pymoab without holding all triangles in memory.

    Processes one volume at a time, extracting surface triangles from gmsh and
    immediately creating pymoab entities.
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
                elem_types, elem_tags, elem_node_tags = gmsh.model.mesh.getElements(face_dim, face_tag)

                for etype, etags, enodes in zip(elem_types, elem_tags, elem_node_tags):
                    if etype == 2:  # 3-node triangle
                        for i in range(0, len(enodes), 3):
                            tri_indices = [
                                int(enodes[i]) - 1,
                                int(enodes[i + 1]) - 1,
                                int(enodes[i + 2]) - 1,
                            ]
                            tri_verts = (
                                moab_verts[tri_indices[0]],
                                moab_verts[tri_indices[1]],
                                moab_verts[tri_indices[2]],
                            )
                            mb_tri = moab_core.create_element(types.MBTRI, tri_verts)
                            moab_core.add_entity(surface_sets[face_tag], mb_tri)
                    elif etype == 3:  # 4-node quadrilateral -> split into 2 triangles
                        for i in range(0, len(enodes), 4):
                            q = [
                                int(enodes[i]) - 1,
                                int(enodes[i + 1]) - 1,
                                int(enodes[i + 2]) - 1,
                                int(enodes[i + 3]) - 1,
                            ]
                            for tri in ([q[0], q[1], q[2]], [q[0], q[2], q[3]]):
                                tri_verts = (
                                    moab_verts[tri[0]],
                                    moab_verts[tri[1]],
                                    moab_verts[tri[2]],
                                )
                                mb_tri = moab_core.create_element(types.MBTRI, tri_verts)
                                moab_core.add_entity(surface_sets[face_tag], mb_tri)

            # Link volume to surface
            moab_core.add_parent_child(volume_sets[vol_tag], surface_sets[face_tag])

        # Create material group for this volume
        mat_tag = material_tags[idx] if idx < len(material_tags) else f'mat_{idx}'
        gset = moab_core.create_meshset()
        moab_core.tag_set_data(tag_cat, gset, "Group")
        moab_core.tag_set_data(tag_gdim, gset, 4)
        moab_core.tag_set_data(tag_name, gset, f"mat:{mat_tag}")
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

    return ""


def refacet(existing_h5m: str, source_cad_path: str, tolerance: float) -> dict:
    """Re-export a DAGMC file from source CAD with a new faceting tolerance.

    Memory-optimized: streams mesh data from gmsh directly into pymoab
    one volume at a time, never holding all triangles in Python memory.

    Args:
        existing_h5m: Path to the current DAGMC .h5m file.
        source_cad_path: Path to the source CAD file (STEP/STP/BREP/IGES).
        tolerance: Desired faceting tolerance.

    Returns:
        Dictionary with success flag and output file path.
    """
    import tempfile
    try:
        import gmsh
    except ImportError:
        return {'success': False, 'error': 'gmsh is not installed'}

    try:
        from pymoab import core as moab_core, types
    except ImportError:
        return {'success': False, 'error': 'pymoab is not installed'}

    try:
        # 1. Extract material assignments from existing H5M
        old_model = Model(existing_h5m)
        old_materials = {}
        for vol in old_model.volumes:
            old_materials[vol.id] = vol.material

        # 2. Open CAD in gmsh and generate mesh
        gmsh.initialize()
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.open(source_cad_path)

        gmsh.option.setNumber('Mesh.Algorithm', 6)
        gmsh.option.setNumber('Mesh.MeshSizeMax', tolerance)
        gmsh.option.setNumber('Mesh.MeshSizeMin', tolerance * 0.05)
        gmsh.option.setNumber('Mesh.Optimize', 1)
        gmsh.option.setNumber('Mesh.QualityType', 2)
        # Use all available CPU cores for mesh generation
        import multiprocessing
        gmsh.option.setNumber('General.NumThreads', multiprocessing.cpu_count())

        warnings = []
        gmsh.model.mesh.generate(2)

        # 3. Create pymoab Core and DAGMC tags
        mb = moab_core.Core()

        tag_cat = mb.tag_get_handle(
            types.CATEGORY_TAG_NAME, types.CATEGORY_TAG_SIZE,
            types.MB_TYPE_OPAQUE, types.MB_TAG_SPARSE, create_if_missing=True
        )
        tag_name = mb.tag_get_handle(
            types.NAME_TAG_NAME, types.NAME_TAG_SIZE,
            types.MB_TYPE_OPAQUE, types.MB_TAG_SPARSE, create_if_missing=True
        )
        tag_gdim = mb.tag_get_handle(
            types.GEOM_DIMENSION_TAG_NAME, 1,
            types.MB_TYPE_INTEGER, types.MB_TAG_DENSE, create_if_missing=True
        )
        tag_gid = mb.tag_get_handle(types.GLOBAL_ID_TAG_NAME)
        tag_sense = mb.tag_get_handle(
            "GEOM_SENSE_2", 2,
            types.MB_TYPE_HANDLE, types.MB_TAG_SPARSE, create_if_missing=True
        )
        tag_facet_tol = mb.tag_get_handle(
            "FACETING_TOL", 1,
            types.MB_TYPE_DOUBLE, types.MB_TAG_SPARSE, create_if_missing=True
        )

        # 4. Create all vertices in pymoab
        node_tags, node_coords, _ = gmsh.model.mesh.getNodes()
        max_tag = int(max(node_tags)) if len(node_tags) > 0 else 0
        verts_array = np.zeros((max_tag, 3), dtype=np.float64)
        for tag, x, y, z in zip(node_tags, node_coords[0::3], node_coords[1::3], node_coords[2::3]):
            verts_array[int(tag) - 1] = [float(x), float(y), float(z)]
        moab_verts = mb.create_vertices(verts_array)

        # 5. Generate default material tags matching volume count
        volumes = gmsh.model.getEntities(3)
        material_tags = [f'mat_{i}' for i in range(len(volumes))]

        # 6. Stream mesh data volume-by-volume into pymoab
        _write_dagmc_streaming(
            mb, tag_gid, tag_gdim, tag_cat, tag_name, tag_sense, tag_facet_tol,
            moab_verts, material_tags, tolerance
        )

        # 7. Write to temp H5M
        fd, temp_h5m = tempfile.mkstemp(suffix='.h5m')
        os.close(fd)
        mb.write_file(temp_h5m)
        gmsh.finalize()

        # 8. Copy material assignments from old to new (best effort)
        new_model = Model(temp_h5m)

        if len(old_model.volumes) != len(new_model.volumes):
            warnings.append(
                f'Volume count mismatch: old={len(old_model.volumes)}, '
                f'new={len(new_model.volumes)}. Material assignments not copied.'
            )
        else:
            old_vols = sorted(old_model.volumes, key=lambda v: v.id)
            new_vols = sorted(new_model.volumes, key=lambda v: v.id)
            for old_vol, new_vol in zip(old_vols, new_vols):
                if old_vol.material:
                    new_vol.material = old_vol.material
            new_model.mb.write_file(temp_h5m)

        # 9. Move to output path
        output_dir = Path(existing_h5m).parent
        base_name = Path(existing_h5m).stem
        output_path = str(output_dir / f'{base_name}_refaceted.h5m')

        if os.path.exists(output_path):
            os.unlink(output_path)
        shutil.move(temp_h5m, output_path)

        return {
            'success': True,
            'data': {
                'outputPath': output_path,
                'message': f'Re-faceted geometry saved to {Path(output_path).name}'
            },
            'warnings': warnings
        }
    except Exception as e:
        import traceback
        try:
            gmsh.finalize()
        except Exception:
            pass
        return {'success': False, 'error': str(e), 'traceback': traceback.format_exc()}


def main():
    """Main entry point for CLI usage.

    Dispatches to the appropriate editor function based on the
    first command-line argument.
    """
    if len(sys.argv) < 2:
        print(json.dumps({'success': False, 'error': 'No command specified'}))
        sys.exit(1)

    command = sys.argv[1]

    if command == 'load':
        if len(sys.argv) < 3:
            print(json.dumps({'success': False, 'error': 'No file path specified'}))
            sys.exit(1)
        result = load_model(sys.argv[2])
        print(json.dumps(result))

    elif command == 'assign_material':
        if len(sys.argv) < 5:
            print(json.dumps({'success': False, 'error': 'Insufficient arguments'}))
            sys.exit(1)
        file_path = sys.argv[2]
        volume_id = int(sys.argv[3])
        material_name = sys.argv[4]
        result = assign_material(file_path, volume_id, material_name)
        print(json.dumps(result))

    elif command == 'create_group':
        if len(sys.argv) < 4:
            print(json.dumps({'success': False, 'error': 'Insufficient arguments'}))
            sys.exit(1)
        file_path = sys.argv[2]
        group_name = sys.argv[3]
        volume_ids = [int(v) for v in sys.argv[4].split(',')] if len(sys.argv) > 4 and sys.argv[4] else None
        result = create_group(file_path, group_name, volume_ids)
        print(json.dumps(result))

    elif command == 'delete_group':
        if len(sys.argv) < 4:
            print(json.dumps({'success': False, 'error': 'Insufficient arguments'}))
            sys.exit(1)
        file_path = sys.argv[2]
        group_name = sys.argv[3]
        result = delete_group(file_path, group_name)
        print(json.dumps(result))

    elif command == 'add_to_group':
        if len(sys.argv) < 5:
            print(json.dumps({'success': False, 'error': 'Insufficient arguments'}))
            sys.exit(1)
        file_path = sys.argv[2]
        group_name = sys.argv[3]
        volume_ids = [int(v) for v in sys.argv[4].split(',')] if sys.argv[4] else []
        result = add_volumes_to_group(file_path, group_name, volume_ids)
        print(json.dumps(result))

    elif command == 'remove_from_group':
        if len(sys.argv) < 5:
            print(json.dumps({'success': False, 'error': 'Insufficient arguments'}))
            sys.exit(1)
        file_path = sys.argv[2]
        group_name = sys.argv[3]
        volume_ids = [int(v) for v in sys.argv[4].split(',')] if sys.argv[4] else []
        result = remove_volumes_from_group(file_path, group_name, volume_ids)
        print(json.dumps(result))

    elif command == 'get_faceting_params':
        if len(sys.argv) < 3:
            print(json.dumps({'success': False, 'error': 'No file path specified'}))
            sys.exit(1)
        result = get_faceting_params(sys.argv[2])
        print(json.dumps(result))

    elif command == 'estimate_triangles':
        if len(sys.argv) < 4:
            print(json.dumps({'success': False, 'error': 'Insufficient arguments'}))
            sys.exit(1)
        result = estimate_triangles(sys.argv[2], float(sys.argv[3]))
        print(json.dumps(result))

    elif command == 'refacet':
        if len(sys.argv) < 5:
            print(json.dumps({'success': False, 'error': 'Insufficient arguments'}))
            sys.exit(1)
        result = refacet(sys.argv[2], sys.argv[3], float(sys.argv[4]))
        print(json.dumps(result))

    else:
        print(json.dumps({'success': False, 'error': f'Unknown command: {command}'}))
        sys.exit(1)


if __name__ == '__main__':
    main()
