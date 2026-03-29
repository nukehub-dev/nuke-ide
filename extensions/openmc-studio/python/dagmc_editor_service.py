#!/usr/bin/env python3
"""
DAGMC Editor Service

Backend service for DAGMC file editing using pydagmc.
"""

import sys
import json
import os
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


def load_model(file_path: str) -> dict:
    """Load a DAGMC file and return model information."""
    try:
        model = Model(file_path)
        
        # Build volumes list
        volumes = []
        total_triangles = 0
        
        for vol in model.volumes:
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
                except:
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
    """Assign a material to a volume and save the file."""
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
    """Create a new group with optional volumes."""
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
    """Delete a group from the model."""
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
    """Add volumes to an existing group."""
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
    """Remove volumes from a group."""
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


def main():
    """Main entry point for CLI usage."""
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
    
    else:
        print(json.dumps({'success': False, 'error': f'Unknown command: {command}'}))
        sys.exit(1)


if __name__ == '__main__':
    main()
