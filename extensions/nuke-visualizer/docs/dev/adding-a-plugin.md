# Nuke Visualizer — Plugin Developer Guide

This guide explains how to add new visualization plugins to NukeIDE. The `nuke-visualizer` extension provides shared infrastructure for spawning Python servers, managing widgets, running health checks, and executing scripts. You focus on your domain-specific logic.

> **Current plugins:** Base Visualizer (VTK/DAGMC), OpenMC  
> **Future examples:** MOOSE, Cardinal, OpenFOAM, etc.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [What You Get for Free](#what-you-get-for-free)
- [Adding a New Plugin — Step by Step](#adding-a-new-plugin--step-by-step)
- [Extension Points](#extension-points)
- [Shared Services Reference](#shared-services-reference)
- [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                       │
│                                                                             │
│   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   (your plugin here)  │
│   │ Base Viz    │   │ OpenMC      │   │ YourPlugin  │                       │
│   │             │   │             │   │             │                       │
│   │ Widgets     │   │ Widgets     │   │ Widgets     │                       │
│   │ Commands    │   │ Commands    │   │ Commands    │                       │
│   │ Menus       │   │ Menus       │   │ Menus       │                       │
│   └──────┬──────┘   └──────┬──────┘   └──────┬──────┘                       │
│          │                 │                 │                              │
│          └─────────────────┴─────────────────┘                              │
│                            │                                                │
│          ┌─────────────────┴─────────────────┐                              │
│          │  HealthCheckFramework             │                              │
│          │  PlotlyService                    │                              │
│          │  NukeCoreService                  │                              │
│          └─────────────────┬─────────────────┘                              │
│                            │ RPC                                            │
└────────────────────────────┼────────────────────────────────────────────────┘
                             │
┌────────────────────────────┼────────────────────────────────────────────────┐
│                            │  BACKEND                                       │
│          ┌─────────────────┴─────────────────┐                              │
│          │  PythonCommandHelper              │                              │
│          │  (detects Python, runs scripts)   │                              │
│          └─────────────────┬─────────────────┘                              │
│                            │                                                │
│   ┌─────────────┐   ┌──────┴───────┐   ┌─────────────┐   (your backend)     │
│   │ Base Viz    │   │ OpenMC       │   │ YourPlugin  │                      │
│   │ Backend     │   │ Backend      │   │ Backend     │                      │
│   └──────┬──────┘   └──────┬───────┘   └──────┬──────┘                      │
│          │                 │                  │                             │
│          └─────────────────┴──────────────────┘                             │
│                            │                                                │
│                    python/server.py (unified entry)                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key insight:** Each plugin is self-contained but reuses shared infrastructure. You do NOT modify `nuke-visualizer` core files. You add your plugin under `src/browser/plugins/your-plugin/` and `src/node/plugins/your-plugin/`, then wire it into the DI modules.

---

## What You Get for Free

| Infrastructure                | What It Does                                                       | Your Responsibility                                        |
| ----------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| **Python detection**          | Finds a Python with your required packages via `nuke-core`         | Declare packages in `src/common/packages.json`             |
| **Health checks**             | Verifies packages in the configured env, suggests install commands | Register requirements with `HealthCheckFramework`          |
| **Process spawning**          | Finds free ports, starts your Python server, waits for readiness   | Provide `@command` handlers under `python/plugins/<name>/` |
| **Widget lifecycle**          | Creates iframe widgets, handles open/close, theme propagation      | Create widgets or reuse `VisualizerWidget`                 |
| **File open handling**        | Routes file types to your plugin via Theia `OpenHandler`           | Implement `canHandle()` and `open()`                       |
| **Menu/command registration** | Registers commands under `Tools → Visualizer`                      | Define command IDs and labels                              |
| **Plotly integration**        | Displays interactive 2D plots                                      | Provide `PlotlyFigure` data                                |
| **Output channel logging**    | Streams Python stdout/stderr to IDE panels                         | Use `VisualizerClient.log/error/warn`                      |

---

## Adding a New Plugin — Step by Step

Let's say you want to add a **MOOSE** visualization plugin.

### Step 1: Define the RPC Protocol

Create `src/common/moose-protocol.ts`:

```typescript
export const MooseBackendService = Symbol('MooseBackendService');
export const MOOSE_BACKEND_PATH = '/services/moose';

export interface MooseBackendService {
  startServer(inputFile: string): Promise<{ url: string; port: number }>;
  stopServer(port: number): Promise<void>;
  getMeshInfo(filePath: string): Promise<MooseMeshInfo>;
  // Add your domain-specific methods...
}

export interface MooseMeshInfo {
  numElements: number;
  numNodes: number;
  variables: string[];
}

// Package requirements are declared in src/common/packages.json — the single
// source of truth — and exported from src/common, never inlined in services.
// See "Python package requirements" in extensions/AGENTS.md.
import packages from './packages.json';

export const MOOSE_REQUIREMENTS = packages.moose;
```

```json
// src/common/packages.json
{
  "moose": [
    { "name": "moose", "required": true },
    { "name": "vtk", "required": true }
  ]
}
```

### Step 2: Create the Python Backend

All Python code lives under `python/plugins/<name>/`. The unified `server.py` auto-discovers plugins and routes commands.

#### 2a. Create the plugin package

```
python/plugins/moose/
├── plugin.py          # Imports commands, triggers @command registration
├── commands/
│   ├── __init__.py
│   ├── info.py        # @command('moose.info')
│   └── serve.py       # @command('moose.serve') — optional Trame server
└── lib/
    ├── __init__.py
    └── reader.py      # Reusable helpers
```

#### 2b. Register commands

`python/plugins/moose/plugin.py`:

```python
"""MOOSE visualization plugin for NukeIDE."""
import sys

_COMMAND_MODULES = ['info', 'serve']

for mod_name in _COMMAND_MODULES:
    try:
        __import__(f'plugins.moose.commands.{mod_name}')
    except Exception as e:
        print(f"[MOOSE Plugin] '{mod_name}' not loaded: {e}", file=sys.stderr)

PLUGIN_NAME = "moose"
PLUGIN_DISPLAY_NAME = "MOOSE"
REQUIREMENTS = ["moose", "vtk"]
```

#### 2c. Write a command handler

`python/plugins/moose/commands/info.py`:

```python
from nuke_viz.plugin import command, arg
import json

@command('moose.info', help='Get MOOSE mesh info')
@arg('--file', required=True, help='Path to Exodus or input file')
def cmd_info(args):
    # Your logic to read MOOSE output/exodus files
    result = {"numElements": 1000, "numNodes": 500, "variables": ["temp", "disp"]}
    print(json.dumps(result))
    return 0
```

Test standalone:

```bash
python server.py moose.info --file /path/to/moose.i
```

### Step 3: Implement the Backend Service

Create `src/node/plugins/moose/moose-backend-service.ts`:

```typescript
import { injectable, inject } from '@theia/core/shared/inversify';
import { MooseBackendService, MooseMeshInfo } from '../../../common/moose-protocol';
import { VisualizerClient } from '../../../common/base-visualizer-protocol';
import { PythonCommandHelper } from '../../services/python-command-helper';

@injectable()
export class MooseBackendServiceImpl implements MooseBackendService {
  @inject(PythonCommandHelper)
  protected readonly pythonHelper: PythonCommandHelper;

  protected client?: VisualizerClient;

  setClient(client: VisualizerClient): void {
    this.client = client;
  }

  async startServer(inputFile: string): Promise<{ url: string; port: number }> {
    // 1. Detect Python with moose + vtk
    const pythonResult = await this.pythonHelper.detectPython(
      MOOSE_REQUIREMENTS,
      ['moose', 'dev'] // preferred env names
    );

    // 2. Find a free port
    const port = await this.findFreePort();

    // 3. Spawn your server via the unified entry point
    const serverScript = this.pythonHelper.findScript('server.py');
    const { spawn } = await import('child_process');
    const proc = spawn(pythonResult.command, [serverScript, 'moose.serve', '--port', String(port), '--file', inputFile]);

    // 4. Wait for ready
    await this.waitForServer(port);

    return { url: `http://localhost:${port}`, port };
  }

  async getMeshInfo(filePath: string): Promise<MooseMeshInfo> {
    const serverScript = this.pythonHelper.findScript('server.py');
    const execResult = await this.pythonHelper.executeScript(serverScript, ['moose.info', '--file', filePath], {
      requirements: MOOSE_REQUIREMENTS
    });
    if (execResult.status !== 0) {
      throw new Error(execResult.stderr || `moose.info failed`);
    }
    // Extract JSON from mixed stdout (logs + JSON)
    const lines = execResult.stdout.split('\n');
    const jsonLine = lines.find((l) => l.trimStart().startsWith('{'));
    if (!jsonLine) {
      throw new Error(`No JSON in output: ${execResult.stdout.substring(0, 200)}`);
    }
    return JSON.parse(jsonLine) as MooseMeshInfo;
  }

  // ... helpers: findFreePort, waitForServer, stopServer
}
```

### Step 4: Implement the Frontend Service

Create `src/browser/plugins/moose/moose-service.ts`:

```typescript
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { MooseBackendService } from '../../../common/moose-protocol';
import { NukeCoreService } from 'nuke-core/lib/common';
import { HealthCheckFramework } from '../../services/health-check-framework';
import { MOOSE_REQUIREMENTS } from '../../../common/moose-protocol';

@injectable()
export class MooseService {
  @inject(MooseBackendService)
  protected readonly backend: MooseBackendService;

  @inject(NukeCoreService)
  protected readonly nukeCore: NukeCoreService;

  @inject(HealthCheckFramework)
  protected readonly healthFramework: HealthCheckFramework;

  @postConstruct()
  protected init(): void {
    // Register health requirements
    this.healthFramework.registerHealthRequirements({
      id: 'moose',
      name: 'MOOSE',
      packages: MOOSE_REQUIREMENTS
    });

    // Listen for environment changes
    this.nukeCore.onEnvironmentChanged(() => {
      // Clear any cached data
    });
  }

  async openInputFile(filePath: string): Promise<void> {
    // Start server, create widget, etc.
    const server = await this.backend.startServer(filePath);
    // ... create widget with iframe pointing to server.url
  }
}
```

### Step 5: Create Widgets and Contributions

Create `src/browser/plugins/moose/moose-contribution.ts`:

```typescript
import { injectable, inject } from '@theia/core/shared/inversify';
import { OpenHandler, FrontendApplicationContribution } from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';
import { MooseService } from './moose-service';

@injectable()
export class MooseContribution implements OpenHandler, FrontendApplicationContribution {
  readonly id = 'moose-handler';
  readonly label = 'MOOSE Input File';

  @inject(MooseService)
  protected readonly mooseService: MooseService;

  canHandle(uri: URI): number {
    return uri.path.ext === '.i' ? 500 : 0;
  }

  async open(uri: URI): Promise<object | undefined> {
    await this.mooseService.openInputFile(uri.path.toString());
    return undefined;
  }
}
```

### Step 6: Register Commands and Menus

Create `src/browser/plugins/moose/commands.ts`:

```typescript
export namespace MooseCommands {
  export const OPEN_INPUT = {
    id: 'moose.openInput',
    label: 'MOOSE: Open Input File'
  };
}
```

### Step 7: Wire Into DI Modules

**Frontend** (`src/browser/visualizer-frontend-module.ts`):

```typescript
import { MooseService } from './plugins/moose/moose-service';
import { MooseContribution } from './plugins/moose/moose-contribution';
import { MooseBackendService, MOOSE_BACKEND_PATH } from '../common/moose-protocol';

// Add inside the ContainerModule callback:
bind(MooseService).toSelf().inSingletonScope();
bind(OpenHandler).to(MooseContribution);
bind(FrontendApplicationContribution).to(MooseContribution);

// Bind RPC proxy
bind(MooseBackendService)
  .toDynamicValue((ctx) => {
    const connectionProvider = ctx.container.get(WebSocketConnectionProvider);
    return connectionProvider.createProxy<MooseBackendService>(MOOSE_BACKEND_PATH);
  })
  .inSingletonScope();
```

**Backend** (`src/node/visualizer-backend-module.ts`):

```typescript
import { MooseBackendServiceImpl } from './plugins/moose/moose-backend-service';
import { MooseBackendService, MOOSE_BACKEND_PATH } from '../common/moose-protocol';

// Add inside the ContainerModule callback:
bind(MooseBackendServiceImpl).toSelf().inSingletonScope();
bind(MooseBackendService).toService(MooseBackendServiceImpl);
bind(ConnectionHandler)
  .toDynamicValue(
    (ctx) =>
      new RpcConnectionHandler<VisualizerClient>(MOOSE_BACKEND_PATH, (client) => {
        const server = ctx.container.get<MooseBackendServiceImpl>(MooseBackendServiceImpl);
        server.setClient(client);
        return server;
      })
  )
  .inSingletonScope();
```

### Step 8: Add Menu Items

In your contribution's `registerMenus()`:

```typescript
import { NukeMenus } from 'nuke-core/lib/browser/nuke-core-menus';

registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(NukeMenus.TOOLS_VISUALIZER, {
        commandId: MooseCommands.OPEN_INPUT.id,
        label: 'MOOSE'
    });
}
```

### Done!

Your plugin now:

- Opens `.i` files via double-click
- Shows up in `Tools → Visualizer → MOOSE`
- Appears in health checks
- Reuses all shared infrastructure

---

## Extension Points

### 1. Health Check Registration

Any plugin can register package requirements:

```typescript
this.healthFramework.registerHealthRequirements({
  id: 'your-plugin-id',
  name: 'Your Plugin Name',
  packages: [
    { name: 'your-package', required: true },
    { name: 'optional-pkg', required: false, condaOnly: true }
  ]
});
```

### 2. File Type Handling

Implement `OpenHandler` to register file associations:

```typescript
canHandle(uri: URI): number {
    // Return 0 if not handled, >0 priority otherwise
    return uri.path.ext === '.your_ext' ? 500 : 0;
}
```

### 3. Widget Creation

**Option A — Reuse `VisualizerWidget` (iframe-based):**

Best for Python servers that render their own UI (Trame, Dash, etc.).

```typescript
const widget = await this.widgetManager.getOrCreateWidget(VisualizerWidget.ID, { uri: filePath, id: 'your-prefix-' + filePath });
// Set the server URL after the server starts
widget.setServerUrl(serverUrl);
```

**Option B — Custom React widget:**

Best for IDE-integrated UIs (trees, tables, Plotly charts).

```typescript
// Define your widget
@injectable()
export class YourWidget extends ReactWidget {
  static readonly ID = 'your-widget';
  // ... render() implementation
}

// Register factory
bind(WidgetFactory)
  .toDynamicValue((ctx) => ({
    id: YourWidget.ID,
    createWidget: () => ctx.container.get(YourWidget)
  }))
  .inSingletonScope();
```

### 4. Command and Menu Registration

Use standard Theia patterns:

```typescript
// Commands
commands.registerCommand(YOUR_COMMAND, { execute: () => ... });

// Menus under Tools → Visualizer
menus.registerMenuAction(NukeMenus.TOOLS_VISUALIZER, {
    commandId: YOUR_COMMAND.id,
    label: 'Your Plugin'
});
```

### 5. Python Script Execution

Use `PythonCommandHelper` for all Python calls. **All commands go through `server.py`**:

```typescript
const serverScript = this.pythonHelper.findScript('server.py');

// Simple data query — JSON output
const execResult = await helper.executeScript(serverScript, ['moose.info', '--file', filePath], { requirements: MOOSE_REQUIREMENTS });
// Extract JSON line from mixed stdout (library logs may precede it)
const lines = execResult.stdout.split('\n');
const jsonLine = lines.find((l) => l.trimStart().startsWith('{'));
const result = JSON.parse(jsonLine);

// Custom server spawning
const python = await helper.detectPython(YOUR_REQUIREMENTS);
const proc = spawn(python.command, [serverScript, 'moose.serve', '--port', String(port), '--file', inputFile]);
```

---

## Shared Services Reference

### `HealthCheckFramework`

```typescript
registerHealthRequirements(req: PluginHealthRequirements): void
runHealthCheck(pluginId: string): Promise<PluginHealthReport | undefined>
runAllHealthChecks(): Promise<UnifiedHealthReport>
```

### `PythonCommandHelper`

```typescript
detectPython(
    requirements?: PackageDependency[],
    autoDetectEnvs?: string[]
): Promise<PythonCommandResult>

executeScriptJson<T>(
    scriptName: string,
    args: string[],
    requirements?: PackageDependency[]
): Promise<T>
```

### `PlotlyService`

```typescript
showPlot(figure: PlotlyFigure, title: string): Promise<Widget>
```

### `VisualizerWidget`

Properties:

- `id` — Widget ID (must be unique per instance)
- `setUri(uri, volumeId?)` — Set the file to visualize
- `setServerUrl(url)` — Point iframe to running server
- `onServerStop(port)` — Static callback when a server stops

### `NukeCoreService`

Events:

- `onEnvironmentChanged` — Fires when user switches Python env
- `onEnvironmentFallback` — Fires when fallback env is used

Use these to invalidate cached data when the environment changes.

---

## Troubleshooting

### "Python not found" when opening a file

1. Run **Tools → Visualizer → Environment → Run Health Check**
2. Install missing packages using the suggested commands
3. Ensure your plugin's entries in `src/common/packages.json` have correct metadata (`condaOnly`, `extraIndexUrl`, etc.)

### Server starts but widget shows blank

1. Check the **Nuke Visualizer** output channel for Python errors
2. Verify the server URL is correct (`http://localhost:PORT`)
3. Check browser dev tools for CSP or iframe errors

### Widget reopens instead of creating a new one

Ensure widget IDs are unique per file:

```typescript
const widgetId = 'your-plugin-' + filePath;
```

### Health check shows wrong environment

Health checks always verify the **configured** environment, not fallbacks. If your configured env is missing packages, fix the configured env or switch to one that has them.

### Commands don't appear in menus

- Verify `CommandContribution` and `MenuContribution` are bound in the frontend module
- Check that `NukeMenus.TOOLS_VISUALIZER` is the correct menu path
- Ensure command IDs match between `registerCommand` and `registerMenuAction`
