"""
Auto-discovery registry for NukeIDE visualization plugins.

Scans the plugins/ directory and imports each plugin's plugin.py,
triggering @command registration automatically.
"""

import importlib
import os
import sys

# Path to the plugins directory, relative to this file
_PLUGINS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "plugins")


def discover_plugins(plugin_dirs: list[str] = None) -> list[str]:
    """Scan plugin directories and import each plugin's plugin.py.

    Returns a list of discovered plugin names.
    Importing plugin.py triggers @command registration side effects.
    """
    discovered: list[str] = []
    dirs = plugin_dirs or [_PLUGINS_DIR]

    for plugins_dir in dirs:
        if not os.path.isdir(plugins_dir):
            continue

        for name in os.listdir(plugins_dir):
            plugin_path = os.path.join(plugins_dir, name, "plugin.py")
            if os.path.isfile(plugin_path):
                module_name = f"plugins.{name}.plugin"
                try:
                    importlib.import_module(module_name)
                    discovered.append(name)
                except Exception as e:
                    print(f"[PluginRegistry] Failed to load plugin '{name}': {e}", file=sys.stderr)

    return discovered


def discover_plugins_from_entry_points() -> list[str]:
    """Discover plugins via Python entry points (future extension).

    Plugins can register themselves by providing an entry point
    under the group 'nuke_viz.plugins'.
    """
    discovered: list[str] = []
    try:
        import importlib.metadata as metadata

        eps = metadata.entry_points()
        if hasattr(eps, "select"):
            group = eps.select(group="nuke_viz.plugins")
        else:
            group = eps.get("nuke_viz.plugins", [])
        for ep in group:
            try:
                ep.load()
                discovered.append(ep.name)
            except Exception as e:
                print(
                    f"[PluginRegistry] Failed to load entry-point plugin '{ep.name}': {e}",
                    file=sys.stderr,
                )
    except ImportError:
        pass  # importlib.metadata not available on older Python
    return discovered
