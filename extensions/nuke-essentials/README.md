# Nuke Essentials Extension

Shared UI components, themes, and essential features for NukeIDE.

## Overview

`nuke-essentials` provides the visual foundation and common UI patterns used across all NukeIDE extensions.

## What It Provides

### 🎨 Themes

Six custom IDE themes with consistent accent colors and nuclear-engineering-inspired palettes:

| Theme | ID | Type |
|-------|-----|------|
| **Dark** | `nukeide-dark` | Dark |
| **Light** | `nukeide-light` | Light |
| **Blue Dark** | `nukeide-blue-dark` | Dark |
| **Blue Light** | `nukeide-blue-light` | Light |
| **Red Dark** | `nukeide-red-dark` | Dark |
| **Red Light** | `nukeide-red-light` | Light |

Switch themes via **Settings → Color Theme**.

### 🧩 Shared UI Components

React components available for import by other extensions:

| Component | Path | Purpose |
|-----------|------|---------|
| `Tooltip` | `nuke-essentials/lib/theme/browser/components` | Hover tooltip with themed styling |
| `ColorPicker` | `nuke-essentials/lib/theme/browser/components` | Hex color input with preset swatches |
| `LoadingSpinner` | `nuke-essentials/lib/theme/browser/components` | Themed loading indicator |
| `Logo` | `nuke-essentials/lib/theme/browser/components` | NukeIDE logo SVG |

### 🚀 Getting Started Widget

A welcome panel shown on first launch with:
- Quick links to common actions
- NukeIDE tips and quotes
- Recent projects

Re-open it anytime via **Help → Getting Started**.

### 💬 AI Chat Welcome

Custom welcome message provider for the Theia AI chat panel.

### ℹ️ About Dialog

IDE about page with version info and acknowledgments.

## Usage from Another Extension

```typescript
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { ColorPicker } from 'nuke-essentials/lib/theme/browser/components';

// Use themed tooltip
<Tooltip content="Click to apply">
    <button>Apply</button>
</Tooltip>

// Use color picker
<ColorPicker
    color={selectedColor}
    onChange={(color) => setSelectedColor(color)}
/>
```

## Dependencies

- `@theia/core` — Theia platform
- `@theia/monaco` — Monaco editor theming
- `@theia/getting-started` — Getting started framework

## License

BSD-2-Clause
