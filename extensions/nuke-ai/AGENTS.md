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
- Hover/focus hints in the welcome and chat surfaces use the shared `nuke-essentials` `Tooltip`; native `title` attributes are not product tooltips.
- `src/browser/welcome/nuke-ai-chat-frontend-module.ts` rebinds `ChatWelcomeMessageProvider` to
  `NukeChatWelcomeMessageProvider` (priority 101) and keeps `ChatSessionsWelcomeMessageProvider`; do not change the
  fallback session provider's screens or styling. The welcome surface also owns the `NukeAI quick start` actions,
  model-setup card, and pointer-tracking decorative bot; the bot replaces the former static logo across the welcome
  screens, blinks and tilts toward the pointer, stops autonomous motion under `prefers-reduced-motion`, and quick
  actions only execute existing commands. The welcome and tool cards are container-query responsive: the quick-action
  grid, guide button, chat composer options, and two-column tool-card grids collapse or wrap in a narrow docked panel.
  The guide link targets `nuke.docs.open` with `/nuke-ai/user/getting-started.md`.
- `src/browser/welcome/nuke-ai-walkthrough-provider.ts` rebinds `WalkthroughProvider` over Theia's AI walkthrough. It keeps
  the walkthrough and step ids (so saved progress and `ai.openGettingStartedWalkthrough` survive) and rewrites the
  opening and closing slides to NukeAI guide/NukeHub links. Help lists it as **NukeAI Walkthrough...**.
- `src/browser/agent/` owns the `NukeAI` agent (`NUKE_CHAT_AGENT_ID`). Bind it as both `Agent` (prompt registration)
  and `ChatAgent`; an empty default-agent preference is set to NukeAI, and the welcome picker lists NukeAI and Nuke
  Diagnostics ahead of Theia's recommendations. Its prompt references every capability tool and `{{nukeContext}}`, and
  write/execute tools require explicit confirmation. The safe-edit section requires preview before apply for settings,
  materials, tallies, and CAD feature/sketch/topology/import/assembly/drawing edits, a shown diff or plan, confirmation, and
  undo reporting; script preview is shown but its apply is panel-only, never from chat. See `docs/user/safe-edits.md`.
- CAD authoring ships eight slices: the edit slices and creation apply follow `nukeCad.aiAuthoringEnabled` (default off) and
  the edit slices require a saved model; template listing is read-only and ungated:
  scalar feature params; existing sketch dimensions or referenced parameters; topology-impacting hole blind/through
  mode or linear/circular pattern count; imported STEP/IGES/BREP bodies; placement-only edits on an existing grounded
  assembly; presentation settings on existing drawing sheets; Linux-only sandboxed full-file `.py` replacements; and
  shipped-template document creation. The feature, sketch, topology, and assembly slices run
  a real-build preview, CAD Edit Review panel + ghost, atomic commit, backup, rebuild, and undo; parameter-bound edits
  cascade. The topology slice reports added/removed solids
  and named regions, checks the saved active OpenMC project's DAGMC references, and requires acknowledgement; apply never
  rewrites OpenMC. The import slice uses a user-chosen source with a plan-only preview (no build or ghost), stale source
  re-inspection, one `addImportBodies` commit, backup, rebuild, and undo; document-folder references are self-contained,
  but other workspace sources warn. The assembly slice adds an existing `body:<id>` or reuses an existing instance part,
  removes a non-grounded connector-free embedded instance (final count >= 1), or sets pos+quat on a grounded/unmated
  instance; it reports placement rows, BOM delta, exact overlap warnings, and `overlapCheck:false`, requires
  acknowledgement only when a removal loses the last instance of a labeled embedded body, and blocks apply on a saved
  OpenMC reference. The drawing slice summarizes existing sheets/views/dimensions and previews one sheet with 1-16
  `setSheetSize`, `setViewDisplay`, or `setDimensionVisibility` actions; preview is plan-only (no build or ghost), A3→A4
  is rejected when a view is outside A4 and views never move, hidden dimensions stay listed but leave SVG/DXF, and the
  title block is fixed. Drawing apply is one `applyDrawingChanges` commit with backup, sheet refresh, undo, and no
  `nuke.cad.rebuild`.
  Creation is parameter-only: `listDocumentTemplates` is read-only and ungated, `prepareDocumentCreation` resolves
  typed parameters, re-solves affected sketches, and real-builds a private candidate without installing it, and
  `createDocumentFromTemplate` writes a fresh `.nuke-cad` at a validated workspace path (write, confirmed, undoable;
  dirty-document refusal, `replaceExisting` for a clean open document, hash-guarded undo); it is card-only with no ghost.
  Script authoring (the seventh slice) is Linux-only sandboxed `.py` authoring, requiring both `nukeCad.aiAuthoringEnabled` and
  workspace-scoped `nukeCad.scriptAuthoringEnabled`: `inspectScriptSource` returns bounded text/hash/imports (text goes to
  the model provider; inspection requires confirmation), `previewScriptChange` takes an exact base hash plus the full body, runs `bwrap` with no
  network/workspace, returns a diff/sandbox/build audit and no ghost, and omits `applyCapability` so chat has no Apply.
  Apply is panel-only with a hidden approval nonce, overwrites with a backup, rebuilds sandboxed, and blocks DAGMC/FEM
  export while the model stays sandboxed. No fallback without bubblewrap or libseccomp; the filter is a denylist, so
  residual kernel/bubblewrap risk remains.
  Booleans, body/feature add/delete/reorder, lattices, partial or unsandboxed scripts, unreferenced parameters, assembly
  structure beyond placement, drawing creation/deletion or view placement, title-block edits, model-authored or
  user-registered templates, overwriting an existing file, and MCP stay excluded. See
  `docs/dev/cad-authoring-design.md` and `docs/dev/skills.md`.
- `src/browser/agent/nuke-diagnostics-agent.ts` owns the read-only `Nuke Diagnostics` agent (`NUKE_DIAGNOSTICS_AGENT_ID`),
  bound as both `Agent` and `ChatAgent` with the `nuke-diagnostics-system` prompt set; it may only call the diagnostic
  and read-only support tools (including statepoint comparison and tally-series analysis), never the preview or apply tools.
  Series findings cover aggregate steps only; per-bin detail stays in the viewer. The capability bridge also rejects
  any non-diagnostics capability when the request agent is Nuke Diagnostics, even if manually referenced. See
  `docs/user/diagnostics.md`.
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
- `NukeNextActionService` runs read-only next actions in place and replaces the card result through the same bounded result conversion and `updateResult`;
  write/execute/destructive actions only open a NukeAI prompt that keeps the normal confirmation flow. `applyChangeSet`
  requires a `write`/`execute` apply capability and never invokes it; `undo` confirms through `MessageService.warn` and
  calls `NukeUndoService.undo`, updating the card only on success. See `docs/dev/agent-and-cards.md`.
- The pure card helper claims only finished, non-awaiting `nuke_*` calls (priority 30) and returns -1 otherwise so
  Theia keeps progress and confirmation UI; see `docs/dev/agent-and-cards.md`.
- `src/browser/preview/` persists truthful previews and command-to-preview trajectory lines under `.nuke-ide/ai/previews`; see `docs/dev/preview.md`.
- `nuke-preview-gallery-service.ts` scans `<workspace>/.nuke-ide/ai/previews` read-only, returns at most 100
  newest-first entries, skips malformed/symlinked paths, and never reads outside the workspace; the gallery itself has
  no delete or regenerate control, while the separate **NukeAI: Clear Preview History** command deletes the validated
  workspace preview folder after confirmation. See `docs/user/previews.md`.
- `src/browser/capabilities/nuke-capability-tool-bridge.ts` keeps one tool per enabled capability under provider name `nuke-ai`. It subscribes to registry/context changes before the first refresh (a document can open during startup), unregisters stale tools before every refresh, debounces changes, coalesces concurrent refreshes, and disposes subscriptions and registrations on stop.
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
  `src/common/nuke-mcp-protocol.ts` may register, and the raw handler and tool handler re-check it. The script ids
  (`inspectScriptSource`, `previewScriptChange`, `applyScriptChange`) are never allowlisted. Per-session tool
  rate limits, 30-minute idle eviction, and the redacted 200-row audit ring live beside the contribution. See `docs/dev/mcp.md`.
- `src/node/skills/nuke-skill-service.ts` exposes the packaged skill root over RPC; `src/browser/skills/`,
  `src/browser/context/`, and `src/browser/resources/` own the Theia skill directory, `#nukeContext`, and read-only
  resources. See `docs/dev/skills.md` and `docs/dev/context-and-resources.md`.
- Tool confirmation follows risk: a plain `read` follows the IDE preference and may inherit always-allow; any capability with `requiresConfirmation: true`, plus every `write`/`execute`, needs an explicit per-tool allow; `destructive` adds an overwrite/delete warning.

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
npx vitest run extensions/nuke-ai/src/browser/capabilities/nuke-tool-call-renderer.test.tsx
npx vitest run extensions/nuke-ai/src/browser/capabilities/nuke-tool-call-card.test.tsx
npx vitest run extensions/nuke-ai/src/browser/capabilities/nuke-next-action-service.test.ts
npx vitest run extensions/nuke-ai/src/browser/preview/nuke-preview-store.test.ts
npx vitest run extensions/nuke-ai/src/browser/preview/nuke-preview-gallery-service.test.ts
npx vitest run extensions/nuke-ai/src/browser/welcome
npx vitest run extensions/nuke-ai/src/browser/preview
npx vitest run extensions/nuke-ai/src/browser/capabilities/nuke-capability-tool-bridge.test.ts
npx vitest run extensions/nuke-ai/src/browser/capabilities/nuke-ai-metrics-service.test.ts
npx vitest run extensions/nuke-ai/src/browser/capabilities/nuke-edit-journal.test.ts
npx vitest run extensions/nuke-ai/src/browser/commands
npx vitest run extensions/nuke-ai/src/node/skills/nuke-skill-service.test.ts
npx vitest run extensions/nuke-ai/src/browser/skills/nuke-skill-directory-contribution.test.ts
npx vitest run extensions/nuke-ai/src/browser/skills/nuke-skill-root-cache.test.ts
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
npx vitest run extensions/nuke-ai/src/browser/mcp/nuke-mcp-commands.test.ts
yarn lint
```

## Child NAD Index

- None
