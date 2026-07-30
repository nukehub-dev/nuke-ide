"""Particle restart reader command (particle_restart.h5 / particle_<batch>_<id>.h5)."""

import json

from nuke_viz.plugin import arg, command


@command("openmc.particle-restart", help="Read a particle restart file")
@arg("file", help="Path to particle_restart.h5 (or particle_<batch>_<id>.h5)")
def cmd_particle_restart(args):
    """Read an OpenMC particle restart file (lost-particle state)."""
    from plugins.openmc.lib import output_readers

    try:
        result = output_readers.read_particle_restart(args.file)
        print(json.dumps(result, default=output_readers.json_default))
        return 0
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        return 1
