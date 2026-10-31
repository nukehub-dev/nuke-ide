# OpenMC AI Capabilities

`src/browser/capabilities/openmc-capabilities.ts` registers OpenMC Studio project actions with the nuke-core capability registry. The handlers orchestrate the existing state manager, backend service, XML generator, environment service, and simulation runner; they never implement XML generation, validation, or run logic themselves. `OpenMCContextContribution` publishes the active project as `activeOpenmcProject`.

## Capabilities

| ID                             | Risk      | Inputs                                                                          | Outputs                                                                                                   |
| ------------------------------ | --------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `nuke.openmc.summarizeProject` | `read`    | `{}`                                                                            | Project path, name, description, dirty flag, entity counts, and run settings.                             |
| `nuke.openmc.validateProject`  | `read`    | `level` (`basic`/`standard`/`strict`), optional `checks` booleans               | The backend `ValidationResult`; `ok` mirrors `valid`, and failures summarize error/warning counts.        |
| `nuke.openmc.importCad`        | `write`   | Absolute `h5mPath`, optional absolute `manifestPath`                            | DAGMC file/info, manifest material names, created placeholder names, warnings, and parsed manifest.       |
| `nuke.openmc.runSimulation`    | `execute` | Optional `workingDirectory`, `generateXml`, `threads`, `restartFile`, and `mpi` | Working directory, process ID, generated XML files, warnings, and a `getRunStatus` follow-up.             |
| `nuke.openmc.getRunStatus`     | `read`    | Optional exact `workingDirectory`, `logLines` (1-200, default 40)               | `running: false`, or the matching run's process ID, directory, start time, log path, and capped log tail. |
| `nuke.openmc.diagnoseProject`  | `read`    | `{}`                                                                            | Validation, environment, cross-section, and DAGMC findings plus `valid`, `readyToRun`, and counts.        |
| `nuke.openmc.diagnoseRun`      | `read`    | Optional exact `workingDirectory`, `logLines` (1-200, default 80)               | Active-run identity, capped log tail, error/warning counts, and classified log findings.                  |

`importCad` and `runSimulation` require confirmation. Every capability is enabled regardless of whether a project is saved; handlers reject paths outside the workspace roots instead of hiding the action. The two diagnostics are read-only and never write files, change project state, or start/stop runs.

## Rules

- **Workspace paths** — `importCad` and `runSimulation` accept only absolute paths inside a workspace root. `runSimulation` defaults to the parent directory of the saved project file and fails with `Save the project or provide a workingDirectory.` when neither exists.
- **Environment readiness** — `runSimulation` refreshes the OpenMC environment status first and refuses to start when OpenMC is not installed in the selected environment.
- **Validation before run** — `runSimulation` calls `validateState` with level `standard` and returns the issues without generating XML or starting a process when the model is invalid.
- **XML generation** — unless `generateXml` is `false`, the run generates materials and settings XML, geometry when the model has cells or a `dagmcFile`, tallies when any exist, and no plots. The output directory is the run directory, `projectDirectory` is the project file's parent, and the nuke-core cross-sections path is passed for element expansion. The simulation runner supplies `OPENMC_CROSS_SECTIONS`, `OPENMC_CHAIN_FILE`, and `OPENMC_MG_CROSS_SECTIONS` from the same preferences as the dashboard.
- **CAD import** — `importCad` delegates to `importNukeCAD`, creates placeholder materials only for manifest names that are not already present, and fills them with density `1.0 g/cm3`, empty nuclides and thermal scattering, plus `nukeCadMaterialId`/`nukeCadParentId` links when the manifest provides them. It then writes `dagmcFile` and `dagmcInfo` into settings.
- **Run status** — a provided directory matches exactly; without one, only a single active run is reported. `logTail` holds the last `logLines` lines and never exceeds 16 KiB. Poll with `nuke.openmc.getRunStatus` after `runSimulation` returns a process ID.
- **Project diagnosis** — `diagnoseProject` validates at the `standard` level, refreshes the environment, checks the nuke-core cross-sections path through `FileService`, and checks a configured DAGMC file through `checkFileExists` (project-relative paths resolve against the saved project). `ok` stays true when findings exist; only a backend validation failure returns `ok: false`. Unset cross sections warn without blocking `readyToRun`, while missing cross sections, a missing DAGMC file, or validation errors do.
- **Run diagnosis** — `diagnoseRun` uses the only active run, or an exact `workingDirectory` match, and asks for a directory when several runs are active. It classifies lost particles, overlaps, missing cross sections, error/warning lines, convergence, and MPI failures from the log tail; a log read failure returns `ok: false`. Both diagnostics cap findings at 20 and append an info `findings-truncated` entry.

The capability run path forwards only the explicit `threads`, `restartFile`, and `mpi` inputs. The dashboard additionally passes project-level threads/MPI defaults, particle-track `-t`, and CMFD driver configuration; those remain dashboard-only.
