"""Base visualizer plugin for NukeIDE."""

# Import command modules — this triggers @command registration
from .commands import serve

# Plugin metadata
PLUGIN_NAME = "base"
PLUGIN_DISPLAY_NAME = "Base Visualizer"
REQUIREMENTS = ["trame", "paraview"]
