# Nuke Core Documentation

Welcome to the `nuke-core` documentation. This extension provides the core infrastructure for NukeIDE — robust Python environment management, configuration validation, and shared utilities used by all other extensions.

## 📖 Choose Your Path

### 👤 I want to use the extension
→ Start with [**User Documentation**](user/index.md)

Covers environment management, package installation, health checks, status bar configuration, and workspace auto-detection.

### 🛠️ I want to develop or extend it
→ Start with [**Developer Documentation**](dev/index.md)

Covers the service API, backend/frontend architecture, RPC protocols, menu contributions, and how other extensions integrate with nuke-core.

### 🔧 I ran into a problem
→ Jump to [**Troubleshooting**](user/troubleshooting.md)

---

## Quick Overview

**Nuke Core** provides five major feature areas:

| Feature | What It Does | Key Capabilities |
|---------|--------------|------------------|
| **Python Environment Management** | Auto-detect, create, delete, and switch Python environments | Conda, mamba, venv, virtualenv, poetry, pyenv, system Python |
| **Package Management** | Install packages with live terminal output | pip, uv (fast), conda/mamba; per-package channels and indexes |
| **Health Checks & Diagnostics** | Validate setup and troubleshoot issues | Environment validation, UV/mamba availability, package checks |
| **Status Bar** | Context-aware environment display | Quick switcher, auto-hide, extension-driven visibility |
| **Workspace Auto-Detect** | Discover and suggest environment setup | Scans for `environment.yml` and `requirements.txt` |

---

## Documentation Structure

```
docs/
├── README.md              # You are here
├── user/                  # End-user guides
│   ├── index.md
│   ├── environment-management.md
│   ├── package-management.md
│   ├── health-checks.md
│   ├── status-bar.md
│   ├── workspace-auto-detect.md
│   ├── settings.md
│   └── troubleshooting.md
└── dev/                   # Developer guides
    ├── index.md
    ├── architecture.md
    ├── service-api.md
    ├── backend-api.md
    ├── menu-contributions.md
    ├── status-bar-visibility.md
    └── integration-guide.md
```

---

## Maintenance Note

API reference is **not duplicated** in these docs. Instead:
- Key interfaces and services have enhanced **JSDoc** in the source code.
- Developer docs explain **concepts and patterns**, then link directly to source files.
- User docs describe **workflows and UI actions**, which stay stable even when internal APIs change.

---

## Related Documentation

- [**OpenMC Studio Documentation**](../openmc-studio/docs/README.md) — No-code OpenMC simulation workspace
- [**Nuke Visualizer Documentation**](../nuke-visualizer/docs/README.md) — 3D/2D nuclear data visualization
