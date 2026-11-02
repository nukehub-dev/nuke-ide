---
name: nuke-cad
description: Inspect, summarize, and export the active NukeCAD document to DAGMC. Use before an OpenMC import to confirm solid counts, selection, manifest links, and export artifacts.
---

# NukeCAD

Use this skill when the user asks about the active CAD model, needs a DAGMC model for OpenMC, wants to know whether a
CAD document is ready for simulation, or asks for a small feature-parameter, sketch-dimension, or topology-impact
change. Read/export is always available. Feature, sketch, and topology edits are available only when the user enabled
**Nuke CAD: AI Authoring**; new sketch entities, scripts, document parameters not referenced by a sketch, booleans,
add/delete/reorder, lattices, imports, assemblies, and drawings stay in the CAD viewport and Feature Tree.

## Tool names

Capability ids are stable registry identifiers. Chat calls use sanitized tool names: `nuke.cad.summarizeDocument` is
exposed as `nuke_cad_summarizeDocument`, and the other ids in this skill follow the same dots-to-underscores mapping.

## Start with a summary

Call `nuke_cad_summarizeDocument` with `{}` first. It reports the active document path, build success, solid, face,
and triangle counts, the bounding box, warnings, the current selection, and the region manifest.

- Set `{ "includeSolids": true }` only when per-solid detail is needed. The response then adds one entry per
  tessellated solid with its body id, face/edge/triangle counts, and available volume, area, and center of mass.
- If the response says `No CAD document is active.`, ask the user to open or create a `.nuke-cad` document. Do not
  guess a path.
- Treat `warnings` as actionable. A model with failed booleans or overlap warnings is not a clean export candidate.

Use `nuke_cad_inspectSelection` when the user refers to "the selected body" or "this face". It returns the primary
solid, every highlighted solid, and the hidden solid ids. Pass no arguments.

## Edit a feature parameter

Only use this flow when the user asks to change the model and the preview tool is present. If
`nuke_cad_previewFeatureChange` is unavailable, CAD AI authoring is off; point the user to **Settings → Nuke CAD → AI
Authoring** and stop. The document must be saved.

Allowed edits:

- pad/pocket `length` on a blind/default end;
- revolve/groove `angle` between 0 and 360 degrees;
- fillet `radius` on a feature with edges;
- chamfer `distance` in symmetric mode;
- draft `angle` between -90 and 90 degrees;
- linear-pattern `spacing` or circular-pattern `angle`;
- hole `diameter`, and `depth` on a blind hole;
- shell `thickness`.

Call `nuke_cad_previewFeatureChange` with `{ "changes": [{ "featureId", "param", "value" }] }`. It runs a real build,
returns a proposal id, a diff, and an impact summary, and writes nothing. Show the diff and impact before asking to
apply.

Call `nuke_cad_applyFeatureChange` with only `{ "proposalId" }`, and only after explicit confirmation. It writes a
hidden backup, applies the batch, schedules the rebuild, and returns an `undoToken`. If the preview is expired, the
document changed, or the affected feature changed, preview again instead of reusing the old id.

Never invent a feature id or parameter. Ask for the exact feature when the document has more than one candidate.

## Edit a sketch dimension

Only use this flow when the user asks to change a sketch dimension or a document parameter that a sketch references,
and the preview tool is present. If `nuke_cad_previewSketchChange` is unavailable, CAD AI authoring is off; point the
user to **Settings → Nuke CAD → AI Authoring** and stop. The document must be saved.

Start with `nuke_cad_listSketchDimensions` and pass no arguments. It returns the document path, the document parameter
table, and every sketch with its id, name, datum, consumers, and dimensions. Each dimension reports its id, kind,
driving flag, bound parameter, and current value. Never guess a sketch id, dimension id, or parameter name; ask the
user when the target is ambiguous.

Call `nuke_cad_previewSketchChange` with one to eight edits on one target sketch:

```json
{
  "changes": [
    { "sketchId": "fuel-sketch", "dimensionId": "dimension-5", "value": 0.44 },
    { "sketchId": "fuel-sketch", "parameterName": "fuelRadius", "value": 0.44 }
  ]
}
```

Only existing driving dimensions and document parameters referenced by that sketch are accepted.

- A **literal driving dimension** changes only that sketch, and the diff names the sketch and dimension.
- A **parameter-bound dimension** cascades: the preview updates the document parameter and re-solves every sketch and
  curve that references it. The diff lists the parameter and every affected dimension, so show the full impact before
  applying.
- A **reference dimension** (`driving: false`) cannot be edited. Ask the user to change the driving geometry instead.
- Rejected previews name the cause: a missing sketch, dimension, or parameter, a parameter the sketch does not
  reference, a value that does not change anything, or a solve that conflicts. A conflicting solve is never applied.
  Fix the request or ask the user instead of retrying the same preview.

The preview runs a real build, preserves topology, selector, and region coverage, opens the **CAD Edit Review**
panel, and shows the candidate as a display-only ghost. It writes nothing and returns a proposal id, diff, impact, and
solver status.

Call `nuke_cad_applySketchChange` with only `{ "proposalId" }`, and only after explicit confirmation. It re-checks the
document revision and proposal freshness, writes the parameter and every affected sketch in one atomic commit,
rebuilds, and returns an `undoToken`. If the preview expired or the document changed, preview again instead of reusing
the old id. Undo from the card or the review panel restores the parameter and sketches together.

## Change topology-impacting features

Only use this flow when the user asks to change a hole's blind/through mode or a linear/circular pattern count, and the
preview tool is present. If `nuke_cad_previewTopologyChange` is unavailable, CAD AI authoring is off; point the user to
**Settings → Nuke CAD → AI Authoring** and stop. The document must be saved.

Start with `nuke_cad_summarizeDocument` and `nuke_cad_inspectSelection` to confirm the active document and body, then
ask the user for the feature id shown in the Feature Tree. Never guess a feature id, and never use a body or solid id as
a feature id.

Two actions are accepted on existing features, one to eight per preview:

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

- A blind hole stores a positive `depth`; a through hole has no `depth` key. Apply removes the key when switching to
  through.
- `patternCount` includes the original instance. Only a disjoint additive pattern adds solids; an overlapping pattern
  may change only faces or volume.
- Only existing `hole`, `linearPattern`, and `circularPattern` features are editable. A modeled thread cannot become
  through, and a partial circular sweep keeps a count of at least two.

The preview runs a real build and reports solid, face, and triangle deltas, added, removed, and changed solids, and
named regions. It also checks the **saved** active OpenMC project for DAGMC group and material references to changed or
removed regions. Region impact is about DAGMC group/material identity, not only selector keys. Do not call an edit safe
because the geometry builds: show the region impact.

A successful preview opens the **CAD Edit Review** panel with a Region impact section. The user must tick the region
acknowledgement checkbox before **Apply** is enabled; if a removed region is still referenced by OpenMC, **Apply** stays
disabled. An unsaved project is reported as **not checked** and still requires the acknowledgement. Apply never rewrites
the OpenMC project.

Call `nuke_cad_applyTopologyChange` with only `{ "proposalId", "acknowledgeRegionChanges": true }`, and only after
explicit confirmation of the shown region impact. It writes one exact-replace document commit, rebuilds, and returns an
`undoToken`. Undo restores the previous feature parameters, including a removed `depth` key, in one commit. If the
preview expired or the document changed, preview again instead of reusing the old id.

## Inspect before export

Always summarize the active document before calling `nuke_cad_exportDagmc`. The summary confirms that the model
that will be exported is the model the user is discussing.

The export inputs are:

- `documentPath` - absolute path to a `.nuke-cad`, `.py`, `.step`, `.stp`, or `.brep` source. Defaults to the
  active document.
- `outputDirectory` - absolute output directory. Defaults to the source directory.
- `meshEngine` - `gmsh` or `netgen`.
- `meshSize` - non-negative target element size.
- `lengthScale` - non-negative export scale. `1.0` keeps model units; `0.01` converts cm to m.

Only pass `documentPath` when exporting a different source than the active document. Only pass `outputDirectory`
when the user asked for a specific location. Leave meshing options unset unless the user requested them.

`nuke_cad_exportDagmc` is an execute-risk tool: it rebuilds geometry and writes STEP, DAGMC, cache, and manifest
files. It asks for confirmation. Run it only with explicit user intent, such as "export this model to DAGMC".

## Path rules

Every path must be absolute and inside a workspace root. Relative paths and paths outside the workspace are
rejected before the build starts. The active document is checked the same way, so an opened workspace cannot be
used to escape its roots.

## DAGMC sidecar

A successful export returns `dagmcPath`, `stepPath` when generated, `regionManifestPath` when found, and the parsed
`regionManifest`. It also returns file artifacts for the DAGMC model, the region manifest, and the STEP model.

Keep the `.h5m` file and its sibling `.regions.json` manifest together. The manifest carries the material names and
links that OpenMC Studio needs during import. If the manifest is missing, report that clearly instead of inventing
material assignments.

## Failure recovery

- **No active document** - open a document or provide an absolute `documentPath`.
- **Unsupported source** - use `.nuke-cad`, `.py`, `.step`, `.stp`, or `.brep`.
- **Path rejected** - move the source or output inside the workspace, or ask the user for a valid path.
- **Build failed** - read `warnings` and the failure message, then inspect the document in the CAD UI. Do not retry
  the same export unchanged.
- **DAGMC export failed** - the STEP or build may still have succeeded. Report the partial outputs and the
  `dagmcWarnings`; do not claim a usable DAGMC model exists.

## Handoff to OpenMC

When export succeeds, the next step is `nuke_openmc_importCad` with:

- `h5mPath` = the exported `dagmcPath`
- `manifestPath` = the exported `regionManifestPath` when present

Both values must be absolute workspace paths. The import is a write operation and asks for confirmation. After
import, validate the project with `nuke_openmc_validateProject` before starting a run.

## Boundaries

- Do not author geometry beyond the scalar feature-edit, sketch-dimension, and topology-impact flows. New sketch
  entities, scripts, document parameters not referenced by a sketch, booleans, add/delete/reorder, lattices, imports,
  assemblies, and drawings stay in the CAD viewport or Feature Tree.
- Do not apply a feature, sketch, or topology change without an explicit confirmation, and never send CAD authoring
  tools through MCP.
- Do not claim a model is simulation-ready from a summary alone; export and import are separate verified steps.
- Do not read or quote files outside the workspace.
