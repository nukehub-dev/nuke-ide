# Nuke Visualizer

## Purpose

Plugin-based visualization framework for NukeIDE: shared infrastructure (Python environment detection, server lifecycle, widget management, health checks, output streaming) plus domain plugins for 3D/2D nuclear data (Base Visualizer for meshes/DAGMC, OpenMC for statepoints/tallies/geometry).

## Ownership

All files under `extensions/nuke-visualizer/` except generated artifacts (`lib/`, `node_modules/`, `*.tsbuildinfo`, `__pycache__`).

## Local Contracts

- TypeScript side follows `extensions/AGENTS.md`: `src/browser/`, `src/common/`, `src/node/`, wired by `visualizer-frontend-module.ts` / `visualizer-backend-module.ts`.
- Python backend lives in `python/` and is **not pip-installed**; the IDE spawns it as a subprocess:
  - `python/server.py` — CLI entry point; commands are invoked as `python server.py <plugin>.<command> --file <path>` (e.g. `dagmc.info`).
  - `python/nuke_viz/` — framework package: `plugin.py` (`@command`/`@arg` decorators and the global command registry), `registry.py` (plugin registry), `logging.py`.
  - `python/plugins/base/` — Base Visualizer plugin (`commands/`: convert, dagmc, serve; `lib/`: common helpers, dagmc, dagmc_viz, step).
  - `python/plugins/openmc/` — OpenMC plugin (`commands/`: statepoint, tally_viz, xs_plot, geometry, materials, depletion, spectrum, basic, tracks, collision_track, weight_windows, kinetics, particle_restart, output_vtk; `lib/`: parsers, VTK export, overlap, `output_readers.py` shared HDF5 output readers, `output_vtk.py` output→VTK converters).
- Command handlers report errors as a single JSON object `{"error": ...}` with exit code 1 — never a traceback. Base-plugin commands emit it on stderr; OpenMC-plugin commands emit it on stdout. Heavy imports stay lazy (inside the handler) so missing optional dependencies surface as clean JSON errors.
- HDF5 output readers (`plugins/openmc/lib/output_readers.py`) back the `openmc.tracks-*`, `openmc.collision-track-*`, `openmc.weight-windows`, and `openmc.kinetics` commands: pure functions returning JSON-safe dicts, raising `OutputReaderError` on failure; layouts verified against the OpenMC C++/Python writers (see the module docstring). Limits/decimation are enforced server-side.
- Output viewers render through the existing trame/VTK pipeline, not bespoke trame UIs: `plugins/openmc/lib/output_vtk.py` converts tracks → `.vtp` polylines, collision tracks → `.vtp` point cloud, weight windows → `.vtr` rectilinear grid (one `lower_g<i>`/`upper_g<i>` cell array per energy group), voxel `.h5` plots → `.vti` image data (`voxel_to_vtk`), via the `openmc.tracks-vtk` / `openmc.collision-vtk` / `openmc.weight-windows-vtk` / `openmc.voxel-vtk` commands; the frontend then serves the file with `VisualizerBackendService.startServer()` (`base.serve`), whose built-in color-by control selects particle/energy/MT/group arrays. Geometry construction is numpy-only; `vtk` imports lazily for the final write.
- `base.serve` accepts `--color-by '<Solid Color|Point: name|Cell: name>'` (validated against the file's arrays) to set the initial coloring; `VisualizerBackendService.startServer()` takes a matching optional `colorBy`. This is the only way to steer coloring from a widget — there is no remote-control API into a running trame server, so changing colors means restarting it. `openmc.vtk-info` inspects any legacy/XML VTK file (arrays, ranges, grid dims).
- The random-ray results viewer (`widgets/random-ray/random-ray-results-widget.tsx`) opens legacy random-ray `.vtk`, `.vti`, or voxel `.h5` files through the same convert→serve→iframe base, with an array quick-select bar (flux groups / source / id arrays classified by the pure, vitest-covered `random-ray-arrays.ts`) that restarts the server with `--color-by`. It is reached via the `openmc.open-random-ray-results` command, **not** an `OutputViewerContribution`: random-ray outputs are plain `<name>.vtk` files (name comes from the plot config, see OpenMC `src/random_ray/flat_source_domain.cpp::output_to_vtk`), so no filename pattern can claim them without stealing ordinary VTK files from `VisualizerOpenHandler`.
- `src/browser/output-viewer/output-viewer-registry.ts` — `OutputViewerContribution` registry mapping OpenMC output files (tracks, collision tracks, weight windows, kinetics, ...) to viewers. `VisualizerOpenHandler` and `OpenMCContribution` consult `OutputViewerRegistry.getHandlerFor()` first in `canHandle`/`open` and fall through to existing behavior when nothing matches. Register viewers with `bind(OutputViewerContribution).to(...)`; matching logic lives in the pure `selectOutputViewer` function (vitest-covered). Filename matching lives in `src/browser/output-viewer/output-file-patterns.ts` (pure, vitest-covered). Registered viewers: tracks (`openmc-tracks-viewer-contribution.ts`), collision track, weight windows — each a widget under `src/browser/plugins/openmc/widgets/<feature>/` extending `widgets/output-viewer-widget.tsx` (shared convert→serve→iframe lifecycle) with backend data/conversion calls via `src/node/plugins/openmc/services/openmc-output-service.ts`. Exception: the particle restart viewer (`openmc-particle-restart-viewer-contribution.ts`, matching `particle_restart.h5` and the writer's `particle_<batch>_<id>.h5` output name) renders its summary/property table directly in `widgets/particle-restart/` — scalar data, no trame pipeline; the run-single-particle action belongs to openmc-studio.
- IFP kinetics results live in ordinary `statepoint*.h5` files, so they have **no** `OutputViewerContribution` (the statepoint viewer already claims those). Instead the statepoint viewer shows a conditional 'Kinetics (IFP)' tab when any tally carries an `ifp-*` score (`kinetics-utils.ts::hasIfpTallies`, pure + vitest-covered alongside `formatUncertainty`/`kineticsToCsv`); the tab lazy-loads `openmc.kinetics` via `OpenMCService.getKineticsParameters()` and renders β_eff (total + per-group), Λ_eff, uncertainties, and CSV export with friendly empty/error states.
- Some top-level imports are deliberate dependency probes that must fail fast (e.g. `import vtk` in `plugins/base/lib/dagmc_viz.py`); they carry `# noqa: F401` — do not remove them.
- Headless rendering contract: `server.py` sets `paraview.options.batch = True` before plugin discovery (keeps render windows offscreen — no native popup when `DISPLAY` is set), and `serve.py` only defaults `DISPLAY` to empty when unset (an inherited Xvfb display must survive; conda VTK builds are X11/GLX-only and segfault without an X connection). See `docs/dev/python-backends.md`.
- Browser traffic to trame servers goes through the backend reverse proxy at `/visualizer/<port>/` (`src/node/visualizer-proxy-contribution.ts`), never to `127.0.0.1:<port>` directly; iframe URLs are built by `toProxiedVisualizerUrl()` via Theia's `Endpoint` (StripPrefix-safe), and trame servers bind loopback only. Trame's relative asset/ws paths are a hard requirement — verify them before upgrading trame.
- Error paths and argument handling are covered by `tests/python/test_command_error_paths.py`; keep that contract green when adding commands.
- Tests: `tests/python/` runs from the repo root via `yarn test:python`; `conftest.py` puts `python/` on `sys.path` and isolates the global command registry between tests.
- Python package requirements live in `src/common/packages.json` (single source for TS health checks and the Python `check_*_dependencies` functions in `python/plugins/base/lib/common.py`); never inline package lists in services; keep `pydagmc`'s installCommand pinned.
- Trame UI servers (`base.serve`, dagmc, openmc tally/geometry) target **trame 3 / vuetify3 / vue3** (`trame.ui.vuetify3`, `client_type="vue3"`); trame 2's `trame.ui.vuetify2` no longer exists. `trame`/`trame-vuetify` must be >=3 and may come from pip **or** conda-forge — never mix both in one environment (a clobbered install loses submodules like `trame.app`; `check_trame_dependencies` reports that as a broken install with a reinstall hint).
- 3D viewers use `VtkRemoteLocalView` (trame-vtk >= 2.11) with a user-switchable local (vtk.js, default) / remote (server-rendered) mode; build them via `create_view_widget` / `update_view_widget` / `UIComponents.create_render_mode_toggle` in `plugins/base/lib/common.py` with a unique state namespace per viewer, never bare `VtkRemoteView`. The default mode comes from `NUKE_VISUALIZER_RENDER_MODE` ("local"/"remote", default "local"). See `docs/dev/python-backends.md`.
- `GLOBAL_STYLES` in `python/plugins/base/lib/common.py` targets Vuetify 3 DOM classes (`.v-theme--*`, `.v-select__content`/`.v-autocomplete__content`, `.v-chip--size-*`, `.v-field__input`); check selectors against the served vuetify3 bundle when touching CSS.

## Work Guidance

- Adding a plugin: create `python/plugins/<name>/` with `commands/` and `lib/`, register it in `python/plugins/__init__.py`/registry, and add the TS-side widget/open-handler wiring in `src/`. See `docs/dev/` for the full guide.
- Adding a command to an existing plugin: add a handler in the plugin's `commands/` module using `@command`/`@arg`, keep heavy imports lazy, return JSON errors (stdout for openmc-plugin commands, stderr for base-plugin commands), and add error-path tests in `tests/python/`.
- Optional heavy dependencies (openmc, vtk, pymoab, gmsh, trame, paraview) must be import-guarded; the test environment only has `pytest` + `numpy`.
- Python style: ruff (config at repo root) — width 100, double quotes.

## Verification

```bash
yarn test:python     # from repo root; runs this extension's pytest suite
yarn lint:python     # ruff check + ruff format --check
npx lerna run build --scope nuke-visualizer
```

## Child NAD Index

- None
