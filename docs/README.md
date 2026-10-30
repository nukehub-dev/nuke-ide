# NukeIDE Documentation

This directory contains the product documentation for NukeIDE.

## Where docs live

| Location             | Purpose                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| `docs/*.md`          | Product-level docs (Getting Started, Installation, Architecture, etc.) |
| `extensions/*/docs/` | **Source of truth** for extension-specific docs                        |

The native docs widget (`extensions/nuke-docs`) reads directly from both locations. Content changes need **no build step**; rebuilding is only needed after changing the widget's TypeScript or CSS.

## Adding docs for a new extension

1. Create `extensions/your-extension/docs/`
2. Add your Markdown files there
3. Add a landing page: `README.md` (or `index.md`)
4. Restart the IDE — the docs widget discovers any extension with a `docs/` folder

## Writing docs

- Use standard Markdown.
- Cross-link between pages with relative paths, for example `[Installation](installation.md)`.
- For links into another extension, prefer the served route (`/openmc-studio/user/getting-started`) or a portable relative path (`../../openmc-studio/docs/user/getting-started.md`).
- The native widget strips YAML frontmatter (`---`) and VitePress-style containers (`::: tip`) automatically.
- Shipped screenshots live in `docs/images/` or `extensions/<name>/docs/user/images/`; reference them relatively, for example `![Ribbon](images/ribbon.png)`.
- Keep full-window screenshots at a readable width (1280–1600 px); panel crops may be narrower. Avoid personal paths or unrelated workspace content.
- Use SVG for diagrams and PNG for screenshots. Add a short caption or alt text that explains the workflow, not just the widget name.

## Screenshots

User-guide screenshots are generated, not hand-captured. `docs/screenshots.json` is the source of truth: every PNG under `docs/` or `extensions/*/docs/` is declared there with a capture id and repository-relative path, and every declared image must be referenced by a Markdown page. The captures come from `tests/ui/docs-screenshots.spec.ts`, which uses committed fixtures and deterministic blank projects/dialogs with a fixed viewport and the NukeIDE light theme. Images live in `docs/images/` or `extensions/<name>/docs/user/images/` and are referenced relatively from the page that uses them.

```bash
yarn docs:screenshots              # build, capture, optimize, and validate
yarn docs:screenshots --skip-build # reuse the existing browser build
yarn docs:screenshots:optimize     # only quantize new truecolor captures
yarn docs:screenshots:check        # validate without capturing
```

One-time setup: `npx playwright install chromium`. The capture spec writes truecolor PNGs. The pipeline then quantizes them to 256-color indexed PNGs, which typically cuts the committed image payload by more than half without visible UI artifacts. Already-indexed images are skipped, so rerunning the optimizer is a no-op rather than repeated degradation.

`yarn docs:screenshots:check` validates the manifest, every Markdown image reference, PNG headers/dimensions/size, indexed color type, and orphan PNGs under docs trees. It runs in CI, so a missing declaration, broken path, undeclared image, or unoptimized capture fails the build.

Regenerate the images when a documented UI changes, a capture fixture changes, or a layout change moves the controls a screenshot shows. Stop any existing `yarn start:browser` server first: capture runs start a fresh app so they cannot reuse a stale bundle. Review every generated image before committing: no personal paths or data, no loading indicators or transient toasts, crop to the workflow being described, and keep the single light theme so the docs stay consistent.

Keep the manifest curated: remove screenshots that no longer document a flow. Git retains replaced image blobs in history, so the optimizer reduces each revision rather than erasing old ones; at the current seventeen-image size (~560 KiB total) Git LFS is unnecessary.

## Native docs widget

Open it from the IDE via `Help → Documentation` or the Getting Started page.

Features:

- Renders Markdown with Theia-native theming
- Search across document titles and opening text
- Table of contents for the current page
- Collapsible sidebar navigation
- Draggable sidebar resize

## Rebuilding the docs extension

If you modify `extensions/nuke-docs/src/`:

```bash
yarn --cwd extensions/nuke-docs build    # TypeScript + CSS
```

Then rebundle the browser app:

```bash
yarn build:browser
```
