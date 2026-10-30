# Docs

## Purpose

Product-level documentation for NukeIDE: getting started, installation, architecture, and the extension catalogue.

## Ownership

All files under `docs/`.

## Local Contracts

- `docs/*.md` holds product-level docs; `extensions/*/docs/` is the **source of truth** for extension-specific docs (`README.md` landing page, `user/`, `dev/`).
- Both locations are read directly in-IDE by the native docs widget (`extensions/nuke-docs`, opened via Help → Documentation). There is no docs build step and no external docs site.
- Write standard Markdown; cross-link with relative paths. The widget strips YAML frontmatter and VitePress-style containers.
- Shipped screenshots live in `docs/images/` or `extensions/<name>/docs/user/images/`; reference them relatively. Use SVG for diagrams and cropped PNGs for screenshots; never use absolute URLs for shipped screenshots.
- Every PNG under `docs/` or `extensions/*/docs/` is declared in `docs/screenshots.json`, captured by
  `tests/ui/docs-screenshots.spec.ts` from committed `tests/ui/fixtures/` in one fixed light theme, and
  regenerated with `yarn docs:screenshots` (or `--skip-build` after `yarn build:browser`); never hand-edit images.
- The pipeline quantizes fresh captures to 256-color indexed PNGs; `yarn docs:screenshots:optimize` skips
  already-indexed images, so repeated compression cannot degrade them. Keep the manifest curated and remove
  screenshots that no longer document a workflow.

## Work Guidance

- Adding docs for an extension: create/edit files under that extension's `docs/` folder; the widget discovers every `extensions/*/docs` directory on IDE restart.
- Cross-extension links use either the served route (`/openmc-studio/user/getting-started`) or a portable relative path (`../../openmc-studio/docs/user/getting-started.md`).
- Adding a product doc: create `docs/<topic>.md` and add it to `docs/index.md`.
- Keep `docs/architecture.md` (repo layout, extension list) and `docs/extensions.md` (extension catalogue) in sync when extensions are added, removed, or renamed.
- Tracked docs never cite `.planning/`, Wave/phase IDs, feature IDs, briefs, or roadmaps; describe the stable
  technical contract instead.
- Markdown is formatted by prettier (`yarn format`); run `yarn format:check` before committing.

## Verification

```bash
yarn format:check
yarn docs:screenshots:check
npx vitest run extensions/nuke-docs/src/browser/docs-links.test.ts
```

Link and image resolution is covered by `docs-links.test.ts`; update it when the widget's path rules change.
`docs:screenshots:check` validates manifest declarations, Markdown references, PNG headers/dimensions/size, and orphan images.

## Child NAD Index

- None
