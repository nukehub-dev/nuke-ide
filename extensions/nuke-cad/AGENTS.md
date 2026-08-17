# Nuke CAD

## Purpose

Script-first parametric CAD / meshing / FEM extension for NukeIDE: turn
build123d/CadQuery B-rep scripts into simulation-ready artifacts (STEP,
DAGMC, FEM meshes) consumed by openmc-studio and future physics extensions.

## Ownership

All files under `extensions/nuke-cad/` except generated artifacts (`lib/`,
`node_modules/`, `*.tsbuildinfo`, `__pycache__`).

## Local Contracts

- TypeScript side follows `extensions/AGENTS.md` with `src/browser/`,
  `src/node/`, and `src/common/`.
- Python backend lives in `python/` and is not pip-installed; the IDE spawns
  it as a subprocess via `nuke-core` environment detection.
- The CAD viewport is a purpose-built three.js widget (documented exception to
  the "reuse nuke-visualizer" rule); heavy visualization results still route to
  nuke-visualizer.
- Widget CSS is copied to `lib/` by the `copy-css` build step.
- Python package requirements live in `src/common/packages.json`; never inline
  package lists in services or widgets.
- The converter home is nuke-cad `python/` (`dagmc_export.py`). openmc-studio
  delegates to nuke-cad services: the **Import from nuke-cad...** command loads
  a nuke-cad `.h5m` + `.regions.json` into an OpenMC project, and the DAGMC
  editor's imprinted refacet routes through `dagmc_export.py` when available.

## Work Guidance

- Follow repo style: 4-space indent, single quotes, no trailing commas.
- New source files carry the BSD-2-Clause header.
- Geometry scripts must define a top-level `model` variable holding a
  build123d Part/Compound, CadQuery Workplane, or OCP TopoDS_Shape.
- Heavy Python imports must be guarded so the module stays importable in the
  minimal pytest profile (`pytest` + `numpy` only).
- Region manifest volume entries may include an optional `meshSize` number
  for per-region mesh refinement.

## Verification

```bash
npx lerna run build --scope nuke-cad
yarn test:python   # includes nuke-cad tests/python
yarn lint
```

## Child NAD Index

- None
