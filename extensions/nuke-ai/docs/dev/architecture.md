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
```

A domain extension never imports `nuke-ai`. It contributes a `NukeCapability` through `nuke-core`, and `nuke-ai` discovers it from the registry. This keeps the dependency direction one-way: domain extensions depend on the contract, and only the AI extension depends on the AI runtime.

## Why there is no HTTP

The AI chat and the capability handlers both live in the frontend. Registering a `ToolRequest` gives Theia a direct function reference to the bridge handler, which then calls the capability's `invoke` method in the same process. There is no backend route, MCP server, or external client in this path, so:

- no serialization or authentication boundary is added between the model and the handler;
- an invocation sees the live frontend services and ambient context;
- nothing new listens on the network for this internal path.

External MCP exposure is a separate, opt-in surface; see [External MCP](mcp.md). It does not change this in-process path.

## Registration and refresh

On application start the bridge waits for `NukeCapabilityRegistry.ready`, performs one refresh, then subscribes to `NukeCapabilityRegistry.onDidChange` and `NukeCapabilityContextService.onDidChangeContext`.

A refresh:

1. Reads a context snapshot. If context collection fails, it falls back to an empty workspace-root list.
2. Unregisters every tool owned by provider `nuke-ai`, so stale tools never survive a change.
3. Registers one `ToolRequest` per capability returned by `getEnabled(context)`.
4. Logs how many tools were registered and which capability ids were skipped by a `when` predicate.

Change events are debounced with `setTimeout(0)`. Concurrent refreshes share one running pass, and a change that arrives during a pass requests one follow-up pass. A capability that fails schema conversion or registration is logged and skipped; other capabilities still register. Disposing or stopping the bridge removes the subscriptions and every tool it owns.

## Tool shape

- **id** — the capability id, for example `nuke.cad.exportDagmc`.
- **name** — the capability id sanitized to `[A-Za-z0-9_-]`, with repeated underscores collapsed and a 128-character cap, for example `nuke_cad_exportDagmc`.
- **description** — the capability description plus up to three `Example: ...` lines.
- **parameters** — the capability input schema converted to `ToolRequestParameters`.
- **providerName** — `nuke-ai`.
- **confirmAlwaysAllow** — `undefined` for `read`, `true` for `write` and `execute`, and a warning string for `destructive`.
- **getArgumentsShortLabel** — uses the first present key from `path`, `documentPath`, `projectPath`, `statepointPath`, `workingDirectory`, or `query`.
- **handler** — parses the argument JSON, validates required keys and top-level types, merges the ambient context, bridges cancellation to an `AbortSignal`, captures a preview bundle when the result has a preview or artifacts, and converts the result.

Schema conversion preserves JSON Schema keywords recursively, including nested `properties`, `required`, `items`, `anyOf`, `enum`, `default`, `minimum`, `maximum`, and `pattern`. The top-level `additionalProperties` keyword is dropped because Theia's `ToolRequestParameters` does not declare it; nested occurrences are preserved.

## Result limits

Capability results are untrusted and may be large. `toToolCallContent`:

- always emits a human-readable message (`Done.` or `Failed.` when the capability provides none);
- emits an error block first when `ok` is false;
- emits compact JSON for `data` plus warnings, next actions, handle, artifacts, and preview metadata;
- appends one `label: path` or `label: uri` line per artifact;
- truncates any single string at 8 KiB and replaces a JSON payload over 32 KiB with a marked summary;
- omits inline base64 data URIs and oversized base64-like payloads, and represents binary buffers as `[binary omitted]`.

## Previews

A result with a `preview` gets one preview block before its JSON block:

- image and SVG data URIs become Theia image blocks;
- image and SVG paths are read through `FileService`, capped at 4 MiB, and become image blocks; a failed or oversized read becomes a text link;
- HTML becomes a Theia HTML app block titled with the caption;
- markdown becomes a text block.

Every preview is followed by a caption block with the caption, `Limitations: ...` when present, and
`Preview is approximate` when `truthful` is false. The JSON block references the preview path or
`[preview omitted]`; it never carries the raw base64 payload. The bridge persists a bundle after a successful
capability invocation only when the result has a preview or artifacts, and passes the stored path as metadata without
mutating the result. See [Previews and Trajectory](preview.md).
