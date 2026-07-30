"""Weight windows reader command (weight_windows.h5)."""

import json

from nuke_viz.plugin import arg, command


@command("openmc.weight-windows", help="Read weight windows file")
@arg("file", help="Path to weight_windows.h5")
def cmd_weight_windows(args):
    """Read an OpenMC weight windows file (meshes + bounds)."""
    from plugins.openmc.lib import output_readers

    try:
        result = output_readers.read_weight_windows(args.file)
        print(json.dumps(result, default=output_readers.json_default))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1
