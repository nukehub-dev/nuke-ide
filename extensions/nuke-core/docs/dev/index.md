# Developer Documentation

This section is for developers building extensions that depend on **nuke-core**, or contributing to nuke-core itself.

Nuke Core is a Theia extension that provides Python environment discovery, package management, and health diagnostics for nuclear engineering workflows. It uses a layered architecture: frontend services proxy requests over JSON-RPC to a Node backend, which delegates environment discovery to pluggable providers (Conda, Venv, Poetry, Pyenv, System). Commands are prepared as shell strings and executed in live terminal widgets so users see real-time output.

---

## Developer Guides

| Guide                                                    | Description                                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [`architecture.md`](architecture.md)                     | High-level architecture, layer diagram, provider pattern, and key design decisions.                                              |
| [`service-api.md`](service-api.md)                       | How to consume nuke-core from another extension—environment detection, package installation, health checks, and event listeners. |
| [`status-bar-integration.md`](status-bar-integration.md) | How to request status bar visibility from your extension, including reference counting and widget lifecycle patterns.            |

---

## Key Source Files

The source of truth for APIs and behavior is the TypeScript source, not these docs. The following table maps concepts to their implementation files.

| Concept             | Source File                                                                                                                      | Description                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| RPC Protocol        | [`src/common/nuke-core-protocol.ts`](../../src/common/nuke-core-protocol.ts)                                                     | Shared interfaces, RPC methods, DTOs, and event types.                       |
| Frontend Service    | [`src/browser/services/nuke-core-service.ts`](../../src/browser/services/nuke-core-service.ts)                                   | Main API surface for other extensions. Proxies calls to the backend.         |
| Environment Actions | [`src/browser/services/environment-actions-helper.ts`](../../src/browser/services/environment-actions-helper.ts)                 | One-shot install/delete/terminal helper used by commands and the status bar. |
| Visibility Service  | [`src/browser/services/nuke-core-visibility-service.ts`](../../src/browser/services/nuke-core-visibility-service.ts)             | Reference-counted status bar visibility requests.                            |
| Status Bar          | [`src/browser/contributions/status-bar-contribution.ts`](../../src/browser/contributions/status-bar-contribution.ts)             | Widget contribution with grouped environment picker.                         |
| Backend Service     | [`src/node/nuke-core-backend-service.ts`](../../src/node/nuke-core-backend-service.ts)                                           | RPC implementation that delegates to backend services.                       |
| Environment Service | [`src/node/services/environment/environment-service.ts`](../../src/node/services/environment/environment-service.ts)             | Aggregates all providers, manages config, validates env existence.           |
| Package Service     | [`src/node/services/package-service.ts`](../../src/node/services/package-service.ts)                                             | Prepares install/creation commands with tool preference and fallback chain.  |
| Health Service      | [`src/node/services/health-service.ts`](../../src/node/services/health-service.ts)                                               | Diagnostics collection and health check logic.                               |
| Conda Provider      | [`src/node/services/environment/providers/conda-provider.ts`](../../src/node/services/environment/providers/conda-provider.ts)   | Conda/mamba environment discovery.                                           |
| Venv Provider       | [`src/node/services/environment/providers/venv-provider.ts`](../../src/node/services/environment/providers/venv-provider.ts)     | Workspace and global venv/virtualenv discovery.                              |
| Poetry Provider     | [`src/node/services/environment/providers/poetry-provider.ts`](../../src/node/services/environment/providers/poetry-provider.ts) | Poetry virtualenv discovery.                                                 |
| Pyenv Provider      | [`src/node/services/environment/providers/pyenv-provider.ts`](../../src/node/services/environment/providers/pyenv-provider.ts)   | Pyenv Python installation discovery.                                         |
| System Provider     | [`src/node/services/environment/providers/system-provider.ts`](../../src/node/services/environment/providers/system-provider.ts) | System Python discovery.                                                     |
| Conda Resolver      | [`src/node/services/environment/utils/conda-resolver.ts`](../../src/node/services/environment/utils/conda-resolver.ts)           | Finds conda/mamba executables.                                               |
| UV Resolver         | [`src/node/services/environment/utils/uv-resolver.ts`](../../src/node/services/environment/utils/uv-resolver.ts)                 | Finds `uv` executable for fast installs.                                     |
| Python Info         | [`src/node/services/environment/utils/python-info.ts`](../../src/node/services/environment/utils/python-info.ts)                 | Inspects Python executables for versions and packages.                       |

---

## Notes

- **JSDoc in source**: The protocol interfaces and public service methods are documented with JSDoc in the source files. If a detail is missing here, check the source first.
- **API stability**: The RPC protocol in `nuke-core-protocol.ts` is the contract between frontend and backend. Extensions should consume `NukeCoreService` on the frontend rather than calling backend services directly when possible.
- **Live terminal execution**: Package installation and environment creation intentionally return shell commands (`prepare*Command`) rather than executing silently. This is a core design decision—see [`architecture.md`](architecture.md) for rationale.
