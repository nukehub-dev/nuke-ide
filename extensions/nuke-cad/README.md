# Nuke CAD Extension

Parametric CAD, meshing, DAGMC export, and FEM for NukeIDE.

Nuke CAD accepts build123d scripts and `.nuke-cad` GUI documents, then produces
the same simulation-ready artifacts: canonical STEP, a JSON region manifest,
DAGMC `.h5m`, FEM meshes, and OpenFOAM cases. STEP/STP/BREP files open directly
in the CAD viewport.

## Documentation

- [Getting started](docs/user/getting-started.md) — scripts, STEP imports, exports, and environment setup
- [GUI modeler](docs/user/gui-modeler.md) — sketcher, feature tree, assemblies, drawings, and FEM
- [Developer guide](docs/dev/index.md) — architecture, schema, backend pipeline, and testing

CadQuery script support is optional and is not bundled. The default stack is
OCP 7.9 with build123d 0.9.1.

## License

BSD-2-Clause
