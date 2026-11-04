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

- **Id** — `nuke.<domain>.<verbNoun>`, lowercase domain and camel-case verb noun, for example `nuke.openmc.run`. The id stays the stable registry, MCP, resource, preview, and log identifier.
- **Tool name** — the chat exposes the sanitized id: non-alphanumeric characters become `_`, repeated underscores collapse, and the result is capped at 128 characters. For example, `nuke.example.describeProject` becomes `nuke_example_describeProject`, and both `ToolRequest.id` and `ToolRequest.name` use that value.
- **Version** — omit `version` for the initial contract (`1`), or set a positive integer. Additive input/result fields keep the version; a breaking schema or meaning change increments it. The registry rejects invalid versions, and the catalog, MCP descriptor, and metrics journal report the effective value. There is no negotiation.
- **Description** — explain when to use the action. The bridge appends up to three example descriptions as `Example: ...` lines.
- **Input schema** — must be a top-level object schema with a `properties` map. Nested schemas, arrays, enums, defaults, and numeric or pattern constraints are preserved.
- **Risk** — choose the weakest accurate level:
  - `read` follows the IDE confirmation preference and may inherit a global always-allow;
  - `write` and `execute` never inherit a global always-allow and need an explicit per-tool allow;
  - `destructive` also adds a warning that data can be overwritten or deleted.
- **Annotations** — omit them to derive MCP-style hints from `risk`. Explicit annotations win, but a contradiction with the risk is logged and the derived hints are not silently replaced.
- **`when`** — return false when the action does not apply, for example when no CAD document or OpenMC project is active. A throwing predicate is treated as false.
- **Context** — use `workspaceRoots`, `activeCadDocument`, `activeOpenmcProject`, `activeDataset`, `hasDagmcViewer`, and `signal`. Check `signal.aborted` or listen for its abort event when the work is long-running.
- **Results** — return the structured envelope. Use `message` for the human-readable summary, `data` for compact structured output, `artifacts` for files or URIs, `warnings` for caveats, `nextActions` for suggested follow-ups, and `handle` or `undoToken` when the caller needs to continue or reverse the action. Add `preview` to render truthful output in the chat; see [Previews and Trajectory](preview.md).
- **Bounds** — keep `data` small. Strings over 8 KiB are truncated and payloads over 32 KiB are replaced with a marked summary before they reach the model.

Every invocation is recorded automatically in the local tool metrics, and a result with `changeSet` or `undoToken` is
recorded in the applied-edit journal. Do not add logging of inputs, file contents, paths, or tokens for your capability;
see [Local Metrics and the Edit Journal](metrics.md).

## Chat exposure checklist

Registering a capability makes it available to the bridge, but NukeAI only calls tools named in its prompt. The
catalog at `extensions/nuke-ai/src/common/nuke-capability-catalog.ts` is the single source of truth for the NukeAI
tool list and prompt lines, the Nuke Diagnostics tool list, and the external MCP allowlist.

1. Add one catalog entry with:
   - `id` and `toolName` — the dotted registry id and its sanitized `nuke_*` name; `toToolName(id)` must equal `toolName`.
   - `title` and `summary` — the short label and one-line description rendered in the NukeAI prompt.
   - `domain` — `cad`, `openmc`, or `visualizer`; `risk` — the capability's weakest accurate risk.
   - `chat: true` when NukeAI may advertise and call it, `false` for a diagnostics-only tool.
   - `diagnostics: true` only when the read-only Diagnostics agent may call it.
   - `mcpReadOnly: true` plus `mcpOrder` only when the entry is `risk: 'read'` and safe for external clients.
2. Keep `summary` concise. The prompt renders one generated line per chat entry and must stay within its 240-line
   budget; never add a second hand-written tool line.
3. A diagnostics-only tool also needs its triage line in `nuke-diagnostics-system-prompt.ts`. The catalog test
   checks that every `diagnostics: true` entry appears there by name, `~{toolName}`, and dotted id.
4. The owning domain skill under `extensions/nuke-ai/skills/` when the workflow needs guidance, and the dev/user docs
   plus `CHANGELOG.md`.
5. If the capability backs a contextual action, add a `NukeAiActionPrecondition` in `nuke-ai-commands.ts` so the action
   warns without opening a chat when its CAD document, OpenMC project, active run, or statepoint is missing.

`nuke-capability-catalog.test.ts` fails on duplicate ids or tool names, a non-sanitized name, a chat or diagnostics
entry missing from its prompt or list, a non-read MCP or diagnostics entry, and a prompt over budget. Removing one
catalog entry breaks the same consistency check.

See [Capability Registry](../../../nuke-core/docs/dev/capability-registry.md) for validation details, context contributions, workspace path checks, and the version contract.
