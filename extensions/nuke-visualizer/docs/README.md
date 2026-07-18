# Nuke Visualizer Documentation

Welcome to the `nuke-visualizer` documentation. This extension provides advanced 3D and 2D visualization for nuclear engineering data inside NukeIDE.

## 📖 Choose Your Path

### 👤 I want to use the visualizer

→ Start with [**User Documentation**](user/index.md)

Covers everything from opening your first DAGMC file to analyzing OpenMC statepoints, plotting cross-sections, and inspecting geometry hierarchies.

### 🛠️ I want to develop or extend it

→ Start with [**Developer Documentation**](dev/index.md)

Covers architecture, shared services, RPC protocols, DI wiring, and how to add new visualization plugins.

### 🔧 I ran into a problem

→ Jump to [**Troubleshooting**](user/troubleshooting.md)

---

## Quick Overview

**Nuke Visualizer** is a plugin-based visualization framework with two built-in plugins:

| Plugin              | What It Visualizes                                      | File Types                                                                |
| ------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Base Visualizer** | 3D meshes, DAGMC geometry, VTK data                     | `.h5m`, `.vtk`, `.stl`, `.ply`, `.obj`                                    |
| **OpenMC**          | Monte Carlo results, tallies, cross-sections, depletion | `statepoint*.h5`, `geometry.xml`, `materials.xml`, `depletion_results.h5` |

---

## Documentation Structure

```
docs/
├── README.md              # You are here
├── user/                  # End-user guides
│   ├── index.md
│   ├── getting-started.md
│   ├── base-visualizer.md
│   ├── openmc/
│   │   ├── index.md
│   │   ├── statepoint-viewer.md
│   │   ├── tally-visualization.md
│   │   ├── cross-sections.md
│   │   ├── depletion.md
│   │   ├── geometry.md
│   │   └── materials.md
│   └── troubleshooting.md
└── dev/                   # Developer guides
    ├── index.md
    ├── architecture.md
    ├── shared-services.md
    ├── rpc-protocols.md
    ├── di-wiring.md
    ├── widget-patterns.md
    ├── adding-a-plugin.md
    └── python-backends.md
```

---

## Maintenance Note

API reference is **not duplicated** in these docs. Instead:

- Key interfaces and services have enhanced **JSDoc** in the source code.
- Developer docs explain **concepts and patterns**, then link directly to source files.
- User docs describe **workflows and UI actions**, which stay stable even when internal APIs change.
