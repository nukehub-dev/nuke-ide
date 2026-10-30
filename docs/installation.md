# Installation

This page covers how to install NukeIDE from source.

## Prerequisites

| Tool    | Version      | Purpose                                                 |
| ------- | ------------ | ------------------------------------------------------- |
| Node.js | >= 22.13.0   | Theia frontend and build tooling                        |
| Yarn    | >= 1.7.0 < 2 | Package manager (monorepo hoisting)                     |
| Python  | 3.13         | Tested backend profile; OpenMC 0.16 needs 3.12 or newer |
| Git     | any          | Cloning the repository                                  |

Optional but recommended:

| Tool          | Purpose                                                                |
| ------------- | ---------------------------------------------------------------------- |
| OpenMC        | Monte Carlo simulations (required for OpenMC Studio; 0.15.3 or 0.16.x) |
| DAGMC         | Faceted geometry workflows                                             |
| Conda / Mamba | Python environment management                                          |

### Nuke CAD Python toolchain

The nuke-cad extension (parametric CAD / meshing / FEM) needs these packages
in the active Python environment; the Nuke Tools environment health check
reports them as required or optional:

| Package                                                             | Required | Purpose                                                                 |
| ------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------- |
| OCP (`ocp=7.9.3.1`)                                                 | yes      | OpenCASCADE B-rep kernel bindings                                       |
| `build123d==0.9.1`                                                  | yes      | Script-based geometry authoring (install `--no-deps`)                   |
| `gmsh` (`python-gmsh`)                                              | yes      | DAGMC imprint/merge and tetrahedral meshing                             |
| `svgpathtools`, `svgelements`, `anytree`, `ezdxf`, `trianglesolver` | yes      | build123d script dependencies                                           |
| `ocpsvg==0.6.0`, `py-lib3mf`                                        | yes      | build123d SVG and 3MF import/export helpers                             |
| `ipython<9`                                                         | yes      | Script-mode introspection helpers                                       |
| `cadquery`                                                          | optional | CadQuery script support (not bundled; install separately)               |
| `meshio`                                                            | optional | CalculiX/VTK mesh export                                                |
| `netCDF4`                                                           | optional | ExodusII mesh export                                                    |
| `moab` + `h5py`                                                     | optional | DAGMC `.h5m` export (`moab` wheels are on the index below)              |
| `netgen` / `ngsolve`                                                | optional | Alternative meshing engine (conda-forge `ngsolve` preferred; see below) |

```bash
conda install -c conda-forge "ocp=7.9.3.1" python-gmsh meshio netcdf4 \
    svgpathtools svgelements anytree ezdxf trianglesolver "ipython<9"
pip install --no-deps "build123d==0.9.1" "ocpsvg==0.6.0"
pip install py-lib3mf
pip install moab --extra-index-url https://shimwell.github.io/wheels
```

In a plain pip/venv environment:

```bash
pip install "cadquery-ocp<7.9" gmsh meshio netCDF4 h5py \
    svgpathtools svgelements anytree ezdxf trianglesolver "ipython<9" py-lib3mf
pip install --no-deps "build123d==0.9.1" "ocpsvg==0.6.0"
```

Never mix pip `cadquery-ocp` into a conda OCP environment — it replaces conda's
OCCT binaries and breaks the stack (see below).

All required packages above are preinstalled in the Docker image. CadQuery is
optional and is not bundled; install it separately if you need CadQuery
scripts. The FEM analysis panel additionally needs the external `ccx` (CalculiX)
executable on `PATH` or pointed to with `NUKE_CCX` — it is not a Python
package.

### Dedicated dev/test environment

CI and the Docker image run the Python suites in the full `ide` environment
from `applications/docker/environment.yml` (Python 3.13, OpenMC, VTK, and the
CAD toolchain). To reproduce it locally:

```bash
conda env create -f applications/docker/environment.yml
SP="$HOME/.conda/envs/ide/lib/python3.13/site-packages"
cp extensions/nuke-cad/python/ocp_compat.py "$SP/ocp_compat.py"
echo 'import ocp_compat; ocp_compat.install_build123d_import_hook()' > "$SP/_nuke_ocp79.pth"
"$HOME/.conda/envs/ide/bin/pip" install --no-deps "build123d==0.9.1" "ocpsvg==0.6.0"
"$HOME/.conda/envs/ide/bin/pip" install pytest pytest-cov
```

The OCP pin matters: build123d 0.9.1 and nuke-cad's compatibility shim target
the OCP 7.9 line. OCP 7.9 removed the `TopoDS.*_s` downcast statics that
build123d expects, so the Docker image and nuke-cad install the pure-Python
build123d package with `--no-deps` and re-attach those aliases through
`extensions/nuke-cad/python/ocp_compat.py` (activated image-wide by a
site-packages `.pth` hook). Never install a conda `build123d`: it tracks a
different OCP flavor and conflicts with this stack. Install `build123d` and
`ocpsvg` with `--no-deps` so pip cannot replace conda's `ocp`.

Keep netgen out of this env. Conda netgen and conda OCP register the same
OCCT types with pybind11 in one process ("type gp_Pnt is already registered!"
in either import order), and the pip `ngsolve` wheel dumps its own OCCT .so
files into the env's `lib/`, clobbering conda's occt (the OCP stack then fails
to import with undefined-symbol errors). Run netgen engine tests in a separate
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
3. Run `lerna run prepare` to compile all extensions (the applications are bundled separately)

## Running

### Docker (all-in-one)

A ready-to-use image with the browser IDE and the full Python backend
environment (`ide` conda env: OpenMC, headless VTK converters, CAD toolchain) is
available:

```bash
docker compose -f applications/docker/compose.yml up --build
```

Then open `http://localhost:3000`. See `applications/docker/README.md` for details.

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

Output goes to `applications/browser/lib/`.

### Electron Bundle

```bash
yarn build:electron
```

Output goes to `applications/electron/dist/`.

### All Extensions

```bash
npx lerna run build
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

> Make sure you're using Yarn classic (`1.x`) and Node.js >= 22.13.0.

**Plugins fail to download**

> Run `yarn download:plugins` again with a stable internet connection. Some Open VSX requests may time out.

**Python backends not found**

> Use the command `Nuke: Switch Environment` to select the correct Python interpreter. If OpenMC is missing, install it via `pip install openmc --extra-index-url https://shimwell.github.io/wheels` (or `conda install -c conda-forge openmc`).

**Visualizer reports missing `vtk`**

> The converter backends need `vtk` for VTK export (`conda install -c conda-forge vtk`); geometry extraction itself is numpy-only. Run the health check (`Visualizer: Run Health Check`) and follow the suggested install commands.

**Build errors in extensions**

> Run `npx lerna run build` from the root. If a single extension fails, navigate to it and run `yarn build` or `tsc` directly to see the error.
