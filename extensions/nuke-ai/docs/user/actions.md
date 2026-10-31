# NukeAI Actions

NukeAI is available where you work: as a dedicated chat agent, as a section in the Nuke Tools sidebar, and as
commands in the Command Palette. The actions open a focused chat and send a short, read-only request with your active
workspace context attached.

## Open the actions

Open the **Nuke Tools** view from the activity bar (the tools icon), or run **Nuke: Focus Tools Sidebar** from the
Command Palette. The **NukeAI** section is the first section in the sidebar.

| Action                    | What it asks NukeAI to do                                                          |
| ------------------------- | ---------------------------------------------------------------------------------- |
| Ask About Active Context  | Explain what the active CAD document, OpenMC project, and dataset let you do next. |
| Attach Active Context     | Add the `#nukeContext` chip to the active chat.                                    |
| Check Active CAD Model    | Summarize the active CAD document, including counts, selection, and warnings.      |
| Explain CAD Selection     | Explain the selected solid or solids and any hidden solids.                        |
| Validate OpenMC Project   | Validate the active OpenMC project and group issues by severity.                   |
| Explain OpenMC Run        | Summarize the active run status and the recent log tail.                           |
| Explain Active Statepoint | Explain k-effective, batches, tallies, and uncertainty in the active dataset.      |
| Capture DAGMC View        | Capture the active DAGMC viewport and describe the preview.                        |

Every action is also available in the Command Palette under the `NukeAI:` prefix. The command-palette label names the
action, and the chat transcript shows the shorter action label.

## Tool names

Each capability is registered in the chat under a sanitized tool name. For example, **Check Active CAD Model** calls
`nuke_cad_summarizeDocument`, and **Validate OpenMC Project** calls `nuke_openmc_validateProject`. Capability ids stay
the stable identifiers for extension authors: `nuke.cad.summarizeDocument` is exposed as
`nuke_cad_summarizeDocument`, and the remaining ids replace dots with underscores in the same way.

## Read-only by default

The eight actions only read state. They do not move geometry, edit an OpenMC project, open viewers, start or cancel
runs, or write files. If a tool cannot see the required state, NukeAI reports what is missing instead of inventing a
path or a result.

Write and execute capabilities still exist in the agent. Exporting DAGMC, importing geometry, running OpenMC, and
opening a statepoint viewer require explicit confirmation in the conversation. The sidebar actions never confirm those
operations for you.

## The NukeAI agent

The NukeAI agent is pinned automatically when you use an action. To start a chat yourself, open **AI Chat** and choose
**NukeAI** as the agent, or mention it in the request. The agent knows the CAD → DAGMC → OpenMC → statepoint workflow
and uses the capability tools published by the domain extensions.

The agent receives the same active-workspace summary as the context chip. The summary lists the active CAD document,
OpenMC project, dataset, and workspace roots; missing entries appear as `none`.

## The context chip

**NukeAI: Attach Active Context** creates a focused chat session when none exists, then adds `#nukeContext` to it. The
chip keeps the active paths attached to your next request, so you can ask follow-up questions without restating the
document or project. Any action that sends a request includes the same context automatically.

## External MCP

The **External MCP** subsection starts and stops the opt-in MCP endpoint for external clients. See
[MCP Clients](mcp-clients.md) for the endpoint configuration and security notes.

## Requirements

- CAD actions need an open `.nuke-cad` document or an equivalent active CAD model.
- OpenMC actions need an active OpenMC Studio project; run-status questions also need a run directory.
- Statepoint and capture actions need a loaded dataset or an open DAGMC viewer.
- NukeAI needs a configured chat language model. Without one, the chat opens but the request reports that no model is
  available.

For the tool contract, see [Architecture](../dev/architecture.md) and [Adding a Capability](../dev/adding-a-capability.md).
