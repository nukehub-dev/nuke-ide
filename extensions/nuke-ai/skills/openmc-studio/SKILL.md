---
name: openmc-studio
description: Summarize, validate, edit settings, import CAD, run, and poll an OpenMC Studio project. Use when a user asks about the active model, wants to change run settings safely, import a DAGMC model, or needs a simulation run and its status.
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

## Preview, apply, and undo settings

Change basic run settings only through the preview, apply, and undo flow. Never describe a setting as changed until an
apply result confirms it.

1. **Preview** with `nuke_openmc_previewSettings`:

   - `changes` - 1 to 20 objects with a supported `path` and its proposed `value`.
   - optional `summary` - a short description shown with the diff.

   The preview is read-only. It validates every path and value, rejects the whole request on any error, rejects a
   request that changes nothing, and returns a `changeSet` diff plus the apply capability. Show every changed path with
   its before and after value.

2. **Apply** with `nuke_openmc_applySettings` and `{ "proposalId": "<id from the preview>" }`. Apply only after the
   user explicitly confirms the shown diff. The capability requires confirmation and rejects a stale proposal when the
   settings changed since the preview; preview again instead of guessing values. The apply result returns the same
   change set plus an `undoToken`.

3. **Undo** reports whether the change can be undone in this session. The user confirms **Undo** in the card or chat
   before the reverse handler runs. An undo token is one-shot: a redeemed, expired, or unknown token returns
   `This change can no longer be undone.` Undo state is in memory only and does not survive an IDE restart or reload.

Supported paths:

| Path                      | Rule                                                      |
| ------------------------- | --------------------------------------------------------- |
| `run.particles`           | integer >= 1                                              |
| `run.inactive`            | integer >= 0; only when the current run mode has inactive |
| `run.batches`             | integer >= 1                                              |
| `seed`                    | integer >= 0                                              |
| `threads`                 | integer >= 1                                              |
| `verbosity`               | integer 1 to 10                                           |
| `energyMode`              | `continuous-energy` or `multigroup`                       |
| `photonTransport`         | boolean                                                   |
| `electronTreatment`       | `led` or `ttb`                                            |
| `atomicRelaxation`        | boolean                                                   |
| `sourceRejectionFraction` | number from 0 to 1                                        |

Materials, tallies, sources, geometry, and advanced settings are out of scope for this flow. Report the rejection
message instead of trying another path.

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
