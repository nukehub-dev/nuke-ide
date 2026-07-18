"""Tests for nuke_viz.plugin — the @command/@arg decorator framework."""

import argparse

from nuke_viz import plugin as plugin_mod
from nuke_viz.plugin import (
    Plugin,
    arg,
    command,
    get_commands,
    setup_parser_for_handler,
    unregister_command,
)


def test_command_registers_in_global_registry():
    """@command stores the handler in _COMMANDS under the given name."""

    @command("test.sample", help="a sample command")
    def cmd_sample(args):
        return 0

    assert plugin_mod._COMMANDS["test.sample"] is cmd_sample


def test_command_sets_metadata_attributes():
    """@command sets _command_name and _command_help on the function."""

    @command("test.meta", help="some help text")
    def cmd_meta(args):
        return 0

    assert cmd_meta._command_name == "test.meta"
    assert cmd_meta._command_help == "some help text"


def test_command_help_defaults_to_empty_string():
    """Omitting help= leaves an empty _command_help."""

    @command("test.nohelp")
    def cmd_nohelp(args):
        return 0

    assert cmd_nohelp._command_help == ""


def test_arg_stacks_tuples_bottom_up():
    """Stacked @arg decorators append (args, kwargs) tuples bottom-up,
    because Python applies decorators bottom-up."""

    @command("test.stacked")
    @arg("first", help="declared first")
    @arg("--second", type=int, help="declared second")
    def cmd_stacked(args):
        return 0

    assert cmd_stacked._command_args == [
        (("--second",), {"type": int, "help": "declared second"}),
        (("first",), {"help": "declared first"}),
    ]


def test_setup_parser_replays_args_in_declaration_order():
    """setup_parser_for_handler reverses the stored list so arguments
    are added to the parser in original top-down declaration order."""

    @command("test.order")
    @arg("alpha")
    @arg("beta")
    def cmd_order(args):
        return 0

    parser = argparse.ArgumentParser()
    setup_parser_for_handler(cmd_order, parser)
    ns = parser.parse_args(["A", "B"])

    # If the replay order were wrong, 'alpha' would receive 'B'.
    assert ns.alpha == "A"
    assert ns.beta == "B"


def test_setup_parser_applies_argument_options():
    """Keyword options from @arg (type, default, choices) reach argparse."""

    @command("test.opts")
    @arg("statepoint")
    @arg("--port", type=int, default=8080)
    @arg("--theme", choices=["dark", "light"], default="dark")
    def cmd_opts(args):
        return 0

    parser = argparse.ArgumentParser()
    setup_parser_for_handler(cmd_opts, parser)

    ns = parser.parse_args(["model.h5"])
    assert ns.statepoint == "model.h5"
    assert ns.port == 8080
    assert ns.theme == "dark"

    ns = parser.parse_args(["model.h5", "--port", "9000", "--theme", "light"])
    assert ns.port == 9000
    assert ns.theme == "light"


def test_setup_parser_calls_custom_setup_hook():
    """A _setup_parser attribute on the handler is invoked after @arg replay."""

    @command("test.hook")
    @arg("positional_arg")
    def cmd_hook(args):
        return 0

    def _setup(subparser):
        subparser.add_argument("--extra", action="store_true")

    cmd_hook._setup_parser = _setup

    parser = argparse.ArgumentParser()
    setup_parser_for_handler(cmd_hook, parser)
    ns = parser.parse_args(["value", "--extra"])

    assert ns.positional_arg == "value"
    assert ns.extra is True


def test_get_commands_returns_copy():
    """Mutating the dict returned by get_commands() must not affect the registry."""

    @command("test.copyable")
    def cmd_copyable(args):
        return 0

    commands = get_commands()
    assert "test.copyable" in commands

    commands["test.injected"] = lambda args: 1
    del commands["test.copyable"]

    assert "test.injected" not in plugin_mod._COMMANDS
    assert "test.copyable" in plugin_mod._COMMANDS


def test_unregister_command():
    """unregister_command removes existing commands and reports existence."""

    @command("test.removable")
    def cmd_removable(args):
        return 0

    assert unregister_command("test.removable") is True
    assert "test.removable" not in plugin_mod._COMMANDS
    assert unregister_command("test.removable") is False
    assert unregister_command("test.never-registered") is False


def test_plugin_base_class_defaults():
    """The Plugin base class ships empty metadata defaults."""
    assert Plugin.PLUGIN_NAME == ""
    assert Plugin.PLUGIN_DISPLAY_NAME == ""
    assert Plugin.REQUIREMENTS == []
    # register() is a no-op classmethod by default
    assert Plugin.register() is None


def test_plugin_subclass_overrides_do_not_touch_base():
    """Subclass metadata overrides leave the base class attributes intact."""

    class MyPlugin(Plugin):
        PLUGIN_NAME = "mine"
        REQUIREMENTS = ["numpy"]

    assert MyPlugin.PLUGIN_NAME == "mine"
    assert Plugin.PLUGIN_NAME == ""
    assert Plugin.REQUIREMENTS == []
