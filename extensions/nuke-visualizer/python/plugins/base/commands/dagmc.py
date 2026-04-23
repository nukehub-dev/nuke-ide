"""
DAGMC visualization and info commands.

Provides CLI commands for DAGMC model inspection and interactive visualization.
These are invoked via: python server.py dagmc.info --file <path>
"""

import sys
import json

from nuke_viz.plugin import command, arg


@command('dagmc.info', help='Get DAGMC model metadata (volumes, materials, groups)')
@arg('--file', required=True, help='Path to the input .h5m file')
def cmd_dagmc_info(args):
    """Extract metadata from a DAGMC .h5m file."""
    try:
        from plugins.base.lib.dagmc import get_dagmc_model_info
    except ImportError as e:
        print(f'{{"error": "DAGMC library not available: {e}"}}', file=sys.stderr)
        return 1

    try:
        result = get_dagmc_model_info(args.file)
        print(json.dumps(result))
        return 0
    except Exception as e:
        print(f'{{"error": "{str(e)}"}}', file=sys.stderr)
        return 1


@command('dagmc.visualize', help='Visualize a DAGMC .h5m file with volume/material/group selection')
@arg('--file', required=True, help='Path to the input .h5m file')
@arg('--port', type=int, help='Server port')
@arg('--theme', type=str, default='dark', choices=['dark', 'light'], help='UI theme')
@arg('--highlight', help='Volume ID(s) to highlight (comma-separated)')
def cmd_dagmc_visualize(args):
    """Start an interactive DAGMC visualization server."""
    try:
        from plugins.base.lib.dagmc_viz import visualize_dagmc
    except ImportError as e:
        print(f'{{"error": "DAGMC visualization library not available: {e}"}}', file=sys.stderr)
        return 1

    highlight_ids = None
    if args.highlight:
        if isinstance(args.highlight, str):
            highlight_ids = [int(x.strip()) for x in args.highlight.split(',')]
        else:
            highlight_ids = [int(args.highlight)]

    return visualize_dagmc(args.file, args.port, args.theme, highlight_ids)
