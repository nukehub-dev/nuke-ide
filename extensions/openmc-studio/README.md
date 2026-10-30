# OpenMC Studio Extension

No-code graphical interface for building, configuring, and running OpenMC Monte Carlo neutron transport simulations inside NukeIDE.

## Overview

`openmc-studio` provides a complete simulation workspace for OpenMC. Instead of hand-editing XML and Python scripts, you can construct geometry, define materials, configure tallies, set up variance reduction, run simulations, and compare results — all from within the IDE.

## Features

| Feature                     | What It Does                                                                          | Key File Types          |
| --------------------------- | ------------------------------------------------------------------------------------- | ----------------------- |
| **Simulation Dashboard**    | Central control panel for simulation status, runtime metrics, and batch monitoring    | `.xml`, `.h5`           |
| **CSG Builder**             | Graphical constructive solid geometry editor for cells, surfaces, and universes       | `.xml`                  |
| **DAGMC Editor**            | Visual editor for DAGMC faceted geometry, group tagging, and imprint/merge operations | `.h5m`, `.stl`          |
| **Tally Configurator**      | Point-and-click tally setup with mesh, filter, score, and nuclide selectors           | `.xml`                  |
| **Optimization Framework**  | Automated parameter sweeps and criticality (k-eff) searches                           | `.csv`                  |
| **Simulation Comparison**   | Side-by-side comparison of statepoints, k-eff convergence, and tally differences      | `statepoint*.h5`        |
| **XML Generation / Import** | Round-trip XML generation and import for geometry, materials, settings, and tallies   | `*.xml`                 |
| **Project Management**      | OpenMC project scaffolding, template picker, and workspace-aware file resolution      | `.nuke-openmc`          |
| **CAD Import**              | Import STEP, IGES, BREP, and STL CAD models and convert them to DAGMC                 | `.step`, `.stl`, `.h5m` |
| **Simulation Runner**       | Execute OpenMC runs (criticality, fixed-source, depletion) with live log streaming    | —                       |

## What the Extension Provides

- **CSG Builder** — Interactive cell/surface tree, boolean operations, and universe nesting with live 3D preview via `nuke-visualizer`
- **DAGMC Editor** — Faceted geometry viewer, group inspector, and Python-backed mesh operations
- **Tally Configurator** — Form-driven tally construction with validation against OpenMC's score/filter schema
- **Optimization Framework** — React-based parameter editor that drives sequential OpenMC sweep runs and criticality searches
- **Simulation Comparison** — Multi-statepoint analysis with delta tables, confidence-interval checks, and consistency tests
- **XML Generation / Import** — Bidirectional sync between the graphical model and OpenMC XML inputs
- **Project Management** — New-project template picker, workspace-aware file resolution, and XML import/export
- **CAD Import** — Backend CAD-to-DAGMC conversion with progress reporting and validation
- **Simulation Runner** — Integrated execution with stdout/stderr streaming, cancellation, and depletion timeline tracking

## Documentation

This extension has two documentation paths:

### 👤 User Documentation

For end users who want to build and run OpenMC simulations.

→ See [`docs/user/`](docs/user/) for guides on:

- [Getting started](docs/user/getting-started.md) (prerequisites, first project, health checks)
- [Simulation Dashboard](docs/user/simulation-dashboard.md) (monitoring runs, metrics, batch control)
- [Coverage and Limitations](docs/user/coverage.md) (what the workbench supports and what it does not)
- [CSG Builder](docs/user/geometry.md) (geometry construction, surfaces, cells, universes)
- [DAGMC Editor](docs/user/dagmc-editor.md) (faceted geometry, group tagging)
- [Tally Configurator](docs/user/tally-configurator.md) (filters, scores, meshes, nuclides)
- [Optimization Framework](docs/user/optimization.md) (parameter sweeps, criticality search)
- [Volume Calculation](docs/user/volume-calculation.md) (stochastic volume estimation)
- [Native Plotting](docs/user/native-plotting.md) (slice, voxel, and ray-traced plots)
- [MGXS Generator](docs/user/mgxs-generator.md) (multi-group cross-section libraries)
- [Shutdown Dose](docs/user/shutdown-dose.md) (R2S / D1S activation workflows)
- [Simulation Comparison](docs/user/simulation-comparison.md) (statepoint deltas, consistency tests, convergence)
- [XML Generation / Import](docs/user/project-management.md) (round-trip workflow)
- [Project Management](docs/user/project-management.md) (templates, open/save, import/export)
- [CAD Import](docs/user/cad-import.md) (STEP/IGES/BREP/STL to DAGMC)
- [Troubleshooting](docs/user/troubleshooting.md) common issues

### 🛠️ Developer Documentation

For developers who want to understand or extend the codebase.

→ See [`docs/dev/`](docs/dev/) for guides on:

- Architecture (frontend/backend/Python layers)
- Frontend module and DI wiring
- Backend services (runner, validation, CAD import, optimization)
- Widget patterns (React widgets, state management)
- RPC protocols and state schema
- Python backend conventions
- Adding a new feature

## Quick Links

| Resource                    | Path                                                           |
| --------------------------- | -------------------------------------------------------------- |
| User docs landing page      | [`docs/user/index.md`](docs/user/index.md)                     |
| Developer docs landing page | [`docs/dev/index.md`](docs/dev/index.md)                       |
| Troubleshooting             | [`docs/user/troubleshooting.md`](docs/user/troubleshooting.md) |

## Dependencies

- `nuke-core` — Python environment management
- `nuke-essentials` — UI components and theming
- `nuke-visualizer` — 3D geometry preview and Plotly charts
- `@theia/core`, `@theia/editor`, `@theia/filesystem`, `@theia/navigator`, `@theia/process`, `@theia/workspace` — Theia platform
- `xml2js` — XML parsing for import workflows

## License

BSD-2-Clause
