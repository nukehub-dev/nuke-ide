# Visualizer AI Capabilities

`nuke-visualizer` registers its AI-facing actions with the neutral capability registry owned by `nuke-core`. The viewer-facing implementation
lives in `src/browser/capabilities/visualizer-capabilities.ts`; the read-only comparison and series diagnostics live in
`src/browser/capabilities/visualizer-diagnostics-capabilities.ts`, with pure thresholds in `visualizer-diagnostics.ts`. The contract types and
DI tokens come from `nuke-core/lib/common/nuke-capability-protocol`.

## Capabilities

| Id                             | Risk  | Purpose                                                                      |
| ------------------------------ | ----- | ---------------------------------------------------------------------------- |
| `nuke.viz.summarizeStatepoint` | read  | Summarize the loaded statepoint or one absolute workspace statepoint.        |
| `nuke.viz.diagnoseStatepoint`  | read  | Triage loaded statepoint convergence and tally metadata.                     |
| `nuke.viz.compareStatepoints`  | read  | Compare two absolute workspace statepoints without loading either one.       |
| `nuke.viz.analyzeTallySeries`  | read  | Analyze one tally across one to fifty statepoints with aggregate statistics. |
| `nuke.viz.openStatepoint`      | write | Open an absolute workspace statepoint in the statepoint viewer.              |
| `nuke.viz.captureView`         | read  | Capture the active DAGMC viewport as a truthful image preview.               |

The two diagnostic capabilities are registered by a separate `VisualizerDiagnosticsCapabilities` contribution. It receives only
`OpenMCBackendService`, so it cannot call `OpenMCService.loadStatepoint`, change the active widget, or replace the loaded statepoint.

### `nuke.viz.summarizeStatepoint`

Input: an optional `filePath`. Without it, the capability reads the statepoint loaded in `OpenMCService`; with it, the path must be absolute and inside
a workspace root, and the file is loaded through `OpenMCService.loadStatepoint`.

Output data: `file`, `batches`, `generationsPerBatch`, optional `kEff` and `kEffStd`, `nTallies`, `tallyIds`, and one entry per loaded tally with
`id`, `name`, `scores`, `nuclides`, and `hasMesh`. A null load returns `Failed to load statepoint.`; an empty viewer state returns
`No statepoint is loaded.`.

### `nuke.viz.diagnoseStatepoint`

Input: `{}`. The capability diagnoses only the statepoint currently loaded in `OpenMCService`; it never loads, replaces, or mutates a
statepoint.

Output data: `file`, `batches`, `generationsPerBatch`, optional `kEff`, `kEffStd`, and `relativeKeffUncertainty`, `nTallies`, one entry per
loaded tally (`id`, `name`, `scores`, `nuclides`, `hasMesh`), `issues`, and `warnings` (the messages of warning-severity issues). An empty
viewer state returns `ok: false` with `No statepoint is loaded.`; a diagnosis that runs returns `ok: true` even when it reports findings.

Findings use the shared diagnostic issue shape (`severity`, `code`, optional `category`, `message`, optional `suggestion`) and are capped at
20 entries. When the cap drops findings, the final entry is an info `findings-truncated` issue.

| Code                    | Severity | Condition                                  |
| ----------------------- | -------- | ------------------------------------------ |
| `missing-keff`          | warning  | `kEff` or `kEffStd` is absent.             |
| `high-keff-uncertainty` | warning  | `kEffStd / abs(kEff)` > 0.005.             |
| `high-keff-uncertainty` | info     | `kEffStd / abs(kEff)` > 0.001.             |
| `few-batches`           | warning  | `batches` < 50.                            |
| `few-generations`       | info     | `generationsPerBatch` < 10.                |
| `no-tallies`            | warning  | `nTallies` is 0.                           |
| `many-tallies`          | info     | `nTallies` > 20.                           |
| `tally-no-scores`       | warning  | A loaded tally has an empty `scores` list. |
| `mesh-tally`            | info     | A loaded tally has `hasMesh: true`.        |
| `findings-truncated`    | info     | More than 20 findings were produced.       |

### `nuke.viz.compareStatepoints`

Input: required `fileA` and `fileB`, each an absolute statepoint path inside a workspace root. Both files are loaded with
`OpenMCBackendService.loadStatepoint` and their tallies are listed with `OpenMCBackendService.listTallies`. The capability never calls
`OpenMCService.loadStatepoint`, never changes the active widget, and never writes a file.

Output data: `fileA`, `fileB`, `a` and `b` (`batches`, `generationsPerBatch`, optional `kEff`/`kEffStd`, `nTallies`, `tallyIds`), `delta`
(optional `batches`, `kEff`, and `kEffStd` differences from A to B, plus `tallyIdsAdded` and `tallyIdsRemoved`), `issues`, and `warnings`
(the messages of warning-severity issues). If tally metadata cannot be listed, the comparison still succeeds and the reason is appended to
`warnings`.

| Code               | Severity | Condition                                                            |
| ------------------ | -------- | -------------------------------------------------------------------- |
| `missing-keff`     | warning  | `kEff` or `kEffStd` is absent in either file.                        |
| `keff-shift`       | warning  | `abs(kEffB - kEffA) / abs(kEffA)` > 0.01.                            |
| `keff-shift`       | error    | `abs(kEffB - kEffA) / abs(kEffA)` > 0.05.                            |
| `batch-count-diff` | info     | The batch counts differ.                                             |
| `tally-set-diff`   | info     | The tally id sets differ; names are included when `listTallies` ran. |

A file that fails to load, a relative path, or a path outside every workspace root returns `ok: false` with a message naming `fileA` or
`fileB`. When both load, the result is `ok: true` even with error findings.

### `nuke.viz.analyzeTallySeries`

Input: required `files` (1-50 absolute workspace statepoint paths) and `tallyId`; optional `score`, `nuclide`, and `statistic`
(`total` default, `mean`, `max`). Every path is validated before the backend call, and more than 50 files is rejected.

The capability calls `OpenMCBackendService.getTallySeries(files, { tallyId, score, nuclide, statistic })`, which runs the existing headless
`openmc.tally-series` command. Output data passes through `files`, `tallyId`, `tallyName`, `score`, `nuclide`, `statistic`, `timeLabel`,
`steps` (aggregate `value`/`std` and `nBins` per statepoint), `range`, and `hasMesh`, and adds `issues` and `warnings`.

| Code                    | Severity | Condition                                                         |
| ----------------------- | -------- | ----------------------------------------------------------------- |
| `no-steps`              | error    | The series contains no steps.                                     |
| `empty-bins`            | warning  | A step has `nBins === 0`.                                         |
| `high-uncertainty`      | warning  | A step's `std / abs(value)` > 0.1.                                |
| `high-uncertainty`      | error    | A step's `std / abs(value)` > 0.25.                               |
| `worsening-uncertainty` | warning  | The last step's relative uncertainty > the first step's × 1.2.    |
| `mesh-tally`            | info     | `hasMesh` is true; aggregate values cannot show spatial behavior. |
| `single-step`           | info     | The series has one step, so a trend cannot be assessed.           |

A zero-value step with a non-zero standard deviation has an infinite relative uncertainty and is reported as an error. Findings are capped
at 20, with a final `findings-truncated` info entry when the cap drops findings.

`ok: false` means a path, input, or backend failure, or an empty `files` array. A successful backend read returns `ok: true` even when it
reports `no-steps`, high-uncertainty, or other error findings.

### Statepoint metadata limitation

`nuke.viz.diagnoseStatepoint` triages loaded statepoint metadata only: convergence summary values and tally definitions already reported by
`OpenMCService`. It does not read raw tally values, per-bin means, or tally uncertainties, so it cannot identify under-converged tallies,
zero-valued bins, or statistically noisy results. Use the statepoint viewer's tally tabs for those checks; mesh tallies are reported as
metadata findings that point to the viewer.

### Tally-series backend limitation

`nuke.viz.analyzeTallySeries` uses the existing `getTallySeries` contract, which returns one aggregated `value` and `std` per statepoint
step plus the number of contributing bins. It does not expose per-bin means or standard deviations for a single file, and there is no RPC
that returns them. The capability therefore reports uncertainty only at the aggregate level; it does not add a Python command, change the
series contract, or infer per-bin behavior. Individual bins, spatial distributions, and per-cell uncertainties stay in the statepoint viewer.

### `nuke.viz.openStatepoint`

Input: a required absolute `filePath` inside the workspace. The capability calls `OpenMCContribution.open`, which reuses the statepoint viewer
for an already-open file and activates it, then returns `{ filePath, opened: true }` and suggests `nuke.viz.captureView` as the next action.

### `nuke.viz.captureView`

Input: optional `format` (`png` default, `jpeg`, `webp`), `scale` (`1` default, `2`, `4`), `transparent` (default `false`), and `caption`.

The viewer search prefers the active widget when it is a DAGMC viewer, then the first DAGMC viewer in the main area. If no DAGMC viewer is open, the
capability returns `Open a DAGMC viewer before capturing the view.`.

## Why DAGMC only

This slice captures the native DAGMC viewer because it already exposes a stable viewport capture path (`DagmcViewerWidget.captureScreenshot`, built on
`captureRendererScreenshot`). VTK and other viewer capture paths are out of scope; the capability never falls back to another viewer type.

## Truthful previews

A preview is the real DAGMC viewport rendered by the viewer itself: the visible blocks at the current camera, clipping, selection, color-by, and
visibility state. It is never a window screenshot, a DOM screenshot, or a re-rendered approximation. The preview reports `truthful: true` and states
the limitation that the capture reflects only the currently visible viewport. Capture failures (missing renderer/scene/camera, no loaded geometry, or
a WebGL error) return `ok: false` with the widget's message.

## Path scoping

The path-taking statepoint capabilities (`nuke.viz.summarizeStatepoint`, `nuke.viz.openStatepoint`, `nuke.viz.compareStatepoints`, and
`nuke.viz.analyzeTallySeries`) accept only absolute paths that resolve inside a workspace root. Relative paths and paths outside every root
are rejected before any file load, backend read, or viewer open runs. A tally series is limited to 50 files. `nuke.viz.diagnoseStatepoint`
and the current-statepoint summary path need no scoping because they use state the viewer already loaded.
