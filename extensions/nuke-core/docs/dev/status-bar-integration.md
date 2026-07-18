# Status Bar Integration

Nuke Core renders an environment status bar item that shows the current Python environment and provides quick access to the grouped environment picker. When `nuke.showStatusBar` is set to `"auto"`, the status bar hides once an environment is configured to avoid duplication with the MS Python extension.

Your extension can **request temporary visibility** so the status bar appears while your tools are active. This is useful for extensions like `nuke-visualizer` and `openmc-studio` that need to surface environment status to the user.

---

## Requesting Visibility

Use `NukeCoreStatusBarVisibilityService` to request visibility. It uses **reference counting**, so multiple extensions can request visibility simultaneously without conflicts. When all requests are released, the status bar returns to its normal auto-hide behavior.

### Widget Lifecycle Pattern

The typical pattern is to request visibility when your widget is shown and release it when hidden:

```typescript
import { inject, injectable, postConstruct, preDestroy } from '@theia/core/shared/inversify';
import { NukeCoreStatusBarVisibility, NukeCoreStatusBarVisibilityService } from 'nuke-core/lib/common';

@injectable()
export class MyWidget {
  @inject(NukeCoreStatusBarVisibility)
  private readonly visibilityService: NukeCoreStatusBarVisibilityService;

  private visibilityHandle?: { dispose: () => void };

  // When your widget opens
  onAfterShow(): void {
    this.visibilityHandle = this.visibilityService.requestVisibility('my-extension');
  }

  // When your widget closes
  onBeforeHide(): void {
    this.visibilityHandle?.dispose();
    this.visibilityHandle = undefined;
  }
}
```

### Widget Contribution Pattern

If you manage a view through an `AbstractViewContribution`, request visibility when the view opens and tie disposal to the widget's `disposed` event:

```typescript
import { AbstractViewContribution, OpenViewArguments } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { NukeCoreStatusBarVisibility, NukeCoreStatusBarVisibilityService } from 'nuke-core/lib/common';

@injectable()
export class MyWidgetContribution extends AbstractViewContribution<MyWidget> {
  @inject(NukeCoreStatusBarVisibility)
  private readonly visibilityService: NukeCoreStatusBarVisibilityService;

  private visibilityHandle?: { dispose: () => void };

  async openView(args?: Partial<OpenViewArguments>): Promise<MyWidget> {
    const widget = await super.openView(args);

    // Request visibility when view opens
    this.visibilityHandle = this.visibilityService.requestVisibility('my-extension');

    // Release when the widget is disposed
    widget.disposed.connect(() => {
      this.visibilityHandle?.dispose();
      this.visibilityHandle = undefined;
    });

    return widget;
  }
}
```

---

## How It Works

| Behavior                 | Description                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reference counting**   | Each `requestVisibility(ownerId)` increments an internal counter and returns a disposable handle. Multiple extensions can hold requests at the same time.  |
| **Auto-hide**            | When all handles are disposed, the counter reaches zero and the status bar reverts to normal `auto` mode behavior (hides if an environment is configured). |
| **Seamless integration** | Works alongside the existing `auto` mode without requiring the user to change `nuke.showStatusBar` from its default.                                       |

---

## When to Use It

| Scenario                                                                                | Recommendation                                                                                              |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Your extension has a persistent widget that needs to show the active Python environment | Request visibility on open, release on close.                                                               |
| Your extension runs background tasks that depend on the environment                     | Consider using status messages or custom indicators instead of keeping the status bar visible indefinitely. |
| Your extension only needs the environment for a one-shot command                        | Do not request visibility; use `NukeCoreService` APIs directly.                                             |
| You want the status bar always visible regardless of your extension                     | Encourage the user to set `nuke.showStatusBar` to `"always"`.                                               |

---

## Menu Contributions

The extension provides a **Tools** menu in the main menu bar. Other extensions can contribute to this menu using `NukeMenus.TOOLS`:

```typescript
import { NukeMenus } from 'nuke-core/lib/browser/nuke-core-menus';

menus.registerMenuAction(NukeMenus.TOOLS, {
  commandId: 'my-extension.command',
  label: 'My Command',
  order: 'a'
});
```

> **Tip:** If your extension contributes a widget that frequently interacts with the environment, also consider adding a command to `NukeMenus.TOOLS` so users can access it from the same menu as other Nuke commands.
