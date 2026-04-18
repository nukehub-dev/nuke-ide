# Nuke Core Extension

Core infrastructure for NukeIDE - provides robust Python environment management, configuration validation, and shared utilities for all extensions.

## Overview

`nuke-core` is a Theia extension that provides:

- **Environment Management**: Auto-detection of conda, venv, virtualenv, poetry, and pyenv environments
- **Configuration Management**: Validated settings for environment paths
- **Package Management**: Install packages directly from the IDE
- **Health Checks**: Comprehensive diagnostics and troubleshooting tools
- **Status Bar**: Context-aware visibility - shows when needed, hides when not

## Features

### 🐍 Multi-Environment Support
- Conda/Mamba environments
- Virtualenv and venv
- Poetry environments
- Pyenv installations
- System Python
- Automatic workspace venv discovery

### ✅ Configuration Validation
- Validates Python executable paths
- Checks environment availability
- Warns about missing environment variables

### 🔧 Health Checks & Diagnostics
- Run health checks from command palette
- Check for specific packages (generic - works with any tool)
- View detailed diagnostics for troubleshooting
- Get actionable suggestions

### 📦 Package Management
- Install packages with pip or conda
- Automatic fallback mechanisms
- Version constraint checking

### 📊 Status Bar
- Shows current environment
- Quick environment switcher
- Configuration issue indicators

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

- **Switch Environment** - Quick switch between detected environments
- **Install Package** - Install packages using pip or conda
- **Run Health Check** - Validate your setup
- **Validate Configuration** - Check settings for errors
- **Show Diagnostics** - View detailed system info

## Quick Start

```typescript
import { inject, injectable } from '@theia/core/shared/inversify';
import { NukeCoreService } from '@nuke-core/browser';

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
