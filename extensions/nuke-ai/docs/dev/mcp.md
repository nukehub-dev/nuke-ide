# External MCP

`nuke-ai` can expose a small, read-only MCP endpoint to external agents. It is off by default, requires a bearer
token, binds to loopback, and runs on Theia's external API server. The endpoint is a separate surface from the
in-process capability tool bridge used by the AI chat.

## Architecture

```text
External MCP client
        │ Streamable HTTP + Authorization: Bearer <token>
        ▼
@theia/external-api server (127.0.0.1:<port>)
        │ ExternalApiContribution.configure(router)
        ▼
NukeMcpContribution (backend)
        │ JSON-RPC NukeCapabilityDelegate
        ▼
NukeCapabilityDelegateClientImpl (frontend)
        │ nuke-core registry + NukeResourceService
        ▼
nuke.cad.summarizeDocument / nuke://context / nuke://cad/document
```

- `NukeMcpContribution` is an `ExternalApiContribution` mounted at `/nuke-ai-mcp`.
- The backend cannot call frontend services directly. It holds one frontend RPC client, set through a
  `RpcConnectionHandler` at `/services/nuke-ai/capability-delegate`.
- The frontend delegate waits for `NukeCapabilityRegistry.ready`, projects enabled capabilities, validates input with
  `validateCapabilityInput`, merges `NukeCapabilityContextService.getContext()`, and invokes the capability.
- Resource reads go through `NukeResourceService`; the backend never reads arbitrary files or paths.

## Why not `@theia/ai-mcp-server`

The generic Theia MCP server starts automatically on `/mcp` without a token or origin check. This endpoint must be off by
default and fail closed, so it mounts its own contribution on the external API server instead. Do not add
`@theia/ai-mcp-server` as a dependency or patch Theia's generic endpoint.

## Read-only catalog

The initial catalog deliberately exposes only:

| Surface  | Value                                                                |
| -------- | -------------------------------------------------------------------- |
| Tool     | `nuke_cad_summarize_document` backed by `nuke.cad.summarizeDocument` |
| Resource | `nuke://context`                                                     |
| Resource | `nuke://cad/document`                                                |
| Prompt   | `nuke-workflow`                                                      |

The tool advertises `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, and
`openWorldHint: false`. It forwards the capability's input and output JSON Schemas, result data as
`structuredContent`, the full result as text content, and `isError: true` for failed capability calls.

Do not add `exportDagmc`, `runSimulation`, import, or any write/execute/destructive capability to this catalog. The
`nuke-workflow` prompt only describes the workflow; it performs no action.

## Configuration

The enable command owns the external API preferences for this endpoint:

- `externalApi.delivery = 'separatePort'`
- `externalApi.hostname = '127.0.0.1'`
- `externalApi.port = <nuke.ai.mcp.port>`
- `externalApi.token = <generated token>`

It also sets `nuke.ai.mcp.enabled` and `nuke.ai.mcp.port`. The backend does not trust user-scope preferences: the
enable command writes `<configDir>/nuke-ai-mcp.json` with `{ "enabled": true, "token": "...", "port": 3210 }`, and
`NukeAIMcpConfigService` reads that file with a one-second cache. Missing, malformed, or invalid files mean disabled.
The service logs a one-time warning when the file is world-readable and never logs the token.

Disabling sets the `nuke.ai.mcp.enabled` preference to false, turns delivery off, clears the token and MCP port, and
deletes the config file. Both commands are idempotent. The external API configuration is backend-global and is not
revoked when a frontend disconnects.

## Request pipeline

Every request goes through these checks, in order:

1. Config file missing or `enabled: false` -> `404`.
2. Config token empty or whitespace -> `503` with `MCP is disabled until a token is configured.`
3. Any `Origin` header -> `403`.
4. `Authorization` is not exactly `Bearer <token>` -> `401`.
5. MCP session handling:
   - unknown `mcp-session-id` -> `404` JSON-RPC error (`-32001`);
   - non-initialize request without a session -> `400` JSON-RPC error (`-32000`);
   - more than 16 active sessions -> `503`;
   - otherwise the request is handed to that session's transport.

The `Origin` and bearer checks repeat Theia's external API checks as defense in depth. Bearer comparison hashes both
sides and uses `crypto.timingSafeEqual`. The external API server also rejects cross-origin requests before the
contribution runs.

## Session lifecycle

The MCP SDK allows one transport per `McpServer`, so the endpoint creates one `McpServer` and one
`StreamableHTTPServerTransport` per MCP session instead of one server per contribution build. The server and
transport are registered in a build-scoped map when `onsessioninitialized` fires. `onsessionclosed` and
`transport.onclose` remove the entry, and `router.toDispose` closes every remaining server when Theia rebuilds the
external API routing or shuts down. Sessions are capped at 16.

## Extending the catalog

1. Add a capability to `nuke-cad` or another domain extension, not to this extension.
2. Add its schema to a static catalog entry in `src/common/nuke-mcp-protocol.ts` only if the capability is read-only.
3. Register the MCP tool, resource, or prompt in `NukeMcpContribution.createServer`.
4. Extend `nuke-mcp-contribution.test.ts` with a real client round trip for schemas, annotations, resources, and
   prompts.
5. Keep the endpoint off by default and keep write/execute/destructive actions out until a separate security review.

Multi-frontend routing, OAuth, and a dynamic full-registry catalog are out of scope for this endpoint.

## Verification

```bash
npx lerna run build --scope nuke-ai --scope nuke-core
npx vitest run extensions/nuke-ai/src/node/mcp/nuke-mcp-contribution.test.ts
npx vitest run extensions/nuke-ai/src/node/mcp/nuke-mcp-config-service.test.ts
npx vitest run extensions/nuke-ai/src/node/mcp/nuke-mcp-auth.test.ts
npx vitest run extensions/nuke-ai/src/browser/mcp/nuke-capability-delegate-client.test.ts
```
