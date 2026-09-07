# NukeIDE Docker

All-in-one container for NukeIDE: the Theia browser IDE plus the `ide`
conda environment with every Python backend the extensions need
(OpenMC, headless VTK converters, gmsh/CadQuery/pythonocc-core CAD toolchain, DAGMC).

## Quick start

```bash
docker compose -f applications/docker/compose.yml up --build
```

Then open http://localhost:3000.

Or via the root package scripts:

```bash
yarn docker:build
yarn docker:up
```

## What's inside

- **Stage 1 (build)** — `node:22-bookworm`: `yarn install`, `yarn build:browser`,
  `yarn download:plugins`.
- **Stage 2 (runtime)** — `condaforge/miniforge3` with the `ide` conda env
  (`environment.yml`): Python 3.13, Node 22, OpenMC, VTK,
  gmsh, CadQuery (`OCP`), `pythonocc-core` (`OCC`), pydagmc/moab, and
  build123d (pip-installed `--no-deps` by the Dockerfile with nuke-cad's OCP
  7.9 alias shim — see the CAD comment in `environment.yml` for why it is
  not a conda dependency). VTK runs headless (`QT_QPA_PLATFORM=offscreen`,
  `VTK_USE_OFFSCREEN=1`); the IDE's native three.js viewers render the
  converted XML VTK client-side, so no server-side rendering stack ships.

The IDE's environment auto-detection finds the `ide` conda env because it
satisfies all package requirements — no in-container configuration needed.

## Workspace

`compose.yml` mounts `./workspace` (next to the compose file) to
`/root/workspace` in the container so your projects persist across rebuilds,
and a named volume (`nuke-ide-config`) to `/root/.nuke-ide` so IDE settings
survive container recreation.

## Nuclear data (real OpenMC runs)

The bundled pytest suite and most IDE features work without nuclear data, but
running an actual OpenMC simulation needs a cross-section library. Mount it
and set `OPENMC_CROSS_SECTIONS` — both lines are present, commented, in
`compose.yml`:

```yaml
- /path/to/nndc_hdf5:/data/nndc_hdf5:ro
# environment:
#   OPENMC_CROSS_SECTIONS: /data/nndc_hdf5/cross_sections.xml
```

## Notes

- The first build is slow (conda downloads VTK/OpenCASCADE; Theia
  bundles the browser app). Subsequent builds reuse cached layers.
- The Electron desktop app is not part of this image — Docker support targets
  the browser application only. Dev-only npm packages (electron, lerna,
  typescript, …) are pruned from the image to keep it lean.
