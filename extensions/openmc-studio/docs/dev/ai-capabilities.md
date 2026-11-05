# OpenMC AI Capabilities

`src/browser/capabilities/openmc-capabilities.ts` registers OpenMC Studio project actions with the nuke-core capability registry. The handlers orchestrate the existing state manager, backend service, XML generator, environment service, and simulation runner; they never implement XML generation, validation, or run logic themselves. `OpenMCContextContribution` publishes the active project as `activeOpenmcProject`.

## Capabilities

| ID                                   | Risk      | Inputs                                                                          | Outputs                                                                                                                                   |
| ------------------------------------ | --------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `nuke.openmc.summarizeProject`       | `read`    | `{}`                                                                            | Project path, name, description, author, dirty flag, entity counts, and run settings.                                                     |
| `nuke.openmc.summarizeMaterials`     | `read`    | `{}`                                                                            | Up to 200 materials with ids, names, density/unit, nuclide count (no list), depletion, volume, temperature, and CAD provenance.           |
| `nuke.openmc.summarizeTallies`       | `read`    | `{}`                                                                            | Up to 200 tallies with ids, names, scores, estimator, filter types with sample bins and counts, nuclides, and moment flags.               |
| `nuke.openmc.summarizeGeometry`      | `read`    | Optional `includeDagmc` (default `true`)                                        | Counts and capped ids/types for surfaces, cells, universes, lattices, DAGMC volumes with materials, and up to 20 CSG findings.            |
| `nuke.openmc.validateProject`        | `read`    | `level` (`basic`/`standard`/`strict`), optional `checks` booleans               | The backend `ValidationResult`; `ok` mirrors `valid`, and failures summarize error/warning counts.                                        |
| `nuke.openmc.importCad`              | `write`   | Absolute `h5mPath`, optional absolute `manifestPath`                            | DAGMC file/info, manifest material names, created placeholder names, warnings, and parsed manifest.                                       |
| `nuke.openmc.runSimulation`          | `execute` | Optional `workingDirectory`, `generateXml`, `threads`, `restartFile`, and `mpi` | Working directory, process ID, generated XML files, warnings, and a `getRunStatus` follow-up.                                             |
| `nuke.openmc.getRunStatus`           | `read`    | Optional exact `workingDirectory`, `logLines` (1-200, default 40)               | `running: false`, or the matching run's process ID, directory, start time, log path, and capped log tail.                                 |
| `nuke.openmc.diagnoseProject`        | `read`    | `{}`                                                                            | Validation, environment, cross-section, and DAGMC findings plus `valid`, `readyToRun`, and counts.                                        |
| `nuke.openmc.diagnoseRun`            | `read`    | Optional exact `workingDirectory`, `logLines` (1-200, default 80)               | Active-run identity, capped log tail, error/warning counts, and classified log findings.                                                  |
| `nuke.openmc.previewSettings`        | `read`    | `changes` (1-20 `{ path, value }`), optional `summary`                          | Proposal id, summary, and labelled before/after diff plus a `changeSet` for `applySettings`.                                              |
| `nuke.openmc.applySettings`          | `write`   | `proposalId` from `previewSettings`                                             | Applied diff, a `changeSet` without `applyCapability`, an `undoToken`, and a diagnosis follow-up.                                         |
| `nuke.openmc.summarizeSettings`      | `read`    | `{}`                                                                            | Run mode plus the current value of every supported settings path; unset paths are `null`.                                                 |
| `nuke.openmc.previewMaterialChange`  | `read`    | `actions` (1-20 update/add/remove), optional `summary`                          | Proposal id, summary, and labelled material diff plus a `changeSet` for `applyMaterialChange`.                                            |
| `nuke.openmc.applyMaterialChange`    | `write`   | `proposalId` from `previewMaterialChange`                                       | Applied diff, a `changeSet` without `applyCapability`, an `undoToken`, and a diagnosis follow-up.                                         |
| `nuke.openmc.previewTallyChange`     | `read`    | `actions` (1-20 update/add/remove), optional `summary`                          | Proposal id, summary, and labelled tally diff plus a `changeSet` for `applyTallyChange`.                                                  |
| `nuke.openmc.applyTallyChange`       | `write`   | `proposalId` from `previewTallyChange`                                          | Applied diff, a `changeSet` without `applyCapability`, an `undoToken`, and a diagnosis follow-up.                                         |
| `nuke.openmc.createProject`          | `write`   | `name`, workspace `path`, optional `templateId`/`parameters`, `replaceExisting` | Project path, template id, and entity counts. Builds and saves the project before installing it.                                          |
| `nuke.openmc.previewProjectMetadata` | `read`    | `updates` (`name`, `description`, `author`), optional `summary`                 | Proposal id, summary, and labelled metadata diff plus a `changeSet` for `applyProjectMetadata`.                                           |
| `nuke.openmc.applyProjectMetadata`   | `write`   | `proposalId` from `previewProjectMetadata`                                      | Applied diff, a `changeSet` without `applyCapability`, an `undoToken`, and a summary follow-up.                                           |
| `nuke.openmc.summarizeSources`       | `read`    | `{}`                                                                            | Run mode, fixed-source flag, and up to 50 sources with index, type, spatial/angle/time summaries, energy type, particle, and editability. |
| `nuke.openmc.previewSourceChange`    | `read`    | `actions` (1-16 add/update/remove), optional `summary`                          | Proposal id, summary, and labelled source diff plus a `changeSet` for `applySourceChange`.                                                |
| `nuke.openmc.applySourceChange`      | `write`   | `proposalId` from `previewSourceChange`                                         | Applied diff, a `changeSet` without `applyCapability`, an `undoToken`, and a diagnosis follow-up.                                         |
| `nuke.openmc.exportPython`           | `write`   | Optional workspace `path`, `mode` (`single`/`separate`), comments/shebang flags | Written absolute paths and file count. Single mode defaults to `model.py` beside the project.                                             |
| `nuke.openmc.previewGeometryChange`  | `read`    | `actions` (1-48 add/update/remove surface, cell, universe, lattice), `summary`  | Proposal id, summary, labelled geometry diff, and counts plus a `changeSet` for `applyGeometryChange`.                                    |
| `nuke.openmc.applyGeometryChange`    | `write`   | `proposalId` from `previewGeometryChange`                                       | Applied diff, an `undoToken`, and a diagnosis follow-up.                                                                                  |
| `nuke.openmc.previewDagmcChange`     | `read`    | `actions` (1-32 `assign` volume material or `setFlags`), optional `summary`     | Proposal id, summary, and labelled volume/flag diff plus a `changeSet` for `applyDagmcChange`.                                            |
| `nuke.openmc.applyDagmcChange`       | `write`   | `proposalId` from `previewDagmcChange`                                          | Applied diff, an `undoToken`, and a diagnosis follow-up.                                                                                  |

`importCad`, `runSimulation`, `createProject`, `exportPython`, and every apply capability require confirmation. Every capability is enabled regardless of whether a project is saved; handlers reject paths outside the workspace roots instead of hiding the action. The two diagnostics are read-only and never write files, change project state, or start/stop runs. Previews are read-only and never mutate project state; project creation and script export write files and are not undoable.

## Read inventories before an edit

The edit flows take numeric ids; source edits take list indexes. `summarizeMaterials`, `summarizeTallies`, `summarizeGeometry`, and `summarizeSources` are the only legal way for a model to resolve them: each reads one `OpenMCStateManager` snapshot, never calls the backend or reads a file, and caps its rows with `truncated`.

- Materials: 200 rows with `nuclideCount` but never the nuclide list.
- Tallies: 200 rows; each filter reports its type, the first 20 numeric bins, and the full `binCount`.
- Geometry: 100 surfaces, 100 cells, 100 universes, and 50 lattices, plus counts and the root universe id. Cells carry their `regionString` or a compact region-tree expression. Up to 100 DAGMC volumes report material assignments and triangle counts. `issues` carries the first 20 `validateGeometryModel` findings; CSG validation is skipped when a DAGMC file owns the geometry, matching run readiness.
- Sources: 50 rows with `index`, `type`, `editable`, compact `spatial`/`angle`/`time` summaries, `energyType`, and `particle`; file/compiled/mesh/tokamak rows are read-only and carry a `detail` string.

Use the summaries first and never invent ids.

## Change proposals

`OpenMCChangeProposalService` (`src/browser/capabilities/openmc-change-proposal-service.ts`) is the shared in-memory store for previewed edits. Each proposal carries a domain `scope` (`settings`, `materials`, `tallies`, `project`, `geometry`, `dagmc`, or `sources`), a summary, the `NukeChange` diff, and scoped `before`/`after` snapshots. The store keeps at most twenty live proposals, expires them after ten minutes, prunes on every create, and deep-clones snapshots on create and on read, so later state edits and callers cannot mutate a stored preview. `get` and `has` drop expired entries, `remove` deletes one, and `scopeError` rejects a proposal from another domain with `Proposal <id> is for <scope>, not <scope>.` Apply capabilities check the scope before consuming a proposal. Materials, tallies, and project metadata previews reuse the same store by selecting their scope and storing only their own scoped snapshot.

## Safe settings edits

`nuke.openmc.summarizeSettings` is the read side of this flow: it returns the active run mode and the current value of every supported path, with `null` for unset optional values, without touching state. `previewSettings` validates and diffs those paths, then stores a `settings`-scoped proposal with the current settings as `before` and the computed settings as `after` (ten-minute TTL, at most twenty live proposals). `applySettings` rejects a missing or expired proposal, rejects a proposal from another scope, rejects a stale preview with `Settings changed since the preview. Preview again.`, re-runs the cross-field checks on the settings being applied, applies only the previewed paths to the current settings through `OpenMCStateManager.updateSettings`, removes the proposal, and registers an in-memory undo. Undo verifies that every changed path still equals the applied value, restores only those paths on the current settings, and returns `Settings change undone.`; undo does not survive an IDE restart.

Supported paths only:

| Path                          | Rule                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `run.particles`               | Integer >= 1                                                                                            |
| `run.inactive`                | Integer >= 0; only when the current run mode has inactive batches                                       |
| `run.batches`                 | Integer >= 1                                                                                            |
| `seed`                        | Integer >= 0                                                                                            |
| `threads`                     | Integer >= 1                                                                                            |
| `verbosity`                   | Integer 1-10                                                                                            |
| `energyMode`                  | `continuous-energy` or `multigroup`                                                                     |
| `photonTransport`             | Boolean                                                                                                 |
| `electronTreatment`           | `led` or `ttb`                                                                                          |
| `atomicRelaxation`            | Boolean                                                                                                 |
| `sourceRejectionFraction`     | Number 0-1                                                                                              |
| `output.summary`              | Boolean                                                                                                 |
| `output.tallies`              | Boolean                                                                                                 |
| `output.path`                 | Non-empty string, no control characters, at most 255 characters; project-relative or workspace-absolute |
| `cutoff.energyNeutron`        | Finite number > 0                                                                                       |
| `cutoff.energyPhoton`         | Finite number > 0                                                                                       |
| `cutoff.time`                 | Finite number > 0                                                                                       |
| `cutoff.timePhoton`           | Finite number > 0                                                                                       |
| `cutoff.weight`               | Finite number > 0                                                                                       |
| `cutoff.weightAvg`            | Finite number > 0                                                                                       |
| `kinetics.enabled`            | Boolean; the dashboard-generated IFP tallies must already exist in the project                          |
| `kinetics.ifpNGenerations`    | Integer > 0 and <= `run.inactive`                                                                       |
| `kinetics.numPrecursorGroups` | Integer 1-8 (1 means total β_eff only)                                                                  |
| `kinetics.computeBetaEff`     | Boolean                                                                                                 |

Every edit updates only the addressed leaf: `output.*`, `cutoff.*`, and `kinetics.*` keep unrelated keys in the same object, and undo restores only the changed paths. `previewSettings` runs cross-field checks over the settings the request would produce: `kinetics.ifpNGenerations` must not exceed `run.inactive` (including when the request lowers `run.inactive`), and `kinetics.enabled` is rejected unless the IFP tallies the dashboard would generate already exist in the current tallies (`ifp-time-numerator`, `ifp-beta-numerator` when `computeBetaEff` is not false, and `ifp-denominator`). Absolute `output.path` values must stay inside a workspace root; the capability never creates or deletes the directory. `applySettings` re-runs the cross-field checks and skips only the tally-presence check. A request with any unknown path, invalid value, duplicate path, or unchanged value is rejected as a whole. Sources, random ray, CMFD, geometry, and tallies use their own flows.

## Safe material edits

`previewMaterialChange` accepts 1-20 actions: `{ action: 'update', materialId, updates }`, `{ action: 'add', material }`, or `{ action: 'remove', materialId }`. Start with `summarizeMaterials` to resolve the id. Updates are limited to `name`, `density`, `densityUnit`, `nuclides`, `thermalScattering`, `color`, `temperature`, `volume`, `isDepletable`, `ncrystalCfg`, and `isotropic`; ids, `macroscopic`, and CAD provenance are read-only. Adds receive `getNextMaterialId()` and require a unique name. The preview rejects duplicate actions, no-op sets, invalid density/unit/volume/temperature, malformed nuclides or thermal scattering, and NCrystal combined with thermal scattering. It stores a `materials` proposal with before/after material arrays and per-field `materials.<id>.<field>` changes plus full `materials.<id>` add/remove snapshots. Apply preflights every change against current materials, calls `updateMaterial` once per material, `addMaterial`, or `removeMaterial`, preserves unrelated materials, and registers a path-scoped undo. Removing a material does not rewrite cell or tally references.

## Safe tally edits

`previewTallyChange` accepts 1-20 actions: `{ action: 'update', tallyId, updates }`, `{ action: 'add', tally }`, or `{ action: 'remove', tallyId }`. Start with `summarizeTallies` to resolve the id. Updates are limited to `name`, `scores`, `nuclides`, `estimator`, `multiplyDensity`, and `higherMoments`; filters, triggers, and derivatives are preserved and rejected as edits. Adds validate scores through `scores-catalog.ts` (`getScoreEntry` or numeric `MT<n>`), default `nuclides` to `['total']`, shallow-validate filters against `filters-catalog.ts`, reject caller ids, assign `getNextTallyId()`, and require a unique name when provided. The preview stores a `tallies` proposal with per-field `tallies.<id>.<field>` changes and full add/remove snapshots. Apply preflights every change against current tallies, calls `updateTally` once per tally, `addTally`, or `removeTally`, preserves unrelated tallies, and registers a path-scoped undo.

## Safe source edits

`summarizeSources` returns the run mode, a `fixedSource` flag, and up to 50 rows with each source index, type, compact `spatial`/`angle`/`time` summaries, `energyType`, and `particle`. File, compiled, mesh, and tokamak rows are marked `editable: false`; the index remains the stable handle for the fixed-source list.

`previewSourceChange` accepts 1-16 actions: `{ action: 'add', source }`, `{ action: 'update', index, source }`, or `{ action: 'remove', index }`. The run must be `fixed source`; anything else is rejected with `Sources only apply to fixed-source runs.` Indexes refer to the snapshot returned by `summarizeSources`; duplicate indexes, out-of-range indexes, unknown actions or fields, non-independent source objects, and updates/removals that target read-only source types are rejected. Add appends, update replaces the element at `index`, and remove deletes it.

A source object is independent, with required `spatial` and `energy` distributions plus optional `angle`, `time`, `particle`, and `strength`. Supported spatial types are point, box, sphere, cylinder, cartesian, cylindrical, spherical, and pointcloud; energy types are discrete, uniform, Maxwell, Watt, normal, power law, tabular, mixture, decay spectrum, and Muir; angles are isotropic, monodirectional, and mu-phi; times are delta, uniform, discrete, tabular, and mixture. `spatial.type: "mesh"` and file/compiled/mesh/tokamak source objects are rejected. Every candidate runs `validateSourceDistributions`, the shared XML generators, and explicit range checks: finite numbers, positive sizes and radii, `mu` in [-1, 1], and `phi` in [0, 2π]. A source that cannot serialize is rejected.

The preview stores a `sources` proposal with detached before/after `settings.sources` arrays and one change row per action: `settings.sources.<index>.<field>` for each changed field of an update, and `settings.sources.<index>` for an add or remove. It performs no state write. Apply re-checks that the current source array still equals the preview's `before` snapshot, calls `OpenMCStateManager.updateSettings({ sources })` with the `after` array, removes the proposal, and registers an undo. Undo restores the previous array only while the current array still equals the applied one and returns `Source change undone.`; it does not survive an IDE restart.

## Safe project metadata edits

`previewProjectMetadata` accepts an `updates` map with `name`, `description`, and/or `author`. The name must be non-empty after trimming and at most 120 characters; description at most 500; author at most 120. Name and author reject control characters, descriptions keep tabs and line breaks but reject other control characters, and an empty description or author clears the field. Version, creation/modification timestamps, and the multi-group backup are always read-only. The preview rejects unknown or read-only fields, non-string values, a field that already has the requested value, an unknown top-level key, and an `updates` map that changes nothing, then stores a `project` proposal with the current metadata as `before`, the edited metadata as `after`, and one `metadata.<field>` row per change. It performs no state write.

`applyProjectMetadata` rejects a missing or expired proposal, rejects a proposal from another scope, and rejects a preview whose pinned metadata no longer equals the current metadata. It calls `OpenMCStateManager.updateMetadata` once with only the changed fields, removes the proposal, and registers a field-scoped undo. Undo verifies that each changed field still equals the applied value, restores only those fields, and returns `Project metadata change undone.`; it does not survive an IDE restart. Metadata is not simulation input, so neither handler generates XML or calls the backend, and neither requires a saved project path.

## Project creation and script export

`createProject` accepts a workspace `path` ending in `.nuke-openmc`, a document `name`, an optional `templateId` (default `blank` when that template exists) and template `parameters`. The path must not exist, its parent must be a directory, no segment may be a symlink, and it must stay inside a workspace root. A dirty active project always refuses; a clean one requires `replaceExisting: true`. The capability builds the state with `buildProjectTemplate`, calls the backend `saveProject` first, and only then installs the state and marks it clean, so a failed write leaves the active project untouched. It is not undoable.

`exportPython` requires a saved project. Single mode writes `model.py` beside the project by default; separate mode writes the split modules into a directory. An explicit `path` follows the same workspace/parent/symlink rules, and an existing file needs `overwrite: true`. The capability delegates to `OpenMCPythonExporter`, returns the written paths and file count, never changes project state, and is not undoable.

## Safe CSG geometry edits

`previewGeometryChange` accepts 1-48 actions over `surface`, `cell`, `universe`, and `lattice`. Start with `summarizeGeometry` to resolve every id:

- `{ action: 'add', kind, value }` — the id is optional and defaults to the next free id per kind; an explicit id must be unused. OpenMC ids are independent per entity type, so the same numeric id may exist as both a surface and a cell.
- `{ action: 'update', kind, id, updates }` — `id` cannot change.
- `{ action: 'remove', kind, id }` — rejected when another entity references it: a cell region (string or tree) for surfaces, a universe `cellIds` entry for cells, a lattice `universes` entry / root universe / cell fill for universes, and a cell fill for lattices. Updating a cell fill to a missing universe or lattice is rejected too.

The pure reducer in `src/common/geometry-edit.ts` clones the geometry, applies the actions, and returns one labelled `geometry.<kind>.<id>` change per action. The preview then runs `validateGeometryModel` plus the backend `validateState` (level `standard`), stores a `geometry` proposal with full before/after geometry snapshots, and performs no state write. A project with `settings.dagmcFile` set rejects CSG authoring until the DAGMC file is cleared. Apply re-checks that the current geometry still equals the preview's `before` snapshot, installs the `after` geometry through `OpenMCStateManager.setState`, and registers an undo that restores `before` only while the geometry still equals `after`.

## Safe DAGMC edits

`previewDagmcChange` requires `settings.dagmcFile` and `settings.dagmcInfo` and accepts 1-32 actions. Start with `summarizeGeometry` to resolve volume ids:

- `{ action: 'assign', volumeId, material }` — `material` must be an existing project material name, or an empty string to unassign; duplicate volume assignments are rejected; no-op assignments are skipped.
- `{ action: 'setFlags', autoGeomIds?, autoMatIds? }` — at least one flag is required.

The preview stores a `dagmc` proposal with detached `{ volumes, autoGeomIds, autoMatIds }` before/after snapshots and no writes. Apply re-checks the same values, then calls the backend `dagmcAssignMaterial` for each volume in order — this edits the `.h5m` file in place, exactly like the DAGMC Editor. If a later call fails, the earlier assignments are reverted through the backend and project state is left unchanged. Only after every backend write succeeds does apply update `settings.dagmcInfo`. Undo re-checks the values, restores each previous material through the backend in reverse order, then restores the state flags/materials.

## Rules

- **Workspace paths** — `importCad`, `runSimulation`, `createProject`, and `exportPython` accept only paths inside a workspace root. `runSimulation` defaults to the parent directory of the saved project file and fails with `Save the project or provide a workingDirectory.` when neither exists.
- **Environment readiness** — `runSimulation` refreshes the OpenMC environment status first and refuses to start when OpenMC is not installed in the selected environment.
- **Validation before run** — `runSimulation` calls `validateState` with level `standard` and returns the issues without generating XML or starting a process when the model is invalid.
- **XML generation** — unless `generateXml` is `false`, the run generates materials and settings XML, geometry when the model has cells or a `dagmcFile`, tallies when any exist, and no plots. The output directory is the run directory, `projectDirectory` is the project file's parent, and the nuke-core cross-sections path is passed for element expansion. The simulation runner supplies `OPENMC_CROSS_SECTIONS`, `OPENMC_CHAIN_FILE`, and `OPENMC_MG_CROSS_SECTIONS` from the same preferences as the dashboard.
- **CAD import** — `importCad` delegates to `importNukeCAD`, creates placeholder materials only for manifest names that are not already present, and fills them with density `1.0 g/cm3`, empty nuclides and thermal scattering, plus `nukeCadMaterialId`/`nukeCadParentId` links when the manifest provides them. It then writes `dagmcFile` and `dagmcInfo` into settings.
- **Run status** — a provided directory matches exactly; without one, only a single active run is reported. `logTail` holds the last `logLines` lines and never exceeds 16 KiB. Poll with `nuke.openmc.getRunStatus` after `runSimulation` returns a process ID.
- **Project diagnosis** — `diagnoseProject` validates at the `standard` level, refreshes the environment, checks the nuke-core cross-sections path through `FileService`, and checks a configured DAGMC file through `checkFileExists` (project-relative paths resolve against the saved project). `ok` stays true when findings exist; only a backend validation failure returns `ok: false`. Unset cross sections warn without blocking `readyToRun`, while missing cross sections, a missing DAGMC file, or validation errors do.
- **Run diagnosis** — `diagnoseRun` uses the only active run, or an exact `workingDirectory` match, and asks for a directory when several runs are active. It classifies lost particles, overlaps, missing cross sections, error/warning lines, convergence, and MPI failures from the log tail; a log read failure returns `ok: false`. Both diagnostics cap findings at 20 and append an info `findings-truncated` entry.

The capability run path forwards only the explicit `threads`, `restartFile`, and `mpi` inputs. The dashboard additionally passes project-level threads/MPI defaults, particle-track `-t`, and CMFD driver configuration; those remain dashboard-only.
