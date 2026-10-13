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

### The Color-By Contract

Color-by is a pure client-side control: `'Solid Color' | 'Point: <array>' | 'Cell: <array>'`, validated against the arrays the parsed dataset actually has. Switching arrays re-colors instantly — no conversion re-run, no restart. Converters decide _which_ arrays exist — e.g. weight windows write one cell-data array per (bound, group) named `lower_g<i>` / `upper_g<i>`, which is what makes Color By act as the group/bound selector.

### Derived Fields (Calculator) + Histogram

The tracks/collision-track/weight-windows panels host a Calculator input plus an SVG histogram (`src/browser/plugins/openmc/widgets/derived-field-panel.tsx`, stateless render over props). The language lives in the pure `src/browser/viewer-core/derived-fields.ts` (vitest-covered): a closed grammar (`a/b`, `a-b`, `mag(v)`, `log10(a)` over dataset array names — no nesting, no literals; invalid input throws `DerivedFieldError`, which the panel shows inline and never commits). Operands resolve per tuple through `scalar-mapping.ts::tupleScalar` (magnitude default), so the transient single-component result (`derived(<expr>)`, finite-only `[min, max]` range) slots into the parsed model arrays and the existing recolor/legend/ Viewer-Settings paths consume it identically — divide-by-zero yields NaN per tuple and lands on the preset `nanColor`, same as `log10` of non-positive values. The host widget injects the array into `model.pointArrays`/`cellArrays`, re-runs `classifyNativeVtkArrays`, and switches color-by via the public `applyProps`; `Clear` removes it (restoring Solid Color when active) and each `reload()` re-applies the committed expression against the fresh dataset. Statistics (`min/max/mean/std`, population std, non-finite counts) and equal-width `histogram(nbins)` are pure helpers in the same module; the histogram always covers the active color-by array resolved with the current vector component (`resolveHistogramSource` in the panel file), with a 1–256 bin clamp and a log-y toggle. No Plotly, no new export machinery.

### Lifecycle

- `reload()` converts, reads the file text, and re-parses; parameter changes (filters, mesh selection) re-run `reload()` — convert again, re-parse.
- There are no servers to start, wait for, or kill: conversion timeouts scale with file size via the `nukeVisualizer.serverTimeout` + `nukeVisualizer.serverTimeoutPerMB` preferences, and conversion/parse failure surfaces an error panel pointing at the generic VTK viewer instead of starting anything.

> **Residual:** the generic `visualizer-widget.tsx` still falls back to a server iframe path for formats the native parser cannot read. The output viewers themselves no longer use it.

### Split Drag (`drag-split.ts`)

The resizable split between the 3D area and the data panel uses `src/browser/plugins/openmc/widgets/drag-split.ts::startSplitDrag`. During the drag it shields the 3D view's mouse capture (direct DOM writes — no per-pixel React renders; state commits once on mouseup). The Nuclear Data window's horizontal split uses the same helper.

### Summary Conversion

`summary.h5` opens in the geometry 3D view via `geometry_parser.convert_summary_to_xml()` (lazy `openmc.Summary` round-trip to `geometry.xml`/`materials.xml` in a temp dir). The `openmc.geometry` and `openmc.visualize-geometry` commands resolve any `.h5` input through it; errors (missing file, missing openmc, non-summary HDF5) return the standard error JSON without tracebacks.

### Multi-Mesh Weight Windows

`weight_windows_to_vtk(path, output_path, mesh_id)` anchors the conversion to one mesh; windows on other meshes are skipped and reported in the result (`convertedWindows` / `skippedWindows`). The widget shows a mesh selector when the file's info reports more than one mesh ID, and passes the selection through the `meshId` RPC parameter to the `--mesh-id` CLI argument.

---

## Key Files

| Purpose                    | File                                                               |
| -------------------------- | ------------------------------------------------------------------ |
| Viewer registry            | `src/browser/output-viewer/output-viewer-registry.ts`              |
| Filename patterns          | `src/browser/output-viewer/output-file-patterns.ts`                |
| Viewer base class          | `src/browser/plugins/openmc/widgets/native-vtk-viewer-widget.tsx`  |
| Calculator + histogram UI  | `src/browser/plugins/openmc/widgets/derived-field-panel.tsx`       |
| Derived-field expressions  | `src/browser/viewer-core/derived-fields.ts` (pure, vitest-covered) |
| Split-drag helper          | `src/browser/plugins/openmc/widgets/drag-split.ts`                 |
| Backend conversion service | `src/node/plugins/openmc/services/openmc-output-service.ts`        |
| VTK converters (Python)    | `python/plugins/openmc/lib/output_vtk.py`                          |
| Summary → XML (Python)     | `python/plugins/openmc/lib/geometry_parser.py`                     |
