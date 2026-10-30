# Nuke CAD Developer Guide

Nuke CAD turns Python scripts and `.nuke-cad` documents into simulation-ready
artifacts: canonical STEP, a JSON region manifest, DAGMC `.h5m`, FEM meshes,
and OpenFOAM cases.

## Start with

- [Architecture](architecture.md) — runtime, geometry service, DAGMC, meshing, FEM, and jobs
- [Backend pipeline](backend-pipeline.md) — script/document build, selectors, and export flow
- [Document schema](document-schema.md) — `.nuke-cad` schema v3 blocks and validation
- [GUI modeler architecture](gui-modeler-architecture.md) — viewport, sketch session, feature tree, and commands

## Subsystems

- [Sketch model](sketch.md) — sketch entities, constraints, and solver behavior
- [Features and patterns](features-patterns.md) — feature types and pattern/transform semantics
- [Drawings and assemblies](drawings-assemblies.md) — drawing sheets, dimensions, BOM, and assembly constraints
- [FEM, meshing, and OpenFOAM](fem-mesh-foam.md) — mesh generation, CalculiX, and case export
- [Viewport outline](viewport-outline.md) — display tolerance, picking, and render-performance budget

## Verification

- [End-to-end testing](testing-e2e.md) — pytest, vitest, OpenMC/DAGMC e2e, and environment gates

## Conventions

- Python backends live in `extensions/nuke-cad/python/`; TypeScript frontend code lives in `src/browser/` and shared contracts in `src/common/`.
- The build123d/OCP stack is pinned together. Do not move `ocp`, `build123d`, or `ocpsvg` independently; see [Installation](../../../../docs/installation.md).
- CadQuery is an optional user install, never a bundled dependency.
