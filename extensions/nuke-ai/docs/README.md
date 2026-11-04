# Nuke AI Documentation

Welcome to the `nuke-ai` documentation. This extension hosts NukeIDE's AI runtime integration. It exposes capabilities published by domain extensions to the IDE's AI chat as typed tools.

## 📖 Choose Your Path

### 👤 I want to use the extension

→ Start with [**User Documentation**](user/getting-started.md)

The AI chat and capability tools become useful as domain extensions publish capabilities such as CAD export or OpenMC project queries.

→ Read [**NukeAI Actions**](user/actions.md) for the dedicated agent, the context-aware sidebar and domain-menu actions, and the `#nukeContext` chip.

→ Read [**Nuke Diagnostics**](user/diagnostics.md) for the read-only diagnostics agent and the CAD, OpenMC project/run, and statepoint diagnostic actions.

→ Read [**Safe Edits**](user/safe-edits.md) for previewing settings, material, tally, CSG, DAGMC, and CAD feature diffs, applying them with confirmation, and undoing them in-session.

→ Read [**Preview Gallery**](user/previews.md) for the saved preview history and the read-only gallery.

→ Read [**Local Audit Logs**](user/audit.md) for the local tool metrics and applied-edit journals, how to view or delete
them, and the session-scoped undo lifetime.

→ Read [**External MCP Clients**](user/mcp-clients.md) to connect an external MCP client to the opt-in, read-only endpoint.

### 🛠️ I want to develop or extend it

→ Start with [**Developer Documentation**](dev/architecture.md)

Covers the in-process capability-to-tool flow, tool naming, schema and result conversion, refresh behavior, and result limits.

→ Read [**Agent and Tool Result Cards**](dev/agent-and-cards.md) for the NukeAI agent prompt contract, contextual actions, and the compact renderer for finished tool calls.

→ Read [**Skills**](dev/skills.md) for the packaged `SKILL.md` layout, frontmatter rules, and Theia slash commands.

→ Read [**Context and Resources**](dev/context-and-resources.md) for `#nukeContext`, the read-only `nuke://` resources, and their scoping rules.

→ Read [**External MCP**](dev/mcp.md) for the opt-in, token-protected MCP endpoint, its auth flow, and the read-only catalog.

→ Read [**Previews and Trajectory**](dev/preview.md) for truthful preview rendering and the persisted command-to-preview history.

→ Read [**Local Metrics and the Edit Journal**](dev/metrics.md) for the local `metrics.jsonl` and `edits.jsonl` schemas,
rotation, privacy rules, and the undo persistence decision.

→ Read [**Adding a Capability**](dev/adding-a-capability.md) to make a domain action available to the AI chat.

→ Read [**CAD Authoring Design**](dev/cad-authoring-design.md) for the shipped eight-slice authoring contract, its
threat model, and the security boundaries that remain out of scope.

---

## Quick Overview

| Area               | What It Does                                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NukeAI agent       | Dedicated `NukeAI` chat agent for the CAD → DAGMC → OpenMC → statepoint workflow                                                                                                        |
| Diagnostics agent  | Read-only `Nuke Diagnostics` agent for CAD, OpenMC project/run, and statepoint triage                                                                                                   |
| Context actions    | Read-only Nuke Tools sidebar commands that open a focused chat with `#nukeContext`                                                                                                      |
| Capability bridge  | Turns every enabled `NukeCapability` into a Theia AI tool                                                                                                                               |
| Schema mapping     | Converts capability JSON Schema into `ToolRequestParameters`                                                                                                                            |
| Result mapping     | Renders structured results as bounded text, errors, previews, and artifact lines                                                                                                        |
| Result cards       | Finished Nuke tool calls render as status cards with counts, warnings, and previews                                                                                                     |
| Safe edits         | Preview a diff or plan, apply with confirmation, and undo OpenMC, CAD feature, sketch, topology, import, assembly, drawing, component-creation, and Linux-only sandboxed script changes |
| Preview history    | Persists truthful previews and a reviewable command-to-preview trajectory                                                                                                               |
| Preview gallery    | Read-only, newest-first browser for saved NukeAI preview bundles                                                                                                                        |
| Capability catalog | Read-only list of enabled capabilities with id, risk, version, tags, and availability                                                                                                   |
| Local audit        | Local metrics and applied-edit journals under `.nuke-ide/ai`; nothing is uploaded                                                                                                       |
| Refresh            | Rebuilds the tool set when capabilities or ambient context change                                                                                                                       |
| Skills             | Ships domain guidance as plugin-tier `SKILL.md` slash commands                                                                                                                          |
| Context            | `#nukeContext` carries the active CAD document, OpenMC project, dataset, and roots                                                                                                      |
| Resources          | Read-only `nuke://` summaries backed by the capability registry                                                                                                                         |
| External MCP       | Opt-in, token-protected, loopback-only read-only endpoint on the external API                                                                                                           |
| Transport          | In-process for the chat; external MCP is a separate opt-in surface                                                                                                                      |

---

## Related Documentation

- [**Nuke Core Documentation**](../../nuke-core/docs/README.md) — the capability contract and registry
- [**Capability Registry**](../../nuke-core/docs/dev/capability-registry.md) — registration, validation, versioning, risk, and context contributions
