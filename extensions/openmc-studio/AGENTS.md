# OpenMC Studio

## Purpose

No-code graphical workspace for OpenMC Monte Carlo neutron transport simulations inside NukeIDE: simulation dashboard, CSG builder, DAGMC editor, tally configurator, optimization framework, simulation comparison, XML round-trip, project management, CAD import, and a simulation runner.

## Ownership

All files under `extensions/openmc-studio/` except generated artifacts (`lib/`, `node_modules/`, `*.tsbuildinfo`, `__pycache__`).

## Local Contracts

- TypeScript side follows `extensions/AGENTS.md`: `src/browser/` (React widgets per feature: csg-builder, dagmc-editor, optimization, simulation-comparison, simulation-dashboard, tally-configurator), `src/common/`, `src/node/`; widget CSS is copied to `lib/` by the `copy-css` build step.
- Python backend lives in `python/` and is **not pip-installed**; the IDE spawns it as a subprocess:
  - `python/cad_conversion/` — CAD→DAGMC/CSG conversion pipeline package.
  - `python/cad_importer.py`, `python/dagmc_editor_service.py`, `python/dagmc_info.py` — CAD/DAGMC services.
  - `python/run_depletion.py`, `python/run_optimization.py` — run drivers.
  - `python/statepoint_reader.py` — statepoint parsing/comparison.
  - `python/validation/` — validation helpers.
- Python runtime dependencies (openmc, numpy, gmsh/CadQuery/`OCP`, pythonocc-core/`OCC`, pydagmc/moab) are provided by the `ide` conda environment — see `applications/docker/environment.yml` and `docs/installation.md`. Tests must not require them: the test environment only has `pytest` + `numpy`, so guard heavy imports.
- Python package requirements live in `src/common/packages.json` (single source consumed via `src/common/packages.ts`); never inline package lists in services/widgets; `pydagmc`'s installCommand must stay pinned.
- Tests: `tests/python/` runs from the repo root via `yarn test:python`; `conftest.py` puts `python/` on `sys.path` so `cad_conversion` and the top-level service modules are importable.
- Python style: ruff (config at repo root) — width 100, double quotes.

## Work Guidance

- Keep the graphical model and OpenMC XML in sync through the existing round-trip modules; do not add one-way generators.
- New widget features go in `src/browser/widgets/<feature>/` with their CSS beside the widget; add the CSS file to the copy step if a new directory is introduced.
- Python services stream progress/logs back over stdout; keep output machine-parseable where the TS side consumes it.
- Live 3D previews reuse `nuke-visualizer` services — do not duplicate visualization infrastructure here.

## Verification

```bash
yarn test:python     # from repo root; runs this extension's pytest suite
yarn lint:python     # ruff check + ruff format --check
npx lerna run build --scope openmc-studio
```

## Child NAD Index

- None
