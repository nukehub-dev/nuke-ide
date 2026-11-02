# CAD AI Capabilities

`nuke-cad` publishes read and export actions through the neutral capability
registry owned by `nuke-core`. AI consumers, MCP servers, and other extensions
read the same `NukeCapability` objects without importing CAD widgets.

The implementation lives in
`src/browser/capabilities/nuke-cad-capabilities.ts` (read/export) and
`src/browser/capabilities/nuke-cad-authoring-capabilities.ts` (the gated
feature, sketch, topology, import, assembly-placement, and drawing-settings authoring slices):

- `NukeCadCapabilities` implements `NukeCapabilityContribution` and registers
  the read/export capabilities below.
- `NukeCadAuthoringCapabilities` registers the feature preview/apply pair, the
  sketch dimension list/preview/apply trio, the topology preview/apply pair,
  the import inspect/preview/apply trio, the assembly
  summary/preview/apply trio, and the drawing summary/preview/apply trio. All
  authoring capabilities are default-off behind
  `nukeCad.aiAuthoringEnabled`.
- `NukeCadContextContribution` publishes `activeCadDocument` from
  `NukeCadStateManager.scriptPath` and forwards `onModelChange`.
  `NukeCadAuthoringContextContribution` additionally refreshes the tool set when
  the authoring switch changes.
- All are bound in `nuke-cad-frontend-module.ts`. The nuke-core frontend module
  owns the contribution providers, registry, and context service.

The handlers never reimplement geometry or export logic. Summaries read the
active `NukeCadStateManager` model; export delegates to
`NukeCadFrontendService.buildDocument` or `buildGeometry`; feature, sketch,
topology, and assembly previews build a transient candidate document through the
same `buildDocument` path; import inspection delegates to the read-only
`inspectImportSource` RPC and import apply commits through
`CadDocumentStore.addImportBodies`; assembly apply commits one
`applyAssemblyChanges` batch through `CadDocumentStore`. Drawing preview runs
only the pure planner, and drawing apply commits one `applyDrawingChanges`
batch, opens and refreshes the sheet, and never rebuilds geometry.

## Capabilities

| ID                               | Risk      | Active model required  | Purpose                                                               |
| -------------------------------- | --------- | ---------------------- | --------------------------------------------------------------------- |
| `nuke.cad.summarizeDocument`     | `read`    | Yes                    | Build counts, selection, manifest, and solid summaries                |
| `nuke.cad.inspectSelection`      | `read`    | Yes                    | Primary solid, selected solids, and hidden solid ids                  |
| `nuke.cad.diagnoseModel`         | `read`    | Yes                    | Build, manifest, selection, and per-solid geometry findings           |
| `nuke.cad.listSketchDimensions`  | `read`    | Document only          | Document parameters and per-sketch dimensions, datums, consumers      |
| `nuke.cad.previewFeatureChange`  | `read`    | Yes, saved             | Validate scalar feature edits with a real build and diff them         |
| `nuke.cad.applyFeatureChange`    | `execute` | Yes, saved             | Apply a previewed proposal, rebuild, and register undo                |
| `nuke.cad.previewSketchChange`   | `read`    | Yes, saved             | Validate sketch-dimension or parameter edits with a real build        |
| `nuke.cad.applySketchChange`     | `execute` | Yes, saved             | Apply a sketch proposal atomically, rebuild, and register undo        |
| `nuke.cad.previewTopologyChange` | `read`    | Yes, saved             | Preview hole depth-mode or pattern-count edits with region impact     |
| `nuke.cad.applyTopologyChange`   | `execute` | Yes, saved             | Apply a topology proposal exactly, rebuild, and register undo         |
| `nuke.cad.inspectImportSource`   | `read`    | Yes, saved             | Inspect a user-chosen STEP/IGES/BREP source without building          |
| `nuke.cad.previewImportBodies`   | `read`    | Yes, saved             | Plan imported bodies and open review without a build or write         |
| `nuke.cad.applyImportBodies`     | `execute` | Yes, saved             | Re-inspect the source, add import bodies, rebuild, and register undo  |
| `nuke.cad.summarizeAssembly`     | `read`    | Document only          | Instances, parts, placements, grounding, selector ids, BOM, policy    |
| `nuke.cad.previewAssemblyChange` | `read`    | Yes, grounded assembly | Preview add, remove, or placement actions with a real candidate build |
| `nuke.cad.applyAssemblyChange`   | `execute` | Yes, saved             | Re-run the planner, commit one assembly batch, rebuild, and undo      |
| `nuke.cad.summarizeDrawing`      | `read`    | Document only          | Sheets, views, dimensions, visibility, and fixed title-block fields   |
| `nuke.cad.previewDrawingChange`  | `read`    | Yes, saved             | Plan sheet size, view display, or dimension visibility; no build      |
| `nuke.cad.applyDrawingChange`    | `execute` | Yes, saved             | Commit one drawing batch, refresh the sheet, and register undo        |
| `nuke.cad.exportDagmc`           | `execute` | No                     | Build a source file and export DAGMC + region manifest                |

### `nuke.cad.summarizeDocument`

Input:

```json
{
  "includeSolids": false
}
```

`includeSolids` defaults to `false`. When true, the result carries one summary
per tessellated solid.

Output data:

- `documentPath` — absolute path of the active source.
- `success`, `solidCount`, `faceCount`, `triangleCount`, `boundingBox`,
  `warnings` — copied from the active build result.
- `selection` — `{ solidId?, faceId?, solidIds? }` from the state manager.
- `manifest` — `{ volumes, surfaces }` when a manifest is loaded.
- `solids` — per-solid `solidId`, optional `bodyId`, `faceCount`, `edgeCount`,
  `triangleCount`, and optional geometric `properties`.

The capability declares an `outputSchema` matching this data so MCP clients can
return structured content. Keep the schema and the handler in sync.

### `nuke.cad.inspectSelection`

Input: `{}`.

Output data: `documentPath`, `selection`, `primarySolid`, `selectedSolids`, and
`hiddenSolidIds`. The primary solid comes from `selection.solidId`.
`selectedSolids` resolves `selection.solidIds`, falling back to
`[selection.solidId]` for a single selection. Hidden ids come from the viewport
hide/isolate state.

### `nuke.cad.diagnoseModel`

Input: `{}`.

Read-only diagnosis of the active model. Output data: `documentPath`, `success`,
`valid`, `counts`, `manifest`, `selection`, `hiddenSolidIds`, `warnings`, and
`issues`. `valid` is true only when no error-severity issue is present. A
successful diagnosis returns `ok: true` even when it reports error issues; it
returns `ok: false` with `No CAD document is active.` only when no document is
open. The handler reads the current state manager model and never rebuilds it.

`counts` holds `solids`, `faces`, and `triangles` from the active build result.
`manifest` holds `present`, `volumes`, and `surfaces`; `present` is false for a
missing or empty manifest. `selection` holds the current ids plus `valid`, which
is false when a selected solid is absent from `solidSummaries` or the selected
face is outside the primary solid's face count.

Findings use the shared issue shape `{ severity, code, category?, message,
suggestion? }`:

| Condition                                      | Severity | Code                      | Category       |
| ---------------------------------------------- | -------- | ------------------------- | -------------- |
| Active build failed                            | error    | `build-failed`            | `build`        |
| Build produced no solids                       | error    | `no-solids`               | `geometry`     |
| Solids exist but the model has no triangles    | warning  | `no-triangles`            | `tessellation` |
| One entry per build warning                    | warning  | `build-warning`           | `build`        |
| Manifest is missing or empty                   | warning  | `manifest-missing`        | `manifest`     |
| Manifest volume count differs from solid count | warning  | `manifest-count-mismatch` | `manifest`     |
| Selection references missing solid or face     | warning  | `selection-stale`         | `selection`    |
| Solids hidden in the viewport                  | info     | `hidden-solids`           | `viewport`     |
| A solid has no tessellation triangles          | warning  | `solid-no-triangles`      | `tessellation` |
| A solid has non-positive volume                | warning  | `solid-zero-volume`       | `geometry`     |
| More than 20 findings were produced            | info     | `findings-truncated`      | `diagnostics`  |

At most 20 issues are returned, including a final `findings-truncated` info
entry that reports how many findings were omitted. Hidden solids are a
viewport-only state and do not block export or invalidate the model.

### `nuke.cad.exportDagmc`

Input:

- `documentPath` — absolute `.nuke-cad`, `.py`, `.step`, `.stp`, or `.brep`
  path. Defaults to the active document.
- `outputDirectory` — absolute output directory. Defaults to the source
  directory.
- `meshEngine` — `gmsh` or `netgen`.
- `meshSize` — non-negative target element size.
- `lengthScale` — non-negative export scale (`1.0` keeps model units, `0.01`
  converts cm to m).

Every build passes `exportDagmc: true` and `exportMesh: false`. Only meshing
options present in the input are forwarded.

Source dispatch:

| Extension                | Service call                                |
| ------------------------ | ------------------------------------------- |
| `.nuke-cad`              | `buildDocument`                             |
| `.py`                    | `buildGeometry` with `sourceType: 'script'` |
| `.step`, `.stp`, `.brep` | `buildGeometry` with `sourceType: 'step'`   |
| Anything else            | Rejected before calling the backend         |

Output data: `documentPath`, optional `dagmcPath`, `stepPath`,
`regionManifestPath`, `regionManifest`, `selectorMap`, `warnings`,
`dagmcWarnings`, and `outputDirectory`. Successful results include file
artifacts for the DAGMC model, region manifest (when found), and STEP model, and
suggest `nuke.openmc.importCad` as the next action.

Export is `execute` and sets `requiresConfirmation: true` because it runs the
geometry pipeline and writes STEP, DAGMC, cache, and manifest files into the
workspace. Confirmation protects against overwriting earlier exports and
against expensive or failing builds triggered without an explicit user action.

## Feature authoring (gated)

`nukeCad.aiAuthoringEnabled` defaults to `false`. While it is off, both
feature-edit capabilities are disabled: their `when` predicates are false and
`invoke` returns a clear disabled message. The switch is re-checked on every
call; flipping it refreshes the capability context and the AI tool set.

The preview accepts one to sixteen scalar edits on an existing feature:

| Feature             | Param       | Rule                                      |
| ------------------- | ----------- | ----------------------------------------- |
| `pad`, `pocket`     | `length`    | blind/default end only; finite `> 0`      |
| `revolve`, `groove` | `angle`     | finite `(0, 360]`                         |
| `fillet`            | `radius`    | finite `> 0`; the feature must have edges |
| `shell`             | `thickness` | finite `> 0`                              |

Preview validation is the pure `prepareFeatureEdit` engine. The preview writes
the candidate document beside the source as `.nuke-ai-preview-<uuid>.nuke-cad`
(so document-relative imports keep resolving), builds it with
`useCache: false`, a 120-second timeout, and a caller-chosen job id, then
compares the result with the current build:

- the build must succeed and no feature may fail;
- the solid count must be unchanged;
- the selector map must be unchanged;
- the region-manifest volume and surface selectors must be unchanged;
- the build must produce tessellation and a finite, non-degenerate bounding box.

The preview is read-only; it stores a proposal and returns a `changeSet` with a
`proposalId` and an impact summary. The candidate document, its manifest
sidecar, and the private preview directory are deleted in `finally`, including
on failure or cancellation.

Apply accepts only `{ proposalId }`. It rejects a missing/expired proposal, a
different document epoch, a changed document revision, or any affected feature
whose params changed after the preview. It writes a hidden
`.nuke-ai-backup-<document>` snapshot before mutating, applies all edits in one
document-store commit, schedules `nuke.cad.rebuild`, and registers a
session-scoped undo token. Undo re-checks the epoch, revision, and applied
params, restores the before params in one batch, and schedules the rebuild.

The full design and its remaining security gates are documented in
[Cad Authoring Design](../../../nuke-ai/docs/dev/cad-authoring-design.md). Script,
free-form sketch creation, new sketch entities/constraints/dimensions, topology changes beyond the two topology actions
below, assembly structure beyond placement (mates, connectors, grounding, mated placements, file-backed removal, scale,
part replacement, rename, new external sources, or single-part conversion), drawing creation/deletion, view placement
or structure, title-block editing, and editing or replacing an existing import
source remain out of scope.

## Sketch authoring (gated)

Sketch authoring uses the same switch and saved-document requirement. Discovery is
`nuke.cad.listSketchDimensions` with no arguments. It returns `documentPath`, the document `parameters` table, and one
entry per sketch with `id`, `name`, `datumId`, `consumers` (feature ids), and `dimensions`. Each dimension reports
`id`, `kind`, `driving`, optional `parameter`, and `value`.

Preview (`nuke.cad.previewSketchChange`) accepts one to eight edits, all on one target sketch:

```json
{
  "changes": [
    { "sketchId": "fuel-sketch", "dimensionId": "dimension-5", "value": 0.44 },
    { "sketchId": "fuel-sketch", "parameterName": "fuelRadius", "value": 0.44 }
  ]
}
```

Resolution rules:

- A `dimensionId` must exist in the target sketch, be a driving dimension (`driving: true`), and reference an existing
  constraint. Reference dimensions are rejected.
- A `parameterName` must exist in the document parameter table and be referenced by a sketch or parametric curve. A
  parameter no sketch or curve references is rejected; the edit then cascades to every sketch and curve that uses it.
- Each request must change the current value. Duplicate targets, more than eight edits, and edits spanning multiple
  sketches are rejected.
- A **literal** driving dimension updates only the target sketch. A **parameter-bound** dimension updates
  `document.parameters[parameterName]` and cascades to every sketch whose constraints or dimensions reference the
  parameter, and to every parametric curve whose expression consumes it. The returned edits name the parameter and every
  affected dimension id and sketch id.

The solver transaction (`NukeCadSketchEditService.prepare`) runs on a detached clone. Every affected sketch is restored
with `SketchSession.fromSketchDef`, solved with planegcs, and written back with its solved primitives and dimension
values. Dependent parametric curves are resampled and the candidate document is validated. The preview requires a
converged solver status with no conflicting constraints, no failed curve resample, and no document-validation issue;
otherwise it returns a stable error code (`dimension-not-driving`, `parameter-not-referenced`, `solve-conflicting`,
`value-unchanged`, and so on) and stores no proposal. Parameter-bound edits are stored as document-parameter updates,
never as a sketch-local `parameters` table, so a later rebuild re-solves from the same source of truth.

Apply (`nuke.cad.applySketchChange`) accepts only `{ "proposalId" }`. It re-checks the document epoch, revision, the
affected sketch snapshots, and the parameter values, then applies the stored solved sketches and parameter updates
atomically with the same backup/restore path as feature authoring. The parameter and **every** affected sketch commit
in one document-store transaction before scheduling `nuke.cad.rebuild`, so a multi-sketch cascade cannot half-apply.
Undo re-checks the epoch, revision, and applied values and restores the parameter and all affected sketches together. None of the sketch
authoring ids is on the external MCP read-only allowlist; MCP stays read-only.

## Topology-impact authoring (gated)

Topology authoring uses the same switch and saved-document requirement. It
accepts one to eight actions on existing features:

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

- `holeDepthMode` applies to an existing `hole`. Blind means `params.depth` is a positive number; through means the
  `depth` key is absent. Switching to through deletes the key rather than storing a sentinel value. A modeled thread
  cannot become through.
- `patternCount` applies to an existing `linearPattern` or `circularPattern`, includes the original instance, and must
  be a safe integer of at least 1. A partial circular sweep keeps a count of at least 2. Only a disjoint additive
  pattern adds solids; an overlapping pattern may change only faces or volume.
- Duplicate feature ids, unknown features, wrong feature types, unchanged values, no-op modes, and more than eight
  actions reject the whole request before a build.

The preview runs the same real display build as the other slices and reports solid, face, and triangle deltas,
added/removed/changed solids, and named regions. Region impact is keyed by DAGMC group and material identity, not only
by selector keys: a successful build does not prove that an OpenMC region still maps to the same physical body.

The impact check reads the **saved** active OpenMC project file and compares its DAGMC group and material references
with the candidate regions. An unsaved project is reported as **not checked**, never as safe, and still requires
acknowledgement; a missing, unreadable, or invalid project reports its own warning. The check is read-only: preview and
apply never rewrite the OpenMC project and never run an OpenMC solver.

A valid preview stores the proposal and publishes the candidate tessellation to the ghost service. Apply accepts only
`{ "proposalId", "acknowledgeRegionChanges": true }`. It re-checks the proposal, document epoch, revision, and stored
feature snapshots, then calls `CadDocumentStore.replaceFeatureParamsBatch` with the exact previous/next parameter
objects. Exact replacement is required because a through-hole transition deletes the `depth` key, which a shallow merge
cannot express. The store commits once, the existing rebuild is scheduled, a backup is written, and undo restores the
previous parameter objects (including a removed key) in one commit. Apply does not re-run the geometry solver, but it
re-reads the saved OpenMC project and re-checks blockers before commit. It never writes the OpenMC file.

## Import authoring (gated)

Import authoring uses the same switch and saved-document requirement. It adds editable bodies from a user-chosen
STEP/STP, IGES/IGS, or BREP source; it never downloads, copies, or rewrites the source.

`nuke.cad.inspectImportSource` is read-only. The source must come from the native picker: a model-supplied path is only
a hint, and an arbitrary workspace path still opens the picker unless it is inside the active document's own
`<stem>.parts/` folder. The handler rejects a path outside every workspace root, a symlink, an unsupported extension,
and a source larger than 256 MiB. It delegates to `NukeCadBackendService.inspectImportSource`, which runs
`geometry_service.py --inspect-import` and writes no STEP, tessellation, DAGMC, or cache artifact. The result reports
`documentPath` and optional `documentUnits`, a nested `source` object (`path`, `sourceHash`, `sourceSize`,
`sourceFormat`, `fileUnit`, `effectiveUnit`, `unitScaleFactor`, optional `unitsMessage` and `sourceUnit`), per-solid
`index`, `name`, `faceCount`, `volume`, `bboxMin`, `bboxMax`, and `center` rows, and `warnings`.

`nuke.cad.previewImportBodies` accepts one plan:

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

`strategy` is `single` (one body for all selected solids) or `perSolid` (one body per selected solid). `solidIndexes`
are 1-based source indexes from inspection; `sourceUnit` overrides a misleading file header, and `material` is the
optional in-CAD material tag. The preview re-inspects the authorized source, validates the plan, and stores an import
proposal. It does **not** build geometry, publish a ghost, or mutate `CadDocumentStore`; it opens the **CAD Edit
Review** panel with the source details,
selected solids, body/feature count, units, warnings, and label/material plan. A source outside the document folder is
reported as not self-contained.

`nuke.cad.applyImportBodies` accepts only `{ "proposalId" }`. It re-inspects the same source and rejects a stale
`sourceHash`, `sourceSize`, selection, or plan, writes a backup, then calls
`CadDocumentStore.addImportBodies` once to create the bodies and their import features. The normal rebuild is
scheduled and a session-scoped undo token removes the added bodies and features in one commit. The apply never modifies
the source file. None of the three import ids is on the external MCP read-only allowlist, and the AI flow accepts no
outside-root path or download URL.

## Assembly placement authoring (gated)

Assembly authoring uses the same switch and saved-document requirement for preview and apply; the read-only summary is
available whenever a document is open. It edits an **existing grounded assembly** and never creates one, changes
grounding, or authors mates or connectors. The three ids are:

- `nuke.cad.summarizeAssembly` is read-only and works on the active document; without an assembly it warns and returns
  empty instance/BOM lists. It returns `documentPath`, `hasAssembly`, `instances` (id, part source, optional scale,
  placement, solved matrix, and selector solid ids), `bom` quantity per part/label, `groundedInstanceId`, `overlapCheck`,
  `connectors` (id and instance id), `mates` (id, type, and instance ids), and `warnings`. It works even while the
  authoring switch is off and never builds or mutates.
- `nuke.cad.previewAssemblyChange` accepts one to sixteen actions and runs a real candidate build.
- `nuke.cad.applyAssemblyChange` accepts only a proposal id plus the conditional acknowledgement and commits one
  `applyAssemblyChanges` batch.

Actions:

```json
{
  "changes": [
    {
      "action": "addInstance",
      "part": "body:3",
      "placement": { "position": [0, 0, 10], "orientation": [0, 0, 0, 1] }
    },
    {
      "action": "addInstance",
      "part": "<existing instance part>",
      "id": "instance-4",
      "placement": { "position": [5, 0, 0], "orientation": [0, 0, 0, 1] },
      "scale": 1
    },
    { "action": "removeInstance", "instanceId": "instance-3" },
    {
      "action": "setPlacement",
      "instanceId": "instance-2",
      "placement": { "position": [0, 0, 20], "orientation": [0, 0, 0, 1] }
    }
  ]
}
```

- `addInstance` references an existing embedded `body:<id>` or passes the exact `part` string of an existing instance.
  `placement` (position plus unit quaternion) is required; `id` and a positive uniform or per-axis `scale` are optional.
  It never introduces a new external source.
- `removeInstance` accepts only a non-grounded instance whose part is an embedded body and that has no connector and no
  mate. At least one instance must remain. File-backed parts cannot be removed.
- `setPlacement` writes only `placement` on a grounded or unmated instance. Existing scale, part source, names, mates,
  and connectors stay read-only.
- Unknown or duplicate targets, unsupported parts, grounding changes, connector/mate-dependent removals, a final count
  below one, and more than sixteen actions reject the whole request before a build.

The preview writes a transient candidate beside the source and runs the same display build path with
`exportDagmc: false`, `exportMesh: false`, `useCache: false`, a bounded timeout, and `finally` cleanup. Validation
requires a successful build, no failed features, finite solid/tessellation/bounding-box metrics, selector prefixes that
belong to the final instance ids, and the expected labeled keys for an added instance. The result reports placement rows
(instance, action, before/after position, orientation, and matrix), the BOM count delta, the exact instance-overlap
warnings, and a limitation warning instead of a clean result when the document sets `overlapCheck: false`. Repeated
body ids make the published ghost approximate; the result says so. The data carries `assembly.placements`,
`assembly.bomDelta` (`rows`, `beforeTotal`, `afterTotal`, and grounding), `assembly.collisionWarnings`,
`assembly.overlapCheck`, `assembly.requiresAcknowledgement`, `blockedRegions`, `openmcStatus`, `openmcWarnings`, and the
candidate `build` summary.

Region impact is conditional. Adding an instance and changing a placement never require acknowledgement. Removing the
last instance of a labeled embedded body removes its DAGMC region, so the preview checks the **saved** active OpenMC
project's group and material references and requires acknowledgement. A removed group or material still referenced
blocks Apply; an unsaved project is reported as **not checked** and still requires acknowledgement. Apply never rewrites
the OpenMC project.

`nuke.cad.applyAssemblyChange` accepts only `{ "proposalId", "acknowledgeRegionChanges"? }`, where the acknowledgement
is required only when the preview asked for it. It re-runs the pure planner against the current document, compares the
stored assembly section and action rows, and rejects a stale proposal, revision, or epoch. It then writes a backup,
clears the selection when an instance is removed, commits one `applyAssemblyChanges` store batch, schedules
`nuke.cad.rebuild`, and registers a session-scoped undo token. Undo restores the previous instances and grounding in one
commit. None of the three assembly ids is on the external MCP read-only allowlist; no new source path, part
replacement, rename, scale change on an existing instance, grounded-instance removal, or single-part conversion is
accepted.

## Drawing-sheet settings authoring (gated)

Drawing authoring uses the same switch and saved-document requirement. It changes presentation settings on an
**existing** drawing sheet only; the read-only summary is available whenever a document is open. The three ids are:

- `nuke.cad.summarizeDrawing` is read-only. It returns `documentPath`, `hasDrawings`, `drawingVersion`, sheets (`id`,
  `name`, `size`, `orientation`, `sheetSizeMm`, and `scaleLabel`), flat view rows (`sheetId`, `id`, `kind`,
  `orientation`, `scale`, `scaleLabel`, `position`, `parentId`, and `showHidden`), flat dimension rows (`sheetId`, `id`,
  `kind`, `viewId`, `visible`, optional `value`, `stale`, `targetFeatureIds`, and `targetKinds`), a `titleBlock`
  (`editable: false` with fixed document/sheet/brand/product fields), and `warnings`. It never builds or mutates.
- `nuke.cad.previewDrawingChange` accepts one to sixteen actions on one existing sheet and validates them with the pure
  `prepareDrawingEdit` planner.
- `nuke.cad.applyDrawingChange` accepts only `{ "proposalId" }` and commits one `applyDrawingChanges` batch.

Actions:

```json
{ "action": "setSheetSize", "sheetId": "sheet-1", "size": "A3" }
```

```json
{ "action": "setViewDisplay", "sheetId": "sheet-1", "viewId": "view-1", "scale": 0.5, "showHidden": true }
```

```json
{ "action": "setDimensionVisibility", "sheetId": "sheet-1", "dimensionId": "dimension-1", "visible": false }
```

- `setSheetSize` switches an existing landscape sheet between `A4` and `A3`. A3 to A4 is rejected when any view lies
  outside the A4 bounds; views are never moved. A4 to A3 is allowed.
- `setViewDisplay` changes an existing view's `scale` (finite, `0.001` to `1000`; `1` is 1:1) and/or `showHidden`.
  A non-standard ratio is accepted with a warning. View kind, orientation, parent, section, detail, and position are
  preserved.
- `setDimensionVisibility` writes the dimension's additive `hidden` field through `visible`. Hiding is
  presentation-only: the dimension stays in the document and in the returned dimension list, keeps resolving its value,
  and is omitted from SVG and DXF output. It is never deleted.
- Every action targets the same existing sheet. Duplicate, unknown, unchanged, or cross-sheet targets, an unparsable
  action, and more than sixteen actions reject the whole request. The view and dimension counts must stay unchanged.

The preview is **plan-only**: it validates the whole request against a document clone, stores a drawing proposal, clears
the ghost, and opens the **CAD Edit Review** panel. It creates no transient document or build output, runs no geometry
build, publishes no ghost, and writes no document. The returned `drawing` payload carries the sheet before/after rows,
view rows, dimension rows, and warnings; the `changeSet` names the sheet, view, or dimension path.

Apply re-runs `prepareDrawingEdit` against the live document and compares the sheet, view, dimension, and change rows,
rejecting a stale proposal, revision, or row change. It writes the hidden `.nuke-ai-backup-<document>` snapshot, applies
`CadDocumentStore.applyDrawingChanges({ actions })` once with `markDrawing` so `drawingVersion` increments once, opens
the Drawing Sheet (`nuke.cad.openDrawingSheet`), and refreshes the affected sheet (`nuke.cad.refreshDrawingSheet`). It
never schedules `nuke.cad.rebuild`; the result reports `drawingRefreshScheduled: true` and
`geometryRebuildScheduled: false`. Undo restores the previous drawings, bumps `drawingVersion` again, and refreshes the
sheet. The title block is a fixed read-only template and is never edited. None of the three drawing ids is on the
external MCP read-only allowlist, and the slice accepts no path.

## Review panel and ghost preview

A successful feature, sketch, topology, or assembly preview also publishes the candidate
tessellation to `NukeCadGhostPreviewService` and reveals the **CAD Edit Review**
panel. The viewport renders the candidate as a translucent `cad-ghost` group:
unchanged solids use a cool ghost material, changed solids use a warmer accent.
The group is scene-level, so a real model rebuild never disposes it, and it is
hidden in sketch mode. The ghost is display-only and never participates in
picking, selection, explode, fit, or the document store. An import preview opens
the same panel without a ghost because it builds no candidate geometry. A
drawing preview also opens the panel without a ghost or build, because drawings
are derived linework rather than candidate geometry. An
assembly preview with repeated body ids labels the ghost approximate.

The panel (`CadReviewPanelWidget`, command `nuke.cad.openReviewPanel`) lists the
stored feature, sketch, topology, import, assembly, and drawing proposals with the same `changeSet`
rows, the solid/face/triangle impact, and the build counts. An import proposal
shows the source path, format, hash, size, units, selected solids, strategy,
body/feature count, label/material plan, and self-contained warning instead of a
geometry impact. A drawing proposal shows the sheet size before/after, view
scale and hidden-line rows, dimension shown/hidden rows, and the note that no
geometry rebuild or ghost runs and that dimensions are hidden rather than
deleted; it offers no title-block editor. An assembly proposal adds placement rows (instance, action,
before/after position, orientation, and matrix), the instance/BOM count delta,
exact overlap warnings, the `overlapCheck: false` disclosure, and an approximate
ghost label for repeated body ids. A sketch proposal also
shows its target sketch, affected-sketch count, parameter/dimension rows, and
per-sketch solver status (converged/failed, DOF, conflicting and redundant
counts). A topology proposal shows a **Region impact** section with added,
removed, and changed solids, named regions, and the OpenMC reference status. It
requires the region acknowledgement checkbox before **Apply** is enabled; a
removed region still referenced by the saved active OpenMC project disables
Apply with **Blocked by OpenMC** and the blocking reference named, and an
unsaved project is labelled not checked. The checkbox reads **I understand the
solid and region impact**. Assembly proposals show the same section only when a
removal loses the last instance of a labeled embedded body. **Apply** confirms,
resolves the proposal's apply capability
(`nuke.cad.applyFeatureChange`, `nuke.cad.applySketchChange`,
`nuke.cad.applyTopologyChange`, `nuke.cad.applyImportBodies`,
`nuke.cad.applyAssemblyChange`, or `nuke.cad.applyDrawingChange`) from the
capability registry, and keeps the
returned undo token for **Undo**. **Dismiss** removes the proposal; the ghost
service clears the overlay when the backing proposal disappears. The panel
never writes the document directly; the capability remains the only writer.

## Path scoping

Both `documentPath` and an explicit `outputDirectory` must be absolute and pass
`isWithinWorkspace(path, context.workspaceRoots)` before any build or export.
Relative paths and paths outside every workspace root are rejected with a
message that names the offending path. The active document is checked the same
way as an explicit path; an opened workspace cannot be used to escape its own
roots.

Import sources use the same workspace-root check plus a regular-file (`lstat`,
no symlink) check, a supported `.step`/`.stp`/`.iges`/`.igs`/`.brep` extension,
and a 256 MiB size cap. A path inside the document's own `<stem>.parts/` folder,
or a source this session already inspected, may be inspected without reopening
the picker; any other workspace path is only a hint and reopens it. The AI flow
never downloads or copies the source.

Assembly authoring accepts no new path at all. Instance actions may reference an existing embedded `body:<id>` or
duplicate an existing instance part; removal accepts only an existing embedded-body instance. A file-backed part, a new
external source, a replacement part, or a rename is rejected.

Drawing authoring accepts no new path at all. Actions target an existing sheet, view, or dimension in the active
document, and apply writes only the hidden `.nuke-ai-backup-<document>` snapshot beside the source.

Paths are normalized with `path.resolve` after the scope check, so the backend
and the manifest probe see the same canonical path. Manifest candidates are
built with the platform `path` helpers, which keeps separator handling
consistent with `isWithinWorkspace`.

## Manifest sidecar discovery

The region manifest sidecar is `<stem>.regions.json`, where `<stem>` is the
source file name without its final extension. The capability checks:

1. the source directory;
2. an explicit `outputDirectory` when it differs from the source directory.

A candidate is returned only when `FileService.exists(new URI(candidate))`
reports true. Missing sidecars leave `regionManifestPath` and `regionManifest`
out of the result and add no manifest artifact. The geometry service reads the
sidecar beside the source, and document builds with in-CAD material tags write a
merged sidecar there, so the source directory is the normal location.

## Adding a CAD capability

1. Add a `NukeCapability` factory in `nuke-cad-capabilities.ts` with a
   `nuke.cad.<verbNoun>` id, an object `inputSchema`, a risk level, and a
   `when` predicate when the action needs an active model.
2. Read state from `NukeCadStateManager` and delegate work to
   `NukeCadFrontendService`; do not invoke raw commands or duplicate geometry
   logic.
3. Return `NukeCapabilityResult` with truthful `data`, `warnings`, `artifacts`,
   `nextActions`, or `undoToken` where applicable. Add an `outputSchema` when
   consumers need structured output.
4. Register the capability in `NukeCadCapabilities.registerCapabilities` (or
   the gated authoring contribution) and cover it with a plain-fake unit test.
5. Update this page and the capability table when the contract changes.
