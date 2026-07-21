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
  - `python/plugins/openmc/` — OpenMC plugin (`commands/`: statepoint, tally_viz, xs_plot, geometry, materials, depletion, spectrum, basic; `lib/`: parsers, VTK export, overlap).
- Command handlers report errors as a single JSON object `{"error": ...}` on stderr with exit code 1 — never a traceback. Heavy imports stay lazy (inside the handler) so missing optional dependencies surface as clean JSON errors.
- Some top-level imports are deliberate dependency probes that must fail fast (e.g. `import vtk` in `plugins/base/lib/dagmc_viz.py`); they carry `# noqa: F401` — do not remove them.
- Error paths and argument handling are covered by `tests/python/test_command_error_paths.py`; keep that contract green when adding commands.
- Tests: `tests/python/` runs from the repo root via `yarn test:python`; `conftest.py` puts `python/` on `sys.path` and isolates the global command registry between tests.
- Python package requirements live in `src/common/packages.json` (single source for TS health checks and the Python `check_*_dependencies` functions in `python/plugins/base/lib/common.py`); never inline package lists in services; keep `pydagmc`'s installCommand pinned.
- Trame UI servers (`base.serve`, dagmc, openmc tally/geometry) target **trame 3 / vuetify3 / vue3** (`trame.ui.vuetify3`, `client_type="vue3"`); trame 2's `trame.ui.vuetify2` no longer exists. `trame`/`trame-vuetify` must be >=3 and may come from pip **or** conda-forge — never mix both in one environment (a clobbered install loses submodules like `trame.app`; `check_trame_dependencies` reports that as a broken install with a reinstall hint).
- `GLOBAL_STYLES` in `python/plugins/base/lib/common.py` targets Vuetify 3 DOM classes (`.v-theme--*`, `.v-select__content`/`.v-autocomplete__content`, `.v-chip--size-*`, `.v-field__input`); check selectors against the served vuetify3 bundle when touching CSS.

## Work Guidance

- Adding a plugin: create `python/plugins/<name>/` with `commands/` and `lib/`, register it in `python/plugins/__init__.py`/registry, and add the TS-side widget/open-handler wiring in `src/`. See `docs/dev/` for the full guide.
- Adding a command to an existing plugin: add a handler in the plugin's `commands/` module using `@command`/`@arg`, keep heavy imports lazy, return JSON errors on stderr, and add error-path tests in `tests/python/`.
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
