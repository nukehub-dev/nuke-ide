# CAD AI Capabilities

`nuke-cad` publishes read and export actions through the neutral capability
registry owned by `nuke-core`. AI consumers, MCP servers, and other extensions
read the same `NukeCapability` objects without importing CAD widgets.

The implementation lives in
`src/browser/capabilities/nuke-cad-capabilities.ts`:

- `NukeCadCapabilities` implements `NukeCapabilityContribution` and registers
  the four capabilities below.
- `NukeCadContextContribution` publishes `activeCadDocument` from
  `NukeCadStateManager.scriptPath` and forwards `onModelChange`.
- Both are bound in `nuke-cad-frontend-module.ts`. The nuke-core frontend module
  owns the contribution providers, registry, and context service.

The handlers never reimplement geometry or export logic. Summaries read the
active `NukeCadStateManager` model; export delegates to
`NukeCadFrontendService.buildDocument` or `buildGeometry`.

## Capabilities

| ID                           | Risk      | Active model required | Purpose                                                     |
| ---------------------------- | --------- | --------------------- | ----------------------------------------------------------- |
| `nuke.cad.summarizeDocument` | `read`    | Yes                   | Build counts, selection, manifest, and solid summaries      |
| `nuke.cad.inspectSelection`  | `read`    | Yes                   | Primary solid, selected solids, and hidden solid ids        |
| `nuke.cad.diagnoseModel`     | `read`    | Yes                   | Build, manifest, selection, and per-solid geometry findings |
| `nuke.cad.exportDagmc`       | `execute` | No                    | Build a source file and export DAGMC + region manifest      |

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
4. Register the capability in `NukeCadCapabilities.registerCapabilities` and
   cover it with a plain-fake unit test in
   `nuke-cad-capabilities.test.ts`.
5. Update this page and the capability table when the contract changes.
