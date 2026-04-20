"""
Geometry analysis and visualization commands.
"""

import json
import sys
from nuke_viz.plugin import command, arg


@command('openmc.geometry', help='Get geometry hierarchy')
@arg('file', help='Path to geometry.xml')
def cmd_geometry(args):
    """Get geometry hierarchy from OpenMC geometry file."""
    try:
        from plugins.openmc.lib.geometry_parser import parse_geometry
        result = parse_geometry(args.file)
        print(json.dumps(result))
        return 0 if 'error' not in result else 1
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        return 1


@command('openmc.visualize-geometry', help='Visualize OpenMC geometry')
@arg('file', help='Path to geometry.xml')
@arg('--port', type=int, help='Server port')
@arg('--highlight', help='Cell ID(s) to highlight (comma-separated)')
@arg('--overlaps', help='Path to JSON file with overlap markers')
def cmd_visualize_geometry(args):
    """Visualize OpenMC geometry in 3D."""
    try:
        from plugins.openmc.lib.geometry_viz import visualize_geometry
        
        highlight_ids = None
        if args.highlight:
            # Handle both single int and comma-separated string
            if isinstance(args.highlight, str):
                highlight_ids = [int(x.strip()) for x in args.highlight.split(',')]
            else:
                highlight_ids = [int(args.highlight)]
                
        return visualize_geometry(args.file, args.port, highlight_ids, args.overlaps)
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        return 1


@command('openmc.check-overlaps', help='Check for geometry overlaps')
@arg('geometry', help='Path to geometry.xml or Python model')
@arg('--samples', type=int, default=100000, help='Number of sample points')
@arg('--tolerance', type=float, default=1e-6, help='Numerical tolerance')
@arg('--bounds', help='Bounding box as JSON')
@arg('--parallel', action='store_true', help='Use parallel processing')
def cmd_check_overlaps(args):
    """Check for geometry overlaps."""
    try:
        from plugins.openmc.lib.overlap import check_overlaps
        
        # Parse bounding box if provided
        bounds = None
        if args.bounds:
            try:
                bounds = json.loads(args.bounds)
            except json.JSONDecodeError as e:
                print(json.dumps({"error": f"Invalid bounds JSON: {e}"}))
                return 1
        
        result = check_overlaps(
            geometry_path=args.geometry,
            sample_points=args.samples,
            tolerance=args.tolerance,
            bounds=bounds,
            parallel=args.parallel
        )
        print(json.dumps(result))
        return 0 if result.get('error') is None else 1
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"overlaps": [], "totalOverlaps": 0, "error": str(e)}))
        return 1


@command('openmc.overlap-viz', help='Get overlap visualization data')
@arg('geometry', help='Path to geometry.xml')
@arg('--overlaps', required=True, help='Overlaps JSON array')
@arg('--marker-size', type=float, default=1.0, help='Marker size in cm')
def cmd_overlap_viz(args):
    """Get visualization data for overlaps."""
    try:
        from plugins.openmc.lib.overlap import get_overlap_viz_data
        
        # Parse overlaps JSON
        try:
            overlaps = json.loads(args.overlaps)
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"Invalid overlaps JSON: {e}"}))
            return 1
        
        result = get_overlap_viz_data(
            geometry_path=args.geometry,
            overlaps=overlaps,
            marker_size=args.marker_size
        )
        print(json.dumps(result))
        return 0 if result.get('error') is None else 1
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"markers": [], "overlappingCellIds": [], "error": str(e)}))
        return 1
