---
name: openmc-studio
description: Summarize, validate, import CAD, run, and poll an OpenMC Studio project. Use when a user asks about the active model, wants to import a DAGMC model, or needs a simulation run and its status.
---

# OpenMC Studio

Use this skill for the active OpenMC project. The normal sequence is summarize, validate, import CAD when needed,
run, then poll status. Do not skip validation before a run.

## Tool names

Capability ids are stable registry identifiers. Chat calls use sanitized tool names: `nuke.openmc.validateProject` is
exposed as `nuke_openmc_validateProject`, and the other ids in this skill follow the same dots-to-underscores mapping.

## Prerequisites

Before starting a run, confirm that:

- the active project is saved, or the user supplies an absolute `workingDirectory` inside the workspace;
- the selected Python environment contains OpenMC, and the project has a cross-sections configuration;
- the model is valid at the standard level;
- any DAGMC geometry has already been imported with its region manifest.

If the environment or cross-section setup is missing, report the specific message from the capability. Do not
attempt to install packages or download nuclear data through chat.

## Summarize the project

Call `nuke_openmc_summarizeProject` with `{}`. It returns the project path, name, description, dirty flag, entity
counts (surfaces, cells, universes, lattices, materials, tallies, meshes), and run settings (mode, particles,
inactive batches, batches, and the DAGMC file when set).

Use the summary to answer questions about project contents and run settings without touching the backend.

## Validate before running

Call `nuke_openmc_validateProject` with:

- `level` - `basic`, `standard` (default), or `strict`.
- optional `checks` - booleans for `geometry`, `materials`, `settings`, `tallies`, and `overlaps`.

A successful validation returns the backend validation result. A failure returns `ok: false` with the validation
issues and an error/warning count. Never call `nuke_openmc_runSimulation` while validation has errors; fix the model
or report the issues to the user first.

## Import a NukeCAD DAGMC model

Call `nuke_openmc_importCad` with:

- `h5mPath` - absolute path to the `.h5m` model inside the workspace.
- `manifestPath` - optional absolute path to the sibling `.regions.json` manifest.

The import creates placeholder materials for manifest names that do not exist yet, sets the DAGMC file and info in
settings, and returns the created material names, warnings, and the parsed manifest. It is a write operation and
asks for confirmation. Use the `dagmcPath` and `regionManifestPath` returned by `nuke_cad_exportDagmc`.

After import, run `nuke_openmc_validateProject` before starting a simulation.

## Run and poll

Call `nuke_openmc_runSimulation` with:

- optional `workingDirectory` - absolute run directory. Defaults to the saved project's directory.
- optional `generateXml` - defaults to `true`.
- optional `threads` - positive integer.
- optional `restartFile` - restart file path.
- optional `mpi` - `{ "enabled": true, "processes": N, "hosts": [...] }` when MPI is requested.

The run validates at the standard level and refuses to start when validation fails or OpenMC is unavailable. It is
an execute-risk tool and asks for confirmation. Run it only with explicit user intent.

Poll `nuke_openmc_getRunStatus` with the same `workingDirectory` and optional `logLines` (1-200, default 40). A
result with `running: false` means no matching active run remains. When a run is active, report the process id,
start time, log path, and the returned log tail.

## Failure recovery

- **Validation errors** - report the issues, fix the model or import, and validate again. Do not start the run.
- **OpenMC unavailable** - report the environment error and ask the user to fix the selected environment.
- **Run did not start** - report the start error from the response. Do not retry blindly.
- **Run status missing** - check the exact working directory and whether the run already completed. A completed
  run may still have produced a statepoint in the run directory.
- **Missing cross sections** - report the cross-section error; do not guess paths.

Write and execute tools ask for confirmation and must be run with explicit user intent.

## Handoff to the visualizer

After a successful run, use `nuke_viz_summarizeStatepoint` with the absolute statepoint path, or
`nuke_viz_openStatepoint` when the user wants to open it in the viewer. Capture only DAGMC viewports with
`nuke_viz_captureView`.
