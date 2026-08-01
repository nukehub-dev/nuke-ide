# User Documentation

Welcome! This section helps you get the most out of OpenMC Studio's no-code simulation workspace.

## Getting Started

New to OpenMC Studio? Start here:

→ [**Getting Started**](getting-started.md) — Install dependencies, run your first health check, create an OpenMC project, and launch a simulation.

## Feature Guides

| Guide                                                 | What You'll Learn                                                                                                                |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [**Simulation Dashboard**](simulation-dashboard.md)   | Configure every aspect of a model across the Settings, Materials, Depletion, Variance Reduction, Random Ray, and Simulation tabs |
| [**Geometry Workflows**](geometry.md)                 | Build CSG geometry with the interactive cell/surface tree, or import and edit DAGMC geometry                                     |
| [**DAGMC Editor**](dagmc-editor.md)                   | View and edit faceted DAGMC geometry, manage group tags, apply material overrides, and run imprint/merge operations              |
| [**Tally Configurator**](tally-configurator.md)       | Build tallies with mesh editors, filter builders, the score catalog, triggers, and derivatives                                   |
| [**Optimization Framework**](optimization.md)         | Run parameter sweeps and criticality (k-eff) searches                                                                            |
| [**Volume Calculation**](volume-calculation.md)       | Stochastic volume estimation for cells, materials, and universes                                                                 |
| [**Native Plotting**](native-plotting.md)             | Slice, voxel, and ray-traced geometry plots via OpenMC's C++ plot mode                                                           |
| [**MGXS Generator**](mgxs-generator.md)               | Produce multi-group cross-section libraries (automatic and Library modes)                                                        |
| [**Simulation Comparison**](simulation-comparison.md) | Compare multiple statepoint files side-by-side, analyze tally deltas, and inspect convergence                                    |
| [**Project Management**](project-management.md)       | Scaffold new OpenMC projects, manage workspace files, and browse run history                                                     |
| [**CAD Import**](cad-import.md)                       | Import STEP and IGES files and convert them to DAGMC or CSG representations                                                      |

## Quick-Start Workflow

A typical OpenMC Studio session looks like this:

```
Create Project → Build Geometry (CSG or DAGMC) → Define Materials
       ↓
Configure Tallies → Review Settings → Run Simulation
       ↓
Analyze Results → Compare Runs → Export XML / Python
```

Each step has a dedicated panel or widget inside the IDE. You can jump between steps at any time — the model stays synchronized with your edits.

## Need Help?

→ [**Troubleshooting**](troubleshooting.md) — Fixes for common issues: missing OpenMC installation, Python environment problems, blank 3D previews, XML import errors, and simulation runner timeouts.
