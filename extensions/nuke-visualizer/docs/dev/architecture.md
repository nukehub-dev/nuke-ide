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

- Render widgets (React-based or iframe-based)
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
- `openmc-protocol.ts` — OpenMC RPC + ~1400 lines of domain types

### 3. Backend Layer (`src/node/`)

The backend runs in Node.js. It spawns Python processes and manages their lifecycle.

**Responsibilities:**

- Accept RPC calls from the frontend
- Detect Python environments with required packages
- Spawn Python visualization servers on free ports
- Stream stdout/stderr back to the frontend via `VisualizerClient`
- Convert file formats (e.g., DAGMC .h5m → VTK)

**Key concepts:**

- **RPC handlers:** `RpcConnectionHandler` maps a WebSocket path to a service implementation.
- **Process management:** Each visualization server gets its own `RawProcess`. Processes are tracked in a `Map<port, process>` and killed on shutdown.
- **Port allocation:** `findFreePort(startPort)` scans for an available TCP port.

### 4. Python Layer (`python/`)

Python scripts that do the actual scientific visualization.

**Responsibilities:**

- Read domain-specific files (HDF5, XML, VTK)
- Render 3D scenes (Trame + ParaView)
- Compute derived data (spectra, spatial plots, cross-sections)
- Serve HTTP on the loopback interface (`127.0.0.1:<port>`)

Browser traffic never touches these ports directly: `VisualizerProxyContribution` (in `src/node/visualizer-proxy-contribution.ts`) reverse-proxies `/visualizer/<port>/*` (HTTP + WebSocket) on the Theia backend to `127.0.0.1:<port>`, restricted to ports registered by the visualizer/OpenMC backend services. This makes the widgets work when the IDE runs behind nginx in a container, where loopback ports are unreachable from the user's browser. Widget iframes convert server URLs via `toProxiedVisualizerUrl()` (`src/browser/visualizer-url.ts`), which builds the proxy path with Theia's `Endpoint` class. Trame is path-prefix friendly (relative asset paths, ws URL derived from the page directory), so no response rewriting is needed.

**Key scripts:**

- `server.py` — Unified entry point with auto-discovery and plugin routing
- `nuke_viz/` — Shared framework (`@command` decorator, registry, server)
- `plugins/openmc/` — OpenMC plugin (commands + lib modules)
- `plugins/base/` — Base visualizer plugin (Trame server, file converters, shared libraries)

Plugins register commands via the `@command` decorator. Importing a command module triggers registration automatically — no manual routing needed.

---

## Data Flow Example: Opening a Statepoint

1. **User double-clicks** `statepoint_100.h5` in the Explorer.
2. **`OpenMCContribution.canHandle()`** returns `200` (high priority).
3. **`OpenMCContribution.open()`** is called.
4. It calls **`OpenMCService.loadStatepoint()`** which:
   - Checks OpenMC availability via `HealthCheckFramework`
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
- `VisualizerWidget` — iframe container for Python servers
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
│   │   ├── visualizer-contribution.ts       # Base viz commands/menus/OpenHandler
│   │   ├── visualizer-widget.tsx            # iframe widget
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
│   │   └── server.py                    # CLI routing
│   └── plugins/                         # Plugin packages
│       ├── openmc/                      # OpenMC plugin
│       │   ├── commands/                # @command-decorated modules
│       │   └── lib/                     # Helper modules
│       └── base/                        # Base visualizer plugin
│           ├── commands/
│           │   ├── serve.py             # Trame visualization server
│           │   └── convert.py           # File format converters (DAGMC, STEP)
│           └── lib/
│               ├── common.py
│               ├── dagmc.py             # DAGMC → VTK library
│               └── step.py              # STEP → VTK library
└── docs/                                # This documentation
```

---

## Key Design Decisions

| Decision                                 | Rationale                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **iframe widgets for 3D**                | Trame/Dash render their own HTML/Canvas. An iframe isolates them from Theia's CSS and gives full control.                |
| **React widgets for 2D plots**           | Plotly.js integrates cleanly with React. No server needed — data comes over RPC and renders directly.                    |
| **One Python process per visualization** | Simplifies lifecycle. Killing a tab kills its server. No shared state corruption.                                        |
| **RPC over WebSocket**                   | Theia's standard. Bidirectional: frontend calls backend methods; backend streams logs via `VisualizerClient`.            |
| **Health checks in frontend**            | Frontend registers requirements; backend executes them via `nuke-core`. Keeps plugin logic decoupled from env detection. |
