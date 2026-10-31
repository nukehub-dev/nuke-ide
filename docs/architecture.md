# Architecture

NukeIDE is organized as a monorepo with a clear separation between applications, extensions, and shared infrastructure.

## Repository Layout

```
nuke-ide/
├── applications/          # IDE shells
│   ├── browser/           # Theia browser application
│   ├── electron/          # Theia Electron desktop application
│   └── docker/            # Containerized deployment
│
├── extensions/            # Theia extensions (plugins)
│   ├── nuke-core/         # Python env management, health checks, status bar
│   ├── nuke-ai/           # AI runtime and capability-backed tools
│   ├── nuke-visualizer/   # 3D/2D visualization framework
│   ├── openmc-studio/     # No-code OpenMC simulation workspace
│   ├── nuke-cad/          # Parametric CAD / meshing / FEM
│   ├── nuke-essentials/   # Common UI components and commands
│   ├── nuke-sysmon/       # System monitoring
│   ├── nuke-fileinfo/     # File properties/metadata viewer
│   ├── nuke-docs/         # In-IDE documentation widget
│   └── nukelab-integration/ # NukeLab gateway integration
│
├── docs/                  # Product documentation (read in-IDE by nuke-docs)
├── resources/             # Static assets (logos, preload templates)
├── scripts/               # Build and utility scripts
└── configs/               # Shared TypeScript and build configs
```

## Theia Platform

NukeIDE is built on [Eclipse Theia](https://theia-ide.org/), an extensible framework for developing cloud and desktop IDEs. Theia provides:

- **Editor** — Monaco-based code editor with syntax highlighting and IntelliSense
- **Shell** — Flexible workbench with views, panels, and menus
- **Extension System** — Dependency-injected contributions (commands, menus, views, themes)
- **MiniBrowser** — Embedded web views for rendering HTML content

## Extension Architecture

Each extension in `extensions/` is a self-contained Theia package with:

- `package.json` — Theia contribution metadata and npm scripts
- `src/browser/` — Frontend contributions (React widgets, commands, menus)
- `src/node/` — Backend contributions (services, RPC handlers, file operations)
- `src/common/` — Shared protocols and interfaces
- `docs/` — Extension-specific documentation, served in the IDE

Extensions communicate via **JSON-RPC** over WebSocket. The frontend uses **inversify** for dependency injection.

## AI Integration

`nuke-ai` owns NukeIDE's AI runtime, language-model provider packages, and NukeAI chat theming. It is optional at build time: `NUKE_EXCLUDE_EXTENSIONS=nuke-ai` removes NukeAI and its tools; the Theia plugin host still pulls a few inert `@theia/ai-*` modules transitively (`@theia/ai-core`, `@theia/ai-core-ui`, `@theia/ai-mcp`). Required extensions must not import `@theia/ai-*`.

`nuke-ai` also exposes cross-extension actions to the IDE's AI chat. Domain extensions register `NukeCapability` handlers with the neutral registry in `nuke-core`; the `nuke-ai` bridge turns each enabled capability into a typed Theia tool. Tool invocation stays in the frontend process — no HTTP or MCP hop is involved.

## Python Integration

Many extensions rely on Python backends:

1. **Nuke Core** manages Python environments (conda, venv, poetry, etc.).
2. Extensions spawn Python processes via RPC to perform heavy computation (OpenMC runs, VTK file conversion, mesh processing); the frontend renders VTK output natively with three.js.
3. Output is streamed back to the IDE and displayed in terminals or custom widgets.

## Documentation Architecture

NukeIDE's documentation is read **inside the IDE** by the native docs widget (`extensions/nuke-docs`, opened via Help → Documentation):

- **Product docs** live in `docs/` (installation, architecture, getting started).
- **Extension docs** live inside each extension's `docs/` folder (`README.md` landing page, `user/`, `dev/`).
- The widget reads both locations directly — no build step and no external site.

This keeps documentation close to the code that owns it while presenting a seamless experience to readers.
