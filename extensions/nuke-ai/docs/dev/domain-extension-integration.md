# Integrating a New Domain Extension

This guide is for a new solver or domain extension — for example MOOSE/Cardinal, OpenFOAM, or another physics package — that should become available to NukeAI. The domain extension owns its services, files, and processes. NukeAI only orchestrates those actions through the neutral contracts in `nuke-core`.

## Dependency direction

```text
new domain extension
        │ registers capabilities + context
        ▼
   nuke-core registry
        ▲
        │ reads the registry + context
   nuke-ai bridge
        │
        ▼
   Theia AI tools, cards, skills, MCP
```

- The domain extension may depend on `nuke-core` and `nuke-essentials`.
- It must **not** import `nuke-ai`, `@theia/ai-*`, or another domain extension's `src/`.
- `nuke-ai` must **not** import the domain extension.
- The only shared surface is `NukeCapabilityContribution`, `NukeCapabilityContextContribution`, the context-action registry, and the capability catalog.

## 1. Register capabilities through `nuke-core`

Implement `NukeCapabilityContribution` and bind it in the extension's frontend module:

```typescript
import { injectable } from '@theia/core/shared/inversify';
import { NukeCapabilityContribution, NukeCapabilityRegistry } from 'nuke-core/lib/common/nuke-capability-protocol';

@injectable()
export class MyDomainCapabilities implements NukeCapabilityContribution {
  registerCapabilities(registry: NukeCapabilityRegistry): void {
    registry.register({
      id: 'nuke.mydomain.summarizeCase',
      title: 'Summarize case',
      description: 'Return the active case path, input counts, and solver settings.',
      category: ['MyDomain', 'Project'],
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
      when: (context) => context.workspaceRoots.length > 0,
      invoke: async () => ({ ok: true, data: this.summarize() })
    });
  }
}
```

```typescript
bind(MyDomainCapabilities).toSelf().inSingletonScope();
bind(NukeCapabilityContribution).toService(MyDomainCapabilities);
```

Start with read-only capabilities:

- `summarizeCase` — paths, input counts, mesh/solver summary.
- `validateInput` — schema and semantic findings.
- `getRunStatus` — active run, working directory, bounded log tail.
- `diagnoseRun` — read-only log triage with evidence.

Rules:

- Use `when(context)` so a tool disappears when it cannot work. A throwing predicate is treated as false.
- Validate every path against `context.workspaceRoots`.
- Return `ok: false` with a clear message when no case is loaded; do not throw.
- Keep `data` small; strings over 8 KiB and payloads over 32 KiB are bounded by the bridge.
- Follow the registry contract for ids, risk, versions, schemas, and result envelopes. See [Capability Registry](../../../nuke-core/docs/dev/capability-registry.md).

## 2. Publish active context

Use `NukeCapabilityContextContribution` for the active case, project, run, or dataset:

```typescript
@injectable()
export class MyDomainContext implements NukeCapabilityContextContribution {
  getContext(): Partial<NukeCapabilityContext> {
    return { activeMyDomainCase: this.service.activeCasePath };
  }
  onDidChangeContext = this.service.onDidChangeCase;
}
```

Only add a field to `NukeCapabilityContext` when it improves a preflight or the model's awareness. Update `formatNukeContext` and the context docs when you do. Prefer a read capability such as `getRunStatus` for run-only state over a new cached field. See [Context and Resources](context-and-resources.md).

## 3. Add AI exposure through the capability catalog

After the capability exists, add one entry per tool to `extensions/nuke-ai/src/common/nuke-capability-catalog.ts`:

```typescript
{
    id: 'nuke.mydomain.summarizeCase',
    toolName: 'nuke_mydomain_summarizeCase',
    title: 'MyDomain case summary',
    summary: 'Returns the active case path, input counts, and solver settings.',
    domain: 'mydomain',
    risk: 'read',
    chat: true,
    mcpReadOnly: true,
    mcpOrder: 20,
    diagnostics: true
}
```

The catalog is the single source of truth for:

- the generated NukeAI prompt (one line per `chat: true` entry),
- `NUKE_CAPABILITY_TOOL_NAMES` and the agent `functions` list,
- the Nuke Diagnostics tool list,
- the external MCP read-only allowlist,
- the skill allowlist drift test.

Rules:

- `chat: true` — NukeAI may advertise and call it.
- `diagnostics: true` — only for a strictly read-only tool the diagnostics agent may call.
- `mcpReadOnly: true` + `mcpOrder` — only for `risk: 'read'` tools. Never expose writes, executes, or previews through MCP.
- Keep `summary` to one concise line; the prompt has a hard line budget.
- Never add a second hand-written prompt line or a private tool list.

Add a domain skill under `extensions/nuke-ai/skills/<domain>/SKILL.md` when the model needs workflow guidance, id-resolution steps, or domain-specific safety rules. Add a card label in `extensions/nuke-ai/src/browser/capabilities/nuke-tool-call-summary.ts`.

## 4. Add authoring only after the read path works

For a write or execute capability, use the managed flow:

1. **Preview** — read-only, validates the request, compares a before snapshot, and returns a `changeSet` with an `applyCapability`.
2. **Apply** — `write`, `requiresConfirmation: true`, rejects a stale snapshot, performs one commit, and returns an `undoToken`.
3. **Undo** — restores only what the proposal changed and fails if the state changed again.

Execute capabilities need explicit confirmation and a cancellation path. Keep solver input parsing, process control, and file writes in the domain extension; never let the model author arbitrary shell commands or raw solver files.

## 5. Add domain UI entry points

If the extension owns a dashboard or toolbar:

1. Add a context-action scope in `nuke-core` only if no existing scope fits.
2. Publish command-backed descriptors from `nuke-ai` with the existing command ids.
3. Render them in the domain widget through `NukeContextActionRegistry`.
4. Use the shared `nuke-essentials` action menu and `Tooltip`.
5. Add a `NukeAiActionPrecondition` when the action needs an active case or run, so a missing prerequisite warns without opening a chat.

The domain widget must not import `nuke-ai`; it only reads the neutral registry.

## 6. Verification checklist

- Unit-test capability handlers with a fake registry; no Theia boot and no model calls.
- Test invalid paths, missing context, stale previews, apply/undo, and rejection paths.
- Run the catalog drift test; a missing prompt, tool, diagnostics, or MCP entry must fail.
- Verify that no write/execute capability is MCP-allowlisted.
- Add Playwright coverage when the extension owns a visible widget or menu.
- Update user docs, developer docs, the owning `AGENTS.md`, and `CHANGELOG.md`.
- Keep an AI-free build green: `NUKE_EXCLUDE_EXTENSIONS=nuke-ai yarn build:browser` must render no NukeAI controls.

## Anti-patterns

- Importing `nuke-ai` from the domain extension.
- Adding a tool name to a private array instead of the catalog.
- Exposing writes or executes over MCP.
- Passing around raw shell commands, unbounded solver files, or unvalidated workspace paths.
- Hiding an action that could work after the user loads a case; preflight and explain instead.
- Calling a model from a preflight, widget render, or capability predicate.

## Related

- [Capability Registry](../../../nuke-core/docs/dev/capability-registry.md)
- [Adding a Capability](adding-a-capability.md)
- [Context and Resources](context-and-resources.md)
- [Agent and Tool Result Cards](agent-and-cards.md)
- [External MCP](mcp.md)
