"""OpenMC visualization plugin for NukeIDE."""

from nuke_viz.plugin import load_command_modules

# Import all command modules — this triggers @command registration.
# Modules that fail to import (missing optional dependencies) are skipped and
# logged via nuke_viz.logging, never printed raw to stderr.
_COMMAND_MODULES = [
    "basic",
    "spectrum",
    "geometry",
    "materials",
    "depletion",
    "xs_plot",
    "statepoint",
    "tally_viz",
    "tracks",
    "collision_track",
    "weight_windows",
    "kinetics",
    "particle_restart",
    "nuclear_data",
    "output_vtk",
]

load_command_modules("plugins.openmc.commands", _COMMAND_MODULES)

# Plugin metadata (used by registry for discovery)
PLUGIN_NAME = "openmc"
PLUGIN_DISPLAY_NAME = "OpenMC"
REQUIREMENTS = ["openmc", "h5py", "numpy"]
