"""
Depletion result commands.
"""

import json
import sys


def cmd_depletion_summary(args):
    """Get summary of depletion results."""
    try:
        from openmc_integration import OpenMCDepletionReader
        reader = OpenMCDepletionReader()
        summary = reader.load_summary(args.file)
        print(json.dumps(summary))
        return 0
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        return 1


def cmd_depletion_materials(args):
    """List materials in depletion results."""
    try:
        from openmc_integration import OpenMCDepletionReader
        reader = OpenMCDepletionReader()
        materials = reader.list_materials(args.file)
        print(json.dumps({"materials": materials}))
        return 0
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        return 1


def cmd_depletion_data(args):
    """Get depletion data for a specific material."""
    try:
        from openmc_integration import OpenMCDepletionReader
        reader = OpenMCDepletionReader()
        
        nuclide_filter = None
        if args.nuclides:
            nuclide_filter = [n.strip() for n in args.nuclides.split(',')]
        
        data = reader.load_material_data(args.file, args.material_index, nuclide_filter)
        summary = reader.load_summary(args.file)
        
        print(json.dumps({"summary": summary, "materialData": data}))
        return 0
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        return 1
