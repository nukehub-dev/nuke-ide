# Getting Started

Welcome to NukeIDE! This guide will help you get up and running quickly.

## What You'll Need

- **Node.js** >= 22.13.0
- **Yarn** >= 1.7.0 and < 2
- **Python** 3.13 for the tested backend profile (OpenMC 0.16 also runs on Python 3.12; OpenMC 0.15.3 supports older interpreters)

## Installation

1. **Clone the repository**

   ```bash
   git clone https://github.com/nukehub-dev/nuke-ide.git
   cd nuke-ide
   ```

2. **Install dependencies**

   ```bash
   yarn
   ```

   This installs root dependencies and uses Lerna to prepare all workspaces.

3. **Download Theia plugins**

   ```bash
   yarn download:plugins
   ```

See the [Installation](installation.md) page for detailed platform-specific instructions and troubleshooting.

## Running NukeIDE

![NukeIDE workbench with the Nuke Tools sidebar and an OpenMC Studio project](images/workbench.png)

### Browser Version

```bash
yarn start:browser
```

Then open `http://localhost:3000` in your browser.

### Desktop (Electron) Version

```bash
yarn start:electron
```

## Next Steps

- **Configure Python**: Use the status bar or command palette (`Nuke: Switch Environment`) to select your Python environment.
- **Run a Health Check**: Press `Ctrl+Shift+P` (or `Cmd+Shift+P`) and type `Nuke: Run Health Check`.
- **Open Nuke Tools**: Click the tools icon in the left activity bar (or run `Nuke: Focus Tools Sidebar`) to browse and search every NukeIDE command.
- **Explore Extensions**: Open the Explorer sidebar and look for the NukeIDE panels contributed by your installed extensions.

## Learn More

### Running the GUI smoke tests

The repo ships a Playwright smoke suite for the browser UI (`tests/ui/`). One-time setup: `npx playwright install chromium`. Then build the browser app once (`yarn build:browser`) and run `yarn test:ui` — it starts the app on `127.0.0.1:3000`, exercises the workbench, dashboard, and viewer windows in headless Chromium, and shuts everything down afterwards. Failures drop screenshots and traces into `test-results/`.

- [Nuke Core User Guide](/nuke-core/user/getting-started) — Environment management and package installation
- [Nuke Visualizer User Guide](/nuke-visualizer/user/getting-started) — Opening and visualizing nuclear data
- [OpenMC Studio User Guide](/openmc-studio/user/getting-started) — Building and running simulations
- [Nuke CAD User Guide](/nuke-cad/user/getting-started) — Parametric models, meshing, DAGMC export, and FEM
