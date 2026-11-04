# Architecture

`nuke-ai` bridges the neutral capability contract in `nuke-core` to Theia's AI tool registry. The bridge runs entirely in the frontend process.

## In-process flow

```text
Domain extension frontend module
        │ registerCapabilities(registry)
        ▼
NukeCapabilityRegistry (nuke-core)
        │ getEnabled(context)
        ▼
NukeCapabilityToolBridge (nuke-ai)
        │ registerTool(ToolRequest)
        ▼
ToolInvocationRegistry (Theia AI)
        │ handler(arguments, invocationContext)
        ▼
capability.invoke(input, context)
        │ result (best effort)
        ▼
NukeAiMetricsService / NukeEditJournal
```

A domain extension never imports `nuke-ai`. It contributes a `NukeCapability` through `nuke-core`, and `nuke-ai` discovers it from the registry. This keeps the dependency direction one-way: domain extensions depend on the contract, and only the AI extension depends on the AI runtime.

## Why there is no HTTP

The AI chat and the capability handlers both live in the frontend. Registering a `ToolRequest` gives Theia a direct function reference to the bridge handler, which then calls the capability's `invoke` method in the same process. There is no backend route, MCP server, or external client in this path, so:

- no serialization or authentication boundary is added between the model and the handler;
- an invocation sees the live frontend services and ambient context;
- nothing new listens on the network for this internal path.

External MCP exposure is a separate, opt-in surface; see [External MCP](mcp.md). It does not change this in-process path.

## Registration and refresh

On application start the bridge subscribes to `NukeCapabilityRegistry.onDidChange` and `NukeCapabilityContextService.onDidChangeContext` **before** awaiting `NukeCapabilityRegistry.ready` and performing the first refresh. A document can open while startup is still settling, and that context change must not fall between the first context read and the subscription.

A refresh:

1. Reads a context snapshot. If context collection fails, it falls back to an empty workspace-root list.
2. Unregisters every tool owned by provider `nuke-ai`, so stale tools never survive a change.
3. Registers one `ToolRequest` per capability returned by `getEnabled(context)`.
4. Logs how many tools were registered and which capability ids were skipped by a `when` predicate.

Change events are debounced with `setTimeout(0)`. Concurrent refreshes share one running pass, and a change that arrives during a pass requests one follow-up pass. A capability that fails schema conversion or registration is logged and skipped; other capabilities still register. Disposing or stopping the bridge removes the subscriptions and every tool it owns.

## Tool shape

- **id** — the sanitized tool name, for example `nuke_cad_exportDagmc`. Theia's `ToolInvocationRegistry` keys tools by this id.
- **name** — the same sanitized tool name, for example `nuke_cad_exportDagmc`. Model tool calls and confirmation UI use this name.
- **description** — the capability description plus up to three `Example: ...` lines.
- **parameters** — the capability input schema converted to `ToolRequestParameters`.
- **providerName** — `nuke-ai`.
- **confirmAlwaysAllow** — `undefined` for a plain `read`, `true` for `write`/`execute` and for any capability with `requiresConfirmation: true`, and a warning string for `destructive`.
- **getArgumentsShortLabel** — uses the first present key from `path`, `documentPath`, `projectPath`, `statepointPath`, `workingDirectory`, or `query`.
- **handler** — parses the argument JSON, validates required keys and top-level types, merges the ambient context, bridges cancellation to an `AbortSignal`, captures a preview bundle when the result has a preview or artifacts, and converts the result.

The capability id, for example `nuke.cad.exportDagmc`, remains the stable registry identifier used by `NukeCapabilityRegistry`, external MCP, resources, preview records, and logs. The bridge derives both tool fields from it with `toToolName`, so tool lookup, confirmation, model calls, and `~{...}` prompt references all resolve against the same sanitized name.

Schema conversion preserves JSON Schema keywords recursively, including nested `properties`, `required`, `items`, `anyOf`, `enum`, `default`, `minimum`, `maximum`, and `pattern`. The top-level `additionalProperties` keyword is dropped because Theia's `ToolRequestParameters` does not declare it; nested occurrences are preserved.

The registry normalizes every capability to an explicit version, defaulting to `1`. The version appears in catalog rows and MCP descriptors; it is not part of the model-facing tool name. A capability with the same id and a higher version replaces the old contract only through a normal registration change.

## Capability catalog

`src/common/nuke-capability-catalog.ts` is the static source of truth for what the AI surfaces advertise. The live registry still decides which capabilities are enabled; the catalog describes each AI-facing capability once and records which consumer may expose it:

- `chat: true` entries drive `NUKE_CAPABILITY_TOOL_NAMES`, the NukeAI `functions` list, and the generated prompt lines.
- `diagnostics: true` entries drive `NUKE_DIAGNOSTICS_TOOL_NAMES` and are checked against the Diagnostics prompt. Diagnostics-only entries use `chat: false`.
- `mcpReadOnly: true` entries with `risk: 'read'` drive `MCP_READ_ONLY_CAPABILITY_IDS`; `mcpOrder` keeps the external order stable.
- Each entry carries `id`, `toolName`, `title`, one-line `summary`, `domain`, and `risk`.

`buildNukeSystemPrompt` renders one compact line per chat entry, grouped by risk (read first, then write and execute), and `NUKE_SYSTEM_PROMPT` is computed once from it. The chat agent, Diagnostics agent, and MCP protocol re-export the derived lists so existing imports stay stable. `src/browser/agent/nuke-capability-catalog.test.ts` fails when an id or tool name is duplicated, a tool name is not the sanitized id, a consumer list or prompt misses an entry, a diagnostics-only entry leaks into chat, or an MCP or diagnostics entry is not `read`.

## Local journals

Every `invokeCapability` call records one metric line in a `finally` block, including failed, cancelled, and
validation-rejected calls. A result that carries a `changeSet` or `undoToken` also appends one edit-journal line. Both
journals are local, serialized, capped at 1 MiB with one rotated backup, and best-effort: a write failure is logged and
the tool result is unchanged. See [Local Metrics and the Edit Journal](metrics.md).

## Result limits

Capability results are untrusted and may be large. `toToolCallContent`:

- always emits a human-readable message (`Done.` or `Failed.` when the capability provides none);
- emits an error block first when `ok` is false;
- emits compact JSON for `data` plus warnings, next actions, handle, artifacts, and preview metadata;
- appends at most 50 `label: path` or `label: uri` lines per artifact, then a count of the remaining artifacts;
- caps strings at 8 KiB, arrays/objects at 500 entries and 8 levels, and replaces a JSON payload over 32 KiB with a
  marked summary that keeps a compact change set and undo token;
- omits inline base64 data URIs and oversized base64-like payloads, and represents binary buffers as `[binary omitted]`.

## Previews

A result with a `preview` gets one preview block before its JSON block:

- image and SVG data URIs become Theia image blocks, capped at 4 MiB;
- image and SVG paths are read through `FileService`, capped at 4 MiB, and become image blocks; a failed or oversized read becomes a text link;
- HTML becomes a Theia HTML app block titled with the caption, capped at 4 MiB;
- markdown becomes a text block.

Every preview is followed by a caption block with the caption, `Limitations: ...` when present, and
`Preview is approximate` when `truthful` is false. The JSON block references the preview path or
`[preview omitted]`; it never carries the raw base64 payload. The bridge persists a bundle after a successful
capability invocation only when the result has a preview or artifacts, and passes the stored path as metadata without
mutating the result. See [Previews and Trajectory](preview.md).
