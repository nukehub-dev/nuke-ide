# Extensions

## Purpose

Custom Theia extensions that deliver NukeIDE's functionality: commands, views, widgets, themes, and backend services for nuclear simulation workflows.

## Ownership

All files under `extensions/` except generated artifacts (`*/lib/`, `*/node_modules/`, `*.tsbuildinfo`, `__pycache__`).

## Local Contracts

- Every extension is a self-contained Theia package: `package.json` (keyword `theia-extension`), `tsconfig.json` extending `../../configs/base.tsconfig.json` (`composite`, `outDir: lib`, `rootDir: src`), and sources under `src/`.
- Extension `tsconfig.json` `include` arrays must list `../../configs/global.d.ts` so TypeScript resolves CSS/SCSS/Less side-effect imports and loads the React JSX namespace under Node16 module resolution.
- Standard source layout: `src/browser/` (frontend contributions), `src/node/` (backend services), `src/common/` (shared protocols/interfaces). `nuke-essentials` instead groups by feature (`src/<feature>/browser|node`).
- DI wiring uses inversify `ContainerModule`s named `<name>-frontend-module.ts` / `<name>-backend-module.ts`. Frontend↔backend communication is JSON-RPC over WebSocket via `WebSocketConnectionProvider`.
- Standard npm scripts: `build` (`tsc`, plus `copy-css` when the extension ships CSS), `watch`, `clean`, `prepare` (`clean && build`, run by lerna on install).
- `lib/` is the tsc output directory — generated, never edited, never committed.
- **Python package requirements live in `extensions/<name>/src/common/packages.json`** — the single source of truth for dependency health checks and install suggestions, consumed by TS (typed accessor in `src/common/`) and by the Python backends. Never inline package lists in services or widgets. Entry fields follow nuke-core's `PackageDependency`; the checker imports `name[.submodule]` and falls back to `importlib.metadata.version(name)`, so `name` must be the import name or the distribution name (e.g. `moab`, not `pymoab`). Pin external installs (`installCommand` with a commit-pinned URL) and add `extraIndexUrl` for packages not on PyPI.
- Extensions with Python backends keep them in `python/` (not pip-installed) with pytest suites in `tests/python/`; see the child docs for those extensions.
- Extension docs live in `<extension>/docs/` (`README.md` landing page, `user/`, `dev/`) and are read in-IDE by `extensions/nuke-docs`; see `docs/AGENTS.md`.

## Work Guidance

### Adding a new extension

1. Create `extensions/<name>/` with `package.json`, `tsconfig.json` (extend the base config), and `src/`.
2. Implement contributions in `src/browser/` and/or `src/node/`; put shared protocol constants/interfaces in `src/common/`.
3. Register the extension as a dependency in `applications/browser/package.json` and `applications/electron/package.json`.
4. Add `docs/` with `README.md` plus `user/` and `dev/` guides if the extension is user-facing.
5. Update the extension list in `docs/architecture.md` and `docs/extensions.md`.

### Conventions

- Follow the existing Theia style: 4-space indent, single quotes, no trailing commas (enforced by prettier, config at repo root).
- Keep widgets and services small and composable; register everything through the module files, not ad-hoc singletons.
- License header: new source files carry the BSD-2-Clause header used by existing files.
- Extensions that spawn Python processes go through `nuke-core`'s environment detection rather than hard-coding interpreters.

### Common pitfalls

- Do not import from another extension's `src/`; depend on its published `lib/` API via the package name.
- `noUnusedLocals` is on in the base tsconfig — dead locals fail the build.
- CSS changes require the extension's `copy-css` step (part of `build`); editing CSS in `lib/` is lost on rebuild.
- Never fetch extension-backend endpoints with origin-rooted URLs (`fetch('/api/...')`): in the NukeLab deployment Traefik serves the IDE under a `StripPrefix` route (`/user/<name>/<server>`), so an origin-rooted request hits the hub API instead of the IDE backend. Resolve with Theia's `Endpoint` class (`new Endpoint({ path: '/api/...' }).getRestUrl()`), which prefixes the page path, exactly like Theia's own services. Origin-rooted URLs are only correct for hub routes (dashboard, `/servers/<id>`, `/api/auth/*`).

## Verification

```bash
npx lerna run build        # compile all extensions
yarn lint                  # prettier + ruff (for extensions with Python)
yarn test:python           # pytest for extensions with Python backends
```

## Child NAD Index

- `nuke-visualizer/AGENTS.md` — visualization plugin framework and its Python backend.
- `openmc-studio/AGENTS.md` — OpenMC workspace extension and its Python backend.
