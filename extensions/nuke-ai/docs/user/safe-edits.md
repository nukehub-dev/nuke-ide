# Safe Edits

NukeAI can change basic OpenMC run settings, materials, tallies, CSG surfaces/cells/universes/lattices, DAGMC volume materials, scalar CAD feature parameters, existing sketch
dimensions or referenced document parameters, a small set of topology-impacting CAD feature settings, imported
STEP/IGES/BREP bodies, placement-only edits on an existing grounded assembly, existing drawing-sheet presentation
settings, parameterized component-document creation, and, on Linux only, sandboxed Python model scripts without writing
directly from the chat model. Every edit goes through a preview or plan, an explicit apply step with confirmation, and
an in-session undo.

## Supported settings

Only these paths are accepted. Any other path rejects the whole preview.

| Path                      | Rule                                                      |
| ------------------------- | --------------------------------------------------------- |
| `run.particles`           | integer >= 1                                              |
| `run.inactive`            | integer >= 0; only when the current run mode has inactive |
| `run.batches`             | integer >= 1                                              |
| `seed`                    | integer >= 0                                              |
| `threads`                 | integer >= 1                                              |
| `verbosity`               | integer from 1 to 10                                      |
| `energyMode`              | `continuous-energy` or `multigroup`                       |
| `photonTransport`         | boolean                                                   |
| `electronTreatment`       | `led` or `ttb`                                            |
| `atomicRelaxation`        | boolean                                                   |
| `sourceRejectionFraction` | number from 0 to 1                                        |

Sources and advanced settings are not editable through this flow. Materials, tallies, CSG geometry, and DAGMC have
their own flows below.

## Materials

Material edits support add, update, and remove actions, one to twenty per preview.

- **Update** - change `name`, `density`, `densityUnit`, `nuclides`, `thermalScattering`, `color`, `temperature`,
  `volume`, `isDepletable`, `ncrystalCfg`, or `isotropic` on an existing material.
- **Add** - create a material with those fields. It receives the next material id, and its name must not already exist.
- **Remove** - delete an existing material; the preview keeps its full snapshot for undo.

Material ids, macroscopic data, and CAD provenance fields are read-only in this flow. NCrystal config cannot be
combined with thermal scattering. A nuclide list uses `{ name, fraction, fractionType }` entries and must have a
positive total fraction. NukeAI reads the current material first and does not invent nuclides, densities, volumes, or
names.

Removing a material does not rewrite references in cells or tallies. Validate the project after a removal.

## Tallies

Tally edits support add, update, and remove actions, one to twenty per preview.

- **Update** - change `name`, `scores`, `nuclides`, `estimator`, `multiplyDensity`, or `higherMoments`.
- **Add** - create a tally with those fields. It receives the next tally id, and a provided name must be unique.
  `nuclides` defaults to `["total"]` and `filters` defaults to `[]`.
- **Remove** - delete an existing tally; the preview keeps its full snapshot for undo.

Scores must be catalog names or numeric `MT<n>` values. Existing filters, triggers, and derivatives are preserved and
cannot be edited through this flow. Adding a tally with filters is supported; mesh authoring remains a dashboard task.
NukeAI never invents tally results: run the model and inspect a statepoint for results.

## CSG geometry

Geometry edits add, update, or remove a `surface`, `cell`, `universe`, or `lattice`, one to forty-eight actions per
preview. Ids are optional on add (the next free id is assigned) and cannot change on update. The preview rejects
references that would dangle: a surface a cell region still uses, a cell a universe still lists, a universe a lattice or
cell still fills, and a fill that points at a missing universe or lattice. It runs the same geometry validation as the
CSG Builder before storing a proposal. A project with a DAGMC file set must clear it before CSG authoring.

## DAGMC volumes

DAGMC edits assign a material to a volume (an empty name unassigns) or toggle the `autoGeomIds`/`autoMatIds` flags. The
material must already exist in the project. Apply writes the `.h5m` file through the same backend path as the DAGMC
Editor, rolls back earlier volume writes if a later one fails, and undo restores both the file and the project state.

## Project creation and Python export

Creating a project from a template and exporting the project as Python write new files; they are confirmed but not
undoable. The path must be inside the workspace, must not already exist, and project creation refuses a dirty open
project. Export defaults to `model.py` beside the saved project.

## Preview

Ask NukeAI to change a setting, for example "set 200 batches and 5000 particles per batch". NukeAI calls the
read-only preview capability (`nuke_openmc_previewSettings`) first. The preview validates every path and value, rejects
a request that would change nothing, and returns a diff without touching the project.

The finished tool card shows a **Changes** section with:

- the proposal title and summary;
- one row per changed path, with its human-readable label, its path, and the before and after values.

If anything is invalid, the preview fails and no proposal is stored. Read the error and ask for a corrected value
instead of retrying the same request.

## Apply with NukeAI

A preview card shows **Apply with NukeAI**. The button never applies anything itself: it opens a focused chat prompt with
the proposal id, summary, and apply capability. NukeAI previews again when needed, shows the diff, and asks for
explicit confirmation before calling the write capability.

Confirm only when the diff matches what you want. The apply tool call appears as its own result card with the same
diff, an **Undo** button, and no **Apply with NukeAI**.

If the project changed between the preview and the apply, the apply is rejected with a message naming the changed
setting, material, or tally. Run a fresh preview instead of retrying the old proposal.

## Undo

An applied change shows **Undo**. Selecting it opens a warning notification with an **Undo** action; the reverse
handler runs only after you choose that action. Cancelling the notification leaves the settings unchanged.

Undo restores only the paths, materials, or tallies that the proposal changed and verifies that the current values
still match the applied result. A failed undo keeps the token so you can try again, and reports the failure instead of
replacing the card.

Undo state is in memory for the current IDE session only:

- it does not survive an IDE restart or window reload;
- each token is one-shot and is removed after a successful undo;
- an unknown, expired, or already used token reports `This change can no longer be undone.`

## CAD component creation

With **Nuke CAD: AI Authoring** enabled, NukeAI can create a new `.nuke-cad` from a shipped parametric component, such
as the pincell. It lists the template catalogue, resolves the numeric parameters in their declared or requested length
unit, re-solves every affected sketch, and runs a real preview build. The chat card shows one row per parameter (default
before, resolved value after) and the build summary. Creation has no before-model, so it does not open the **CAD Edit
Review** panel and does not draw a viewport ghost.

Apply accepts only the returned proposal and asks where to save the new document when no path is supplied. It refuses
while the active CAD document has unsaved changes and requires `replaceExisting` for a clean, open document. The target
must be a new `.nuke-cad` file inside a workspace root, with an existing folder chain and no symlink. Apply writes the
file, installs it as the active document, schedules the rebuild, and offers **Undo**. Undo deletes the created file only
while its contents still match what apply wrote. The model supplies a template id and numbers only; it cannot supply
geometry, document JSON, code, a user-defined template, or overwrite an existing file.

## CAD feature edits

CAD edits are opt-in. Turn on **Nuke CAD: AI Authoring** in **Settings → Nuke CAD**; while it is off, the CAD
authoring tools are absent from NukeAI. Only a saved `.nuke-cad` document can be edited.

The allowlist is deliberately narrow:

| Feature          | Parameter   | Rule                                          |
| ---------------- | ----------- | --------------------------------------------- |
| Pad, Pocket      | `length`    | blind/default end only; positive              |
| Revolve, Groove  | `angle`     | greater than 0 and at most 360 degrees        |
| Fillet           | `radius`    | positive; the feature must already have edges |
| Chamfer          | `distance`  | positive; symmetric mode only                 |
| Draft            | `angle`     | between -90 and 90 degrees                    |
| Linear pattern   | `spacing`   | positive                                      |
| Circular pattern | `angle`     | greater than 0 and at most 360 degrees        |
| Hole             | `diameter`  | positive                                      |
| Hole (blind)     | `depth`     | positive                                      |
| Shell            | `thickness` | positive                                      |

A preview writes a transient hidden candidate beside the source, builds it with the same geometry backend, and
compares it with the current build. The preview is rejected if the build fails, a feature fails, the solid count
changes, the selector map changes, the region-manifest volume or surface coverage changes, no tessellation is produced,
or the bounding box is invalid. The candidate and its sidecar are deleted whether the build succeeds or fails.

A successful preview opens the **CAD Edit Review** panel beside the viewport. The panel shows the same diff and impact, keeps the candidate geometry as a translucent ghost over the current model (changed solids use a warmer accent), and offers **Apply**, **Dismiss**, and **Undo**. The chat card remains available; both surfaces invoke the same apply capability and confirmation path.

Apply accepts only the proposal id. It rejects a proposal from another document, an expired proposal, a changed
document revision, or a feature whose parameters changed after the preview. Before mutating, it writes a hidden
`.nuke-ai-backup-<document>` snapshot beside the source. It then applies every edit in one document-store commit,
schedules the normal rebuild, and exposes **Undo** in the card. Undo re-checks the revision and applied values, restores
the before parameters in one batch, and schedules the rebuild again.

New sketch entities, constraints, or dimensions, free-form sketch creation, document parameters not referenced by a
sketch, booleans, body/feature add/delete/reorder, and lattices are outside this surface. Scripts use the separate
Linux-only sandboxed flow below; imports use the import-body flow and assemblies use the placement-only flow. External
MCP never exposes the CAD preview or apply tools.

## CAD sketch dimensions

Sketch edits use the same opt-in switch: **Nuke CAD: AI Authoring** in **Settings → Nuke CAD**. Only a saved `.nuke-cad`
document can be edited, and NukeAI starts by calling `nuke_cad_listSketchDimensions`. That read-only tool returns the
document path, the document parameter table, and every sketch with its id, name, datum, consumers, and dimensions (id,
kind, driving flag, bound parameter, and current value), so NukeAI never guesses a sketch or dimension.

A preview accepts one to eight edits on one target sketch, in either form:

```json
{ "sketchId": "fuel-sketch", "dimensionId": "dimension-5", "value": 0.44 }
```

```json
{ "sketchId": "fuel-sketch", "parameterName": "fuelRadius", "value": 0.44 }
```

Only existing driving dimensions and document parameters referenced by a sketch or parametric curve are editable.
A literal driving dimension changes only that sketch. A parameter-bound dimension cascades: the document parameter
changes, and every sketch and parametric curve that references it is re-solved or re-sampled. The preview diff names
the parameter and every affected dimension and sketch, so review the full impact before applying.

The preview runs a real build and is rejected when the sketch, dimension, or parameter is missing, the dimension is a
reference (`driving: false`), the parameter is not referenced by any sketch or curve, the value does not change
anything, or the solver reports a conflict. It preserves topology, selector, and region coverage. A successful preview
opens the **CAD Edit Review** panel with the same diff, solver status, and build impact, and shows the candidate
geometry as a display-only ghost.

Apply accepts only the proposal id after explicit confirmation. It re-checks the document revision and proposal
freshness, then writes the parameter and every affected sketch in one atomic document-store commit and rebuilds. If the
document changed after the preview, preview again instead of reusing the id. Undo from the chat card or the review
panel restores the parameter and all affected sketches together and schedules the rebuild again.

## CAD topology-impact edits

Topology-impact edits use the same opt-in switch and saved-document requirement. They change only two things on an
existing feature:

- a hole's blind/through mode (`holeDepthMode`). A blind hole stores a positive `depth`; a through hole has no `depth`
  key, so switching to through removes the key.
- the count of an existing linear or circular pattern (`patternCount`). The count includes the original instance. Only a
  disjoint additive pattern adds solids; an overlapping pattern may change only faces or volume.

```json
{ "changes": [{ "featureId": "hole-1", "action": "holeDepthMode", "mode": "through" }] }
```

```json
{
  "changes": [
    { "featureId": "hole-1", "action": "holeDepthMode", "mode": "blind", "depth": 4 },
    { "featureId": "pattern-1", "action": "patternCount", "count": 4 }
  ]
}
```

NukeAI confirms the active document and body first and asks for the feature id shown in the Feature Tree; it never
guesses an id. Only existing hole and pattern features are accepted, one to eight actions per preview. A modeled thread
cannot become a through hole, and a partial circular sweep keeps at least two instances.

The preview runs a real build and reports solid, face, and triangle deltas, added, removed, and changed solids, and
named regions. It also checks the **saved** active OpenMC project for DAGMC group and material references to changed or
removed regions. Region impact is about DAGMC group/material identity, not only selector keys: a geometry build that
succeeds does not prove the region mapping is still correct.

A successful preview opens the **CAD Edit Review** panel with a **Region impact** section. Tick **I understand the solid
and region impact** before **Apply** is enabled. If a removed region is still referenced by the saved OpenMC project,
Apply stays disabled and the panel names the reference. An unsaved project is reported as **not checked** and still
requires the acknowledgement. Apply never rewrites the OpenMC project.

Apply accepts only the proposal id and the acknowledgement, writes a hidden backup, installs the exact feature
parameters in one commit (including removing a hole's `depth` key), rebuilds, and exposes **Undo**. Undo restores the
previous parameters, including a removed key, in one commit. If the document changed after the preview, preview again
instead of reusing the id.

## CAD import as bodies

Import edits use the same opt-in switch and saved-document requirement. They add editable bodies from a STEP/STP,
IGES/IGS, or BREP file instead of a frozen assembly reference.

1. NukeAI calls `nuke_cad_inspectImportSource`. The file must be chosen by you in the native picker: a path in the
   conversation is only a hint, and an arbitrary workspace path still opens the picker. A file already inside the
   document's own `<stem>.parts/` folder may be inspected directly.
2. Inspect reports the source format, byte size, SHA-256 hash, declared and effective units, and each source solid's
   index, name, face count, volume, and bounding box. Outside-root, symlinked, unsupported-extension, and larger-than-
   256-MiB sources are rejected.
3. NukeAI plans the import with `nuke_cad_previewImportBodies`:
   `{ "sourcePath", "strategy": "single" | "perSolid", "label", "solidIndexes", "sourceUnit"?, "material"? }`. The plan
   chooses all selected solids in one body or one body per solid, and carries an optional unit override, body label, and
   material tag. The plan is read-only: it builds no geometry, shows no ghost, and opens the **CAD Edit Review** panel.
4. Review the source details, selected solids, body count, units, warnings, and label/material plan before applying.
   A source outside the document folder makes the document not self-contained; NukeAI warns that it references the
   chosen path. The UI **Import CAD as Body** flow copies the source into `<stem>.parts/` instead.
5. Apply accepts only the proposal id after explicit confirmation. It re-inspects the same source and rejects a stale
   hash, size, selection, or plan, writes a hidden backup, commits `addImportBodies` in one document-store commit,
   schedules the rebuild, and exposes **Undo**.
6. Undo restores the previous document in this session. If the source or document changed after the preview, preview
   again instead of reusing the id. Imported bodies are B-rep snapshots, so replace or refresh the source rather than
   editing its surfaces.

This flow never downloads or copies a source, never accepts a path outside the workspace roots, and never exposes an
import tool through MCP.

## CAD assembly placement

Assembly edits use the same opt-in switch and saved-document requirement. They change an **existing grounded assembly**
only; NukeAI cannot turn a single-part document into an assembly, change grounding, author mates or connectors, add a new
external source, replace a part, change an existing instance's scale, or rename an instance.

1. NukeAI calls `nuke_cad_summarizeAssembly`. It returns the document path, every instance with its id, part source,
   optional scale, placement and solved matrix, selector solid ids, the grounded instance, connectors, mates, BOM
   quantities, and whether the document's `overlapCheck` policy is on. This read-only summary works even when AI
   authoring is off, but changes need the switch. NukeAI never guesses an instance, part, or body id.
2. NukeAI previews one to sixteen actions with `nuke_cad_previewAssemblyChange`:
   - `{ "action": "addInstance", "part": "body:<id>", "placement": { "position": [...], "orientation": [...] } }` adds
     an instance from an existing embedded body; pass an existing instance's exact `part` value to repeat that part.
     `id` and a positive `scale` are optional.
   - `{ "action": "removeInstance", "instanceId": "<instance>" }` removes a non-grounded instance whose part is an
     embedded body and that has no connector or mate. At least one instance must remain.
   - `{ "action": "setPlacement", "instanceId": "<instance>", "placement": { "position": [...], "orientation": [...] } }`
     sets only the position and unit quaternion of a grounded or unmated instance. Existing scale, part source, and
     names stay read-only.
3. The preview runs a real candidate build and returns placement rows with before/after position, orientation, and
   matrix, the BOM count delta, exact instance-overlap warnings, and whether `overlapCheck: false` disables overlap
   warnings. Adding an instance and changing a placement never require an acknowledgement.
4. Removing the last instance of a labeled embedded body deletes its DAGMC region. The preview then shows a **Region
   impact** section and requires **I understand the solid and region impact** before **Apply** is enabled. A removed
   group or material still referenced by the saved active OpenMC project shows **Blocked by OpenMC** and keeps Apply
   disabled; an unsaved project is reported as not checked and still requires the acknowledgement. Assembly apply never
   rewrites the OpenMC project.
5. Apply accepts only the proposal id, plus the acknowledgement when the preview requested it. It re-runs the planner,
   rejects a stale proposal or changed document, writes a hidden backup, commits one assembly-section batch, schedules
   the rebuild, and exposes **Undo**. Undo restores the previous instances and grounding in one commit.
6. The **CAD Edit Review** panel shows the same placement rows, BOM delta, and overlap warnings. Repeated body ids make
   the viewport ghost approximate, and the panel says so rather than implying exact per-instance geometry.

Mates, connectors, grounding changes, mated placements, file-backed removal, scale changes on an existing instance,
part replacement, rename, new external sources, and single-part conversion stay in the Assembly card and Feature Tree.
No assembly tool is exposed through MCP.

## CAD drawing sheet settings

Drawing settings use the same opt-in switch and saved-document requirement. They change only existing sheets, views, and
dimensions; NukeAI cannot add or delete any of them, move a view, change a view's kind/orientation/parent/section/detail,
edit the title block, or touch geometry.

1. NukeAI calls `nuke_cad_summarizeDrawing`. It returns the document path, drawing version, every sheet with its id, name,
   size (A4 or A3), orientation, sheet size in millimetres, and scale label; every view with its sheet, id, kind,
   orientation, scale, position, parent, and hidden-line setting; every dimension with its sheet, id, kind, owning view,
   visibility, value, and stale state; and the fixed title-block fields. The title block is read-only.
2. NukeAI previews one sheet and one to sixteen actions with `nuke_cad_previewDrawingChange`:
   - `{ "action": "setSheetSize", "sheetId": "<sheet>", "size": "A4" | "A3" }` resizes the landscape sheet. Shrinking
     A3 to A4 is rejected when any view lies outside A4; views are never moved to fit. A4 to A3 is allowed.
   - `{ "action": "setViewDisplay", "sheetId": "<sheet>", "viewId": "<view>", "scale"?, "showHidden"? }` changes an
     existing view's scale (positive, `0.001` to `1000`; `1` is 1:1) and/or hidden-line display.
   - `{ "action": "setDimensionVisibility", "sheetId": "<sheet>", "dimensionId": "<dimension>", "visible": false }`
     hides or shows an existing dimension.

   The preview is plan-only: it stores a proposal and opens the **CAD Edit Review** panel with sheet, view, and dimension
   rows. It builds no geometry, shows no ghost, writes nothing, and schedules no rebuild. Duplicate, unchanged, unknown,
   or cross-sheet targets reject the whole request.

3. Hiding a dimension never deletes it. The dimension stays in the list, keeps resolving its value, and is omitted from
   SVG and DXF output. The title block is a fixed template and cannot be edited.
4. Apply accepts only the proposal id after explicit confirmation. It re-runs the planner, rejects a stale proposal or
   changed rows, writes a hidden `.nuke-ai-backup-<document>` snapshot, commits one `applyDrawingChanges` batch, opens the
   Drawing Sheet, refreshes only that sheet's linework, and exposes **Undo**. It never schedules a geometry rebuild.
5. Undo restores the previous drawings and refreshes the sheet in one commit.

## Python model scripts (Linux only)

AI script authoring replaces the active saved `.py` build123d/CadQuery model as a whole file. It is default-off and
Linux-only; NukeAI chat, model setup, and the other capability tools are not Linux-specific. Turn on both **Nuke CAD:
AI Authoring** and the workspace-scoped **Nuke CAD: Script Authoring** in **Settings → Nuke CAD**. It needs a working
bubblewrap user namespace and libseccomp; macOS, Windows, and environments without them fail closed with a Linux-only
unavailable message. There is no unsandboxed fallback.

1. Open the `.py` in the editor and run **Open Active Python Model in CAD** so it is the active model. NukeAI inspects
   the script with `nuke_cad_inspectScriptSource`; inspection asks for confirmation because the source text leaves the
   IDE. The result carries the path, bounded text, SHA-256 hash, imports, and whether a top-level `model` is assigned.
   **The script text is sent to the configured model provider**; inspect a sensitive script only when you want NukeAI to
   read it.
2. A preview requires the exact base hash and the complete proposed script. It runs in a bubblewrap sandbox with no
   network and no workspace access, a read-only source, one private writable output directory, CPU/memory/process/file
   limits, and a timeout that kills the whole PID namespace. Sandbox artifacts are validated and then discarded. The
   preview never writes the script and shows no viewport ghost.
3. The **CAD Edit Review** panel shows a **Script change** section with a prominent executable warning, the unified diff
   (plain text, never rendered HTML or Markdown), added/removed/hunk counts, a truncation notice, imports, the `model`
   assignment advisory, sandbox engine/version/userns/seccomp/limits, build counts, duration, timeout, exit code, and the
   audit id. The chat card has **no Apply action**.
4. Apply is available only in the panel. It uses a hidden approval nonce, confirms that the Python file will be
   overwritten and that a hidden backup is kept, then writes the script, rebuilds in the sandbox, installs the model, and
   offers **Undo**. NukeAI cannot apply a script from chat and must never claim it can.
5. A model applied this way is marked sandboxed. Later `.py` rebuilds for it stay sandboxed, and DAGMC/FEM export is
   blocked while the marking remains. Undo restores the previous script bytes and rebuilds in the sandbox.

Every build also loads a libseccomp BPF denylist inside bubblewrap (`--seccomp`) that blocks network,
namespace/mount, tracing, BPF, keyring, module, io_uring, process-memory, and `seccomp` syscalls, and forces `clone3`
to `ENOSYS`; a host without libseccomp reports script authoring unavailable, with no unsandboxed fallback. The sandbox is a namespace, resource, and
seccomp boundary, not a complete security guarantee: because the filter is a denylist, kernel and bubblewrap correctness
still matter. The audit log under `<workspace>/.nuke-ide/ai/` records hashes, outcome,
duration, exit, timeout, counts, sandbox version, and limits, never script text, absolute paths, or process output. None
of the script tools is exposed through MCP.

## Related

- [NukeAI Actions](actions.md) for the chat actions and result cards.
- [Agent and Tool Result Cards](../dev/agent-and-cards.md) for the renderer contract.
