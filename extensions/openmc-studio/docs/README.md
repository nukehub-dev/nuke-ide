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

**OpenMC Studio** is a no-code simulation builder with these major feature areas:

| Feature                       | What It Does                                                                           | Typical Output                           |
| ----------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------- |
| **Simulation Dashboard**      | Configure settings, sources, materials, depletion, VR, and random ray; run and monitor | Runtime logs, k-eff plots                |
| **Geometry**                  | CSG builder and DAGMC editor (incl. material overrides and depletion sync)             | `geometry.xml`, `.h5m`                   |
| **Tally Configurator**        | Build tallies with filters, scores, meshes, triggers, and derivatives                  | `tallies.xml`                            |
| **Depletion & Chain Builder** | Burnup timelines, transfer rates, custom chain subset/ENDF builds                      | Depletion chains, `depletion_results.h5` |
| **Optimization Framework**    | Parameter sweeps and criticality (k-eff) searches                                      | Optimized inputs, convergence plots      |
| **Volume Calculation**        | Stochastic volume estimation                                                           | Domain volumes ± σ                       |
| **Native Plotting**           | Slice, voxel, and ray-traced geometry plots (C++ plot mode)                            | PNG, `.vti`                              |
| **MGXS Generator**            | Multi-group cross-section libraries (automatic + Library modes)                        | `mgxs.h5`                                |
| **Simulation Comparison**     | Compare multiple statepoints side-by-side                                              | Delta tables, overlay plots              |
| **Project Management**        | Scaffold projects and track run history                                                | Project folders, run metadata            |
| **CAD Import**                | Convert STEP/IGES to DAGMC or CSG                                                      | `.h5m`, `geometry.xml`                   |

---

## Documentation Structure

```
docs/
├── README.md              # You are here
├── user/                  # End-user guides
│   ├── index.md
│   ├── getting-started.md
│   ├── simulation-dashboard.md
│   ├── geometry.md
│   ├── dagmc-editor.md
│   ├── tally-configurator.md
│   ├── optimization.md
│   ├── volume-calculation.md
│   ├── native-plotting.md
│   ├── mgxs-generator.md
│   ├── simulation-comparison.md
│   ├── project-management.md
│   ├── cad-import.md
│   └── troubleshooting.md
└── dev/                   # Developer guides
    ├── index.md
    ├── architecture.md
    ├── di-wiring.md
    ├── state-model.md
    ├── widget-patterns.md
    ├── rpc-protocols.md
    ├── python-backends.md
    ├── xml-generation.md
    ├── adding-a-widget.md
    └── testing.md
```

---

## Maintenance Note

API reference is **not duplicated** in these docs. Instead:

- Key interfaces and services have enhanced **JSDoc/TSDoc** in the source code.
- Developer docs explain **concepts and patterns**, then link directly to source files.
- User docs describe **workflows and UI actions**, which stay stable even when internal APIs change.
