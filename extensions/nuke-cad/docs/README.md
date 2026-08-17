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

- Phase 1 (geometry service, viewport, STEP, region manifest): complete.
- Phase 2 (DAGMC export with imprint/merge and named material groups): complete.

## User guides

- [Getting started](user/getting-started.md)

## Developer guides

- [Architecture](dev/architecture.md)
