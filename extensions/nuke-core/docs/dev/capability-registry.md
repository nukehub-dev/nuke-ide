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

Every invocation returns a `NukeCapabilityResult` with `ok` plus optional `data`, `message`, `warnings`, `artifacts`, `preview`, `undoToken`, `nextActions`, and `handle`. Use `artifacts` and `preview` for verifiable output, and mark previews that cannot fully represent the result with `truthful: false` and `limitations`.

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
