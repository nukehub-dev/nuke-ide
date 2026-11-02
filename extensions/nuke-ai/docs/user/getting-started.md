# Getting Started

`nuke-ai` connects the IDE's AI chat to actions that domain extensions publish through the Nuke capability registry. Each enabled capability appears as a typed tool, so the assistant can call real extension services instead of driving the UI.

The extension's actions live in the first section of the Nuke Tools sidebar and in the Command Palette, its tools become visible as domain extensions adopt the capability contract, and **NukeAI: Open Preview Gallery** opens the read-only preview gallery in the main area. Its skills appear as chat slash commands.

Choose the **NukeAI** agent in **AI Chat** for a dedicated assistant, or use the sidebar actions to ask a focused
read-only question about the active model. **NukeAI: Attach Active Context** adds the `#nukeContext` chip to the
active chat. See [NukeAI Actions](actions.md) for the full action list and the read-only guarantee.

## Quick start and model setup

With no chat session open, the AI Chat welcome screen shows a **NukeAI quick start** section. NukeAI is preselected as
the default chat agent when no default has been chosen; if the default-agent picker appears, choose **NukeAI** or
**Nuke Diagnostics** there. Its five buttons run read-only requests with your active workspace context attached:

- **Ask About Active Context** summarizes what the active CAD document, OpenMC project, and dataset make possible.
- **Check Active CAD Model** reports build status, counts, selection, and warnings.
- **Diagnose OpenMC Project** triages validation, environment readiness, and cross-section state.
- **Review OpenMC Settings** shows the current run settings and previews a proposed change before anything is applied.
- **Diagnose Active Statepoint** checks k-effective uncertainty, batches, and tally coverage.

If no language model is ready, the section shows a **Choose a model** card with an **Open AI Settings** button. Add a
provider and API key there, then return to the chat. The card disappears once a model is ready. NukeAI never ships a
provider key of its own.

The NukeAI bot above the model configuration and quick-start sections follows the pointer, blinks, and tilts its head.
It is decorative, and its autonomous motion stops when your system requests reduced motion.

## Chat basics

- NukeAI is the default agent. Mention `@NukeAI` or `@Nuke Diagnostics` to switch; `@Coder`, `@Architect`, and
  `@Universal` remain available.
- Attach context with `#file`, `#_f` (the active file), `#selectedText`, or the `#nukeContext` chip.
- Press Up in an empty chat input to reopen recent history.
- Choose a language model in the chat input selector or in AI Settings; NukeAI never ships a provider key. Each
  agent has its own default, so assign one to **Nuke Diagnostics** as well.
- The IDE asks before running a tool until you approve it or mark it **Always allow**. Read-only tools follow that
  preference; write and execute tools never inherit a global always-allow, and destructive tools add a warning.

## Using capability tools

Once a domain capability is available, open the AI chat and ask about the active CAD document, OpenMC project, or visualizer dataset. The assistant chooses a capability tool from its description and asks for confirmation according to the action's risk. Tools use sanitized names: the capability id `nuke.cad.summarizeDocument`, for example, is exposed as `nuke_cad_summarizeDocument`.

- Read-only tools follow the IDE's confirmation preference and can be marked **Always allow**.
- Write and execute tools never inherit a global always-allow; approve each tool explicitly.
- Destructive tools add a warning that data can be overwritten or deleted.

Tool results include a short message, bounded structured JSON, and file or URI lines for artifacts. Large logs are truncated; inline base64 payloads are omitted.

When a tool can show a preview, the chat renders it next to the result with a caption, its limitations, and a marker
when the image is approximate. Previews produced by tools, including the DAGMC viewport capture, are also recorded
under the workspace at `.nuke-ide/ai/previews/` so the command-to-preview history can be replayed. See
[Previews and the Gallery](previews.md) for the folder layout and the read-only gallery; the IDE recreates the folder
on the next capture.

### CAD feature edits

CAD authoring is opt-in. Enable **Nuke CAD: AI Authoring** in **Settings → Nuke CAD** first. NukeAI can then propose
scalar changes to an existing feature on a saved `.nuke-cad` document: pad/pocket length, revolve/groove angle, fillet
radius, chamfer distance, draft angle, pattern spacing/angle, shell thickness, and blind-hole diameter/depth. It
previews every change with a real build, shows the diff and impact (solid/face/triangle counts and bounding box), and
applies only the returned proposal after explicit confirmation. Apply writes a hidden backup beside the document,
schedules the normal rebuild, and offers **Undo** in the chat.

Sketch dimensions use a second flow on the same saved document. NukeAI lists the sketch dimensions and document
parameters first, then previews one to eight edits to existing driving dimensions or to document parameters that a
sketch or parametric curve references. A literal dimension changes only its sketch; a parameter-bound dimension
cascades to every sketch and curve that references the parameter, and the diff names the parameter and all affected
dimensions. Reference dimensions, missing sketches or parameters, unchanged values, and conflicting solves are
rejected. New sketch entities, free-form sketch creation, unreferenced document parameters, partial or unsandboxed
scripts, booleans, body/feature add/delete/reorder, and lattices are not editable in this mode. Drawing sheets and Python
scripts have their own flows below.

Topology-impact edits are the third flow. NukeAI can switch an existing hole between blind and through, or change the
count of an existing linear or circular pattern. The preview builds the change and reports solid/face/triangle deltas,
added/removed/changed solids, named regions, and whether the saved active OpenMC project still references a changed or
removed DAGMC group or material. The **CAD Edit Review** panel shows a **Region impact** section and requires an
acknowledgement before **Apply** is enabled; a removed region still referenced by OpenMC blocks Apply. An unsaved project
is reported as not checked and still requires the acknowledgement. Apply never rewrites the OpenMC project.

A successful preview also opens the **CAD Edit Review** panel and shows the candidate geometry as a translucent ghost
in the viewport; changed solids use a warmer accent. Apply, Dismiss, and Undo are available there as well as in the
chat card. Apply commits the parameter and all affected sketches atomically. The scalar and sketch previews reject any
edit that changes the solid count, selector map, or region-manifest coverage; the topology flow reports those changes
instead of claiming they are safe.

Import CAD as Body is the fourth flow. NukeAI inspects a STEP/STP, IGES/IGS, or BREP file that you choose in the native
picker, reports its format, size, hash, units, and solids, and plans either one body for the selected solids or one body
per solid. The plan also takes a body label, an optional source-unit override, and an optional material tag. The plan is
read-only: it opens the **CAD Edit Review** panel but builds no geometry and shows no ghost. Apply re-inspects the same
source, rejects a stale hash, size, selection, or plan, writes a hidden backup, adds the bodies in one commit,
rebuilds, and offers **Undo**. A source inside the document folder keeps the document self-contained; a source
elsewhere is referenced in place, and NukeAI warns about it. The AI flow never downloads or copies a source and never
accepts a path outside the workspace roots.

Assembly placement is the fifth flow, for an existing grounded assembly only. NukeAI lists the instances, part sources,
placements, grounding, selector ids, BOM quantities, and overlap policy first. It can add an instance from an existing
body or reuse an existing part, remove a non-grounded embedded instance that has no connector or mate while keeping
at least one instance, or set the position and orientation of a grounded or unmated instance. The preview runs a real
candidate build and shows placement rows, the BOM count delta, exact overlap warnings, and whether `overlapCheck: false`
disables overlap checks. Only removing the last instance of a labeled embedded body requires a region acknowledgement;
a saved OpenMC reference to the removed group or material blocks Apply. Apply commits one assembly batch, rebuilds, and
offers **Undo**. NukeAI does not create an assembly from a single part, change grounding, edit mates or connectors, add a
new external source, replace a part, change an existing instance's scale, or rename an instance.

Drawing sheet settings are the sixth flow, for a document that already contains a drawing sheet. NukeAI reports every
sheet's size and views, each view's scale and hidden-line setting, and each dimension's visibility. It can switch an
existing sheet between A4 and A3, change a view's scale or hidden lines, or hide a dimension. A3 to A4 is refused when a
view would fall outside A4, and views are never moved. Hiding is presentation-only: the dimension stays in the list but
leaves SVG and DXF output. The title block is fixed and read-only. The preview is plan-only — no geometry build and no
ghost — and apply commits one drawing batch, opens and refreshes the Drawing Sheet, and offers **Undo** without
rebuilding geometry.

Python model scripts are the seventh flow, available only on Linux with bubblewrap. Enable both **Nuke CAD: AI
Authoring** and the workspace **Nuke CAD: Script Authoring** setting, then open a saved `.py` model. NukeAI can inspect
the script, but its text is sent to the configured model provider. A preview runs the complete replacement in a sandbox
with no network and no workspace access, then shows a plain-text unified diff, imports, sandbox limits, build counts, and
an audit id in the **CAD Edit Review** panel; it writes nothing and shows no ghost. The chat card has no Apply action.
Apply is panel-only: it confirms the overwrite, keeps a hidden backup, rebuilds in the sandbox, and offers **Undo**.
Later rebuilds of that model stay sandboxed and DAGMC/FEM export stays blocked. The sandbox has no seccomp filter, so it
is not a guarantee against kernel bugs.

## Preview gallery

Run **NukeAI: Open Preview Gallery** from the Command Palette to browse the saved previews. The gallery lists bundles
newest first, shows the capability and capture time behind each card, and opens the preview image or its result
snapshot when you click a card. It is read-only: there is no delete or regenerate control. To clear the history,
delete `.nuke-ide/ai/previews` in the file explorer. See [Previews and the Gallery](previews.md).

## Domain skills

NukeAI ships five skills that load only when a task needs them:

- `/nuke-cad` — summarize, inspect, and export the active CAD document to DAGMC, preview/apply feature, sketch, topology, import, assembly-placement, or drawing-settings edits, and guide Linux sandboxed Python script review.
- `/openmc-studio` — summarize, validate, import CAD, run, and poll an OpenMC project.
- `/nuke-visualizer` — summarize or open a statepoint and capture a DAGMC viewport.
- `/nuke-workflow` — the end-to-end CAD → DAGMC → OpenMC → statepoint → capture handoff.
- `/nuke-diagnostics` — triage the active CAD model, OpenMC project or run, and loaded statepoint read-only.

Type the slash command in the chat, or open **Generic Capabilities → Skills** in the chat input. The skills only
describe existing tools; write and execute tools still ask for confirmation.

## Active workspace context

Attach `#nukeContext` to a request to include the active CAD document, OpenMC project, dataset, and workspace
roots. Missing fields appear as `none`; if the context cannot be collected, the variable resolves to
`context unavailable` instead of failing the request.

## External MCP clients

The command **NukeAI: Enable MCP Endpoint** starts a token-protected MCP server on `127.0.0.1`, and
**NukeAI: Disable MCP Endpoint** stops it and removes the token. The endpoint exposes a live, read-only catalog of
CAD, OpenMC, and Visualizer tools plus context resources and workflow/diagnostics prompts. See
[External MCP Clients](mcp-clients.md) for the client configuration and security notes.

## Troubleshooting

If a capability does not appear in the chat:

1. Confirm the owning extension's frontend module registered it with `NukeCapabilityRegistry`.
2. Confirm its optional `when` predicate is satisfied by the current workspace or active document/project.
3. Reload the IDE after installing an extension that adds capabilities.

For the developer contract, see [Architecture](../dev/architecture.md), [Adding a Capability](../dev/adding-a-capability.md),
[Skills](../dev/skills.md), [Context and Resources](../dev/context-and-resources.md), and [External MCP](../dev/mcp.md).
For external clients, see [MCP Clients](mcp-clients.md).
