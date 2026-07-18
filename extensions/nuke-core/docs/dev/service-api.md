# Service API Guide

This guide shows how to use **nuke-core** from another Theia extension. All examples are in TypeScript and assume you are using Theia's Inversify dependency injection container.

> **Source of truth**: The definitive types and JSDoc are in [`src/common/nuke-core-protocol.ts`](../../src/common/nuke-core-protocol.ts) and [`src/browser/services/nuke-core-service.ts`](../../src/browser/services/nuke-core-service.ts).

---

## Table of Contents

1. [Inject the Service](#inject-the-service)
2. [Check Configuration](#check-configuration)
3. [Detect Python with Requirements](#detect-python-with-requirements)
4. [List and Switch Environments](#list-and-switch-environments)
5. [Install Packages](#install-packages)
   - [`ensurePackages`](#ensurepackages)
   - [`installPackages`](#installpackages)
   - [Manual terminal execution](#manual-terminal-execution)
6. [Check Dependencies](#check-dependencies)
7. [Health Check](#health-check)
8. [Validate Configuration](#validate-configuration)
9. [Get Diagnostics](#get-diagnostics)
10. [Get/Set OpenMC Paths](#getset-openmc-paths)
11. [Listen for Environment Changes](#listen-for-environment-changes)
12. [Quick Checks](#quick-checks)
13. [Backend API](#backend-api)

---

## Inject the Service

Import `NukeCoreService` from the common package and inject it into your extension class:

```typescript
import { inject, injectable } from '@theia/core/shared/inversify';
import { NukeCoreService } from 'nuke-core/lib/common';

@injectable()
export class MyExtension {
  @inject(NukeCoreService)
  private readonly nukeCore: NukeCoreService;
}
```

---

## Check Configuration

```typescript
// Check if Python is configured
if (this.nukeCore.isConfigured()) {
  // Python path or conda env is set
}

// Get a human-readable configuration error, if any
const error = this.nukeCore.getConfigError();
```

---

## Detect Python with Requirements

Smart auto-detection searches **all** available environments for one that satisfies your package requirements.

```typescript
const result = await this.nukeCore.detectPythonWithRequirements({
  requiredPackages: [
    { name: 'openmc', required: true },
    { name: 'numpy', required: true, minVersion: '1.20.0' },
    { name: 'paraview', condaOnly: true }
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

**Detection order:**

1. Configured `nuke.pythonPath`
2. Configured `nuke.condaEnv`
3. All available environments filtered by required packages
4. Named conda environments from `autoDetectEnvs`
5. Workspace venvs (if `searchWorkspaceVenvs: true`)
6. Poetry environments
7. Pyenv environments
8. System Python (last resort)

---

## List and Switch Environments

```typescript
// List all available environments (including workspace venvs)
const environments = await this.nukeCore.listEnvironments(true);

// Get the currently selected environment
const current = await this.nukeCore.getSelectedEnvironment();

// Switch to a different environment
await this.nukeCore.switchToEnvironment(environments[0]);
```

---

## Install Packages

### `ensurePackages`

The easiest way to guarantee required packages are available in the **configured** environment. This checks dependencies, prompts the user if anything is missing, installs via a live terminal, and re-checks.

```typescript
import { EnvironmentActionsHelper } from 'nuke-core/lib/browser/services';

@injectable()
export class MyExtension {
  @inject(EnvironmentActionsHelper)
  private readonly envActions: EnvironmentActionsHelper;

  async setup() {
    const result = await this.envActions.ensurePackages({
      requiredPackages: [
        { name: 'openmc', required: true },
        { name: 'numpy', required: true }
      ],
      title: 'Install OpenMC dependencies'
    });

    if (result.success) {
      console.log('Ready:', result.environment?.name);
      console.log('Python:', result.command);
    } else if (result.installed === false) {
      console.log('User declined installation');
    } else if (!result.environment) {
      console.log('No configured environment');
    } else {
      console.log('Failed to install:', result.missingPackages);
    }
  }
}
```

**What `ensurePackages` does:**

1. Gets the **configured** environment (never a fallback).
2. Runs `checkDependencies()` directly on that environment's Python path.
3. If all packages exist → returns success immediately.
4. If packages are missing → shows a Theia notification with an **Install** action.
5. If the user clicks **Install** → launches a live terminal and installs into the configured environment.
6. Re-checks dependencies to verify.
7. Returns the final result.

> **Important:** `ensurePackages` checks **only** the configured environment. It does **not** search other environments or return fallbacks. If you need discovery across all envs, use `detectPythonWithRequirements` instead.

### `installPackages`

One-shot install into a specific environment with live terminal output.

```typescript
const result = await this.envActions.installPackages({
  packages: ['openmc', 'numpy'],
  title: 'Install OpenMC dependencies',
  useConda: false, // use pip (set true for conda/mamba)
  channels: ['conda-forge'],
  extraIndexUrl: 'https://shimwell.github.io/wheels'
});

if (result.success) {
  console.log(result.message);
} else {
  console.log(result.message);
}
```

**How it works:**

1. Resolves the **configured** environment's Python path.
2. Resolves workspace root as CWD.
3. Calls `prepareInstallPackagesCommand()` to build the shell command.
4. Runs the command in a live terminal widget.
5. Returns `{ success, message }`.

### Manual Terminal Execution

If you need custom terminal handling (e.g., custom widgets), use the low-level `prepareInstallPackagesCommand()`:

```typescript
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';

@injectable()
export class MyExtension {
  @inject(TerminalService)
  private readonly terminalService: TerminalService;

  async customInstall() {
    // 1. Prepare the command
    const { command, cwd } = await this.nukeCore.prepareInstallPackagesCommand({
      packages: ['openmc', 'numpy'],
      useConda: false,
      pythonPath: '/home/user/.conda/envs/dev/bin/python'
    });

    // 2. Create and run in your own terminal
    const terminal = await this.terminalService.newTerminal({ title: 'Custom Install', cwd });
    await terminal.start();
    this.terminalService.open(terminal, { mode: 'reveal' });
    await terminal.executeCommand({ cwd, args: command.split(' ') });
  }
}
```

### Custom Channels and Indexes

Set global defaults in **Settings → Nuke Utils**, or override per-package in `PackageDependency`:

```typescript
const result = await this.nukeCore.detectPythonWithRequirements({
  requiredPackages: [
    { name: 'pytorch', channels: ['pytorch', 'nvidia'] },
    { name: 'openmc', condaOnly: true },
    { name: 'openmc', extraIndexUrl: 'https://shimwell.github.io/wheels' },
    { name: 'pydagmc', installCommand: 'pip install git+https://github.com/svalinn/pydagmc' }
  ]
});
```

Per-override at install time:

```typescript
const result = await this.envActions.installPackages({
  packages: ['pytorch', 'cuda-toolkit'],
  useConda: true,
  channels: ['pytorch', 'nvidia', 'conda-forge'],
  extraIndexUrl: 'https://my-index.example.com/simple'
});
```

### `PackageDependency` Fields

| Field            | Description                                                 |
| ---------------- | ----------------------------------------------------------- |
| `name`           | Package name to import                                      |
| `submodule`      | Submodule for version check (e.g., `'app'` for `trame.app`) |
| `required`       | Whether this package is required or optional                |
| `minVersion`     | Minimum version required                                    |
| `condaOnly`      | Use `conda install` instead of `pip` (e.g., `paraview`)     |
| `channels`       | Conda channels for this package                             |
| `extraIndexUrl`  | Extra pip index URL                                         |
| `installCommand` | Explicit install command override (highest priority)        |

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
  console.log('Suggested command:', result.installCommand);

  const installResult = await this.envActions.installPackages({
    packages: result.missingPackages!,
    title: 'Install missing dependencies'
  });

  if (installResult.success) {
    const retry = await this.nukeCore.detectPythonWithRequirements({
      requiredPackages: [
        { name: 'openmc', required: true },
        { name: 'numpy', required: true }
      ]
    });
    if (retry.success) {
      console.log('Environment ready:', retry.environment?.name);
    }
  }
}
```

### Manual Workflow (Advanced)

If you need custom UI or logic, use the lower-level APIs directly:

```typescript
// 1. Detect
const result = await this.nukeCore.detectPythonWithRequirements({
  requiredPackages: [{ name: 'openmc', required: true }]
});

if (result.success) {
  return result.command;
}

// 2. Prompt yourself
if (result.missingPackages) {
  const installResult = await this.envActions.installPackages({
    packages: result.missingPackages,
    title: 'Install missing dependencies'
  });

  if (installResult.success) {
    // 3. Retry detection
    const retry = await this.nukeCore.detectPythonWithRequirements({
      requiredPackages: [{ name: 'openmc', required: true }]
    });
    if (retry.success) {
      return retry.command;
    }
  }
}
```

---

## Check Dependencies

Check whether specific packages are installed in the currently configured environment:

```typescript
const result = await this.nukeCore.checkDependencies([
  { name: 'openmc', required: true, minVersion: '0.14.0' },
  { name: 'numpy', required: true },
  { name: 'trame', submodule: 'app', required: false },
  { name: 'paraview', condaOnly: true, required: true }
]);

if (result.available) {
  console.log('All packages available:', result.versions);
} else {
  console.log('Missing:', result.missing);
  console.log('Version mismatches:', result.versionMismatches);
}
```

---

## Health Check

Run comprehensive health checks on the environment. You can optionally check for specific packages with metadata-driven install suggestions.

```typescript
// Basic health check (environment + configuration)
const health = await this.nukeCore.healthCheck();

// Health check with packages
const health = await this.nukeCore.healthCheck([
  { name: 'openmc', extraIndexUrl: 'https://shimwell.github.io/wheels' },
  { name: 'paraview', condaOnly: true },
  { name: 'pydagmc', installCommand: 'pip install git+https://github.com/svalinn/pydagmc' }
]);

console.log('Healthy:', health.healthy);
for (const check of health.checks) {
  console.log(`${check.name}: ${check.passed ? '✓' : '✗'} ${check.message}`);
  if (check.suggestion) {
    console.log(`  → ${check.suggestion}`);
  }
}
```

**Default checks (always included):**

- Configured Python Environment availability (checks your explicitly configured path/env, not fallbacks)
- Conda/Mamba availability
- UV availability
- Active Python Environment (shown when a fallback env is being used because the configured one lacks required packages)

**Optional checks (when packages provided):**

- Package availability for each specified package — checked against the **configured** environment, not fallbacks.
- Missing required packages are reported as `error` severity; optional packages as `warning`.
- Smart install suggestions based on `PackageDependency` metadata:
  - `installCommand` → used as-is (highest priority)
  - `condaOnly` → `conda install -c <channels> <pkg>`
  - `extraIndexUrl` → `pip install --extra-index-url <url> <pkg>`
  - fallback → `pip install <pkg>`

> **Note:** Configuration validation is a separate API (`validateConfig()`). Call it independently if you need to check settings and paths.

---

## Validate Configuration

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

---

## Get Diagnostics

```typescript
const diagnostics = await this.nukeCore.getDiagnostics();
console.log('Diagnostics:', JSON.stringify(diagnostics, null, 2));
// Includes: platform, Python version, conda info, env vars,
// available environments, uv/mamba status
```

---

## Get/Set OpenMC Paths

Nuke Core provides convenience helpers for OpenMC path management. These are simple preference wrappers.

```typescript
// Get paths (checks preferences and environment variables)
const crossSections = this.nukeCore.getCrossSectionsPath();
const chainFile = this.nukeCore.getChainFilePath();

// Set paths (saves to preferences)
await this.nukeCore.setCrossSectionsPath('/path/to/cross_sections.xml');
await this.nukeCore.setChainFilePath('/path/to/chain.xml');
```

> **Note:** These are convenience methods. Extensions can define their own preferences for tool-specific paths.

---

## Listen for Environment Changes

```typescript
this.nukeCore.onEnvironmentChanged((event) => {
  console.log('Environment changed from', event.previous, 'to', event.current);
  console.log('Previous env:', event.previousEnv);
  console.log('New env:', event.currentEnv);
});

// Listen for status changes
this.nukeCore.onStatusChanged((status) => {
  console.log('Status:', status.message);
  console.log('Ready:', status.ready);
});

// Listen for environment fallback (configured env lacks required packages)
this.nukeCore.onEnvironmentFallback((event) => {
  console.log('Requested env:', event.requestedEnv);
  console.log('Fallback env:', event.fallbackEnv.name);
  console.log('Warning:', event.warning);

  // Show user notification
  this.messageService.warn(event.warning, { timeout: 10000 });
});
```

---

## Quick Checks

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

---

## Backend API

For direct backend communication, inject `NukeCoreBackendService` (which implements `NukeCoreBackendServiceInterface`):

```typescript
import { NukeCoreBackendService, NukeCoreBackendServiceInterface } from 'nuke-core/lib/common';

@injectable()
export class MyExtension {
  @inject(NukeCoreBackendService)
  private readonly backend: NukeCoreBackendServiceInterface;

  async example() {
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
      pythonSpecifier: '3.11'
    });

    // Create with custom channels and additional packages
    const cmdInfo2 = await this.backend.prepareCreateEnvironmentCommand({
      type: 'conda',
      name: 'moose',
      pythonSpecifier: '3.11',
      channels: ['https://conda.software.inl.gov/public'],
      packages: ['moose']
    });
  }
}
```

### Command Preparation Methods

The backend exposes `prepare*Command()` methods that return shell commands instead of executing them directly. This allows the frontend to run commands in a **terminal widget** for live output:

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

**Benefits:**

- **Live output**: Users see real-time install progress.
- **Error visibility**: Failed commands show full stderr in the terminal.
- **Interaction**: Commands that prompt for input (e.g., conda solve) work correctly.

---

## Shared Utilities

### `resolveAsarUnpacked` — Electron Packaged App Helper

When NukeIDE is packaged as an Electron app, files inside `app.asar` cannot be read by external processes (e.g. Python). Files listed in `electron-builder`'s `asarUnpack` are extracted to `app.asar.unpacked`, but `require.resolve()` still returns the original `.asar` path.

Use `resolveAsarUnpacked` from `nuke-core` before passing a script path to an external process:

```typescript
import { resolveAsarUnpacked } from 'nuke-core/lib/node/utils/asar-helper';

const scriptPath = path.resolve(extensionPath, 'python/my_script.py');
const unpackedPath = resolveAsarUnpacked(scriptPath);
// Pass unpackedPath to Python — it points to the real filesystem location
```

**Used by:** `nuke-visualizer`, `openmc-studio` (any extension that spawns Python processes from bundled scripts).
