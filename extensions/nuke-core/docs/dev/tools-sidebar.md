# Nuke Tools Sidebar

The **Nuke Tools** sidebar is a left-panel view that aggregates every Nuke command into a single, searchable, categorized list. It complements the existing `Tools` menu in the menubar rather than replacing it.

## Registering tools

Extensions contribute items to the sidebar through the `NukeToolsContribution` provider. Each item declares a label, Theia command id, category path, optional order, icon, description, and search keywords.

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
      category: ['My Extension'],
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

## Category guidelines

- Use the extension display name as the top-level category (e.g. `OpenMC Studio`, `Visualizer`).
- Use second-level categories only when an extension has many commands (e.g. `OpenMC Studio > Simulation`).
- Keep labels concise; use the `description` field for longer explanations.

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
