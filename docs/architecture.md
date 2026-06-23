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
│   ├── nuke-visualizer/   # 3D/2D visualization framework
│   ├── openmc-studio/     # No-code OpenMC simulation workspace
│   ├── nuke-essentials/   # Common UI components and commands
│   ├── nuke-sysmon/       # System monitoring
│   └── nukelab-integration/ # NukeLab gateway integration
│
├── docs/                  # VitePress documentation site (this site)
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
- `src/browser/` or `src/frontend/` — Frontend contributions (React widgets, commands, menus)
- `src/node/` or `src/backend/` — Backend contributions (services, RPC handlers, file operations)
- `src/common/` — Shared protocols and interfaces
- `docs/` — Extension-specific documentation (merged into this site)

Extensions communicate via **JSON-RPC** over WebSocket. The frontend uses **inversify** for dependency injection.

## Python Integration

Many extensions rely on Python backends:

1. **Nuke Core** manages Python environments (conda, venv, poetry, etc.).
2. Extensions spawn Python processes via RPC to perform heavy computation (OpenMC runs, VTK rendering, mesh processing).
3. Output is streamed back to the IDE and displayed in terminals or custom widgets.

## Documentation Architecture

This documentation site follows a **unified docs** pattern:

- **Product docs** live in `docs/` (installation, architecture, getting started).
- **Extension docs** live inside each extension's `docs/` folder.
- `scripts/build-docs.js` copies extension docs into `docs/` before VitePress builds.
- VitePress renders everything as a single site with cross-linked navigation.

This keeps documentation close to the code that owns it while presenting a seamless experience to readers.
