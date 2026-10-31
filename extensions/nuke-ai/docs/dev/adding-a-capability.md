# Adding a Capability

Any extension can make an action available to the AI chat by registering a `NukeCapability` with the registry owned by `nuke-core`. No dependency on `nuke-ai` and no tool-specific registration are required.

## Minimal contribution

```typescript
import { injectable } from '@theia/core/shared/inversify';
import { NukeCapabilityContribution, NukeCapabilityRegistry } from 'nuke-core/lib/common/nuke-capability-protocol';

@injectable()
export class ExampleCapabilityContribution implements NukeCapabilityContribution {
  registerCapabilities(registry: NukeCapabilityRegistry): void {
    registry.register({
      id: 'nuke.example.describeProject',
      title: 'Describe project',
      description: 'Summarize the active project and return its workspace roots.',
      category: ['Example', 'Project'],
      inputSchema: {
        type: 'object',
        properties: {
          includeFiles: {
            type: 'boolean',
            description: 'Include file names in the summary.'
          }
        }
      },
      risk: 'read',
      examples: [{ description: 'Summarize the current project', input: {} }],
      when: (context) => context.workspaceRoots.length > 0,
      invoke: async (input, context) => ({
        ok: true,
        message: 'Project summarized.',
        data: { workspaceRoots: context.workspaceRoots, input }
      })
    });
  }
}
```

Bind the contribution in the owning extension's frontend module:

```typescript
import { NukeCapabilityContribution } from 'nuke-core/lib/common/nuke-capability-protocol';

bind(ExampleCapabilityContribution).toSelf().inSingletonScope();
bind(NukeCapabilityContribution).toService(ExampleCapabilityContribution);
```

`nuke-ai` re-reads the registry whenever it changes, so a newly registered capability becomes a tool without a reload.

## Contract rules

- **Id** — `nuke.<domain>.<verbNoun>`, lowercase domain and camel-case verb noun, for example `nuke.openmc.run`.
- **Description** — explain when to use the action. The bridge appends up to three example descriptions as `Example: ...` lines.
- **Input schema** — must be a top-level object schema with a `properties` map. Nested schemas, arrays, enums, defaults, and numeric or pattern constraints are preserved.
- **Risk** — choose the weakest accurate level:
  - `read` needs no always-allow confirmation;
  - `write` and `execute` require confirmation before auto-approval;
  - `destructive` adds a warning that data can be overwritten or deleted.
- **Annotations** — omit them to derive MCP-style hints from `risk`. Explicit annotations win, but a contradiction with the risk is logged and the derived hints are not silently replaced.
- **`when`** — return false when the action does not apply, for example when no CAD document or OpenMC project is active. A throwing predicate is treated as false.
- **Context** — use `workspaceRoots`, `activeCadDocument`, `activeOpenmcProject`, `activeDataset`, and `signal`. Check `signal.aborted` or listen for its abort event when the work is long-running.
- **Results** — return the structured envelope. Use `message` for the human-readable summary, `data` for compact structured output, `artifacts` for files or URIs, `warnings` for caveats, `nextActions` for suggested follow-ups, and `handle` or `undoToken` when the caller needs to continue or reverse the action. Add `preview` to render truthful output in the chat; see [Previews and Trajectory](preview.md).
- **Bounds** — keep `data` small. Strings over 8 KiB are truncated and payloads over 32 KiB are replaced with a marked summary before they reach the model.

See [Capability Registry](../../../nuke-core/docs/dev/capability-registry.md) for validation details, context contributions, and workspace path checks.
