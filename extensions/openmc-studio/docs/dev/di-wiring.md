# DI Wiring

`openmc-studio` uses **InversifyJS** (via Theia) for dependency injection. Understanding how the container modules work is essential for adding widgets, services, or new backend capabilities.

For the full module definitions, see:
- Frontend: [`src/browser/openmc-studio-frontend-module.ts`](../../src/browser/openmc-studio-frontend-module.ts)
- Backend: [`src/node/openmc-studio-backend-module.ts`](../../src/node/openmc-studio-backend-module.ts)

---

## Service Dependency Graph

```
Frontend (Browser)
│
├─ OpenMCStudioBackendService  ──── RPC ────►  Backend (Node.js)
│   (proxy)                                         │
├─ OpenMCStateManager                             ├─ OpenMCStudioBackendServiceImpl
│   ├─ uses ──► OpenMCStudioBackendService        │   ├─ uses ──► OpenMCRunnerService
│   └─ emits ──► StateChangeEvent                 │   ├─ uses ──► XMLGenerationService
│                                                 │   ├─ uses ──► OpenMCCADImportService
├─ OpenMCStudioService                            │   ├─ uses ──► DAGMCEditorService
│   └─ uses ──► OpenMCStateManager                │   └─ uses ──► OptimizationBackendService
│                                                 │
├─ OpenMCXMLGenerationService                     ├─ OpenMCRunnerService
│   └─ uses ──► OpenMCStudioBackendService        │   ├─ uses ──► ProcessManager
│                                                 │   └─ uses ──► NukeCoreBackendService
├─ OpenMCSimulationRunner                         │
│   └─ uses ──► OpenMCStudioBackendService        ├─ XMLGenerationService
│                                                 │
├─ OpenMCPythonExporter                           ├─ OpenMCCADImportService
│                                                 │   └─ uses ──► NukeCoreBackendService
├─ OpenMCEnvironmentService                       │
├─ OpenMCHealthService                            ├─ DAGMCEditorService
└─ OpenMCInstallerService                         │
                                                  ├─ OptimizationBackendService
                                                  │   └─ uses ──► OpenMCRunnerService
                                                  │
                                                  └─ OpenMCValidationBackendService
                                                      └─ uses ──► NukeCoreBackendService
```

---

## Frontend Module

**File:** `src/browser/openmc-studio-frontend-module.ts`

This is the entry point for the browser side. It exports a `ContainerModule` that tells Inversify how to instantiate everything.

### 1. Backend RPC Proxy

```typescript
bind(OpenMCStudioBackendService).toDynamicValue(ctx => {
    const connectionProvider = ctx.container.get(WebSocketConnectionProvider);

    const client: OpenMCStudioClient = {
        log: (message) => {
            window.dispatchEvent(new CustomEvent('openmc-output', {
                detail: { type: 'stdout', data: message }
            }));
        },
        onSimulationStatus: (event) => { /* ... */ },
        onOptimizationProgress: (event) => { /* ... */ },
        // ...
    };

    return connectionProvider.createProxy<OpenMCStudioBackendService>(
        OPENMC_STUDIO_BACKEND_PATH, client
    );
}).inSingletonScope();
```

The proxy is a **dynamic value** because it needs to capture the `client` object at creation time. The `client` converts backend push events into DOM `CustomEvent`s so that widgets can subscribe without importing the RPC layer directly.

### 2. Core Services

```typescript
bind(OpenMCStudioService).toSelf().inSingletonScope();
bind(OpenMCStateManager).toSelf().inSingletonScope();
bind(OpenMCXMLGenerationService).toSelf().inSingletonScope();
bind(OpenMCSimulationRunner).toSelf().inSingletonScope();
bind(OpenMCPythonExporter).toSelf().inSingletonScope();
```

| Service | Responsibility |
|---------|----------------|
| `OpenMCStudioService` | High-level orchestration: new project, open project, run simulation, export Python script. |
| `OpenMCStateManager` | Central reactive store for `OpenMCState`. CRUD for geometry, materials, tallies, meshes, settings, depletion, variance reduction, and optimization. |
| `OpenMCXMLGenerationService` | Frontend-side XML generation helpers (complements the backend service). |
| `OpenMCSimulationRunner` | Widget-facing simulation controller: starts runs, polls progress, handles cancellation. |
| `OpenMCPythonExporter` | Generates standalone Python scripts from the current state for users who want to leave the GUI. |

### 3. Environment & Health Services

```typescript
bind(OpenMCEnvironmentService).toSelf().inSingletonScope();
bind(OpenMCHealthService).toSelf().inSingletonScope();
bind(OpenMCInstallerService).toSelf().inSingletonScope();
```

| Service | Responsibility |
|---------|----------------|
| `OpenMCEnvironmentService` | Detects Python environments, OpenMC installations, and cross-sections paths. |
| `OpenMCHealthService` | Runs diagnostic checks and reports environment issues to the user. |
| `OpenMCInstallerService` | Guides users through installing missing dependencies (OpenMC, MPI, etc.). |

### 4. Command Modules

```typescript
bind(EnvironmentCommands).toSelf().inSingletonScope();
bind(ProjectCommands).toSelf().inSingletonScope();
bind(SimulationCommands).toSelf().inSingletonScope();
bind(ViewCommands).toSelf().inSingletonScope();
```

Commands are grouped by domain. Each class implements `CommandContribution` and registers its commands in the Theia command registry. Keeping them in separate classes avoids a single monolithic contribution file.

### 5. Contributions

```typescript
bind(OpenMCCommandContribution).toSelf().inSingletonScope();
bind(CommandContribution).toService(OpenMCCommandContribution);

bind(OpenMCMenuContribution).toSelf().inSingletonScope();
bind(MenuContribution).toService(OpenMCMenuContribution);

bind(OpenMCToolbarContribution).toSelf().inSingletonScope();
bind(TabBarToolbarContribution).toService(OpenMCToolbarContribution);

bind(OpenMCOpenHandlerContribution).toSelf().inSingletonScope();
bind(OpenHandler).toService(OpenMCOpenHandlerContribution);
bind(FrontendApplicationContribution).toService(OpenMCOpenHandlerContribution);
```

| Contribution | Purpose |
|--------------|---------|
| `OpenMCCommandContribution` | Registers all domain commands (project, simulation, view, environment). |
| `OpenMCMenuContribution` | Adds menu items under the Theia menu bar (e.g., OpenMC → Run Simulation). |
| `OpenMCToolbarContribution` | Adds toolbar buttons to widget tab bars (e.g., play/stop icons). |
| `OpenMCOpenHandlerContribution` | Intercepts file double-clicks for `.nuke-openmc` files and opens the project. |

### 6. Widget Factories

```typescript
bind(SimulationDashboardWidget).toSelf();
bind(WidgetFactory).toDynamicValue(({ container }) => ({
    id: SimulationDashboardWidget.ID,
    createWidget: () => container.get(SimulationDashboardWidget)
})).inSingletonScope();
```

The pattern is repeated for each widget:
- `SimulationDashboardWidget`
- `CSGBuilderWidget`
- `DAGMCEditorWidget`
- `TallyConfiguratorWidget`
- `SimulationComparisonWidget`
- `OptimizationWidget`

**Concept:** Widget classes are bound with default scope (transient in Inversify) so each tab gets a fresh instance. The `WidgetFactory` is a singleton that produces instances on demand. `OptimizationWidget` is explicitly `inTransientScope()` to guarantee independence between multiple optimization panels.

---

## Backend Module

**File:** `src/node/openmc-studio-backend-module.ts`

The backend module binds domain services and registers the JSON-RPC connection handler.

### 1. Domain Services

```typescript
bind(XMLGenerationService).toSelf().inSingletonScope();
bind(OpenMCRunnerService).toSelf().inSingletonScope();
bind(OpenMCCADImportService).toSelf().inSingletonScope();
bind(DAGMCEditorService).toSelf().inSingletonScope();
bind(OptimizationBackendService).toSelf().inSingletonScope();
bind(OpenMCValidationBackendService).toSelf().inSingletonScope();
```

| Service | Responsibility |
|---------|----------------|
| `XMLGenerationService` | Converts `OpenMCState` into OpenMC XML files. |
| `OpenMCRunnerService` | Spawns `openmc` and `mpiexec`, manages process lifecycle, streams logs. |
| `OpenMCCADImportService` | Imports STEP/IGES/BREP/STL and converts to CSG or DAGMC. |
| `DAGMCEditorService` | Reads and modifies DAGMC `.h5m` files via `pydagmc`. |
| `OptimizationBackendService` | Executes parameter sweeps by mutating state clones and running OpenMC per iteration. |
| `OpenMCValidationBackendService` | Environment detection and deep state validation. |

### 2. Orchestrator Service

```typescript
bind(OpenMCStudioBackendServiceImpl).toSelf().inSingletonScope();
bind(OpenMCStudioBackendService).toService(OpenMCStudioBackendServiceImpl);
```

- `OpenMCStudioBackendServiceImpl` is the actual implementation (~2000 lines).
- `OpenMCStudioBackendService` is the interface token.
- The orchestrator is a singleton: all frontend connections share the same instance, but each connection gets its own client callback channel.

### 3. JSON-RPC Connection Handler

```typescript
bind<ConnectionHandler>(ConnectionHandler).toDynamicValue(({ container }) =>
    new JsonRpcConnectionHandler<OpenMCStudioClient>(OPENMC_STUDIO_BACKEND_PATH, client => {
        const backendService = container.get<OpenMCStudioBackendServiceImpl>(
            OpenMCStudioBackendServiceImpl
        );
        backendService.setClient(client);
        return backendService;
    })
).inSingletonScope();
```

**Concept:** Theia creates one `JsonRpcConnectionHandler` per WebSocket path. When a frontend connects, Theia instantiates a handler, passes the frontend's `client` object to `setClient()`, and returns the backend service implementation as the RPC target. Because the backend service is a singleton, its internal state (running simulations, optimization runs) is shared across all connections.

### 4. Application Lifecycle

```typescript
bind(BackendApplicationContribution).to(RpcBufferConfiguration).inSingletonScope();
bind(BackendApplicationContribution).toDynamicValue(({ container }) =>
    container.get(OpenMCStudioBackendServiceImpl)
).inSingletonScope();
```

- `RpcBufferConfiguration` increases WebSocket buffer limits to prevent "Max disconnected buffer size exceeded" errors during large simulation log streaming.
- `OpenMCStudioBackendServiceImpl` is also bound as a `BackendApplicationContribution` so its `onStop()` method is called on shutdown, terminating any running simulations gracefully.

---

## Scope Reference

| Scope | Meaning | When to Use |
|-------|---------|-------------|
| `inSingletonScope()` | One instance per container | Services, frameworks, factories, state manager |
| `inTransientScope()` | New instance every time | Widgets (each tab must be independent) |
| default (no scope) | New instance per injection | Widget classes when `inTransientScope()` is not explicit |
| `toDynamicValue()` | Factory function | RPC proxies that need client setup at creation time |
| `toService()` | Alias one symbol to another | Binding interface tokens to their implementations |

---

## Common Patterns

### Adding a New Widget

```typescript
// 1. Define the widget class
@injectable()
export class MyWidget extends ReactWidget {
    static readonly ID = 'my-widget';
    // ...
}

// 2. Bind in frontend module
bind(MyWidget).toSelf();
bind(WidgetFactory).toDynamicValue(({ container }) => ({
    id: MyWidget.ID,
    createWidget: () => container.get(MyWidget)
})).inSingletonScope();

// 3. Open it
const widget = await widgetManager.getOrCreateWidget(MyWidget.ID);
await shell.addWidget(widget, { area: 'main' });
```

### Adding a New Backend Service

```typescript
// 1. Define the service
@injectable()
export class MyBackendService {
    @inject(OpenMCRunnerService)
    protected readonly runner: OpenMCRunnerService;
    // ...
}

// 2. Bind in backend module
bind(MyBackendService).toSelf().inSingletonScope();

// 3. Inject into the orchestrator
@inject(MyBackendService)
protected readonly myService: MyBackendService;
```

### Adding a New RPC Method

```typescript
// 1. Add to the interface in src/common/openmc-studio-protocol.ts
export interface OpenMCStudioBackendService {
    myOperation(request: MyRequest): Promise<MyResult>;
}

// 2. Implement in OpenMCStudioBackendServiceImpl
async myOperation(request: MyRequest): Promise<MyResult> {
    return this.myService.doWork(request);
}

// 3. Use from the frontend via the injected proxy
const result = await this.backendService.myOperation(req);
```

No additional wiring is required — Theia's `JsonRpcConnectionHandler` exposes all methods on the backend service implementation automatically.

---

## Troubleshooting DI Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| "No matching bindings found" | Symbol not bound in module | Add `bind(MyService).toSelf()` to the appropriate module |
| Widget not created | `WidgetFactory` missing or wrong ID | Check `id` matches `WidgetFactory.id` exactly |
| Command not in palette | `CommandContribution` not bound | `bind(CommandContribution).toService(...)` |
| RPC call fails | Path mismatch or handler not bound | Verify `OPENMC_STUDIO_BACKEND_PATH` matches both frontend and backend |
| Singleton state leaks | Widget in singleton scope | Use default scope or `inTransientScope()` for widgets |
| Backend events not received | Client not passed to `createProxy` | Ensure the second argument to `createProxy` is the `OpenMCStudioClient` object |
