# Getting Started

`nuke-ai` connects the IDE's AI chat to actions that domain extensions publish through the Nuke capability registry. Each enabled capability appears as a typed tool, so the assistant can call real extension services instead of driving the UI.

The extension has no dedicated panel of its own. Its actions live in the first section of the Nuke Tools sidebar and in the Command Palette, and its tools become visible as domain extensions adopt the capability contract. Its skills appear as chat slash commands.

Choose the **NukeAI** agent in **AI Chat** for a dedicated assistant, or use the sidebar actions to ask a focused
read-only question about the active model. **NukeAI: Attach Active Context** adds the `#nukeContext` chip to the
active chat. See [NukeAI Actions](actions.md) for the full action list and the read-only guarantee.

## Using capability tools

Once a domain capability is available, open the AI chat and ask about the active CAD document, OpenMC project, or visualizer dataset. The assistant chooses a capability tool from its description and asks for confirmation according to the action's risk. Tools use sanitized names: the capability id `nuke.cad.summarizeDocument`, for example, is exposed as `nuke_cad_summarizeDocument`.

- Read-only tools run without an extra always-allow confirmation.
- Write and execute tools ask for confirmation before auto-approval.
- Destructive tools add a warning that data can be overwritten or deleted.

Tool results include a short message, bounded structured JSON, and file or URI lines for artifacts. Large logs are truncated; inline base64 payloads are omitted.

When a tool can show a preview, the chat renders it next to the result with a caption, its limitations, and a marker
when the image is approximate. Previews produced by tools, including the DAGMC viewport capture, are also recorded
under the workspace at `.nuke-ide/ai/previews/` so the command-to-preview history can be replayed. Open that folder in
the file explorer to inspect or delete old previews; the IDE recreates it on the next capture.

## Domain skills

NukeAI ships five skills that load only when a task needs them:

- `/nuke-cad` — summarize, inspect, and export the active CAD document to DAGMC.
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
**NukeAI: Disable MCP Endpoint** stops it and removes the token. The endpoint exposes a read-only CAD summary,
context resources, and a workflow prompt. See [External MCP Clients](mcp-clients.md) for the client configuration and
security notes.

## Troubleshooting

If a capability does not appear in the chat:

1. Confirm the owning extension's frontend module registered it with `NukeCapabilityRegistry`.
2. Confirm its optional `when` predicate is satisfied by the current workspace or active document/project.
3. Reload the IDE after installing an extension that adds capabilities.

For the developer contract, see [Architecture](../dev/architecture.md), [Adding a Capability](../dev/adding-a-capability.md),
[Skills](../dev/skills.md), [Context and Resources](../dev/context-and-resources.md), and [External MCP](../dev/mcp.md).
For external clients, see [MCP Clients](mcp-clients.md).
