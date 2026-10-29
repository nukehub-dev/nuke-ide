# Nuke Visualizer

## Purpose

Plugin-based 3D/2D visualization framework for NukeIDE: native three.js viewers over headless Python converters.
Domain plugins: Base Visualizer (meshes/DAGMC/STEP/Gmsh/Exodus) and OpenMC (statepoints/tallies/geometry/outputs).

## Ownership

All files under `extensions/nuke-visualizer/` except generated artifacts (`lib/`, `node_modules/`, `*.tsbuildinfo`, `__pycache__`).

## Local Contracts

- TS layout follows `extensions/AGENTS.md`: `src/browser/`, `src/common/`, `src/node/` wired by
  `visualizer-frontend-module.ts` / `visualizer-backend-module.ts`; Python in `python/`, pytest in `tests/python/`.
- Commands run as `python server.py <plugin>.<command> --file <path>` (e.g. `dagmc.info`); framework in
  `python/nuke_viz/` (`plugin.py` `@command`/`@arg`, registry, logging), plugins in `python/plugins/base|openmc/`.
- Error contract: handlers print one JSON `{"error": ...}` and exit 1, never a traceback; base-plugin errors go to
  stderr, openmc-plugin errors to stdout; heavy imports stay lazy; node `executeCommandJson` is stdout-first and
  dependency-shaped failures render via `widgets/dependency-hints.ts`.
- Python requirements live in `src/common/packages.json` (single source; see parent contract) — never inline
  package lists; keep shared specs matching nuke-core `package-registry.json` spec-for-spec.
- No servers: never bind ports, spawn HTTP/trame/ParaView processes, or add proxy/iframe paths; every viewer
  converts headlessly and renders client-side.
- Native render rule is convert → read → render: backend writes VTK (XML or legacy ASCII) and exits, frontend reads
  via `readVtkText` (`native-vtk-data.ts`, 256 MB `NATIVE_VTK_MAX_READ_BYTES` budget — never bare `FileService.read`)
  and `parseNativeVtk`. Legacy volume cells emit only unshared boundary faces as triangles (no interior surface soup).
- Shared viewer is `NativeVtkViewerWidget` (+ `widgets/native-vtk/`); color-by (`Solid Color|Point:|Cell:`) maps through
  `viewer-core/scalar-mapping.ts` (34-preset generated `colormaps.ts` — never hand-edit); see `docs/dev/output-viewers.md`.
  Bivariate uncertainty (`viewer-core/bivariate-mapping.ts` + Viewer Settings `Uncertainty`) pairs `<score>-mean` with its
  `-std`/`-rel-err` companion and blends surfaces/voxel blocks toward the mask color; smooth volume/slice stays mean-only.
  DAGMC adds categorical `Material|Volume|Group` (`dagmc-color-by.ts` + shared `material-colors`): no scalar mapping or
  legend, and Viewer Settings hides the colormap/Invert/Log/range/threshold/legend rows (`colormap.disabled`).
- Grid volumes use `viewer-core/volume-transfer.ts` + `volume-raycast.ts` (editable opacity stops, MIP/composite, gradient
  shade); Viewer Settings `ViewerVolumeSettings` keeps the ramp and defaults to the legacy MIP look.
- Orthoslices use `viewer-core/slice-view.ts`; `ViewerSettingsHost.getSlicePreview` returns RGBA for the Slice section,
  and `slice-preview.tsx` only paints it. Never move the 3D camera from the preview.
- Clip caps use `viewer-core/capped-clip.ts` on closed triangle soups; `clipCaps` defaults on, caps follow solid/block
  colors, and open/point/line data stays hollow. Rebuild caps from `applyClip()`, never a separate event.
- Dataset Inspector (`src/browser/dataset-inspector/`, `ViewerDatasetHost`) binds like Viewer Settings; hosts expose
  `getDatasetSummary`/`getDatasetTable` and optional `getDatasetStats`, the panel only renders the first 200 rows and
  copies that window as CSV; cell integrals use grid volume / triangle area from `viewer-core/dataset-inspector.ts`.
  DAGMC aggregates blocks through `dagmc-dataset.ts` (counts/bounds/arrays merged, tables cross block boundaries).
- Screenshots use `viewer-core/canvas-screenshot.ts` (`captureRendererScreenshot`, formats/scales/transparency) and the
  props-only `viewer-export-menu.tsx`; keep the one-click PNG path and never resize the canvas CSS permanently. The
  same menu's Dataset CSV/VTK actions call `VisualizerBackendService.runBaseCommand('base.export', …)` and download the
  returned temp file; both require `vtk` in the active environment.
- Color legend title/vertical-label settings are native-viewer fields (`scalarBarTitle`/`scalarBarVertical`); keep the
  legend as the single source of truth and do not duplicate the title in the viewer header.
- Mesh quality (`viewer-quality-menu.tsx`) runs `base.mesh-quality` through `runBaseCommand`, then opens the returned
  `.vtp`/`.vtu` via `WorkspaceService.open`; keep the metric list closed and surface/tet-mesh-only.
- Statistical plots use `viewer-core/statistics.ts` + `statistics-panel.tsx` (Plotly, 2D hist/scatter/box/parallel); the
  host supplies scalar arrays, the panel owns tab/bin state only.
- Plotly charts go through `plotly/plotly-component.tsx` + `plotly-theme.ts`; never hardcode `plotly_dark`/`theme="dark"`.
  The component follows the Theia body theme and owns primary-axis, legend, modebar, and background colors.
- Find Data uses `viewer-core/selection-query.ts` + props-only `find-data-dialog.tsx`; the native viewer keeps the
  selection transient and expands it through `selection-overlay.ts` into an orange always-on-top group.
- Axes grid uses `viewer-core/axes-grid.ts` + props-only `axes-grid-overlay.tsx`; lines live outside the data group so
  data clipping never cuts the axes, and label projection goes through the isolated overlay host (not per-frame widget
  re-renders).
- Saved views use `viewer-core/viewer-state.ts` (versioned camera + display schema) and `nukeVisualizer.viewerStates`
  keyed by viewer tab id; `orbit-controls.ts` owns `getPose`/`setPose`. Never store file paths or transient selections.
- Output routing uses `src/browser/output-viewer/` (`output-viewer-registry.ts` + `output-file-patterns.ts`); register
  with `bind(OutputViewerContribution).to(...)`; see `docs/dev/output-viewers.md`.
- DAGMC/STEP/Gmsh use `python/plugins/base/lib/dagmc.py`, `step.py`, and `gmsh_mesh.py` (`DagmcError`/`StepError`/
  `GmshMeshError`, `find_spec` probes, lazy loaders, cached converters); `.msh` imports as-is (no remeshing) via
  `base.convert-gmsh`; see `docs/dev/python-backends.md`.
- Analysis commands `base.integrate` / `base.describe` / `base.mesh-quality` live in
  `python/plugins/base/commands/analysis.py` (pure numpy in `lib/analysis.py`, lazy VTK); `base.export` lives in
  `commands/export.py` + `lib/export.py` (CSV/VTK/glTF). Register both in `base/plugin.py`.
- Exodus series (`python/plugins/base/lib/exodus_series.py`, `base.exodus-series` → `ExodusTimeSliderWidget` for
  `*.e`/`*.exo*`) and headless geometry (`geometry_viz.py::extract_csg_mesh`, `slice_viz.py` via `openmc.geometry-mesh` /
  `openmc.geometry-slice-vtk` into `widgets/geometry-native/` and `widgets/tally-native/`); see `docs/dev/python-backends.md`.
- Tally series (`openmc.tally-series` in `commands/tally_series.py` + `lib/tally_series.py`) reads sibling
  statepoints through `widgets/statepoint/tally-series-widget.tsx`; preload no per-step mesh, and pass the
  series-wide `viewRange` as the custom 3D range when Shared color range is on.
- Derived tallies: the statepoint viewer discovers the sibling `.nuke-openmc` project, resolves
  `openmc-studio/python/derive_tallies.py` through nuke-core, and renders mean/std with a DERIVED badge
  (bins/plot/CSV/comparison). Definitions are analysis-only and never enter simulation XML/Python; keep the
  viewer free of OpenMC Studio TS imports. See `docs/user/openmc/statepoint-viewer.md`.
- Comparison workspace (`viewer-core/comparison-session.ts`, `comparison-layout.ts`,
  `visualizer-comparison-contribution.ts`) groups already-open or browsed native/DAGMC viewers into split panes;
  four panes use a 2x2 grid, camera links apply direction only across files, and the shared range is the union of
  active-array data ranges. Never preload data or copy source camera distance.
- Generic probe (`viewer-core/probe-model.ts`, `widgets/probe-dialog.tsx`, `base.probe`) maps raycast hits by
  triangle/segment/voxel indices; keep point sampling client-side and line profiles file-backed, and never
  map derived overlay geometry (edges, caps, glyphs, selection) onto dataset tuples. Point samples render as
  world-anchored scene markers outside `dataGroup` (newest accented); clear them with history/dataset rebuilds.
- Shading modes live in `viewer-core/shading-mode.ts`; `edges` draws every triangle edge, `feature-edges` draws only
  creases above `FEATURE_EDGE_ANGLE_DEGREES` (30°), and DAGMC reuses its single edge overlay for both.
- Tally routing uses `python/plugins/openmc/lib/tally_vtk.py` (`openmc.tally-mesh-vtk` / `source-vtk` / `overlay-vtk` /
  `overlay-geometry-vtk`, XML only) via `openmc-service.ts::openTallyNativeWidget`; tabs open instantly with a loading
  status (`beginPendingLoad`) before conversion runs, failures land in-tab (`failPendingLoad`); probe/contour source
  fields are pre-filled from the tab context (`seedToolContext`, never overwriting typing); see `docs/dev/output-viewers.md`.
- File claims: `*.vtm`/`*.h5m` → `DagmcViewerWidget`, `geometry.xml` → `GeometryNativeViewerWidget`,
  `*voxel*.h5`/`plot_*.h5` → random-ray widget; plain random-ray `.vtk` opens only via `openmc.open-random-ray-results`.
- Kinetics IFP results stay in the statepoint viewer (no registry entry): conditional tab via
  `kinetics-utils.ts::hasIfpTallies`, lazy-loading `openmc.kinetics`; see `docs/dev/output-viewers.md`.
- Nuclear Data browser (`widgets/nuclear-data/`) covers the cross_sections.xml library plus the NCrystal tab
  (`ncrystal-materials/info/xs`, optional dep) and the ENDF tab (`endf-evaluations/detail`, `nuke.endfLibrary` pref).
- Shared HDF5 readers live in `python/plugins/openmc/lib/output_readers.py` (pure JSON-safe dicts, `OutputReaderError`,
  limits/decimation server-side); see `docs/dev/output-viewers.md`.
- 3D navigation is `viewer-core/orbit-controls.ts` OrbitControls only (`ORBIT_DAMPING_FACTOR`,
  `fitBounds`/`setViewDirection`/`zoomBy`) — never hand-roll orbit math.
- Side panels bind one active viewer each: Viewer Settings (`ViewerSettingsHost`), DAGMC Outline (`DagmcOutlineHost`),
  CSG Outline (`CsgOutlineHost`), Dataset Inspector (`ViewerDatasetHost`) under `src/browser/<panel>/`. Settings rows
  reserve a nowrap 82 px label column with plain-integer section badges; DAGMC Outline mirrors Model Outline
  headers/24 px rows (see `docs/dev/widget-patterns.md`). Native bottom bars expose one-click Viewer Settings,
  Dataset Inspector, and (on DAGMC) Outline shortcuts; panel commands stay id-only in `commands/panel-commands.ts`
  to avoid cycles.
- `contributions/visualizer-tools-contribution.ts` exposes commands in the Nuke Tools sidebar under `Visualizer` and
  `Visualizer > OpenMC`; 3D chrome comes from `nuke-essentials` (`ViewCube`/`ViewerNavBar`/`ViewBadge`,
  `.nuke-viewer-status-line`) — never local gizmo/nav widgets.
- File-specific empty states use `NukeEmptyState` with `iconNode`; reusable domain illustrations live in
  `src/browser/widgets/domain-icons.tsx` instead of generic repo/database codicons. Widget/command `iconClass`
  hooks and Nuke Tools `iconClass` rows use the matching `nuke-visualizer-icon-<domain>` CSS mask classes, not
  generic `fa`/`codicon` glyphs.

## Work Guidance

- Add a plugin: create `python/plugins/<name>/` plus TS widget/open-handler wiring; follow `docs/dev/adding-a-plugin.md`.
- Add a command: `@command`/`@arg` handler with lazy imports plus error-path tests in `tests/python/test_command_error_paths.py`;
  keep `tests/python/test_command_contracts.py` green (every registered command supports `--help`, and missing
  input yields one JSON error with no traceback); follow `docs/dev/python-backends.md`.
- Reuse shared services, DI, and RPC patterns from `docs/dev/shared-services.md`, `docs/dev/di-wiring.md`, and
  `docs/dev/rpc-protocols.md` — never invent new plumbing.

## Verification

```bash
yarn test:python
npx lerna run build --scope nuke-visualizer
```

## Child NAD Index

- None
