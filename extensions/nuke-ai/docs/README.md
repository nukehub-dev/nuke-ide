# Nuke AI Documentation

Welcome to the `nuke-ai` documentation. This extension hosts NukeIDE's AI runtime integration. It exposes capabilities published by domain extensions to the IDE's AI chat as typed tools.

## 📖 Choose Your Path

### 👤 I want to use the extension

→ Start with [**User Documentation**](user/getting-started.md)

The AI chat and capability tools become useful as domain extensions publish capabilities such as CAD export or OpenMC project queries.

### 🛠️ I want to develop or extend it

→ Start with [**Developer Documentation**](dev/architecture.md)

Covers the in-process capability-to-tool flow, tool naming, schema and result conversion, refresh behavior, and result limits.

→ Read [**Skills**](dev/skills.md) for the packaged `SKILL.md` layout, frontmatter rules, and Theia slash commands.

→ Read [**Context and Resources**](dev/context-and-resources.md) for `#nukeContext`, the read-only `nuke://` resources, and their scoping rules.

→ Read [**Previews and Trajectory**](dev/preview.md) for truthful preview rendering and the persisted command-to-preview history.

→ Read [**Adding a Capability**](dev/adding-a-capability.md) to make a domain action available to the AI chat.

---

## Quick Overview

| Area              | What It Does                                                                       |
| ----------------- | ---------------------------------------------------------------------------------- |
| Capability bridge | Turns every enabled `NukeCapability` into a Theia AI tool                          |
| Schema mapping    | Converts capability JSON Schema into `ToolRequestParameters`                       |
| Result mapping    | Renders structured results as bounded text, errors, previews, and artifact lines   |
| Preview history   | Persists truthful previews and a replayable command-to-preview trajectory          |
| Refresh           | Rebuilds the tool set when capabilities or ambient context change                  |
| Skills            | Ships domain guidance as plugin-tier `SKILL.md` slash commands                     |
| Context           | `#nukeContext` carries the active CAD document, OpenMC project, dataset, and roots |
| Resources         | Read-only `nuke://` summaries backed by the capability registry                    |
| Transport         | In-process only; the AI chat never calls the IDE backend over HTTP to reach a tool |

---

## Related Documentation

- [**Nuke Core Documentation**](../../nuke-core/docs/README.md) — the capability contract and registry
- [**Capability Registry**](../../nuke-core/docs/dev/capability-registry.md) — registration, validation, risk, and context contributions
