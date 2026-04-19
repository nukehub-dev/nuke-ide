# Nuke Core Extension

Core infrastructure for NukeIDE - provides robust Python environment management, configuration validation, and shared utilities for all extensions.

## Overview

`nuke-core` is a Theia extension that provides:

- **Environment Management**: Auto-detection of conda, mamba, venv, virtualenv, and system Python environments
- **Environment Creation**: Create conda and venv environments directly from the IDE
- **Environment Deletion**: Delete user-created conda/venv environments with type-to-confirm safety
- **Configuration Management**: Validated settings for environment paths
- **Package Management**: Install packages with pip, uv, or conda — with live terminal output
- **Health Checks**: Comprehensive diagnostics and troubleshooting tools
- **Status Bar**: Context-aware visibility - shows when needed, hides when not
- **Workspace Auto-Detect**: Discovers `environment.yml` and `requirements.txt` automatically; suggests update when already configured

## Features

### 🐍 Multi-Environment Support
- **Conda / Mamba** environments (Anaconda, Miniconda, Miniforge, Mambaforge)
- **Virtualenv** and **venv**
- **System Python**
- **Poetry** environments (via `poetry env list --full-path`)
- **Pyenv** installations (via `pyenv versions --bare`)
- Automatic workspace venv discovery
- Cross-platform path support (Linux, macOS, Windows)

### 🏗️ Environment Creation
- Create **conda** environments with custom Python versions
- Create **venv** environments in the workspace
- Live terminal output during creation
- Duplicate detection — warns if environment already exists
- User-created environments stored in `~/.nuke-ide/envs/`

### 🗑️ Environment Deletion
- Delete **user-created** conda environments (in `~/.nuke-ide/envs/`) and **all venvs**
- Protected: system, pyenv, poetry, and base conda environments cannot be deleted
- **Type-to-confirm** safety: must type the environment name to confirm
- Status bar refreshes automatically after deletion

### 📦 Package Management
- Install packages via **pip**, **uv** (fast), or **conda/mamba**
- Live terminal output during installation
- Automatic Python path resolution — never hits system PEP 668 restrictions
- Package manager picker: choose pip or conda at install time
- Conda-only package support: mark packages with `condaOnly: true` (e.g., `paraview`)

### 🔔 Workspace Auto-Detect
- Scans workspace for `environment.yml`, `environment.yaml`, `requirements.txt`
- Suggests **Create** when unconfigured; suggests **Update/Recreate** when already configured
- Auto-creates conda environments from `environment.yml` into `~/.nuke-ide/envs/`
- Auto-installs dependencies from `requirements.txt` via pip
- Dismissed prompts are persisted across reloads in `localStorage`

### ✅ Configuration Validation
- Validates Python executable paths
- Checks environment availability
- Warns about missing environment variables

### 🔧 Health Checks & Diagnostics
- Run health checks from command palette
- Check for specific packages (generic - works with any tool)
- View detailed diagnostics for troubleshooting
- Get actionable suggestions
- **UV** and **Mamba** availability checks

### 📊 Status Bar
- Shows current environment with type icon
- Quick environment switcher (grouped by type)
- Configuration issue indicators
- **Environment Actions** menu: Re-select, Open Terminal, Install Packages, Update from env file, Copy Path, Delete

## Installation

Already included in the NukeIDE extensions. No additional setup required.

## Configuration

Settings are available in **Settings → Nuke Utils**:

| Preference | Description |
|------------|-------------|
| `nuke.pythonPath` | Path to Python executable |
| `nuke.condaEnv` | Conda environment name |
| `nuke.openmcCrossSections` | Path to cross_sections.xml |
| `nuke.openmcChainFile` | Path to depletion chain XML |
| `nuke.showStatusBar` | Control status bar visibility (`auto`, `always`, `never`) |
| `nuke.pipExtraIndexUrl` | Extra pip index URL for private packages (e.g., Azure Artifacts) |
| `nuke.condaChannels` | Comma-separated conda channels (default: `conda-forge`) |

### Using with MS Python Extension

If you're using the Microsoft Python extension, set `nuke.showStatusBar` to:
- **`auto`** (recommended): Only shows when environment is not configured. Hides once configured to avoid duplication.
- **`never`**: Use Commands (Tools menu) for environment management instead.

## Commands

Access via **Tools** menu or Command Palette:

| Command | Description |
|---------|-------------|
| **Switch Environment** | Quick switch between detected environments (grouped picker) |
| **Environment Actions** | Pick an environment, then choose: Switch / Open Terminal / Install / Update / Copy / Delete |
| **Create Environment** | Create a new conda or venv environment |
| **Delete Environment** | Delete a user-created environment (type-to-confirm) |
| **Install Package** | Install packages using pip, uv, or conda — with live terminal output |
| **Run Health Check** | Validate your setup |
| **Validate Configuration** | Check settings for errors |
| **Show Diagnostics** | View detailed system info |

## Quick Start

```typescript
import { inject, injectable } from '@theia/core/shared/inversify';
import { NukeCoreService } from 'nuke-core/lib/common';

@injectable()
export class MyExtension {
    @inject(NukeCoreService)
    private readonly nukeCore: NukeCoreService;

    async doSomething() {
        // Detect Python with required packages
        const result = await this.nukeCore.detectPythonWithRequirements({
            requiredPackages: [{ name: 'openmc' }],
            searchWorkspaceVenvs: true
        });

        if (result.success) {
            console.log('Using:', result.environment?.name);
        }
    }
}
```

## Documentation

See [docs/USAGE.md](docs/USAGE.md) for detailed API documentation and examples.

## License

BSD-2-Clause
