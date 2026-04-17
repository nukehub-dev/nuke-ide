# Nuke Core Usage Guide

Detailed usage guide for the Nuke Core extension.

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

// Get error message if not configured
const error = this.nukeCore.getConfigError();
```

### Detect Python

```typescript
// Detect Python based on current config
const result = await this.nukeCore.detectPython();
if (result.success) {
    console.log('Python command:', result.command);
}

// Get cached Python command
const pythonCmd = await this.nukeCore.getPythonCommand();
```

### List Available Environments

```typescript
const environments = await this.nukeCore.listEnvironments();
for (const env of environments) {
    console.log(`${env.name}: ${env.pythonPath} (${env.type})`);
}
```

### Check Package Dependencies

```typescript
const result = await this.nukeCore.checkDependencies([
    { name: 'openmc', required: true },
    { name: 'numpy', required: true },
    { name: 'trame', submodule: 'app', required: false }
]);

if (result.available) {
    console.log('All packages available:', result.versions);
} else {
    console.log('Missing:', result.missing);
}
```

### Validate OpenMC Setup

```typescript
const validation = await this.nukeCore.validateOpenMCSetup();
console.log('Ready:', validation.ready);
console.log('Errors:', validation.errors);
console.log('Warnings:', validation.warnings);
```

### Get OpenMC Paths

```typescript
const crossSections = this.nukeCore.getCrossSectionsPath();
const chainFile = this.nukeCore.getChainFilePath();
```

### Listen for Environment Changes

```typescript
this.nukeCore.onEnvironmentChanged(event => {
    console.log('Environment changed from', event.previous, 'to', event.current);
});
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
    autoDetectEnvs: ['openmc', 'nuke-ide']
});
```

## Menu Contributions

The extension provides a **Tools** menu in the main menu bar. Other extensions can contribute to this menu using `NukeMenus.TOOLS`.

## File Structure

```
nuke-core/
├── src/
│   ├── common/
│   │   ├── nuke-core-protocol.ts   # TypeScript interfaces
│   │   └── index.ts               # Exports
│   ├── browser/
│   │   ├── nuke-core-service.ts    # Frontend service
│   │   ├── nuke-core-preferences.ts # Preference definitions
│   │   ├── nuke-core-menus.ts      # Menu contributions
│   │   ├── nuke-core-frontend-module.ts
│   │   └── nuke-core-preference-layout.ts  # Settings layout
│   └── node/
│       ├── nuke-core-backend-service.ts # Backend implementation
│       └── nuke-core-backend-module.ts
└── package.json
```

## Architecture

- **Frontend (browser)**: `NukeCoreService` - communicates with backend via WebSocket/JSON-RPC
- **Backend (node)**: `NukeCoreBackendServiceImpl` - executes Python commands, manages config
- **Protocol**: Shared TypeScript interfaces in `nuke-core-protocol.ts`
- **Settings Layout**: `NukePreferenceLayoutProvider` - places preferences under "Nuke Utils"

The frontend service proxies requests to the backend, which handles:
1. Python detection (system, conda, venv, pyenv)
2. Conda environment discovery
3. Package availability checking
4. Configuration persistence
