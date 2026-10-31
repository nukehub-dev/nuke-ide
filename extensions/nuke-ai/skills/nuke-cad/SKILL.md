---
name: nuke-cad
description: Inspect, summarize, and export the active NukeCAD document to DAGMC. Use before an OpenMC import to confirm solid counts, selection, manifest links, and export artifacts.
---

# NukeCAD

Use this skill when the user asks about the active CAD model, needs a DAGMC model for OpenMC, or wants to know
whether a CAD document is ready for simulation. Geometry authoring stays in the CAD viewport and Feature Tree;
this capability set only reads the active model and exports it.

## Start with a summary

Call `nuke.cad.summarizeDocument` with `{}` first. It reports the active document path, build success, solid, face,
and triangle counts, the bounding box, warnings, the current selection, and the region manifest.

- Set `{ "includeSolids": true }` only when per-solid detail is needed. The response then adds one entry per
  tessellated solid with its body id, face/edge/triangle counts, and available volume, area, and center of mass.
- If the response says `No CAD document is active.`, ask the user to open or create a `.nuke-cad` document. Do not
  guess a path.
- Treat `warnings` as actionable. A model with failed booleans or overlap warnings is not a clean export candidate.

Use `nuke.cad.inspectSelection` when the user refers to "the selected body" or "this face". It returns the primary
solid, every highlighted solid, and the hidden solid ids. Pass no arguments.

## Inspect before export

Always summarize the active document before calling `nuke.cad.exportDagmc`. The summary confirms that the model
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

`nuke.cad.exportDagmc` is an execute-risk tool: it rebuilds geometry and writes STEP, DAGMC, cache, and manifest
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

When export succeeds, the next step is `nuke.openmc.importCad` with:

- `h5mPath` = the exported `dagmcPath`
- `manifestPath` = the exported `regionManifestPath` when present

Both values must be absolute workspace paths. The import is a write operation and asks for confirmation. After
import, validate the project with `nuke.openmc.validateProject` before starting a run.

## Boundaries

- Do not author, edit, or delete geometry through this skill. Direct the user to the CAD viewport or Feature Tree.
- Do not claim a model is simulation-ready from a summary alone; export and import are separate verified steps.
- Do not read or quote files outside the workspace.
