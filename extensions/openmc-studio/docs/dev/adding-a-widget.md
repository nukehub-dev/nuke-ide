# Adding a Widget

Step-by-step guide to adding a new React widget to OpenMC Studio. We'll create a **CrossSectionViewerWidget** as a concrete example.

---

## Step 1: Create the Widget Class

Create `src/browser/widgets/cross-section/cross-section-widget.tsx`:

```typescript
import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { MessageService } from '@theia/core/lib/common/message-service';
import { OpenMCStateManager } from '../../openmc-state-manager';
import { OpenMCStudioBackendService } from '../../../common/openmc-studio-protocol';

@injectable()
export class CrossSectionViewerWidget extends ReactWidget {
    static readonly ID = 'openmc-cross-section-viewer';
    static readonly LABEL = 'Cross Section Viewer';

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    @inject(OpenMCStateManager)
    protected readonly stateManager!: OpenMCStateManager;

    @inject(OpenMCStudioBackendService)
    protected readonly backend!: OpenMCStudioBackendService;

    private selectedNuclide = 'U235';
    private reactionType = 'total';

    @postConstruct()
    protected init(): void {
        this.id = CrossSectionViewerWidget.ID;
        this.title.label = CrossSectionViewerWidget.LABEL;
        this.title.caption = CrossSectionViewerWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-graph-line';
        this.update();
    }

    protected render(): React.ReactNode {
        return (
            <div className='cross-section-viewer'>
                <div className='viewer-header'>
                    <h3>Cross Section Viewer</h3>
                </div>
                <div className='viewer-controls'>
                    <select
                        value={this.selectedNuclide}
                        onChange={e => {
                            this.selectedNuclide = e.target.value;
                            this.update();
                        }}
                    >
                        <option value='U235'>U-235</option>
                        <option value='U238'>U-238</option>
                        <option value='O16'>O-16</option>
                    </select>
                    <button
                        className='theia-button primary'
                        onClick={() => this.loadCrossSection()}
                    >
                        Load Data
                    </button>
                </div>
            </div>
        );
    }

    private async loadCrossSection(): Promise<void> {
        try {
            this.messageService.info(`Loading ${this.selectedNuclide} ${this.reactionType}...`);
            // Backend call would go here
        } catch (err) {
            this.messageService.error(`Failed to load cross section: ${err}`);
        }
    }
}
```

Create `src/browser/widgets/cross-section/cross-section.css`:

```css
.cross-section-viewer {
    padding: 16px;
}

.cross-section-viewer .viewer-header h3 {
    margin: 0 0 16px 0;
}

.cross-section-viewer .viewer-controls {
    display: flex;
    gap: 8px;
    align-items: center;
}
```

---

## Step 2: Register Widget Factory in Frontend DI Module

Add to `src/browser/openmc-studio-frontend-module.ts`:

```typescript
// Import the widget
import { CrossSectionViewerWidget } from './widgets/cross-section/cross-section-widget';

// Import the CSS
import './widgets/cross-section/cross-section.css';

// Inside the ContainerModule callback:
bind(CrossSectionViewerWidget).toSelf();
bind(WidgetFactory).toDynamicValue(({ container }) => ({
    id: CrossSectionViewerWidget.ID,
    createWidget: () => container.get(CrossSectionViewerWidget)
})).inSingletonScope();
```

**Scope rules:**

| Scope | Use When |
|-------|----------|
| `inSingletonScope()` | One instance shared across the app (dashboards, config panels) |
| `inTransientScope()` | New instance per request (optimization runs that need isolation) |
| Default (no scope) | New instance per injection |

---

## Step 3: Create a Command to Open the Widget

Create or extend a command module. Add to `src/browser/commands/view-commands.ts`:

```typescript
export namespace OpenMCViewCommands {
    // ... existing commands

    export const OPEN_CROSS_SECTION_VIEWER: Command = {
        id: 'openmc.openCrossSectionViewer',
        category: CATEGORY,
        label: 'Open Cross Section Viewer'
    };
}
```

In `ViewCommands.registerCommands()`:

```typescript
registry.registerCommand(OpenMCViewCommands.OPEN_CROSS_SECTION_VIEWER, {
    execute: () => this.openWidget(CrossSectionViewerWidget.ID)
});
```

The `openWidget` helper already exists in `ViewCommands`:

```typescript
private async openWidget(widgetId: string): Promise<void> {
    const widget = await this.widgetManager.getOrCreateWidget(widgetId);
    await this.shell.addWidget(widget, { area: 'main' });
    await this.shell.activateWidget(widget.id);
}
```

---

## Step 4: Register Command in Contribution Class

Commands are already registered via `OpenMCCommandContribution` which delegates to `ViewCommands`. No additional registration is needed if you added the command to `ViewCommands`.

If you created a new command module, bind it in the frontend module:

```typescript
bind(CrossSectionCommands).toSelf().inSingletonScope();
```

And register it in `OpenMCCommandContribution`:

```typescript
@inject(CrossSectionCommands)
protected readonly crossSectionCommands: CrossSectionCommands;

registerCommands(registry: CommandRegistry): void {
    // ... existing modules
    this.crossSectionCommands.registerCommands(registry);
}
```

---

## Step 5: Add Menu and Toolbar Entries

### Menu Entry

Add to `src/browser/contributions/openmc-menu-contribution.ts`:

```typescript
export namespace OpenMCMenus {
    // ... existing menus
    export const OPENMC_CROSS_SECTIONS = [...OPENMC, '5_cross_sections'];
}

private registerCrossSectionMenus(menus: MenuModelRegistry): void {
    menus.registerSubmenu(OpenMCMenus.OPENMC_CROSS_SECTIONS, 'Cross Sections');
    menus.registerMenuAction(OpenMCMenus.OPENMC_CROSS_SECTIONS, {
        commandId: OpenMCViewCommands.OPEN_CROSS_SECTION_VIEWER.id,
        label: 'Cross Section Viewer',
        order: 'a'
    });
}
```

Call `this.registerCrossSectionMenus(menus)` from `registerMenus()`.

### Toolbar Entry (Optional)

If the widget needs toolbar buttons when active:

```typescript
// In a new or existing toolbar contribution
registry.registerItem({
    id: 'openmc.cross-section-refresh',
    command: 'openmc.crossSection.refresh',
    tooltip: 'Refresh Cross Section Data',
    priority: 50,
    onDidChange: this.onDidChange,
    isVisible: (widget?: any) => widget instanceof CrossSectionViewerWidget
});
```

---

## Step 6: Add Backend RPC Methods (If Needed)

If your widget needs backend functionality, extend the RPC protocol.

### 6a: Add to Protocol

```typescript
// src/common/openmc-studio-protocol.ts
export interface OpenMCStudioBackendService {
    // ... existing methods

    /** Load cross section data for a nuclide */
    loadCrossSection(nuclide: string, reaction: string): Promise<{
        success: boolean;
        energies?: number[];
        values?: number[];
        error?: string;
    }>;
}
```

### 6b: Implement in Backend Service

```typescript
// src/node/openmc-studio-backend-service.ts
async loadCrossSection(nuclide: string, reaction: string): Promise<{ ... }> {
    this.log(`Loading cross section for ${nuclide} ${reaction}`);
    // Delegate to a specialized service or execute a Python script
    return this.executeScriptJson('cross_section_loader.py', [
        nuclide, reaction, '--json'
    ]);
}
```

### 6c: Call from Widget

```typescript
private async loadCrossSection(): Promise<void> {
    const result = await this.backend.loadCrossSection(
        this.selectedNuclide,
        this.reactionType
    );

    if (result.success) {
        this.energies = result.energies;
        this.values = result.values;
        this.update();
    } else {
        this.messageService.error(result.error || 'Unknown error');
    }
}
```

---

## Step 7: Add Python Script (If Needed)

Create `python/cross_section_loader.py`:

```python
#!/usr/bin/env python3
"""Load cross section data for a nuclide."""

import sys
import json
import argparse


def main():
    parser = argparse.ArgumentParser(description='Load cross section data')
    parser.add_argument('nuclide', help='Nuclide name, e.g., U235')
    parser.add_argument('reaction', help='Reaction type, e.g., total, fission')
    parser.add_argument('--json', action='store_true', help='Output as JSON')
    args = parser.parse_args()

    try:
        import openmc
    except ImportError:
        print(json.dumps({
            'success': False,
            'error': 'openmc is required for cross section loading'
        }))
        sys.exit(0)

    try:
        # Example: load from ENDF data
        data = openmc.data.IncidentNeutron.from_hdf5(f'{args.nuclide}.h5')
        reaction = data[args.reaction]

        result = {
            'success': True,
            'nuclide': args.nuclide,
            'reaction': args.reaction,
            'energies': reaction.xs['294K'].x.tolist(),
            'values': reaction.xs['294K'].y.tolist()
        }
        print(json.dumps(result))
        sys.exit(0)
    except Exception as e:
        print(json.dumps({
            'success': False,
            'error': str(e)
        }))
        sys.exit(0)


if __name__ == '__main__':
    main()
```

---

## File Checklist

After adding a widget, these files should be modified or created:

| File | Action |
|------|--------|
| `src/browser/widgets/<name>/<name>-widget.tsx` | **Create** — widget class |
| `src/browser/widgets/<name>/<name>.css` | **Create** — widget styles |
| `src/browser/commands/view-commands.ts` | **Modify** — add command constant + handler |
| `src/browser/contributions/openmc-menu-contribution.ts` | **Modify** — add menu action |
| `src/browser/openmc-studio-frontend-module.ts` | **Modify** — bind widget factory, import CSS |
| `src/common/openmc-studio-protocol.ts` | **Modify (if backend needed)** — add RPC method |
| `src/node/openmc-studio-backend-service.ts` | **Modify (if backend needed)** — implement RPC method |
| `python/<script>.py` | **Create (if backend needed)** — Python helper script |

---

## Testing Your Widget

1. **Build the extension:** `yarn build` from the project root
2. **Start the IDE:** `yarn start:electron` or `yarn start:browser`
3. **Open the widget:** `Tools → OpenMC Studio → Advanced → Cross Section Viewer`
4. **Check the console:** Verify no DI binding errors
5. **Test standalone script:** `python python/cross_section_loader.py U235 total --json`
