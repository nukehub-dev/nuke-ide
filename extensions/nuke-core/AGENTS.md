# Nuke Core

## Purpose

Foundation extension for NukeIDE: shared Theia services, the Python environment subsystem, global commands, and the Nuke Tools sidebar that aggregates commands from every extension.

## Ownership

All files under `extensions/nuke-core/` except generated artifacts (`lib/`, `node_modules/`, `*.tsbuildinfo`, `__pycache__`).

## Local Contracts

- TypeScript side follows `extensions/AGENTS.md`: `src/browser/`, `src/node/`, `src/common/`, wired by `nuke-core-frontend-module.ts` / `nuke-core-backend-module.ts`.
- Python backend lives in `python/` and is **not pip-installed**; the IDE spawns it as a subprocess for environment discovery, health checks, and package installation.
- `src/browser/tools-sidebar/` owns the **Nuke Tools sidebar**:
  - `nuke-tools-protocol.ts` defines the `NukeToolsContribution` contract and `NukeToolsItem` shape.
  - `nuke-tools-sidebar-widget.tsx` renders the searchable, collapsible sidebar.
  - `nuke-tools-sidebar-model.ts` groups items into nested categories and supports `categoryOrder` for controlled ordering.
  - `nuke-tools-sidebar-contribution.ts` registers the view at rank 400 in the left area, between Source Control and Extensions.
  - `nuke-core-tools-contribution.ts` registers Nuke Core's own Environment and Health & Diagnostics commands.
  - CSS is copied to `lib/` by the `copy-css` build step.
- Items are grouped by their `category` path. The first element becomes a top-level section (e.g., `Environment`, `OpenMC Studio`, `Visualizer`). Use `categoryOrder` to order sections logically; without it, sections sort alphabetically.
- Items may declare `enabled` and `onDidChangeEnabled` so the sidebar dims rows that require state (e.g., an opened OpenMC Studio project) and refreshes when that state changes.
- Commands must already exist in the Theia `CommandRegistry`; the sidebar only invokes them.

## Work Guidance

- New global commands that should be discoverable in the sidebar belong in `nuke-core-tools-contribution.ts` or in the relevant feature extension's `*ToolsContribution`.
- Keep the sidebar model pure (`nuke-tools-sidebar-model.ts`) so sorting/grouping logic is unit-testable without a DOM.
- Do not add execution logic to the sidebar widget; it only calls `CommandService.executeCommand`.

## Verification

```bash
npx lerna run build --scope nuke-core
yarn test:ts                              # includes nuke-core TS unit tests
yarn lint
```

## Child NAD Index

- None
