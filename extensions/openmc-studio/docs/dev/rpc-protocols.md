# RPC Protocols

The frontend and backend communicate via **JSON-RPC over WebSocket**, using Theia's `JsonRpcConnectionHandler`. Protocol files in `src/common/` define the contract: TypeScript interfaces that both sides import.

For the full protocol definition, see [`src/common/openmc-studio-protocol.ts`](../../src/common/openmc-studio-protocol.ts).

---

## Protocol File Pattern

Every service follows the same convention:

```typescript
// src/common/openmc-studio-protocol.ts

export const OpenMCStudioBackendService = Symbol('OpenMCStudioBackendService');
export const OPENMC_STUDIO_BACKEND_PATH = '/services/openmc-studio';

export interface OpenMCStudioBackendService {
  // Methods return Promises because they cross the WebSocket boundary
  generateXML(request: XMLGenerationRequest): Promise<XMLGenerationResult>;
  runSimulation(request: SimulationRunRequest): Promise<SimulationRunResult>;
  // ...
}
```

**Rules:**

- Use `Symbol('Name')` for the Inversify service token.
- Export a constant path string starting with `/services/`.
- All method arguments and return types must be serializable (no functions, no class instances, no DOM nodes).
- The backend interface is consumed by the frontend as a _proxy_ and implemented by the backend as a _handler_.

---

## Service Interface: `OpenMCStudioBackendService`

The main backend service interface is intentionally broad — it is the single RPC entry point for all OpenMC Studio operations. It delegates to specialized Node.js services internally.

### Configuration

| Method                    | Purpose                                                                 |
| ------------------------- | ----------------------------------------------------------------------- |
| `setPythonConfig(config)` | Sets Python path / conda env (shared with nuke-visualizer preferences). |

### XML Generation

| Method                   | Purpose                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `generateXML(request)`   | Writes `geometry.xml`, `materials.xml`, `settings.xml`, `tallies.xml` from an `OpenMCState` object. |
| `importXML(request)`     | Parses existing XML files into an `OpenMCState`. Supports merge/replace/preserve strategies.        |
| `validateXML(directory)` | Checks XML files for structural validity without importing.                                         |

**Concept:** XML generation is the bridge between the JSON state model and OpenMC's native input format. The frontend never writes XML directly; it mutates `OpenMCState` and asks the backend to materialize files.

### Simulation Runner

| Method                        | Blocking?        | Purpose                                                                                  |
| ----------------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| `runSimulation(request)`      | **Blocking**     | Spawns OpenMC and returns the complete result (exit code, stdout, stderr, output files). |
| `startSimulation(request)`    | **Non-blocking** | Spawns OpenMC in the background and returns a `processId` immediately.                   |
| `cancelSimulation(processId)` | —                | Kills the running process identified by `processId`.                                     |
| `getSimulationLog(processId)` | —                | Reads the log file for a running or completed simulation.                                |
| `checkOpenMC()`               | —                | Detects whether `openmc` is available and returns version/path.                          |
| `checkMPI()`                  | —                | Detects MPI availability and recommended process count.                                  |

**Concept:** Two execution modes serve different UX needs. The blocking call is used for quick validation runs or when the user explicitly waits. The non-blocking call is used for long production runs where the dashboard shows real-time progress. Both modes write a dedicated log file so output is never lost, even if the WebSocket disconnects.

### Validation

| Method                             | Purpose                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `validateState(request)`           | Checks geometry, materials, settings, tallies, and depletion configuration for errors and warnings. |
| `checkOverlaps(request)`           | Samples geometry for cell overlaps (placeholder for Phase 2).                                       |
| `validateRegion(region, surfaces)` | Parses a region string against the available surface list.                                          |

**Concept:** Validation runs in the backend because it may need to inspect cross-references across the entire state (e.g., verifying that every surface referenced in a cell region actually exists). The frontend can trigger validation on demand or before run/export.

### Project Management

| Method                     | Purpose                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `createProject(request)`   | Creates a `.nuke-openmc` file with default state.                                  |
| `loadProject(projectPath)` | Reads and parses a `.nuke-openmc` file.                                            |
| `saveProject(request)`     | Serializes state to JSON, optionally also generating XML.                          |
| `getTemplates()`           | Returns built-in templates (pin-cell, fuel-assembly, full-core, shielding, blank). |
| `applyTemplate(request)`   | Merges a template's default state into the current state.                          |

### WWINP Import/Export

| Method                 | Purpose                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `importWWINP(request)` | Reads an MCNP weight-window file and returns weight-window bounds. |
| `exportWWINP(request)` | Writes weight-window data in a simplified text-based WWINP format. |

### Statepoint Comparison

| Method                          | Purpose                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `readStatepoint(request)`       | Extracts k-effective, tally data, and batch statistics from a `statepoint_*.h5` file.      |
| `compareStatepoints(request)`   | Reads multiple statepoints and computes comparative statistics (χ², confidence intervals). |
| `readDepletionResults(request)` | Reads `depletion_results.h5` and returns material evolution data.                          |
| `analyzeConvergence(request)`   | Computes running averages, drift, and convergence recommendations from a statepoint.       |

**Concept:** Statepoint operations delegate to `python/statepoint_reader.py`. The backend spawns Python as a subprocess, captures JSON stdout, and returns the parsed result. This keeps HDF5 parsing logic out of TypeScript.

### CAD Import

| Method                 | Purpose                                                                    |
| ---------------------- | -------------------------------------------------------------------------- |
| `checkCADSupport()`    | Reports availability of OpenCASCADE, Gmsh, and CadQuery.                   |
| `importCAD(request)`   | Converts STEP/IGES/BREP/STL to OpenMC CSG surfaces and cells.              |
| `previewCAD(filePath)` | Returns solid count, face count, and bounding box without full conversion. |

**`CADImportRequest.options` fields:**

| Field                 | Type      | Default | Description                                           |
| --------------------- | --------- | ------- | ----------------------------------------------------- |
| `tolerance`           | `number`  | `0.001` | Tolerance for surface approximation in cm             |
| `mergeSurfaces`       | `boolean` | —       | Whether to merge coplanar surfaces                    |
| `scale`               | `number`  | `1.0`   | Scale factor for the geometry                         |
| `units`               | `string`  | `'cm'`  | Input file units (`cm`, `mm`, `m`, `in`, `ft`)        |
| `autoAdjustTolerance` | `boolean` | `true`  | Whether to auto-raise tolerance for very large models |
| `materialId`          | `number`  | —       | Material assignment for imported geometry             |
| `universeId`          | `number`  | `0`     | Universe to place the imported geometry in            |

### DAGMC Editor

| Method                     | Purpose                                                                       |
| -------------------------- | ----------------------------------------------------------------------------- |
| `dagmcLoad(filePath)`      | Reads a `.h5m` file and returns volumes, materials, groups, and bounding box. |
| `dagmcAssignMaterial(...)` | Assigns a material name to a volume in the DAGMC file.                        |
| `dagmcCreateGroup(...)`    | Creates a new group and optionally adds volumes.                              |
| `dagmcDeleteGroup(...)`    | Removes a group from the DAGMC file.                                          |

**Concept:** DAGMC editing operates on the `.h5m` file directly via `pydagmc` / `pymoab`. The backend modifies the file in place and returns success confirmation. The frontend refreshes the DAGMC editor widget by calling `dagmcLoad` again.

### Optimization Framework

| Method                              | Purpose                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `startOptimization(request)`        | Begins a parameter sweep, spawning one OpenMC run per parameter combination. |
| `stopOptimization(request)`         | Cancels a running optimization.                                              |
| `getOptimizationStatus(runId)`      | Returns current iteration, total iterations, and status.                     |
| `getIterationLogsIndex(runId)`      | Lists which iterations have log files and their timestamps.                  |
| `getIterationLog(runId, iteration)` | Returns the full log content for a specific iteration.                       |

### Utility

| Method                     | Purpose                                             |
| -------------------------- | --------------------------------------------------- |
| `getCrossSectionsPath()`   | Reads `OPENMC_CROSS_SECTIONS` environment variable. |
| `suggestMaterialId(state)` | Returns `max(material IDs) + 1`.                    |
| `suggestCellId(state)`     | Returns `max(cell IDs) + 1`.                        |
| `suggestSurfaceId(state)`  | Returns `max(surface IDs) + 1`.                     |
| `suggestTallyId(state)`    | Returns `max(tally IDs) + 1`.                       |
| `suggestMeshId(state)`     | Returns `max(mesh IDs) + 1`.                        |

---

## Client Interface: `OpenMCStudioClient`

The backend pushes events to the frontend via the client object passed during connection setup:

```typescript
export interface OpenMCStudioClient {
  log(message: string): void; // stdout lines
  error(message: string): void; // stderr / errors
  warn(message: string): void; // warnings (toast)
  onSimulationStatus(event: SimulationStatusEvent): void;
  onProgress(progress: SimulationProgress): void;
  onStateChange(event: StateChangeEvent): void;
  onOptimizationProgress(event: OptimizationProgressEvent): void;
  onOptimizationIterationComplete(runId: string, result: OptimizationResult): void;
}
```

**Concept:** The client is the inverse of the service: the backend calls methods on it, and the frontend receives them as events. In the frontend module, the proxy setup maps these callbacks to DOM `CustomEvent`s (e.g., `openmc-simulation-status`, `openmc-optimization-progress`) so that any widget can listen without holding a direct reference to the RPC proxy.

---

## Wiring Frontend Proxy

In `openmc-studio-frontend-module.ts`:

```typescript
bind(OpenMCStudioBackendService)
  .toDynamicValue((ctx) => {
    const connectionProvider = ctx.container.get(WebSocketConnectionProvider);

    const client: OpenMCStudioClient = {
      log: (message) => {
        window.dispatchEvent(
          new CustomEvent('openmc-output', {
            detail: { type: 'stdout', data: message }
          })
        );
      },
      onOptimizationProgress: (event) => {
        window.dispatchEvent(
          new CustomEvent('openmc-optimization-progress', {
            detail: event
          })
        );
      }
      // ... other callbacks
    };

    return connectionProvider.createProxy<OpenMCStudioBackendService>(OPENMC_STUDIO_BACKEND_PATH, client);
  })
  .inSingletonScope();
```

**Important:** Pass the `client` as the second argument to `createProxy`. This registers the frontend's `OpenMCStudioClient` implementation so the backend can stream simulation progress, optimization updates, and log output.

---

## Wiring Backend Handler

In `openmc-studio-backend-module.ts`:

```typescript
bind<ConnectionHandler>(ConnectionHandler)
  .toDynamicValue(
    ({ container }) =>
      new JsonRpcConnectionHandler<OpenMCStudioClient>(OPENMC_STUDIO_BACKEND_PATH, (client) => {
        const backendService = container.get<OpenMCStudioBackendServiceImpl>(OpenMCStudioBackendServiceImpl);
        backendService.setClient(client);
        return backendService;
      })
  )
  .inSingletonScope();
```

The `JsonRpcConnectionHandler` creates a new handler per WebSocket connection. It injects the `client` so the backend can push events. The handler returns the same `OpenMCStudioBackendServiceImpl` instance (singleton) — multiple frontend connections share the orchestrator, but each gets its own client callback channel.

---

## Key Request/Response Types

The protocol file defines granular types for every operation. Rather than listing all fields here, the table below maps conceptual operations to their type names in `openmc-studio-protocol.ts`:

| Domain                    | Request Type                | Response Type                 |
| ------------------------- | --------------------------- | ----------------------------- |
| XML generation            | `XMLGenerationRequest`      | `XMLGenerationResult`         |
| XML import                | `XMLImportRequest`          | `XMLImportResult`             |
| Simulation (blocking)     | `SimulationRunRequest`      | `SimulationRunResult`         |
| Simulation (non-blocking) | `SimulationRunRequest`      | `StartSimulationResponse`     |
| Progress streaming        | —                           | `SimulationProgress`          |
| Validation                | `ValidationRequest`         | `ValidationResult`            |
| Overlap check             | `OverlapCheckRequest`       | `OverlapCheckResult`          |
| Project create            | `ProjectCreateRequest`      | `ProjectCreateResult`         |
| Project save              | `ProjectSaveRequest`        | `{ success, error? }`         |
| Template apply            | `ApplyTemplateRequest`      | `{ success, state?, error? }` |
| CAD import                | `CADImportRequest`          | `CADImportResult`             |
| Statepoint read           | `ReadStatepointRequest`     | `ReadStatepointResult`        |
| Statepoint compare        | `CompareStatepointsRequest` | `CompareStatepointsResult`    |
| Depletion read            | `ReadDepletionRequest`      | `DepletionResults`            |
| Convergence analysis      | `AnalyzeConvergenceRequest` | `KeffConvergenceAnalysis`     |
| Optimization start        | `StartOptimizationRequest`  | `StartOptimizationResult`     |
| Optimization stop         | `StopOptimizationRequest`   | `StopOptimizationResult`      |

For field-level documentation, refer to the JSDoc comments in [`src/common/openmc-studio-protocol.ts`](../../src/common/openmc-studio-protocol.ts).
