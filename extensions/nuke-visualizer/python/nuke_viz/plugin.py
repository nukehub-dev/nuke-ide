"""
Plugin framework for NukeIDE visualization commands.

Provides the @command and @arg decorators for registering CLI commands,
plus a Plugin base class for organizing commands into plugins.
"""

import argparse
from collections.abc import Callable

# Global command registry
_COMMANDS: dict[str, Callable] = {}


def command(name: str, help: str = ""):
    """Register a CLI command. Call this on any handler function.

    The decorated function should accept a single `args` argument
    (an argparse.Namespace) and return an integer exit code.

    Example:
        @command('openmc.info', help='Get statepoint info')
        def cmd_info(args):
            ...
            return 0
    """

    def decorator(fn: Callable) -> Callable:
        fn._command_name = name
        fn._command_help = help
        fn._command_args: list[tuple[tuple, dict]] = getattr(fn, "_command_args", [])
        _COMMANDS[name] = fn
        return fn

    return decorator


def arg(*args_, **kwargs):
    """Add an argument to a command's argparse subparser.

    Can be stacked multiple times on a single handler.

    Example:
        @command('openmc.visualize-mesh', help='Visualize mesh tally')
        @arg('statepoint', help='Path to statepoint file')
        @arg('--port', type=int, help='Server port')
        def cmd_visualize_mesh(args):
            ...
    """

    def decorator(fn: Callable) -> Callable:
        if not hasattr(fn, "_command_args"):
            fn._command_args = []
        fn._command_args.append((args_, kwargs))
        return fn

    return decorator


def get_commands() -> dict[str, Callable]:
    """Return a copy of the registered commands dictionary."""
    return _COMMANDS.copy()


def unregister_command(name: str) -> bool:
    """Remove a command from the registry. Returns True if it existed."""
    if name in _COMMANDS:
        del _COMMANDS[name]
        return True
    return False


def setup_parser_for_handler(handler: Callable, subparser: argparse.ArgumentParser) -> None:
    """Configure an argparse subparser from a handler's metadata.

    Uses @arg decorators and/or a _setup_parser hook on the handler.
    Because Python evaluates decorators bottom-up, we reverse the stored
    list to restore the original top-down declaration order.
    """
    # Apply @arg decorators in original declaration order
    for args, kwargs in reversed(getattr(handler, "_command_args", [])):
        subparser.add_argument(*args, **kwargs)

    # Call custom setup hook if present
    if hasattr(handler, "_setup_parser"):
        handler._setup_parser(subparser)


class Plugin:
    """Base class for NukeIDE visualization plugins.

    Plugins organize commands and provide metadata. Subclass this
    and set class attributes, or just use @command/@arg decorators
    directly in command modules.
    """

    PLUGIN_NAME: str = ""
    PLUGIN_DISPLAY_NAME: str = ""
    REQUIREMENTS: list[str] = []

    @classmethod
    def register(cls) -> None:
        """Trigger registration of all commands in this plugin.

        Override to perform any custom import or setup logic.
        By default, importing command modules triggers @command registration.
        """
        pass
