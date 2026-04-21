# NukeIDE Documentation

This directory contains the product documentation for NukeIDE.

## Where docs live

| Location | Purpose |
|----------|---------|
| `docs/*.md` | Product-level docs (Getting Started, Installation, Architecture, etc.) |
| `extensions/*/docs/` | **Source of truth** for extension-specific docs |

The native docs widget (`extensions/nuke-docs`) reads directly from both locations — **no build step required**.

## Adding docs for a new extension

1. Create `extensions/your-extension/docs/`
2. Add your markdown files there
3. Add a root file: `README.md` (or `index.md`) — this becomes the extension's landing page
4. The docs widget will automatically pick it up on the next IDE restart

## Writing docs

- Use standard Markdown
- Cross-link between pages with relative paths: `[Link](../other-extension/user/guide.md)`
- The native widget strips YAML frontmatter (`---`) and VitePress-style containers (`::: tip`) automatically
- Images should be placed next to the markdown file and referenced with relative paths

## Native docs widget

Open it from the IDE via `Help → NukeIDE Documentation` or the Getting Started page.

Features:
- Renders markdown with Theia-native theming
- Full-text search across all docs
- Table of contents for the current page
- Collapsible sidebar navigation
- Draggable sidebar resize

## Rebuilding the docs extension

If you modify `extensions/nuke-docs/src/`:

```bash
yarn docs:rebuild    # rebuilds nuke-docs TypeScript + CSS
```

Then rebundle the browser app:

```bash
yarn build:browser
```
