# Installation

This page covers how to install NukeIDE from source.

## Prerequisites

| Tool    | Version      | Purpose                             |
| ------- | ------------ | ----------------------------------- |
| Node.js | >= 22        | Theia frontend and build tooling    |
| Yarn    | >= 1.7.0 < 2 | Package manager (monorepo hoisting) |
| Python  | >= 3.12      | Backend services for extensions     |
| Git     | any          | Cloning the repository              |

Optional but recommended:

| Tool          | Purpose                                              |
| ------------- | ---------------------------------------------------- |
| OpenMC        | Monte Carlo simulations (required for OpenMC Studio) |
| DAGMC         | Faceted geometry workflows                           |
| Conda / Mamba | Python environment management                        |

### Nuke CAD Python toolchain

The nuke-cad extension (parametric CAD / meshing / FEM) needs these packages
in the active Python environment; the Nuke Tools environment health check
reports them as required or optional:

| Package              | Required | Purpose                                                                 |
| -------------------- | -------- | ----------------------------------------------------------------------- |
| OCP (`cadquery-ocp`) | yes      | OpenCASCADE B-rep kernel bindings                                       |
| `build123d`          | yes      | Script-based geometry authoring                                         |
| `gmsh`               | yes      | DAGMC imprint/merge and tetrahedral meshing                             |
| `cadquery`           | optional | CadQuery script support                                                 |
| `meshio`             | optional | CalculiX/VTK mesh export                                                |
| `netCDF4`            | optional | ExodusII mesh export                                                    |
| `moab` + `h5py`      | optional | DAGMC `.h5m` export (`moab` wheels are on the index below)              |
| `netgen` / `ngsolve` | optional | Alternative meshing engine (conda-forge `ngsolve` preferred; see below) |

```bash
conda install -c conda-forge ocp "build123d=0.9.1" python-gmsh meshio netcdf4
pip install moab --extra-index-url https://shimwell.github.io/wheels
```

In a plain pip/venv environment use `pip install "build123d==0.9.1" --no-deps cadquery-ocp gmsh meshio netCDF4` instead — pip `cadquery-ocp` must not be mixed into a conda OCP env (it clobbers conda's OCCT binaries; see below).

All of the above except netgen/ngsolve are preinstalled in the Docker image.
The FEM analysis panel additionally needs the external `ccx` (CalculiX)
executable on `PATH` or pointed to with `NUKE_CCX` — it is not a Python
package.

### Dedicated dev/test environment

For running the Python test suites against real dependencies, use a lean conda
env (no ParaView/trame — the test profile doesn't need them, and conda-forge
currently cannot co-solve paraview with a build123d-compatible ocp; see below).
The verified recipe (`~/.conda/envs/nuke` on the maintainer machine; the root
`AGENTS.md` `NUKE_TEST_PYTHON` example points there):

```bash
conda create -n nuke -c conda-forge --strict-channel-priority python=3.13 \
    "ocp=7.8.1.2" "cadquery=2.7.0" "build123d=0.9.1" python-gmsh meshio \
    netCDF4 h5py numpy scipy matplotlib pandas pyyaml pytest pytest-cov
~/.conda/envs/nuke/bin/python -m pip install \
    --extra-index-url https://shimwell.github.io/wheels \
    openmc moab "pydagmc @ git+https://github.com/svalinn/pydagmc@4afa678d24aa091417798ef4b3d11fda98b165f8"
```

The ocp pin matters: conda `ocp` 7.8.1.2 still provides the `TopoDS.*_s`
downcast API that conda build123d requires, while `ocp` 7.9.x dropped it
(build123d then fails with `TopoDS has no attribute 'Vertex_s'`). That API gap
is also why build123d cannot be a conda dependency alongside paraview
(paraview 6.1.1 forces the ocp 7.9 line via occt's vtk-base pin): the Docker
runtime env (`applications/docker/environment.yml`) instead pip-installs
build123d 0.9.1 `--no-deps` (pure Python — it cannot clobber conda's binary
stack) and re-attaches the removed aliases via nuke-cad's OCP 7.9 shim
(`extensions/nuke-cad/python/ocp_compat.py`, activated image-wide through a
site-packages `.pth` hook). The shim is a no-op on ocp 7.8, so both flavors
run the same code.

Keep netgen out of this env. Conda netgen and conda OCP register the same
OCCT types with pybind11 in one process ("type gp_Pnt is already registered!"
in either import order), and the pip `ngsolve` wheel dumps its own OCCT .so
files into the env's `lib/`, clobbering conda's occt (cadquery then fails to
import with undefined-symbol errors). Run netgen engine tests in a separate
pip-OCP env instead — pip `cadquery-ocp` and pip `ngsolve` coexist fine.

## Clone and Install

```bash
# Clone the repository
git clone https://github.com/nukehub-dev/nuke-ide.git
cd nuke-ide

# Install dependencies and build all workspaces
yarn

# Download Theia plugins (Python support, Jupyter, icons, etc.)
yarn download:plugins
```

The `yarn` command will:

1. Install root dependencies
2. Hoist shared packages
3. Run `lerna run prepare` to compile all extensions and applications

## Running

### Docker (all-in-one)

A ready-to-use image with the browser IDE and the full Python backend
environment (`ide` conda env: OpenMC, Trame/ParaView, CAD toolchain) is
available:

```bash
docker compose -f applications/docker/compose.yml up --build
```

Then open `http://localhost:3000`. See
[applications/docker/README.md](../applications/docker/README.md) for details.

### Browser Application

```bash
yarn start:browser
```

By default the server listens on `http://localhost:3000`.

### Electron Application

```bash
yarn start:electron
```

## Building for Production

### Browser Bundle

```bash
yarn build:browser
```

Output goes to `applications/browser/lib/` and `applications/browser/dist/`.

### Electron Bundle

```bash
yarn build:electron
```

Output goes to `applications/electron/dist/`.

### All Extensions

```bash
lerna run build
```

## Selecting Extensions at Build Time

Optional extensions can be left out of a bundle via environment variables:

```bash
# Default: everything except the NukeLab-only nukelab-integration
yarn build:browser

# Everything, including nukelab-integration
NUKE_EXTENSIONS=all yarn build:browser

# Bundle only the core IDE plus openmc-studio (nuke-visualizer is pulled in automatically)
NUKE_EXTENSIONS=openmc-studio yarn build:browser

# Drop additional extensions from the default set
NUKE_EXCLUDE_EXTENSIONS=nuke-sysmon yarn build:browser
```

- `NUKE_EXTENSIONS` — comma-separated allow-list of optional extensions to bundle (`all` = every optional extension).
- `NUKE_EXCLUDE_EXTENSIONS` — comma-separated deny-list applied to the default set (ignored when `NUKE_EXTENSIONS` is set).
- Unset: every extension is bundled except `nukelab-integration`, which only applies to NukeLab deployments and is opt-in.
- `nuke-core` and `nuke-essentials` are required and always ship. Local dependencies resolve automatically: selecting `openmc-studio` pulls in `nuke-visualizer`; excluding `nuke-visualizer` also drops `openmc-studio`.
- Run `yarn ext:list` to preview the resolved set per app without building.

The same variables are exposed as Docker build args (also passed through by `compose.yml`):

```bash
NUKE_EXTENSIONS=all yarn docker:build
```

The selection only affects the bundled IDE; it does not change the Docker Python environment.

## Troubleshooting

**`yarn` fails with engine errors**

> Make sure you're using Yarn classic (`1.x`) and Node.js >= 22.

**Plugins fail to download**

> Run `yarn download:plugins` again with a stable internet connection. Some Open VSX requests may time out.

**Python backends not found**

> Use the command `Nuke: Switch Environment` to select the correct Python interpreter. If OpenMC is missing, install it via `pip install openmc --extra-index-url https://shimwell.github.io/wheels` (or `conda install -c conda-forge openmc`).

**Visualizer reports missing/broken trame**

> The visualizer backends need trame >= 3 (`pip install trame trame-vuetify trame-vtk trame-components` or `conda install -c conda-forge trame trame-vuetify trame-vtk trame-components`). Do not mix pip and conda trame packages in the same environment — the install gets clobbered and `trame.app` goes missing; repair with `pip install --force-reinstall trame` or reinstall via conda only.

**Build errors in extensions**

> Run `lerna run build` from the root. If a single extension fails, navigate to it and run `yarn build` or `tsc` directly to see the error.
