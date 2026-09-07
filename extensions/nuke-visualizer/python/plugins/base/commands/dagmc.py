"""
DAGMC visualization and info commands.

Provides CLI commands for DAGMC model inspection and interactive visualization.
These are invoked via: python server.py dagmc.info --file <path>
"""

import json
import sys

from nuke_viz.plugin import arg, command


@command("dagmc.info", help="Get DAGMC model metadata (volumes, materials, groups)")
@arg("--file", required=True, help="Path to the input .h5m file")
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
