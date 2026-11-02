# CAD AI Capabilities

`nuke-cad` publishes read and export actions through the neutral capability
registry owned by `nuke-core`. AI consumers, MCP servers, and other extensions
read the same `NukeCapability` objects without importing CAD widgets.

The implementation lives in
`src/browser/capabilities/nuke-cad-capabilities.ts` (read/export) and
`src/browser/capabilities/nuke-cad-authoring-capabilities.ts` (the gated
feature and sketch authoring slices):

- `NukeCadCapabilities` implements `NukeCapabilityContribution` and registers
  the read/export capabilities below.
- `NukeCadAuthoringCapabilities` registers the feature preview/apply pair and
  the sketch dimension list/preview/apply trio. All authoring capabilities are
  default-off behind `nukeCad.aiAuthoringEnabled`.
- `NukeCadContextContribution` publishes `activeCadDocument` from
  `NukeCadStateManager.scriptPath` and forwards `onModelChange`.
  `NukeCadAuthoringContextContribution` additionally refreshes the tool set when
  the authoring switch changes.
- All are bound in `nuke-cad-frontend-module.ts`. The nuke-core frontend module
  owns the contribution providers, registry, and context service.

The handlers never reimplement geometry or export logic. Summaries read the
active `NukeCadStateManager` model; export delegates to
`NukeCadFrontendService.buildDocument` or `buildGeometry`; preview builds a
transient candidate document through the same `buildDocument` path.

## Capabilities

| ID                              | Risk      | Active model required | Purpose                                                          |
| ------------------------------- | --------- | --------------------- | ---------------------------------------------------------------- |
| `nuke.cad.summarizeDocument`    | `read`    | Yes                   | Build counts, selection, manifest, and solid summaries           |
| `nuke.cad.inspectSelection`     | `read`    | Yes                   | Primary solid, selected solids, and hidden solid ids             |
| `nuke.cad.diagnoseModel`        | `read`    | Yes                   | Build, manifest, selection, and per-solid geometry findings      |
| `nuke.cad.listSketchDimensions` | `read`    | Document only         | Document parameters and per-sketch dimensions, datums, consumers |
| `nuke.cad.previewFeatureChange` | `read`    | Yes, saved            | Validate scalar feature edits with a real build and diff them    |
| `nuke.cad.applyFeatureChange`   | `execute` | Yes, saved            | Apply a previewed proposal, rebuild, and register undo           |
| `nuke.cad.previewSketchChange`  | `read`    | Yes, saved            | Validate sketch-dimension or parameter edits with a real build   |
| `nuke.cad.applySketchChange`    | `execute` | Yes, saved            | Apply a sketch proposal atomically, rebuild, and register undo   |
| `nuke.cad.exportDagmc`          | `execute` | No                    | Build a source file and export DAGMC + region manifest           |

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
free-form sketch creation, new sketch entities/constraints/dimensions, topology, and import authoring remain out of
scope.

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

## Review panel and ghost preview

A successful preview also publishes the candidate tessellation to
`NukeCadGhostPreviewService` and reveals the **CAD Edit Review** panel. The
viewport renders the candidate as a translucent `cad-ghost` group: unchanged
solids use a cool ghost material, changed solids use a warmer accent. The group
is scene-level, so a real model rebuild never disposes it, and it is hidden in
sketch mode. The ghost is display-only and never participates in picking,
selection, explode, fit, or the document store.

The panel (`CadReviewPanelWidget`, command `nuke.cad.openReviewPanel`) lists the
stored feature and sketch proposals with the same `changeSet` rows, the
solid/face/triangle impact, and the build counts. A sketch proposal also shows
its target sketch, affected-sketch count, parameter/dimension rows, and
per-sketch solver status (converged/failed, DOF, conflicting and redundant
counts). **Apply** confirms, resolves the proposal's apply capability
(`nuke.cad.applyFeatureChange` or `nuke.cad.applySketchChange`) from the
capability registry, and keeps the returned undo token for **Undo**.
**Dismiss** removes the proposal; the ghost service clears the overlay when the
backing proposal disappears. The panel never writes the document directly; the
capability remains the only writer.

## Path scoping

Both `documentPath` and an explicit `outputDirectory` must be absolute and pass
`isWithinWorkspace(path, context.workspaceRoots)` before any build or export.
Relative paths and paths outside every workspace root are rejected with a
message that names the offending path. The active document is checked the same
way as an explicit path; an opened workspace cannot be used to escape its own
roots.

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
