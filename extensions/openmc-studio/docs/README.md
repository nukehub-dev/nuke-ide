# OpenMC Studio Documentation

Welcome to the `openmc-studio` documentation. This extension provides a no-code graphical workspace for OpenMC Monte Carlo neutron transport simulations inside NukeIDE.

## 📖 Choose Your Path

### 👤 I want to run simulations

→ Start with [**User Documentation**](user/index.md)

Covers everything from creating your first OpenMC project to building CSG geometry, configuring tallies, running criticality calculations, and comparing statepoint results.

### 🛠️ I want to develop or extend it

→ Start with [**Developer Documentation**](dev/index.md)

Covers architecture, frontend/backend services, widget patterns, RPC protocols, and how to add new simulation features or integrate additional Python backends.

### 🔧 I ran into a problem

→ Jump to [**Troubleshooting**](user/troubleshooting.md)

---

## Quick Overview

**OpenMC Studio** is a no-code simulation builder with ten major feature areas:

| Feature                     | What It Does                                                          | Typical Output                      |
| --------------------------- | --------------------------------------------------------------------- | ----------------------------------- |
| **Simulation Dashboard**    | Monitor live runs, view batch metrics, and control execution          | Runtime logs, k-eff plots           |
| **CSG Builder**             | Construct cells, surfaces, and universes graphically                  | `geometry.xml`                      |
| **DAGMC Editor**            | Edit faceted geometry, assign groups, and preview meshes              | `.h5m`, `geometry.xml`              |
| **Tally Configurator**      | Build tallies with filters, scores, meshes, and nuclides              | `tallies.xml`                       |
| **Optimization Framework**  | Run parameter sweeps and surrogate-driven optimization                | Optimized inputs, convergence plots |
| **Simulation Comparison**   | Compare multiple statepoints side-by-side                             | Delta tables, overlay plots         |
| **XML Generation / Import** | Generate OpenMC XML from the UI or import existing XML into the model | `*.xml`                             |
| **Project Management**      | Scaffold projects and track run history                               | Project folders, run metadata       |
| **CAD Import**              | Convert STEP/IGES to DAGMC or CSG                                     | `.h5m`, `geometry.xml`              |
| **Simulation Runner**       | Execute OpenMC with live log streaming and cancellation               | `statepoint*.h5`, `summary.h5`      |

---

## Documentation Structure

```
docs/
├── README.md              # You are here
├── user/                  # End-user guides
│   ├── index.md
│   ├── getting-started.md
│   ├── simulation-dashboard.md
│   ├── csg-builder.md
│   ├── dagmc-editor.md
│   ├── tally-configurator.md
│   ├── optimization-framework.md
│   ├── simulation-comparison.md
│   ├── xml-generation.md
│   ├── project-management.md
│   ├── cad-import.md
│   └── troubleshooting.md
└── dev/                   # Developer guides
    ├── index.md
    ├── architecture.md
    ├── frontend-module.md
    ├── backend-services.md
    ├── widget-patterns.md
    ├── rpc-protocols.md
    ├── python-backends.md
    └── adding-a-feature.md
```

---

## Maintenance Note

API reference is **not duplicated** in these docs. Instead:

- Key interfaces and services have enhanced **JSDoc/TSDoc** in the source code.
- Developer docs explain **concepts and patterns**, then link directly to source files.
- User docs describe **workflows and UI actions**, which stay stable even when internal APIs change.
