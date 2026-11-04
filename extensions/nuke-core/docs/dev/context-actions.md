# Context Actions

`nuke-core` owns the neutral cross-extension contract for contextual menu actions. A contributor registers command-backed descriptors for a known domain scope; the domain widget renders them next to its own menu rows. The domain never imports the contributing extension, and the contract has no AI, CAD, or OpenMC dependency.

The public types and DI tokens live in [`src/common/nuke-context-action-protocol.ts`](https://github.com/nukehub-dev/nuke-ide/blob/main/extensions/nuke-core/src/common/nuke-context-action-protocol.ts). The registry lives in `src/browser/context-actions/`.

## Scopes

| Scope               | Rendered by                                    | Example surface                              |
| ------------------- | ---------------------------------------------- | -------------------------------------------- |
| `cad.viewport`      | CAD viewport right-click menu and toolbar      | Solid/empty-space menus, NukeAI actions menu |
| `openmc.validation` | OpenMC Studio Simulation dashboard             | Validation toolbar group                     |
| `openmc.run`        | OpenMC Studio Simulation dashboard             | Run toolbar group                            |
| `visualizer.dagmc`  | DAGMC viewer menu and DAGMC Editor header      | Canvas context menu, header actions menu     |
| `visualizer.tally`  | Tally viewer menu and statepoint viewer header | Only with a loaded tally/statepoint          |

## Registering an action

Implement `NukeContextActionContribution` and bind it to the contribution provider in your frontend module. `nuke-core` already binds the provider and registry, so contributors bind only their implementation.

```typescript
import { injectable } from '@theia/core/shared/inversify';
import { NukeContextActionContribution, NukeContextActionRegistry } from 'nuke-core/lib/common/nuke-context-action-protocol';

@injectable()
export class MyContextActionContribution implements NukeContextActionContribution {
  registerContextActions(registry: NukeContextActionRegistry): void {
    registry.register({
      id: 'my-extension.cad.viewport.summarize',
      scope: 'cad.viewport',
      label: 'Summarize Model',
      description: 'Summarize the active model without changing it.',
      commandId: 'my.extension.summarize',
      group: 'my-extension',
      order: 'a',
      when: () => true
    });
  }
}
```

```typescript
bind(MyContextActionContribution).toSelf().inSingletonScope();
bind(NukeContextActionContribution).toService(MyContextActionContribution);
```

The `commandId` must be a command registered in the Theia `CommandRegistry`. The action descriptor carries presentation and ordering only; the command handler owns the behavior.

## Registry behavior

- `register` validates the id, scope, label, and command id. Invalid actions are logged and skipped.
- Duplicate ids keep the first registration and log both contributing sources.
- `getActions(scope)` returns that scope's enabled actions in stable order: `group`, then `order`, then `label`, then id. Missing `group`/`order` values sort first.
- `when` is synchronous and evaluated on every `getActions` call. A `false` result hides the action; a throwing predicate is logged and treated as disabled.
- `onDidChange` fires once after the initial contribution pass and after every later accepted registration. Consumers that keep a persistent toolbar should subscribe and re-render; menus that are rebuilt on open can call `getActions` directly.
- The initial pass is synchronous and starts on first use, so DI resolution never becomes async. A throwing contribution is logged and does not prevent later contributions from registering.

## Rendering contract

Domain widgets own their menu and toolbar layout. They must:

1. Call `getActions(scope)` for their scope.
2. Drop actions whose `commandId` is missing from the `CommandRegistry` (for example a build that excludes the contributing extension) instead of rendering dead rows.
3. Render the group only when at least one action remains.
4. Execute the chosen action through the command registry.

The widget may import the protocol types and registry token from `nuke-core`, but never the contributor. Domain extensions stay free of the contributor's dependencies. Toolbar/header surfaces can map the same descriptors through `NukeActionMenu` from `nuke-essentials` (with `availableNukeActionDescriptors` for the missing-command filter); the menu is presentation-only and its execute callback routes back to the host command registry.

## Consumers

| Domain            | Integration                                                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nuke-cad`        | `viewport-context-menu.ts` appends a NukeAI group to solid and empty-space menus; the document toolbar adds the shared menu.                              |
| `openmc-studio`   | `nuke-ai-actions.ts` builds validation/run groups for the Simulation dashboard toolbar; the DAGMC Editor header adds the shared menu.                     |
| `nuke-visualizer` | DAGMC and tally context menu builders append their scope's actions after the domain-owned rows; the statepoint viewer header/loader adds the shared menu. |

`nuke-ai` registers the current read-only actions in `src/browser/actions/nuke-ai-context-actions.ts`. When NukeAI is excluded from the build, no commands exist, so every domain omits the group.
