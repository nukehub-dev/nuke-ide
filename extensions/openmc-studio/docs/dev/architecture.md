# Architecture

`openmc-studio` is a Theia extension that provides a no-code simulation builder for OpenMC. It bridges TypeScript/React frontend widgets with Node.js backend services and Python scientific computing scripts through a centralized reactive state model.

---

## High-Level Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                        FRONTEND (Browser/Electron)                         │
│                                                                            │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│   │ Simulation   │  │ CSG Builder  │  │ Tally Config │  │ Optimization │   │
│   │ Dashboard    │  │ Widget       │  │ Widget       │  │ Widget       │   │
│   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘   │
│          │                 │                 │                 │           │
│          └─────────────────┴───────┬─────────┴─────────────────┘           │
│                                    │                                       │
│                    ┌───────────────┴───────────────┐                       │
│                    │   OpenMCStateManager          │                       │
│                    │   (central reactive store)    │                       │
│                    └───────────────┬───────────────┘                       │
│                                    │                                       │
│          ┌─────────────────────────┴─────────────────────────┐             │
│          │  Commands / Contributions / Menus / Toolbars      │             │
│          └─────────────────────────┬─────────────────────────┘             │
│                                    │ RPC over WebSocket                    │
└────────────────────────────────────┼───────────────────────────────────────┘
                                     │
┌────────────────────────────────────┼───────────────────────────────────────┐
│                              BACKEND (Node.js)                             │
│                                    │                                       │
│          ┌─────────────────────────┴─────────────────────────┐             │
│          │          OpenMCStudioBackendServiceImpl           │             │
│          │          (orchestrates domain services)           │             │
│          └────────────┬──────────────┬──────────────┬────────┘             │
│                       │              │              │                      │
│  ┌────────────────────┴─┐  ┌─────────┴─────┐  ┌─────┴──────────────────┐   │
│  │  OpenMCRunnerService │  │ XMLGeneration │  │ OpenMCCADImportService │   │
│  │  (spawn / stream)    │  │ Service       │  │ (CAD → CSG/DAGMC)      │   │
│  └───────────┬──────────┘  └────────┬──────┘  └──────────┬─────────────┘   │
│              │                      │                    │                 │
│   ┌──────────┴──────────┐  ┌────────┴────────┐  ┌────────┴────────┐        │
│   │ DAGMCEditorService  │  │ Optimization    │  │ OpenMCValidation│        │
│   │ (pydagmc edits)     │  │ BackendService  │  │ BackendService  │        │
│   └──────────┬──────────┘  └────────┬────────┘  └─────────┬───────┘        │
│              │                      │                     │                │
│              └──────────────────────┼─────────────────────┘                │
│                                     │ spawn / exec                         │
└─────────────────────────────────────┼──────────────────────────────────────┘
                                      │
┌─────────────────────────────────────┼────────────────────────────────────────┐
│                        PYTHON LAYER │                                        │
│                                     │                                        │
│   ┌─────────────────────────────────┴────────────────────────────────────┐   │
│   │  statepoint_reader.py  │  run_depletion.py  │  cad_helpers/          │   │
│   │  ────────────────────  │  ───────────────── │  ───────────────────── │   │
│   │  • read statepoint     │  • burnup calc     │  • STEP/IGES import    │   │
│   │  • compare tallies     │  • chain evolution │  • faceting            │   │
│   │  • k-eff convergence   │  • power history   │  • CSG conversion      │   │
│   └──────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Layers

### 1. Frontend Layer (`src/browser/`)

The frontend runs in the browser/Electron renderer. It is built on **Theia** and uses **InversifyJS** for dependency injection.

**Responsibilities:**
- Render React widgets for simulation authoring (dashboard, CSG builder, tally configurator, optimization)
- Register commands, menus, keyboard shortcuts, and toolbar items
- Handle `.nuke-openmc` file open events via `OpenHandler`
- Maintain the authoritative simulation state via `OpenMCStateManager`
- Call backend services over RPC for XML generation, simulation runs, and file I/O

**Key concepts:**
- **Centralized state manager:** `OpenMCStateManager` is a singleton reactive store. All widgets read from it and mutate through its CRUD methods. Changes emit `StateChangeEvent`s that widgets subscribe to.
- **Contribution pattern:** Classes implement `CommandContribution`, `MenuContribution`, `TabBarToolbarContribution`, etc., and are bound in the DI module.
- **Widget factories:** Each widget type is registered with a `WidgetFactory` so Theia's `WidgetManager` can create instances on demand.

### 2. Common Layer (`src/common/`)

TypeScript interfaces shared by both frontend and backend. These define the RPC contract and the simulation state schema.

**Responsibilities:**
- Define the JSON-RPC service interface (`OpenMCStudioBackendService`)
- Define request/response types for XML generation, simulation runs, validation, CAD import, etc.
- Define the complete `OpenMCState` schema — the data model for the no-code builder

**Key files:**
- `openmc-studio-protocol.ts` — RPC contract + domain request/response types (~1200 lines)
- `openmc-state-schema.ts` — `OpenMCState` and all sub-types (~1150 lines)

### 3. Backend Layer (`src/node/`)

The backend runs in Node.js. It coordinates domain services and spawns Python processes.

**Responsibilities:**
- Accept RPC calls from the frontend via `JsonRpcConnectionHandler`
- Generate OpenMC XML files from `OpenMCState`
- Spawn and manage OpenMC simulation processes (blocking and non-blocking)
- Stream simulation stdout/stderr and progress back to the frontend
- Import CAD files and edit DAGMC models
- Run parameter sweep optimizations

**Key concepts:**
- **Orchestration service:** `OpenMCStudioBackendServiceImpl` is the single RPC entry point. It delegates to specialized services (runner, XML, CAD, DAGMC, optimization).
- **Process management:** `OpenMCRunnerService` tracks running simulations in a `Map<processId, RunningSimulation>`. Each simulation gets its own log file and can be cancelled independently.
- **Service isolation:** XML generation, CAD import, and optimization each have their own service class, keeping the orchestrator thin.

### 4. Python Layer (`python/`)

Python scripts that perform scientific computing operations that are impractical in TypeScript.

**Responsibilities:**
- Read OpenMC statepoint and depletion HDF5 files
- Compare multiple statepoint results with statistical tests
- Execute depletion calculations with OpenMC + `openmc.deplete`
- Convert CAD files (STEP/IGES/BREP) to OpenMC-compatible CSG or DAGMC
- Facet and edit DAGMC models via `pydagmc` / `pymoab`

---

## Data Flow Example: Running a Simulation

1. **User clicks** "Run Simulation" in the Simulation Dashboard widget.
2. **Frontend** calls `OpenMCStateManager.validate()` to perform client-side checks.
3. **`OpenMCStudioService`** (frontend) calls `backendService.generateXML()` over RPC with the current `OpenMCState`.
4. **Backend** (`XMLGenerationService`) writes `geometry.xml`, `materials.xml`, `settings.xml`, and `tallies.xml` to the project directory.
5. **Frontend** then calls `backendService.startSimulation()` (non-blocking) with the working directory and MPI configuration.
6. **Backend** (`OpenMCRunnerService`) spawns `openmc` (or `mpiexec -n N openmc`) as a child process, assigns a `processId`, and creates a log file.
7. **Backend** parses stdout in real time, extracts batch progress and k-effective values, and streams `SimulationProgress` events to the frontend via the RPC `client`.
8. **Frontend** receives progress via DOM `CustomEvent`s dispatched by the RPC client proxy, and updates the dashboard progress bar.
9. When the process exits, the backend stores the result in `completedSimulations` and notifies the frontend.
10. **Frontend** refreshes the output file list and enables post-processing actions (statepoint read, comparison, etc.).

---


## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **React widgets (not iframe)** | The no-code builder requires tight two-way data binding with the central state manager. React + direct DOM events give lower latency and simpler state sync than iframe message passing. |
| **JSON-RPC over WebSocket** | Theia's standard transport. Bidirectional: frontend calls backend methods; backend streams progress/logs via the `OpenMCStudioClient` callback interface. |
| **Centralized state manager** | A single `OpenMCStateManager` prevents sync bugs between widgets. All mutations emit granular events (`StateChangeEvent`) so UI updates are targeted and efficient. |
| **State-as-JSON schema** | `OpenMCState` is plain JSON — serializable, diffable, and directly mappable to OpenMC XML. Enables save-to-file (`.nuke-openmc`) and easy migration via schema versioning. |
| **Orchestrator + specialized services** | `OpenMCStudioBackendServiceImpl` is the sole RPC handler. It delegates to `OpenMCRunnerService`, `XMLGenerationService`, etc. This keeps RPC wiring in one place while allowing domain logic to evolve independently. |
| **Blocking vs non-blocking runs** | `runSimulation()` blocks until completion (good for short runs); `startSimulation()` returns immediately with a `processId` (good for long runs with progress streaming). Both are available so UI can choose the right UX. |
| **Python as subprocess (not server)** | Unlike nuke-visualizer's Trame servers, openmc-studio spawns short-lived Python scripts or OpenMC processes directly. This avoids port management overhead for batch compute workloads. |
