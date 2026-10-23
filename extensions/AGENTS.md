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
- **Python package requirements live in `extensions/<name>/src/common/packages.json`** — the single source of truth for dependency health checks, install suggestions, and the actual install flow, consumed by TS (typed accessor in `src/common/`) and by the Python backends. Never inline package lists in services or widgets. Entry fields follow nuke-core's `PackageDependency`; the checker imports `name[.submodule]` and falls back to `importlib.metadata.version(name)`, so `name` must be the import name or the distribution name (e.g. `moab`, not `pymoab`). Install routing is structured, not free-form: in a conda env entries with `condaOnly`/`condaSpec` install via conda (`condaSpec || name`), everything else via pip (`pipSpec || name` + `pipArgs` + `extraIndexUrl`); `installCommand` is deprecated (hint-only, never executed). Pin VCS `pipSpec` URLs to a commit. Packages shared by more than one extension must match `extensions/nuke-core/src/common/package-registry.json` spec-for-spec — enforced by `package-registry.test.ts`.
- Extensions with Python backends keep them in `python/` (not pip-installed) with pytest suites in `tests/python/`; see the child docs for those extensions.
- `nuke-essentials` owns the shared React UI components under `src/theme/browser/components/` (`Logo`, `Tooltip`, `ColorPicker`, `NukeSelect`, `NukeCheckbox`, `NukeSlider`, `NukeSearchInput`, `NukeSwitch`, `NukeBadge`, `SearchableMultiSelect`, `NukeDialog`, `NukeToolbar`/`NukeToolbarGroup`, `NukeRibbon`/`NukeRibbonSection` (non-wrapping labelled action sections with promoted buttons, host `promotedIds` pins, and per-section menus listing every action with pin/unpin; pure promotion/density model in `nuke-ribbon-model.ts`; `NukeRibbonItem.disabledReason` feeds the disabled tooltip and the menu's muted second line), `NukeEmptyState`, `NukeLoadingOverlay`, `NukePanel`, `NukeSection`/`NukeFormRow`, plus the shared 3D-viewer chrome `ViewCube`/`ViewerNavBar`/`ViewBadge`); they are exported from the components `index.ts` and consumed via `nuke-essentials/lib/theme/browser/components` (never `src/`). Component CSS is co-located, copied by `copy-css`, and loaded once from `theme-frontend-module.ts`. `ViewCube` is the labeled-triad orientation gizmo (pure quaternion projection in `view-cube-math.ts`, vitest-covered; imperative handle, never React state), `ViewerNavBar` is the one bottom-bar variant (ISO/T/F/R + fit + zoom, props-only `ViewerNavAction` router over the pure `viewer-nav-actions.ts` model, host extras as `children`), `ViewBadge` is the muted dataset/view pill (presentational), and `viewer-chrome.css` owns the converged `.nuke-viewer-status-line` text treatment every viewport status line shares.
- `nuke-essentials` owns the workspace-config-folder override (`src/workspace-config/browser/`): `NukePreferenceConfigurations` rebinds Theia's `PreferenceConfigurations` so workspace-scope settings and sections (settings/tasks/launch/snippets) read and write `<project>/.nuke-ide/` instead of `.theia/` (`.vscode` stays as secondary path), and `NukeWorkspaceFileService` rebinds Theia's `WorkspaceFileService` so workspace files default to `*.nuke-workspace` (`.theia-workspace`/`.code-workspace` stay registered for opening). Keep these the only rebinds of those symbols in the app; existing projects must migrate `.theia/settings.json` to `.nuke-ide/settings.json` by hand.
- `nuke-core` owns the `BackendApplicationServer` override (`src/node/static-frontend-server.ts`) that serves the built frontend with `Cache-Control: no-store` on HTML so redeploys propagate despite Theia's un-hashed bundle filenames (JS/CSS keep ETag revalidation — 304s, not full re-downloads); keep it the only such binding in the app.
- `nukelab-integration` owns the idle-activity contract with NukeLab: `NukeLabActivityContribution` POSTs `/api/nukelab/activity` (via `Endpoint`) every 60s only after recent deliberate input, so the container auth sidecar sees real IDE usage; an untouched IDE tab must not keep the server alive. It also owns session renewal: `NukeLabSessionRenewalContribution` wraps `window.fetch` and, on a same-origin 401, silently re-mints NukeLab's 5-minute server access cookie (`POST /api/servers/:id/access-token`, NukeLab JWT from localStorage) and retries the request once — without it, Theia REST calls (file downloads/uploads) hang once the gateway-minted cookie expires mid-session.
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
- Sidebar `ReactWidget`s opt out of PerfectScrollbar (`this.scrollOptions = undefined` in the constructor — Theia enables it by default) and scroll natively via their own CSS; otherwise the `ps__thumb` overlay sits on top of panel content.
- License header: new source files carry the BSD-2-Clause header used by existing files.
- Extensions that spawn Python processes go through `nuke-core`'s environment detection rather than hard-coding interpreters.

### Common pitfalls

- Do not import from another extension's `src/`; depend on its published `lib/` API via the package name.
- `noUnusedLocals` is on in the base tsconfig — dead locals fail the build.
- CSS changes require the extension's `copy-css` step (part of `build`); editing CSS in `lib/` is lost on rebuild.
- Never fetch extension-backend endpoints with origin-rooted URLs (`fetch('/api/...')`): in the NukeLab deployment Traefik serves the IDE under a `StripPrefix` route (`/user/<name>/<server>`), so an origin-rooted request hits the NukeLab API instead of the IDE backend. Resolve with Theia's `Endpoint` class (`new Endpoint({ path: '/api/...' }).getRestUrl()`), which prefixes the page path, exactly like Theia's own services. Origin-rooted URLs are only correct for NukeLab routes (dashboard, `/servers/<id>`, `/api/auth/*`).

## Verification

```bash
npx lerna run build        # compile all extensions
yarn lint                  # prettier + ruff (for extensions with Python)
yarn test:python           # pytest for extensions with Python backends
```

## Child NAD Index

- `nuke-core/AGENTS.md` — shared services, environment subsystem, and the Nuke Tools sidebar.
- `nuke-visualizer/AGENTS.md` — visualization plugin framework and its Python backend.
- `openmc-studio/AGENTS.md` — OpenMC workspace extension and its Python backend.
- `nuke-cad/AGENTS.md` — parametric CAD / meshing / FEM extension and its Python backend.
