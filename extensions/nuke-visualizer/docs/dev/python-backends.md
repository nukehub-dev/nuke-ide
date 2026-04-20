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
- Print **errors to stderr** and exit with non-zero code.
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

If a command module requires heavy dependencies (e.g., `openmc`, `paraview`), wrap imports in `try/except` at the plugin level so missing deps don't break the entire plugin:

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

## Server Startup (Trame / ParaView)

For visualization servers that need to bind a port, use `@command` + `@arg` like any other command:

```python
# python/plugins/base/commands/serve.py
from nuke_viz.plugin import command, arg

@command('base.serve', help='Start the base visualizer server')
@arg('--port', type=int, help='Port to run server on')
@arg('--file', type=str, help='File to load')
@arg('--host', type=str, default='127.0.0.1', help='Host to report in URL')
@arg('--theme', type=str, default='dark', choices=['dark', 'light'])
def cmd_serve(args):
    port = args.port or find_free_port()
    server = create_app(args.file, port, theme=args.theme)
    print(f"Starting visualizer server on port {port}")
    server.start(port=port, host='0.0.0.0', open_browser=False)
    return 0
```

### Readiness Signaling

Python servers must signal readiness so the backend knows when to return:

**Option 1: Print a ready message**

```python
print(f"Starting visualizer server on port {port}")
server.start(port=port)
```

The backend watches stdout for `"Starting visualizer server on"`.

**Option 2: Just bind the port**

The backend also polls the TCP port every second. Once the port accepts connections, the server is considered ready.

---

## Unified Entry Point

All commands are invoked through `server.py`:

```bash
# Data query
python server.py openmc.info /path/to/statepoint.h5

# 3D visualization
python server.py openmc.visualize-mesh /path/to/statepoint.h5 1 --port 8090

# Base visualizer
python server.py base.serve --file /path/to/mesh.vtk --port 8080
```

`server.py` auto-discovers plugins, builds argparse from registered commands, and routes to the handler.

### Backward-Compatible Shims

Old entry points (`openmc_server.py`, `visualizer_app.py`) are thin shims that translate legacy arguments to namespaced commands and delegate to `server.py`:

```bash
# These still work
python openmc_server.py info /path/to/statepoint.h5
python visualizer_app.py --file /path/to/mesh.vtk --port 8080
```

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

## Port Binding

The backend allocates a free port and passes it to your script:

```bash
python server.py openmc.visualize-mesh statepoint.h5 1 --port 8090
```

Your script must bind to **exactly** that port. Do not pick your own port.

If you need multiple ports (rare), discuss with the backend service author.

---

## File Paths

Paths are passed as absolute strings from the TypeScript side:

```typescript
const filePath = uri.path.toString();  // e.g., "/home/user/project/geometry.xml"
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

## Headless / Offscreen Rendering

For VTK/ParaView scripts running in a headless environment (servers, containers):

```python
import os
os.environ['DISPLAY'] = ''
os.environ['QT_QPA_PLATFORM'] = 'offscreen'
os.environ['VTK_USE_OFFSCREEN'] = '1'
```

Set these **before** importing `vtk` or `paraview`.

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
    └── openmc/
        ├── plugin.py
        ├── commands/
        │   ├── basic.py
        │   ├── statepoint.py
        │   ├── geometry.py
        │   └── xs_plot.py
        └── lib/
            ├── reader.py
            ├── geometry_parser.py
            └── materials_parser.py
```

Import helpers using absolute imports:

```python
from plugins.openmc.lib.reader import OpenMCReader
from plugins.base.lib.common import find_free_port, COLOR_MAPS
```

---

## Testing Python Scripts

You can test Python scripts independently of the IDE:

```bash
cd extensions/nuke-visualizer/python
python server.py openmc.info /path/to/statepoint.h5
python server.py base.serve --file /path/to/mesh.vtk --port 8080
```

This is useful for debugging without starting the full Theia application.

---

## Summary Checklist

When writing a new Python backend command:

- [ ] Decorate the handler with `@command('plugin.command-name')`
- [ ] Add `@arg` decorators for each argument (positional first, then flags)
- [ ] Accept `args` (argparse.Namespace) and return an integer exit code
- [ ] Output data as JSON to stdout
- [ ] Print errors to stderr, exit non-zero on failure
- [ ] Use `NUKE_IDE_WARNING:{json}` or `nuke_viz.logging.warning()` for IDE warnings
- [ ] For servers: accept `--port` and bind to it exactly
- [ ] Set headless env vars before importing VTK
- [ ] Put reusable code in `python/plugins/<plugin>/lib/`
- [ ] Register the command module in `python/plugins/<plugin>/plugin.py`
- [ ] Test standalone: `python server.py plugin.command-name ...`
