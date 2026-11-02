# CAD Authoring Design (Gated)

## Status and gate

**Seven gated slices implemented behind default-off switches.** The shipped authoring surface covers scalar
feature-parameter edits (`nuke.cad.previewFeatureChange` / `nuke.cad.applyFeatureChange`), sketch-dimension or
referenced-document-parameter edits (`nuke.cad.listSketchDimensions` / `nuke.cad.previewSketchChange` /
`nuke.cad.applySketchChange`), topology-impacting feature edits (`nuke.cad.previewTopologyChange` /
`nuke.cad.applyTopologyChange`), imported STEP/IGES/BREP bodies (`nuke.cad.inspectImportSource` /
`nuke.cad.previewImportBodies` / `nuke.cad.applyImportBodies`), placement-only assembly edits on an existing
grounded assembly (`nuke.cad.summarizeAssembly` / `nuke.cad.previewAssemblyChange` /
`nuke.cad.applyAssemblyChange`), drawing-sheet settings (`nuke.cad.summarizeDrawing` /
`nuke.cad.previewDrawingChange` / `nuke.cad.applyDrawingChange`), and Linux-only sandboxed Python model scripts
(`nuke.cad.inspectScriptSource` / `nuke.cad.previewScriptChange` / `nuke.cad.applyScriptChange`). Preview and apply are
disabled unless `nukeCad.aiAuthoringEnabled` is on; the script slice additionally requires workspace-scoped
`nukeCad.scriptAuthoringEnabled` and a working bubblewrap user namespace. The assembly and drawing summaries stay
read-only whenever a document is open. The feature, sketch, topology, and assembly slices ship the **CAD Edit Review**
panel and a display-only viewport ghost for the candidate geometry. The import slice uses the same panel with a
plan-only proposal: it builds no geometry and shows no ghost. The drawing slice is also plan-only and shows no ghost
because drawings are derived linework, not candidate geometry. The script slice shows a diff, sandbox, and build result
with no ghost and no chat Apply. Sketches are editable only through existing driving dimensions and document parameters
they reference; new sketch entities, constraints, and dimensions and free-form sketch creation remain design-only.

All seven slices follow the security model below: stale-proposal rejection, a pre-apply backup, one atomic
commit, session-scoped undo, and no MCP exposure. The feature, sketch, topology, and assembly slices schedule a rebuild
after their commit; the drawing slice refreshes only the affected sheet; the script slice writes the script plus backup
and rebuilds in the sandbox. The feature, sketch, topology, and assembly slices add a real-build preview; the scalar and
sketch slices also require topology/selector/region invariance, while the topology slice reports solid and region changes
explicitly and requires acknowledgement, and the assembly slice requires it only when a removal loses the last instance
of a labeled embedded body. The import slice is plan-only, re-inspects a user-chosen source at apply time, and rejects a
stale hash, size, selection, or plan instead of building candidate geometry. The drawing slice is plan-only too: it
re-runs the pure drawing planner, rejects a stale sheet/view/dimension plan, and never schedules `nuke.cad.rebuild`. The
script slice requires an exact base hash and the full replacement body; preview runs in `bwrap` with no network or
workspace bind, and apply requires the panel-issued nonce. The full
[security gate checklist](#security-gate-checklist) remains the gate for broader authoring.

This page is the contract for the remaining implementation:

- It is not a commitment to ship.
- It does not authorize unsandboxed `.py`/build123d execution, partial script edits, raw Python execution, free-form
  sketch creation, new sketch entities/constraints/dimensions, booleans, body/feature add/delete/reorder, assembly
  structure authoring (mates, connectors, grounding changes, new external sources, part replacement, rename, scale, or
  single-part conversion), or free-form JSON patches.
- Any implementation starts behind a default-off kill switch and must not be enabled for users until the roll-out gates
  are met.
- The security review is a hard gate, not a code-review formality.
- The script slice is Linux-only: macOS, Windows, and environments without `bwrap`/user namespaces have no fallback and
  no unsandboxed execution path.

The design intentionally reuses existing CAD services and the existing NukeAI preview/apply/undo pattern. It does not add
a second geometry kernel or a general model-facing file API. The script slice adds one constrained sandboxed execution
path with no unsandboxed fallback.

## Why CAD authoring is gated

| Risk                            | Why it is different from an OpenMC settings edit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arbitrary code execution        | A `build123d`/CadQuery `.py` model is Python. `geometry_service.py` executes it in a child process (120 s default timeout); that timeout is resource control, not isolation from the filesystem or network. The script slice therefore never uses that path: preview and every sandboxed rebuild run through `bwrap` with no network/workspace bind, `prlimit` limits, and a libseccomp denylist loaded with `--seccomp`; there is no unsandboxed fallback. Residual kernel and bubblewrap risk remains because the seccomp filter is a denylist. |
| Invalid geometry                | A syntactically valid document can build zero-volume, self-intersecting, non-manifold, or overlapping solids. The preview must fail or warn before the change reaches DAGMC/FEM export, because downstream physics silently consumes bad geometry.                                                                                                                                                                                                                                                                                                |
| Destructive overwrite           | Applying a change to a saved `.nuke-cad` file rewrites user work. The viewport's normal edit flow already saves dirty documents before a rebuild, so an in-memory-only apply would be persisted by the next rebuild anyway. Overwrite protection has to be explicit, not implied.                                                                                                                                                                                                                                                                 |
| Stale previews                  | A preview is a snapshot. Between preview and apply the user can edit, undo, reload, switch documents, or change the file on disk. Applying a stale patch can silently discard newer work or produce a build that was never shown.                                                                                                                                                                                                                                                                                                                 |
| Expensive builds                | A full document build can take minutes and produce large STEP/tessellation artifacts; the CAD backend's default process timeout is one hour. An unguarded preview loop is a denial-of-service surface for the IDE and the machine.                                                                                                                                                                                                                                                                                                                |
| Prompt injection via names/text | Body names, feature names, parameter names, material tags, build warnings, and import product names come from documents and external CAD files. They are untrusted data that the model reads and that UIs render. A malicious document can carry instructions, Markdown/HTML, control characters, or misleading labels.                                                                                                                                                                                                                           |
| Simulation impact               | `label`, `material`, selector maps, and body identity feed the region manifest and DAGMC export. A geometry edit that changes solid identity or region coverage can invalidate a coupled OpenMC model even when the shape still builds.                                                                                                                                                                                                                                                                                                           |

The shipped CAD AI surface is read/export plus the seven gated authoring slices:

| Capability                       | Risk      | Effect                                                                          |
| -------------------------------- | --------- | ------------------------------------------------------------------------------- |
| `nuke.cad.summarizeDocument`     | `read`    | Build counts, selection, manifest, optional per-solid summaries                 |
| `nuke.cad.inspectSelection`      | `read`    | Selected solids and hidden ids                                                  |
| `nuke.cad.diagnoseModel`         | `read`    | Build, manifest, selection, and per-solid findings without rebuilding           |
| `nuke.cad.listSketchDimensions`  | `read`    | Document parameters and per-sketch dimensions, datums, and consumers            |
| `nuke.cad.previewFeatureChange`  | `read`    | Real-build preview of scalar feature edits; gated by the switch                 |
| `nuke.cad.applyFeatureChange`    | `execute` | Applies a previewed feature proposal, rebuilds, and registers undo              |
| `nuke.cad.previewSketchChange`   | `read`    | Real-build preview of sketch-dimension or referenced-parameter edits            |
| `nuke.cad.applySketchChange`     | `execute` | Applies a previewed sketch proposal atomically, rebuilds, and registers undo    |
| `nuke.cad.previewTopologyChange` | `read`    | Real-build preview of hole depth-mode or pattern-count edits with region impact |
| `nuke.cad.applyTopologyChange`   | `execute` | Applies exact feature parameters, rebuilds, and registers undo                  |
| `nuke.cad.inspectImportSource`   | `read`    | Inspects a user-chosen STEP/IGES/BREP source without building                   |
| `nuke.cad.previewImportBodies`   | `read`    | Plans imported bodies and opens review without a build, ghost, or write         |
| `nuke.cad.applyImportBodies`     | `execute` | Re-inspects the source, adds import bodies, rebuilds, and registers undo        |
| `nuke.cad.summarizeAssembly`     | `read`    | Instances, parts, placements, grounding, selector ids, BOM, and overlap policy  |
| `nuke.cad.previewAssemblyChange` | `read`    | Real-build preview of instance add, remove, and placement actions               |
| `nuke.cad.applyAssemblyChange`   | `execute` | Re-runs the planner, commits one store batch, rebuilds, and registers undo      |
| `nuke.cad.summarizeDrawing`      | `read`    | Sheets, views, dimensions, visibility, and fixed title-block fields             |
| `nuke.cad.previewDrawingChange`  | `read`    | Plan-only sheet-size, view-display, and dimension-visibility preview            |
| `nuke.cad.applyDrawingChange`    | `execute` | Commits one drawing batch, refreshes the sheet, and registers undo              |
| `nuke.cad.inspectScriptSource`   | `read`    | Bounded active-script text, hash, imports, and model assignment                 |
| `nuke.cad.previewScriptChange`   | `execute` | Sandboxed full-script preview with diff, limits, counts, and audit id           |
| `nuke.cad.applyScriptChange`     | `execute` | Panel-issued nonce, atomic overwrite with backup, sandboxed rebuild, undo       |
| `nuke.cad.exportDagmc`           | `execute` | Builds a source and writes STEP, DAGMC, manifest, and cache artifacts           |

`nuke.cad.diagnoseModel` and `nuke.cad.listSketchDimensions` give the model bounded ways to inspect a model.
`nuke.cad.inspectImportSource` extends that read-only inspection to a user-chosen exchange file,
`nuke.cad.summarizeAssembly` extends it to the existing grounded assembly, and `nuke.cad.summarizeDrawing` extends it
to existing sheets, views, and dimensions, and `nuke.cad.inspectScriptSource` extends it to the active `.py` model (with
the privacy caveat that its text reaches the model provider). Preview never mutates `CadDocumentStore` and script
preview never writes the source; only the seven apply capabilities commit, and external MCP never exposes write/execute
CAD tools. Script apply is panel-only: its proposal stores an approval nonce that is not rendered in the review view,
and its preview `changeSet` omits `applyCapability` so the chat card has no Apply action.

## Current surface and what must change

| Layer                                                                                             | Today                                                                                                                                                                                                                                                                                                                                       | Required for authoring                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability registration (`extensions/nuke-cad/src/browser/capabilities/nuke-cad-capabilities.ts`) | Four read/export capabilities; the authoring contributions add the gated feature preview/apply pair, the sketch list/preview/apply trio, the topology preview/apply pair, the import inspect/preview/apply trio, the assembly summary/preview/apply trio, the drawing summary/preview/apply trio, and the script inspect/preview/apply trio | Keep the switches, region-impact acknowledgement, saved-project reference check, source-picker policy, script sandbox/approval nonce, and undo boundary; unsandboxed scripts, booleans/body/feature add/delete/reorder, drawing creation/deletion, title-block editing, and assembly structure beyond placement stay out    |
| Import source policy                                                                              | The UI import copies a user-chosen source into `<stem>.parts/`; no AI import capability exists                                                                                                                                                                                                                                              | Add a user-granted source reference: the file comes from the native picker, must be a workspace-root regular file with a supported extension and at most 256 MiB, may skip the picker only inside the active document's own `<stem>.parts/`, and is re-inspected at apply                                                   |
| Proposal/undo pattern                                                                             | CAD has a scoped in-memory proposal store (20 entries, 10-minute TTL, deep-cloned snapshots) for feature, sketch, topology, import, assembly, drawing, and script proposals, plus session-scoped `NukeUndoService` tokens                                                                                                                   | Keep the scope, TTL, capacity, and binding for all seven slices; script proposals additionally carry the panel-issued approval nonce outside the view; register reverse handlers with `NukeUndoService`                                                                                                                     |
| Document state (`CadDocumentStore`)                                                               | Framework-free in-memory authority; immutable snapshots; depth-100 snapshot undo/redo; one history entry per committed mutation; `documentEpoch` on install; `loadDocument` resets history; drawing mutations bump `drawingVersion` and never schedule a rebuild                                                                            | Add a revision/identity accessor, a single-transaction patch API (one history entry for a multi-operation patch), an exact feature-parameter replacement API (key removal included), a guarded restore-by-transaction API, an `applyDrawingChanges` drawing batch, and the revision that the active build was produced from |
| Build orchestration (`NukeCadFrontendService` → `NukeCadBackendService`)                          | `buildDocument` → `geometry_service.py --from-document`; display builds skip DAGMC/mesh; the backend defaults to a one-hour process timeout and has `cancelJob` for tracked jobs, but `buildDocument` does not expose a timeout or cancellation input                                                                                       | Add a bounded preview build seam: explicit job id, timeout, abort/cancel, private output directory, cleanup guarantee; record the built document revision on the installed model                                                                                                                                            |
| NukeAI bridge                                                                                     | Generic `NukeCapability` → tool conversion; `changeSet` cards; apply requires `write`/`execute`; undo redeems the service token                                                                                                                                                                                                             | No new tool-conversion code required; the capability IDs, `changeSet`, and `undoToken` follow the existing contract. A kill-switch context signal may be added so the catalog refreshes                                                                                                                                     |
| MCP                                                                                               | Explicit read-only allowlist                                                                                                                                                                                                                                                                                                                | CAD authoring IDs must never be added; add a regression test                                                                                                                                                                                                                                                                |

The CAD build service is the only build path. The design does not add an evaluator, a second feature builder, or a
model-reachable file writer. `geometry_service.py` continues to own document builds, STEP/tessellation output, and feature
validation. Script preview and sandboxed rebuilds add one constrained execution path through `python/sandbox_service.py`
(bubblewrap + `prlimit`), not a second geometry kernel; it has no fallback to the normal child process.

## Editable surfaces

The shipped surface is seven static slices. None can be widened by the model.

### Slice 1: scalar feature parameters

Feature properties come first because:

- A feature's `params` are consumed directly by the build on every rebuild. Changing `pad.length` or `fillet.radius` has a
  deterministic geometric effect; no client-side step is needed to make the value live.
- The change is a single scalar at a stable feature id. There are no sketch primitives, solver state, topology references,
  boolean targets, or array indices in this slice.
- `CadDocumentStore.updateFeatureParams` already performs a shallow merge and a schema validation commit. The transaction
  wrapper commits one history entry per preview.
- The existing preview card, `changeSet`, and undo token already fit the OpenMC safe-edit pattern.

Starter allowlist:

| Feature type      | Allowed key | Condition                           | Why it is safe                                                                             |
| ----------------- | ----------- | ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `pad`             | `length`    | `end` absent or `blind`             | Positive extrusion distance; topology changes only if the build itself fails or intersects |
| `pocket`          | `length`    | `end` absent or `blind`             | Positive cut depth; same build validation as a manual edit                                 |
| `revolve`         | `angle`     | Existing feature                    | Finite angle in `(0, 360]`; no sketch or reference change                                  |
| `groove`          | `angle`     | Existing feature                    | Same as revolve                                                                            |
| `fillet`          | `radius`    | Existing feature, non-empty `edges` | Positive scalar; a too-large radius fails the build and is rejected by preview             |
| `chamfer`         | `distance`  | Symmetric mode (`distances` absent) | Positive scalar; two-distance mode is not editable                                         |
| `draft`           | `angle`     | Existing feature                    | Finite angle in `(-90, 90)`; pull direction is not editable                                |
| `linearPattern`   | `spacing`   | Existing feature                    | Non-zero scalar; count is handled by the topology slice                                    |
| `circularPattern` | `angle`     | Existing feature                    | `(0, 360]`; partial sweep keeps count >= 2                                                 |
| `hole`            | `diameter`  | Existing feature                    | Positive scalar; counterbore/countersink/counterdrill modes are not editable               |
| `hole`            | `depth`     | Existing blind hole                 | Positive scalar; through mode and drill-point mode are handled outside this row            |
| `shell`           | `thickness` | Existing feature, non-empty `faces` | Positive scalar; build failure is caught before apply                                      |

Deliberately outside the feature allowlist: mirror and lattice **counts** (cell-count changes), hole
counterbore/countersink/counterdrill modes and placement, chamfer **two-distance** mode and chamfer angle, draft pull
direction, primitive `dimensions` arrays (index-addressed), `translate` vectors (array paths), booleans and consumed
bodies, new sketch entities, datums, assembly structure, suppression, reorder, add, and delete. Linear and
circular pattern counts are handled only by the topology slice, not by this scalar merge.

The allowlist is a static table in the capability module, not something the model can extend. A feature type or key
missing from the table is rejected before any build.

### Slice 2: sketch dimensions and referenced document parameters

The second slice edits one target sketch's existing driving dimensions and document parameters that the sketch
references. It accepts one to eight edits:

```json
{
  "changes": [
    { "sketchId": "fuel-sketch", "dimensionId": "dimension-5", "value": 0.44 },
    { "sketchId": "fuel-sketch", "parameterName": "fuelRadius", "value": 0.44 }
  ]
}
```

- A **literal driving dimension** changes only the target sketch.
- A **parameter-bound dimension** writes the document parameter and cascades: every sketch and parametric curve that
  references the parameter is re-solved or re-sampled in the same transaction. The diff lists the parameter and every
  affected dimension and sketch.
- **Discovery** is read-only (`nuke.cad.listSketchDimensions`) and returns the document path, document parameters, and
  per-sketch id, name, datum, consumers, and dimensions (id, kind, driving, parameter, value). The model never guesses a
  sketch, dimension, or parameter id.

The resolver re-solves every affected sketch through `SketchSession.fromSketchDef` and planegcs, rejects a failed or
conflicting solve, and stores parameter-bound dimension edits as document-parameter updates, never as a stale
sketch-local table. The candidate is one detached document; apply writes the parameter and every affected sketch in one
document-store commit, so a multi-sketch cascade cannot half-apply.

Rejected edits: reference dimensions (`driving: false`), a missing sketch, dimension, or parameter, a parameter the
sketch does not reference, duplicate edits, more than eight edits, edits spanning multiple sketches, an unchanged or
non-finite value, a failed or conflicting solve, a failed curve resample, and an invalid candidate document.

### Slice 3: topology-impacting features

The third slice changes topology on existing features. It accepts one to eight actions:

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

- `holeDepthMode` switches an existing hole between blind and through. A blind hole stores a positive `depth`; a
  through hole has no `depth` key. Apply performs an exact parameter replacement, so switching to through removes the
  key instead of storing a sentinel. A modeled thread cannot become through.
- `patternCount` sets the count of an existing linear or circular pattern. The count includes the original instance.
  A partial circular sweep keeps count >= 2. Only a disjoint additive pattern adds solids; an overlapping pattern may
  change only faces or volume while leaving the solid count unchanged.
- The whole request is rejected for a missing feature, a feature of the wrong type, a duplicate feature id, an
  unchanged value, a premature through-mode request, or more than eight actions. Only existing `hole`, `linearPattern`,
  and `circularPattern` features are editable.

Unlike the first two slices, this slice is intentionally allowed to change the solid set. The preview runs a real
build and reports solid/face/triangle deltas, added, removed, and changed solids, and named regions. Region impact is
keyed by DAGMC group and material identity, not only selector keys: an OpenMC region reference can break even when
every selector still resolves. The preview also reads the **saved** active OpenMC project file and reports whether its
DAGMC group and material references still resolve against the candidate regions. It never rewrites the OpenMC project
and never runs an OpenMC solver. An unsaved project is reported as **not checked**, never as safe; a missing,
unreadable, or invalid project reports its own warning.

A valid preview stores the proposal. Apply accepts only `{ "proposalId", "acknowledgeRegionChanges": true }`; the
acknowledgement is mandatory even when the OpenMC check was unavailable. Apply re-checks the proposal, epoch, revision,
and stored feature snapshots, writes a backup, then calls `CadDocumentStore.replaceFeatureParamsBatch` with the exact
previous/next parameter objects. That exact replacement is what removes a blind hole's `depth` key. The store commits
once, the normal rebuild is scheduled, and undo restores the previous parameter objects, including a removed key, in one
commit. The review panel keeps Apply disabled while a removed region is still referenced by OpenMC.

### Slice 4: imported bodies

The fourth slice adds editable bodies from a user-chosen STEP/STP, IGES/IGS, or BREP source. It accepts one plan at a
time with `{ sourcePath, strategy, label, solidIndexes, sourceUnit?, material? }`:

```json
{
  "sourcePath": "/workspace/models/pump/pump.parts/impeller.step",
  "strategy": "perSolid",
  "label": "impeller",
  "solidIndexes": [1, 2],
  "sourceUnit": "mm",
  "material": "steel"
}
```

- **Source grant.** The user chooses the file in the native picker. A model-supplied path is only a hint: an arbitrary
  workspace path opens the picker unless it is inside the active document's own `<stem>.parts/` folder, which is the
  self-contained location the UI import uses. The picker result is the grant; the model never widens it.
- **Path and source checks.** The source must be a regular file (symlinks rejected), inside a workspace root, with a
  `.step`/`.stp`/`.iges`/`.igs`/`.brep` extension, at most 256 MiB, and readable. `inspectImportSource` runs the
  backend inspection without a build and returns the format, byte size, SHA-256 hash, declared/effective units, and
  per-solid index, product name, face count, volume, bounding box, and center. It writes no STEP, mesh, DAGMC, or cache
  artifact; no source bytes are copied or downloaded.
- **Plan-only preview.** `previewImportBodies` re-inspects the authorized source and validates the strategy (`single`
  for one body from the selected solids, `perSolid` for one body per solid), label, solid indexes, optional source unit,
  and optional material. It stores an import proposal and opens the **CAD Edit Review** panel, but it never builds
  geometry, shows a ghost, or mutates `CadDocumentStore`. Review shows the source details, selected solids,
  body/feature count, units, warnings, and the label/material plan.
- **Apply and undo.** `applyImportBodies` accepts only `{ proposalId }`. It re-inspects the same source and rejects a
  stale hash, size, selection, or plan, writes a backup, and calls `CadDocumentStore.addImportBodies` once to create
  the bodies and their import features. The normal rebuild is scheduled and a session undo token restores the previous
  document in one commit.
- **Self-contained check.** A source outside the document folder is referenced in place; the preview and apply results
  warn that the document is not self-contained. A missing or changed source is reported as stale, never silently
  re-imported. Imported bodies are B-rep snapshots; their surfaces are not editable, so replace or refresh the source
  instead.

### Slice 5: assembly placement

The fifth slice edits an existing grounded assembly in a saved `.nuke-cad` document. It never creates an assembly,
changes grounding, or touches a mate or connector. It accepts one to sixteen actions:

```json
{
  "action": "addInstance",
  "part": "body:3",
  "placement": { "position": [0, 0, 10], "orientation": [0, 0, 0, 1] }
}
```

```json
{
  "action": "addInstance",
  "part": "<existing instance part>",
  "id": "instance-4",
  "placement": { "position": [5, 0, 0], "orientation": [0, 0, 0, 1] },
  "scale": 1
}
```

```json
{ "action": "removeInstance", "instanceId": "instance-3" }
```

```json
{
  "action": "setPlacement",
  "instanceId": "instance-2",
  "placement": { "position": [0, 0, 20], "orientation": [0, 0, 0, 1] }
}
```

- **Discovery.** `nuke.cad.summarizeAssembly` is read-only and returns `documentPath`, `hasAssembly`,
  `groundedInstanceId`, `overlapCheck`, `instances` (id, part source, optional scale, position/orientation placement,
  solved matrix, selector solid ids), BOM quantities, connectors, mates, and warnings. It works even while the authoring
  switch is off. The model never guesses an instance, part, or body id.
- **`addInstance`** references an existing embedded body (`body:<id>`) or passes the exact `part` string of an existing
  instance. `placement` is required; `id` and a positive uniform or per-axis `scale` are optional. It never introduces a
  new external source.
- **`removeInstance`** accepts only a non-grounded instance whose part is an embedded body and that has no connector
  and no mate. At least one instance must remain. File-backed parts cannot be removed.
- **`setPlacement`** writes only `placement` on a grounded or unmated instance. Existing scale, part source, and names
  stay read-only in this slice.
- Duplicate action targets, unknown instances, unsupported parts, a grounding change, a connector/mate-dependent
  removal, a final count below one, and more than sixteen actions reject the whole request before a build.

**Candidate build.** The preview builds a detached candidate document through the same display build path. It requires
a successful build, no failed features, finite solid/tessellation/bounding-box metrics, selector prefixes that belong
to the final instance ids, and the expected labeled keys for any added instance. Repeated body ids make the viewport
ghost approximate, so the preview labels that limitation instead of implying exact per-instance geometry.

**Collision and region safety.** The preview reports the BOM count delta, placement rows with before/after position,
orientation, and matrix, and the exact instance-overlap warnings from the build. When the document sets
`overlapCheck: false`, cross-body and assembly-instance overlap warnings are disabled; the preview must say so instead
of reporting a clean result. Adding an instance and changing a placement never require acknowledgement. Removing the
last instance of a labeled embedded body deletes that DAGMC region, so the preview requires region acknowledgement and
checks the saved active OpenMC project for a reference to the removed group or material. A blocking reference disables
Apply; an unsaved project is reported as not checked and still requires acknowledgement. Apply never rewrites the
OpenMC project.

**Apply and undo.** `nuke.cad.applyAssemblyChange` accepts only `{ proposalId, acknowledgeRegionChanges? }`, where the
acknowledgement is required only when the preview requested it. Apply re-runs the pure planner against the current
document and compares the stored assembly section and changes, rejects a stale proposal or revision, writes a backup,
clears the selection when an instance is removed, commits one `applyAssemblyChanges` store batch, schedules the
rebuild, and registers a session undo token. Undo restores the previous instances and grounding in one commit.

### Slice 6: drawing-sheet settings

The sixth slice edits presentation settings on an existing drawing sheet in a saved `.nuke-cad` document. It never
creates or deletes a sheet, view, or dimension, moves a view, or changes geometry. One proposal targets one sheet and
accepts one to sixteen actions:

```json
{ "action": "setSheetSize", "sheetId": "sheet-1", "size": "A3" }
```

```json
{ "action": "setViewDisplay", "sheetId": "sheet-1", "viewId": "view-1", "scale": 0.5, "showHidden": true }
```

```json
{ "action": "setDimensionVisibility", "sheetId": "sheet-1", "dimensionId": "dimension-1", "visible": false }
```

- **Discovery.** `nuke.cad.summarizeDrawing` is read-only and returns the document path, `drawingVersion`, sheets
  (id, name, size, orientation, sheet size in mm, and a scale label), flat view rows (sheet id, view id, kind,
  orientation, scale, position, parent, and `showHidden`), flat dimension rows (sheet id, id, kind, view id, visibility,
  value, stale state, and target feature ids/kinds), the fixed title-block fields, and warnings. It works while the
  authoring switch is off.
- **Sheet size.** Only `A4` and `A3` landscape sheets exist. A3 to A4 is rejected when any view lies outside the A4
  bounds; views are never moved to fit. A4 to A3 is allowed.
- **View display.** `setViewDisplay` changes the existing view `scale` (finite, `0.001` to `1000`; `1` is 1:1) and/or
  `showHidden`. A non-standard ratio is accepted with a warning. View kind, orientation, parent, section, detail, and
  position stay untouched.
- **Dimension visibility.** `setDimensionVisibility` sets the existing dimension's `hidden` flag through `visible`.
  Hiding is presentation-only: the dimension stays in the document and in the dimension list, keeps resolving its
  value, and is omitted from SVG and DXF only. Nothing is ever deleted.
- **Title block.** The title block is a fixed read-only template. It is reported for context and cannot be edited.
- **Preview is plan-only.** `nuke.cad.previewDrawingChange` validates the whole request against a clone, stores a
  drawing proposal, and opens the **CAD Edit Review** panel. It writes no document, creates no candidate temp file,
  runs no geometry build, shows no ghost, and schedules no rebuild.
- **Apply and undo.** `nuke.cad.applyDrawingChange` accepts only `{ proposalId }`. It re-runs the pure planner against
  the live document and rejects a stale proposal, revision, or row change, writes the hidden
  `.nuke-ai-backup-<document>` snapshot, and commits one `applyDrawingChanges` batch with `markDrawing`, so
  `drawingVersion` increments once. It opens the Drawing Sheet and refreshes the affected sheet's HLR linework. It
  never schedules `nuke.cad.rebuild`. Undo restores the previous drawings, bumps `drawingVersion`, and refreshes the
  sheet again.
- Unchanged, duplicate, unknown, or cross-sheet targets reject the whole request. Adding or deleting sheets, views, or
  dimensions, moving a view, changing view kind/orientation/parent/section/detail, title-block editing, and geometry
  changes are out of scope.

### Slice 7: sandboxed Python model scripts

The seventh slice replaces the active saved `.py` build123d/CadQuery model as a whole file. It requires both
`nukeCad.aiAuthoringEnabled` and workspace-scoped `nukeCad.scriptAuthoringEnabled` (both default `false`), an active
workspace-contained regular `.py` file (no symlink, at most 64 KiB / 2000 lines), and Linux with `bwrap`, a working
user-namespace probe, and libseccomp. macOS, Windows, and environments without bubblewrap or libseccomp report the slice
unavailable, with no fallback.

- **Inspect.** `nuke.cad.inspectScriptSource` takes `{}` and returns the path, bounded text, SHA-256 hash, imports, and
  whether a top-level `model` is assigned. The script text is sent to the configured model provider; this is the
  documented source-code privacy boundary.
- **Preview.** `nuke.cad.previewScriptChange` takes `{ baseScriptHash, proposedScript, summary? }`, where
  `proposedScript` is the complete replacement body. It rejects a stale hash, unchanged text, NUL bytes, an over-limit
  file, or a non-`.py`/non-workspace target. The sandbox has `--unshare-all`, cleared environment, read-only `/usr`,
  Python environment, and source, one private writable output, tmpfs `/tmp` and `/dev/shm`, no `/sys`, and no network or
  workspace bind; a libseccomp denylist loaded with `--seccomp` blocks network, namespace/mount, tracing, BPF, keyring,
  module, io_uring, process-memory, and `seccomp` syscalls; `prlimit` bounds CPU, address space, NPROC, file size, NOFILE,
  and core. Timeout escalates to SIGKILL
  for the PID namespace. Output files are validated (expected names, regular files, no symlinks, `nlink == 1`, size
  caps) and unexpected files are discarded. The result carries a unified diff, imports, sandbox version/limits, build
  counts, duration, timeout, exit code, and audit id. It publishes no ghost, writes nothing, and discards artifacts.
- **Chat card.** The preview `changeSet` omits `applyCapability`, so the card has no Apply action. The model must direct
  the user to the CAD Edit Review panel and must not claim it can apply a script from chat.
- **Apply and undo.** `nuke.cad.applyScriptChange` takes only `{ proposalId, approvalId }`; the nonce is panel-issued and
  stored on the proposal, never rendered in the review view. Apply rechecks the proposal, base hash, clean editor
  buffer, sandbox availability, and nonce, writes the active script atomically with a hidden backup, rebuilds in the
  sandbox, installs the resulting model, and registers session undo. Undo restores the previous bytes and rebuilds in
  the sandbox. The installed model is marked `sandboxed`: later `.py` rebuilds use the sandbox, and DAGMC/FEM export is
  blocked while the marking remains.
- **Audit and risk.** `<workspace>/.nuke-ide/ai/cad-script-audit.jsonl` records the capability, outcome, hashes,
  duration, exit, timeout, counts, sandbox version, and limits, never script text, absolute paths, stdout/stderr, or
  errors. Every build loads a libseccomp BPF denylist inside bwrap; the namespace, resource, and seccomp boundary still
  depends on kernel and bubblewrap correctness because the filter is a denylist. None of the three script ids is
  exposed through MCP.

Deliberately outside all seven slices: new sketch entities, constraints, or dimensions, free-form sketch creation,
document parameters not referenced by a sketch, partial script edits or arbitrary unsandboxed Python, topology
references/pushes/pulls, topology changes beyond hole depth mode and linear/circular pattern count (booleans and consumed
bodies, feature/body add, delete, or reorder, lattices), datums, and suppression. Scalar and sketch edits still require
topology, selector-map, and region coverage to stay unchanged; any change rejects their preview. Import authoring covers
only the static source/selection/unit/material plan above; it cannot edit or replace an existing import source. Assembly
authoring is placement-only: mates, connectors, grounding changes, mated placements, file-backed removal, scale changes
on an existing instance, part replacement, rename, new external sources, and single-part-to-assembly conversion are out
of scope. Drawing authoring covers presentation settings only: creation, deletion, view placement, view structure, the
title block, and geometry are out of scope. Script authoring covers full-file replacement only, runs Linux-only, and
never removes the sandboxed marking automatically.

## Candidate document-patch surface (not shipped)

The shipped slices use the narrower feature and sketch capabilities above. This table describes a later, generic
document-patch surface; it is not the current contract.

| Capability                       | Risk      | Confirmation                       | Undo                                        | Inputs                                         | Outputs                                                                                                                                                            |
| -------------------------------- | --------- | ---------------------------------- | ------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `nuke.cad.previewDocumentChange` | `read`    | No                                 | No                                          | Active-document patch only: `{ patch }`        | `{ proposalId?, documentPath, documentEpoch, baseRevision, candidateRevision, valid, changes, build, metrics, issues, limitations }` plus a `changeSet` when valid |
| `nuke.cad.applyDocumentChange`   | `execute` | Yes (`requiresConfirmation: true`) | Yes (`undoable: true`, returns `undoToken`) | `{ proposalId }` only                          | `{ proposalId, documentPath, revision, backupPath, buildScheduled, changes }`                                                                                      |
| `nuke.cad.undoDocumentChange`    | `write`   | Yes                                | No (redeems the token)                      | `{ undoToken }` only                           | `{ documentPath, revision, restored }`                                                                                                                             |
| `nuke.cad.previewScriptChange`   | `execute` | Yes (`requiresConfirmation: true`) | No (panel-only apply)                       | `{ baseScriptHash, proposedScript, summary? }` | Separate Linux-only sandboxed script slice; no ghost, no source write, no chat apply                                                                               |

Notes:

- Preview and apply declare `when` requiring the kill switch on and an active `.nuke-cad` document. Undo checks the token
  in `invoke` and remains callable while the kill switch is off, so an applied change can always be reversed.
- Preview is `read` because it never mutates the user's document or writes user-visible artifacts. It still runs the
  geometry backend, so it must have the timeout, cancellation, concurrency, and rate limits described below. If those
  controls are not implemented, preview must be reclassified as `execute` before implementation.
- Apply is `execute`, matching the card's existing apply path (`write`/`execute` only). It overwrites the active
  `.nuke-cad` file, so the confirmation text must name the file and the backup, and the result must report both. If
  reviewers require a `destructive` risk, the card's apply path must be widened first; that is a separate NukeAI change,
  not part of this design.
- Apply never accepts a patch. It accepts only a proposal id, so an "always allow" confirmation cannot invent or widen a
  change; it can only apply a previously previewed, still-fresh proposal.
- Undo is a thin wrapper over the same session-scoped `NukeUndoService` token the NukeAI card already uses. The card's
  Undo button keeps redeeming the service token directly; the capability exists for typed in-process consumers and for
  symmetry. Both paths are single-use.
- `nuke.cad.previewScriptChange` is registered by the separate script slice, not by this generic document-patch surface.
  It accepts the full replacement body and an exact base hash, executes only inside `bwrap`, and writes nothing. Script
  apply is panel-only with the approval nonce and is not reachable from the chat card or MCP; the script slice has its
  own code-execution review and residual-risk acceptance.

### Example preview input

```json
{
  "patch": {
    "schemaVersion": 1,
    "summary": "Increase the fuel pellet height",
    "operations": [{ "op": "setFeatureParam", "featureId": "fuel", "key": "length", "value": 1.2 }]
  }
}
```

### Example preview result

```json
{
  "proposalId": "6f1c7a64-6f6f-4d8d-9d2e-9b9f4f3d2a10",
  "documentPath": "/workspace/models/pincell.nuke-cad",
  "documentEpoch": 12,
  "baseRevision": "sha256:1f0c...",
  "candidateRevision": "sha256:8a31...",
  "valid": true,
  "changes": [
    {
      "path": "features.fuel.params.length",
      "label": "fuel length",
      "kind": "update",
      "before": 1,
      "after": 1.2
    }
  ],
  "build": { "success": true, "solidCount": 3, "faceCount": 48, "triangleCount": 12040, "durationMs": 8421 },
  "metrics": {
    "before": { "solidCount": 3, "faceCount": 48, "volume": 5.12, "boundingBox": { "min": [0, 0, 0], "max": [1.26, 1.26, 1] } },
    "after": { "solidCount": 3, "faceCount": 48, "volume": 5.74, "boundingBox": { "min": [0, 0, 0], "max": [1.26, 1.26, 1.2] } },
    "delta": { "volume": 0.62 }
  },
  "issues": [],
  "limitations": ["Display build only: no DAGMC or FEM mesh is produced."]
}
```

### Example applied result

```json
{
  "proposalId": "6f1c7a64-6f6f-4d8d-9d2e-9b9f4f3d2a10",
  "documentPath": "/workspace/models/pincell.nuke-cad",
  "revision": "sha256:8a31...",
  "backupPath": "/workspace/.nuke-ide/ai/backups/cad/3f9a/2026-11-01T120000Z-1f0c.nuke-cad",
  "buildScheduled": true,
  "changes": [
    {
      "path": "features.fuel.params.length",
      "label": "fuel length",
      "kind": "update",
      "before": 1,
      "after": 1.2
    }
  ]
}
```

Deliberately excluded from the entire surface:

- No document path, output directory, file name, or output-format input. The target is always the active document.
- No raw JSON Patch (`add`/`remove`/`replace`/`move`/`copy`/`test` at arbitrary pointers).
- No script text, Python expression, shell command, import URL, or code snippet in this generic patch surface. The separate
  script slice accepts a full replacement body only, after its own sandbox and approval gate.
- No feature add/remove/reorder/suppress, body add/remove/rename, new sketch entities/constraints/dimensions, datum
  edit, topology change beyond existing hole depth mode and linear/circular pattern count, boolean target change, import
  source change, assembly structure (mates, connectors, grounding, sources, parts, or names), or unit change.
- No bulk/multi-document apply, no background/automatic apply, and no MCP write exposure.
- No raster preview image. The preview is the structured diff, build metrics, and the display-only viewport ghost shared
  by all slices; the card never implies a rendered image.

## Change representation and schema validation

The feature slice uses a small, versioned patch; the sketch slice uses the `{ changes: [...] }` shape above and runs the
same validation order against the detached candidate document. The topology slice uses `prepareTopologyEdit` from
`src/common/cad-topology-edit.ts`, which validates all one to eight actions against a detached clone before mutating
anything and returns resolved full `before`/`after` parameter snapshots plus capability-style changes. Through-hole
changes carry `kind: 'remove'` for the deleted `depth` key. The assembly slice uses `prepareAssemblyEdit` from
`src/common/cad-assembly-edit.ts`, which validates every one to sixteen actions against a detached clone before
mutating: an existing grounded assembly, an add source that is an existing `body:<id>` or an existing instance part,
removal of a non-grounded connector-free mate-free embedded instance while keeping at least one, a finite position and
non-zero unit quaternion for add/placement, no duplicate targets, exact before/after placements, and a BOM delta. The
drawing slice uses `prepareDrawingEdit` from `src/common/cad-drawing-edit.ts`, which validates one to sixteen actions on
one existing sheet against a detached clone: known sheet/view/dimension ids, one `setSheetSize` per sheet, a finite
scale in `[0.001, 1000]`, a boolean `showHidden`/`visible`, no duplicate targets, no no-op actions, no cross-sheet
actions, and the A4 view-bounds check. It returns the candidate document, before/after sheet, view, and dimension rows,
capability-style changes, and warnings, and also re-checks that the view and dimension counts are unchanged.

```ts
interface CadAuthoringPatchV1 {
  readonly schemaVersion: 1;
  readonly summary?: string;
  readonly operations: readonly CadSetFeatureParamOperation[];
}

interface CadSetFeatureParamOperation {
  readonly op: 'setFeatureParam';
  readonly featureId: string;
  readonly key: string;
  readonly value: number;
}
```

Validation is pure and runs before any file or build work:

1. **Shape** — object, `schemaVersion === 1`, at most 32 operations, serialized patch ≤ 64 KiB, `summary` trimmed to 200
   characters, `additionalProperties: false` at every level.
2. **Operation** — only `setFeatureParam`; unknown operations are rejected with the operation index.
3. **Feature id** — must exist exactly once in `document.features`; ids are opaque strings, never paths. No creation of
   ids, no implicit features.
4. **Allowlist** — `(feature.type, key)` must be in the static table, and the key must already exist on that feature (the
   patch never creates a parameter). The feature's current mode must satisfy the condition (`end` absent/`blind` for
   extrude-family keys). A key that is valid for another feature type is rejected.
5. **Value** — finite number, not `NaN`/`Infinity`, within the feature type's documented bounds (for example angle in
   `(0, 360]`, length/thickness/radius `> 0`). No strings, arrays, objects, booleans, or `null`.
6. **No path-shaped keys** — `sketchId`, `body`, `dependsOn`, `suppressed`, `source`, `targetBody`, `toolBodies`,
   `upToFace`, `upToBody`, `edges`, `faces`, `dimensions`, `vector`, and every other structural key are not in the
   allowlist.
7. **No duplicate targets** — at most one operation per `(featureId, key)`. Operations apply in order to a clone; the
   final value must differ from the current value (a no-op patch is rejected rather than silently accepted).
8. **Document validation** — after applying every operation to a deep clone, run `validateNukeCadDocument`. Any issue
   rejects the whole patch; there is no partial application.
9. **Revision** — compute the candidate's canonical SHA-256 and require it to differ from `baseRevision` only by the
   intended changes (the diff is derived from the operations, not by diffing arbitrary JSON).
10. **Exact replacement** — topology edits install the complete next parameter object, not a shallow merge, because
    through mode requires deleting `depth`. The applier never merges unknown keys or accepts structural fields outside
    the action allowlist.
11. **Assembly actions** — one to sixteen typed actions, each with only the documented fields; duplicate targets,
    unknown instances or parts, grounded removal, connector/mate-dependent removal, a final count below one, and any
    non-pos/quat placement reject the whole request before the clone is mutated.

Path format is identifier-based, never index-based: `features.<featureId>.params.<key>`. Feature ids, not display names,
select targets. Display names are untrusted labels and are only shown, escaped, in the diff.

Name and text handling:

- Feature/body names and the model-supplied `summary` are untrusted display text. Cap them, strip control characters,
  render them as text (React escapes by default), and never interpolate them into a tool name, capability id, file path,
  prompt instruction, or Markdown/HTML fragment.
- Object keys such as `__proto__`, `constructor`, or `prototype` are rejected even if a malformed document contains them as
  own keys. The applier uses own-property checks and a null-prototype working map, never dynamic property assignment on a
  normal object.
- No expression strings in the first slice. If the parameter surface later accepts expressions, they are evaluated by
  `expression.ts` (a whitelisted recursive-descent evaluator, not `eval`) against the document parameter scope, with a
  256-character limit, finite-result check, and no new identifiers or functions; the evaluated number is stored, never
  the expression text.

Ids and revisions:

- `baseRevision` = canonical SHA-256 of the validated in-memory document at preview time.
- `candidateRevision` = canonical SHA-256 of the fully patched, validated document.
- `documentEpoch` = `CadDocumentStore.documentEpoch`; a reload/open bumps it even when the content is identical.
- `proposalId` and `undoToken` are server-generated UUIDs. The model never supplies either.
- `revision` after apply is the hash of the exact document written to disk.

## Preview, build, and validation pipeline

The preview runs the existing CAD backend, not a new evaluator:

1. **Target resolution.** Use the active `CadDocumentStore` document only. Require a backing `.nuke-cad` URI inside a
   workspace root, a clean buffer (`dirty === false`), a readable file whose parsed canonical document hash equals
   `baseRevision`, and an active build whose recorded document revision equals `baseRevision`. Reject an unsaved
   sample/new document until the user saves it, and ask the user to rebuild a stale model before previewing. There is no
   model-supplied path.
2. **Patch validation.** Run the pure validator above against the current document. Reject unknown ids, keys, modes,
   duplicate targets, no-ops, size overflows, and prototype-shaped names.
3. **Candidate materialization.** Apply the operations to a detached clone with `cloneDocument`, revalidate, and compute
   `candidateRevision`.
4. **Transient document.** Write the candidate to a harness-named hidden sibling of the real document, for example
   `<docdir>/.nuke-ai-preview-<uuid>.nuke-cad`. A sibling is required because `import` and assembly part paths resolve
   against the document's directory; a file in the OS temp directory would silently break relative imports. Use exclusive
   create, never overwrite, and remove it in `finally`.
5. **Private output directory.** Build outputs go to `<workspace>/.nuke-ide/ai/cad-builds/<uuid>/`, not next to the user's
   file. Pass it as `outputDirectory`; the transient document is the only artifact beside the source and is deleted.
6. **Bounded build.** Call `NukeCadFrontendService.buildDocument` with `exportDagmc: false`, `exportMesh: false`,
   `useCache: false`, `tolerance: document.displayTolerance`, the private output directory, an explicit timeout, and an
   abort signal. No DAGMC or FEM mesh is produced; the cache sidecar is not written. The display build still writes STEP
   and tessellation files into the private output directory; they are deleted after metrics are read.
7. **Result mapping.** Read `success`, `error`, counts, `boundingBox`, `warnings`, `featureResults`, `referenceResults`,
   `selectorMap`, and the region manifest from the build result. Read per-solid properties from the tessellation only when
   the file is within the metrics cap.
8. **Checks.** Turn the result into issues (below). A valid preview stores a proposal and returns a `changeSet`; an invalid
   preview stores nothing and has no apply next action. The preview never installs the candidate model in the viewport or
   `NukeCadStateManager`; the user's screen keeps the current model until apply commits and the normal rebuild finishes.
9. **Cleanup.** Delete the transient document, any sidecar sharing its stem in the source directory, the private output
   directory, and any partial artifacts in `finally`. A startup sweep removes stale `.nuke-ai-preview-*` files and files
   sharing that stem older than one hour; the sweep only matches the harness prefix.

Time and size limits (constants, not user preferences):

| Limit                     | Value                                                                                                 | Reason                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Patch size / operations   | 64 KiB / 32                                                                                           | Bounded tool input; a CAD edit is not a batch migration       |
| Expression length         | 256 chars (only if expressions are enabled later)                                                     | Prevent parser/stack abuse                                    |
| Candidate document        | 16 MiB serialized, 5,000 features, 2,000 parameters                                                   | Bounded validation and temp-file write                        |
| Preview build             | 120 s deadline; kill the process tree at the deadline; 180 s absolute cap including startup/cleanup   | The backend default is one hour; previews must not inherit it |
| Concurrent previews       | 1 per document/workspace                                                                              | Avoid multiplying an expensive build                          |
| Preview rate              | 6 per minute per session                                                                              | Bound an unguarded `read` capability loop                     |
| Tessellation metrics read | 64 MiB, 5,000 solids; aggregate metrics over all parsed solids, per-solid rows only for the first 500 | Avoid parsing a huge model just to format a card              |
| Proposals                 | 20 stored, 10-minute TTL, deep-cloned                                                                 | Mirrors the OpenMC proposal store                             |
| Backups                   | 10 per document, 50 MiB total, 30-day age cap                                                         | Recovery without unbounded disk growth                        |

The timeout/cancellation seam is a hard prerequisite. `NukeCadBackendServiceImpl.buildDocument` currently has no timeout
parameter and does not expose the internal job id before completion, so a preview cannot cancel or bound a build today.
Implementation must add an explicit preview method (or request fields) that passes `timeoutSeconds` and a job id or abort
signal to `_spawnJsonService`, and kills the process tree on timeout/abort.

Validation checks:

| Check                                                | Severity | Behavior                                                                |
| ---------------------------------------------------- | -------- | ----------------------------------------------------------------------- |
| `validateNukeCadDocument` issues                     | error    | Reject before build                                                     |
| Build `success === false`                            | error    | No proposal                                                             |
| Any `featureResults[].status === 'failed'`           | error    | No proposal; list feature ids                                           |
| Any `referenceResults[].status === 'unmatched'`      | error    | No proposal                                                             |
| Any `referenceResults[].status === 'ambiguous'`      | warning  | Allow with a warning                                                    |
| `solidCount === 0`                                   | error    | No proposal                                                             |
| Solid count changed by a scalar/sketch patch         | error    | Those slices are topology-preserving; block and use the topology slice  |
| Body or selector coverage changed by scalar/sketch   | error    | Prevent silent region-map changes                                       |
| Topology preview changes solids or regions           | warning  | Report deltas, named regions, and require acknowledgement at apply      |
| Removed region referenced by saved OpenMC project    | warning  | Report the blocking reference; the review panel disables Apply          |
| Active OpenMC project unsaved or unreadable          | info     | Report `not checked`; acknowledgement is still required                 |
| Sketch solver status `failed` or conflicting         | error    | No proposal; list sketch ids, conflicts, and redundant constraints      |
| Sketch curve resample failure                        | error    | No proposal; the parameter change is not stored                         |
| Non-finite bounding box or non-positive solid volume | error    | Reject invalid geometry                                                 |
| Cross-body/build overlap warnings                    | warning  | Surface after sanitization; apply remains possible after confirmation   |
| Assembly action invalid or structural                | error    | Reject before build; list the action index and cause                    |
| Assembly selector prefix outside final instances     | error    | No proposal; prevent stale per-instance selector keys                   |
| Expected added labeled key missing after build       | error    | No proposal; the candidate does not contain the planned region          |
| Exact assembly instance overlap                      | warning  | Show the instance-pair warning; apply remains possible after confirm    |
| `overlapCheck: false`                                | info     | State that overlap checks are disabled, not that the candidate is clean |
| Removal loses the last labeled embedded-body region  | warning  | Require acknowledgement; block Apply on a saved OpenMC reference        |
| Drawing action invalid, duplicate, or cross-sheet    | error    | Reject before any write; name the action index and cause                |
| Sheet A3 → A4 with a view outside A4                 | error    | No proposal; views are never moved to fit                               |
| Drawing view or dimension count changed              | error    | No proposal; the slice only edits existing presentation settings        |
| Unchanged drawing target                             | error    | Reject a no-op action instead of storing a proposal                     |
| Non-standard drawing view scale                      | warning  | Allow with a warning; show the ratio                                    |
| Volume/bbox delta above the informational threshold  | warning  | Show the percentage; do not block a legitimate scalar edit              |
| Metrics unavailable (tessellation over cap)          | info     | Say so in `limitations`; do not guess                                   |
| Build timeout / cancellation                         | error    | No proposal; no retry                                                   |

Mass properties come from the build's tessellation `properties` block (volume, area, bounding box, center of mass) when it
is within the read cap. `before` comes from the active build installed for `baseRevision`; `after` comes from the
candidate build. The preview reports `before`, `after`, and `delta` for solid count, face count, triangles, volume, and
bounding box. It does not return the tessellation itself.

Sketch proposals use the same candidate/two-snapshot shape. The resolver runs the planegcs transaction against a
detached document, re-solves every affected sketch from `SketchSession.fromSketchDef`, and requires a converged solve
with no conflicting constraints. A parameter-bound dimension edit updates the document parameter and every affected
sketch and parametric curve; it never writes a sketch-local parameter table. Any solver failure, conflict, or resample
failure rejects the preview before a proposal exists. The diff lists each parameter/dimension row with its sketch,
before/after value, and affected dimension ids so the cascade is visible before apply.

On build failure: no proposal id, no apply next action, no file write, no store change, and no partial artifact. The
transient files are deleted, and the result reports the build error plus per-feature findings so the user can ask for a
different change. On a clean build, the candidate is stored with its `before`/`after` snapshots and revisions; only then
does the result advertise the matching apply capability (`nuke.cad.applyFeatureChange`,
`nuke.cad.applySketchChange`, `nuke.cad.applyTopologyChange`, `nuke.cad.applyAssemblyChange`, or
`nuke.cad.applyDrawingChange`).

Apply is all-or-nothing:

> **Shipped subset:** the current slices check the switch, proposal id/scope/TTL, `documentEpoch`, `baseRevision`, and
> the stored before snapshots, write a backup, commit once through the document store, schedule the rebuild, and
> register a session undo. The topology apply also requires `acknowledgeRegionChanges: true` and commits exact
> previous/next parameter objects with `replaceFeatureParamsBatch` instead of a merge, so a deleted `depth` key stays
> deleted. On-disk hash comparison, atomic file replacement, and preview rate limits remain part of the security gate
> below.

1. Re-check the kill switch, proposal id/scope/TTL, `documentEpoch`, clean buffer, file hash, and `baseRevision`.
2. Re-apply the stored operations to the current document (not the stored `after` blob) and require the result to hash to
   `candidateRevision`. Any difference is a stale preview; discard the proposal and ask for a fresh preview.
3. Validate the candidate again and run the file-write and store-commit steps in the order below.
4. Write the candidate atomically: temp file in the same directory, flush, rename over the original. Keep a backup of the
   previous bytes in `<workspace>/.nuke-ide/ai/backups/cad/...` before the rename. Do not follow symlinks out of the
   workspace.
5. Commit the candidate to `CadDocumentStore` as **one** history entry and mark it saved, so the store-change rebuild reads
   the file that was just written instead of auto-saving a second time.
6. If the file write fails, change nothing. If the store commit fails after the write, restore the backup and change
   nothing. The operation never leaves the file and the store disagreeing.

No partial apply is possible: a multi-operation patch is validated and materialized as one candidate, the file replace is
atomic, and the store gets one transaction. There is no loop of `updateFeatureParams` calls that could half-succeed.

The shipped sketch apply validates the stored before snapshots and parameter values against the current document, then
commits the stored solved sketches and parameter updates atomically; it does not re-run the solver at apply time. The
document parameter and every affected sketch land in **one** store commit, so a cascade that touches several sketches
can never leave the parameter updated for only some of them. Apply rejects when a sketch, dimension, or parameter changed
after the preview or when the document epoch/revision moved. A future security gate may re-materialize the candidate and
re-run the solver before commit.

The shipped topology apply validates the stored `before`/`after` parameter snapshots against the current document, then
commits the exact next parameter objects with `CadDocumentStore.replaceFeatureParamsBatch` in one store transaction. It
does not merge, so a blind-to-through change actually removes `depth`; undo writes the exact previous objects back,
including the removed key. Apply also requires the acknowledgement flag even when the OpenMC check was unavailable.
Apply does not re-run the geometry solver. It re-reads the saved OpenMC project and re-checks removed-region
references before commit, and it never writes the OpenMC project.

The shipped assembly apply re-runs the pure planner against the current document, compares the stored assembly section
and action rows, rejects a stale proposal, revision, or epoch, writes a backup, clears the selection when an instance is
removed, and commits one `applyAssemblyChanges` store transaction. It requires `acknowledgeRegionChanges` only when the
preview removed the last instance of a labeled embedded body, re-checks the saved OpenMC reference blocker before the
commit, and never rewrites a part source or the OpenMC project. Undo restores the previous instances and grounding in
one commit.

The shipped drawing apply re-runs the pure planner against the current document, compares the stored sheet, view,
dimension, and change rows, and rejects a stale proposal, revision, or row change. It writes the hidden
`.nuke-ai-backup-<document>` snapshot, then commits one `applyDrawingChanges` store transaction with `markDrawing`,
which increments `drawingVersion` once. It opens the Drawing Sheet and refreshes only the affected sheet's HLR linework,
and it never schedules `nuke.cad.rebuild`. Undo restores the previous drawings, increments `drawingVersion`, and
refreshes the sheet again. The title block is fixed and never written.

### Path scoping and backups

| Target        | First-slice rule                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document      | Active `.nuke-cad` only; no model-supplied path; must be workspace-contained, a regular file (no symlink escape), and match the previewed revision. Backup the previous bytes under `<workspace>/.nuke-ide/ai/backups/cad/`, then replace via a same-directory temp file + rename. Retain at most 10 backups / 50 MiB / 30 days per document.                                                        |
| Script        | Active workspace-contained `.py` only, regular file, no symlink, at most 64 KiB / 2000 lines. Preview writes no source or artifact outside staging. Apply writes only the active script plus the hidden backup, atomically, after rechecking the base hash, clean buffer, sandbox, and panel-issued approval nonce. Every build runs through `bwrap`; there is no unsandboxed fallback.              |
| Import source | A user-chosen STEP/IGES/BREP file may be inspected and imported as editable bodies through the import slice. It must be a workspace-root regular file with a supported extension and at most 256 MiB; a path inside `<stem>.parts/` skips the picker. The source is never patched or copied, and apply re-inspects `sourceHash`/`sourceSize`/selection/plan so a stale source cannot build silently. |
| Assembly part | No new path is accepted. `addInstance` references an existing embedded `body:<id>` or passes an existing instance part; `removeInstance` accepts only an existing embedded-body instance. File-backed parts, new sources, part replacement, and rename stay out of the slice.                                                                                                                        |
| Drawing sheet | No new path is accepted. The target is an existing sheet in the active document; the apply backup is the hidden `.nuke-ai-backup-<document>` snapshot beside the source. No candidate document, temp file, or render artifact is created.                                                                                                                                                            |
| Internal temp | Harness-named hidden sibling for the candidate document (relative imports must resolve against the document directory), private output directory under `.nuke-ide/ai/cad-builds/`, exclusive create, `finally` cleanup, startup sweep.                                                                                                                                                               |

The backup is a recovery aid, not an undo source: undo redeems the in-memory token and restores the recorded backup only
after verifying its hash. A user can also recover manually from the reported `backupPath` if the session ends.

## Confirmation and undo UX

The NukeAI tool card and the **CAD Edit Review** panel are the confirmation surfaces for all seven slices. The panel
renders the same proposal (feature, sketch, topology, import, assembly, drawing, or script) and invokes the same apply
capability; it never writes the document or script directly. Script apply is panel-only because the panel holds the
proposal's approval nonce, and a script preview card deliberately has no Apply action. Feature, sketch, topology, and
assembly proposals show the candidate geometry as the same display-only viewport ghost. The panel reuses the proposed-vs-current tessellation split: unchanged solids use
the cool ghost material and changed solids use the warmer accent. A sketch cascade highlights every affected sketch's
solids because the candidate build already contains the re-solved geometry. A topology proposal adds a **Region impact**
section with added, removed, and changed solids, named regions, and saved-OpenMC reference status; its Apply stays
disabled until the region acknowledgement checkbox is ticked and stays disabled while a removed region is referenced by
OpenMC. An unsaved project is labelled **not checked** and still requires the acknowledgement. An import proposal shows
the source details, selected solids, body/feature count, units, warnings, and label/material plan, and deliberately
shows no ghost because no candidate geometry was built. An assembly proposal shows placement rows (instance,
add/remove/place, before/after position, orientation, and matrix), the instance/BOM count delta, exact overlap warnings,
the `overlapCheck: false` disclosure, and, only when removal loses the last instance of a labeled embedded body, a
**Region impact** section with its acknowledgement checkbox. Repeated body ids make the ghost approximate, and the
panel says so. A drawing proposal shows the sheet size before/after, view scale and hidden-line rows, and dimension
shown/hidden rows, notes that no geometry rebuild or ghost runs and that dimensions are hidden rather than deleted, and
never offers a title-block editor. A script proposal shows a **Script change** section with the executable-warning
banner, a text-only unified diff plus counts and truncation state, imports, the `model` assignment advisory, sandbox
engine/version/userns/limits, sandboxed build counts, duration/timeout/exit, and the audit id. It notes that artifacts were
discarded, shows no ghost, and has no acknowledgement checkbox.

Preview card:

- Title and summary: "CAD feature change — increase the fuel pellet height", "CAD sketch change — fuel radius",
  "CAD topology change — hole becomes through", "CAD import — add two impeller bodies", "CAD assembly — move the
  arm instance", "CAD drawing — resize the sheet and hide a dimension", or "CAD script change — update the pincell
  model".
- Diff rows: `features.fuel.params.length  1 → 1.2`, or
  `parameters.fuelRadius 0.4 → 0.44 (fuel-sketch, dimension-5, dimension-8)`, using the existing `changeSet` renderer.
  Through-hole rows use the remove kind and show the disappeared `depth` value. Import rows name the source path, each
  selected solid index, the target body, strategy, units, and label/material, and state that no geometry was built.
  Assembly rows name the instance, the action, and the before/after placement values. Drawing rows name the sheet,
  view, or dimension, and the before/after size, scale, hidden-line, or visibility value. Script rows show the unified
  diff, imports, sandbox limits, and build counts; the card has no Apply action.
- Validation badge: valid/invalid, solid/face/triangle counts, volume and bounding-box delta, overlap and reference
  warnings, and a short "Not produced: DAGMC/FEM mesh" limitation line. A drawing preview replaces the geometry badge
  with the sheet/view/dimension rows and states that only HLR linework will refresh.
- A topology preview also lists added/removed/changed solids, named regions, and the OpenMC reference status, and never
  claims region stability from a successful build alone. An assembly preview shows the BOM count delta and exact
  instance-overlap warnings, and says when `overlapCheck: false` disabled those checks.
- Actions: **Apply with NukeAI** only when the preview is valid; otherwise no apply action. The existing card never invokes
  a write capability directly; it opens a NukeAI prompt and the normal tool confirmation stays in charge.
- The proposal id is shown only as an opaque reference, not as an editable field.

Apply confirmation:

- The confirmation names the absolute document path and says that the file will be rewritten and that a backup is kept.
  It says whether a geometry rebuild or only a drawing refresh follows.
- A topology apply also states that the geometry and region mapping will change, and requires
  `acknowledgeRegionChanges: true`.
- An import apply names the source path, the selected solids, the created bodies/features, units, and whether the
  document is self-contained, and states that the source is referenced rather than copied.
- An assembly apply names the instance actions and placements, the BOM count change, and the removed labeled regions
  when acknowledgement was required. It states that only the assembly section changes, not a part, mate, connector, or
  grounding.
- A drawing apply names the sheet, each view scale or hidden-line change, and each dimension shown or hidden. It states
  that no geometry is rebuilt, no ghost is shown, the title block stays fixed, and hidden dimensions are not deleted.
- A script apply happens only from the review panel, names the script path, and states that the Python file will be
  overwritten and a hidden backup kept. It never originates from a chat card, which has no Apply action.
- The user must confirm the write/execute tool call. An always-allow confirmation cannot widen the change because apply
  accepts only a proposal id (and, for topology or a region-removing assembly edit, the acknowledgement flag).
- The result card shows the applied revision, the backup path, and an **Undo** action. If the rebuild was scheduled but has
  not finished, the card says so; it never claims the new geometry is already on screen. A drawing result reports
  `drawingRefreshScheduled: true` and `geometryRebuildScheduled: false`.

Undo:

- The card asks for explicit confirmation before redeeming the token (the existing warning dialog).
- A topology undo restores the exact previous feature parameter objects, including a `depth` key that apply removed, in
  one commit. An import undo removes the added bodies and import features in one commit. An assembly undo restores the
  previous instances and grounding in one commit. A drawing undo restores the previous sheets, views, and dimension
  visibility and refreshes the sheet in one commit. A script undo restores the previous Python bytes and rebuilds in the
  sandbox.
- The undo entry restores the file and the store as one unit and marks the document clean; it must not emit a store change
  that lets the rebuild read the still-applied file. Validate the restore first, write the backup to the file atomically,
  then restore the store transaction and emit.
- The entry is one-shot and session-scoped. `NukeUndoService` removes it only after `ok: true`.
- Before restoring, compare the current revision and transaction id with the applied values. If the user edited, undid, or
  reloaded after apply, undo fails with "The document changed after this edit; undo is not available" and leaves both the
  file and the store untouched. The backup path is reported for manual recovery.
- If the backup is missing or does not hash to the recorded value, undo fails safely. The edit journal remains an audit
  trail, not an undo source.

Stale and reload behavior:

- Preview records `documentEpoch`, `baseRevision`, the on-disk canonical hash, and the proposal creation time. Apply
  re-checks all of them and re-materializes the candidate. A mismatch discards the proposal. An import proposal also
  records the source hash and size; apply re-inspects the source and rejects a changed hash, size, selection, or plan.
  An assembly proposal also records the planned section and changes; apply re-runs the planner and rejects a mismatch.
- Switching documents bumps the epoch; the old proposal cannot be applied. Reloading resets store history and invalidates
  every in-memory undo token.
- Applying writes the file, so a reload after apply loads the applied document; the change persists, but the undo token
  does not survive the reload. This is the same session-scoped undo contract as OpenMC edits.
- A failed post-apply rebuild does not roll the document back automatically. The file and store contain the confirmed
  change, the viewport shows its normal build error, and Undo is the recovery path. The result suggests
  `nuke.cad.diagnoseModel`.

Kill switch:

- `nukeCad.aiAuthoringEnabled` is a user-level boolean preference, default `false`; `nukeCad.scriptAuthoringEnabled` is a
  workspace-scoped boolean preference, default `false`. Script preview and apply require both. Linux plus `bwrap` and a
  working user namespace are required too, with no fallback.
- `when` hides preview/apply from the tool catalog while a switch is false, and `invoke` re-checks it so a stale tool cannot run.
- Toggling it off cancels in-flight previews (abort signal/process kill), clears pending proposals, and prevents new
  previews/applies. Existing undo tokens remain redeemable so an already-applied change can still be reversed.
- The preference change must notify the capability context/bridge so the tool list refreshes; a passive `when` check alone
  is not enough.
- External MCP never allowlists these ids. Disabling or excluding `nuke-ai` leaves the capabilities inert behind the
  default-off switch.

## Security model

### Threat table

| #   | Threat                                 | Attack or failure path                                                                                                                                   | Impact                                                       | Required mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Arbitrary code execution               | Model-authored `.py`, Python expression, `eval`, shell, dynamic import, or a script path passed through a patch                                          | Full user-level code execution in the backend                | The script slice executes only inside `bwrap` with `--unshare-all`, cleared env, read-only `/usr`/Python/source, no network or workspace bind, a private writable output, and `prlimit` limits; no fallback. Script apply needs the panel nonce, writes a hidden backup, and rebuilds sandboxed. The generic patch surface has no script text and uses no `eval`/`Function`/dynamic import. Every build loads a libseccomp denylist inside bwrap; residual kernel/bubblewrap risk remains because the filter is a denylist.                                                 |
| 2   | Path escape / symlink                  | A patch or proposal makes the capability write, read, back up, or build outside the workspace                                                            | Write/read outside the project, credential exposure          | Feature, sketch, assembly, and drawing slices accept no new paths at all; the import slice accepts only a user-granted source from the native picker (or the document's own `<stem>.parts/`), checked as a workspace-root regular file, supported extension, at most 256 MiB, and symlink-rejected; internal temp/backup/output paths are harness-generated, absolute, canonicalized, checked with `isWithinWorkspace`, and `lstat`-checked; write via same-directory temp + rename                                                                                         |
| 3   | Destructive overwrite                  | Apply rewrites a saved `.nuke-cad`; the file changed on disk or the backup is missing                                                                    | Loss of user work                                            | Apply requires a clean buffer, a matching base revision, and an atomic backup before the rename; the confirmation names the file; undo restores the backup; the operation is one transaction; no retry. Import apply never modifies the source file and assembly apply never edits a part source                                                                                                                                                                                                                                                                            |
| 4   | Stale preview / TOCTOU                 | User edits, undoes, reloads, switches documents, changes the file, or replaces/edits the import source between preview and apply                         | Applying a change that was never previewed                   | Proposal scope + 10-minute TTL + `documentEpoch` + `baseRevision` + on-disk hash + candidate re-materialization; import apply re-inspects the source and rejects a stale hash, size, selection, or plan; assembly apply re-runs the planner and rejects a changed section; drawing apply re-runs the planner and rejects changed sheet/view/dimension rows; any mismatch rejects and discards; undo checks the applied revision/transaction id                                                                                                                              |
| 5   | Untrusted names/text                   | Feature/body names, labels, material tags, warnings, or import product names contain instructions, Markdown/HTML, control characters, or misleading text | Prompt injection, UI/log injection, misleading confirmations | Treat as data; cap and strip control characters; render as text; never build ids/paths/prompts from them; static capability descriptions; the NukeAI prompt must state that CAD document content is untrusted                                                                                                                                                                                                                                                                                                                                                               |
| 6   | Prompt injection via document content  | A malicious document tells the model to apply, export, or ignore confirmation                                                                            | Unauthorized edits or exports                                | Confirmation is a UI/tool-layer control, not a prompt instruction; apply accepts only a fresh proposal id; the model cannot skip preview; the system prompt and tool descriptions are static and reviewed                                                                                                                                                                                                                                                                                                                                                                   |
| 7   | DoS via expensive builds               | Repeated previews, a huge document, pathological geometry, or many operations                                                                            | IDE and machine exhaustion                                   | 120 s build deadline + process-tree kill; one concurrent preview; 6/min rate; patch/document/size caps; proposal cap/TTL; no auto-retry; no background previews                                                                                                                                                                                                                                                                                                                                                                                                             |
| 8   | Prototype pollution / schema confusion | `__proto__`/`constructor` keys, duplicate keys, deep nesting, unknown fields, array where a scalar is expected                                           | Validator bypass or state corruption                         | Strict `additionalProperties: false`, own-property checks, null-prototype maps, reject reserved keys, depth/size caps, semantic validation in the handler                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 9   | Cross-scope or replay                  | An OpenMC proposal id is passed to CAD apply, or a proposal/token is replayed                                                                            | Wrong-domain mutation or double apply                        | Proposal scope `cad-document`; apply/undo accept only ids/tokens from their own store; tokens are one-shot; proposals are removed after apply or on staleness                                                                                                                                                                                                                                                                                                                                                                                                               |
| 10  | Concurrent apply/race                  | Two applies, apply while a rebuild is in flight, or apply during a document switch                                                                       | Interleaved writes or a build against the wrong file         | One in-flight apply per document; revision/epoch re-check immediately before write; store transaction is synchronous; a document switch invalidates the proposal                                                                                                                                                                                                                                                                                                                                                                                                            |
| 11  | Privacy/log leakage                    | Parameter values, feature names, document paths, or before/after values land in metrics/journals                                                         | Sensitive model data in local logs                           | Reuse the existing journal rules: capability id, outcome, counts, durations, hashed tokens; no names, values, paths, or before/after payloads                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 12  | Simulation-invalid geometry            | The build succeeds but solid identity, labels, or selector coverage changed, or an imported source adds or replaces bodies unexpectedly                  | Wrong region/material mapping downstream                     | Scalar/sketch slices block solid-count/body/selector changes; the topology slice reports added/removed/changed solids and named regions, checks saved OpenMC group/material references, and requires acknowledgement; the import plan shows every added body and selected solid before apply; the assembly preview checks selector prefixes and added labeled keys, reports exact overlap warnings and the `overlapCheck: false` policy, and requires acknowledgement only when removing the last instance of a labeled embedded body; keep DAGMC/FEM export out of preview |

### Required mitigations before implementation

- A bounded, cancellable preview build seam in the CAD backend (timeout, job id, process-tree kill) and an abort path from
  the capability context.
- A pure patch validator/applier with no `eval`, no dynamic property assignment, and a static allowlist.
- Active-document-only targeting with no model-supplied document or output paths; a user-granted import source with
  workspace-root, extension, size, and symlink checks; assembly actions accept only existing `body:<id>` or instance
  parts and never introduce a source or path; harness-generated temp/backup paths with realpath and symlink checks.
- Atomic write + backup + restore helpers; a store transaction API that commits and restores exactly one history entry
  without exposing an intermediate state to the rebuild scheduler.
- A CAD proposal store with scope, TTL, capacity, deep clones, and revision binding.
- The kill switch wired into `when`, `invoke`, and the capability-context refresh path.
- A read-only check of the saved active OpenMC project for DAGMC group/material references, plus mandatory region
  acknowledgement in the review panel and the apply input; no OpenMC rewrite from CAD apply. Assembly apply requires
  acknowledgement only when a removal loses the last instance of a labeled embedded body.
- Static NukeAI prompt/tool descriptions that treat all CAD document text as untrusted data.
- No MCP allowlist entry and a regression test proving the authoring ids never register externally.
- Security tests for every row in the threat table before any user-facing enablement.

### Explicitly not solved by this design

- Fully sandboxing arbitrary Python. The script slice isolates model-authored scripts with namespaces and resource limits,
  and loads a libseccomp denylist inside bwrap; because the filter is a denylist, kernel and bubblewrap correctness remain part of the trust boundary. The normal `.py`
  build path remains an execution surface for user-authored scripts; only the script-authoring/rebuild path is sandboxed.
- Multi-user concurrent editing, merge, or conflict resolution.
- A malicious CAD kernel/OCP or a malicious imported STEP file. The design bounds the build and treats imported data as
  untrusted, but does not replace the geometry kernel's own security posture.
- Supply-chain or model-provider trust. The model is not trusted to enforce confirmation; the UI/tool layer is.

## Model context budget and projection

The model never receives the full document, geometry, or script. Context is built from bounded projections:

| Projection            | Budget                            | Contents                                                                                                                                                                                  |
| --------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document summary      | ≤ 4 KiB                           | Name, units, `documentEpoch`, revision, dirty flag, body/sketch/feature/curve/parameter counts, build success/counts, at most 10 warnings                                                 |
| Sketch dimension list | ≤ 50 parameters, ≤ 100 dimensions | `nuke.cad.listSketchDimensions`: per-sketch id/name/datum/consumers and dimension id/kind/driving/parameter/value; truncation marker                                                      |
| Topology impact       | ≤ 8 actions, ≤ 100 regions        | Per-action feature id and params, solid/face/triangle deltas, added/removed/changed solid ids, named regions, and OpenMC reference status                                                 |
| Import source plan    | ≤ 500 solids, 10 warnings         | Source format/size/hash/units, per-solid index/name/faces/volume/bbox, selected indexes, strategy, label, material, self-contained flag                                                   |
| Assembly summary      | ≤ 200 instances, 10 warnings      | Instance id, part source, placement summary, grounding, selector ids, BOM counts, connector/mate counts, and overlap policy                                                               |
| Drawing summary       | ≤ 50 sheets, ≤ 500 rows           | Sheet id/name/size/orientation/bounds/scale label, view id/kind/orientation/scale/position/parent/showHidden, dimension id/kind/view/visibility/value/stale, and fixed title-block fields |
| Feature projection    | ≤ 50 features                     | Id, name, type, body id, suppression, and allowlisted scalar params only; no topology refs, arrays, or nested objects                                                                     |
| Selection projection  | Current selection only            | `nuke.cad.inspectSelection` output plus per-solid volume/area/bbox for the selected solid(s)                                                                                              |
| Preview diff          | ≤ 32 changes                      | `path`, display label, before/after scalar, issue list, metrics summary                                                                                                                   |
| Build issues          | ≤ 20, truncation marker           | Severity, code, short message; sanitized                                                                                                                                                  |

Never sent to the model:

- The serialized `NukeCadDocument`, unbounded parameter or dimension tables, sketch primitives/constraints, curve
  samples, raw selector map, or raw region manifest. The topology slice sends only the bounded region-impact projection
  described above.
- Tessellation data, STEP/DAGMC/FEM bytes, import-source bytes, file contents, backup contents, or absolute internal
  temp paths. The import slice sends only the bounded source plan above. The assembly slice sends instance ids, part
  sources, placements, grounding, and BOM counts, not part-document contents.
- `.py` script text outside `nuke.cad.inspectScriptSource` (which returns a bounded 64 KiB/2000-line body and a hash and
  sends that text to the model provider), Python tracebacks beyond a short sanitized message, or environment details. The
  script preview sends only the bounded diff and sandbox/build metrics, never stdout/stderr.
- Raw tool output beyond the existing 8 KiB per string and 32 KiB per JSON payload caps in `nuke-tool-result.ts`.

Projection rules:

- Prefer ids over names for matching; names are display-only untrusted text.
- Cap every array before JSON serialization, not after, so the tool result never constructs a huge payload.
- Summarize scalar/sketch geometry as scalar counts and deltas. The topology slice names changed regions and reference
  status as bounded ids/labels, never as a free-form topology description. The import slice sends source metadata and
  per-solid rows, not source geometry or file bytes.
- `#nukeContext` continues to carry only the active document path. It must not gain document content.
- The NukeAI prompt must say that document names, labels, warnings, and preview text are data, never instructions, and that
  the model must not ask the user to bypass confirmation.

## Test strategy

| Layer                                                          | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure patch validation (`src/common`, vitest, no Theia/backend) | Allowed ops/keys; unknown op/feature/key/mode; duplicate targets; no-op; non-finite values; bounds; patch/document size caps; reserved prototype keys; strict `additionalProperties`; path format; canonical revision stability                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Pure topology validation (`src/common`, vitest)                | Hole blind/through depth presence; modeled-thread rejection; linear/circular counts including the original; partial-sweep minimum; duplicate/unknown/wrong-type features; unchanged values; one-to-eight limit; exact `before`/`after` snapshots and remove-kind diff                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Pure import planning (`src/common`, vitest)                    | Supported extensions; source-path grant inside `<stem>.parts/`; outside-root/symlink/oversize rejection; one-body vs per-solid selection; label/material/unit normalization; empty or duplicate solid indexes; stale hash/size/plan rejection                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Pure assembly planning (`src/common`, vitest)                  | Add from `body:<id>` or an existing instance part; remove only non-grounded, connector-free, mate-free embedded bodies with count >= 1; pos/quat placement only; unknown instance/part rejection; grounding, mate, connector, new source, existing scale/part/name change, rename, and single-part conversion rejection; one-to-sixteen limit; exact before/after placement rows and BOM delta                                                                                                                                                                                                                                                                                                  |
| Pure drawing planning (`src/common`, vitest)                   | Set sheet size A4/A3; set view scale/showHidden; set dimension visibility; one-sheet and one-to-sixteen limits; duplicate/unknown/no-op/cross-sheet rejection; scale bounds; A3→A4 view-bounds rejection; unchanged view/dimension counts; exact before/after rows; hidden stays listed and is omitted from SVG/DXF                                                                                                                                                                                                                                                                                                                                                                             |
| Proposal store                                                 | TTL expiry, 20-entry eviction, deep-clone isolation, scope rejection, revision/epoch binding, removal after apply, replay rejection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Capability wiring (fake registry/store/service/undo)           | IDs, risk, `requiresConfirmation`, `undoable`, `when` kill switch, `changeSet.applyCapability`, result shapes, no apply action for invalid previews, no mutation on preview, topology acknowledgement required, assembly acknowledgement only for a last-instance removal, drawing apply reports no geometry rebuild                                                                                                                                                                                                                                                                                                                                                                            |
| Store transaction (in-memory)                                  | One undo entry for a multi-op patch; dirty/clean transitions; revision changes; exact parameter replacement removes `depth`; `applyDrawingChanges` bumps `drawingVersion` once and schedules no rebuild; transaction-id restore; stale restore rejection; load/create resets history; reload invalidates tokens                                                                                                                                                                                                                                                                                                                                                                                 |
| Preview pipeline (fake build + fake file service)              | Temp sibling naming, private output directory, `exportDagmc/exportMesh/useCache` flags, timeout/abort, cleanup in `finally` and on throw, no proposal on failure, metrics mapping, size-cap fallbacks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Real build end-to-end (env-gated)                              | Committed small fixture (pincell or a dedicated primitive/pad fixture) → preview → apply → undo with the real `geometry_service.py`; assert volume changes, solid count/selector coverage unchanged, the file is written atomically, the backup restores byte-for-byte, and a reload sees the persisted change. Skip cleanly without `NUKE_TEST_PYTHON`; keep the e2e marker/profile conventions                                                                                                                                                                                                                                                                                                |
| Failure paths                                                  | Build failure, timeout, missing Python, zero solids, failed feature, unmatched reference, scalar/sketch solid-count or body/selector change, non-positive volume, stale proposal, expired proposal, wrong scope, kill switch off, concurrent apply, missing/corrupt backup, topology acknowledgement missing, removed region still referenced by OpenMC, unsaved OpenMC project, unsupported/symlinked/oversized import source, stale import hash/size/selection/plan, unknown assembly instance, grounded or mated removal, final assembly count below one, stale assembly plan, unknown or duplicate drawing target, A3→A4 view outside A4, stale drawing plan, hidden dimension still listed |
| Security                                                       | Path/symlink probes, prototype pollution, deeply nested/oversized JSON, expression bombs (`2^100000`), control/injection characters in names and summary, proposal/token replay, MCP allowlist absence, saved-project reference check is read-only, drawing ids absent from the MCP allowlist, bwrap argv policy (no network/workspace/home/env), source read-only, only staging writable, timeout kills the PID namespace, artifact validation, missing approval nonce, and no unsandboxed fallback                                                                                                                                                                                            |
| UI/card                                                        | Existing renderer tests for diff rows, valid/invalid badges, Apply only when valid, Undo confirmation and stale-undo message; topology review panel covers the Region impact rows, acknowledgement checkbox, unsaved-project state, and blocked Apply; drawing review panel covers sheet/view/dimension rows, hidden-not-deleted copy, fixed title block, and no ghost; script review panel covers the warning, text-only diff/truncation, imports/model advisory, sandbox limits, build/audit rows, no ghost, no acknowledgement, and no approval nonce in the view                                                                                                                            |

Tests must not boot Theia or call an LLM. The real-build test uses the existing CAD e2e fixtures and environment gates; the
minimal profile skips it cleanly. Pure logic is covered by vitest and should keep the measured logic-layer ratchet honest.

## Rollout gates and kill switch

| Gate       | Entry criteria                                                   | Exit criteria                                                                                            |
| ---------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Design     | This page reviewed; threat table and checklist accepted          | Explicit approval to implement                                                                           |
| Internal   | Flag off by default; unit/fake/e2e tests green; no user exposure | Maintainer dogfood with a small set of documents; no security findings                                   |
| Opt-in     | Documented as experimental; kill switch visible; metrics on      | Two weeks without high/medium findings; undo success > 95%; p95 preview < 30 s on the reference fixtures |
| Default on | Only the seven shipped allowlists; backups and undo proven       | Security review sign-off; rollback drill passes                                                          |

Rollback and kill switch:

- `nukeCad.aiAuthoringEnabled = false` immediately hides/cancels previews and blocks new applies; undo remains available.
- No `.nuke-cad` schema change is introduced by any slice, so disabling authoring requires no migration or file
  rewrite.
- Proposals expire in 10 minutes and are in-memory only; restarting the IDE clears them.
- Backups are retained for manual recovery even after the kill switch is off; pruning is age/count based, never on disable.
- External MCP remains read-only regardless of the flag; the check is compile-time/test-enforced, not only runtime.

## Non-goals

- An eighth authoring surface beyond the seven shipped slices.
- Unsandboxed `.py`/build123d/CadQuery execution, partial script edits, Python snippets, shell commands, or arbitrary
  expressions. The script slice accepts only a full-file replacement and runs it through `bwrap`.
- New sketch entities, constraints, or dimensions, free-form sketch creation, document parameters not referenced by a
  sketch, datums, topology references/pushes/pulls, topology changes beyond hole depth mode and linear/circular pattern
  count, booleans, consumed bodies, assembly structure (mates, connectors, grounding changes, mated placements,
  file-backed removal, scale changes on an existing instance, part replacement, rename, new external sources, or
  single-part conversion), drawing creation/deletion, view placement/structure, title-block editing,
  existing-import source replacement, appearance, materials, labels, units, suppression, reorder, add, or delete.
- Raw JSON Patch, arbitrary document pointers, array-index paths, or model-supplied file paths.
- A new geometry kernel, a new feature builder, or a second execution path.
- New CAD widgets, menus, or a second ghost implementation; the review panel is shared by all seven slices, and the ghost
  serves the four build-preview slices while import, drawing, and script show no ghost.
- Automatic, background, batch, multi-document, or cross-workspace apply.
- Persisting proposals or undo tokens across reload/restart.
- MCP write exposure, external-agent authoring, or a generic "run this CAD change" endpoint.
- Making arbitrary Python fully safe to model-author; the script slice provides a namespace, resource, and libseccomp
  denylist boundary, and broader code execution remains a separate security problem.

## Related documentation

- [CAD AI capabilities](../../../nuke-cad/docs/dev/ai-capabilities.md) — the shipped read/export and gated feature, sketch, topology, import, assembly placement, drawing-settings, and sandboxed script authoring surface.
- [CAD document schema](../../../nuke-cad/docs/dev/document-schema.md) — store history, parameters, features, and imports.
- [CAD backend pipeline](../../../nuke-cad/docs/dev/backend-pipeline.md) — document builds, timeouts, tessellation, and artifacts.
- [CAD features and patterns](../../../nuke-cad/docs/dev/features-patterns.md) — feature parameters and build behavior.
- [CAD end-to-end testing](../../../nuke-cad/docs/dev/testing-e2e.md) — fixtures and environment gates.
- [Capability registry](../../../nuke-core/docs/dev/capability-registry.md) — risk, confirmation, `changeSet`, and undo.
- [Safe OpenMC edits](../user/safe-edits.md) — the preview/apply/undo pattern this design follows.
- [Agent and tool result cards](./agent-and-cards.md) — how the preview card and undo action are rendered.
- [Previews and trajectory](./preview.md) — truthful preview persistence; CAD authoring adds no image preview.
- [Local metrics and the edit journal](./metrics.md) — the privacy rules the authoring journal must follow.
- [External MCP](./mcp.md) — why CAD authoring is never exposed externally.
- [Adding a capability](./adding-a-capability.md) — the registration and schema conventions.

## Security gate checklist

Implementation must not start, and the capability must not be enabled, until every item is checked and signed off:

- [ ] The capability surface (ids, risks, confirmation, undo, and the Linux-only sandboxed script trio with its own
      residual-risk acceptance) is approved.
- [ ] The editable surfaces are the static feature-property allowlist, existing sketch driving dimensions or referenced
      document parameters, existing hole blind/through mode or linear/circular pattern count, a single imported-body
      plan for a user-chosen STEP/IGES/BREP source, placement-only actions on an existing grounded assembly (add an
      embedded body or duplicate an existing part, remove a non-grounded connector-free embedded instance while keeping
      at least one, and set pos/quat on a grounded or unmated instance), existing drawing sheets' size, view display,
      and dimension visibility, and a full-file Python script replacement through the bubblewrap sandbox with a
      panel-issued nonce. New sketch entities/constraints/dimensions, partial/unsandboxed scripts, booleans,
      body/feature add/delete/reorder, assembly structure (mates, connectors, grounding, sources, parts, names, scale, or
      single-part conversion), drawing creation/deletion, view placement or structure, title-block editing, and other
      topology changes are out of scope.
- [ ] The patch schema is frozen with `schemaVersion`, strict `additionalProperties`, operation/feature/key allowlists,
      finite-number bounds, no strings/arrays/nested values, and no duplicate targets. Topology actions use the same
      strict shape with one to eight actions and exact before/after parameter snapshots; assembly actions use one to
      sixteen actions with exact before/after placements and no structural fields.
- [ ] The validator/applier is pure, has no `eval`/`Function`/dynamic import, rejects reserved prototype keys, and has
      adversarial tests for oversized/deep/duplicate input.
- [ ] There is no model-supplied document, output, backup, or script path. The document target is always active; the only
      accepted import source is a user-granted picker result or a file in the document's own `<stem>.parts/`.
- [ ] An import source is a workspace-root regular file with a supported extension and at most 256 MiB; symlinks,
      outside-root paths, and unsupported extensions are rejected before inspection, and the source is never copied or
      downloaded by the AI flow.
- [ ] Internal temp/backup/output paths are harness-generated, absolute, workspace-contained, realpath-checked, and
      symlink-rejected.
- [ ] Feature, sketch, topology, and assembly previews cannot inherit the one-hour backend timeout: an explicit timeout +
      process-tree kill + abort path exists and is tested (including a real hung build). Import and drawing previews build
      nothing.
- [ ] Feature, sketch, topology, and assembly previews use `exportDagmc: false`, `exportMesh: false`, `useCache: false`,
      a private output directory, one concurrent build, a preview rate limit, and cleanup in `finally` plus a stale-file
      sweep.
- [ ] The size/time limits in this design are constants, not user preferences, and are enforced before parsing/building.
- [ ] Feature, sketch, topology, and assembly previews require an active build produced from `baseRevision`, record that
      revision, and reject a stale or missing build instead of comparing against an old model.
- [ ] Apply requires a clean buffer, matching epoch/revision/on-disk hash, and a valid unexpired proposal; build slices
      re-materialize the candidate, the import slice re-inspects the source hash/size/selection/plan, and the assembly
      slice re-runs its planner and compares the stored section; any mismatch rejects without writing.
- [ ] Apply writes atomically with a backup, commits exactly one store transaction, and restores the backup if the store
      commit fails. No partial file/store state is observable; import apply never rewrites the source file.
- [ ] Undo restores file and store as one unit, validates the transaction id/revision, is one-shot, is session-scoped, and
      fails safely when the document changed or the backup is missing. Topology undo restores exact previous parameter
      objects, including a `depth` key removed by apply; import undo removes the added bodies and features in one
      commit; assembly undo restores the previous instances and grounding in one commit.
- [ ] The kill switch is default-off, is checked in `when` and `invoke`, refreshes the tool catalog on change, cancels
      in-flight previews, and leaves undo available.
- [ ] Solid-count, body, and selector-coverage changes are blocked in the scalar and sketch slices. The topology slice
      reports them, checks the saved active OpenMC project's DAGMC group/material references read-only, requires
      `acknowledgeRegionChanges`, and disables Apply while a removed region is referenced; it never rewrites OpenMC.
      The import plan lists every added body and selected solid before apply and never claims a build validation it did
      not run. The assembly preview checks selector prefixes and added labeled keys, reports exact overlap warnings and
      the `overlapCheck: false` policy, and requires acknowledgement only when a removal loses the last instance of a
      labeled embedded body. Zero-volume/non-finite geometry is blocked; overlaps and reference ambiguity are surfaced
      as warnings.
- [ ] Untrusted names/labels/warnings/summary are bounded, sanitized, rendered as text, and documented as data; the NukeAI
      prompt/tool descriptions are updated and reviewed.
- [ ] The local metrics/journal record no names, values, paths, before/after payloads, or raw tokens; tokens are hashed.
- [ ] CAD authoring ids are absent from the external MCP read-only allowlist, and a regression test proves it.
- [ ] Unit, fake-backend, real-build e2e, failure-path, reload/undo, and security tests are green in the minimal and full
      profiles, and `yarn lint` / `npx lerna run build` pass.
- [ ] A security review has signed off on the threat table, with no open high or medium findings.
