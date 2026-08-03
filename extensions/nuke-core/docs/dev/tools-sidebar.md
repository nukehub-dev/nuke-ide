# Nuke Tools Sidebar

The **Nuke Tools** sidebar is a left-panel view that aggregates every Nuke command into a single, searchable, categorized list. It complements the existing `Tools` menu in the menubar rather than replacing it.

## Registering tools

Extensions contribute items to the sidebar through the `NukeToolsContribution` provider. Each item declares a label, Theia command id, category path, optional ordering hints, icon, description, search keywords, and optional state-aware enablement.

### Example

```typescript
import { injectable } from '@theia/core/shared/inversify';
import { NukeToolsContribution, NukeToolsRegistry } from 'nuke-core/lib/common/nuke-tools-protocol';
import { MyCommands } from '../commands';

@injectable()
export class MyToolsContribution implements NukeToolsContribution {
  registerTools(registry: NukeToolsRegistry): void {
    registry.registerItem({
      id: 'my-extension.openWidget',
      label: 'Open My Widget',
      commandId: MyCommands.OPEN_WIDGET.id,
      category: ['My Extension', 'Widgets'],
      sectionOrder: 'm',
      categoryOrder: 'a',
      order: 'a',
      icon: 'symbol-event',
      description: 'Open the main widget for my extension.',
      keywords: ['widget', 'panel']
    });
  }
}
```

### Wiring the contribution

Bind your contribution to the `NukeToolsContribution` provider in your frontend module:

```typescript
import { bindContributionProvider } from '@theia/core/lib/common/contribution-provider';
import { NukeToolsContribution } from 'nuke-core/lib/common/nuke-tools-protocol';
import { MyToolsContribution } from './contributions/my-tools-contribution';

export default new ContainerModule((bind) => {
  bind(MyToolsContribution).toSelf().inSingletonScope();
  bind(NukeToolsContribution).toService(MyToolsContribution);
});
```

> Note: `nuke-core` already calls `bindContributionProvider(bind, NukeToolsContribution)` in its frontend module, so dependent extensions only need to bind their own contribution class.

## State-aware enablement

Items can be disabled when their command is not currently applicable. The sidebar dims disabled rows and ignores clicks.

```typescript
import { inject } from '@theia/core/shared/inversify';
import { Event, Emitter } from '@theia/core/lib/common/event';
import { OpenMCStateManager } from 'openmc-studio/lib/browser/openmc-state-manager';

@injectable()
export class MyToolsContribution implements NukeToolsContribution {
  @inject(OpenMCStateManager)
  protected readonly stateManager: OpenMCStateManager;

  protected readonly onDidChangeEnabledEmitter = new Emitter<unknown>();

  registerTools(registry: NukeToolsRegistry): void {
    registry.registerItem({
      id: 'openmc-studio.runSimulation',
      label: 'Run Simulation',
      commandId: OpenMCCommands.RUN_SIMULATION.id,
      category: ['OpenMC Studio', 'Simulation'],
      icon: 'play-circle',
      enabled: () => this.stateManager.projectPath !== undefined,
      onDidChangeEnabled: this.onDidChangeEnabledEmitter.event
    });

    this.stateManager.onDidChangeProject(() => this.onDidChangeEnabledEmitter.fire(undefined));
  }
}
```

- `enabled` — optional predicate returning `boolean`. Missing means always enabled.
- `onDidChangeEnabled` — optional `Event<unknown>` that tells the sidebar to re-evaluate `enabled`. Fire it whenever the predicate's result may have changed.

## Categories and ordering

- The `category` array is a path. The first element becomes the top-level section; deeper elements become nested subcategories.
  - `['OpenMC Studio']` — one flat section.
  - `['OpenMC Studio', 'Simulation']` — a "Simulation" subcategory under "OpenMC Studio".
  - `['OpenMC Studio', 'Simulation', 'Run']` — a nested group under "Simulation".
- Use the extension display name as the top-level category (e.g. `OpenMC Studio`, `Visualizer`).
- Use subcategories when an extension has many commands; keep the tree shallow (two levels is usually enough).
- Keep labels concise; use the `description` field for longer explanations.

### Ordering

Ordering hints are lexicographic strings. Omitting them falls back to alphabetical sorting.

| Field           | Scope                                              | Example use                                                                                              |
| --------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `sectionOrder`  | Top-level section relative to other sections       | Put core/global sections first (`'a'`) and extension sections after (`'m'`).                             |
| `categoryOrder` | Containing (deepest) category relative to siblings | Keep a stable category order inside an extension (e.g. `Project` before `Geometry` before `Simulation`). |
| `order`         | Item within the deepest category                   | Order individual commands logically inside a category.                                                   |

Use distinct prefixes for sections so extension authors do not collide: nuke-core uses `'a'`–`'c'`, visualizer uses `'m'`, openmc-studio uses `'o'`. These are conventions, not enforced by the model.

## Icons

Use Theia `codicon` names without the `codicon-` prefix. The sidebar widget expands them with the `codicon()` helper. Examples: `tools`, `play-circle`, `package`, `server-environment`, `graph`, `dashboard`.

## Searching

The sidebar searches item labels, descriptions, keywords, and category paths. Queries are case-insensitive. Good keywords help users discover commands by related terms (e.g. `conda`, `pip`, `venv` for environment commands).

## Source files

| File                                                                                                                           | Purpose                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| [`src/common/nuke-tools-protocol.ts`](../../src/common/nuke-tools-protocol.ts)                                                 | `NukeToolsItem`, `NukeToolsContribution`, and `NukeToolsRegistry` contracts. |
| [`src/browser/tools-sidebar/nuke-tools-sidebar-widget.tsx`](../../src/browser/tools-sidebar/nuke-tools-sidebar-widget.tsx)     | React widget that renders the sidebar.                                       |
| [`src/browser/tools-sidebar/nuke-tools-sidebar-model.ts`](../../src/browser/tools-sidebar/nuke-tools-sidebar-model.ts)         | Pure grouping/filtering/sorting helpers.                                     |
| [`src/browser/tools-sidebar/nuke-core-tools-contribution.ts`](../../src/browser/tools-sidebar/nuke-core-tools-contribution.ts) | Nuke Core's own tool registrations.                                          |
