# Output Viewers

How OpenMC output files (`tracks.h5`, `weight_windows.h5`, …) become interactive 3D viewers: the **OutputViewerRegistry** routes files to contributions, each contribution **converts** the file to VTK via the Python backend, **parses** the VTK in the frontend, and **renders** it natively with three.js — no server, no port, no iframe.

---

## OutputViewerRegistry

`src/browser/output-viewer/output-viewer-registry.ts` collects `OutputViewerContribution` instances (DI, same provider pattern as other registries):

```typescript
interface OutputViewerContribution {
  readonly id: string;
  readonly label: string;
  readonly priority: number;
  canHandle(uri: URI): number; // score > 0 if this viewer claims the file
  open(uri: URI): Promise<void>;
}
```

- Filename matching lives in `src/browser/output-viewer/output-file-patterns.ts` — one place to add a new recognized pattern.
- Both open handlers consult the registry **first**: `VisualizerOpenHandler` ("Open in Nuke Visualizer") and the OpenMC plugin's `OpenMCContribution` ("OpenMC Files"). Double-clicking a recognized file therefore routes automatically — there is no manual "Open as" step (except random ray results, whose plain `.vtk`/`.h5` names are not distinctive; those open via the `openmc.open-random-ray-results` command).
- Built-in contributions: tracks, collision tracks, weight windows, particle restart (a React summary — no 3D conversion), voxel plots (`*voxel*.h5`, `plot_*.h5` → random-ray results widget), and `summary.h5` (→ geometry 3D view).

To add a viewer: add a pattern, implement the contribution, bind it with `bind(OutputViewerContribution).to(...).inSingletonScope()`.

---

## Convert → Parse → Render

3D output viewers extend `NativeVtkViewerWidget` (`src/browser/plugins/openmc/widgets/native-vtk-viewer-widget.tsx`), which implements the whole pipeline; subclasses only provide `convert(filePath)` and panel content.

```
reload()
  └─ subclass.convert(filePath)            # RPC → OpenMCOutputService (node)
  │    └─ python server.py openmc.<cmd>    # plugins/openmc/lib/output_vtk.py
  │         tracks-vtk / collision-vtk / weight-windows-vtk [--mesh-id] / voxel-vtk
  │         → writes .vtp / .vtr / .vti (numpy-only geometry; vtk imports lazily for the write)
  └─ FileService.read(vtkPath) → setVtkText(text)
       └─ parseNativeVtkXml → three.js scene (instant color-by, no restart)
```

Viewer tabs open instantly: the opener attaches the tab with `beginPendingLoad` (spinner + status) before the conversion
runs, then loads the converted file into it (`loadTallyIntoWidget` / `setVtmFile`); conversion failure lands in the
tab's error panel (`failPendingLoad`), never a toast-only dead end. Applies to tally mesh/slice/overlay/contour/source
tabs and the DAGMC tally drape — never block the open on the backend.

### The Color-By Contract

Color-by is a pure client-side control: `'Solid Color' | 'Point: <array>' | 'Cell: <array>'`, validated against the arrays the parsed dataset actually has. Switching arrays re-colors instantly — no conversion re-run, no restart. Converters decide _which_ arrays exist — e.g. weight windows write one cell-data array per (bound, group) named `lower_g<i>` / `upper_g<i>`, which is what makes Color By act as the group/bound selector.

The DAGMC viewer adds three categorical modes, `Material`, `Volume`, and `Group` (`dagmc-color-by.ts`): per-volume material names, volume ids, and group memberships from `dagmc.info` map through the shared `nuke-essentials` `theme/browser/material-colors.ts` helpers (trim/lower-case + FNV-1a palette index) — `materialColor` mutes the graveyard material grey; `categoryColor` keys volumes as `volume:<id>` and groups as `group:<name>` without special-casing the graveyard (those modes are structural). Group mode uses the primary group per volume: the first group key in `info.groups` insertion order whose `volumeIds` include the volume; volumes in no group fall back to the solid color. Each categorical mode carries no scalar array, so `activeColorArray`/range/component stay undefined, `colormap.disabled` is true, the snapshot omits `scalarBar`, and the Viewer Settings panel hides the whole scalar-controls group (colormap, Invert/Log, range, threshold, legend) instead of rendering dead controls, leaving Color by plus a short `note` (`Color by material` / volume / group). Solid Color follows the same hide rule. `isCategoricalColorBy` guards the load-time array fallback so these modes survive a manifest load with no matching array; volumes without material info (or an unresolvable category) fall back to the solid color. The outline renders matching material and group swatches.

### Derived Fields (Calculator) + Histogram

The tracks/collision-track/weight-windows panels host a Calculator input plus an SVG histogram (`src/browser/plugins/openmc/widgets/derived-field-panel.tsx`, stateless render over props). The language lives in the pure `src/browser/viewer-core/derived-fields.ts` (vitest-covered): a closed grammar (`a/b`, `a-b`, `mag(v)`, `log10(a)` over dataset array names — no nesting, no literals; invalid input throws `DerivedFieldError`, which the panel shows inline and never commits). Operands resolve per tuple through `scalar-mapping.ts::tupleScalar` (magnitude default), so the transient single-component result (`derived(<expr>)`, finite-only `[min, max]` range) slots into the parsed model arrays and the existing recolor/legend/ Viewer-Settings paths consume it identically — divide-by-zero yields NaN per tuple and lands on the preset `nanColor`, same as `log10` of non-positive values. The host widget injects the array into `model.pointArrays`/`cellArrays`, re-runs `classifyNativeVtkArrays`, and switches color-by via the public `applyProps`; `Clear` removes it (restoring Solid Color when active) and each `reload()` re-applies the committed expression against the fresh dataset. Statistics (`min/max/mean/std`, population std, non-finite counts) and equal-width `histogram(nbins)` are pure helpers in the same module; the histogram always covers the active color-by array resolved with the current vector component (`resolveHistogramSource` in the panel file), with a 1–256 bin clamp and a log-y toggle. No Plotly, no new export machinery.

### Direction Glyphs

The tracks viewer draws decimated direction cones (`THREE.InstancedMesh`, one draw call) oriented along per-point vectors; the collision-track viewer shares the path. The math lives in the pure `src/browser/viewer-core/glyph-layout.ts` (vitest-covered): density decimation (`decimateGlyphIndices`, stride `round(1/density)` widened past `MAX_GLYPH_INSTANCES`), polyline tangents (`polylineTangents` — per-pair accumulation into both endpoints, zero-length segments and isolated points stay zero), the +Y apex quaternion (`quaternionFromUp`, undefined for zero/non-finite vectors — the skip), and `planGlyphs` (decimate + skip). The converted `.vtp` carries no explicit direction array (the HDF5 `u` never reaches the converter), so the tracks widget overrides the base `glyphVectors()` hook with cached tangents (explicit 3-component point array fallback); the collision widget resolves the first 3-component point array (none today, so its Glyphs rows stay hidden until a producer emits vectors). The base owns the cone lifecycle: `refreshGlyphs()` runs after the warp rewrite in every funnel (build, warp edits, threshold edits — cones sit on warped positions), drops threshold-hidden tuples (point arrays 1:1, cell arrays via the first incident segment's cell), colors instances from the active mapping, and sizes cones off the scene diagonal (`autoGlyphSize` × the scale slider). Viewer Settings drives it through `glyphEnabled`/`glyphDensity`/`glyphScale` patches with a `glyph` snapshot section (live/total counts) beside the Warp rows. Streamlines stay deferred: `glyph-layout.ts` carries the marked F5b seam (`GlyphVectorField`) but no integrator.

### Linked Cameras

The nav bar carries a `Link cameras` toggle (`widgets/viewer-nav-extras.tsx::LinkCamerasTrigger`, props-only — the host widget owns the per-widget flag, default off). The wiring lives in the native-VTK base: the orbit `change` hook publishes `{position, target}` (camera position plus a widget-mirrored target, exact except after a local pan) on the same-file bus (`src/browser/viewer-core/camera-link-bus.ts`, vitest-covered, no Theia imports), keyed by the viewed file path — different files never link. File-less tally tabs (mesh/slice/overlay/source/contour siblings load converted text) are keyed by their source statepoint (or source) file: `openmc-service.ts::openTallyNativeWidget` takes the source path as its link key at every call site, and `TallyNativeViewerWidget.setProbeContext` keys contour tabs from the probe context — so all tabs derived from one statepoint link together. Subscribers apply the pose direction through the existing `setViewDirection` handle after staging the linked distance on their own camera, so each view keeps its target and framing; display settings never cross views (camera-only sync, stated in code). Echo suppression is layered: the bus drops publishes equal to the last dispatched pose and never echoes to the sender, and the widget never publishes while applying (`applyingLinkedPose`). Subscriptions drop on detach and dispose.

### Lifecycle

- `reload()` converts, reads the file text, and re-parses; parameter changes (filters, mesh selection) re-run `reload()` — convert again, re-parse.
- There are no servers to start, wait for, or kill: conversion timeouts scale with file size via the `nukeVisualizer.serverTimeout` + `nukeVisualizer.serverTimeoutPerMB` preferences, and conversion/parse failure surfaces an error panel pointing at the generic VTK viewer instead of starting anything.

### Split Drag (`drag-split.ts`)

The resizable split between the 3D area and the data panel uses `src/browser/plugins/openmc/widgets/drag-split.ts::startSplitDrag`. During the drag it shields the 3D view's mouse capture (direct DOM writes — no per-pixel React renders; state commits once on mouseup). The Nuclear Data window's horizontal split uses the same helper.

### Summary Conversion

`summary.h5` opens in the geometry 3D view via `geometry_parser.convert_summary_to_xml()` (lazy `openmc.Summary` round-trip to `geometry.xml`/`materials.xml` in a temp dir). The `openmc.geometry` and `openmc.visualize-geometry` commands resolve any `.h5` input through it; errors (missing file, missing openmc, non-summary HDF5) return the standard error JSON without tracebacks.

### Multi-Mesh Weight Windows

`weight_windows_to_vtk(path, output_path, mesh_id)` anchors the conversion to one mesh; windows on other meshes are skipped and reported in the result (`convertedWindows` / `skippedWindows`). The widget shows a mesh selector when the file's info reports more than one mesh ID, and passes the selection through the `meshId` RPC parameter to the `--mesh-id` CLI argument.

### HDF5 Output Readers

`python/plugins/openmc/lib/output_readers.py` backs the tracks/collision-track/weight-windows/kinetics commands with pure functions returning JSON-safe dicts (raising `OutputReaderError` on failure); limits and decimation are enforced server-side.

### Kinetics (IFP) Tab

IFP kinetics results live in ordinary `statepoint*.h5` files, so they have no registry entry: the statepoint viewer shows a conditional tab when `kinetics-utils.ts::hasIfpTallies` matches, lazy-loading `openmc.kinetics` via `getKineticsParameters()`.

---

## Key Files

| Purpose                    | File                                                               |
| -------------------------- | ------------------------------------------------------------------ |
| Viewer registry            | `src/browser/output-viewer/output-viewer-registry.ts`              |
| Filename patterns          | `src/browser/output-viewer/output-file-patterns.ts`                |
| Viewer base class          | `src/browser/plugins/openmc/widgets/native-vtk-viewer-widget.tsx`  |
| Calculator + histogram UI  | `src/browser/plugins/openmc/widgets/derived-field-panel.tsx`       |
| Derived-field expressions  | `src/browser/viewer-core/derived-fields.ts` (pure, vitest-covered) |
| Glyph layout math          | `src/browser/viewer-core/glyph-layout.ts` (pure, vitest-covered)   |
| Split-drag helper          | `src/browser/plugins/openmc/widgets/drag-split.ts`                 |
| Backend conversion service | `src/node/plugins/openmc/services/openmc-output-service.ts`        |
| VTK converters (Python)    | `python/plugins/openmc/lib/output_vtk.py`                          |
| Summary → XML (Python)     | `python/plugins/openmc/lib/geometry_parser.py`                     |
