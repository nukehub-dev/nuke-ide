# Python Backends

Python helper scripts in `python/` perform scientific work: reading statepoints, running depletion, optimizing parameters, and processing CAD/DAGMC geometry. This document covers conventions for writing and integrating Python backends.

---

## Script Location

All Python scripts live in `extensions/openmc-studio/python/`:

The Node.js backend resolves script paths via `__dirname` relative resolution (production `lib/python/` vs development `src/python/`).

---

## Argument Parsing

Every script must use `argparse` with explicit subcommands or flags. No positional-only mystery arguments.

### Minimal Template

```python
#!/usr/bin/env python3
"""My new backend script for OpenMC Studio."""

import sys
import json
import argparse
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description='My backend service')
    parser.add_argument('input_file', help='Path to input file')
    parser.add_argument('--output', '-o', help='Output file path')
    parser.add_argument('--verbose', '-v', action='store_true', help='Verbose output')

    args = parser.parse_args()

    # Validate input
    if not Path(args.input_file).exists():
        print(f"File not found: {args.input_file}", file=sys.stderr)
        sys.exit(1)

    # Do work
    result = do_work(args.input_file, args.output, args.verbose)

    # Output JSON
    print(json.dumps(result))
    sys.exit(0)


def do_work(input_file: str, output: str | None, verbose: bool) -> dict:
    return {
        'success': True,
        'inputFile': input_file,
        'outputFile': output,
        'data': {}
    }


if __name__ == '__main__':
    main()
```

### Rules

- Use `argparse.ArgumentParser` with a descriptive `description`.
- Validate file paths with `Path.exists()` before opening.
- Print errors to `sys.stderr` and exit with a non-zero code.
- Print data responses as JSON to `stdout`.

---

## JSON stdout Communication

The Node.js backend parses stdout as JSON. Your script must print **exactly one JSON object** as the final line.

### Output Format

```python
import json

# Success
result = {
    'success': True,
    'data': { ... }
}
print(json.dumps(result))

# Error (still JSON, but success=false)
result = {
    'success': False,
    'error': 'Missing dependency: openmc',
    'traceback': traceback.format_exc()
}
print(json.dumps(result))
```

### Handling Numpy Types

Statepoint data frequently contains numpy arrays and `uncertainties` objects. Use a custom encoder:

```python
import numpy as np

class NumpyEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            return float(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        return super().default(obj)

print(json.dumps(result, cls=NumpyEncoder))
```

See [`statepoint_reader.py`](../../python/statepoint_reader.py) for the full implementation.

---

## Error Handling

| Scenario           | Action                                       | Exit Code                |
| ------------------ | -------------------------------------------- | ------------------------ |
| Success            | Print JSON result                            | `0`                      |
| Missing dependency | Print JSON with `success: false` and `error` | `0` (JSON parsed) or `1` |
| File not found     | Print to stderr, exit non-zero               | `1`                      |
| Runtime exception  | Print JSON with `error` + `traceback`        | `0` or `1`               |
| Invalid arguments  | `argparse` prints help, exits                | `2`                      |

### Example: Graceful Dependency Handling

```python
try:
    import openmc
    import h5py
except ImportError as e:
    print(json.dumps({
        'success': False,
        'error': f'Missing dependency: {e}. Please install openmc and h5py.'
    }))
    sys.exit(0)  # Return JSON error so frontend can display it
```

---

## Python Environment Detection

OpenMC Studio uses `nuke-core` to detect the correct Python environment. The backend service (`OpenMCRunnerService`, `OpenMCStudioBackendServiceImpl`) handles environment selection.

You do NOT need to detect Python in your script. The Node.js backend:

1. Checks `nuke-core` for configured environments
2. Verifies `openmc` and other required packages are available
3. Spawns your script with the resolved Python executable

### Requirements for Scripts

- Do not assume `python` or `python3` is the correct interpreter.
- Do not hardcode package import paths.
- Use `try/except ImportError` for optional heavy dependencies.

---

## Backend Execution Pattern

The Node.js backend executes scripts via `child_process.spawn` or helper methods. The standard pattern is:

### `executeScriptJson` Pattern

```typescript
// Node backend service executes a script and parses JSON stdout
async runMyScript(inputPath: string): Promise<MyResult> {
    const { spawn } = await import('child_process');

    // Resolve Python from nuke-core configuration
    const pythonPath = await this.getPythonPath();
    const scriptPath = this.resolveScriptPath('my_script.py');

    return new Promise((resolve, reject) => {
        const proc = spawn(pythonPath, [scriptPath, inputPath, '--json']);

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => { stdout += data; });
        proc.stderr.on('data', (data) => { stderr += data; });

        proc.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(stderr || `Process exited with code ${code}`));
                return;
            }
            try {
                const result = JSON.parse(stdout.trim().split('\n').pop() || '{}');
                resolve(result);
            } catch (e) {
                reject(new Error(`Failed to parse JSON: ${stdout}`));
            }
        });
    });
}
```

### Long-Running Processes (Simulations)

For simulations that stream output, use event-based streaming:

```typescript
async startSimulation(request: SimulationRunRequest): Promise<StartSimulationResponse> {
    const proc = spawn(pythonPath, ['-m', 'openmc', ...request.args], {
        cwd: request.workingDirectory,
        env: { ...process.env, ...request.env }
    });

    proc.stdout.on('data', (data) => {
        this.client?.log(data.toString());
    });

    proc.stderr.on('data', (data) => {
        this.client?.error(data.toString());
    });

    // Return process ID for tracking
    return { processId: uuid(), success: true };
}
```

---

### Native DAGMC Writer

The CAD import and refacet pipelines use a **native DAGMC H5M writer** built on `pymoab`. This avoids external meshing dependencies and handles edge cases (empty element lists, invalid topology) gracefully.

**Key features:**

- Tessellation via **OpenCASCADE BRepMesh_IncrementalMesh** with user-defined linear deflection
- Direct STEP/IGES loading through `STEPControl_Reader` / `IGESControl_Reader`
- Face-to-volume sense mapping via `TopExp_Explorer` and `BRep_Tool.Triangulation`
- Writes full DAGMC tag schema: `CATEGORY`, `GEOM_DIMENSION`, `GEOM_SENSE_2`, `GLOBAL_ID`, `NAME`
- Material groups written as `mat:...` tags
- Triangle count scales predictably with faceting tolerance

**Pipeline (`dagmc_editor_service.py` → `_step_to_dagmc_ocp`):**

1. Load the source CAD with `STEPControl_Reader` or `IGESControl_Reader`
2. Compute bounding-box diagonal; auto-adjust tolerance for very large models
3. Tessellate with `BRepMesh_IncrementalMesh(shape, tolerance, parallel=True)`
4. Iterate solids → faces → `Poly_Triangulation`; transform vertices and extract triangle indices
5. Build MOAB entity sets with proper DAGMC tags and write H5M via `pymoab`

**Why OpenCASCADE instead of Gmsh:** BRepMesh tessellates based on linear deflection from the true CAD surface, so triangle count scales correctly with tolerance. This produces meshes that are both faster to generate and more predictable in size.

---

## Example: Adding a New Python Backend Script

Let's add a script that computes volume statistics from a DAGMC file.

### Step 1: Create the Script

```python
# python/dagmc_volume_stats.py
#!/usr/bin/env python3
"""Compute volume statistics from a DAGMC file."""

import sys
import json
import argparse
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description='DAGMC volume statistics')
    parser.add_argument('file', help='Path to DAGMC .h5m file')
    parser.add_argument('--json', action='store_true', help='Output as JSON')
    args = parser.parse_args()

    file_path = Path(args.file)
    if not file_path.exists():
        print(json.dumps({'success': False, 'error': f'File not found: {args.file}'}))
        sys.exit(1)

    try:
        import pymoab
    except ImportError:
        print(json.dumps({
            'success': False,
            'error': 'pymoab is required for DAGMC operations'
        }))
        sys.exit(0)

    mb = pymoab.core.Core()
    mb.load_file(str(file_path))

    # Compute stats
    volumes = mb.get_entities_by_dimension(0, 3)
    surfaces = mb.get_entities_by_dimension(0, 2)

    result = {
        'success': True,
        'file': str(file_path),
        'volumeCount': len(volumes),
        'surfaceCount': len(surfaces),
    }

    print(json.dumps(result))
    sys.exit(0)


if __name__ == '__main__':
    main()
```

### Step 2: Add Backend Method

```typescript
// src/node/openmc-studio-backend-service.ts
async getDAGMCVolumeStats(filePath: string): Promise<{
    success: boolean;
    volumeCount?: number;
    surfaceCount?: number;
    error?: string;
}> {
    return this.executeScriptJson('dagmc_volume_stats.py', [filePath, '--json']);
}
```

### Step 3: Add to RPC Protocol

```typescript
// src/common/openmc-studio-protocol.ts
export interface OpenMCStudioBackendService {
    // ... existing methods
    getDAGMCVolumeStats(filePath: string): Promise<{ ... }>;
}
```

### Step 4: Call from Widget

```typescript
const stats = await this.backend.getDAGMCVolumeStats(filePath);
if (stats.success) {
  this.messageService.info(`${stats.volumeCount} volumes, ${stats.surfaceCount} surfaces`);
}
```

---

## Summary Checklist

When writing a new Python backend script:

- [ ] Place script in `python/` directory
- [ ] Use `argparse` with descriptive help text
- [ ] Validate input file paths before opening
- [ ] Output data as JSON to stdout
- [ ] Use `NumpyEncoder` for numpy/uncertainties types
- [ ] Print errors to stderr and exit non-zero on unrecoverable failures
- [ ] Wrap optional heavy dependencies in `try/except ImportError`
- [ ] Do not hardcode Python interpreter paths
- [ ] Test standalone: `python python/my_script.py --help`
