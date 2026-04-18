# Nuke Core Usage Guide

Detailed usage guide for the Nuke Core extension.

## Features

### Enhanced Python Environment Management
- **Auto-detection**: Automatically detects conda, venv, virtualenv, poetry, and pyenv environments
- **Workspace venv discovery**: Finds virtual environments in the workspace
- **Environment switching**: Quick switch between environments via status bar or command palette
- **Version checking**: Verifies Python versions and package compatibility

### Configuration Validation
- Validates that configured Python paths exist
- Checks conda environment availability
- Warns about missing environment variables

### Health Checks & Diagnostics
- Run comprehensive health checks from the command palette
- View detailed diagnostics for troubleshooting
- Get actionable suggestions for fixing issues

### Package Management
- Install packages directly from the IDE
- Automatic fallback from conda to pip
- Install missing dependencies with one click

### Status Bar Integration
- Shows current Nuke environment
- Quick access to environment switcher
- Visual indicators for configuration issues
- **Configurable visibility** - avoid duplication with MS Python extension

## Commands

All commands are available in the **Tools** menu or via the Command Palette:

| Command | Description |
|---------|-------------|
| `Nuke: Switch Environment` | Switch to a different environment |
| `Nuke: Install Package` | Install packages using pip or conda |
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

4. **Alternative: Set to `"never"`**
   - If you prefer using commands over status bars
   - Access all functionality via Tools menu or Command Palette

## Usage from Another Extension

### Inject the Service

```typescript
import { inject, injectable } from '@theia/core/shared/inversify';
import { NukeCoreService } from '@nuke-core/browser';

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
1. First tries your configured `nuke.pythonPath` or `nuke.condaEnv`
2. Then searches ALL conda environments for ones with required packages
3. Checks workspace venvs (if `searchWorkspaceVenvs: true`)
4. Returns the best match (prioritizes complete package sets)
5. Falls back to system Python as last resort

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
- Environment availability
- Configuration validity

**Optional checks (when packages provided):**
- Package availability for each specified package

### Get Diagnostics

```typescript
const diagnostics = await this.nukeCore.getDiagnostics();
console.log('Diagnostics:', JSON.stringify(diagnostics, null, 2));
// Includes: platform, Python version, conda info, env vars, available environments
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
import { NukeCoreBackendService } from '@nuke-core/common';

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
```

## Menu Contributions

The extension provides a **Tools** menu in the main menu bar. Other extensions can contribute to this menu using `NukeMenus.TOOLS`:

```typescript
import { NukeMenus } from '@nuke-core/browser';

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
│   │   ├── nuke-core-protocol.ts      # TypeScript interfaces
│   │   └── index.ts                   # Exports
│   ├── browser/
│   │   ├── nuke-core-service.ts       # Frontend service
│   │   ├── nuke-core-preferences.ts   # Preference definitions
│   │   ├── nuke-core-menus.ts         # Menu contributions
│   │   ├── nuke-core-commands.ts      # Commands & menu actions
│   │   ├── nuke-core-status-bar.ts    # Status bar contribution
│   │   ├── nuke-core-preference-layout.ts  # Settings layout
│   │   └── nuke-core-frontend-module.ts
│   └── node/
│       ├── nuke-core-backend-service.ts    # Backend implementation
│       └── nuke-core-backend-module.ts
├── docs/
│   └── USAGE.md                       # This file
├── README.md                          # Extension overview
└── package.json
```

## For Extension Developers

If your extension depends on nuke-core, you can request the status bar to be visible when your tools are active. This is useful when `nuke.showStatusBar` is set to `"auto"` - the status bar will appear when your tool opens, even if Python is already configured.

### Requesting Status Bar Visibility

```typescript
import { inject, injectable, postConstruct, preDestroy } from '@theia/core/shared/inversify';
import { NukeCoreStatusBarVisibility, NukeCoreStatusBarVisibilityService } from '@nuke-core/browser';

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

- **Frontend (browser)**: `NukeCoreService` - communicates with backend via WebSocket/JSON-RPC
- **Backend (node)**: `NukeCoreBackendServiceImpl` - executes Python commands, manages config
- **Protocol**: Shared TypeScript interfaces in `nuke-core-protocol.ts`
- **Settings Layout**: `NukePreferenceLayoutProvider` - places preferences under "Nuke Utils"
- **Status Bar**: `NukeCoreStatusBarContribution` - shows current environment with visibility management
- **Commands**: `NukeCoreCommandContribution` - provides health check, diagnostics, etc.
- **Visibility Service**: `NukeCoreVisibilityService` - allows extensions to request status bar visibility

The frontend service proxies requests to the backend, which handles:
1. Python detection (system, conda, venv, virtualenv, pyenv, poetry)
2. Conda environment discovery
3. Workspace venv discovery
4. Package availability checking
5. Package installation (pip/conda)
6. Configuration persistence
7. Health checks and diagnostics
