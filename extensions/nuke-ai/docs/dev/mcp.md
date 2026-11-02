# External MCP

`nuke-ai` can expose a read-only MCP endpoint to external agents. It is off by default, requires a bearer token, binds
to loopback, and runs on Theia's external API server. The endpoint is a separate surface from the in-process capability
tool bridge used by the AI chat.

## Architecture

```text
External MCP client
        │ Streamable HTTP + Authorization: Bearer <token>
        ▼
@theia/external-api server (127.0.0.1:<port>)
        │ ExternalApiContribution.configure(router)
        ▼
NukeMcpContribution (backend, one server per session)
        │ JSON-RPC NukeCapabilityDelegate
        ▼
NukeCapabilityDelegateClientImpl (frontend)
        │ nuke-core registry + NukeResourceService
        ▼
allowlisted read-only capabilities / nuke:// resources / generated prompts
```

- `NukeMcpContribution` is an `ExternalApiContribution` mounted at `/nuke-ai-mcp`.
- The backend cannot call frontend services directly. It holds one frontend RPC client, set through an
  `RpcConnectionHandler` at `/services/nuke-ai/capability-delegate`.
- The frontend delegate waits for `NukeCapabilityRegistry.ready`, projects enabled capabilities, validates input with
  `validateCapabilityInput`, merges `NukeCapabilityContextService.getContext()`, and invokes the capability.
- `listResources()` returns descriptors only; resource reads stay in `NukeResourceService`. The backend never reads
  arbitrary files or paths.

## Why not `@theia/ai-mcp-server`

The generic Theia MCP server starts automatically on `/mcp` without a token or origin check. This endpoint must be off by
default and fail closed, so it mounts its own contribution on the external API server instead. Do not add
`@theia/ai-mcp-server` as a dependency or patch Theia's generic endpoint.

## Read-only allowlist

Only the capability IDs in `MCP_READ_ONLY_CAPABILITY_IDS` (`src/common/nuke-mcp-protocol.ts`) may cross the external
boundary:

| Capability                     | MCP tool name                   |
| ------------------------------ | ------------------------------- |
| `nuke.cad.summarizeDocument`   | `nuke_cad_summarize_document`   |
| `nuke.cad.inspectSelection`    | `nuke_cad_inspect_selection`    |
| `nuke.cad.diagnoseModel`       | `nuke_cad_diagnose_model`       |
| `nuke.openmc.summarizeProject` | `nuke_openmc_summarize_project` |
| `nuke.openmc.validateProject`  | `nuke_openmc_validate_project`  |
| `nuke.openmc.getRunStatus`     | `nuke_openmc_get_run_status`    |
| `nuke.openmc.diagnoseProject`  | `nuke_openmc_diagnose_project`  |
| `nuke.openmc.diagnoseRun`      | `nuke_openmc_diagnose_run`      |
| `nuke.viz.summarizeStatepoint` | `nuke_viz_summarize_statepoint` |
| `nuke.viz.diagnoseStatepoint`  | `nuke_viz_diagnose_statepoint`  |
| `nuke.viz.captureView`         | `nuke_viz_capture_view`         |

The catalog is rebuilt per session from `delegate.listCapabilities()`:

- A capability is registered only when it is allowlisted, `risk === 'read'`, `requiresConfirmation !== true`, and its
  annotations do not contradict read-only (`readOnlyHint: false` or `destructiveHint: true`).
- `toMcpToolName` preserves the original `nuke.cad.summarizeDocument` to `nuke_cad_summarize_document` name and maps
  every other ID from dots to underscores and camelCase to snake_case. Names must match `^[a-z0-9_]{1,128}$`.
- Each tool advertises its live JSON input schema and, when the capability declares one, its output schema through
  `zod.fromJSONSchema`, canonical read-only annotations, a bounded description, and one worked example.
- Tool results and resource reads are bounded to 1 MiB; inline data URIs are omitted from the MCP result projection.
- Missing, disabled, unsafe, duplicate, or unconvertible descriptors are skipped at debug level. The catalog is capped
  at 24 tools.
- When the frontend is not connected the session opens with an empty tool list. A tool invocation that loses the
  frontend returns `isError: true` with `NukeIDE frontend is not connected.`; the endpoint never falls back to a stale
  static catalog.
- Tool names are re-checked in the raw HTTP handler before the transport sees `tools/call`, so a tool that is not
  registered for that session, or no longer passes the allowlist and read-only checks, is rejected with `403` and a
  JSON-RPC `-32601` error.

Do not add `exportDagmc`, `runSimulation`, import, preview/apply, or any write/execute/destructive capability. Write
tools stay in the in-process AI chat because MCP clients are external processes without NukeIDE's confirmation UI; a
read-only catalog keeps the endpoint's blast radius to observation.

## Resources

The endpoint advertises resource descriptors from `delegate.listResources()`:

- `nuke://context`
- `nuke://cad/document`
- `nuke://openmc/project`
- `nuke://visualizer/dataset`
- `nuke://skills/<name>` (one per discovered skill)

The backend accepts only those fixed URIs and valid lowercase skill names, deduplicates them, and caps the list at 64.
Each read delegates to `NukeResourceService` and returns `text` with the descriptor's `mimeType`. Read failures produce an
MCP internal error (`-32603`) without stopping the session or the server. If the descriptor list is unavailable or
malformed, the session registers only `nuke://context` as a static fallback and logs the gap.

## Prompts

- `nuke-workflow` walks the CAD to DAGMC to OpenMC to visualizer flow and lists only the tools exposed in that session.
- `nuke-diagnostics` triages CAD, OpenMC project/run, and statepoint findings, prioritizes findings by severity, and lists
  only the exposed diagnostic tools.

Both prompts are generated from the session catalog, not from a hard-coded capability list. Neither performs an action.

## Configuration

The enable command owns the external API preferences for this endpoint:

- `externalApi.delivery = 'separatePort'`
- `externalApi.hostname = '127.0.0.1'`
- `externalApi.port = <nuke.ai.mcp.port>`
- `externalApi.token = <generated token>`

It also sets `nuke.ai.mcp.enabled` and `nuke.ai.mcp.port`. The backend does not trust user-scope preferences: the
enable command writes `<configDir>/nuke-ai-mcp.json` with `{ "enabled": true, "token": "...", "port": 3210 }`, and
`NukeAIMcpConfigService` reads that file with a one-second cache. Missing, malformed, or invalid files mean disabled.
The service tightens a world-readable file to owner-only on POSIX hosts, logs one warning if it cannot, and never
logs the token.

Disabling sets the `nuke.ai.mcp.enabled` preference to false, turns delivery off, clears the token and MCP port, and
deletes the config file. Both commands are idempotent. The external API configuration is backend-global and is not
revoked when a frontend disconnects.

## Request pipeline

Every request goes through these checks, in order:

1. Config file missing or `enabled: false` -> `404`.
2. Config token empty or whitespace -> `503` with `MCP is disabled until a token is configured.`
3. Any `Origin` header -> `403`.
4. A non-loopback peer address -> `403`.
5. `Authorization` is not exactly `Bearer <token>` -> `401`.
6. MCP session handling:
   - unknown `mcp-session-id` -> `404` JSON-RPC error (`-32001`);
   - a `tools/call` naming a tool not registered in that session -> `403` JSON-RPC error (`-32601`);
   - non-initialize request without a session -> `400` JSON-RPC error (`-32000`);
   - more than 16 active sessions -> `503`;
   - otherwise the request is handed to that session's transport.

The `Origin`, loopback, and bearer checks repeat Theia's external API checks as defense in depth. Bearer comparison
hashes both sides and uses `crypto.timingSafeEqual`. The external API server also rejects cross-origin requests before
the contribution runs.

## Session lifecycle and limits

The MCP SDK allows one transport per `McpServer`, so the endpoint creates one `McpServer`, one
`StreamableHTTPServerTransport`, and one catalog per MCP session. `NukeMcpSessionRegistry` owns the active map:

- at most 16 concurrent sessions;
- sessions idle for 30 minutes are evicted; the sweep timer is unref'd and stopped when the map empties;
- eviction and routing rebuilds close the server and transport;
- each session may make 60 tool or resource calls per 60-second window. Excess calls return a clear MCP error and an audit row;
- `router.toDispose` closes every remaining session when Theia rebuilds the external API routing or shuts down.

## Audit ring

`NukeMcpAuditLog` keeps the last 200 tool/resource-call rows in memory. A row carries the timestamp, session id, tool or resource name,
duration, `ok`, a truncated SHA-256 input hash, and a bounded redacted input summary. Credential-like keys
(`authorization`, `token`, `apiKey`, `secret`, `password`) and Bearer/key-value secret values become `[redacted]`,
strings are capped, and neither file contents, resource contents, result payloads, nor the bearer token are stored. The ring is process-local and is not
persisted.

## Extending the catalog

1. Add a capability to `nuke-cad`, `openmc-studio`, or `nuke-visualizer`; never to this extension.
2. If it is read-only and safe for external agents, add its ID to `MCP_READ_ONLY_CAPABILITY_IDS`. Being `read` alone is
   not enough.
3. Add the matching resource URI or prompt only if it stays inside the read-only contract.
4. Extend `nuke-mcp-protocol.test.ts`, `nuke-mcp-catalog.test.ts`, and `nuke-mcp-contribution.test.ts` for the new tool,
   resource, or prompt, including the real client round trip.
5. Keep the endpoint off by default and keep write/execute/destructive actions out until a separate security review.

Multi-frontend routing, OAuth, persistent audit storage, and MCP apps/HTML tool results are out of scope. With more than
one IDE window connected, the oldest live frontend serves the endpoint; close it to hand the endpoint to the next
window, or close the other windows if the wrong workspace answers.

## Verification

```bash
npx lerna run build --scope nuke-ai --scope nuke-core
npx vitest run extensions/nuke-ai/src/node/mcp
npx vitest run extensions/nuke-ai/src/browser/mcp
npx vitest run extensions/nuke-ai
yarn lint
```
