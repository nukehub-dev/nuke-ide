# Visualizer AI Capabilities

`nuke-visualizer` registers its AI-facing actions with the neutral capability registry owned by `nuke-core`. The implementation lives in
`src/browser/capabilities/visualizer-capabilities.ts`; the contract types and DI tokens come from
`nuke-core/lib/common/nuke-capability-protocol`.

## Capabilities

| Id                             | Risk  | Purpose                                                               |
| ------------------------------ | ----- | --------------------------------------------------------------------- |
| `nuke.viz.summarizeStatepoint` | read  | Summarize the loaded statepoint or one absolute workspace statepoint. |
| `nuke.viz.openStatepoint`      | write | Open an absolute workspace statepoint in the statepoint viewer.       |
| `nuke.viz.captureView`         | read  | Capture the active DAGMC viewport as a truthful image preview.        |

### `nuke.viz.summarizeStatepoint`

Input: an optional `filePath`. Without it, the capability reads the statepoint loaded in `OpenMCService`; with it, the path must be absolute and inside
a workspace root, and the file is loaded through `OpenMCService.loadStatepoint`.

Output data: `file`, `batches`, `generationsPerBatch`, optional `kEff` and `kEffStd`, `nTallies`, `tallyIds`, and one entry per loaded tally with
`id`, `name`, `scores`, `nuclides`, and `hasMesh`. A null load returns `Failed to load statepoint.`; an empty viewer state returns
`No statepoint is loaded.`.

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

Both statepoint capabilities accept only absolute paths that resolve inside a workspace root. Relative paths and paths outside every root are
rejected before any file load or viewer open runs. The current-statepoint summary path needs no scoping because it uses state the viewer already
loaded.
