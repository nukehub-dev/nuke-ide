"""Base visualizer plugin for NukeIDE."""

from nuke_viz.plugin import load_command_modules

# Import command modules — this triggers @command registration.
# Modules that fail to import (missing optional dependencies) are skipped and
# logged via nuke_viz.logging, never printed raw to stderr.
_COMMAND_MODULES = ["serve", "convert", "dagmc"]

load_command_modules("plugins.base.commands", _COMMAND_MODULES)

# Plugin metadata
PLUGIN_NAME = "base"
PLUGIN_DISPLAY_NAME = "Base Visualizer"
REQUIREMENTS = ["trame", "paraview"]
