# Nuke Core Architecture

Nuke Core is split into three layers: **Browser (Frontend)**, **Common (Protocol)**, and **Node (Backend)**. The frontend communicates with the backend over Theia's JSON-RPC channel. The backend delegates environment discovery to pluggable providers and prepares shell commands that the frontend executes in live terminal widgets.

---

## Layer Diagram

```
┌───────────────────────────────────────────────────────────────────────┐
│                         BROWSER (Frontend)                            │
│  ┌─────────────────┐  ┌───────────────────┐  ┌──────────────────────┐ │
│  │ NukeCoreService │  │ EnvironmentActions│  │ StatusBarContribution│ │
│  │   (RPC proxy)   │  │     Helper        │  │  (env picker widget) │ │
│  └────────┬────────┘  └───────────────────┘  └──────────────────────┘ │
│           │                                                           │
│    ┌──────┴──────────────────────────────────────────────────────┐    │
│    │         NukeCoreVisibilityService (ref-counted requests)    │    │
│    └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────┬─────────────────────────────────────┘
                                  │ JSON-RPC
┌─────────────────────────────────┼─────────────────────────────────────┐
│                        COMMON (Protocol)                              │
│               nuke-core-protocol.ts (interfaces & DTOs)               │
└─────────────────────────────────┬─────────────────────────────────────┘
                                  │
┌─────────────────────────────────┼─────────────────────────────────────┐
│                           NODE (Backend)                              │
│  ┌──────────────────────────────┼─────────────────────────────────┐   │
│  │     NukeCoreBackendService   │     (RPC implementation)        │   │
│  └─────────────┬────────────────┴────────────────┬────────────────┘   │
│                │                                 │                    │
│   ┌────────────┴────────────┐    ┌───────────────┴──────────────┐     │
│   │   EnvironmentService    │    │        PackageService        │     │
│   │  (aggregates providers) │    │  (prepare*Command methods)   │     │
│   └────────────┬────────────┘    └──────────────────────────────┘     │
│                │                                                      │
│   ┌────────────┼────────────────────────────────────────────────┐     │
│   │            │             PROVIDERS                          │     │
│   │  ┌─────────┴────────┐  ┌──────────────┐  ┌──────────────┐   │     │
│   │  │   CondaProvider  │  │ VenvProvider │  │PoetryProvider│   │     │
│   │  │  (+ mamba pref)  │  │              │  │              │   │     │
│   │  └──────────────────┘  └──────────────┘  └──────────────┘   │     │
│   │  ┌──────────────┐  ┌──────────────┐                         │     │
│   │  │ PyenvProvider│  │SystemProvider│                         │     │
│   │  └──────────────┘  └──────────────┘                         │     │
│   └─────────────────────────────────────────────────────────────┘     │
│                                                                       │
│   UTILITIES: CondaResolver · UvResolver · PythonInfo · AsarHelper     │
└───────────────────────────────────────────────────────────────────────┘
```

---

## Layer Breakdown

### Frontend (Browser)

| Component                       | Role                                                                                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NukeCoreService`               | Primary API for other extensions. Receives injected dependencies, exposes high-level methods, and proxies backend calls via RPC.                                                 |
| `EnvironmentActionsHelper`      | Shared frontend helper for one-shot terminal operations: install packages, delete environments, open an activated terminal. Handles CWD resolution and terminal widget creation. |
| `NukeCoreStatusBarContribution` | Renders the status bar widget with current environment info and a grouped picker (Conda, Venv, Other).                                                                           |
| `NukeCoreVisibilityService`     | Reference-counted visibility requests so multiple extensions can temporarily show the status bar.                                                                                |
| Command Contributions           | Wire user commands (switch, create, delete, install, health check) to the services above.                                                                                        |
| `WorkspaceEnvContribution`      | Scans workspace roots for `environment.yml` / `requirements.txt` and prompts the user to create/install.                                                                         |

### Backend (Node)

| Component                | Role                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NukeCoreBackendService` | Implements the RPC interface defined in the protocol. Entry point for all backend calls.                                                                                                                                                                                                                    |
| `EnvironmentService`     | Aggregates all `EnvironmentProvider` implementations, resolves configuration, validates that configured environments still exist, and deduplicates results.                                                                                                                                                 |
| `PackageService`         | Builds install and environment-creation commands. Determines which tool to use (mamba/conda → uv → pip) and resolves the target environment's Python path.                                                                                                                                                  |
| `HealthService`          | Runs diagnostics: Python availability, tool availability (conda, mamba, uv), and optional package checks.                                                                                                                                                                                                   |
| **Providers**            | Each provider implements the `EnvironmentProvider` interface to discover environments from a specific source. See Provider Pattern below.                                                                                                                                                                   |
| **Utilities**            | `CondaResolver` finds conda/mamba executables; `UvResolver` finds `uv`; `PythonInfo` inspects a Python executable for version and installed packages; `AsarHelper` converts `app.asar` paths to `app.asar.unpacked` so external processes (e.g. Python scripts) can access files in packaged Electron apps. |

### Common (Protocol)

| File                    | Role                                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nuke-core-protocol.ts` | Defines the RPC interface (`NukeCoreBackendServiceInterface`), DTOs (`NukeEnvironment`, `PackageDependency`, `HealthResult`, etc.), and event types. This is the contract between frontend and backend. |

---

## Provider Pattern

Environment discovery is implemented as a chain of independent providers. Each provider focuses on one source and is registered in the backend DI container.

### EnvironmentProvider Interface

All providers implement a common interface (defined in the backend). The `EnvironmentService` collects results from every provider, deduplicates by resolved path, and enriches each environment with metadata such as `isDeletable`.

```
EnvironmentService
    │
    ├── CondaProvider      ──► conda env list --json
    │                            (prefers mamba over conda)
    │
    ├── VenvProvider       ──► workspace + known paths
    │
    ├── PoetryProvider     ──► poetry env list --full-path
    │
    ├── PyenvProvider      ──► pyenv versions --bare
    │
    └── SystemProvider     ──► which python, registry, etc.
```

### How Providers Are Aggregated

1. `EnvironmentService.listEnvironments()` calls `list()` on every registered provider.
2. Results are merged and deduplicated by `pythonPath`.
3. Each environment is tagged with `isDeletable`: `true` for user-created venvs and conda envs in `~/.nuke-ide/envs/`, `false` for system/pyenv/poetry/base conda environments.
4. The selected/configured environment is validated against the aggregated list to detect stale config.

---

## Key Design Decisions

| Decision                    | Rationale                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Live terminal execution** | `prepare*Command()` returns shell commands; the frontend runs them in `TerminalService`. Users see real-time output, errors are visible, and interactive prompts work.                |
| **Mamba preference**        | `CondaResolver` prefers `mamba` over `conda` when available for faster dependency solving. Install commands use `--prefix <resolvedPath>` when possible, falling back to `-n <name>`. |
| **UV integration**          | `PackageService` uses `uv pip install` when `uv` is available, falling back to `pip`. This significantly speeds up package installation.                                              |
| **Workspace CWD**           | All terminal commands use the workspace root (`WorkspaceService.roots[0]`) instead of `process.cwd()`, ensuring commands run in the correct project context.                          |
| **Cross-platform paths**    | Frontend code uses `OS.type()` from `@theia/core` instead of Node-only `process.platform`. Backend handles platform-specific path and shell logic.                                    |

---

## File Structure

```
src/
├── common/
│   ├── nuke-core-protocol.ts           # RPC interfaces, DTOs, events
│   └── index.ts                        # Barrel exports
├── browser/
│   ├── services/
│   │   ├── nuke-core-service.ts        # Frontend API & RPC proxy
│   │   ├── environment-actions-helper.ts # Terminal/install/delete helper
│   │   └── nuke-core-visibility-service.ts # Status bar visibility requests
│   ├── commands/
│   │   ├── environment-command-contribution.ts  # Switch / Create / Delete
│   │   ├── package-command-contribution.ts      # Install
│   │   └── health-command-contribution.ts       # Health / Diagnostics
│   ├── contributions/
│   │   ├── status-bar-contribution.ts  # Status bar widget + picker
│   │   └── workspace-env-contribution.ts # Auto-detect workspace env configs
│   ├── nuke-core-preferences.ts        # Preference schema
│   ├── nuke-core-menus.ts              # Menu contributions (Tools menu)
│   ├── nuke-core-preference-layout.ts  # Settings UI layout
│   └── nuke-core-frontend-module.ts    # DI bindings
└── node/
    ├── services/
    │   ├── environment/
    │   │   ├── providers/
    │   │   │   ├── base.ts             # EnvironmentProvider interface
    │   │   │   ├── conda-provider.ts   # Conda / mamba discovery
    │   │   │   ├── venv-provider.ts    # Venv / virtualenv discovery
    │   │   │   ├── poetry-provider.ts  # Poetry env discovery
    │   │   │   ├── pyenv-provider.ts   # Pyenv discovery
    │   │   │   └── system-provider.ts  # System Python discovery
    │   │   ├── utils/
    │   │   │   ├── conda-resolver.ts   # Find conda / mamba binaries
    │   │   │   ├── uv-resolver.ts      # Find uv binary
    │   │   │   └── python-info.ts      # Inspect Python versions & packages
    │   │   └── environment-service.ts  # Aggregates providers
    │   ├── package-service.ts          # Command preparation
    │   └── health-service.ts           # Diagnostics
    ├── utils/
    │   └── asar-helper.ts              # Electron ASAR path helper for packaged apps
    ├── nuke-core-backend-service.ts    # RPC implementation
    └── nuke-core-backend-module.ts     # Backend DI bindings
```
