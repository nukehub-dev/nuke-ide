# Nuke Core Extension

Core infrastructure for NukeIDE - provides Python environment management, configuration, and shared utilities for all extensions.

## Overview

`nuke-core` is a Theia extension that provides:
- Python environment detection and management
- Configuration management (Python paths, OpenMC settings)
- Package dependency checking
- Menu contributions

## Installation

Already included in the NukeIDE extensions. No additional setup required.

## Configuration

Settings are available in **Settings → Nuke Utils**:

| Preference | Description |
|------------|--------------|
| `nuke.pythonPath` | Path to Python executable |
| `nuke.condaEnv` | Conda environment name |
| `nuke.openmcCrossSections` | Path to cross_sections.xml |
| `nuke.openmcChainFile` | Path to depletion chain XML |

## Usage

See [docs/USAGE.md](docs/USAGE.md) for detailed usage instructions.

## Architecture

- **Frontend (browser)**: `NukeCoreService` - communicates with backend via WebSocket/JSON-RPC
- **Backend (node)**: `NukeCoreBackendServiceImpl` - executes Python commands, manages config
- **Protocol**: Shared TypeScript interfaces in `nuke-core-protocol.ts`

## License

BSD-2-Clause
