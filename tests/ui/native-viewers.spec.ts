import { test, expect, Page, Locator } from '@playwright/test';
import { collectErrors, waitForWorkbench, openFileByQuickOpen, closeAllEditors, runCommand } from './helpers';

/**
 * Native 3D viewer smoke suite (trame-to-frontend migration).
 *
 * Covers every native viewer with tiny committed fixtures under
 * tests/ui/fixtures/ (no nuclear-data backend needed except where noted):
 * - generic VisualizerWidget: XML `.vtp`, legacy ASCII `.vtk`, `.vti`
 * - DAGMC multiblock viewer: hand-written `.vtm` + 2× `.vtu` (FileService only)
 * - geometry-native viewer: tiny `geometry.xml` (pure-Python XML parse)
 *
 * Suite conventions (root AGENTS.md): Theia/lumino selectors only, Command
 * Palette via Ctrl+Shift+P + `>` prefix, zero console severity-error/pageerror
 * gate per test (l10n noise filtered like the other specs).
 */

test.setTimeout(180_000);

function severe(errors: string[]): string[] {
    return errors.filter(
        (e) =>
            !e.includes('l10n') &&
            !e.includes('localization bundles') &&
            // Upstream Theia plugin-host race when tabs open/close in quick
            // succession (extHostTab dto arrives for a closed tab).
            !e.includes('INVALID tab')
    );
}

async function openViewer(page: Parameters<typeof openFileByQuickOpen>[0], name: string) {
    await closeAllEditors(page);
    // Warm the file-search index: the first Quick Open query after server
    // start can take a long time on a repo-sized workspace and times out.
    await page.locator('#theia-app-shell').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Control+P');
    const warm = page.locator('.quick-input-widget input');
    await expect(warm).toBeVisible({ timeout: 10_000 });
    await warm.fill('fixtures');
    await expect(page.locator('.quick-input-widget .monaco-list-row').first()).toBeVisible({ timeout: 120_000 });
    await page.keyboard.press('Escape');
    await openFileByQuickOpen(page, name);
    const container = page.locator('.openmc-output-viewer-container').first();
    await expect(container).toBeVisible({ timeout: 60_000 });
    return container;
}

/**
 * Open the Viewer Settings sidebar (display controls moved out of the
 * viewer headers). The panel binds to the last-active viewer tab and keeps
 * the binding while its own controls have focus.
 */
async function openViewerSettings(page: Parameters<typeof openFileByQuickOpen>[0]) {
    await runCommand(page, 'Open Viewer Settings');
    const panel = page.locator('.viewer-settings-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    return panel;
}

/**
 * Pick a NukeSelect option: the dropdown portals to document.body, so the
 * option is located from the page root, not the settings panel.
 */
async function selectNukeOption(page: Page, scope: Locator, hookClass: string, optionName: string) {
    await scope.locator(`.${hookClass} .nuke-select-trigger`).click();
    await page.locator('.nuke-select-list').getByRole('option', { name: optionName }).click();
}

test('native polydata (.vtp) renders with canvas and instant color-by', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'native-polydata.vtp');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    const canvas = container.locator('.openmc-output-viewer-viewarea canvas');
    await expect(canvas).toBeVisible({ timeout: 30_000 });

    // Instant color-by switch (no server restart): point energy -> cell id.
    // Display controls live in the Viewer Settings sidebar, not the header.
    const settings = await openViewerSettings(page);
    const colorByTrigger = settings.locator('.viewer-settings-color-by .nuke-select-trigger');
    await expect(colorByTrigger).toBeVisible();
    await selectNukeOption(page, settings, 'viewer-settings-color-by', 'Cell: cell_id');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    await expect(canvas).toBeVisible();

    // Shading + clip controls (CAD parity): wireframe mode and an enabled
    // clip plane must apply instantly without errors.
    await selectNukeOption(page, settings, 'viewer-settings-shading', 'Wireframe');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    const clipToggle = settings.locator('.viewer-settings-clip-master');
    await clipToggle.click();
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    await expect(canvas).toBeVisible();

    // OrbitControls smoke (reported camera bugs): drag to orbit, wheel to
    // zoom — the canvas must survive with no errors.
    const box = await canvas.boundingBox();
    if (box) {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + 120, cy + 60, { steps: 12 });
        await page.mouse.up();
        await page.mouse.wheel(0, -240);
        await expect(canvas).toBeVisible();
        await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    }

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('viewer settings sidebar shows values and drives shading', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'native-polydata.vtp');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    const canvas = container.locator('.openmc-output-viewer-viewarea canvas');
    await expect(canvas).toBeVisible({ timeout: 30_000 });

    // No header strip at all — screenshot/reload live on the bottom bar.
    await expect(container.locator('.openmc-output-viewer-header')).toHaveCount(0);

    // The file name renders exactly once, in the canvas dataset badge.
    await expect(container.locator('.nuke-view-badge')).toHaveCount(1);
    await expect(container.locator('.nuke-view-badge')).toContainText('native-polydata.vtp');

    // Bottom-bar quick actions mirror the sidebar (clip + shading popovers, screenshot + reload past the core 7).
    await expect(container.locator('.nuke-viewer-nav-bar')).toBeVisible();
    expect(await container.locator('.nuke-viewer-nav-bar button').count()).toBeGreaterThanOrEqual(11);

    // The sidebar binds to the active viewer tab and shows its live values.
    const settings = await openViewerSettings(page);
    await expect(settings.locator('.viewer-settings-header-name')).toHaveText('Viewer Settings');
    await expect(settings.locator('.viewer-settings-title')).toContainText('Visualizer: native-polydata.vtp');
    // CAD panel chrome: collapsible count-badge sections with live status dots.
    await expect(settings.locator('.viewer-settings-category-header').first()).toBeVisible();
    await expect(settings.locator('.viewer-settings-state-dot').first()).toBeVisible();
    const colorByTrigger = settings.locator('.viewer-settings-color-by .nuke-select-trigger');
    await expect(colorByTrigger).toBeVisible();
    await expect(colorByTrigger).not.toHaveText('Select an option');
    await colorByTrigger.click();
    expect(await page.locator('.nuke-select-list [role="option"]').count()).toBeGreaterThan(1);
    await page.keyboard.press('Escape');
    const shadingTrigger = settings.locator('.viewer-settings-shading .nuke-select-trigger');
    await expect(shadingTrigger).toHaveText('Shaded');

    // A sidebar shading change applies to the canvas instantly.
    await selectNukeOption(page, settings, 'viewer-settings-shading', 'X-Ray');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    await expect(canvas).toBeVisible();
    await expect(settings.locator('.viewer-settings-shading .nuke-select-trigger')).toHaveText('X-Ray');

    // The axis snap group drives the orbit handle without errors.
    await settings.locator('button.viewer-settings-snap-iso').click();
    await expect(canvas).toBeVisible();
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('orientation cube is visible and X snaps the view', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'native-polydata.vtp');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    const canvas = container.locator('.openmc-output-viewer-viewarea canvas');
    await expect(canvas).toBeVisible({ timeout: 30_000 });

    // Shared orientation cube (nuke-essentials ViewCube): six labeled axis
    // knobs top-right below the header chrome.
    const gizmo = container.locator('.nuke-view-cube');
    await expect(gizmo).toBeVisible({ timeout: 30_000 });
    await expect(gizmo.locator('.nuke-view-cube-knob')).toHaveCount(6);

    // Overlay-sizing regression (collapsed-cross bug): the box must be a
    // healthy fixed-size overlay and every knob slot a real hit target, not
    // a shrunken sliver (the visible knob circle itself is smaller).
    const gizmoBox = await gizmo.boundingBox();
    expect(gizmoBox?.width).toBeGreaterThanOrEqual(60);
    expect(gizmoBox?.height).toBeGreaterThanOrEqual(60);
    const knobBox = await gizmo.locator('.nuke-view-cube-knob-slot').first().boundingBox();
    expect(knobBox?.width).toBeGreaterThanOrEqual(20);
    expect(knobBox?.height).toBeGreaterThanOrEqual(20);

    // Clicking the +X knob snaps the standard view (orbit handle): the
    // canvas must survive with no errors. (The triad has ± knobs per axis;
    // the positive one lacks the `-negative` marker class.)
    await gizmo.locator('.nuke-view-cube-knob.nuke-view-cube-axis-x:not(.nuke-view-cube-knob-negative)').click();
    await expect(canvas).toBeVisible();
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('distance measure labels a known-size fixture and Escape clears', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    // The legacy fixture is a 1x1 unit square in the z=0 plane: two clicks on
    // the same surface point must read exactly 0.
    const container = await openViewer(page, 'native-legacy.vtk');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    const canvas = container.locator('.openmc-output-viewer-viewarea canvas');
    await expect(canvas).toBeVisible({ timeout: 30_000 });

    const toggle = (await openViewerSettings(page)).locator('.viewer-measure-toggle');
    await expect(toggle).toBeVisible({ timeout: 30_000 });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    const box = await canvas.boundingBox();
    if (!box) {
        throw new Error('measure test needs a laid-out canvas');
    }
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.click(cx, cy);
    await page.mouse.click(cx, cy);
    const label = container.locator('.viewer-measure-label');
    await expect(label).toBeVisible({ timeout: 30_000 });
    await expect(label).toHaveText('0');

    // Escape clears the committed segment (label hides).
    await page.keyboard.press('Escape');
    await expect(label).toBeHidden({ timeout: 30_000 });

    // Two spread clicks on the same unit square commit a non-zero distance.
    await page.mouse.click(box.x + box.width * 0.4, cy);
    await page.mouse.click(box.x + box.width * 0.6, cy);
    await expect(label).toBeVisible({ timeout: 30_000 });
    const text = (await label.textContent())?.trim() ?? '';
    expect(text).toMatch(/^\d+(\.\d+)?$/);
    expect(text).not.toBe('0');
    await page.keyboard.press('Escape');
    await expect(label).toBeHidden({ timeout: 30_000 });

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('legacy ASCII (.vtk) renders (screenshot regression)', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    // The exact class from the bug screenshot: a converter-produced legacy
    // UNSTRUCTURED_GRID must parse instead of reporting a missing XML root.
    const container = await openViewer(page, 'native-legacy.vtk');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    await expect(container.locator('.openmc-output-viewer-viewarea canvas')).toBeVisible({ timeout: 30_000 });
    // Surface datasets must report (and render) filled triangles, not
    // wireframe outlines only — the tokamak DAGMC regression.
    await expect(container.getByText('2 triangles').first()).toBeVisible({ timeout: 30_000 });

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('voxel image (.vti) renders', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'native-image.vti');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    await expect(container.locator('.openmc-output-viewer-viewarea canvas')).toBeVisible({ timeout: 30_000 });

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('DAGMC multiblock (.vtm) renders both volumes', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'native-volumes.vtm');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    await expect(container.locator('.openmc-output-viewer-viewarea canvas')).toBeVisible({ timeout: 30_000 });
    // No sibling .h5m exists for dagmc.info, so the viewer renders blocks
    // with a block-count status line; volume toggles live in the DAGMC
    // Outline sidebar, not the viewer footer.
    await expect(container.getByText('2 of 2 volumes (no model info)').first()).toBeVisible({ timeout: 30_000 });
    await expect(container.locator('.openmc-output-viewer-header select')).toHaveCount(0);

    // The file name renders exactly once, in the canvas dataset badge (never the header).
    await expect(container.locator('.openmc-output-viewer-header .openmc-output-viewer-file')).toHaveCount(0);
    await expect(container.locator('.nuke-view-badge')).toHaveCount(1);
    await expect(container.locator('.nuke-view-badge')).toContainText('native-volumes.vtm');

    // Bottom-bar quick actions mirror the sidebars (clip + shading popovers, exclude/isolate past the core 7).
    await expect(container.locator('.nuke-viewer-nav-bar')).toBeVisible();
    expect(await container.locator('.nuke-viewer-nav-bar button').count()).toBeGreaterThanOrEqual(11);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('DAGMC outline sidebar lists volumes and toggles visibility', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'native-volumes.vtm');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    const canvas = container.locator('.openmc-output-viewer-viewarea canvas');
    await expect(canvas).toBeVisible({ timeout: 30_000 });

    // The outline binds to the active DAGMC viewer tab and lists the loaded
    // blocks as volume rows (no dagmc.info for this fixture, so no
    // material/group sections — volumes fall back to block names).
    await runCommand(page, 'Open DAGMC Outline');
    const panel = page.locator('.dagmc-outline-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    // Regression for the empty-state report: with the .vtm tab open, the
    // panel must bind it instead of showing "No DAGMC viewer open".
    await expect(panel.locator('.dagmc-outline-empty')).toHaveCount(0);
    const boxes = panel.locator('.dagmc-outline-volume-checkbox');
    await expect(boxes).toHaveCount(2);
    await expect(panel.getByText('Material and group info need model info')).toBeVisible();
    // CAD panel chrome: icon header, collapsible badge sections, per-row
    // status dots, and the no-model-info banner.
    await expect(panel.locator('.dagmc-outline-header-icon')).toBeVisible();
    await expect(panel.locator('.dagmc-outline-panel-name')).toHaveText('DAGMC Outline');
    await expect(panel.locator('.dagmc-outline-group-header').first()).toBeVisible();
    await expect(panel.locator('.dagmc-outline-volume-row .dagmc-outline-state-dot')).toHaveCount(2);
    await expect(panel.locator('.dagmc-outline-banner')).toContainText('Material and group info need model info');

    // Uncheck one volume: the canvas status line drops to 1 of 2.
    await boxes.nth(0).click();
    await expect(container.getByText('1 of 2 volumes').first()).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('.dagmc-outline-volume-row.dagmc-outline-row-hidden')).toHaveCount(1);
    await expect(canvas).toBeVisible();
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    // The search filter narrows the volume list for large models.
    const search = panel.locator('.dagmc-outline-search');
    await search.fill('zzz-no-such-volume');
    await expect(panel.locator('.dagmc-outline-volume-checkbox')).toHaveCount(0);
    await search.fill('');
    await expect(panel.locator('.dagmc-outline-volume-checkbox')).toHaveCount(2);

    // Show all restores the hidden volume.
    await panel.locator('.dagmc-outline-show-all').click();
    await expect(container.getByText('2 of 2 volumes').first()).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('.dagmc-outline-volume-row.dagmc-outline-row-hidden')).toHaveCount(0);
    await expect(canvas).toBeVisible();
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('DAGMC viewer auto-opens the outline and row click selects the volume', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'native-volumes.vtm');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    const canvas = container.locator('.openmc-output-viewer-viewarea canvas');
    await expect(canvas).toBeVisible({ timeout: 30_000 });

    // Auto-open: the viewer reveals the DAGMC Outline sidebar on open, so no
    // command is needed (fresh context → the panel starts closed).
    const panel = page.locator('.dagmc-outline-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('.nuke-empty-state')).toHaveCount(0);
    await expect(panel.locator('.dagmc-outline-volume-checkbox')).toHaveCount(2);

    // Row click selects the volume in the canvas: the widget owns the
    // selection and the row mirrors it with the selected treatment.
    const rows = panel.locator('.dagmc-outline-volume-row');
    await expect(rows).toHaveCount(2);
    await rows.nth(0).click();
    await expect(rows.nth(0)).toHaveClass(/selected/);
    await expect(rows.nth(1)).not.toHaveClass(/selected/);

    // Clicking the selected row again clears the selection.
    await rows.nth(0).click();
    await expect(rows.nth(0)).not.toHaveClass(/selected/);

    await expect(canvas).toBeVisible();
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('viewer context menu opens inside the viewport and fit works', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'native-polydata.vtp');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    const canvas = container.locator('.openmc-output-viewer-viewarea canvas');
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    const box = await canvas.boundingBox();
    if (!box) {
        throw new Error('context-menu test needs a laid-out canvas');
    }

    // Bottom-right corner right-click: the menu must clamp fully inside the
    // viewport instead of spilling over the edge.
    await page.mouse.click(box.x + box.width - 8, box.y + box.height - 8, { button: 'right' });
    const menu = page.locator('.viewer-context-menu');
    await expect(menu).toBeVisible({ timeout: 30_000 });
    const viewport = page.viewportSize();
    const menuBox = await menu.boundingBox();
    if (!menuBox || !viewport) {
        throw new Error('context-menu test needs a laid-out menu and viewport');
    }
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.y).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height);

    // Escape dismisses without picking anything.
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden({ timeout: 30_000 });

    // Center right-click: grouped menu (separators, icons, checked active
    // shading mode) with the first row fully inside the menu — the
    // top-item-clip regression.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await expect(menu).toBeVisible({ timeout: 30_000 });
    await expect(menu.locator('.viewer-context-menu-separator')).toHaveCount(2);
    // CAD menu density: every row (including shading rows) carries an icon.
    const menuRowCount = await menu.locator('.viewer-context-menu-item').count();
    expect(await menu.locator('.viewer-context-menu-icon .codicon').count()).toBe(menuRowCount);
    await expect(menu.locator('.viewer-context-menu-item-checked').first()).toContainText('Shaded');
    const first = menu.locator('.viewer-context-menu-item').first();
    await expect(first).toContainText('Fit to View');
    const openBox = await menu.boundingBox();
    const firstBox = await first.boundingBox();
    if (!openBox || !firstBox) {
        throw new Error('context-menu test needs laid-out menu rows');
    }
    expect(firstBox.y).toBeGreaterThanOrEqual(openBox.y);
    expect(firstBox.y + firstBox.height).toBeLessThanOrEqual(openBox.y + openBox.height);

    // Clicking Fit to View closes the menu and keeps the canvas healthy.
    await first.click();
    await expect(menu).toBeHidden({ timeout: 30_000 });
    await expect(canvas).toBeVisible();
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('nav-bar clip popover drives the X plane and shading popover applies X-Ray', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'native-polydata.vtp');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    const canvas = container.locator('.openmc-output-viewer-viewarea canvas');
    await expect(canvas).toBeVisible({ timeout: 30_000 });

    // Clip trigger opens the anchored card (X/Y/Z tabs + Flip + Offset).
    const clipTrigger = container.locator('.viewer-nav-clip-trigger');
    await expect(clipTrigger).toBeVisible();
    await clipTrigger.click();
    const clipPopover = container.locator('.viewer-nav-clip-popover');
    await expect(clipPopover).toBeVisible({ timeout: 30_000 });

    // Dragging Offset enables the tab plane and clips the canvas (no extra
    // step — the slider implies the cut, like the geometry header).
    const offset = clipPopover.locator('input.viewer-nav-clip-offset');
    await offset.evaluate((element: HTMLInputElement, value: string) => {
        // Native setter: a plain assignment is swallowed by React's value
        // tracker, so the controlled onChange would never fire.
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }, '80');
    await expect(clipPopover.locator('.viewer-nav-clip-slider-row span').last()).toHaveText('80%');
    // The trigger lights up (a plane is enabled) and the canvas survives.
    await expect(clipTrigger).toHaveClass(/active/);
    await expect(canvas).toBeVisible();
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    // Re-clicking the trigger toggles the card closed.
    await clipTrigger.click();
    await expect(clipPopover).toBeHidden({ timeout: 30_000 });

    // Escape also dismisses: reopen, then press Escape with the slider focused.
    await clipTrigger.click();
    await expect(clipPopover).toBeVisible({ timeout: 30_000 });
    await offset.focus();
    await page.keyboard.press('Escape');
    await expect(clipPopover).toBeHidden({ timeout: 30_000 });

    // Shading trigger opens the mode list; picking X-Ray applies it through
    // the existing setter (the sidebar select shows the same value —
    // single-sourced state, no duplication).
    const shadingTrigger = container.locator('.viewer-nav-shading-trigger');
    await shadingTrigger.click();
    const shadingPopover = container.locator('.viewer-nav-shading-popover');
    await expect(shadingPopover).toBeVisible({ timeout: 30_000 });
    await shadingPopover.locator('.viewer-nav-shading-item', { hasText: 'X-Ray' }).click();
    // Picking a mode closes the card and lights the trigger.
    await expect(shadingPopover).toBeHidden({ timeout: 30_000 });
    await expect(shadingTrigger).toHaveClass(/active/);
    await expect(canvas).toBeVisible();
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    const settings = await openViewerSettings(page);
    await expect(settings.locator('.viewer-settings-shading .nuke-select-trigger')).toHaveText('X-Ray');

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('geometry.xml renders cells in the native geometry viewer', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'geometry.xml');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    await expect(container.locator('.openmc-output-viewer-viewarea canvas')).toBeVisible({ timeout: 60_000 });
    // Cell list from the extractor payload: the CSG Outline sidebar binds to
    // the active geometry viewer (outline sidebar pattern — the list lives
    // outside the viewer tab, like the DAGMC outline).
    const outline = page.locator('.csg-outline-panel').first();
    await expect(outline.getByText('fuel (1)').first()).toBeVisible({ timeout: 30_000 });

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});
