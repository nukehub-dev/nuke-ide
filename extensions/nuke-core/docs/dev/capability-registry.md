# Capability Registry

`nuke-core` owns the neutral cross-extension capability contract. Domain extensions expose actions by registering a `NukeCapability`; consumers read the same registry without importing the contributing extension. The contract has no AI, CAD, or OpenMC dependency, so an extension can be AI-drivable without depending on an AI package.

The public types and DI tokens live in [`src/common/nuke-capability-protocol.ts`](https://github.com/nukehub-dev/nuke-ide/blob/main/extensions/nuke-core/src/common/nuke-capability-protocol.ts). The registry, validation helpers, and context service live in `src/browser/capabilities/`.

## Registering a capability

Implement `NukeCapabilityContribution` and bind it to the contribution provider in your frontend module. `nuke-core` already binds the provider, registry, and context service, so contributors only bind their own implementation.

```typescript
import { injectable } from '@theia/core/shared/inversify';
import { NukeCapabilityContribution, NukeCapabilityRegistry } from 'nuke-core/lib/common/nuke-capability-protocol';

@injectable()
export class MyCapabilityContribution implements NukeCapabilityContribution {
  registerCapabilities(registry: NukeCapabilityRegistry): void {
    registry.register({
      id: 'nuke.example.describeProject',
      title: 'Describe project',
      description: 'Return a summary of the active project.',
      category: ['Example', 'Project'],
      inputSchema: {
        type: 'object',
        properties: {
          includeFiles: { type: 'boolean', description: 'Include file names in the summary.' }
        }
      },
      risk: 'read',
      invoke: async (input, context) => ({
        ok: true,
        data: { workspaceRoots: context.workspaceRoots, input }
      })
    });
  }
}
```

```typescript
import { NukeCapabilityContribution } from 'nuke-core/lib/common/nuke-capability-protocol';

bind(MyCapabilityContribution).toSelf().inSingletonScope();
bind(NukeCapabilityContribution).toService(MyCapabilityContribution);
```

Every invocation returns a `NukeCapabilityResult` with `ok` plus optional `data`, `message`, `warnings`, `artifacts`, `preview`, `changeSet`, `undoToken`, `nextActions`, and `handle`. Use `artifacts` and `preview` for verifiable output, and mark previews that cannot fully represent the result with `truthful: false` and `limitations`.

## Validation

`register` validates the static contract and logs and skips invalid capabilities; one broken extension never breaks the registry.

- `id` must match `nuke.<domain>.<verbNoun>`, for example `nuke.cad.exportDagmc`.
- `title` and `description` must be non-empty strings.
- `inputSchema.type` must be `object` and `inputSchema.properties` must be present.
- `risk` must be `read`, `write`, `execute`, or `destructive`.
- `invoke` must be a function; `when`, when present, must be a function.
- Duplicate ids keep the first registration and log both contributing sources.

The exported `validateCapability(capability)` and `validateCapabilityInput(capability, input)` helpers return human-readable problem strings. Input validation checks required keys and top-level primitive types only; nested schemas, enums, and additional properties are the capability's responsibility.

Use `isWithinWorkspace(candidate, roots)` before touching files. It accepts only absolute candidates inside an absolute workspace root and rejects sibling folders with a shared prefix, `..` traversal, relative roots, and an empty root list.

## Risk and annotations

When `annotations` is omitted, the registry derives MCP-style hints from `risk`:

| Risk          | readOnlyHint | destructiveHint | idempotentHint | openWorldHint |
| ------------- | ------------ | --------------- | -------------- | ------------- |
| `read`        | `true`       | `false`         | `true`         | `false`       |
| `write`       | `false`      | `false`         | `false`        | `false`       |
| `execute`     | `false`      | `false`         | `false`        | `false`       |
| `destructive` | `false`      | `true`          | `false`        | `false`       |

Explicit annotations win, but a value that contradicts the risk is logged as a warning. Set `requiresConfirmation` for actions that must be confirmed independently of the risk level, and `undoable` when the handler can issue an `undoToken`.

## Change sets and undo

A write capability that changes structured state previews and applies in two steps. The preview (read risk) validates the proposed edits, builds the diff, and returns a `changeSet` whose `applyCapability` names the write capability to apply it. The apply capability (write risk, `requiresConfirmation: true`) applies the same edits, returns the `changeSet` without `applyCapability`, and adds an `undoToken`.

```typescript
const changeSet: NukeChangeSet = {
  id: 'proposal-1',
  title: 'Run settings',
  summary: 'Increase batches and particles per batch.',
  changes: [
    { path: 'run.batches', label: 'Batches', kind: 'update', before: 100, after: 200 },
    { path: 'run.particles', label: 'Particles per batch', kind: 'update', before: 1000, after: 5000 }
  ],
  applyCapability: 'nuke.example.applySettings'
};
```

`NukeChange.kind` is `add`, `update`, or `remove`; `before` is omitted for adds and `after` for removes. `NukeChangeSet.id` is the proposal identity the write capability expects in its input.

The apply capability registers the reverse handler and returns the token:

```typescript
import { inject } from '@theia/core/shared/inversify';
import { NukeUndoService } from 'nuke-core/lib/browser/capabilities/nuke-undo-service';

@inject(NukeUndoService) protected readonly undoService: NukeUndoService;

const { applyCapability: _appliedBy, ...appliedChangeSet } = changeSet;
const undoToken = this.undoService.register({
  title: 'Settings change',
  undo: async () => {
    // Verify the current state still matches what was applied, then restore
    // only the changed paths.
    return { ok: true, message: 'Settings change undone.' };
  }
});
return { ok: true, changeSet: appliedChangeSet, undoToken, message: 'Settings applied.' };
```

- `register` returns an opaque UUID token and fires `onDidChange`.
- `undo` runs the handler, removes the token only when the result is `ok: true`, and fires `onDidChange` on removal.
- A failing or throwing handler keeps the token so the caller can retry; thrown errors become `{ ok: false, message }` and `undo` never rejects.
- Concurrent calls for the same token run the handler once; later callers are rejected while the first call is in flight.
- An unknown, already-redeemed, or expired token returns `{ ok: false, message: 'This change can no longer be undone.' }`.
- The service is a frontend singleton backed by memory only. Tokens are never persisted, so undo does not survive a reload or IDE restart.
- Undo handlers must verify the state they are restoring and touch only the paths they changed; never replace the whole settings object.

`undoable: true` on the capability marks that it can issue an `undoToken`; it does not create the handler. Consumers display the diff from `changeSet` and call `NukeUndoService.undo(token)` after explicit confirmation.

## Registry behavior

- `get(id)` returns one capability or `undefined`.
- `getAll()` returns a stable order: category path, then title, then id.
- `getEnabled(context)` filters on each capability's optional `when(context)` predicate. A throwing predicate is logged and treated as disabled.
- `ready` resolves after the initial contribution pass and never rejects.
- DI resolution stays synchronous: the eager pass starts from a synchronous `@postConstruct` wrapper, while `initialize()` returns the async pass and `ready` awaits it.
- `onDidChange` fires once after the initial pass and once per later registration batch. Consumers must debounce.

## Context contributions

Extensions publish ambient state with `NukeCapabilityContextContribution`. Each contribution returns a partial context and may expose an `onDidChangeContext` event.

```typescript
import { injectable } from '@theia/core/shared/inversify';
import { Emitter } from '@theia/core/lib/common/event';
import { NukeCapabilityContext, NukeCapabilityContextContribution } from 'nuke-core/lib/common/nuke-capability-protocol';

@injectable()
export class MyContextContribution implements NukeCapabilityContextContribution {
  protected readonly onDidChangeContextEmitter = new Emitter<void>();
  protected currentDocument: { uri: { toString(): string } } | undefined;
  readonly onDidChangeContext = this.onDidChangeContextEmitter.event;

  getContext(): Partial<NukeCapabilityContext> {
    return { activeCadDocument: this.currentDocument?.uri.toString() };
  }
}
```

```typescript
import { NukeCapabilityContextContribution } from 'nuke-core/lib/common/nuke-capability-protocol';

bind(MyContextContribution).toSelf().inSingletonScope();
bind(NukeCapabilityContextContribution).toService(MyContextContribution);
```

`NukeCapabilityContextService.getContext()` awaits async contributions, merges their partials in contribution order, always adds the absolute workspace roots from `WorkspaceService`, and returns a frozen snapshot. A failing contribution is logged and skipped. `onDidChangeContext` fires when any contribution event or the workspace roots change, debounced by one microtask.
