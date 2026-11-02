# NukeAI Agent and Tool Result Cards

This page describes the NukeAI chat agent, the contextual action service, and the compact cards that replace raw JSON
for finished Nuke capability calls.

## Agent contract

`src/browser/agent/nuke-chat-agent.ts` registers the `NukeAI` agent (`NUKE_CHAT_AGENT_ID`). The agent:

- extends `AbstractStreamParsingChatAgent` and is bound as both `Agent` and `ChatAgent`;
- uses the `chat` language-model purpose and the `nuke-system` prompt;
- declares `nuke.context` and the thirty-seven capability tool names in its `functions` list;
- references every capability tool through `~{toolName}` in the prompt, where `toolName` is the sanitized name
  registered by the bridge (for example `nuke_cad_summarizeDocument`), not the capability id, so the model receives
  the typed tools without a separate registration step.

The system prompt introduces the CAD → DAGMC → OpenMC → statepoint workflow, lists read-only tools first, and tells
the model to ask before a write, execute, or destructive tool. Export, import, run, and viewer-open tools keep their
Theia confirmation requirement. Never add a write or execute tool to the prompt without a matching confirmation path.

The safe-edit section requires NukeAI to preview with `nuke_openmc_previewSettings`, `nuke_openmc_previewMaterialChange`,
`nuke_openmc_previewTallyChange`, `nuke_cad_previewFeatureChange`, `nuke_cad_previewSketchChange`,
`nuke_cad_previewTopologyChange`, `nuke_cad_previewImportBodies`, `nuke_cad_previewAssemblyChange`, or
`nuke_cad_previewDrawingChange`, show the diff, plan, placement rows, or sheet/view/dimension rows, apply with the
matching apply tool (including `nuke_cad_applyFeatureChange`, `nuke_cad_applySketchChange`,
`nuke_cad_applyTopologyChange`, `nuke_cad_applyImportBodies`, `nuke_cad_applyAssemblyChange`, or
`nuke_cad_applyDrawingChange`) only after explicit confirmation, and report undo availability from the apply result.
Sketch edits start with the read-only `nuke_cad_listSketchDimensions`, accept one to eight driving-dimension or
referenced-document-parameter changes on one sketch, and reject topology, selector-map, or region-coverage changes. CAD
previews are exposed only while `nukeCad.aiAuthoringEnabled` is on and require a saved document; a parameter-bound
dimension cascades to every affected sketch and curve, and the diff lists the parameter and its consumers.
Topology edits change existing hole blind/through mode or linear/circular pattern count. They run a real build and show
solid/face/triangle deltas, added/removed/changed solids, named regions, and whether the saved active OpenMC project
still references a changed or removed DAGMC group or material. Apply accepts only `{ "proposalId",
"acknowledgeRegionChanges": true }` and is blocked while a removed region is referenced; an unsaved OpenMC project is
reported as not checked and still requires the acknowledgement. Import edits use a user-chosen STEP/IGES/BREP source:
`nuke_cad_inspectImportSource` reports format, size, hash, units, and solids, and `nuke_cad_previewImportBodies` records
the one-body or per-solid plan without building geometry or showing a ghost. Apply re-inspects the same source, rejects
a stale hash, size, selection, or plan, and commits one `addImportBodies` with a backup and undo token. Assembly edits
start with `nuke_cad_summarizeAssembly` and change only existing grounded instances: add from an existing `body:<id>` or
reuse an existing instance part, remove a non-grounded connector-free embedded instance while keeping at least one, or
set pos/quat on a grounded or unmated instance. The preview runs a real candidate build and shows placement rows, the
BOM count delta, exact overlap warnings, and the `overlapCheck: false` disclosure; only a removal that loses the last
instance of a labeled embedded body requires region acknowledgement and can be blocked by a saved OpenMC reference.
Apply re-runs the planner, commits one store batch, and returns an undo token. Drawing edits start with
`nuke_cad_summarizeDrawing` and change only existing sheets, views, and dimensions: set the sheet size A4/A3, set a view
scale or hidden-line display, or hide a dimension. The preview is plan-only and shows sheet, view, and dimension
rows without a geometry build or ghost; A3 to A4 is rejected when a view lies outside A4. Apply re-runs the planner,
writes a backup, commits one `applyDrawingChanges` batch, refreshes the Drawing Sheet, returns an undo token, and never
schedules a geometry rebuild. Hidden dimensions stay listed but leave SVG/DXF, and the title block is fixed and
read-only. The **CAD Edit Review** panel renders the same pending proposal (feature, sketch, topology, import, assembly,
or drawing), invokes the same apply capability after confirmation, and keeps the returned undo token; it never writes
the document directly. The read-only Diagnostics agent never receives a
preview or apply tool; see [Safe Edits](../user/safe-edits.md) and
[CAD Feature, Sketch, Topology, Import, Assembly, and Drawing Authoring](../user/safe-edits.md#cad-feature-edits).

The agent receives the same active-workspace summary as `#nukeContext`. Missing documents, projects, or datasets are
reported as `none`; the agent must not invent model state.

## Diagnostics agent

`src/browser/agent/nuke-diagnostics-agent.ts` registers the read-only `Nuke Diagnostics` agent
(`NUKE_DIAGNOSTICS_AGENT_ID`). It is bound as both `Agent` and `ChatAgent`, uses the `chat` language-model purpose,
the `nuke-diagnostics-system` prompt set, `#nukeContext`, and a `functions` list of the six diagnostics tools plus
the read-only support tools:

- diagnostics: `nuke_cad_diagnoseModel`, `nuke_openmc_diagnoseProject`, `nuke_openmc_diagnoseRun`,
  `nuke_viz_diagnoseStatepoint`, `nuke_viz_compareStatepoints`, `nuke_viz_analyzeTallySeries`;
- support: `nuke_cad_summarizeDocument`, `nuke_cad_inspectSelection`, `nuke_openmc_summarizeProject`,
  `nuke_openmc_validateProject`, `nuke_openmc_getRunStatus`, `nuke_viz_summarizeStatepoint`.

The prompt forbids every write, execute, and destructive tool. It requires severity-ordered findings (`error`, then
`warning`, then `info`), tool-backed evidence for each finding, a separation between observation and hypothesis, and
at most three safe next steps. It also states that the statepoint diagnosis reads metadata only, that a tally series
reports aggregate step statistics only (no per-bin values for one file), and that a missing diagnostic tool must be
reported rather than simulated. Never add a state-changing tool to this agent; use the NukeAI agent and its
confirmation flow for those actions.

## Contextual actions

`src/browser/actions/nuke-ai-action-service.ts` owns two entry points:

- `ask(prompt, displayText, agentId = NUKE_CHAT_AGENT_ID)` creates or reuses a focused chat session pinned to the
  requested agent, falling back to the default NukeAI agent when the requested one is unavailable, attaches
  `nukeContext`, and sends the prompt with the short display text.
- `attachContext()` ensures an active session and executes the public `add-context-variable` command for
  `nukeContext`.

`src/browser/actions/nuke-ai-commands.ts` registers the Command Palette entries and
`src/browser/actions/nuke-ai-tools-contribution.ts` places them in the first Nuke Tools sidebar section, with the
four diagnostic commands under a `Diagnostics` subgroup. The actions are read-only, never import a domain extension,
and report failures through `MessageService` instead of failing silently.

## Tool result pipeline

A capability returns a `NukeCapabilityResult`. `nuke-tool-result.ts` converts it into bounded Theia
`ToolCallContent`:

1. A human-readable text block, plus an error block first when `ok` is false.
2. Optional image or HTML preview blocks with a caption block.
3. A compact JSON block with `{ ok, data, warnings, changeSet, undoToken, nextActions, handle, artifacts }`.
4. One artifact line per path or URI.

The result content is bounded: strings are capped at 8 KiB, the JSON payload at 32 KiB, and inline base64 data is
omitted from text. A `changeSet` is bounded field by field: every id, title, summary, label, path, and capability id is
truncated like other strings, and each before/after value passes through the same value truncation as `data`, so a
diff can never inline base64. `undoToken` is a short opaque string and is emitted only when the capability returns one.
`nuke-tool-call-summary.ts` parses that content without trusting it. It accepts `undefined`, a string, a plain
object, or `ToolCallContent`; malformed JSON stays visible as text; images become data URLs; error and HTML blocks are
collected separately; and every field is optional. A malformed change set (missing changes, a non-array, or rows
without a path) is dropped instead of rendered, and an empty or non-string `undoToken` is ignored.

## Renderer and card contract

`nuke-tool-call-renderer.tsx` implements `ChatResponsePartRenderer<ToolCallChatResponseContent>` and is bound to
`ChatResponsePartRenderer` in the frontend module. It parses the summary, issues, status, and details, owns artifact
opening through the opener service, and passes those values to `NukeToolCard`.

`nuke-tool-call-card.tsx` is the pure presentational card. It imports only React and the summary helpers, so
`nuke-tool-call-card.test.tsx` renders it with `renderToStaticMarkup` in a plain Node test without booting Theia or a
DOM. Its `canHandleNukeToolCall` rule is intentionally narrow:

- return `30` only for a `ToolCallChatResponseContent` whose `name` starts with `nuke_`, whose `finished` flag is true,
  and whose `isAwaitingUserConfirmation` flag is false;
- return `-1` for every other state, including running calls and calls waiting for Allow/Deny.

Returning `-1` is what preserves Theia's progress and confirmation UI. Never claim an unfinished or waiting call just
because it has a partial result.

## Executable next actions

`nuke-next-action-service.ts` turns the next actions in a finished card into buttons:

- `canRunDirectly(capabilityId)` is true only when the capability exists and its `risk` is `read`.
- A direct run reads the current capability context, honors the capability's `when` predicate, validates the empty
  input with `validateCapabilityInput`, invokes `capability.invoke({}, context)`, and replaces the card result with
  `response.updateResult(result)`. Duplicate concurrent runs of the same capability are ignored.
- A missing capability, an unavailable `when`, or missing required inputs never invokes the capability. Missing
  capabilities and unavailable context warn; missing inputs open a chat prompt that asks NukeAI to collect them.
- A write, execute, or destructive capability is never invoked from the card. `ask` sends a short prompt through
  `NukeAiActionService.ask` with the display text `Run next action`. The prompt tells NukeAI to inspect current state
  (`#nukeContext`), never invent state, use the sanitized tool name, and ask for confirmation before any state-changing
  tool. The normal Theia confirmation flow remains in charge.
- Invocation failures are logged and reported as `NukeAI could not run ...` without changing the card result.

`applyChangeSet(changeSet)` handles the preview → apply handoff. It requires a non-empty `applyCapability` that exists
in the registry and has `write` or `execute` risk; a missing, unknown, or weaker capability warns and does nothing.
Otherwise it sends a prompt through `NukeAiActionService.ask` with the display text `Apply settings changes`. The
prompt names the proposal id, summary, and capability (both the id and sanitized tool name) and the changed paths,
requires a fresh preview and a shown diff, and asks for confirmation before applying. The card never invokes the apply
capability itself.

`undo(token, response)` is the only path that calls `NukeUndoService.undo`. It first shows `MessageService.warn` with
an `Undo` action and awaits the choice; cancelling returns without touching state. On confirmation it calls the undo
service and replaces the card through `response.updateResult(result)` only when the result has `ok: true`. A failed
undo result is reported through the message service and keeps the card unchanged; a thrown error is logged and
reported, and the method never rejects. A duplicate concurrent undo of the same token is ignored.

## Card anatomy

Each card contains, in order:

- a header with a codicon, the short tool label from `toolLabel`, and a `Done`, `Warning`, or `Failed` badge;
- the human-readable message;
- a two-column summary grid built from `summaryEntries` (CAD counts, OpenMC validation counters, run status,
  statepoint k-eff and batches, then generic primitive fields);
- an issues list from `data.issues`, with severity, category, and suggested fix;
- a **Changes** section for `summary.changeSet`: the proposal title and summary, then one row per change with its label,
  path, and before → after value; a `changeSet` without an apply capability (already applied) shows only **Undo**;
- **Apply with NukeAI** only when `changeSet.applyCapability` is present, and **Undo** when `summary.undoToken` is
  present; both are disabled when their callback is missing, and an undo token without a change set renders a
  standalone **Undo** section;
- error and warning lists;
- image previews as `<img src="data:...">` figures, never raw base64 text;
- HTML previews in `<iframe sandbox="" srcDoc={...} title={...}>`;
- artifact buttons wired to the renderer, which opens a path through `URI.fromFilePath` or a URI through the opener service;
- one button per next action: `Run` for read-only capabilities and `Ask NukeAI` for every other risk, with the action
  label and reason visible beside it;
- a bounded `<details>` block with the parsed arguments and normalized result (20 KiB maximum).

Status is derived from the result, not the badge alone: `ok: false`, an error block, or an error-severity issue marks
the card `Failed`; warnings or warning-severity issues mark it `Warning`; everything else is `Done`.

The card never uses native `title` attributes for hints. Use visible labels or the shared nuke-essentials `Tooltip`
component when a new hover hint is needed.

## Styling

`nuke-tool-call.css` is copied to `lib/` by the extension's `copy-css` step and imported from the frontend module. The
card:

- uses Theia theme variables with fallbacks: `--theia-editorWidget-background`, `--theia-editorWidget-border`,
  `--theia-foreground`, `--theia-descriptionForeground`, `--theia-focusBorder`, `--theia-successForeground`,
  `--theia-warningForeground`, and `--theia-errorForeground`;
- sets `container-type: inline-size` and switches the summary grid to one column at `@container (max-width: 420px)`;
- draws the change diff as a bordered list, stacks each row from two columns to one at the same container width, and
  colors the before value with `--theia-errorForeground` and the after value with `--theia-successForeground`;
- keeps artifact targets truncated with a leading ellipsis while preserving the full path in the parsed data and
  raw details.

No UI screenshot is attached to this page.
