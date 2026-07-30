"""Kinetics parameters command (IFP tallies from a statepoint)."""

import json

from nuke_viz.plugin import arg, command


@command("openmc.kinetics", help="Get IFP kinetics parameters (beta_eff, Lambda_eff)")
@arg("statepoint", help="Path to statepoint file with IFP tallies")
def cmd_kinetics(args):
    """Get effective kinetics parameters from a statepoint's IFP tallies."""
    from plugins.openmc.lib import output_readers

    try:
        result = output_readers.read_kinetics(args.statepoint)
        print(json.dumps(result, default=output_readers.json_default))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1
