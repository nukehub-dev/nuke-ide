---
name: nuke-visualizer
description: Summarize or open an OpenMC statepoint and capture a DAGMC viewport. Use when a user asks about simulation results, k-effective, tallies, or wants a truthful image of the current 3D view.
---

# Nuke Visualizer

Use this skill for OpenMC statepoint results and DAGMC viewport captures. The visualizer is a read-only analysis
surface here; it does not edit tallies or simulation inputs.

## Tool names

Capability ids are stable registry identifiers. Chat calls use sanitized tool names: `nuke.viz.summarizeStatepoint` is
exposed as `nuke_viz_summarizeStatepoint`, and the other ids in this skill follow the same dots-to-underscores mapping.

## Summarize a statepoint

Call `nuke_viz_summarizeStatepoint` with `{}` to use the statepoint already loaded in the viewer, or with
`{ "filePath": "<absolute workspace path>" }` to load a specific file.

The response reports the file, batches, generations per batch, k-effective and its standard deviation when present,
the tally count, and the tally ids with scores, nuclides, and mesh status. Use it to answer questions about results
without opening a viewer.

If the response says `No statepoint is loaded.`, ask for a path or suggest opening one. A failed load returns a
clear error message; do not assume a partial statepoint is valid.

## Open a statepoint

Call `nuke_viz_openStatepoint` with a required absolute `filePath` inside a workspace root. It reuses an already
open statepoint viewer for the same file or opens a new one, then activates it.

Opening a viewer is a write-risk tool because it changes the workspace UI. It asks for confirmation and must be run
with explicit user intent, such as "open this statepoint" or "show me the results".

After opening, the natural follow-up is `nuke_viz_summarizeStatepoint` with `{}` to confirm what was loaded.

## Capture a DAGMC viewport

Call `nuke_viz_captureView` with optional:

- `format` - `png` (default), `jpeg`, or `webp`.
- `scale` - `1` (default), `2`, or `4`.
- `transparent` - defaults to `false`.
- `caption` - a short description for the preview.

The capture prefers the active widget when it is a DAGMC viewer, then the first DAGMC viewer in the main area. If no
DAGMC viewer is open, the capability returns a clear error. Do not claim a capture was made in that case.

Preview truthfulness:

- The image is the real DAGMC viewport rendered by the viewer, not a window, DOM, or generated approximation.
- It reflects the current camera, clipping, selection, color-by, and visibility state.
- It reflects only the visible viewport. Hidden geometry is not included, and the preview states that limitation.
- Capture failures (no renderer, no scene, no camera, no loaded geometry, or a WebGL error) are reported as errors.

## Boundaries

- Do not edit tallies, materials, or simulation settings through this skill.
- Do not capture non-DAGMC viewers; the capability intentionally has no fallback.
- Statepoint paths must be absolute and inside the workspace. Never read a file outside the workspace.
- Treat previews as evidence of the current visible state, not as proof that a model or run is correct.
