# OpenMC AI Capabilities

`src/browser/capabilities/openmc-capabilities.ts` registers OpenMC Studio project actions with the nuke-core capability registry. The handlers orchestrate the existing state manager, backend service, XML generator, environment service, and simulation runner; they never implement XML generation, validation, or run logic themselves. `OpenMCContextContribution` publishes the active project as `activeOpenmcProject`.

## Capabilities

| ID                                  | Risk      | Inputs                                                                          | Outputs                                                                                                   |
| ----------------------------------- | --------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `nuke.openmc.summarizeProject`      | `read`    | `{}`                                                                            | Project path, name, description, dirty flag, entity counts, and run settings.                             |
| `nuke.openmc.validateProject`       | `read`    | `level` (`basic`/`standard`/`strict`), optional `checks` booleans               | The backend `ValidationResult`; `ok` mirrors `valid`, and failures summarize error/warning counts.        |
| `nuke.openmc.importCad`             | `write`   | Absolute `h5mPath`, optional absolute `manifestPath`                            | DAGMC file/info, manifest material names, created placeholder names, warnings, and parsed manifest.       |
| `nuke.openmc.runSimulation`         | `execute` | Optional `workingDirectory`, `generateXml`, `threads`, `restartFile`, and `mpi` | Working directory, process ID, generated XML files, warnings, and a `getRunStatus` follow-up.             |
| `nuke.openmc.getRunStatus`          | `read`    | Optional exact `workingDirectory`, `logLines` (1-200, default 40)               | `running: false`, or the matching run's process ID, directory, start time, log path, and capped log tail. |
| `nuke.openmc.diagnoseProject`       | `read`    | `{}`                                                                            | Validation, environment, cross-section, and DAGMC findings plus `valid`, `readyToRun`, and counts.        |
| `nuke.openmc.diagnoseRun`           | `read`    | Optional exact `workingDirectory`, `logLines` (1-200, default 80)               | Active-run identity, capped log tail, error/warning counts, and classified log findings.                  |
| `nuke.openmc.previewSettings`       | `read`    | `changes` (1-20 `{ path, value }`), optional `summary`                          | Proposal id, summary, and labelled before/after diff plus a `changeSet` for `applySettings`.              |
| `nuke.openmc.applySettings`         | `write`   | `proposalId` from `previewSettings`                                             | Applied diff, a `changeSet` without `applyCapability`, an `undoToken`, and a diagnosis follow-up.         |
| `nuke.openmc.previewMaterialChange` | `read`    | `actions` (1-20 update/add/remove), optional `summary`                          | Proposal id, summary, and labelled material diff plus a `changeSet` for `applyMaterialChange`.            |
| `nuke.openmc.applyMaterialChange`   | `write`   | `proposalId` from `previewMaterialChange`                                       | Applied diff, a `changeSet` without `applyCapability`, an `undoToken`, and a diagnosis follow-up.         |
| `nuke.openmc.previewTallyChange`    | `read`    | `actions` (1-20 update/add/remove), optional `summary`                          | Proposal id, summary, and labelled tally diff plus a `changeSet` for `applyTallyChange`.                  |
| `nuke.openmc.applyTallyChange`      | `write`   | `proposalId` from `previewTallyChange`                                          | Applied diff, a `changeSet` without `applyCapability`, an `undoToken`, and a diagnosis follow-up.         |

`importCad`, `runSimulation`, and every apply capability require confirmation. Every capability is enabled regardless of whether a project is saved; handlers reject paths outside the workspace roots instead of hiding the action. The two diagnostics are read-only and never write files, change project state, or start/stop runs. Previews are read-only and never mutate project state.

## Change proposals

`OpenMCChangeProposalService` (`src/browser/capabilities/openmc-change-proposal-service.ts`) is the shared in-memory store for previewed edits. Each proposal carries a domain `scope` (`settings`, `materials`, `tallies`, or `project`), a summary, the `NukeChange` diff, and scoped `before`/`after` snapshots. The store keeps at most twenty live proposals, expires them after ten minutes, prunes on every create, and deep-clones snapshots on create and on read, so later state edits and callers cannot mutate a stored preview. `get` and `has` drop expired entries, `remove` deletes one, and `scopeError` rejects a proposal from another domain with `Proposal <id> is for <scope>, not <scope>.` Apply capabilities check the scope before consuming a proposal. Materials, tallies, and project metadata previews reuse the same store by selecting their scope and storing only their own scoped snapshot.

## Safe settings edits

`previewSettings` validates and diffs basic run/settings paths, then stores a `settings`-scoped proposal with the current settings as `before` and the computed settings as `after` (ten-minute TTL, at most twenty live proposals). `applySettings` rejects a missing or expired proposal, rejects a proposal from another scope, rejects a stale preview with `Settings changed since the preview. Preview again.`, applies only the previewed paths to the current settings through `OpenMCStateManager.updateSettings`, removes the proposal, and registers an in-memory undo. Undo verifies that every changed path still equals the applied value, restores only those paths on the current settings, and returns `Settings change undone.`; undo does not survive an IDE restart.

Supported paths only:

| Path                      | Rule                                                              |
| ------------------------- | ----------------------------------------------------------------- |
| `run.particles`           | Integer >= 1                                                      |
| `run.inactive`            | Integer >= 0; only when the current run mode has inactive batches |
| `run.batches`             | Integer >= 1                                                      |
| `seed`                    | Integer >= 0                                                      |
| `threads`                 | Integer >= 1                                                      |
| `verbosity`               | Integer 1-10                                                      |
| `energyMode`              | `continuous-energy` or `multigroup`                               |
| `photonTransport`         | Boolean                                                           |
| `electronTreatment`       | `led` or `ttb`                                                    |
| `atomicRelaxation`        | Boolean                                                           |
| `sourceRejectionFraction` | Number 0-1                                                        |

Sources, output, random ray, CMFD, and geometry are deliberately unsupported. A request with any unknown path, invalid value, duplicate path, or unchanged value is rejected as a whole. Material and tally edits use the separate flows below.

## Safe material edits

`previewMaterialChange` accepts 1-20 actions: `{ action: 'update', materialId, updates }`, `{ action: 'add', material }`, or `{ action: 'remove', materialId }`. Updates are limited to `name`, `density`, `densityUnit`, `nuclides`, `thermalScattering`, `color`, `temperature`, `volume`, `isDepletable`, `ncrystalCfg`, and `isotropic`; ids, `macroscopic`, and CAD provenance are read-only. Adds receive `getNextMaterialId()` and require a unique name. The preview rejects duplicate actions, no-op sets, invalid density/unit/volume/temperature, malformed nuclides or thermal scattering, and NCrystal combined with thermal scattering. It stores a `materials` proposal with before/after material arrays and per-field `materials.<id>.<field>` changes plus full `materials.<id>` add/remove snapshots. Apply preflights every change against current materials, calls `updateMaterial` once per material, `addMaterial`, or `removeMaterial`, preserves unrelated materials, and registers a path-scoped undo. Removing a material does not rewrite cell or tally references.

## Safe tally edits

`previewTallyChange` accepts 1-20 actions: `{ action: 'update', tallyId, updates }`, `{ action: 'add', tally }`, or `{ action: 'remove', tallyId }`. Updates are limited to `name`, `scores`, `nuclides`, `estimator`, `multiplyDensity`, and `higherMoments`; filters, triggers, and derivatives are preserved and rejected as edits. Adds validate scores through `scores-catalog.ts` (`getScoreEntry` or numeric `MT<n>`), default `nuclides` to `['total']`, shallow-validate filters against `filters-catalog.ts`, reject caller ids, assign `getNextTallyId()`, and require a unique name when provided. The preview stores a `tallies` proposal with per-field `tallies.<id>.<field>` changes and full add/remove snapshots. Apply preflights every change against current tallies, calls `updateTally` once per tally, `addTally`, or `removeTally`, preserves unrelated tallies, and registers a path-scoped undo.

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
