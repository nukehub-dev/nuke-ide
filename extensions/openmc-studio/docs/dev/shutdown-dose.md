# Shutdown Dose (R2S / D1S)

The shutdown-dose workflow is a **driver-only** feature: the project state carries `shutdownDose`, but that configuration never appears in `settings.xml` or `tallies.xml`. The Python drivers load the generated model XML and receive the configuration as JSON.

## Contract

`schema` (`src/common/openmc-state-schema.ts`):

```ts
interface OpenMCShutdownDoseConfig {
  method: 'r2s' | 'd1s';
  domainType?: 'cell' | 'mesh';
  cellIds?: number[];
  meshIds?: number[];
  timesteps: (number | string)[];
  timestepUnits?: 's' | 'min' | 'h' | 'd' | 'a';
  sourceRates: number | number[];
  chainFile?: string;
  photonTimeIndices?: number[];
  byParentNuclide?: boolean;
  workingDirectory?: string;
  outputDirectory?: string;
  boundingBoxes?: Record<number, { lowerLeft: [number, number, number]; upperRight: [number, number, number] }>;
  matVolSamples?: number;
  photonTallyIds?: number[];
  d1sTimeIndex?: number;
  d1sSumNuclides?: boolean;
  runNeutron?: boolean;
  runPhoton?: boolean;
  wizardStep?: 'method' | 'schedule' | 'tallies' | 'review' | 'results';
  doseTallyId?: number;
  doseTallyTemplate?: { dataSource; doseQuantity; geometry; interpolation };
  lastRun?: { outputDirectory; method; completedAt? };
}
```

`src/common/shutdown-dose.ts` owns the pure behavior:

- `createDefaultShutdownDoseConfig(state)` seeds the chain and photon tallies.
- `normalizeShutdownDoseSchedule(config)` parses numeric/unit-bearing timesteps and validates source-rate lengths.
- `assessShutdownDoseReadiness(state, config)` returns blocking errors and warnings: fixed-source mode, cell volume/material fill, mesh overlap, chain presence, photon tally particle filters, D1S index range.
- `createDoseTally(...)` builds a photon flux tally with an `energyfunction` filter from coefficients supplied by the backend.

`OpenMCStateManager.updateShutdownDose` merges partial updates and emits `shutdown-dose` change events. The wizard persists its current page in `wizardStep` and its last output in `lastRun`, so reopening a project restores the results page.

## XML boundary

Cell volumes (required for cell-based R2S) are part of the CSG model and **do** round-trip:

- `OpenMCCell.volume` → `<cell volume="...">` in `geometry.xml`;
- `OpenMCStudioBackendService.importXML` reads the attribute back.

Everything else in `shutdownDose` is ignored by XML generation. `src/node/shutdown-dose-xml.test.ts` asserts settings/tallies XML contain no shutdown-dose markers and that cell volumes round-trip.

## Protocol and backend

Protocol types (`src/common/openmc-studio-protocol.ts`):

- `validateShutdownDose` combines pure readiness with filesystem checks (chain exists, run directory exists, XML not generated yet).
- `startShutdownDose({ workingDirectory, config, env? })` writes `.nuke-shutdown-dose.json` into the run directory and spawns `run_r2s.py` or `run_d1s.py`.
- Progress streams through `OpenMCStudioClient.onShutdownDoseProgress`; the terminal event carries `ShutdownDoseResult` and the process id is passed to `cancelShutdownDose`.
- `readShutdownDoseSummary({ outputDirectory })` reads `r2s_summary.json` / `d1s_summary.json` to resume the results page.
- `getDoseCoefficients` runs `python/dose_coefficients.py`, which wraps `openmc.data.dose_coefficients`. The UI never hard-codes a response function.

`OpenMCRunnerService.startShutdownDose` reuses the standard Python environment detection, streams stdout/stderr to the run log, and parses structured markers:

```
@@NUKE_PROGRESS@@ {"step":"activation","message":"...","fraction":0.3}
```

`step` is one of `neutron`, `activation`, `source`, `photon`, `d1s`, `done`. Malformed markers are ignored; the raw line remains in the log.

## Drivers

`python/run_r2s.py`:

1. Loads `openmc.Model.from_xml()`.
2. Resolves cell domains (volume, material fill, bounding-box overrides or `cell.bounding_box`) or mesh domains from every `<mesh>` element in `tallies.xml` / `settings.xml` (a missing `type` means regular).
3. Builds the photon model with deep-copied selected photon tallies and `photon_transport = True`.
4. Calls `R2SManager.step1_neutron_transport` … `step4_photon_transport` explicitly so each stage emits progress, inside `openmc.config.patch('chain_file', ...)`.
5. Writes `r2s_summary.json`: photon time indices, activation region count, capped neutron/photon tally arrays, parent nuclides, dose peak/mean, total activity (Bq), decay heat (W), warnings, files, and the last photon statepoint. Photon tallies are removed from the neutron model before step 1 (their independent copies live on the photon model), so the neutron solve does not warn about photon-only filters.

`python/run_d1s.py`:

1. Sets `use_decay_photons = True` and `photon_transport = True`.
2. Calls `d1s.get_radionuclides` / `d1s.prepare_tallies`.
3. Runs one transport solve in a timestamped output directory.
4. Computes `d1s.time_correction_factors`, applies `d1s.apply_time_correction` at the selected index, and writes `d1s_summary.json` with corrected tally summaries and per-parent factors.

Both scripts lazy-import OpenMC, raise `ShutdownDoseConfigError` for user-facing problems, and always print a JSON object (success or `{success:false, error}`) before exiting. `tests/python/test_run_r2s.py` and `test_run_d1s.py` inject fake modules to verify domains, schedules, bounding boxes, multiple meshes, parent filters, and corrections without OpenMC.

## UI

`src/browser/widgets/shutdown-dose/` contains the widget shell and the five step views. The shell owns run orchestration (XML generation → `startShutdownDose` → progress events), cancellation, summary loading, and file reveal/open actions. Step views are pure functions of state + config and call back into the shell.

The wizard gates **Next** on the current step's issues while keeping later pages visible in the stepper. The Results page loads from `lastRun` when a project reloads, so an old run does not need to be recomputed.

## Python export

`src/common/shutdown-dose-python.ts` appends an equivalent driver to single-file `model.py` after XML export: `R2SManager` with the selected domains/tallies/chain/output, or the D1S helper chain ending in `apply_time_correction`. Separate-file export labels the boundary because the generated modules do not build a combined `model` object.

## Verification

```bash
npx vitest run extensions/openmc-studio
python -m pytest extensions/openmc-studio/tests/python/test_run_r2s.py extensions/openmc-studio/tests/python/test_run_d1s.py
OPENMC_CROSS_SECTIONS=... NUKE_E2E_CHAIN=... python -m pytest extensions/openmc-studio/tests/e2e/test_shutdown_dose_e2e.py
yarn test:ui --grep "shutdown dose"
```
