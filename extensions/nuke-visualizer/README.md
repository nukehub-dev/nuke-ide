# Nuke Visualizer Extension

Advanced 3D visualization for nuclear computational data in NukeIDE.

## Features

- Visualize DAGMC (.h5m), VTK, and mesh files directly in NukeIDE
- Embedded ParaView web interface for high-performance rendering
- Support for STL, PLY, OBJ mesh formats
- Headless/off-screen rendering (no native windows)

## Prerequisites

1. **ParaView** with Python support installed in your Python environment
2. **Trame** Python packages:
   ```bash
   pip install trame trame-vuetify
   ```
3. **MOAB** (optional, for DAGMC .h5m file support):
   ```bash
   conda install -c conda-forge moab
   ```

## Setup

### Conda Environment (Recommended)

```bash
conda create -n visualizer python=3.13
conda activate visualizer
conda install -c conda-forge paraview
pip install trame trame-vuetify
```

### Configure NukeIDE

Open **Preferences → Nuke Visualizer** and set:

```json
{
  "nukeVisualizer.pythonPath": "/home/username/.conda/envs/visualizer/bin/python"
}
```

Or specify a conda environment name:

```json
{
  "nukeVisualizer.condaEnv": "visualizer"
}
```

## Usage

1. Open a supported file (VTK, STL, PLY, or DAGMC .h5m)
2. Right-click and select **"Open With → Nuke Visualizer"**
3. Or use Command Palette: **"Open Nuke Visualizer"**

## Development

```bash
cd extensions/nuke-visualizer
yarn install
yarn build
yarn watch  # For development
```

## Architecture

- `src/browser/visualizer-widget.tsx` - Theia widget embedding visualization iframe
- `src/browser/visualizer-contribution.ts` - Commands, menus, and file open handler
- `src/browser/visualizer-frontend-module.ts` - Dependency injection bindings
- `src/browser/visualizer-preferences.ts` - Preference schema and bindings
- `src/node/visualizer-backend-service.ts` - Backend service for spawning Python
- `python/visualizer_app.py` - Python visualizer/ParaView server
- `python/dagmc_converter.py` - DAGMC .h5m to VTK converter
