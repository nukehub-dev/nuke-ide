# Changelog

All notable changes to NukeIDE are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Phase 5: comprehensive OpenMC feature completeness.
Phase 6: remaining OpenMC surface.
Phase 7: deferred surface + end-to-end testing layer.
Phase 8: nuclear data hub (NCrystal + ENDF).
Phase 9: hardening + workflow unification.

### Added

- nuke-core: **Nuke Tools sidebar** — a searchable, categorized left-panel view that aggregates every Nuke command across extensions. Extensions contribute items via `NukeToolsContribution`, with support for nested categories, section/category ordering, and state-aware enabled/disabled items.
- openmc-studio: element symbols (e.g. `U`, `O`) in materials are expanded to their natural nuclide compositions on XML export and script generation, so hand-edited element shorthand round-trips correctly through OpenMC.
- openmc-studio: one-click **CE ↔ Multi-Group conversion** (Random Ray tab) —
  generates MGXS from the current CE model, converts matched materials to
  macroscopic with the correct XS data names, and stashes the original materials
  in project metadata for a lossless **Revert to Continuous-Energy**.
- openmc-studio: version-compatibility architecture for upstream OpenMC drift —
  a per-env runtime probe (ray_source XML format, adjoint source, TokamakSource,
  s2 sampling) that adapts XML emission and gates dev-only UI options; MG library
  reference in materials.xml with legacy path unification; depletion solver names
  aligned to OpenMC's real integrator registry with legacy aliases.
- openmc-studio: mode guard rails with plain-language errors — coupled depletion
  vs multi-group, macroscopic depletable materials, MGXS generation vs MG models,
  IFP kinetics vs random ray, random-ray score whitelist, duplicate mesh emission.
- nuke-visualizer: NCrystal tab in the Nuclear Data window — browse the installed
  `.ncmat` material library (or custom files/dirs), inspect phases/structure,
  build config strings with a guided editor (temp, dcutoff, mosaicity, …) for
  pasting into openmc-studio's NCrystal import, and plot S(α,β) scatter +
  absorption cross sections (validated against known thermal values).
- nuke-visualizer: ENDF tab in the Nuclear Data window — browse an ENDF-6
  library directory (decay/nfy/sfy/neutrons sub-libraries), with per-evaluation
  detail: decay modes and half-lives, per-energy fission-product yield tables,
  and fast reaction-section scans of neutron files.
- nuke-visualizer: voxel plot HDF5 (`*voxel*.h5`, `plot_*.h5`) and `summary.h5`
  now open on double-click (voxel → results viewer; summary → geometry 3D via
  on-the-fly XML conversion). Output viewers have a draggable viewer/table
  split, and missing-dependency errors show an actionable install/env panel.
- nuke-visualizer: the visualizer proxy retries refused connections on startup
  (trame bind race), eliminating false 'Visualizer server unreachable' errors.
- openmc-studio: tally derivatives (`TallyDerivative`) — sensitivity tallies in
  the tally editor with density/nuclide-density/temperature perturbation
  variables, e2e-verified against the real statepoint layout.
- openmc-studio: custom depletion chain builder (Depletion tab) — build from an
  ENDF-B-VII library directory (`decay/` + `nfy/` + `neutron(s)/`) or subset an
  existing chain XML, with full recursive closure over decay/reaction targets,
  fission-yield products, and FPY borrow parents; 'Use as Depletion Chain'
  applies the result directly.
- nuke-visualizer: nuclear data browser (Materials menu) — searchable library table
  (nuclides, temperatures, reaction counts) with per-nuclide MT/temperature/
  fission detail, resolved from `OPENMC_CROSS_SECTIONS`, and one-click plotting
  of any nuclide in the XS viewer.
- openmc-studio: Library (manual) mode in the MGXS generator — user-chosen XS
  types, domains, by-nuclide decomposition, Legendre order, and estimator via
  the `openmc.mgxs.Library` API (validated: MG k-eff within 0.3% of CE).
- openmc-studio: random-ray adjoint source editing, tally-trigger `ignore_zeros`,
  muir energy round-trip (serializes as `normal` in this OpenMC version),
  TokamakSource time distributions, criticality-search cancellation, and CMFD
  mesh-reference validation.
- nuke-visualizer: weight-windows viewer mesh selector for multi-mesh files.
- openmc-studio: CMFD acceleration — Convergence-section UI, validation, codegen,
  and a `run_cmfd.py` driver so CMFD-enabled runs execute through the IDE (CMFD is
  C-API-only in this OpenMC version; there is no settings.xml form).
- openmc-studio: mesh sources (`MeshSource`) with exact `n_elements` sub-source
  enforcement and a fill helper; tokamak sources (`TokamakSource`, 0.15.4+) with
  Miller geometry and emission-profile editing. Both join the source type selector.
- openmc-studio: per-tally precision triggers (variance/std_dev/rel_err, per-score
  subsets) with automatic `trigger_active` emission, plus run-level trigger
  settings in Settings → Output.
- openmc-studio: criticality search (`search_for_keff`) as a mode of the
  optimization widget — guess or bracket with method selection, live iteration
  table, and apply-to-model for the converged parameter. Parameter paths
  (`material.density|temperature|<nuclide>`, `settings.*`, `geometry.<cell>.temperature`)
  are now one shared vocabulary used by sweeps, search, and the Python drivers.
- openmc-studio: Advanced settings section — event-based transport, tabular
  Legendre conversion, delayed neutron/photon creation, decay photons, survival
  biasing, generations per batch, probability tables, lost-particle limits,
  initial-source writing, uniform source sampling, log-grid bins, and multi-group
  max order.
- openmc-studio: simulation dashboard tabs are now modular contributions behind a
  `DashboardTabRegistry` (the monolithic dashboard widget was split into per-tab
  modules), and `.nuke-openmc` project files carry schema version 1.1.0 with a
  chained migration hook.
- openmc-studio: full source model — file sources, compiled sources, multi-source
  lists with strengths, source constraints, and surface source write/read.
- openmc-studio: output-control settings (statepoint/sourcepoint batches, track
  files, collision tracks), photon physics (`electron_treatment`,
  `atomic_relaxation`), Shannon entropy mesh, and restart-from-statepoint runs.
- openmc-studio: particle track files (`tracks.h5`, `tracks_p<N>.h5`) are moved
  into a `tracks/` subfolder after a run, and `weight_windows.h5` is surfaced
  as an 'Open Weight Windows' action alongside 'Open Tracks' in the Simulation
  Dashboard.
- openmc-studio: complete tally score catalog (79 scores incl. photon,
  particle-production, and IFP kinetics scores) and descriptor-driven filter
  editors for all 23 supported filter types.
- openmc-studio: IFP kinetics workflow (`ifp_n_generation`, auto-generated IFP
  tallies with optional per-delayed-group β_eff) with validation.
- openmc-studio: volume-calculation window with trigger support and
  adopt-into-materials; native plotting window for slice, voxel, solid and
  wireframe ray-trace plots (PNG output, voxel→VTK handoff).
- openmc-studio: advanced depletion — `IndependentOperator` (file or
  generate-from-model MicroXS), integrator transfer rates, all normalization
  modes with per-nuclide fission Q, and `diff_burnable_mats`.
- openmc-studio: macroscopic (multigroup) materials and NCrystal material import
  (optional dependency, env-gated).
- openmc-studio: random ray support — dedicated dashboard tab, MGXS generator
  window (`convert_to_multigroup`/`convert_to_random_ray`), and FW-CADIS weight
  window generation via the adjoint workflow.
- openmc-studio: DAGMC material overrides (by-name replace, per-cell assignment),
  `auto_geom_ids`/`auto_mat_ids` toggles, and sync-for-depletion.
- openmc-studio: single-particle restart runs with track capture (`-t`) and
  post-run track handoff.
- nuke-visualizer: shared HDF5 output readers and viewers for `tracks*.h5`,
  `collision_track.h5`, and `weight_windows.h5` (convert→VTK→trame pipeline),
  registered through a new `OutputViewerRegistry`.
- nuke-visualizer: IFP kinetics tab in the statepoint viewer (β_eff/Λ_eff with
  uncertainties, CSV export), particle-restart preview viewer, and a random-ray
  results viewer with initial-coloring support (`base.serve --color-by`).
- Testing: **Playwright UI smoke suite** (`yarn test:ui`) — boot with zero
  console errors, all dashboard tabs, New Project flow, windows, select-sticks;
  weekly `ui-smoke.yml` CI with failure screenshots.
- Testing: `openmc-dev.yml` weekly CI lane building upstream OpenMC develop from
  source; CI python tests moved to a cached conda full profile (coverage ratchet
  back above 94%).
- Testing: end-to-end test layer — real OpenMC runs for every driver
  (CMFD, depletion, k-eff search, volume calc, MGXS, chain build, plots) and a
  project-file suite (10+ `.nuke-openmc` fixtures through the real
  load → migrate → XML → run pipeline, incl. DAGMC, random ray, kinetics,
  derivatives, mesh/tokamak sources, and a v1.0.0 migration fixture).
  `yarn test:python:full` runs the full-dependency profile via `NUKE_TEST_PYTHON`;
  env-gated on `OPENMC_CROSS_SECTIONS` / `NUKE_E2E_CHAIN` / `NUKE_E2E_ENDF`,
  skipping cleanly otherwise.

### Fixed

- openmc-studio: random-ray ray_source emitted in the dev-clone XML format,
  which release 0.15.3 binaries reject — now probed per env.
- openmc-studio: macroscopic materials couldn't select the required `macro`
  density unit; MGXS generation crashed silently on MG models via libopenmc's
  C-level exit — now a first-class guarded error with the real cause surfaced.
- openmc-studio: depletion solver dropdown emitted names the driver rejected
  (`ce-cm`, `leapfrog`, `si-rk4`, `predictor-corrector`).
- openmc-studio: `generateSurfaceElement` stamped `boundary="vacuum"` on every
  surface, silently killing particles in all multi-region models — regenerate
  XML for existing projects.
- openmc-studio: cylinder surfaces generated invalid Python (`openmc.Cylinder`
  does not exist); kinetics-enabled scripts omitted the auto-generated IFP
  tallies; macroscopic materials lacked the required `macro` density unit —
  all caught by the e2e layer.
- openmc-studio: MGXS generation passed a wrong `particles` kwarg to
  `convert_to_multigroup`; k-eff search used nonexistent `Model.clone()` and a
  direct density assignment; nuclide-fraction changes now renormalize only
  within the same element instead of distorting all other nuclides.
- openmc-studio: chain builder accepts both ENDF `neutron/` and `neutrons/`
  layouts and closes FPY borrow-parent references in ENDF-built chains.
- openmc-studio: run-level tally trigger settings, `eventBased`,
  `probabilityTables`, `maxLostParticles`, and `relLostParticleRate` existed in
  the project schema but never round-tripped to XML or appeared in the UI.
- openmc-studio: React controlled selects/checkboxes that mutated widget fields
  without scheduling a re-render were reverted by React (DAGMC overrides, MGXS
  generator, volume calculator) — selections now stick immediately.
- openmc-studio: `tallies.xml` and `plots.xml` are now parsed back on XML import
  (previously export-only), and plots use the real OpenMC element format.
- openmc-studio: tallies emit a single space-joined `<nuclides>` element (the
  repeated `<nuclide>` form was silently ignored by OpenMC), and tally codegen
  emits real filter constructors instead of invalid `openmc.Filter()` calls.
- openmc-studio: weight window generators use the real
  `<weight_window_generators>` settings.xml format.
- nuke-essentials: tooltips anchored to a stretched wrapper span could appear far
  from their control, and lingered at stale coordinates after scroll/resize.
- nuke-visualizer: output viewers' selects/inputs lacked focus/disabled styling
  and themed dropdown option lists.
- CI: vitest job never compiled extensions (broken imports on fresh runners);
  setup-miniconda pinned Python 3.14, unsatisfiable for OpenMC.

## [0.1.3] - 2026-07-28

First tagged release.

### Added

- IDE shells: Theia browser application, Electron desktop application, and an
  all-in-one Docker deployment (`applications/`).
- Extensions (`extensions/`):
  - `nuke-core` — shared services, environment detection, and health checks.
  - `nuke-essentials` — core IDE workflow features.
  - `nuke-docs` — product documentation readable inside the IDE.
  - `nuke-sysmon` — system monitor widget.
  - `nuke-fileinfo` — file information views.
  - `nuke-visualizer` — trame/ParaView visualization backends with
    local (vtk.js) / remote (server-rendered) view modes.
  - `openmc-studio` — OpenMC workspace: CAD import/conversion, DAGMC tooling,
    statepoint reading, depletion and optimization runners.
  - `nukelab-integration` — NukeLab service integration.
- Python backend test suites with tiered coverage policy (lightweight
  pytest profile for logic, full-dependency profile exercised in Docker).
- CI/CD: fast PR checks (`ci.yml`), cross-platform Electron packaging with
  draft GitHub Releases on `v*` tags (`build.yml`), weekly all-in-one
  container build + smoke test (`docker.yml`), and a weekly latest-upstream
  early-warning job (`upstream-latest.yml`).
- Functional rendering smoke test (`applications/docker/render_smoke_test.py`)
  gating the trame/ParaView/VTK seam in the container.

### Fixed

- Container image now renders headless: `libosmesa6` provides the OSMesa
  software-GL backend (no X server / EGL device in the image).
- `create_view_widget` no longer requires trame-vtk at import time, so the
  lightweight test profile runs without the rendering stack.

### Changed

- Backend conda environment (`applications/docker/environment.yml`) moved to
  an all-conda-forge visualization/CAD stack (paraview 6.1.1, trame, gmsh,
  cadquery, pythonocc-core sharing conda's VTK 9.6.1); the pip
  `cadquery-ocp`/`cadquery_vtk` pins and the Dockerfile's VTK force-reinstall
  repair step are gone.

[Unreleased]: https://github.com/nukehub-dev/nuke-ide/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/nukehub-dev/nuke-ide/releases/tag/v0.1.3
