# Docs

## Purpose

Product-level documentation for NukeIDE: getting started, installation, architecture, and the extension catalogue.

## Ownership

All files under `docs/`.

## Local Contracts

- `docs/*.md` holds product-level docs; `extensions/*/docs/` is the **source of truth** for extension-specific docs (`README.md` landing page, `user/`, `dev/`).
- Both locations are read directly in-IDE by the native docs widget (`extensions/nuke-docs`, opened via Help → NukeIDE Documentation). There is no build step and no external docs site.
- Write standard Markdown; cross-link with relative paths. The widget strips YAML frontmatter and VitePress-style containers.
- Images live next to the markdown file that references them, via relative paths.

## Work Guidance

- Adding docs for an extension: create/edit files under that extension's `docs/` folder; the widget picks them up on IDE restart.
- Adding a product doc: create `docs/<topic>.md` and add it to `docs/index.md`.
- Keep `docs/architecture.md` (repo layout, extension list) and `docs/extensions.md` (extension catalogue) in sync when extensions are added, removed, or renamed.
- Markdown is formatted by prettier (`yarn format`); run `yarn format:check` before committing.

## Verification

```bash
yarn format:check
```

## Child NAD Index

- None
