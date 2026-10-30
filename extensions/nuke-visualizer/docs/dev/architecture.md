# Architecture

`nuke-visualizer` is a Theia extension that bridges TypeScript/React frontend code with Python scientific visualization backends. It uses a plugin-based design so new domains can be added without modifying core files.

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        FRONTEND (Browser/Electron)          │
│                                                             │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│   │ Base Viz     │  │ OpenMC       │  │ Your Plugin  │      │
│   │ (widgets,    │  │ (widgets,    │  │ (widgets,    │      │
│   │  commands)   │  │  commands)   │  │  commands)   │      │
│   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│          │                 │                 │              │
│          └─────────────────┴─────────────────┘              │
│                            │                                │
│          ┌─────────────────┴─────────────────┐              │
│          │  Shared: HealthCheckFramework     │              │
│          │         PlotlyService             │              │
│          │         NukeCoreService           │              │
│          └─────────────────┬─────────────────┘              │
│                            │ RPC (WebSocket)                │
└────────────────────────────┼────────────────────────────────┘
                             │
┌────────────────────────────┼────────────────────────────────┐
│                        BACKEND (Node.js)                    │
│                                                             │
│          ┌─────────────────┴─────────────────┐              │
│          │  Shared: PythonCommandHelper      │              │
│          │         (detect, execute, spawn)  │              │
│          └─────────────────┬─────────────────┘              │
│                            │                                │
│   ┌──────────────┐  ┌──────┴───────┐  ┌──────────────┐      │
│   │ Base Viz     │  │ OpenMC       │  │ Your Plugin  │      │
│   │ Backend      │  │ Backend      │  │ Backend      │      │
│   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│          │                 │                 │              │
│          └─────────────────┴─────────────────┘              │
│                            │                                │
│              python/server.py (unified entry point)         │
└─────────────────────────────────────────────────────────────┘
```

---

## Layers

### 1. Frontend Layer (`src/browser/`)

The frontend runs in the browser/Electron renderer. It is built on **Theia** and uses **InversifyJS** for dependency injection.

**Responsibilities:**

- Render widgets (React-based, including native three.js 3D viewers)
- Register commands, menus, and keyboard shortcuts
- Handle file open events via `OpenHandler`
- Display plots via Plotly.js
- Call backend services over RPC

**Key concepts:**

- **Contribution pattern:** Classes implement `CommandContribution`, `MenuContribution`, `OpenHandler`, etc., and are bound in the DI module.
- **Widget factories:** Each widget type is registered with a `WidgetFactory` so Theia's `WidgetManager` can create instances.
- **RPC proxies:** Backend services are accessed via `WebSocketConnectionProvider.createProxy<T>(PATH)`.

### 2. Common Layer (`src/common/`)

TypeScript interfaces shared by both frontend and backend. These define the RPC contract.

**Responsibilities:**

- Define service interfaces (methods + paths)
- Define data types (tallies, geometry, cross-sections, etc.)
- Declare package requirements

**Key files:**

- `base-visualizer-protocol.ts` — Base visualizer RPC + shared types
- `openmc-protocol.ts` — OpenMC RPC + domain types

### 3. Backend Layer (`src/node/`)

The backend runs in Node.js. It spawns Python processes and manages their lifecycle.

**Responsibilities:**

- Accept RPC calls from the frontend
- Detect Python environments with required packages
- Run short-lived Python converter commands and return their JSON/file results
- Stream stdout/stderr back to the frontend via `VisualizerClient`
- Convert file formats (e.g., DAGMC .h5m → VTK)

**Key concepts:**

- **RPC handlers:** `RpcConnectionHandler` maps a WebSocket path to a service implementation.
- **Process management:** Each conversion spawns its own short-lived Python process; nothing listens on ports and nothing persists after the command exits.
- **Timeouts:** conversion waits scale with file size via the `nukeVisualizer.serverTimeout` + `nukeVisualizer.serverTimeoutPerMB` preferences.

### 4. Python Layer (`python/`)

Python scripts that do the actual scientific visualization.

**Responsibilities:**

- Read domain-specific files (HDF5, XML, VTK)
- Convert scientific data to VTK XML or legacy ASCII (numpy geometry, `vtk` imports lazily for the final write)
- Compute derived data (spectra, spatial plots, cross-sections)
- Print JSON results to stdout and exit — commands never bind ports or serve HTTP

There are no visualization servers to reach: a conversion command runs, writes its VTK/JSON output, and exits. The frontend reads the converted file (via the Theia `FileService`) and renders it natively with three.js, so the viewers work identically in browser and Electron deployments with no proxying.

**Key scripts:**

- `server.py` — Unified entry point with auto-discovery and plugin routing
- `nuke_viz/` — Shared framework (`@command`/`@arg` decorators, plugin registry, structured logging)
- `plugins/openmc/` — OpenMC plugin (commands + lib modules)
- `plugins/base/` — Base visualizer plugin (headless file converters, shared libraries)

Plugins register commands via the `@command` decorator. Importing a command module triggers registration automatically — no manual routing needed.

---

## Data Flow Example: Opening a Statepoint

1. **User double-clicks** `statepoint_100.h5` in the Explorer.
2. **`OpenMCContribution.canHandle()`** returns `200` (high priority).
3. **`OpenMCContribution.open()`** is called.
4. It calls **`OpenMCService.loadStatepoint()`** which:
   - Checks OpenMC availability through the backend, then uses `HealthCheckFramework` requirements to offer a package install
   - Calls `OpenMCBackendService.loadStatepoint()` over RPC
5. **Backend** (`OpenMCBackendServiceImpl`) delegates to `OpenMCStatepointService`.
6. `OpenMCStatepointService` calls **`PythonCommandHelper.executeScriptJson()`**.
7. `PythonCommandHelper` detects Python with `openmc` + `h5py`, then runs:
   ```bash
   python server.py openmc.info /path/to/statepoint_100.h5
   ```
8. **Python** reads the HDF5 file and prints JSON to stdout.
9. **Backend** parses JSON and returns `OpenMCStatepointInfo`.
10. **Frontend** updates the `OpenMCStatepointViewerWidget` with the data.

---

## Plugin Design

Each plugin is self-contained:

```
Plugin = {
  common:    protocol types + requirements
  browser:   widgets + commands + contributions + services
  node:      backend service + delegated services
  python:    server script + helper modules
}
```

Plugins reuse shared infrastructure:

- `HealthCheckFramework` — register package requirements once
- `PythonCommandHelper` — detect Python, execute scripts
- `NativeVtkViewerWidget` — native three.js viewer for converted VTK
- `PlotlyService` — display 2D plots

See [Adding a Plugin](adding-a-plugin.md) for the step-by-step creation guide.

---

## Directory Layout

```
extensions/nuke-visualizer/
├── src/
│   ├── common/                          # RPC contracts
│   │   ├── base-visualizer-protocol.ts  # Base viz types + service interface
│   │   ├── openmc-protocol.ts           # OpenMC types + service interface
│   │   └── index.ts                     # Re-exports
│   ├── browser/                         # Frontend
│   │   ├── visualizer-frontend-module.ts    # DI module (bindings)
│   │   ├── contributions/                   # Base viz contributions
│   │   │   ├── visualizer-view-contribution.ts  # View toggle command + keybinding
│   │   │   ├── visualizer-open-handler.ts       # File open routing
│   │   │   └── visualizer-menu-contribution.ts  # Tools → Visualizer menus
│   │   ├── visualizer-widget.tsx            # native viewer widget
│   │   ├── visualizer-preferences.ts        # Settings schema
│   │   ├── plotly/                      # Plotly integration
│   │   │   ├── plotly-service.ts
│   │   │   ├── plotly-component.tsx
│   │   │   └── plotly-utils.ts
│   │   ├── services/                    # Shared frontend services
│   │   │   └── health-check-framework.ts
│   │   └── plugins/openmc/              # OpenMC plugin frontend
│   │       ├── openmc-contribution.ts
│   │       ├── openmc-service.ts
│   │       ├── commands/
│   │       ├── widgets/
│   │       └── services/
│   └── node/                            # Backend
│       ├── visualizer-backend-module.ts     # DI module
│       ├── visualizer-backend-service.ts    # Base viz backend
│       ├── services/                    # Shared backend services
│       │   └── python-command-helper.ts
│       └── plugins/openmc/              # OpenMC plugin backend
│           ├── openmc-backend-service.ts
│           └── services/
├── python/                              # Python scripts
│   ├── server.py                        # Unified entry point
│   ├── nuke_viz/                        # Framework package
│   │   ├── plugin.py                    # @command + @arg decorators
│   │   ├── registry.py                  # Auto-discovery
│   │   └── logging.py                   # Structured warnings
│   └── plugins/                         # Plugin packages
│       ├── openmc/                      # OpenMC plugin
│       │   ├── commands/                # @command-decorated modules
│       │   └── lib/                     # Helper modules
│       └── base/                        # Base visualizer plugin
│           ├── commands/
│           │   └── convert.py           # File format converters (DAGMC, STEP)
│           └── lib/
│               ├── common.py
│               ├── dagmc.py             # DAGMC → VTK library
│               └── step.py              # STEP → VTK library
└── docs/                                # This documentation
```

---

## Key Design Decisions

| Decision                              | Rationale                                                                                                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Native three.js widgets for 3D**    | Converters write VTK (XML or legacy ASCII); the frontend parses and renders client-side. No servers, ports, or iframes — color-by switches instantly with no restart. |
| **React widgets for 2D plots**        | Plotly.js integrates cleanly with React. No server needed — data comes over RPC and renders directly.                                                                 |
| **One Python process per conversion** | Simplifies lifecycle. Each conversion spawns its own short-lived Python process; nothing persists after exit.                                                         |
| **RPC over WebSocket**                | Theia's standard. Bidirectional: frontend calls backend methods; backend streams logs via `VisualizerClient`.                                                         |
| **Health checks in frontend**         | Frontend registers requirements; backend executes them via `nuke-core`. Keeps plugin logic decoupled from env detection.                                              |
