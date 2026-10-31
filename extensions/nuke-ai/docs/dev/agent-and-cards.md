# NukeAI Agent and Tool Result Cards

This page describes the NukeAI chat agent, the contextual action service, and the compact cards that replace raw JSON
for finished Nuke capability calls.

## Agent contract

`src/browser/agent/nuke-chat-agent.ts` registers the `NukeAI` agent (`NUKE_CHAT_AGENT_ID`). The agent:

- extends `AbstractStreamParsingChatAgent` and is bound as both `Agent` and `ChatAgent`;
- uses the `chat` language-model purpose and the `nuke-system` prompt;
- declares `nuke.context` and the eleven capability tool names in its `functions` list;
- references every capability tool through `~{toolName}` in the prompt, where `toolName` is the sanitized name
  registered by the bridge (for example `nuke_cad_summarizeDocument`), not the capability id, so the model receives
  the typed tools without a separate registration step.

The system prompt introduces the CAD → DAGMC → OpenMC → statepoint workflow, lists read-only tools first, and tells
the model to ask before a write, execute, or destructive tool. Export, import, run, and viewer-open tools keep their
Theia confirmation requirement. Never add a write or execute tool to the prompt without a matching confirmation path.

The agent receives the same active-workspace summary as `#nukeContext`. Missing documents, projects, or datasets are
reported as `none`; the agent must not invent model state.

## Contextual actions

`src/browser/actions/nuke-ai-action-service.ts` owns two entry points:

- `ask(prompt, displayText)` creates or reuses a focused chat session pinned to the NukeAI agent, attaches
  `nukeContext`, and sends the prompt with the short display text.
- `attachContext()` ensures an active session and executes the public `add-context-variable` command for
  `nukeContext`.

`src/browser/actions/nuke-ai-commands.ts` registers the Command Palette entries and
`src/browser/actions/nuke-ai-tools-contribution.ts` places them in the first Nuke Tools sidebar section. The actions
are read-only, never import a domain extension, and report failures through `MessageService` instead of failing
silently.

## Tool result pipeline

A capability returns a `NukeCapabilityResult`. `nuke-tool-result.ts` converts it into bounded Theia
`ToolCallContent`:

1. A human-readable text block, plus an error block first when `ok` is false.
2. Optional image or HTML preview blocks with a caption block.
3. A compact JSON block with `{ ok, data, warnings, nextActions, handle, artifacts }`.
4. One artifact line per path or URI.

The result content is bounded: strings are capped at 8 KiB, the JSON payload at 32 KiB, and inline base64 data is
omitted from text. `nuke-tool-call-summary.ts` parses that content without trusting it. It accepts `undefined`, a
string, a plain object, or `ToolCallContent`; malformed JSON stays visible as text; images become data URLs; error and
HTML blocks are collected separately; and every field is optional.

## Renderer contract

`nuke-tool-call-renderer.tsx` implements `ChatResponsePartRenderer<ToolCallChatResponseContent>` and is bound to
`ChatResponsePartRenderer` in the frontend module. Its `canHandle` rule is intentionally narrow:

- return `30` only for a `ToolCallChatResponseContent` whose `name` starts with `nuke_`, whose `finished` flag is true,
  and whose `isAwaitingUserConfirmation` flag is false;
- return `-1` for every other state, including running calls and calls waiting for Allow/Deny.

Returning `-1` is what preserves Theia's progress and confirmation UI. Never claim an unfinished or waiting call just
because it has a partial result.

## Card anatomy

Each card contains, in order:

- a header with a codicon, the short tool label from `toolLabel`, and a `Done`, `Warning`, or `Failed` badge;
- the human-readable message;
- a two-column summary grid built from `summaryEntries` (CAD counts, OpenMC validation counters, run status,
  statepoint k-eff and batches, then generic primitive fields);
- an issues list from `data.issues`, with severity, category, and suggested fix;
- error and warning lists;
- image previews as `<img src="data:...">` figures, never raw base64 text;
- HTML previews in `<iframe sandbox="" srcDoc={...} title={...}>`;
- artifact buttons that open a path through `URI.fromFilePath` or a URI through the opener service;
- textual next actions — cards never execute a capability;
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
- keeps artifact targets truncated with a leading ellipsis while preserving the full path in the parsed data and
  raw details.

No UI screenshot is attached to this page.
