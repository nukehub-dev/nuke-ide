# Python Backends

Python scripts in `python/` do the actual scientific work. This document covers conventions, patterns, and gotchas for writing and integrating Python backends using the **plugin framework**.

---

## Plugin Framework Overview

Instead of monolithic server scripts with manual argparse routing, the Python backend uses a **declarative plugin framework**:

- **`@command`** — registers a CLI command by name
- **`@arg`** — adds arguments to the command's argparse subparser
- **`registry.discover_plugins()`** — auto-imports all plugins and triggers registration
- **`server.py`** — unified entry point that builds argparse from registered commands

This means adding a new command is just decorating a function. No edits to central routers.

---

## Script Discovery

Never hardcode paths. Use `PythonCommandHelper.findScript()`:

```typescript
const scriptPath = this.pythonHelper.findScript('server.py');
```

This resolves to:

1. `lib/python/server.py` (production build)
2. `src/python/server.py` (development)
3. Fallback relative to `__dirname`

All operations — file converters, data queries — go through the unified `server.py` entry point.

---

## Writing a Command

Commands are plain functions decorated with `@command` and `@arg`:

```python
# python/plugins/myplugin/commands/example.py
from nuke_viz.plugin import command, arg
import json

@command('myplugin.greet', help='Say hello')
@arg('name', help='Who to greet')
@arg('--loud', action='store_true', help='Use uppercase')
def cmd_greet(args):
    message = f"Hello, {args.name}!"
    if args.loud:
        message = message.upper()
    print(json.dumps({"message": message}))
    return 0
```

### Rules

- The function receives one argument: `args` (an `argparse.Namespace`).
- Return an integer exit code (`0` for success).
- Output **JSON to stdout** for data responses.
- Report errors as one JSON `{"error": ...}` object and exit 1, never a traceback — base-plugin commands emit it on stderr, OpenMC-plugin commands on stdout; the node side parses stdout first (`executeCommandJson`).
- Use `@arg` decorators in the order you want positional arguments to appear.

### Argument Order

Python evaluates decorators **bottom-up**, so declare positional arguments **top-down**:

```python
@command('openmc.spectrum', help='Get energy spectrum data')
@arg('statepoint', help='Path to statepoint file')      # first positional
@arg('tally_id', type=int, help='Tally ID')             # second positional
@arg('--score-index', help='Score index')               # optional flag
@arg('--nuclide-index', help='Nuclide index')           # optional flag
def cmd_spectrum(args):
    ...
```

This produces `usage: server.py openmc.spectrum statepoint tally_id [--score-index ...]`.

---

## Creating a Plugin

A plugin is a self-contained package under `python/plugins/<name>/`.

### Minimal Plugin Structure

```
python/plugins/myplugin/
├── __init__.py
├── plugin.py              # Imports commands, triggers registration
├── commands/
│   ├── __init__.py
│   └── example.py         # @command-decorated handlers
└── lib/
    ├── __init__.py
    └── helpers.py         # Reusable helpers (optional)
```

### `plugin.py`

Import all command modules to trigger `@command` registration:

```python
# python/plugins/myplugin/plugin.py
"""MyPlugin visualization plugin for NukeIDE."""

from .commands import example

PLUGIN_NAME = "myplugin"
PLUGIN_DISPLAY_NAME = "My Plugin"
REQUIREMENTS = ["numpy"]
```

### Graceful Dependency Handling

If a command module requires heavy dependencies (e.g., `openmc`, `vtk`), wrap imports in `try/except` at the plugin level so missing deps don't break the entire plugin:

```python
# python/plugins/openmc/plugin.py
_COMMAND_MODULES = ['basic', 'spectrum', 'geometry', ...]

for mod_name in _COMMAND_MODULES:
    try:
        __import__(f'plugins.openmc.commands.{mod_name}')
    except Exception as e:
        print(f"[OpenMC Plugin] '{mod_name}' not loaded: {e}", file=sys.stderr)
```

---

## Headless Commands (No Servers)

Commands run, print JSON, and exit. Nothing binds a port and nothing serves HTTP — the frontend renders converted files natively. A converter looks like any other command:

```python
# python/plugins/base/commands/convert.py
from nuke_viz.plugin import command, arg

@command('base.convert-step', help='Convert STEP to VTK')
@arg('--file', required=True, help='Input file path')
def cmd_convert_step(args):
    from plugins.base.lib.step import convert_step_to_vtk_cached
    result = convert_step_to_vtk_cached(args.file)
    print(json.dumps(result))
    return 0
```

The backend invokes the command, parses stdout JSON, and reads the converted file — there is no readiness handshake because there is nothing to wait for beyond process exit.

---

## Unified Entry Point

All commands are invoked through `server.py`:

```bash
# Data query
python server.py openmc.info /path/to/statepoint.h5

# Headless conversion (geometry + VTK export, then exit)
python server.py openmc.tally-mesh-vtk /path/to/statepoint.h5 1

# Base visualizer
python server.py base.convert-dagmc --file /path/to/model.h5m
```

`server.py` auto-discovers plugins, builds argparse from registered commands, and routes to the handler.

---

## Logging & Warnings

### Standard Output

Everything printed to stdout is streamed to the IDE's output channel:

```python
print("Loading mesh...")        # Appears in output channel
print(f"Result: {data}")        # Appears in output channel
```

### Structured Warnings

To show a warning toast in the IDE, use the framework helper or print manually:

```python
from nuke_viz.logging import warning
warning("Tally mesh does not align with geometry", warning_type="spatial_warning")
```

Or print directly:

```python
import json
print(f"NUKE_IDE_WARNING:{json.dumps({'type': 'spatial_warning', 'message': '...'})}")
```

The backend scans stdout for lines starting with `NUKE_IDE_WARNING:` and forwards them via `VisualizerClient.warn()`.

### Errors

Print to stderr and exit non-zero:

```python
import sys
print("Failed to load HDF5 file", file=sys.stderr)
sys.exit(1)
```

This causes `executeScriptJson()` to throw with the stderr text.

---

## No Ports

There is no port management: commands must never bind ports or start servers. The backend allocates nothing and passes no `--port` — a command that needs to expose data writes a file (VTK/JSON) and prints its path.

---

## File Paths

Paths are passed as absolute strings from the TypeScript side:

```typescript
const filePath = uri.path.toString(); // e.g., "/home/user/project/geometry.xml"
```

In Python, verify the file exists before opening:

```python
import os
if not os.path.exists(file_path):
    print(f"File not found: {file_path}", file=sys.stderr)
    sys.exit(1)
```

---

## Concurrency

Each widget gets its own Python process. There is no shared state between processes. This is intentional — it prevents:

- Memory leaks from accumulating VTK pipelines
- State corruption when switching files
- Port conflicts

If you need shared caching, implement it in the Node backend, not in Python.

---

## Headless Conversion (No Display Needed)

Converters write files with the `vtk` writers and never create a render window, so no display server, `DISPLAY` handling, or offscreen GL setup is needed. Keep `QT_QPA_PLATFORM=offscreen` defensively (some `vtk` imports touch rendering modules), and keep heavy imports lazy inside the handler so a missing `vtk` surfaces as a clean JSON error instead of a traceback.

Rules:

- Do all geometry work in numpy; import `vtk` only for the final write (see `tally_vtk._load_vtk` / `output_vtk._load_vtk`).
- Never create render windows or mappers in converter code — rendering happens client-side in the IDE's three.js viewers.

---

## Client-Side Rendering

All 3D rendering happens in the frontend (`NativeVtkViewerWidget` + `src/browser/viewer-core/`: LUT pack, toolbar state model, clip plane, canvas screenshots). Color-by, colormap, clip, and screenshot controls run against the parsed VTK with no backend round-trip — so there is no server-side render mode, toggle, or fallback to maintain in new viewer code.

---

## Helper Modules

Reusable Python code should go in `python/plugins/<name>/lib/`, not in the main command modules.

Example structure:

```
python/
├── server.py                        # Unified entry point
├── nuke_viz/                        # Framework
│   ├── plugin.py
│   ├── registry.py
│   └── server.py
└── plugins/
    ├── openmc/
    │   ├── plugin.py
    │   ├── commands/
    │   │   ├── basic.py
    │   │   ├── statepoint.py
    │   │   ├── geometry.py
    │   │   └── xs_plot.py
    │   └── lib/
    │       ├── reader.py
    │       ├── geometry_parser.py
    │       └── materials_parser.py
    └── base/
        ├── plugin.py
        ├── commands/
        │   ├── convert.py     # headless converters (DAGMC, STEP)
        │   ├── exodus.py      # headless Exodus time-series extractor
        │   ├── analysis.py    # integrate / describe / mesh-quality commands
        │   └── export.py      # CSV/VTK/glTF dataset export
        └── lib/
            ├── common.py
            ├── dagmc.py           # DAGMC → VTK library
            ├── step.py            # STEP → VTK library
            ├── analysis.py        # pure numpy integrate/stats/quality helpers
            └── export.py          # pure CSV/format helpers
```

Import helpers using absolute imports:

```python
from plugins.openmc.lib.reader import OpenMCReader
from plugins.base.lib.common import find_free_port, COLOR_MAPS
from plugins.base.lib.dagmc import convert_h5m_to_vtk_cached
from plugins.base.lib.step import convert_step_to_vtk_cached
```

---

## Testing Python Scripts

You can test Python scripts independently of the IDE:

```bash
cd extensions/nuke-visualizer/python
python server.py openmc.info /path/to/statepoint.h5
python server.py base.convert-dagmc --file /path/to/model.h5m
```

This is useful for debugging without starting the full Theia application.

### Unit tests

The pytest suite lives in `tests/python/` and runs from the repo root:

```bash
yarn test:python        # run the suite
yarn test:python:cov    # run with the coverage report
```

Tests must pass with only `pytest` + `numpy` installed — guard heavy imports
and use `pytest.importorskip` for optional dependencies. Coverage of the
logic layer is ratcheted in CI (see "Coverage" in the root `AGENTS.md`); the
headless VTK converter modules are excluded by design and covered by
error-path contract tests instead.

---

## File Converters

Format conversion (e.g., DAGMC → VTK, STEP → VTK) is implemented as ordinary `@command` handlers in `plugins/base/commands/convert.py`:

```python
# python/plugins/base/commands/convert.py
from nuke_viz.plugin import command, arg
import json

@command('base.convert-step', help='Convert STEP to VTK')
@arg('--file', required=True, help='Input file path')
def cmd_convert_step(args):
    from plugins.base.lib.step import convert_step_to_vtk_cached
    result = convert_step_to_vtk_cached(args.file)
    print(json.dumps(result))
    return 0
```

The Node backend invokes them via `server.py` and parses JSON:

```typescript
const scriptPath = this.pythonHelper.findScript('server.py');
const result = await this.pythonHelper.executeScriptJson<{
  vtk_path: string;
  from_cache: boolean;
}>(scriptPath, ['base.convert-step', '--file', filePath]);
```

**Rule of thumb:**

- Library code → `python/plugins/<plugin>/lib/`
- CLI commands → `python/plugins/<plugin>/commands/`
- Unified entry point → `python/server.py`

Converter libs follow the hardened pattern (`DagmcError`/`StepError`, `find_spec` probes, lazy loaders, validators before heavy imports): `plugins/base/lib/dagmc.py` + `step.py` (cached multiblock conversion), `plugins/base/lib/exodus_series.py` (`base.exodus-series`), and `plugins/openmc/lib/geometry_viz.py` + `slice_viz.py` (`openmc.geometry-mesh` / `openmc.geometry-slice-vtk`).

---

## Summary Checklist

When writing a new Python backend command:

- [ ] Decorate the handler with `@command('plugin.command-name')`
- [ ] Add `@arg` decorators for each argument (positional first, then flags)
- [ ] Accept `args` (argparse.Namespace) and return an integer exit code
- [ ] Output data as JSON to stdout
- [ ] Print errors to stderr, exit non-zero on failure
- [ ] Use `NUKE_IDE_WARNING:{json}` or `nuke_viz.logging.warning()` for IDE warnings
- [ ] Never bind ports or start servers — write files and exit
- [ ] Keep heavy imports lazy (inside the handler) so missing deps report clean JSON errors
- [ ] Put reusable code in `python/plugins/<plugin>/lib/`
- [ ] Register the command module in `python/plugins/<plugin>/plugin.py`
- [ ] Test standalone: `python server.py plugin.command-name ...`
