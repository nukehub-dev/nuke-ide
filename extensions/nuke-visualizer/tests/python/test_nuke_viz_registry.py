"""Tests for nuke_viz.registry — plugin auto-discovery."""

import sys
import textwrap

import plugins as plugins_pkg

from nuke_viz import plugin as plugin_mod
from nuke_viz.registry import (
    discover_plugins,
    discover_plugins_from_entry_points,
)


def _make_plugin(plugins_dir, name, plugin_py):
    """Create a fake ``plugins.<name>.plugin`` package under plugins_dir."""
    pkg_dir = plugins_dir / name
    pkg_dir.mkdir(parents=True)
    (pkg_dir / '__init__.py').write_text('')
    (pkg_dir / 'plugin.py').write_text(textwrap.dedent(plugin_py))
    return pkg_dir


def _drop_modules(monkeypatch, *names):
    """Ensure fresh imports for the given module names."""
    for name in names:
        monkeypatch.delitem(sys.modules, name, raising=False)


def test_discover_plugins_imports_and_registers(tmp_path, monkeypatch):
    """A plugin.py found in the scan dir is imported as plugins.<name>.plugin,
    triggering its @command registration side effects."""
    plugins_dir = tmp_path / 'plugins'
    _make_plugin(plugins_dir, 'discplug', '''
        from nuke_viz.plugin import command

        PLUGIN_NAME = "discplug"

        @command('test.discovered', help='fake discovered command')
        def cmd_discovered(args):
            return 0
    ''')

    monkeypatch.setattr(plugins_pkg, '__path__', [str(plugins_dir)])
    _drop_modules(monkeypatch, 'plugins.discplug', 'plugins.discplug.plugin')

    found = discover_plugins([str(plugins_dir)])

    assert found == ['discplug']
    assert 'test.discovered' in plugin_mod._COMMANDS


def test_discover_plugins_skips_dirs_without_plugin_py(tmp_path, monkeypatch):
    """Directories lacking a plugin.py file are ignored."""
    plugins_dir = tmp_path / 'plugins'
    (plugins_dir / 'noplugin').mkdir(parents=True)
    (plugins_dir / 'noplugin' / '__init__.py').write_text('')
    # A plain file (not a directory) must also be ignored.
    (plugins_dir / 'stray.py').write_text('')

    found = discover_plugins([str(plugins_dir)])

    assert found == []


def test_discover_plugins_nonexistent_dir_returns_empty():
    """A scan directory that does not exist yields no plugins."""
    assert discover_plugins(['/definitely/not/a/real/dir']) == []


def test_discover_plugins_broken_plugin_continues(tmp_path, monkeypatch, capsys):
    """A plugin that raises on import reports to stderr and does not
    prevent discovery of the remaining plugins."""
    plugins_dir = tmp_path / 'plugins'
    _make_plugin(plugins_dir, 'brokenplug', '''
        raise RuntimeError('boom on import')
    ''')
    _make_plugin(plugins_dir, 'goodplug', '''
        from nuke_viz.plugin import command

        @command('test.good', help='good fake command')
        def cmd_good(args):
            return 0
    ''')

    monkeypatch.setattr(plugins_pkg, '__path__', [str(plugins_dir)])
    _drop_modules(
        monkeypatch,
        'plugins.brokenplug', 'plugins.brokenplug.plugin',
        'plugins.goodplug', 'plugins.goodplug.plugin',
    )

    found = discover_plugins([str(plugins_dir)])

    assert 'goodplug' in found
    assert 'brokenplug' not in found
    assert 'test.good' in plugin_mod._COMMANDS

    err = capsys.readouterr().err
    assert "[PluginRegistry] Failed to load plugin 'brokenplug': boom on import" in err


def test_discover_plugins_from_entry_points_does_not_crash():
    """Entry-point discovery returns a list even when no entry points exist."""
    found = discover_plugins_from_entry_points()
    assert isinstance(found, list)
