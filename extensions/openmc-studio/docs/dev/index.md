# Developer Documentation

This section is for developers who want to understand, modify, or extend `openmc-studio`.

## Getting Started

| Doc | What You'll Learn |
|-----|-------------------|
| [**Architecture**](architecture.md) | How the frontend React widgets, Theia backend services, and Python scripts fit together |
| [**Frontend Module**](frontend-module.md) | DI bindings, command/menu contributions, OpenHandler registration, and state management |
| [**Backend Services**](backend-services.md) | Runner, validation, CAD import, DAGMC editing, optimization, and XML generation services |
| [**Widget Patterns**](widget-patterns.md) | When to use React widgets vs iframe widgets, state propagation, and CSS theming |
| [**RPC Protocols**](rpc-protocols.md) | How TypeScript interfaces define the frontend/backend contract and state schema |
| [**Python Backends**](python-backends.md) | Conventions for Python service scripts (statepoint reading, DAGMC editing, depletion, optimization) |
| [**Adding a Feature**](adding-a-feature.md) | Step-by-step guide to adding a new simulation feature or UI panel |

## Architecture Summary

OpenMC Studio follows a three-layer architecture typical of Theia extensions:

```
┌─────────────────────────────────────────────┐
│  Browser (Frontend)                         │
│  ├─ React widgets (CSG, DAGMC, Tally, ...)  │
│  ├─ Commands / menus / toolbar items        │
│  ├─ OpenHandler contributions               │
│  └─ State manager (shared client state)     │
├─────────────────────────────────────────────┤
│  RPC / Protocol Layer                       │
│  └─ openmc-studio-protocol.ts               │
├─────────────────────────────────────────────┤
│  Node (Backend)                             │
│  ├─ openmc-studio-backend-service.ts        │
│  ├─ Runner / validation / CAD / XML services│
│  └─ Python process management (nuke-core)   │
├─────────────────────────────────────────────┤
│  Python Scripts                             │
│  ├─ dagmc_editor_service.py                 │
│  ├─ statepoint_reader.py                    │
│  ├─ run_depletion.py                        │
│  ├─ run_optimization.py                     │
│  └─ cad_importer.py                         │
└─────────────────────────────────────────────┘
```

The frontend communicates with backend services over Theia's JSON-RPC channel. Backend services spawn Python processes via `nuke-core`'s environment helper and stream stdout/stderr back to the IDE output channels.

## Code Organization

```
src/
├── common/                          # RPC protocols & shared types
│   ├── openmc-studio-protocol.ts    # Main frontend/backend contract
│   └── openmc-state-schema.ts       # Shared state shape
├── browser/                         # Frontend code
│   ├── openmc-studio-frontend-module.ts   # DI bindings
│   ├── openmc-studio-service.ts           # Shared frontend service
│   ├── openmc-state-manager.ts            # Client-side state store
│   ├── commands/                    # Command definitions
│   │   ├── environment-commands.ts
│   │   ├── project-commands.ts
│   │   ├── simulation-commands.ts
│   │   └── view-commands.ts
│   ├── contributions/               # Theia contributions
│   │   ├── openmc-command-contribution.ts
│   │   ├── openmc-menu-contribution.ts
│   │   ├── openmc-openhandler-contribution.ts
│   │   └── openmc-toolbar-contribution.ts
│   ├── services/                    # Frontend services
│   │   ├── openmc-environment-service.ts
│   │   ├── openmc-health-service.ts
│   │   ├── openmc-installer-service.ts
│   │   └── openmc-package-metadata.ts
│   ├── widgets/                     # React widgets
│   │   ├── csg-builder/
│   │   ├── dagmc-editor/
│   │   ├── optimization/
│   │   ├── simulation-comparison/
│   │   ├── simulation-dashboard/
│   │   │   ├── vr/                  # Variance reduction editors
│   │   │   └── simulation-runner.ts
│   │   └── tally-configurator/
│   │       └── components/          # Mesh, filter, score editors
│   ├── script-generator/            # Python script export
│   │   └── python-exporter.ts
│   └── xml-generator/               # XML generation & import
│       └── xml-generation-service.ts
└── node/                            # Backend code
    ├── openmc-studio-backend-module.ts    # DI bindings
    ├── openmc-studio-backend-service.ts   # Main backend service
    ├── openmc-validation-backend-service.ts
    ├── openmc-runner-service.ts
    ├── optimization-backend-service.ts
    ├── cad-import-service.ts
    ├── dagmc-editor-service.ts
    ├── xml-generation-service.ts
    └── rpc-buffer-config.ts

python/                              # Python service scripts
├── dagmc_editor_service.py          # DAGMC mesh operations
├── dagmc_info.py                    # DAGMC metadata reader
├── statepoint_reader.py             # Statepoint extraction
├── run_depletion.py                 # Depletion execution
├── run_optimization.py              # Optimization driver
└── cad_importer.py                  # CAD → DAGMC conversion
```

## API Reference

We do **not** maintain a separate API reference in Markdown (it goes stale too quickly). Instead:

- **JSDoc/TSDoc in source code** documents interfaces and public methods.
- Developer docs explain **concepts and patterns**, then link to the relevant source files.

Key files to read for API details:

| Purpose | File |
|---------|------|
| RPC protocol definition | `src/common/openmc-studio-protocol.ts` |
| State schema | `src/common/openmc-state-schema.ts` |
| Frontend DI module | `src/browser/openmc-studio-frontend-module.ts` |
| State manager | `src/browser/openmc-state-manager.ts` |
| Backend DI module | `src/node/openmc-studio-backend-module.ts` |
| Main backend service | `src/node/openmc-studio-backend-service.ts` |
| Simulation runner | `src/node/openmc-runner-service.ts` |
| Validation service | `src/node/openmc-validation-backend-service.ts` |
| Optimization backend | `src/node/optimization-backend-service.ts` |
| CAD import backend | `src/node/cad-import-service.ts` |
| XML generation (backend) | `src/node/xml-generation-service.ts` |
| Python exporter | `src/browser/script-generator/python-exporter.ts` |
| Frontend XML service | `src/browser/xml-generator/xml-generation-service.ts` |

---

## Contributing

When adding a new feature:
1. Write or update the **user doc** if it affects end-user workflows.
2. Write or update the **dev doc** if it introduces new patterns or architecture changes.
3. Add **JSDoc/TSDoc** to new public APIs.
4. Do **not** add exhaustive method lists to Markdown — link to source instead.
