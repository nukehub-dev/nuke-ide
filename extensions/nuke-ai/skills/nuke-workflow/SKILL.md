---
name: nuke-workflow
description: Run the end-to-end CAD to DAGMC to OpenMC to visualizer workflow with NukeAI. Use when a user asks how to go from a CAD model to simulation results, or needs the exact capability handoff arguments.
---

# Nuke End-to-End Workflow

This skill ties the domain capabilities together. The path is:

CAD document -> DAGMC export -> OpenMC import -> validation -> run -> status -> statepoint -> capture.

Each step is a separate capability. Do not skip a verification step to save time.

## Tool names

Capability ids are stable registry identifiers. Chat calls use sanitized tool names: `nuke.cad.summarizeDocument` is
exposed as `nuke_cad_summarizeDocument`, and every id below follows the same dots-to-underscores mapping.

## 1. Confirm the CAD model

Call `nuke_cad_summarizeDocument` with `{}`.

Check `success`, `solidCount`, warnings, and the active `documentPath`. Add `{ "includeSolids": true }` when you need
per-solid detail. Use `nuke_cad_inspectSelection` with `{}` when the user refers to a specific selected body or face.

If no CAD document is active, stop and ask the user to open one.

## 2. Export DAGMC

Call `nuke_cad_exportDagmc` with:

```json
{
  "documentPath": "/workspace/model.nuke-cad",
  "outputDirectory": "/workspace/export",
  "meshSize": 0.2
}
```

Only include the fields the user requested; `documentPath` defaults to the active document and `outputDirectory`
defaults to the source directory. This is an execute-risk tool and asks for confirmation.

From the result, keep:

- `dagmcPath` - the exported `.h5m` file.
- `regionManifestPath` - the sibling `.regions.json` manifest when present.

If `dagmcPath` is missing or the export failed, stop. Do not import a partial model.

## 3. Import into OpenMC Studio

Call `nuke_openmc_importCad` with:

```json
{
  "h5mPath": "/workspace/export/model.h5m",
  "manifestPath": "/workspace/export/model.regions.json"
}
```

Both paths must be absolute and inside a workspace root. The import is a write operation and asks for confirmation.
It creates placeholder materials for new manifest names and points settings at the DAGMC geometry.

## 4. Validate

Call `nuke_openmc_validateProject` with `{ "level": "standard" }`. Add a `checks` object only when the user wants a
narrower inspection.

If validation fails, report the errors and do not run. Fixing may require the user to edit geometry, materials,
settings, or tallies in OpenMC Studio.

## 5. Run

Call `nuke_openmc_runSimulation` with:

```json
{
  "workingDirectory": "/workspace/run",
  "generateXml": true,
  "threads": 4
}
```

`workingDirectory` is optional only when the project is saved; it then defaults to the project directory. The run
validates again and refuses to start on validation errors or a missing OpenMC environment. It is an execute-risk
tool and asks for confirmation. Start it only with explicit user intent.

The response includes the process id, generated files, and warnings.

## 6. Poll status

Call `nuke_openmc_getRunStatus` with `{ "workingDirectory": "/workspace/run", "logLines": 40 }`.

A run that is still active returns its process id, start time, log path, and log tail. `{ "running": false }` means
no matching active run remains. A completed run usually leaves a statepoint such as
`/workspace/run/statepoint.100.h5`; locate it from the run output or ask the user for the path.

## 7. Summarize results

Call `nuke_viz_summarizeStatepoint` with `{ "filePath": "/workspace/run/statepoint.100.h5" }`.

Report batches, k-effective and its standard deviation when present, and the tallies with their scores and mesh
status. Use `nuke_viz_openStatepoint` with the same absolute `filePath` when the user wants to inspect results in
the viewer. Opening is a write-risk tool and asks for confirmation.

## 8. Capture evidence

Call `nuke_viz_captureView` with `{ "format": "png", "caption": "DAGMC model" }`.

Only DAGMC viewports are captured. The image is the real current viewport, so it reflects the camera, clipping,
selection, color-by, and visibility state, and includes only visible geometry.

## Stop conditions

Stop the workflow and report the specific failure when:

- no CAD document is active;
- the DAGMC export fails or produces no `.h5m` file;
- the manifest is required but missing;
- the OpenMC import fails;
- validation reports errors;
- OpenMC is unavailable in the selected environment;
- the simulation fails to start or the status cannot be found.

Never claim a later step succeeded when an earlier step failed. Never invent paths, material names, or results.

## Confirmation rule

Read tools (`nuke_cad_summarizeDocument`, `nuke_cad_inspectSelection`, `nuke_openmc_summarizeProject`,
`nuke_openmc_validateProject`, `nuke_openmc_getRunStatus`, `nuke_viz_summarizeStatepoint`,
`nuke_viz_captureView`) follow the IDE's read-tool confirmation preference and may be marked Always allow.

Write and execute tools (`nuke_cad_exportDagmc`, `nuke_openmc_importCad`, `nuke_openmc_runSimulation`,
`nuke_viz_openStatepoint`) never inherit a global always-allow; they ask for confirmation and must be run with explicit
user intent.
