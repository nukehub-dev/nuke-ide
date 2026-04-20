# Developer Documentation

This section is for developers who want to understand, modify, or extend `nuke-visualizer`.

## Getting Started

| Doc | What You'll Learn |
|-----|-------------------|
| [**Architecture**](architecture.md) | How frontend, backend, and Python layers fit together |
| [**Shared Services**](shared-services.md) | Health checks, Python helper, Plotly service, widget lifecycle |
| [**RPC Protocols**](rpc-protocols.md) | How TypeScript interfaces define the frontend/backend contract |
| [**DI Wiring**](di-wiring.md) | InversifyJS container modules and binding patterns |
| [**Widget Patterns**](widget-patterns.md) | When to use iframe widgets vs React widgets |
| [**Adding a Plugin**](adding-a-plugin.md) | Step-by-step guide to creating a new visualization plugin |
| [**Python Backends**](python-backends.md) | Conventions for Python server scripts |

## Code Organization

```
src/
├── common/                    # RPC protocols (shared between frontend & backend)
│   ├── base-visualizer-protocol.ts
│   └── openmc-protocol.ts
├── browser/                   # Frontend code
│   ├── visualizer-frontend-module.ts   # DI bindings
│   ├── visualizer-contribution.ts      # Commands, menus, OpenHandler
│   ├── visualizer-widget.tsx           # Base iframe widget
│   ├── plotly/                # Plotly integration
│   ├── services/              # Shared frontend services
│   └── plugins/openmc/        # OpenMC plugin frontend
│       ├── commands/          # Command contributions
│       ├── widgets/           # React widgets
│       ├── services/          # OpenMC-specific services
│       └── openmc-contribution.ts
└── node/                      # Backend code
    ├── visualizer-backend-module.ts    # DI bindings
    ├── visualizer-backend-service.ts   # Base visualizer backend
    ├── services/              # Shared backend services
    └── plugins/openmc/        # OpenMC plugin backend
        └── services/          # OpenMC-specific backend services

python/                        # Python scripts
├── visualizer_app.py          # Trame server for base visualizer
├── openmc_server.py           # OpenMC visualization server
├── dagmc_converter.py         # H5M → VTK converter
└── openmc_commands/           # OpenMC helper modules
```

## API Reference

We do **not** maintain a separate API reference in Markdown (it goes stale too quickly). Instead:

- **JSDoc in source code** documents interfaces and public methods.
- Developer docs explain **concepts and patterns**, then link to the relevant source files.

Key files to read for API details:

| Purpose | File |
|---------|------|
| Base visualizer protocol | `src/common/base-visualizer-protocol.ts` |
| OpenMC protocol | `src/common/openmc-protocol.ts` |
| Health check framework | `src/browser/services/health-check-framework.ts` |
| Python command helper | `src/node/services/python-command-helper.ts` |
| Plotly service | `src/browser/plotly/plotly-service.ts` |
| Base visualizer backend | `src/node/visualizer-backend-service.ts` |
| OpenMC backend | `src/node/plugins/openmc/openmc-backend-service.ts` |

---

## Contributing

When adding a new feature:
1. Write or update the **user doc** if it affects end-user workflows.
2. Write or update the **dev doc** if it introduces new patterns or architecture changes.
3. Add **JSDoc** to new public APIs.
4. Do **not** add exhaustive method lists to Markdown — link to source instead.
