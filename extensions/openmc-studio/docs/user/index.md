# User Documentation

Welcome! This section helps you get the most out of OpenMC Studio's no-code simulation workspace.

## Getting Started

New to OpenMC Studio? Start here:

→ [**Getting Started**](getting-started.md) — Install dependencies, run your first health check, create an OpenMC project, and launch a simulation.

## Feature Guides

| Guide | What You'll Learn |
|-------|-------------------|
| [**Simulation Dashboard**](simulation-dashboard.md) | Monitor live simulation status, view batch metrics, track k-eff convergence, and control run execution |
| [**CSG Builder**](csg-builder.md) | Construct constructive solid geometry using an interactive cell/surface tree with boolean operations and live 3D preview |
| [**DAGMC Editor**](dagmc-editor.md) | View and edit faceted DAGMC geometry, manage group tags, and run imprint/merge operations |
| [**Tally Configurator**](tally-configurator.md) | Build tallies with mesh editors, filter builders, score selectors, and nuclide pickers |
| [**Optimization Framework**](optimization-framework.md) | Set up parameter sweeps and surrogate-model-driven optimization campaigns |
| [**Simulation Comparison**](simulation-comparison.md) | Compare multiple statepoint files side-by-side, analyze tally deltas, and inspect convergence |
| [**XML Generation / Import**](xml-generation.md) | Generate OpenMC XML files from the graphical model or import existing XML to populate the model |
| [**Project Management**](project-management.md) | Scaffold new OpenMC projects, manage workspace files, and browse run history |
| [**CAD Import**](cad-import.md) | Import STEP and IGES files and convert them to DAGMC or CSG representations |

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
