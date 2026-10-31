# Nuke AI

## Purpose

AI runtime integration for NukeIDE. This extension bundles the Theia AI runtime and provider packages, the NukeAI chat
Welcome theming, the capability tool bridge that exposes enabled `NukeCapability` handlers from `nuke-core` to the
IDE's AI chat as Theia tools, domain skills, an active-workspace context variable, read-only project resources, and an
opt-in external MCP endpoint.

## Ownership

All files under `extensions/nuke-ai/` except generated artifacts (`lib/`, `node_modules/`, `*.tsbuildinfo`). This
includes the `@theia/ai-*` runtime and provider dependencies and the welcome theming under `src/browser/welcome/`.

## Local Contracts

- `nuke-ai` is optional at build time. No other extension may depend on it, and required extensions must not import
  `@theia/ai-*`; `NUKE_EXCLUDE_EXTENSIONS=nuke-ai` must build an IDE without NukeAI and its tools (the Theia plugin host
  still bundles inert `@theia/ai-core`, `@theia/ai-core-ui`, and `@theia/ai-mcp`).
- `src/browser/welcome/nuke-ai-chat-frontend-module.ts` rebinds `ChatWelcomeMessageProvider` to
  `NukeChatWelcomeMessageProvider` (priority 101) and keeps `ChatSessionsWelcomeMessageProvider`; do not change the
  provider's screens or styling.
- Do not add `@theia/ai-mcp-server`: its generic `/mcp` endpoint starts automatically without auth or origin checks.
  External MCP is a separate opt-in contribution; see `docs/dev/mcp.md`.
- `src/browser/capabilities/nuke-tool-schema.ts` converts capability ids and JSON schemas into `ToolRequest` names and `ToolRequestParameters`; it throws for non-object input schemas.
- `src/browser/capabilities/nuke-tool-result.ts` renders `NukeCapabilityResult` as bounded `ToolCallContent`: 8 KiB per string, 32 KiB per JSON payload, `[truncated]` markers, and no inline base64 or binary payloads.
- `src/browser/preview/` persists truthful previews and command-to-preview trajectory lines under `.nuke-ide/ai/previews`; see `docs/dev/preview.md`.
- `src/browser/capabilities/nuke-capability-tool-bridge.ts` keeps one tool per enabled capability under provider name `nuke-ai`. It unregisters stale tools before every refresh, debounces changes, coalesces concurrent refreshes, and disposes subscriptions and registrations on stop.
- `nuke-core` owns the capability contract and registry; import them from `nuke-core/lib/...`, never from another extension's `src/`.
- The capability tool bridge path is in-process only. Do not route chat tool calls through HTTP or MCP.
- `src/browser/mcp/` and `src/node/mcp/` own external MCP: off by default, token-protected, loopback-only, read-only,
  hosted on `@theia/external-api` at `/nuke-ai-mcp`; the backend reads `<configDir>/nuke-ai-mcp.json`, and every MCP
  session gets its own `McpServer` + `StreamableHTTPServerTransport`. See `docs/dev/mcp.md`.
- `src/node/skills/nuke-skill-service.ts` exposes the packaged skill root over RPC; `src/browser/skills/`,
  `src/browser/context/`, and `src/browser/resources/` own the Theia skill directory, `#nukeContext`, and read-only
  resources. See `docs/dev/skills.md` and `docs/dev/context-and-resources.md`.
- Tool confirmation follows risk: `read` is unguarded, `write`/`execute` require always-allow confirmation, and `destructive` adds an overwrite/delete warning.

## Work Guidance

- Add AI-facing actions as `NukeCapability` contributions in the owning domain extension, not as private tools here.
- Keep schema, result, and bridge helpers pure and testable with fake registries; tests must not boot Theia or call an LLM.
- A capability that fails conversion or registration is logged and skipped; never let it abort the rest of a refresh.
- Update `docs/dev/architecture.md` and `docs/dev/adding-a-capability.md` when the bridge contract changes.

## Verification

```bash
npx lerna run build --scope nuke-ai --scope nuke-core
npx vitest run extensions/nuke-ai/src/browser/capabilities/nuke-tool-schema.test.ts
npx vitest run extensions/nuke-ai/src/browser/capabilities/nuke-tool-result.test.ts
npx vitest run extensions/nuke-ai/src/browser/preview/nuke-preview-store.test.ts
npx vitest run extensions/nuke-ai/src/browser/capabilities/nuke-capability-tool-bridge.test.ts
npx vitest run extensions/nuke-ai/src/node/skills/nuke-skill-service.test.ts
npx vitest run extensions/nuke-ai/src/browser/skills/nuke-skill-directory-contribution.test.ts
npx vitest run extensions/nuke-ai/src/browser/context/nuke-context-variable-contribution.test.ts
npx vitest run extensions/nuke-ai/src/browser/resources/nuke-resource-service.test.ts
npx vitest run extensions/nuke-ai/src/node/mcp/nuke-mcp-auth.test.ts
npx vitest run extensions/nuke-ai/src/node/mcp/nuke-mcp-config-service.test.ts
npx vitest run extensions/nuke-ai/src/node/mcp/nuke-mcp-contribution.test.ts
npx vitest run extensions/nuke-ai/src/browser/mcp/nuke-capability-delegate-client.test.ts
yarn lint
```

## Child NAD Index

- None
