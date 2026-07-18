# User Documentation

Welcome! This section helps you get the most out of Nuke Visualizer's features.

## Getting Started

New to Nuke Visualizer? Start here:

→ [**Getting Started**](getting-started.md) — Install dependencies, run your first health check, configure your Python environment, and open a file.

## Feature Guides

### Base Visualizer (3D Mesh / DAGMC)

→ [**Base Visualizer**](base-visualizer.md) — View VTK, DAGMC (.h5m), STL, PLY, and OBJ files with interactive 3D controls.

### OpenMC Plugin

The OpenMC plugin handles Monte Carlo simulation data:

| Guide                                                    | What You'll Learn                                                          |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| [**OpenMC Overview**](openmc/index.md)                   | What the plugin does, supported files, typical workflow                    |
| [**Statepoint Viewer**](openmc/statepoint-viewer.md)     | Open `statepoint*.h5` files, inspect k-eff, runtime, tallies               |
| [**Tally Visualization**](openmc/tally-visualization.md) | 3D mesh tallies, geometry overlay, energy spectra, spatial plots, heatmaps |
| [**Cross-Sections (XS)**](openmc/cross-sections.md)      | Plot nuclear cross-sections, temperature comparisons, mixed materials      |
| [**Depletion / Burnup**](openmc/depletion.md)            | Analyze `depletion_results.h5`, plot nuclide evolution, compare runs       |
| [**Geometry Viewer**](openmc/geometry.md)                | Browse `geometry.xml` hierarchy, 3D view, overlap checking                 |
| [**Materials**](openmc/materials.md)                     | Explore `materials.xml`, mix compositions, trace cell linkage              |

## Need Help?

→ [**Troubleshooting**](troubleshooting.md) — Fixes for common issues: missing Python, blank widgets, server timeouts, and menu problems.
