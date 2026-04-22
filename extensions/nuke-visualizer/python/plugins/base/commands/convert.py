"""
Base visualizer file-format conversion commands.

Provides CLI commands for converting DAGMC and CAD files to VTK.
These are invoked via: python server.py base.convert-dagmc --file <path>
"""

import sys
import os

from nuke_viz.plugin import command, arg


@command('base.convert-dagmc', help='Convert a DAGMC .h5m file to VTK')
@arg('--file', required=True, help='Path to the input .h5m file')
@arg('--volume', type=int, help='Extract only a specific volume ID')
def cmd_convert_dagmc(args):
    """Convert DAGMC H5M to VTK."""
    try:
        from plugins.base.lib.dagmc import convert_h5m_to_vtk_cached, convert_h5m_volume_to_vtk
    except ImportError as e:
        print(f'{{"error": "DAGMC library not available: {e}"}}', file=sys.stderr)
        return 1

    import json

    if args.volume is not None:
        try:
            output_path = convert_h5m_volume_to_vtk(args.file, args.volume)
            result = {
                'vtk_path': output_path,
                'from_cache': False,
                'volume_id': args.volume
            }
        except Exception as e:
            print(f'{{"error": "{str(e)}"}}', file=sys.stderr)
            return 1
    else:
        try:
            result = convert_h5m_to_vtk_cached(
                args.file,
                use_cache=True,
                do_filter_graveyard=True,
                max_cell_area=100.0
            )
        except Exception as e:
            print(f'{{"error": "{str(e)}"}}', file=sys.stderr)
            return 1

    print(json.dumps(result))
    return 0


@command('base.convert-step', help='Convert a STEP/STP/BREP file to VTK')
@arg('--file', required=True, help='Path to the input STEP/STP/BREP file')
@arg('--mesh-size', type=float, default=10.0, help='Maximum mesh element size')
def cmd_convert_step(args):
    """Convert STEP/STP/BREP to VTK via gmsh."""
    try:
        from plugins.base.lib.step import convert_step_to_vtk_cached
    except ImportError as e:
        print(f'{{"error": "STEP library not available: {e}"}}', file=sys.stderr)
        return 1

    import json

    try:
        result = convert_step_to_vtk_cached(
            args.file,
            use_cache=True,
            mesh_size_max=args.mesh_size
        )
    except Exception as e:
        print(f'{{"error": "{str(e)}"}}', file=sys.stderr)
        return 1

    print(json.dumps(result))
    return 0
