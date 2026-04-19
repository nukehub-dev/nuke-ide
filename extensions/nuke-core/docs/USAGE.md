# Nuke Core Usage Guide

Detailed usage guide for the Nuke Core extension.

## Features

### Enhanced Python Environment Management
- **Auto-detection**: Automatically detects conda, mamba, venv, virtualenv, poetry, pyenv, and system Python environments
- **Workspace venv discovery**: Finds virtual environments in the workspace
- **Environment switching**: Quick switch between environments via status bar or command palette
- **Version checking**: Verifies Python versions and package compatibility
- **Grouped environment picker**: Environments grouped by type (Conda, Venv, Other)
- **Environment actions**: After selecting an environment, open terminal, install packages, or copy Python path

### Environment Creation
- **Create conda environments** with custom Python versions via guided wizard
- **Create venv environments** in the workspace root or a custom location
- **Live terminal output** during creation so you can see progress in real time
- **Duplicate guard**: Warns and offers to switch if the environment already exists
- **Mamba preference**: Uses mamba (faster solver) when available, falls back to conda

### Package Management
- **Install packages directly from the IDE** with pip, uv, or conda
- **Live terminal output** during installation — no silent failures
- **UV support**: Uses `uv pip install` for significantly faster installs when available
- **Mamba/Conda support**: Installs packages with mamba or conda via `--prefix` when possible, falling back to `-n`
- **Automatic fallback**: conda (if selected) → uv → pip (configurable via package manager picker)
- **Automatic Python path resolution**: Uses the detected Python path from the current environment, never triggers PEP 668 externally-managed errors

### Workspace Auto-Detect
- Scans the workspace for `environment.yml`, `environment.yaml`, and `requirements.txt`
- Suggests environment setup when config files are found
- **Auto-creates conda environments** from `environment.yml` with live terminal output
- **Auto-installs dependencies** from `requirements.txt` via pip with live terminal output

### Configuration Validation
- Validates that configured Python paths exist
- Checks conda environment availability
- Warns about missing environment variables

### Health Checks & Diagnostics
- Run comprehensive health checks from the command palette
- View detailed diagnostics for troubleshooting
- Get actionable suggestions for fixing issues
- Checks for uv and mamba availability in addition to standard tools

### Status Bar Integration
- Shows current Nuke environment with type indicator
- Quick access to grouped environment switcher
- Visual indicators for configuration issues
- **Configurable visibility** - avoid duplication with MS Python extension
- **Environment actions submenu**: Open Terminal, Install Packages, Copy Python Path

## Commands

All commands are available in the **Tools** menu or via the Command Palette:

| Command | Description |
|---------|-------------|
| `Nuke: Switch Environment` | Switch to a different environment (grouped by type) |
| `Nuke: Environment Actions` | Select an environment, then choose: Switch / Open Terminal / Install Packages / Copy Python Path |
| `Nuke: Create Environment` | Create a new conda or venv environment with guided wizard |
| `Nuke: Install Package` | Install packages using pip, uv, or conda — with live terminal output |
| `Nuke: Run Health Check` | Run comprehensive health checks |
| `Nuke: Validate Configuration` | Validate settings and paths |
| `Nuke: Show Diagnostics` | View detailed diagnostic information |

## Settings

Settings are available in **Settings → Nuke Utils**:

| Preference | Description | Default |
|------------|-------------|---------|
| `nuke.pythonPath` | Path to Python executable | `""` |
| `nuke.condaEnv` | Conda environment name | `""` |
| `nuke.openmcCrossSections` | Path to OpenMC cross_sections.xml file | `""` |
| `nuke.openmcChainFile` | Path to OpenMC depletion chain XML file | `""` |
| `nuke.showStatusBar` | Control status bar visibility (`auto`, `always`, `never`) | `"auto"` |

### Status Bar Visibility (`nuke.showStatusBar`)

Controls when the Nuke environment status bar is displayed:

- **`auto`** (recommended): Only shows when environment is **not configured**. Once you set up the environment, the status bar hides automatically to avoid clutter. This is ideal when using the MS Python extension which has its own status bar.

- **`always`**: Always display the status bar with current environment info.

- **`never`**: Never show the status bar. Use Commands (Tools menu) to manage environments.

### Using with Microsoft Python Extension

When using the Microsoft Python extension alongside NukeIDE:

1. **Set `nuke.showStatusBar` to `"auto"`** (default)
   - Nuke status bar only appears when environment needs configuration
   - Once configured, MS Python extension's status bar takes over
   - No duplication, clean workspace

2. **Use MS Python extension for:**
   - General Python interpreter selection
   - Language server features (IntelliSense, debugging)

3. **Use Nuke commands for:**
   - Nuclear-specific environment validation
   - OpenMC setup verification
   - Health checks (`Tools → Nuke: Run Health Check`)
   - Environment creation (`Tools → Nuke: Create Environment`)
   - Package installation with live terminal output

4. **Alternative: Set to `"never"`**
   - If you prefer using commands over status bars
   - Access all functionality via Tools menu or Command Palette

## Usage from Another Extension

### Inject the Service

```typescript
import { inject, injectable } from '@theia/core/shared/inversify';
import { NukeCoreService } from 'nuke-core/lib/common';

@injectable()
export class MyExtension {
    @inject(NukeCoreService)
    private readonly nukeCore: NukeCoreService;
}
```

### Check Configuration

```typescript
// Check if Python is configured
if (this.nukeCore.isConfigured()) {
    // Python is configured
}

// Get configuration error message
const error = this.nukeCore.getConfigError();
```

### Detect Python with Requirements (Smart Auto-Detection)

Nuke Core has **smart auto-detection** - it automatically searches ALL available environments (conda, venv, etc.) to find one that has your required packages:

```typescript
// Detect environment with specific package requirements
// Nuke Core will automatically search ALL environments for ones with these packages
const result = await this.nukeCore.detectPythonWithRequirements({
    requiredPackages: [
        { name: 'openmc', required: true },
        { name: 'numpy', required: true, minVersion: '1.20.0' }
    ],
    // Optional: prefer these environment names if multiple match
    autoDetectEnvs: ['openmc', 'nuke-ide'],
    // Also search for venvs in the workspace
    searchWorkspaceVenvs: true
});

if (result.success) {
    console.log('Found environment:', result.command);
    console.log('Environment info:', result.environment);
} else {
    console.log('Missing packages:', result.missingPackages);
}
```

**How Smart Detection Works:**
1. First tries your configured `nuke.pythonPath`
2. Then tries your configured `nuke.condaEnv`
3. Searches ALL available environments for ones with required packages
4. Tries named conda environments from `autoDetectEnvs`
5. Checks workspace venvs (if `searchWorkspaceVenvs: true`)
6. Checks poetry environments
7. Checks pyenv environments
8. Falls back to system Python as last resort

**Note:** You typically don't need `autoDetectEnvs` anymore - nuke-core will find the right environment automatically!

### List and Switch Environments

```typescript
// List all available environments (including workspace venvs)
const environments = await this.nukeCore.listEnvironments(true);

// Get currently selected environment
const current = await this.nukeCore.getSelectedEnvironment();

// Switch to a different environment
await this.nukeCore.switchToEnvironment(environments[0]);
```

### Environment Actions

After selecting an environment, you can install packages or use the path directly:

```typescript
// Install packages in the environment
await this.nukeCore.installPackages({
    packages: ['numpy', 'scipy'],
    pythonPath: env.pythonPath,
    useConda: env.type === 'conda'
});

// Copy the Python executable path to clipboard
await navigator.clipboard.writeText(env.pythonPath);
```

> **Note:** Opening a terminal with the environment activated is handled internally by the `Nuke: Environment Actions` command. Extensions that need this should use Theia's `TerminalService` directly or delegate to the command palette.

### Check Package Dependencies

```typescript
const result = await this.nukeCore.checkDependencies([
    { name: 'openmc', required: true, minVersion: '0.14.0' },
    { name: 'numpy', required: true },
    { name: 'trame', submodule: 'app', required: false }
]);

if (result.available) {
    console.log('All packages available:', result.versions);
} else {
    console.log('Missing:', result.missing);
    console.log('Version mismatches:', result.versionMismatches);
}
```

### Install Packages

```typescript
// Install packages using default Python
const result = await this.nukeCore.installPackages({
    packages: ['openmc', 'numpy'],
    useConda: false,  // Use pip (set to true to try conda first)
    extraArgs: ['--upgrade']
});

if (result.success) {
    console.log('Installed:', result.installed);
} else {
    console.log('Failed:', result.failed);
    console.log('Output:', result.output);
}

// Convenience method for quick installs
await this.nukeCore.installMissingPackages(['openmc', 'vtk']);
```

### Automatic Package Installation Suggestions

When detecting Python with requirements, you can get automatic suggestions for installing missing packages:

```typescript
const result = await this.nukeCore.detectWithInstallSuggestion({
    requiredPackages: [
        { name: 'openmc', required: true },
        { name: 'numpy', required: true }
    ]
});

if (!result.success && result.suggestInstall) {
    console.log('Missing packages:', result.missingPackages);
    console.log('Install command:', result.installCommand);
    
    // Option 1: Show command to user for manual installation
    // Option 2: Automatically install
    await this.nukeCore.installPackages({ 
        packages: result.missingPackages! 
    });
}
```

### Complete Package Management Workflow

Here's a workflow for extensions that need specific packages:

```typescript
async function ensureEnvironment() {
    // 1. Try to detect with required packages
    const result = await this.nukeCore.detectWithInstallSuggestion({
        requiredPackages: [
            { name: 'openmc', required: true },
            { name: 'numpy', required: true }
        ]
    });

    if (result.success) {
        // Environment found with all packages
        return result.command;
    }

    // 2. If packages are missing, suggest installation
    if (result.suggestInstall && result.missingPackages) {
        const shouldInstall = await this.showInstallPrompt(
            `Missing packages: ${result.missingPackages.join(', ')}. Install?`
        );
        
        if (shouldInstall) {
            const installResult = await this.nukeCore.installPackages({
                packages: result.missingPackages
            });
            
            if (installResult.success) {
                // Retry detection after installation
                return this.ensureEnvironment();
            } else {
                throw new Error(`Failed to install packages: ${installResult.failed.join(', ')}`);
            }
        }
    }

    // 3. If no environment found, let user select one
    const environments = await this.nukeCore.listEnvironments(true);
    // ... show picker and let user select
}
```

### Validate Configuration

```typescript
const validation = await this.nukeCore.validateConfig();

if (!validation.valid) {
    for (const error of validation.errors) {
        console.error(`Error in ${error.field}: ${error.message}`);
    }
}

for (const warning of validation.warnings) {
    console.warn(`Warning in ${warning.field}: ${warning.message}`);
}
```

### Health Check

Run health checks on the environment. You can optionally check for specific packages:

```typescript
// Basic health check (environment + configuration)
const health = await this.nukeCore.healthCheck();

// Health check with specific packages
const health = await this.nukeCore.healthCheck(['openmc', 'numpy', 'vtk']);

console.log('Healthy:', health.healthy);
for (const check of health.checks) {
    console.log(`${check.name}: ${check.passed ? '✓' : '✗'} ${check.message}`);
    if (check.suggestion) {
        console.log(`  → ${check.suggestion}`);
    }
}
```

**Default checks (always included):**
- Python Environment availability
- Conda/Mamba availability
- UV availability

**Optional checks (when packages provided):**
- Package availability for each specified package

> **Note:** Configuration validation is a separate API (`validateConfig()`). Call it independently if you need to check settings and paths.

### Get Diagnostics

```typescript
const diagnostics = await this.nukeCore.getDiagnostics();
console.log('Diagnostics:', JSON.stringify(diagnostics, null, 2));
// Includes: platform, Python version, conda info, env vars, available environments, uv/mamba status
```

### Get/Set OpenMC Paths

Nuke Core provides helpers for OpenMC path management. These are simple preference wrappers:

```typescript
// Get paths (checks preferences and environment variables)
const crossSections = this.nukeCore.getCrossSectionsPath();
const chainFile = this.nukeCore.getChainFilePath();

// Set paths (saves to preferences)
await this.nukeCore.setCrossSectionsPath('/path/to/cross_sections.xml');
await this.nukeCore.setChainFilePath('/path/to/chain.xml');
```

> **Note:** These are provided as convenience methods. Extensions can define their own preferences for tool-specific paths.

### Listen for Environment Changes

```typescript
this.nukeCore.onEnvironmentChanged(event => {
    console.log('Environment changed from', event.previous, 'to', event.current);
    console.log('Previous env:', event.previousEnv);
    console.log('New env:', event.currentEnv);
});

// Listen for status changes
this.nukeCore.onStatusChanged(status => {
    console.log('Status:', status.message);
    console.log('Ready:', status.ready);
});

// Listen for environment fallback (when configured env doesn't have required packages)
this.nukeCore.onEnvironmentFallback(event => {
    console.log('Requested env:', event.requestedEnv);
    console.log('Fallback env:', event.fallbackEnv.name);
    console.log('Warning:', event.warning);
    
    // Show user notification
    this.messageService.warn(event.warning, { timeout: 10000 });
});
```

### Quick Checks

```typescript
// Check if Python is ready
const isReady = await this.nukeCore.isReady();

// Require Python (throws helpful error if not available)
try {
    const pythonPath = await this.nukeCore.requirePython();
} catch (error) {
    // Shows user-friendly error message
}

// Get current status
const status = this.nukeCore.getStatus();
console.log(status.message);
```

## Backend API

For direct backend communication:

```typescript
import { NukeCoreBackendService, NukeCoreBackendServiceInterface } from 'nuke-core/lib/common';

@inject(NukeCoreBackendService)
private readonly backend: NukeCoreBackendServiceInterface;

// Set configuration
await this.backend.setConfig({
    pythonPath: '/path/to/python',
    condaEnv: 'my-env'
});

// Get current config
const config = await this.backend.getConfig();

// Detect Python with requirements
const result = await this.backend.detectPythonWithRequirements({
    requiredPackages: [{ name: 'openmc' }],
    autoDetectEnvs: ['openmc', 'nuke-ide'],
    searchWorkspaceVenvs: true
});

// Prepare install command (returns shell command for terminal execution)
const { command, cwd } = await this.backend.prepareInstallPackagesCommand({
    packages: ['numpy', 'scipy'],
    useConda: false,
    cwd: '/workspace/root'
});

// Prepare environment creation command
const cmdInfo = await this.backend.prepareCreateEnvironmentCommand({
    type: 'conda',
    name: 'my-env',
    pythonSpecifier: 'python=3.11'
});
```

### Command Preparation Methods

The backend now exposes `prepare*Command()` methods that return shell commands instead of executing them directly. This allows the frontend to run commands in a **terminal widget** for live output:

```typescript
// Backend returns the command string
const { command, cwd } = await this.backend.prepareInstallPackagesCommand({
    packages: ['openmc'],
    useConda: true
});

// Frontend opens a terminal and executes the command
const terminal = await this.terminalService.newTerminal({ title: 'Install', cwd });
await terminal.start();
this.terminalService.open(terminal, { mode: 'reveal' });
await terminal.executeCommand({ cwd, args: command.split(' ') });
```

Benefits:
- **Live output**: Users see real-time install progress
- **Error visibility**: Failed commands show full stderr in the terminal
- **Interaction**: Commands that prompt for input (e.g., conda solve) work correctly

## Menu Contributions

The extension provides a **Tools** menu in the main menu bar. Other extensions can contribute to this menu using `NukeMenus.TOOLS`:

```typescript
import { NukeMenus } from 'nuke-core/lib/browser/nuke-core-menus';

menus.registerMenuAction(NukeMenus.TOOLS, {
    commandId: 'my-extension.command',
    label: 'My Command',
    order: 'a'
});
```

## File Structure

```
nuke-core/
├── src/
│   ├── common/
│   │   ├── nuke-core-protocol.ts           # TypeScript interfaces & RPC protocol
│   │   └── index.ts                        # Exports
│   ├── browser/
│   │   ├── nuke-core-service.ts            # Frontend service (proxies to backend)
│   │   ├── nuke-core-preferences.ts        # Preference definitions
│   │   ├── nuke-core-menus.ts              # Menu contributions
│   │   ├── nuke-core-commands.ts           # Commands & menu actions (live terminal)
│   │   ├── contributions/
│   │   │   ├── status-bar-contribution.ts  # Status bar widget + env picker
│   │   │   └── workspace-env-contribution.ts # Scans workspace for env config files
│   │   ├── nuke-core-preference-layout.ts  # Settings layout
│   │   └── nuke-core-frontend-module.ts    # DI bindings
│   └── node/
│       ├── services/
│       │   ├── environment/
│       │   │   ├── providers/
│       │   │   │   ├── conda-provider.ts   # Conda/mamba env discovery
│       │   │   │   ├── venv-provider.ts    # Venv/virtualenv discovery
│       │   │   │   └── system-provider.ts  # System Python discovery
│       │   │   ├── utils/
│       │   │   │   ├── conda-resolver.ts   # Conda/mamba installation finder
│       │   │   │   ├── uv-resolver.ts      # UV executable finder
│       │   │   │   └── python-info.ts      # Python version/package inspection
│       │   │   └── environment-service.ts  # Aggregates all providers
│       │   ├── package-service.ts          # Package install command preparation
│       │   └── health-service.ts           # Diagnostics & health checks
│       ├── nuke-core-backend-service.ts    # Backend RPC implementation
│       └── nuke-core-backend-module.ts     # Backend DI bindings
├── docs/
│   └── USAGE.md                            # This file
├── README.md                               # Extension overview
└── package.json
```

## For Extension Developers

If your extension depends on nuke-core, you can request the status bar to be visible when your tools are active. This is useful when `nuke.showStatusBar` is set to `"auto"` - the status bar will appear when your tool opens, even if Python is already configured.

### Requesting Status Bar Visibility

```typescript
import { inject, injectable, postConstruct, preDestroy } from '@theia/core/shared/inversify';
import { NukeCoreStatusBarVisibility, NukeCoreStatusBarVisibilityService } from 'nuke-core/lib/common';

@injectable()
export class MyWidget {
    
    @inject(NukeCoreStatusBarVisibility)
    private readonly visibilityService: NukeCoreStatusBarVisibilityService;
    
    private visibilityHandle?: { dispose: () => void };
    
    // When your widget opens
    onAfterShow(): void {
        // Request status bar visibility
        this.visibilityHandle = this.visibilityService.requestVisibility('my-extension');
    }
    
    // When your widget closes
    onBeforeHide(): void {
        // Release visibility request
        this.visibilityHandle?.dispose();
        this.visibilityHandle = undefined;
    }
}
```

### Example: Widget Contribution

```typescript
@injectable()
export class MyWidgetContribution extends AbstractViewContribution<MyWidget> {
    
    @inject(NukeCoreStatusBarVisibility)
    private readonly visibilityService: NukeCoreStatusBarVisibilityService;
    
    private visibilityHandle?: { dispose: () => void };

    async openView(args?: Partial<OpenViewArguments>): Promise<MyWidget> {
        const widget = await super.openView(args);
        
        // Request visibility when view opens
        this.visibilityHandle = this.visibilityService.requestVisibility('my-extension');
        
        // Listen for widget close
        widget.disposed.connect(() => {
            this.visibilityHandle?.dispose();
            this.visibilityHandle = undefined;
        });
        
        return widget;
    }
}
```

### How It Works

- **Reference counting**: Multiple extensions can request visibility simultaneously
- **Auto-hide**: When all extensions release their requests, the status bar hides (in "auto" mode)
- **Seamless integration**: Works alongside the existing `auto` mode behavior

This allows extensions like `nuke-visualizer` and `openmc-studio` to show the Python environment status when their tools are active, while keeping the workspace clean when they're not in use.

## Architecture

### Frontend (Browser)
- **`NukeCoreService`** - Communicates with backend via WebSocket/JSON-RPC
- **`NukeCoreCommandContribution`** - Commands with live terminal integration (install, create, switch)
- **`NukeCoreStatusBarContribution`** - Shows current environment with grouped picker and actions
- **`NukeCoreVisibilityService`** - Allows extensions to request status bar visibility

### Backend (Node)
The backend is modularized into providers and services:

**Providers** (implement `EnvironmentProvider` interface):
- **`CondaProvider`** - Discovers conda/mamba environments across all installations (Anaconda, Miniforge, Mambaforge, Miniconda, custom paths). Uses `conda env list --json` for cross-platform path resolution. Supports `--prefix` for out-of-root environments (e.g., `~/.conda/envs/`).
- **`VenvProvider`** - Discovers venv/virtualenv in workspace and standard locations
- **`PoetryProvider`** - Discovers Poetry virtual environments via `poetry env list --full-path`
- **`PyenvProvider`** - Discovers pyenv Python installations via `pyenv versions --bare`
- **`SystemProvider`** - Discovers system Python installations

**Utilities**:
- **`CondaResolver`** - Finds conda/mamba executables across common paths and environment variables. Prefers mamba over conda.
- **`UvResolver`** - Finds `uv` executable for fast package installation
- **`PythonInfo`** - Inspects Python executables for versions and installed packages

**Services**:
- **`EnvironmentService`** - Aggregates all providers, manages configuration
- **`PackageService`** - Prepares install commands with fallback chain: mamba/conda → uv → pip
- **`HealthService`** - Diagnostics and health checks
- **`WorkspaceEnvContribution`** - Scans workspace for `environment.yml` / `requirements.txt` and suggests environment setup

### Protocol
Shared TypeScript interfaces in `nuke-core-protocol.ts` with RPC methods:
- `prepareInstallPackagesCommand()` - Returns `{ command, cwd }` for terminal execution
- `prepareCreateEnvironmentCommand()` - Returns `{ command, cwd, expectedPythonPath }`
- `createEnvironment()` - Direct execution (legacy path)

### Key Design Decisions

1. **Live Terminal Execution**: Package installation and environment creation use `prepare*Command()` + `TerminalService` instead of silent `execSync`. This gives users real-time feedback and handles interactive prompts correctly.

2. **Mamba Preference**: Always prefers mamba over conda when available (faster solver). Uses `--prefix <resolvedPath>` when the env path can be resolved; falls back to `-n <name>` otherwise.

3. **Cross-Platform Compatibility**: Uses `OS.type()` from `@theia/core` in frontend code instead of `process.platform` (which is Node-only). Backend handles platform-specific path logic.

4. **Workspace Root as CWD**: All terminal commands use `WorkspaceService.roots[0]` as the working directory instead of `process.cwd()`, ensuring commands run in the correct project context.

5. **UV Integration**: Automatically uses `uv pip install` when available for significantly faster package installation, falling back to pip if uv is not installed.
