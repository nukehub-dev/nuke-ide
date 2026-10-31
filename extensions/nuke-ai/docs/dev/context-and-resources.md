# Context and Resources

NukeAI keeps the always-on prompt small by exposing the active workspace as a chat variable and project summaries
as read-only resources. Both surfaces read the same ambient context that feeds capability `when` predicates.

## Context contributions

Domain extensions contribute `NukeCapabilityContextContribution`s. `NukeCapabilityContextService` (owned by
`nuke-core`) merges their partial snapshots with the current workspace roots and emits one debounced change event.
The available fields are:

- `workspaceRoots` — absolute roots of the open workspace.
- `activeCadDocument` — path of the active NukeCAD document.
- `activeOpenmcProject` — path of the active OpenMC Studio project.
- `activeDataset` — path of the statepoint loaded in the visualizer.

NukeAI must not import a domain extension to read these values. It injects `NukeCapabilityContextService` and reads
the merged snapshot.

## `#nukeContext`

`NukeContextVariableContribution` registers the `nuke.context` variable as `#nukeContext`. It resolves to this
exact Markdown block:

```text
Active CAD document: <path or none>
Active OpenMC project: <path or none>
Active dataset: <path or none>
Workspace roots:
- <root>
```

- Missing fields and an empty root list render as `none`.
- An absolute path outside every workspace root is rendered as `none`, so the variable never leaks an external
  path.
- If context collection fails, the value is exactly `context unavailable`; resolution never throws.

`canResolve` returns `100` for `nukeContext` and `0` for other variables. The contribution is bound to
`AIVariableContribution`; `@theia/ai-core` owns the contribution provider.

## Resource URIs

`NukeResourceService` exposes descriptors with `uri`, `name`, `description`, `mimeType`, and `read()`:

| URI                         | Condition                    | Source                                           |
| --------------------------- | ---------------------------- | ------------------------------------------------ |
| `nuke://context`            | Always                       | `NukeCapabilityContextService.getContext()` JSON |
| `nuke://cad/document`       | Active CAD document          | `nuke.cad.summarizeDocument` with `{}`           |
| `nuke://openmc/project`     | Active OpenMC project        | `nuke.openmc.summarizeProject` with `{}`         |
| `nuke://visualizer/dataset` | Active visualizer dataset    | `nuke.viz.summarizeStatepoint` with `{}`         |
| `nuke://skills/<name>`      | Skill root contains `<name>` | `SKILL.md` under the backend skill root          |

`getResources()` lists only descriptors whose condition is currently satisfied. It checks both the active context
field and the enabled state of the backing capability through `NukeCapabilityRegistry.get(id)` and
`getEnabled(context)`, so a missing or disabled capability hides its resource. `read(uri)` resolves on demand.

Capability summaries are rendered as pretty-printed JSON from the result's `data`; a failed capability returns its
message as text. Skill resources return the raw `SKILL.md`, including frontmatter.

## Read-only rule

Resources never write. They do not call a mutation capability, open a network connection, or read arbitrary files.
Skill reads are restricted to the backend-provided roots and the strict skill-name format; traversal segments,
absolute segments, empty names, and paths that would escape the root are rejected with an error string. A missing
or failed resource returns a clear error string rather than rejecting the caller.

`NukeResourceService` is bound as a frontend singleton. No UI is added; an external consumer can map these
descriptors without changing their read behavior.
