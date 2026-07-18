#!/usr/bin/env python3
"""
NukeIDE Visualization Server — unified entry point for all plugins.

Usage:
    python server.py <command> [args...]

Examples:
    python server.py openmc.info statepoint.h5
    python server.py openmc.visualize-mesh statepoint.h5 1 --port 8090
    python server.py base.serve --file model.vtk --port 8080
"""

import argparse
import os
import sys

# Ensure the directory containing this script is on sys.path so that
# 'nuke_viz' and 'plugins' packages are importable.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from nuke_viz.plugin import get_commands, setup_parser_for_handler
from nuke_viz.registry import discover_plugins


def main():
    # 1. Auto-discover all plugins (this triggers @command registration)
    discover_plugins()

    # 2. Build argparse from registered commands
    parser = argparse.ArgumentParser(
        description="NukeIDE Visualization Server — unified entry point for all plugins."
    )
    subparsers = parser.add_subparsers(dest="command")

    commands = get_commands()
    for name, handler in commands.items():
        sub = subparsers.add_parser(name, help=getattr(handler, "_command_help", ""))
        setup_parser_for_handler(handler, sub)

    args = parser.parse_args()

    # No command given: print help. (An unrecognized command never reaches
    # here — argparse rejects it with exit code 2.)
    if not args.command:
        parser.print_help()
        return 1

    # 3. Route to handler
    return commands[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
