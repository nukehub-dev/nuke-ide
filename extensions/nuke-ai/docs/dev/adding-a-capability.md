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
- **Context** — use `workspaceRoots`, `activeCadDocument`, `activeOpenmcProject`, `activeDataset`, and `signal`. Check `signal.aborted` or listen for its abort event when the work is long-running.
- **Results** — return the structured envelope. Use `message` for the human-readable summary, `data` for compact structured output, `artifacts` for files or URIs, `warnings` for caveats, `nextActions` for suggested follow-ups, and `handle` or `undoToken` when the caller needs to continue or reverse the action. Add `preview` to render truthful output in the chat; see [Previews and Trajectory](preview.md).
- **Bounds** — keep `data` small. Strings over 8 KiB are truncated and payloads over 32 KiB are replaced with a marked summary before they reach the model.

Every invocation is recorded automatically in the local tool metrics, and a result with `changeSet` or `undoToken` is
recorded in the applied-edit journal. Do not add logging of inputs, file contents, paths, or tokens for your capability;
see [Local Metrics and the Edit Journal](metrics.md).

## Chat exposure checklist

Registering a capability makes it available to the bridge, but the NukeAI agent only calls tools named in its prompt.
When the capability should be callable from chat, update all of these together:

1. `extensions/nuke-ai/src/browser/agent/nuke-system-prompt.ts` — one title line with the tool name and one description
   line with the dotted capability id and `~{<tool_name>}`. Keep the prompt within its 240-line budget.
2. `NUKE_CAPABILITY_TOOL_NAMES` in `extensions/nuke-ai/src/browser/agent/nuke-chat-agent.ts` — the sanitized tool name,
   in workflow order.
3. `CAPABILITY_IDS` in `nuke-chat-agent.test.ts` — the dotted id at the same index.
4. For a Diagnostics-only tool, `NUKE_DIAGNOSTICS_TOOL_NAMES` in `nuke-diagnostics-agent.ts` and the matching
   `CAPABILITY_IDS` in `nuke-diagnostics-agent.test.ts` plus its prompt line.
5. For an externally exposed read-only tool, `MCP_READ_ONLY_CAPABILITY_IDS` in `src/common/nuke-mcp-protocol.ts` and the
   MCP protocol, catalog, and contribution tests.
6. The owning domain skill under `extensions/nuke-ai/skills/` when the workflow needs guidance, and the dev/user docs plus
   `CHANGELOG.md`.

The `references every capability tool by its sanitized name` test fails when the chat prompt and its two lists drift
apart. The diagnostics test covers its own list, and the MCP catalog tests cover the external boundary.

See [Capability Registry](../../../nuke-core/docs/dev/capability-registry.md) for validation details, context contributions, workspace path checks, and the version contract.
