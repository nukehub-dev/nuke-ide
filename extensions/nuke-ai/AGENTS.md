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
  provider's screens or styling. The welcome surface also owns the `NukeAI quick start` actions and model-setup card;
  quick actions only execute existing commands, and the setup card links to the shared AI configuration command.
- `src/browser/agent/` owns the `NukeAI` agent (`NUKE_CHAT_AGENT_ID`). Bind it as both `Agent` (prompt registration)
  and `ChatAgent`; its prompt references every capability tool and `{{nukeContext}}`, and write/execute tools require
  explicit confirmation. The safe-edit section requires preview before apply for settings, materials, and tallies, a
  shown diff, confirmation, and undo reporting; see `docs/user/safe-edits.md`.
- `src/browser/agent/nuke-diagnostics-agent.ts` owns the read-only `Nuke Diagnostics` agent (`NUKE_DIAGNOSTICS_AGENT_ID`),
  bound as both `Agent` and `ChatAgent` with the `nuke-diagnostics-system` prompt set; it may only call the diagnostic
  and read-only support tools (including statepoint comparison and tally-series analysis), never the preview or apply tools.
  Series findings cover aggregate steps only; per-bin detail stays in the viewer. See `docs/user/diagnostics.md`.
- `NukeAiActionService.ask(prompt, displayText, agentId = NUKE_CHAT_AGENT_ID)` resolves the requested agent and falls back
  to `NukeAI`; the four `nuke.ai.diagnose*` commands sit under the NukeAI `Diagnostics` sidebar subgroup.
- `src/browser/actions/` owns the read-only NukeAI commands, `NukeAiActionService`, and the NukeAI Nuke Tools
  section. Actions send `#nukeContext` through `ChatService`, never import domain extensions, and report failures.
  `nuke-ai-context-actions.ts` publishes the same commands through nuke-core's neutral context-action registry for
  CAD, OpenMC, DAGMC, and tally menus; domain extensions never import nuke-ai.
- Do not add `@theia/ai-mcp-server`: its generic `/mcp` endpoint starts automatically without auth or origin checks.
  External MCP is a separate opt-in contribution; see `docs/dev/mcp.md`.
- `src/browser/capabilities/nuke-tool-schema.ts` converts capability ids and JSON schemas into sanitized tool names and
  `ToolRequestParameters`; the bridge registers both `ToolRequest.id` and `ToolRequest.name` as that name while the
  capability id stays the registry/MCP/resource identifier.
- `src/browser/capabilities/nuke-tool-result.ts` renders `NukeCapabilityResult` as bounded `ToolCallContent`: 8 KiB per
  string, 32 KiB per JSON payload, `[truncated]` markers, and no inline base64 or binary payloads. The JSON payload
  carries `changeSet` and `undoToken` when present.
- `src/browser/capabilities/nuke-tool-call-summary.ts` parses finished `nuke_*` results into a normalized summary,
  including a safe `changeSet` diff and `undoToken`; `nuke-tool-call-card.tsx` is the pure card rendering status,
  counts, issues, warnings, previews, artifacts, executable next actions, and the diff with **Apply with NukeAI** and
  **Undo**; `nuke-tool-call-renderer.tsx` binds the Theia renderer, opener service, and parsed card props.
- `NukeNextActionService` runs read-only next actions in place and replaces the card result through `updateResult`;
  write/execute/destructive actions only open a NukeAI prompt that keeps the normal confirmation flow. `applyChangeSet`
  requires a `write`/`execute` apply capability and never invokes it; `undo` confirms through `MessageService.warn` and
  calls `NukeUndoService.undo`, updating the card only on success. See `docs/dev/agent-and-cards.md`.
- The pure card helper claims only finished, non-awaiting `nuke_*` calls (priority 30) and returns -1 otherwise so
  Theia keeps progress and confirmation UI; see `docs/dev/agent-and-cards.md`.
- `src/browser/preview/` persists truthful previews and command-to-preview trajectory lines under `.nuke-ide/ai/previews`; see `docs/dev/preview.md`.
- `nuke-preview-gallery-service.ts` scans `<workspace>/.nuke-ide/ai/previews` read-only, returns at most 100
  newest-first entries, skips malformed/symlinked paths, and never reads outside the workspace; the gallery has no
  delete or regenerate control. See `docs/user/previews.md`.
- `src/browser/capabilities/nuke-capability-tool-bridge.ts` keeps one tool per enabled capability under provider name `nuke-ai`. It unregisters stale tools before every refresh, debounces changes, coalesces concurrent refreshes, and disposes subscriptions and registrations on stop.
- `src/browser/capabilities/` journals local-only metrics and applied edits under `<workspace>/.nuke-ide/ai`: no inputs,
  file contents, metric paths, raw tokens, or before/after values; undo tokens are SHA-256 hashed. Writes are serialized,
  capped at 1 MiB with one backup, and never fail a tool call. See `docs/dev/metrics.md`.
- `NukeAI: Show Capability Catalog` and `NukeAI: Show Tool Metrics` are read-only; the catalog uses `getEnabled` and never
  invokes. Undo stays session-scoped, and the edit journal is an audit trail, not an undo source. See `docs/user/audit.md`.
- `nuke-core` owns the capability contract and registry; import them from `nuke-core/lib/...`, never from another extension's `src/`.
- The capability tool bridge path is in-process only. Do not route chat tool calls through HTTP or MCP.
- `src/browser/mcp/` and `src/node/mcp/` own external MCP: off by default, token-protected, loopback-only, hosted on
  `@theia/external-api` at `/nuke-ai-mcp`; the backend reads `<configDir>/nuke-ai-mcp.json`, and every MCP session gets
  its own `McpServer`, `StreamableHTTPServerTransport`, live read-only catalog, resources, and prompts.
- External MCP never exposes write/execute/destructive tools: only the explicit read-only allowlist in
  `src/common/nuke-mcp-protocol.ts` may register, and the raw handler and tool handler re-check it. Per-session tool
  rate limits, 30-minute idle eviction, and the redacted 200-row audit ring live beside the contribution. See `docs/dev/mcp.md`.
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
npx vitest run extensions/nuke-ai/src/browser/agent/nuke-chat-agent.test.ts
npx vitest run extensions/nuke-ai/src/browser/agent/nuke-diagnostics-agent.test.ts
npx vitest run extensions/nuke-ai/src/browser/actions/nuke-ai-action-service.test.ts
npx vitest run extensions/nuke-ai/src/browser/actions/nuke-ai-commands.test.ts
npx vitest run extensions/nuke-ai/src/browser/actions/nuke-ai-tools-contribution.test.ts
npx vitest run extensions/nuke-ai/src/browser/capabilities/nuke-tool-schema.test.ts
npx vitest run extensions/nuke-ai/src/browser/capabilities/nuke-tool-result.test.ts
npx vitest run extensions/nuke-ai/src/browser/capabilities/nuke-tool-call-summary.test.ts
npx vitest run extensions/nuke-ai/src/browser/capabilities/nuke-tool-call-card.test.tsx
npx vitest run extensions/nuke-ai/src/browser/capabilities/nuke-next-action-service.test.ts
npx vitest run extensions/nuke-ai/src/browser/preview/nuke-preview-store.test.ts
npx vitest run extensions/nuke-ai/src/browser/welcome
npx vitest run extensions/nuke-ai/src/browser/preview
npx vitest run extensions/nuke-ai/src/browser/capabilities/nuke-capability-tool-bridge.test.ts
npx vitest run extensions/nuke-ai/src/browser/capabilities/nuke-ai-metrics-service.test.ts
npx vitest run extensions/nuke-ai/src/browser/capabilities/nuke-edit-journal.test.ts
npx vitest run extensions/nuke-ai/src/browser/commands
npx vitest run extensions/nuke-ai/src/node/skills/nuke-skill-service.test.ts
npx vitest run extensions/nuke-ai/src/browser/skills/nuke-skill-directory-contribution.test.ts
npx vitest run extensions/nuke-ai/src/browser/context/nuke-context-variable-contribution.test.ts
npx vitest run extensions/nuke-ai/src/browser/resources/nuke-resource-service.test.ts
npx vitest run extensions/nuke-ai/src/node/mcp/nuke-mcp-auth.test.ts
npx vitest run extensions/nuke-ai/src/node/mcp/nuke-mcp-config-service.test.ts
npx vitest run extensions/nuke-ai/src/node/mcp/nuke-mcp-protocol.test.ts
npx vitest run extensions/nuke-ai/src/node/mcp/nuke-mcp-catalog.test.ts
npx vitest run extensions/nuke-ai/src/node/mcp/nuke-mcp-audit.test.ts
npx vitest run extensions/nuke-ai/src/node/mcp/nuke-mcp-session-registry.test.ts
npx vitest run extensions/nuke-ai/src/node/mcp/nuke-mcp-contribution.test.ts
npx vitest run extensions/nuke-ai/src/browser/mcp/nuke-capability-delegate-client.test.ts
yarn lint
```

## Child NAD Index

- None
