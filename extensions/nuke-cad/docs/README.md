# Nuke CAD

Parametric CAD / meshing / FEM extension for NukeIDE.

Nuke CAD provides two authoring modes that converge on the same geometry
pipeline and produce identical simulation-ready artifacts for NukeIDE's physics
extensions:

```
Script mode (.py)          Document mode (.nuke-cad)
build123d/CadQuery         GUI sketcher + feature tree
        │                          │
        └──────┬───────────────────┘
               ▼
    OCP B-rep model with named volumes/surfaces
               │
    canonical STEP + region manifest (sidecar JSON)
               │
    ├→ DAGMC .h5m (imprint/merge via gmsh OCC) → openmc-studio
    ├→ FEM volume mesh (.msh / .inp / .e ExodusII) → CalculiX
    └→ OpenFOAM case + per-solid STL → OpenFOAM
```

## Current status

- Geometry service: script execution, STEP export, viewport tessellation stream, region manifest validation.
- GUI modeler: `.nuke-cad` parametric documents with sketcher, constraints, dimensions, feature tree, and document-level parameters.
- Model Outline panel: read-only tree of manifest volumes/surfaces with two-way viewport picking sync, Ctrl/Cmd multi-select, hide/isolate actions, and one-click fuse fixes for cross-body overlap warnings.
- DAGMC export: gmsh OCC imprint/merge, named material groups, auto-graveyard.
- FEM meshing: gmsh HXT volume meshing (or the optional netgen engine), ExodusII/CalculiX/VTK export, mesh quality report.
- FEM analysis (CalculiX): input-deck writer, boundary-condition/material UI, `ccx` runner with timeout and Stop/cancel, FRD-to-VTK conversion.
- Generic job runner: declarative local subprocess abstraction for solver hooks, with process-group timeout and cancellation.
- OpenFOAM scaffolding: case directory + dictionary generation, per-solid STL export from STEP.

## User guides

- [Getting started with scripts and STEP files](user/getting-started.md)
- [GUI parametric modeler](user/gui-modeler.md)

## Developer guides

- [Architecture](dev/architecture.md)
- [GUI modeler architecture](dev/gui-modeler-architecture.md)
