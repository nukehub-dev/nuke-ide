# Nuke CAD

Parametric CAD / meshing / FEM extension for NukeIDE.

Nuke CAD turns Python-authored B-rep models (build123d / CadQuery on OCP/OCCT)
into simulation-ready artifacts for NukeIDE's physics extensions:

```
build123d/CadQuery script (.py = source of truth)
  → OCP B-rep model with named volumes/surfaces
  → canonical STEP + region manifest (sidecar JSON)
  ├→ DAGMC .h5m (imprint/merge via gmsh OCC) → openmc-studio
  ├→ FEM volume mesh (.msh / .inp / .e ExodusII) → CalculiX
  └→ region-named STL → OpenFOAM (future)
```

## Current status

- Geometry service: script execution, STEP export, viewport tessellation stream, region manifest validation.
- DAGMC export: gmsh OCC imprint/merge, named material groups, auto-graveyard.
- FEM meshing: gmsh HXT volume meshing, ExodusII/CalculiX/VTK export, mesh quality report.

## User guides

- [Getting started](user/getting-started.md)

## Developer guides

- [Architecture](dev/architecture.md)
