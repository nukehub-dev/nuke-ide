# Python Backends

Python scripts in `python/` do the actual scientific work. This document covers conventions, patterns, and gotchas for writing and integrating Python backends.

---

## Script Discovery

Never hardcode paths. Use `PythonCommandHelper.findScript()`:

```typescript
const scriptPath = this.pythonHelper.findScript('my_script.py');
```

This resolves to:
1. `lib/python/my_script.py` (production build)
2. `src/python/my_script.py` (development)
3. Fallback relative to `__dirname`

---

## Entry Point Conventions

Python server scripts should follow this structure:

```python
#!/usr/bin/env python3
import argparse
import json
import sys

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command')
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--file', required=True)
    args = parser.parse_args()
    
    if args.command == 'serve':
        run_server(args.file, args.port)
    elif args.command == 'info':
        result = get_info(args.file)
        print(json.dumps(result))
    else:
        print(f"Unknown command: {args.command}", file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
```

### Rules

- Use **subcommands** (`serve`, `info`, `convert`) rather than many flags.
- Output **JSON to stdout** for data responses.
- Print **errors to stderr** and exit with non-zero code.
- Accept `--port` for server mode.

---

## Server Startup

Python servers must signal readiness so the backend knows when to return:

### Option 1: Print a ready message

```python
print(f"Starting visualizer server on port {port}")
server.start(port=port)
```

The backend watches stdout for `"Starting visualizer server on"`.

### Option 2: Just bind the port

The backend also polls the TCP port every second. Once the port accepts connections, the server is considered ready.

### Server Script Example

```python
from trame.app import get_server
from trame.ui.vuetify2 import VAppLayout

def create_app(file_path, port, theme='dark'):
    server = get_server(client_type="vue2")
    # ... build UI ...
    
    print(f"Starting visualizer server on port {port}")
    server.start(port=port)

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--file')
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--theme', default='dark')
    args = parser.parse_args()
    
    create_app(args.file, args.port, args.theme)
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

To show a warning toast in the IDE, print a structured warning line:

```python
import json
warning = {"type": "spatial_warning", "message": "Tally mesh does not align with geometry bounds"}
print(f"NUKE_IDE_WARNING:{json.dumps(warning)}")
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
python my_server.py --port 8090
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

Reusable Python code should go in `python/openmc_commands/` or similar sub-packages, not in the main server script.

Example structure:

```
python/
├── openmc_server.py           # Entry point, argparse, server loop
└── openmc_commands/
    ├── __init__.py
    ├── statepoint.py          # Statepoint reading functions
    ├── geometry.py            # Geometry parsing
    ├── xs_plot.py             # Cross-section data extraction
    └── depletion.py           # Depletion results processing
```

Import helpers from the server script:

```python
from openmc_commands import statepoint
result = statepoint.load_summary(file_path)
```

---

## Testing Python Scripts

You can test Python scripts independently of the IDE:

```bash
cd extensions/nuke-visualizer/python
python openmc_server.py info --file /path/to/statepoint.h5
python visualizer_app.py --file /path/to/mesh.vtk --port 8080
```

This is useful for debugging without starting the full Theia application.

---

## Summary Checklist

When writing a new Python backend script:

- [ ] Accept `--port` and bind to it exactly
- [ ] Accept file paths as arguments
- [ ] Print `"Starting ... server on port N"` for readiness
- [ ] Output data as JSON to stdout
- [ ] Print errors to stderr, exit non-zero on failure
- [ ] Use `NUKE_IDE_WARNING:{json}` for IDE warnings
- [ ] Set headless env vars before importing VTK
- [ ] Put reusable code in `python/<plugin>_commands/` submodules
- [ ] Test standalone: `python my_script.py --file ... --port ...`
