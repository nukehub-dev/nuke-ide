# Nuke Visualizer

## Purpose

Plugin-based 3D/2D visualization framework for NukeIDE: native three.js viewers over headless Python converters.
Domain plugins: Base Visualizer (meshes/DAGMC/STEP/Exodus) and OpenMC (statepoints/tallies/geometry/outputs).

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
- Native render rule is convert → read → render: backend writes XML VTK and exits, frontend reads via `readVtkText`
  (`native-vtk-data.ts`, 256 MB `NATIVE_VTK_MAX_READ_BYTES` budget — never bare `FileService.read`) and `parseNativeVtk`.
- Shared viewer is `NativeVtkViewerWidget` (+ `widgets/native-vtk/`); color-by (`Solid Color|Point:|Cell:`) maps through
  `viewer-core/scalar-mapping.ts` (34-preset generated `colormaps.ts` — never hand-edit); see `docs/dev/output-viewers.md`.
- Output routing uses `src/browser/output-viewer/` (`output-viewer-registry.ts` + `output-file-patterns.ts`); register
  with `bind(OutputViewerContribution).to(...)`; see `docs/dev/output-viewers.md`.
- DAGMC/STEP use `python/plugins/base/lib/dagmc.py` / `step.py` (`DagmcError`/`StepError`, `find_spec` probes, lazy
  loaders, cached `base.convert-dagmc-multiblock`); see `docs/dev/python-backends.md`.
- Exodus series (`python/plugins/base/lib/exodus_series.py`, `base.exodus-series` → `ExodusTimeSliderWidget` for
  `*.e`/`*.exo*`) and headless geometry (`geometry_viz.py::extract_csg_mesh`, `slice_viz.py` via `openmc.geometry-mesh` /
  `openmc.geometry-slice-vtk` into `widgets/geometry-native/` and `widgets/tally-native/`); see `docs/dev/python-backends.md`.
- Tally routing uses `python/plugins/openmc/lib/tally_vtk.py` (`openmc.tally-mesh-vtk` / `source-vtk` / `overlay-vtk` /
  `overlay-geometry-vtk`, XML only) via `openmc-service.ts::openTallyNativeWidget`; see `docs/dev/output-viewers.md`.
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
  CSG Outline (`CsgOutlineHost`) under `src/browser/<panel>/`.
- `contributions/visualizer-tools-contribution.ts` exposes commands in the Nuke Tools sidebar under `Visualizer` and
  `Visualizer > OpenMC`; 3D chrome comes from `nuke-essentials` (`ViewCube`/`ViewerNavBar`/`ViewBadge`,
  `.nuke-viewer-status-line`) — never local gizmo/nav widgets.

## Work Guidance

- Add a plugin: create `python/plugins/<name>/` plus TS widget/open-handler wiring; follow `docs/dev/adding-a-plugin.md`.
- Add a command: `@command`/`@arg` handler with lazy imports plus error-path tests in `tests/python/test_command_error_paths.py`;
  follow `docs/dev/python-backends.md`.
- Reuse shared services, DI, and RPC patterns from `docs/dev/shared-services.md`, `docs/dev/di-wiring.md`, and
  `docs/dev/rpc-protocols.md` — never invent new plumbing.

## Verification

```bash
yarn test:python
npx lerna run build --scope nuke-visualizer
```

## Child NAD Index

- None
