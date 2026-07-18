"""OpenMC visualization plugin for NukeIDE."""

import sys

# Import all command modules — this triggers @command registration.
# We catch import errors so missing optional dependencies don't break
# the entire plugin.
_COMMAND_MODULES = [
    "basic",
    "spectrum",
    "geometry",
    "materials",
    "depletion",
    "xs_plot",
    "statepoint",
    "tally_viz",
]

for mod_name in _COMMAND_MODULES:
    try:
        __import__(f"plugins.openmc.commands.{mod_name}")
    except Exception as e:
        print(f"[OpenMC Plugin] Command module '{mod_name}' not loaded: {e}", file=sys.stderr)

# Plugin metadata (used by registry for discovery)
PLUGIN_NAME = "openmc"
PLUGIN_DISPLAY_NAME = "OpenMC"
REQUIREMENTS = ["openmc", "h5py", "numpy"]
