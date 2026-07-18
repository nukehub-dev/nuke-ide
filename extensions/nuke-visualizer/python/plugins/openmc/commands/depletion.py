"""
Depletion result commands.
"""

import json
import sys

from nuke_viz.plugin import arg, command


@command("openmc.depletion-summary", help="Get depletion summary")
@arg("file", help="Path to depletion_results.h5")
def cmd_depletion_summary(args):
    """Get summary of depletion results."""
    try:
        from plugins.openmc.lib.reader import OpenMCDepletionReader

        reader = OpenMCDepletionReader()
        summary = reader.load_summary(args.file)
        print(json.dumps(summary))
        return 0
    except Exception as e:
        import traceback

        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        return 1


@command("openmc.depletion-materials", help="List materials in depletion results")
@arg("file", help="Path to depletion_results.h5")
def cmd_depletion_materials(args):
    """List materials in depletion results."""
    try:
        from plugins.openmc.lib.reader import OpenMCDepletionReader

        reader = OpenMCDepletionReader()
        materials = reader.list_materials(args.file)
        print(json.dumps({"materials": materials}))
        return 0
    except Exception as e:
        import traceback

        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        return 1


@command("openmc.depletion-data", help="Get depletion data for material")
@arg("file", help="Path to depletion_results.h5")
@arg("material_index", type=int, help="Material index")
@arg("--nuclides", help="Comma-separated nuclide list")
def cmd_depletion_data(args):
    """Get depletion data for a specific material."""
    try:
        from plugins.openmc.lib.reader import OpenMCDepletionReader

        reader = OpenMCDepletionReader()

        nuclide_filter = None
        if args.nuclides:
            nuclide_filter = [n.strip() for n in args.nuclides.split(",")]

        data = reader.load_material_data(args.file, args.material_index, nuclide_filter)
        summary = reader.load_summary(args.file)

        print(json.dumps({"summary": summary, "materialData": data}))
        return 0
    except Exception as e:
        import traceback

        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        return 1
