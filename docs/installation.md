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

## Troubleshooting

**`yarn` fails with engine errors**

> Make sure you're using Yarn classic (`1.x`) and Node.js >= 22.

**Plugins fail to download**

> Run `yarn download:plugins` again with a stable internet connection. Some Open VSX requests may time out.

**Python backends not found**

> Use the command `Nuke: Switch Environment` to select the correct Python interpreter. If OpenMC is missing, install it via `pip install openmc --extra-index-url https://shimwell.github.io/wheels` (or `conda install -c conda-forge openmc`).

**Build errors in extensions**

> Run `lerna run build` from the root. If a single extension fails, navigate to it and run `yarn build` or `tsc` directly to see the error.
