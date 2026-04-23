"""Base visualizer plugin for NukeIDE."""

import sys

# Import command modules — this triggers @command registration.
# We catch import errors so missing optional dependencies don't break
# the entire plugin.
_COMMAND_MODULES = ['serve', 'convert', 'dagmc']

for mod_name in _COMMAND_MODULES:
    try:
        __import__(f'plugins.base.commands.{mod_name}')
    except Exception as e:
        print(f"[Base Plugin] Command module '{mod_name}' not loaded: {e}", file=sys.stderr)

# Plugin metadata
PLUGIN_NAME = "base"
PLUGIN_DISPLAY_NAME = "Base Visualizer"
REQUIREMENTS = ["trame", "paraview"]
