# Widget Patterns

All OpenMC Studio widgets are React widgets living inside the Theia IDE. They extend `ReactWidget`, use Inversify for dependency injection, and communicate with backend services via JSON-RPC.

---

## Widget Basics

Every widget extends `ReactWidget` and is bound in the frontend DI module as a `WidgetFactory`.

```
┌─────────────────────────────────────────────┐
│  Theia IDE                                  │
│  ┌───────────────────────────────────────┐  │
│  │  SimulationDashboardWidget            │  │
│  │  ┌─────────────────────────────────┐  │  │
│  │  │  React + CSS                    │  │  │
│  │  │  (tabs, forms, tables, charts)  │  │  │
│  │  └─────────────────────────────────┘  │  │
│  └───────────────────────────────────────┘  │
│                    │ RPC                    │
│  ┌───────────────────────────────────────┐  │
│  │  OpenMCStudioBackendService           │  │
│  │  (Node backend / Python scripts)      │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

### Core Widgets

| Widget                       | File                                                           | Purpose                                                                 |
| ---------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `SimulationDashboardWidget`  | `widgets/simulation-dashboard/simulation-dashboard-widget.tsx` | Main dashboard: settings, materials, tallies, depletion, VR, simulation |
| `CSGBuilderWidget`           | `widgets/csg-builder/csg-builder-widget.tsx`                   | Constructive Solid Geometry editor                                      |
| `DAGMCEditorWidget`          | `widgets/dagmc-editor/dagmc-editor-widget.tsx`                 | DAGMC geometry editor                                                   |
| `TallyConfiguratorWidget`    | `widgets/tally-configurator/tally-configurator-widget.tsx`     | Tally and mesh configuration                                            |
| `OptimizationWidget`         | `widgets/optimization/optimization-widget.tsx`                 | Parameter sweep studies                                                 |
| `SimulationComparisonWidget` | `widgets/simulation-comparison/comparison-widget.tsx`          | Statepoint comparison                                                   |

---

## Extending ReactWidget

### Minimal Widget Template

```typescript
import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { MessageService } from '@theia/core/lib/common/message-service';
import { OpenMCStateManager } from '../../openmc-state-manager';

@injectable()
export class MyWidget extends ReactWidget {
    static readonly ID = 'openmc-my-widget';
    static readonly LABEL = 'My Widget';

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    @inject(OpenMCStateManager)
    protected readonly stateManager!: OpenMCStateManager;

    @postConstruct()
    protected init(): void {
        this.id = MyWidget.ID;
        this.title.label = MyWidget.LABEL;
        this.title.caption = MyWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-symbol-method';
        this.update();
    }

    protected render(): React.ReactNode {
        const state = this.stateManager.getState();
        return <div className='my-widget'>Hello, {state.metadata.name}!</div>;
    }
}
```

### Rules

- Use `static readonly ID` — unique widget identifier used by `WidgetManager`.
- Use `static readonly LABEL` — display label for the widget title.
- Use `!` (definite assignment assertion) on injected properties to satisfy strict TypeScript.
- Perform all setup in `@postConstruct()` — do NOT use a constructor for ReactWidget subclasses.
- Call `this.update()` after any state change to trigger a React re-render.

---

## Widget Lifecycle

| Event     | Method                | Typical Action                                             |
| --------- | --------------------- | ---------------------------------------------------------- |
| Created   | `@postConstruct()`    | Set id, title, icon, register listeners                    |
| Shown     | `onAfterShow()`       | Start polling, request status bar visibility               |
| Hidden    | `onBeforeHide()`      | Stop polling, release visibility handle                    |
| Activated | `onActivateRequest()` | Sync state with backend runner                             |
| Disposed  | `dispose()`           | Stop intervals, clean up resources, call `super.dispose()` |

### Example: Lifecycle Management

```typescript
@postConstruct()
protected init(): void {
    this.id = SimulationDashboardWidget.ID;
    this.title.label = SimulationDashboardWidget.LABEL;
    this.title.closable = true;
    this.title.iconClass = 'codicon codicon-dashboard';

    // Listen to state changes
    this.stateManager.onStateChange(() => this.update());
    this.stateManager.onDirtyChange(() => this.updateTitle());

    this.update();
}

protected onAfterShow(msg: any): void {
    super.onAfterShow(msg);
    this.visibilityHandle = this.statusBarVisibility.requestVisibility('openmc-studio');
}

protected onBeforeHide(msg: any): void {
    this.visibilityHandle?.dispose();
    this.visibilityHandle = undefined;
    super.onBeforeHide(msg);
}

protected onActivateRequest(msg: any): void {
    super.onActivateRequest(msg);
    // Sync running state with simulation runner when widget becomes active
    const runnerState = (this.simulationRunner as any)['_isRunning'];
    if (this.isRunning !== runnerState) {
        this.isRunning = runnerState;
        this.update();
    }
}

dispose(): void {
    this.stopLogPolling();
    this.visibilityHandle?.dispose();
    super.dispose();
}
```

---

## State Management

Two options: React component state (private fields) or `OpenMCStateManager` (shared application state).

### Option A: React Component State (Widget-Local)

Best for UI state that does not need to persist or be shared.

```typescript
private activeTab: DashboardTab = 'settings';
private isRunning = false;
private consoleOutput: { type: 'info' | 'error'; message: string }[] = [];

// In render()
<button onClick={() => { this.activeTab = 'materials'; this.update(); }}>
    Materials
</button>
```

**Key rule:** After mutating a private field, always call `this.update()` to trigger re-render.

### Option B: OpenMCStateManager (Shared)

Best for simulation data that other widgets or the backend need to access.

```typescript
// Read state (returns a deep copy)
const state = this.stateManager.getState();

// Modify state — fires onStateChange event
this.stateManager.addMaterial(newMaterial);
this.stateManager.updateSettings({ run: { mode: 'fixed source', particles: 10000, batches: 50 } });
```

**State manager events:**

| Event           | Fires When                       | Typical Listener                |
| --------------- | -------------------------------- | ------------------------------- |
| `onStateChange` | Granular add/update/delete       | `this.update()` to re-render    |
| `onStateReload` | Full state replaced (load/reset) | Reset local UI state            |
| `onDirtyChange` | Dirty flag toggles               | Update title with `●` indicator |

---

## Command Registration Pattern

Commands are grouped by domain into injectable command classes.

### Step 1: Define Command Constants

```typescript
// src/browser/commands/my-commands.ts
export namespace OpenMCMyCommands {
  export const CATEGORY = 'OpenMC/MyFeature';

  export const RUN_ANALYSIS: Command = {
    id: 'openmc.runAnalysis',
    category: CATEGORY,
    label: 'Run Analysis'
  };
}
```

### Step 2: Create Command Handler Class

```typescript
@injectable()
export class MyCommands {
  @inject(WidgetManager)
  protected readonly widgetManager: WidgetManager;

  @inject(ApplicationShell)
  protected readonly shell: ApplicationShell;

  @inject(OpenMCStudioBackendService)
  protected readonly backend: OpenMCStudioBackendService;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(OpenMCMyCommands.RUN_ANALYSIS, {
      execute: () => this.runAnalysis()
    });
  }

  private async runAnalysis(): Promise<void> {
    const result = await this.backend.runAnalysis();
    // ... handle result
  }
}
```

### Step 3: Register in Frontend Module

```typescript
bind(MyCommands).toSelf().inSingletonScope();
```

### Step 4: Aggregate in Command Contribution

```typescript
// OpenMCCommandContribution registers all domain command classes
this.myCommands.registerCommands(registry);
```

See [`openmc-command-contribution.ts`](../../src/browser/contributions/openmc-command-contribution.ts) for the aggregator pattern.

---

## Menu and Toolbar Contribution Pattern

### Menu Contribution

```typescript
// src/browser/contributions/openmc-menu-contribution.ts
export namespace OpenMCMenus {
  export const OPENMC = [...NukeMenus.TOOLS, '1_openmc'];
  export const OPENMC_MYFEATURE = [...OPENMC, '5_myfeature'];
}

@injectable()
export class OpenMCMenuContribution implements MenuContribution {
  registerMenus(menus: MenuModelRegistry): void {
    menus.registerSubmenu(OpenMCMenus.OPENMC_MYFEATURE, 'My Feature');

    menus.registerMenuAction(OpenMCMenus.OPENMC_MYFEATURE, {
      commandId: OpenMCMyCommands.RUN_ANALYSIS.id,
      label: 'Run Analysis',
      order: 'a'
    });
  }
}
```

### Toolbar Contribution

Toolbar items are scoped to a specific widget type via `isVisible`:

```typescript
@injectable()
export class OpenMCToolbarContribution implements TabBarToolbarContribution {
  registerToolbarItems(registry: TabBarToolbarRegistry): void {
    const isVisible = (widget?: any) => widget instanceof SimulationDashboardWidget;

    registry.registerItem({
      id: OpenMCSimulationCommands.RUN_SIMULATION.id,
      command: OpenMCSimulationCommands.RUN_SIMULATION.id,
      tooltip: 'Run Simulation',
      priority: 100,
      onDidChange: this.onDidChange,
      isVisible
    });
  }
}
```

See [`openmc-toolbar-contribution.ts`](../../src/browser/contributions/openmc-toolbar-contribution.ts).

---

## Backend Communication via RPC

Widgets do NOT call Python directly. They call the backend service proxy over JSON-RPC.

### Architecture

```
Widget → OpenMCStudioBackendService (frontend proxy)
              │ WebSocket RPC
              ▼
       OpenMCStudioBackendServiceImpl (Node backend)
              │ child_process.spawn / executeScriptJson
              ▼
              Python script
```

### Example: Button That Triggers Backend Action

```typescript
@injectable()
export class MyWidget extends ReactWidget {
    @inject(OpenMCStudioBackendService)
    protected readonly backend!: OpenMCStudioBackendService;

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    protected render(): React.ReactNode {
        return (
            <button
                className='theia-button primary'
                onClick={() => this.handleAnalyze()}
            >
                <i className='codicon codicon-play'></i>
                Analyze Geometry
            </button>
        );
    }

    private async handleAnalyze(): Promise<void> {
        try {
            const state = this.stateManager.getState();
            const result = await this.backend.validateState({
                state,
                level: 'standard'
            });

            if (result.valid) {
                this.messageService.info('Model is valid');
            } else {
                for (const issue of result.issues) {
                    if (issue.severity === 'error') {
                        this.messageService.error(issue.message);
                    }
                }
            }
        } catch (err) {
            this.messageService.error(`Analysis failed: ${err}`);
        }
    }
}
```

### Using Events from Backend

The backend can push events to the frontend via the client interface:

```typescript
// In frontend module: create proxy with client callbacks
bind(OpenMCStudioBackendService)
  .toDynamicValue((ctx) => {
    const connectionProvider = ctx.container.get(WebSocketConnectionProvider);

    const client: OpenMCStudioClient = {
      log: (message: string) => {
        window.dispatchEvent(
          new CustomEvent('openmc-output', {
            detail: { type: 'stdout', data: message }
          })
        );
      },
      onSimulationStatus: (event) => {
        window.dispatchEvent(
          new CustomEvent('openmc-simulation-status', {
            detail: event
          })
        );
      }
    };

    return connectionProvider.createProxy<OpenMCStudioBackendService>(OPENMC_STUDIO_BACKEND_PATH, client);
  })
  .inSingletonScope();
```

Widgets listen for these window events:

```typescript
window.addEventListener('openmc-simulation-status', ((evt: CustomEvent) => {
  const event = evt.detail as SimulationStatusEvent;
  this.isRunning = event.status === 'running';
  this.update();
}) as EventListener);
```

---

## CSS Conventions

Each widget has a dedicated CSS file imported in the frontend module.

```typescript
// In openmc-studio-frontend-module.ts
import './widgets/my-widget/my-widget.css';
```

Use BEM-like naming scoped to the widget:

```css
.my-widget {
}
.my-widget .widget-header {
}
.my-widget .form-row {
}
.my-widget .form-group {
}
```

Reusable components from `nuke-essentials`:

```typescript
import { Tooltip, ColorPicker } from 'nuke-essentials/lib/theme/browser/components';
```

---

## Widget Reference

| Widget                       | Scope     | State Pattern                             | Backend Calls                                     |
| ---------------------------- | --------- | ----------------------------------------- | ------------------------------------------------- |
| `SimulationDashboardWidget`  | Singleton | Mixed: local UI + `OpenMCStateManager`    | `validateState`, `generateXML`, `startSimulation` |
| `CSGBuilderWidget`           | Singleton | `OpenMCStateManager` (geometry)           | `validateRegion`, `checkOverlaps`                 |
| `DAGMCEditorWidget`          | Singleton | Local + backend file ops                  | `dagmcLoad`, `dagmcAssignMaterial`                |
| `TallyConfiguratorWidget`    | Singleton | `OpenMCStateManager` (tallies/meshes)     | None (pure state edits)                           |
| `OptimizationWidget`         | Transient | Local sweep config + `OpenMCStateManager` | `startOptimization`                               |
| `SimulationComparisonWidget` | Singleton | Local file selections                     | `readStatepoint`, `compareStatepoints`            |
