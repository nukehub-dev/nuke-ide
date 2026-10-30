# Nuke Visualizer Extension

Plugin-based visualization framework for NukeIDE.

## Overview

`nuke-visualizer` provides shared infrastructure for building visualization plugins. It handles Python environment detection, headless conversion, native 3D widget creation, health checks, and output streaming — so you can focus on your domain-specific visualization logic.

## Plugins

| Plugin              | Domain                | File Types                                                                       | Python Packages                                                 |
| ------------------- | --------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Base Visualizer** | General 3D mesh/DAGMC | `.h5m`, `.vtk`, `.vti`, `.stl`, `.ply`, `.obj`, `.msh`, `.step`, `.stp`, `.brep` | `vtk`; `pydagmc` + `moab` for `.h5m`; `gmsh` for `.msh` and CAD |
| **OpenMC**          | Monte Carlo analysis  | `statepoint*.h5`, `geometry.xml`, `materials.xml`, etc.                          | `openmc`, `h5py`, `numpy`, `vtk`                                |

## What the Framework Provides

- **Python Environment Detection** — Automatically finds Python interpreters with your required packages via `nuke-core`
- **Health Checks** — Plugin-agnostic framework for verifying dependencies with smart install suggestions
- **Headless Conversion** — Runs short-lived Python commands that convert to VTK/JSON and exit (no servers, no ports)
- **Widget Management** — Multi-instance native three.js widgets with theme propagation and deterministic IDs
- **File Open Handling** — Theia `OpenHandler` integration for associating file types with plugins
- **Plotly Integration** — Display interactive 2D plots (spectra, heatmaps, cross-sections)
- **Output Streaming** — Python stdout/stderr streamed to IDE output channels

## Documentation

This extension has two documentation paths:

### 👤 User Documentation

For end users who want to visualize nuclear data.

→ See [`docs/user/`](docs/user/) for guides on:

- Getting started (prerequisites, health checks, first file)
- Base Visualizer (3D mesh/DAGMC viewer controls)
- OpenMC plugin (statepoints, tallies, cross-sections, depletion, geometry, materials)
- Troubleshooting common issues

### 🛠️ Developer Documentation

For developers who want to understand or extend the codebase.

→ See [`docs/dev/`](docs/dev/) for guides on:

- Architecture (frontend/backend/Python layers)
- Shared services (health checks, Python helper, Plotly, widgets)
- RPC protocols and DI wiring
- Widget patterns (native 3D vs React)
- Adding a new plugin
- Python backend conventions

## Quick Links

| Resource                    | Path                                                           |
| --------------------------- | -------------------------------------------------------------- |
| User docs landing page      | [`docs/user/index.md`](docs/user/index.md)                     |
| Developer docs landing page | [`docs/dev/index.md`](docs/dev/index.md)                       |
| Plugin creation guide       | [`docs/dev/adding-a-plugin.md`](docs/dev/adding-a-plugin.md)   |
| Troubleshooting             | [`docs/user/troubleshooting.md`](docs/user/troubleshooting.md) |

## Dependencies

- `nuke-core` — Python environment management
- `nuke-essentials` — UI components and theming
- `@theia/core`, `@theia/filesystem`, `@theia/workspace` — Theia platform
- `plotly.js-dist-min` — Interactive plots

## License

BSD-2-Clause
