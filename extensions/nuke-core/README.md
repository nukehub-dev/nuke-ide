# Nuke Core Extension

Core infrastructure for NukeIDE - provides robust Python environment management, configuration validation, and shared utilities for all extensions.

## Overview

`nuke-core` is a Theia extension that provides:

- **Environment Management**: Auto-detection of conda, mamba, venv, virtualenv, and system Python environments
- **Environment Creation**: Create conda and venv environments directly from the IDE
- **Configuration Management**: Validated settings for environment paths
- **Package Management**: Install packages with pip, uv, or conda — with live terminal output
- **Health Checks**: Comprehensive diagnostics and troubleshooting tools
- **Status Bar**: Context-aware visibility - shows when needed, hides when not
- **Workspace Auto-Detect**: Discovers `environment.yml` and `requirements.txt` automatically

## Features

### 🐍 Multi-Environment Support
- **Conda / Mamba** environments (Anaconda, Miniconda, Miniforge, Mambaforge)
- **Virtualenv** and **venv**
- **System Python**
- Supports **poetry** and **pyenv** types in the protocol (discovery via system Python)
- Automatic workspace venv discovery
- Cross-platform path support (Linux, macOS, Windows)

### 🏗️ Environment Creation
- Create **conda** environments with custom Python versions
- Create **venv** environments in the workspace
- Live terminal output during creation
- Duplicate detection — warns if environment already exists
- Project-local environments stored in `<workspace>/.nuke-ide/envs/`

### 📦 Package Management
- Install packages via **pip**, **uv** (fast), or **conda/mamba**
- Live terminal output during installation
- Automatic Python path resolution — never hits system PEP 668 restrictions
- Package manager picker: choose pip or conda at install time

### 🔔 Workspace Auto-Detect
- Scans workspace for `environment.yml`, `environment.yaml`, `requirements.txt`
- Suggests environment setup when files are found
- Guides users to create environments from config files

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
- **Environment Actions** menu: Open Terminal, Install Packages, Copy Path

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

### Using with MS Python Extension

If you're using the Microsoft Python extension, set `nuke.showStatusBar` to:
- **`auto`** (recommended): Only shows when environment is not configured. Hides once configured to avoid duplication.
- **`never`**: Use Commands (Tools menu) for environment management instead.

## Commands

Access via **Tools** menu or Command Palette:

| Command | Description |
|---------|-------------|
| **Switch Environment** | Quick switch between detected environments (grouped picker) |
| **Environment Actions** | Pick an environment, then choose: Switch / Open Terminal / Install Packages / Copy Path |
| **Create Environment** | Create a new conda or venv environment |
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
