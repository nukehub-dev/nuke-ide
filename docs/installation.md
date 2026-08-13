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
environment (`trame` conda env: OpenMC, Trame/ParaView, CAD toolchain) is
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
# Default: everything except the hub-only nukelab-integration
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
- Unset: every extension is bundled except `nukelab-integration`, which is hub-only (NukeLab deployments) and opt-in.
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
