# Changelog

All notable changes to NukeIDE are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Phase 5: comprehensive OpenMC feature completeness.
Phase 6: remaining OpenMC surface.

### Added

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

### Fixed

- openmc-studio: run-level tally trigger settings, `eventBased`,
  `probabilityTables`, `maxLostParticles`, and `relLostParticleRate` existed in
  the project schema but never round-tripped to XML or appeared in the UI.
- openmc-studio: React controlled selects/checkboxes that mutated widget fields
  without scheduling a re-render were reverted by React (DAGMC overrides, MGXS
  generator, volume calculator) — selections now stick immediately.
- nuke-essentials: tooltips anchored to a stretched wrapper span could appear far
  from their control, and lingered at stale coordinates after scroll/resize.
- nuke-visualizer: output viewers' selects/inputs lacked focus/disabled styling
  and themed dropdown option lists.

### Added

- openmc-studio: simulation dashboard tabs are now modular contributions behind a
  `DashboardTabRegistry` (the monolithic dashboard widget was split into per-tab
  modules), and `.nuke-openmc` project files carry schema version 1.1.0 with a
  chained migration hook.
- openmc-studio: full source model — file sources, compiled sources, multi-source
  lists with strengths, source constraints, and surface source write/read.
- openmc-studio: output-control settings (statepoint/sourcepoint batches, track
  files, collision tracks), photon physics (`electron_treatment`,
  `atomic_relaxation`), Shannon entropy mesh, and restart-from-statepoint runs.
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

### Fixed

- openmc-studio: `tallies.xml` and `plots.xml` are now parsed back on XML import
  (previously export-only), and plots use the real OpenMC element format.
- openmc-studio: tallies emit a single space-joined `<nuclides>` element (the
  repeated `<nuclide>` form was silently ignored by OpenMC), and tally codegen
  emits real filter constructors instead of invalid `openmc.Filter()` calls.
- openmc-studio: weight window generators use the real
  `<weight_window_generators>` settings.xml format.

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
