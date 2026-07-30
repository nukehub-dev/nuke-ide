# OpenMC Studio

## Purpose

No-code graphical workspace for OpenMC Monte Carlo neutron transport simulations inside NukeIDE: simulation dashboard, CSG builder, DAGMC editor, tally configurator, optimization framework, simulation comparison, XML round-trip, project management, CAD import, and a simulation runner.

## Ownership

All files under `extensions/openmc-studio/` except generated artifacts (`lib/`, `node_modules/`, `*.tsbuildinfo`, `__pycache__`).

## Local Contracts

- TypeScript side follows `extensions/AGENTS.md`: `src/browser/` (React widgets per feature: csg-builder, dagmc-editor, native-plotting, optimization, simulation-comparison, simulation-dashboard, tally-configurator, volume-calc), `src/common/`, `src/node/`; widget CSS is copied to `lib/` by the `copy-css` build step.
- Python backend lives in `python/` and is **not pip-installed**; the IDE spawns it as a subprocess:
  - `python/cad_conversion/` — CAD→DAGMC/CSG conversion pipeline package.
  - `python/cad_importer.py`, `python/dagmc_editor_service.py`, `python/dagmc_info.py` — CAD/DAGMC services.
  - `python/run_depletion.py`, `python/run_optimization.py` — run drivers. `run_depletion.py` supports coupled and independent operators, `get_microxs_and_flux` generation, transfer rates, custom fission Q, and diff burnable mats.
  - `python/run_volume_calc.py`, `python/generate_plots.py` — volume calculation and native plotting jobs (stdout-JSON protocol: progress on stderr, one final JSON object on stdout).
  - `python/ncrystal_import.py`, `python/generate_mgxs.py` — NCrystal material import and MGXS library generation one-shot jobs (same stdout-JSON protocol).
  - `python/sync_dagmc_depletion.py` — DAGMC sync-for-depletion job (init_lib → sync_dagmc_universes → finalize_lib; rewrites geometry.xml with per-cell material overrides, never the .h5m). `dagmc_editor_service.py` also has a `replace_material` (by-name) subcommand; auto_geom_ids/auto_mat_ids live on `DAGMCInfo` and are emitted on the `<dagmc_universe>` element.
  - `python/statepoint_reader.py` — statepoint parsing/comparison.
  - Phase 5 adds `python/common/` (shared stdout-JSON envelope), `python/h5_readers/` (HDF5 readers), and re-adds `generate_mgxs.py` (previously removed — restored in W8 as a `convert_to_multigroup` wrapper).
- Python runtime dependencies (openmc, numpy, gmsh/CadQuery/`OCP`, pythonocc-core/`OCC`, pydagmc/moab) are provided by the `ide` conda environment — see `applications/docker/environment.yml` and `docs/installation.md`. Tests must not require them: the test environment only has `pytest` + `numpy`, so guard heavy imports.
- Python package requirements live in `src/common/packages.json` (single source consumed via `src/common/packages.ts`); never inline package lists in services/widgets; `pydagmc`'s installCommand must stay pinned.
- Tests: `tests/python/` runs from the repo root via `yarn test:python`; `conftest.py` puts `python/` on `sys.path` so `cad_conversion` and the top-level service modules are importable.
- Python style: ruff (config at repo root) — width 100, double quotes.

## Work Guidance

- Keep the graphical model and OpenMC XML in sync through the existing round-trip modules; do not add one-way generators.
- New widget features go in `src/browser/widgets/<feature>/` with their CSS beside the widget; add the CSS file to the copy step if a new directory is introduced.
- `widgets/shared/openmc-widget.css` is the shared design system: generic form/section/button styles scoped `:is(.simulation-dashboard, .openmc-widget)` — standalone widgets opt in by adding `openmc-widget` to their root element (tally-configurator keeps its own scoped sheet instead). It also documents the shared chrome patterns: `.openmc-header` (CSG-style icon + title + subtitle + right-aligned actions + stat counters), `.category-header` + `.count-badge` (collapsible group headers), and top-aligned `.form-row` grids; accent is always `--theia-focusBorder`, all colors are Theia CSS vars.
- Simulation dashboard tabs are `DashboardTabContribution` classes under `src/browser/widgets/simulation-dashboard/tabs/` collected by `DashboardTabRegistry`; add a tab by creating a contribution there and binding it against `DashboardTabContribution` in `openmc-studio-frontend-module.ts`.
- The settings tab is split into collapsible sections (General / Sources / Output / Physics / Convergence); section renderers live in `tabs/settings/`.
- The Random Ray tab (`tabs/random-ray-tab.tsx`, order 5) owns multi-group mode: `settings.energyMode` ('multigroup' maps to XML `multi-group`), `settings.mgxsLibrary`, and `settings.randomRay` round-trip through settings.xml (`<random_ray>`, `<cross_sections>` deprecated-but-read); `python/generate_mgxs.py` wraps `convert_to_multigroup`/`convert_to_random_ray`, driven by the MGXS Generator window (`widgets/mgxs-generator/`). Weight window generators use the real `<weight_window_generators>` format; FW-CADIS (`method: 'fw_cadis'` + target tallies) is gated on multi-group mode + MGXS library in the VR tab.
- Run readiness and the Setup Checklist are computed by the pure helpers in `src/common/run-readiness.ts` (`computeSetupChecklist` — mirrors the DAGMC-aware materials predicate; `computeReadiness` — materials + geometry + source required, plus the MGXS library in multi-group mode). The simulation tab renders the checklist as a collapsible chip strip (auto-collapsed when ready) and a slim readiness pill; the restart picker is a secondary 'Restart…' button in the run-actions row with a dismissible file chip beside it.
- The source model is a discriminated union (`independent` | `file` | `compiled`; absent `type` means `independent`) with optional per-source `constraints`; `settings.restartFile` is a run-only option passed to OpenMC as `-r`, never written to settings.xml. When it names a particle restart file (`particle_restart.h5` or the writer's `particle_<batch>_<id>.h5`, parsed by `src/common/particle-restart.ts`), the simulation tab offers track capture (`settings.tracks`/`maxTracks` — note particle-restart mode ignores those XML elements, so the dashboard also passes `-t`; OpenMC auto-derives run mode from the file's `filetype` attr), a preview via OpenerService (nuke-visualizer's particle-restart viewer claims the file), and a post-run 'Open Tracks' action when `tracks.h5`/`tracks_p0.h5` appears in the working directory.
- Tally scores and filters are data catalogs in `src/common/scores-catalog.ts` and `src/common/filters-catalog.ts` (ground-truthed against the OpenMC clone); the score selector and filter builder render from them — extend the catalogs, not the components. Deprecated upstream moment scores (`scatter-N`) are intentionally excluded; custom integer MTs are accepted. `tallies.xml` round-trips through `importXML` (meshes, all filter types, nuclides, scores).
- Kinetics (IFP) is driven by `settings.kinetics` and `src/common/kinetics-ifp.ts`: on export the three IFP tallies are auto-appended unless already present (OpenMC's own `Model.add_kinetics_parameters_tallies` pattern), `<ifp_n_generation>` is written to settings.xml, and `importXML` re-derives `settings.kinetics` from parsed IFP tallies so re-export is idempotent. Controls live in the simulation tab; IFP tallies show an 'auto' badge in the Tallies tab.
- Depletion config persists in the custom `<depletion>` block in settings.xml (operator, solver, normalization, diff burnable mats, independent-operator file inputs, `transfer_rates`/`fission_q` as escaped JSON); the runner parses it back in `checkDepletionEnabled` and builds `run_depletion.py` args from it — extend both in lockstep. Transfer rates are applied via `Integrator.add_transfer_rate` (not on the operator).
- Materials may carry `macroscopic: { name }` (multigroup XS data, no nuclide decomposition); materials.xml uses the real `<macroscopic name="..."/>` form and round-trips. NCrystal import goes through `python/ncrystal_import.py`; `ncrystal` is an optional package in `packages.json` (`required: false`), and the materials tab disables the action with a tooltip when it is unavailable.
- Plot configs (`OpenMCPlotConfig`) cover slice, voxel, solid-raytrace, and wireframe-raytrace; `plots.xml` uses the real OpenMC element format (2-value `width` for slice, center-origin + 3-value `width` for voxel, camera/light/wireframe elements for ray-trace) and round-trips through `importXML`. The `up` vector is Python-API-only and intentionally not round-tripped.
- `volume-calc` and `native-plotting` are dedicated windows (WidgetFactory + `OpenMCViewCommands` + Advanced menu); their Python jobs run through `OpenMCRunnerService.executePythonScriptJson`. Voxel `.h5` output is converted to `.vti` by `generate_plots.py` and opened via `OpenerService` (nuke-visualizer's viewer registry claims it) — never render 3D here.
- Geometry bounding-box logic is shared in `tabs/settings/geometry-bounds.ts` (settings tab, entropy mesh, volume-calc widget).
- Python services stream progress/logs back over stdout; keep output machine-parseable where the TS side consumes it.
- Live 3D previews reuse `nuke-visualizer` services — do not duplicate visualization infrastructure here.

## Verification

```bash
yarn test:python     # from repo root; runs this extension's pytest suite
yarn lint:python     # ruff check + ruff format --check
npx lerna run build --scope openmc-studio
npx vitest run extensions/openmc-studio    # TS unit tests (schema migration, settings.xml round-trip)
```

## Child NAD Index

- None
