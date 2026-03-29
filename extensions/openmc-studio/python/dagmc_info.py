#!/usr/bin/env python3
"""
DAGMC file info extractor for OpenMC Studio using pydagmc.

Extracts detailed information from DAGMC .h5m files for display in the UI.
Uses pydagmc (built on PyMOAB) for high-level DAGMC model access.
"""

import sys
import json
import argparse
from pathlib import Path


def get_dagmc_info(h5m_path: str):
    """Extract detailed information from a DAGMC file using pydagmc."""
    try:
        import pydagmc
    except ImportError:
        return {
            'success': False,
            'error': 'pydagmc not available. Install with: pip install pydagmc'
        }
    
    h5m_path = Path(h5m_path)
    if not h5m_path.exists():
        return {'success': False, 'error': f'File not found: {h5m_path}'}
    
    try:
        # Load the model
        model = pydagmc.Model(str(h5m_path))
        
        # Get file info
        file_stat = h5m_path.stat()
        
        # Collect volume information
        volumes = []
        for vol in model.volumes:
            # Get bounding box if available
            try:
                bounds = vol.bounds
                # bounds is (min_array, max_array)
                bbox = {
                    'min': [float(x) for x in bounds[0]],
                    'max': [float(x) for x in bounds[1]]
                }
            except:
                bbox = None
            
            volumes.append({
                'id': int(vol.id),
                'material': vol.material or 'void',
                'numTriangles': int(vol.num_triangles),
                'boundingBox': bbox
            })
        
        # Collect surface information
        surfaces = []
        total_area = 0.0
        for surf in model.surfaces:
            try:
                area = float(surf.area)
                total_area += area
            except:
                area = 0.0
            
            surfaces.append({
                'id': int(surf.id),
                'area': round(area, 2),
                'numTriangles': int(surf.num_triangles)
            })
        
        # Get materials
        materials = {}
        for mat_name, vols in model.volumes_by_material.items():
            materials[mat_name] = {
                'volumeCount': len(vols),
                'totalTriangles': sum(v.num_triangles for v in vols)
            }
        
        # Get groups
        groups = list(model.group_names)
        
        # Calculate overall bounding box
        if model.volumes:
            all_bounds = [v.bounds for v in model.volumes if v.bounds is not None]
            if all_bounds:
                import numpy as np
                # bounds is a tuple of (min_array, max_array)
                mins = np.array([b[0] for b in all_bounds])
                maxs = np.array([b[1] for b in all_bounds])
                overall_bbox = {
                    'min': mins.min(axis=0).tolist(),
                    'max': maxs.max(axis=0).tolist()
                }
            else:
                overall_bbox = {'min': [0, 0, 0], 'max': [0, 0, 0]}
        else:
            overall_bbox = {'min': [0, 0, 0], 'max': [0, 0, 0]}
        
        # Count total triangles
        total_triangles = sum(v.num_triangles for v in model.volumes)
        
        return {
            'success': True,
            'fileName': h5m_path.name,
            'fileSize': file_stat.st_size,
            'fileSizeMB': round(file_stat.st_size / (1024 * 1024), 2),
            'volumes': volumes,
            'volumeCount': len(volumes),
            'surfaces': surfaces,
            'surfaceCount': len(surfaces),
            'totalTriangles': int(total_triangles),
            'totalSurfaceArea': round(total_area, 2),
            'materials': materials,
            'groups': groups,
            'boundingBox': overall_bbox
        }
        
    except Exception as e:
        import traceback
        return {
            'success': False,
            'error': f'Error reading DAGMC file: {str(e)}',
            'traceback': traceback.format_exc()
        }


def main():
    parser = argparse.ArgumentParser(description='Get DAGMC file info using pydagmc')
    parser.add_argument('input_file', help='Input DAGMC .h5m file')
    parser.add_argument('--output-json', action='store_true', help='Output as JSON')
    
    args = parser.parse_args()
    
    result = get_dagmc_info(args.input_file)
    
    if args.output_json:
        # Output compact JSON on a single line for easy parsing
        print(json.dumps(result))
    else:
        if result['success']:
            print(f"DAGMC File: {result['fileName']}")
            print(f"  File Size: {result['fileSizeMB']} MB")
            print(f"  Volumes: {result['volumeCount']}")
            print(f"  Surfaces: {result['surfaceCount']}")
            print(f"  Total Triangles: {result['totalTriangles']:,}")
            print(f"  Total Surface Area: {result['totalSurfaceArea']:.2f} cm²")
            print(f"\n  Materials:")
            for mat, info in result['materials'].items():
                print(f"    {mat}: {info['volumeCount']} volumes, {info['totalTriangles']:,} triangles")
            print(f"\n  Bounding Box:")
            print(f"    Min: {result['boundingBox']['min']}")
            print(f"    Max: {result['boundingBox']['max']}")
        else:
            print(f"Error: {result['error']}")
            if 'traceback' in result:
                print(f"\nTraceback:\n{result['traceback']}")
            sys.exit(1)


if __name__ == '__main__':
    main()
