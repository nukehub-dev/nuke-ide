# Getting Started

Welcome to NukeIDE! This guide will help you get up and running quickly.

## What You'll Need

- **Node.js** >= 18
- **Yarn** >= 1.7.0 and < 2
- **Python** >= 3.12 (for extensions that use Python backends)

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

See the [Installation](./installation) page for detailed platform-specific instructions and troubleshooting.

## Running NukeIDE

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
- **Explore Extensions**: Open the Explorer sidebar and look for the NukeIDE panels contributed by your installed extensions.

## Learn More

- [Nuke Core User Guide](/nuke-core/user/getting-started) — Environment management and package installation
- [Nuke Visualizer User Guide](/nuke-visualizer/user/getting-started) — Opening and visualizing nuclear data
- [OpenMC Studio User Guide](/openmc-studio/user/getting-started) — Building and running simulations
