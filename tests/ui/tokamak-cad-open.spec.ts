import { test, expect, Page } from '@playwright/test';
import { collectErrors, waitForWorkbench, runCommand, closeAllEditors } from './helpers';

/**
 * GUI regression snapshots for the nuke-cad chrome:
 * 1. Empty-state card is centered and not clipped.
 * 2. Loading the tokamak document shows a centered loading overlay (regression for
 *    the right-edge clipping caused by the imperative three.js canvas pushing the
 *    spinner out of the flex container).
 */

test.setTimeout(120_000);

test('CAD Viewport empty state is centered and readable', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    await runCommand(page, 'Open CAD Viewport');
    const viewport = page.locator('.cad-viewport.empty').first();
    await expect(viewport).toBeVisible({ timeout: 30_000 });

    await viewport.screenshot({ path: 'test-results/cad-viewport-empty.png' });
    await page.screenshot({ path: 'test-results/cad-viewport-empty-full.png' });

    const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});

test('tokamak nuke-cad fixture loading overlay is centered', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    // Trigger the file open but do not wait for the quick-input to close, so we
    // can snapshot the loading overlay before the backend build finishes.
    await openFileByQuickOpen(page, 'tokamak_with_divertor.nuke-cad', false);

    const overlay = page.locator('.nuke-loading-overlay').first();
    await expect(overlay).toBeVisible({ timeout: 30_000 });
    await expect(overlay).toContainText(/^(Loading|Building|Rebuilding|Restoring)/);
    await overlay.screenshot({ path: 'test-results/tokamak-cad-loading.png' });

    // Spot-check that the message text is centered (x within 20 % of viewport center).
    const [messageRect, viewportRect] = await page.evaluate(() => {
        const overlayEl = document.querySelector('.nuke-loading-overlay');
        const viewportEl = overlayEl?.closest('.cad-viewport');
        const msgEl = overlayEl
            ? Array.from(overlayEl.querySelectorAll('*')).find(
                  (e) => e.children.length === 0 && /^(Loading|Building|Rebuilding|Restoring)/.test((e.textContent ?? '').trim())
              )
            : null;
        return [msgEl?.getBoundingClientRect() ?? null, viewportEl?.getBoundingClientRect() ?? null];
    });
    expect(messageRect, 'loading message not found').not.toBeNull();
    expect(viewportRect, 'viewport bounding box').not.toBeNull();
    const center = messageRect!.x + messageRect!.width / 2;
    const viewportCenter = viewportRect!.x + viewportRect!.width / 2;
    expect(Math.abs(center - viewportCenter)).toBeLessThan(viewportRect!.width * 0.2);

    // Intentionally do not wait for the full backend build in this snapshot test.
    const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});

test('tokamak build warnings render as a compact badge with a popover list', async ({ page }) => {
    test.setTimeout(240_000);
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    await openFileByQuickOpen(page, 'tokamak_with_divertor.nuke-cad');
    const viewport = page.locator('.cad-viewport').first();
    await expect(viewport).toBeVisible({ timeout: 30_000 });

    // Wait for the backend build: the tokamak fixture reports five non-fatal
    // warnings; a failed build shows the error banner instead (skip, like the
    // command-search spec does).
    const strip = viewport.locator('.cad-viewport-warning-strip').first();
    const errorBanner = viewport.locator('.cad-viewport-error-banner');
    await expect(strip.or(errorBanner).first()).toBeVisible({ timeout: 120_000 });
    if (await errorBanner.isVisible()) {
        test.skip(true, `CAD backend unavailable: ${(await errorBanner.textContent()) ?? 'build failed'}`);
    }
    await expect(strip).toContainText('5 build warnings');

    // Document mode: the badge sits fully below the document toolbar (never
    // hidden behind its z-index) and stays a compact badge, not a full-width bar.
    const toolbar = viewport.locator('.cad-document-toolbar').first();
    await expect(toolbar).toBeVisible({ timeout: 60_000 });
    const [stripBox, toolbarBox] = await Promise.all([strip.boundingBox(), toolbar.boundingBox()]);
    expect(stripBox, 'warning strip has no bounding box').not.toBeNull();
    expect(toolbarBox, 'document toolbar has no bounding box').not.toBeNull();
    expect(stripBox!.width).toBeLessThanOrEqual(300);
    expect(stripBox!.y).toBeGreaterThanOrEqual(toolbarBox!.y + toolbarBox!.height);

    // The dismiss X is fully inside the strip and clickable.
    const dismiss = strip.locator('.cad-viewport-error-dismiss').first();
    await expect(dismiss).toBeVisible();
    const dismissBox = await dismiss.boundingBox();
    expect(dismissBox, 'warning dismiss has no bounding box').not.toBeNull();
    expect(dismissBox!.x + dismissBox!.width).toBeLessThanOrEqual(stripBox!.x + stripBox!.width + 1);

    // Expanding renders the list in a popover; the strip itself keeps its size.
    const toggle = strip.locator('.cad-viewport-warning-toggle');
    await toggle.click();
    const popover = viewport.locator('.cad-viewport-warning-popover').first();
    await expect(popover).toBeVisible();
    await expect(popover.locator('.cad-viewport-warning-item')).toHaveCount(5);
    const [popoverBox, openStripBox] = await Promise.all([popover.boundingBox(), strip.boundingBox()]);
    expect(popoverBox, 'warning popover has no bounding box').not.toBeNull();
    expect(openStripBox, 'open warning strip has no bounding box').not.toBeNull();
    expect(popoverBox!.width).toBeLessThanOrEqual(340);
    expect(popoverBox!.y).toBeGreaterThanOrEqual(openStripBox!.y + openStripBox!.height);
    expect(openStripBox!.height).toBeLessThanOrEqual(stripBox!.height + 0.5);
    // Document mode parks the badge on the right, clear of the ViewCube slot.
    const documentViewport = await viewport.boundingBox();
    expect(documentViewport, 'viewport has no bounding box').not.toBeNull();
    expect(stripBox!.x + stripBox!.width).toBeLessThanOrEqual(documentViewport!.x + documentViewport!.width - 80);
    await page.screenshot({ path: 'test-results/cad-build-warnings.png' });

    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();

    // An outside pointer press closes it as well.
    await toggle.click();
    await expect(popover).toBeVisible();
    const viewportBox = await viewport.boundingBox();
    expect(viewportBox, 'viewport has no bounding box').not.toBeNull();
    await page.mouse.click(viewportBox!.x + viewportBox!.width - 30, viewportBox!.y + viewportBox!.height - 30);
    await expect(popover).toBeHidden();

    // Sketch mode: the compact strip ends before the centered constraint bar
    // and the top-right Finish Sketch pill, and the dismiss stays visible.
    await runCommand(page, 'New Sketch');
    const datumPicker = viewport.locator('.cad-sketch-datum-picker').first();
    await expect(datumPicker).toBeVisible({ timeout: 10_000 });
    await datumPicker.locator('button', { hasText: 'Start Sketch' }).first().click();
    await expect(viewport.locator('.cad-sketch-finish-button')).toBeVisible({ timeout: 30_000 });
    const constraintBar = viewport.locator('.cad-sketch-constraint-bar').first();
    await expect(constraintBar).toBeVisible();
    const [sketchStripBox, barBox, finishBox] = await Promise.all([
        strip.boundingBox(),
        constraintBar.boundingBox(),
        viewport.locator('.cad-sketch-finish-button').boundingBox()
    ]);
    expect(sketchStripBox, 'sketch warning strip has no bounding box').not.toBeNull();
    expect(barBox, 'constraint bar has no bounding box').not.toBeNull();
    expect(finishBox, 'finish button has no bounding box').not.toBeNull();
    expect(sketchStripBox!.width).toBeLessThanOrEqual(300);
    expect(sketchStripBox!.x + sketchStripBox!.width).toBeLessThan(barBox!.x + 1);
    expect(sketchStripBox!.x + sketchStripBox!.width).toBeLessThan(finishBox!.x + 1);
    await expect(dismiss).toBeVisible();
    await page.screenshot({ path: 'test-results/cad-build-warnings-sketch.png' });

    const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});

test('document-mode header toolbar renders with grouped actions and hides welcome card', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    // Start from a clean workbench so New CAD Document is enabled.
    await closeAllEditors(page);
    await runCommand(page, 'New CAD Document');
    const viewport = page.locator('.cad-viewport').first();
    await expect(viewport).toBeVisible({ timeout: 30_000 });

    // The new document command now opens the template picker.
    const templatePicker = page.locator('.cad-template-picker').first();
    await expect(templatePicker).toBeVisible({ timeout: 10_000 });
    await templatePicker.locator('button', { hasText: 'Empty document' }).first().click();

    // After creating a document the welcome card should be hidden and the
    // empty-document card should be shown instead (never the welcome
    // `.nuke-empty-state`).
    await expect(viewport.locator('.nuke-empty-state')).toBeHidden();
    const emptyCard = viewport.locator('.cad-viewport-document-empty').first();
    await expect(emptyCard).toBeVisible({ timeout: 10_000 });
    await expect(emptyCard.locator('.cad-viewport-document-empty-title')).toHaveText('Empty document');

    // The redesigned header toolbar should render with the document title on the
    // left and grouped action buttons on the right.
    // The overlay chrome (toolbar, shortcut bar, datum picker) mounts only
    // after the viewport controller initializes, which awaits a cold dynamic
    // import of the OrbitControls chunk (~20 s on a fresh page load — file
    // flows mask this behind backend-build waits, new-document flows do not).
    const toolbar = page.locator('.cad-document-toolbar').first();
    await expect(toolbar).toBeVisible({ timeout: 60_000 });
    // Visual review: the world-origin triad must not render without a model.
    await viewport.screenshot({ path: 'test-results/cad-empty-no-axes.png' });
    await expect(toolbar.locator('.cad-document-toolbar-name')).toContainText('Untitled');
    await expect(toolbar.locator('.nuke-ribbon-section')).toHaveCount(7);
    await expect(toolbar.locator('[role="group"][aria-label="Document"]')).toBeVisible();
    await expect(toolbar.locator('[role="group"][aria-label="Sketch"]')).toBeVisible();
    await expect(toolbar.locator('[role="group"][aria-label="Additive"]')).toBeVisible();
    await expect(toolbar.locator('[role="group"][aria-label="Boolean"]')).toBeVisible();
    await expect(toolbar.locator('[role="group"][aria-label="Dress-up"]')).toBeVisible();
    await expect(toolbar.locator('[role="group"][aria-label="Pattern"]')).toBeVisible();
    await expect(toolbar.locator('[role="group"][aria-label="Inspect"]')).toBeVisible();

    // Every section keeps a visible caption underneath its promoted buttons.
    for (const label of ['Document', 'Additive', 'Inspect']) {
        const caption = toolbar.locator(`[role="group"][aria-label="${label}"] .nuke-ribbon-caption-label`);
        await expect(caption).toHaveText(label);
        await expect(caption).toBeVisible();
    }

    await viewport.screenshot({ path: 'test-results/cad-viewport-document-toolbar.png' });

    // Pad is disabled until a sketch is selected; verify the toolbar state is
    // sensible and no dialog opens when a disabled feature button is clicked.
    // At menus density the action lives behind the Additive caret.
    const additive = toolbar.locator('[role="group"][aria-label="Additive"]').first();
    let padButton = additive.locator('button:has(.codicon-nuke-cad-pad)').first();
    let openedMenu = false;
    if (!(await padButton.isVisible())) {
        await additive.locator('.nuke-ribbon-menu-trigger').click();
        padButton = page.locator('.nuke-ribbon-menu [role="menuitem"]:has(.codicon-nuke-cad-pad)').first();
        openedMenu = true;
    }
    await expect(padButton).toBeVisible();
    await expect(padButton).toBeDisabled();
    await padButton.click({ force: true });
    await expect(page.locator('.nuke-dialog').first()).toBeHidden();
    if (openedMenu) {
        await page.keyboard.press('Escape');
        await expect(page.locator('.nuke-ribbon-menu')).toBeHidden();
    }

    // The empty-document Create Sketch CTA opens the task panel while the
    // ribbon stays mounted; New Sketch reads as pressed until setup ends.
    await page.setViewportSize({ width: 1920, height: 800 });
    await expect(toolbar.locator('.nuke-ribbon-tiles')).toBeVisible({ timeout: 10_000 });
    await emptyCard.locator('button', { hasText: 'Create Sketch' }).click();
    const datumPicker = viewport.locator('.cad-sketch-datum-picker').first();
    await expect(datumPicker).toBeVisible({ timeout: 10_000 });
    await expect(datumPicker).toHaveAttribute('role', 'dialog');
    await expect(datumPicker.locator('.cad-sketch-datum-title')).toHaveText('Create Sketch');
    await expect(datumPicker.locator('.cad-sketch-datum-instruction')).toHaveText('Pick a plane or planar face for the sketch.');
    await viewport.screenshot({ path: 'test-results/cad-create-sketch-panel.png' });
    await expect(toolbar).toBeVisible();
    const newSketch = toolbar.locator('[role="group"][aria-label="Sketch"] button:has(.codicon-nuke-cad-sketch)').first();
    await expect(newSketch).toHaveAttribute('aria-pressed', 'true');
    await datumPicker.locator('button[aria-label="Cancel sketch setup"]').click();
    await expect(datumPicker).toBeHidden();
    await expect(newSketch).toHaveAttribute('aria-pressed', 'false');

    const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});

test('document toolbar collapses to section menus without wrapping at narrow width', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    // Start from a clean workbench so New CAD Document is enabled.
    await closeAllEditors(page);
    await runCommand(page, 'New CAD Document');
    const viewport = page.locator('.cad-viewport').first();
    await expect(viewport).toBeVisible({ timeout: 30_000 });

    const templatePicker = page.locator('.cad-template-picker').first();
    await expect(templatePicker).toBeVisible({ timeout: 10_000 });
    await templatePicker.locator('button', { hasText: 'Empty document' }).first().click();

    const toolbar = page.locator('.cad-document-toolbar').first();
    await expect(toolbar).toBeVisible({ timeout: 60_000 });

    // Wide window: tiles density with short captions; full labels stay in the
    // tooltip and the section menu.
    await page.setViewportSize({ width: 1920, height: 800 });
    await expect(toolbar.locator('.nuke-ribbon-tiles')).toBeVisible({ timeout: 10_000 });
    await expect(toolbar.locator('[role="group"][aria-label="Document"] .nuke-ribbon-item-label')).toHaveText([
        'New',
        'Save',
        'Undo',
        'Redo',
        'Rebuild'
    ]);
    await expect(toolbar.locator('[role="group"][aria-label="Inspect"] .nuke-ribbon-item-label').last()).toHaveText('Measures');
    await expect(toolbar.locator('.cad-document-toolbar-search')).toBeVisible();
    await toolbar.screenshot({ path: 'test-results/cad-ribbon-tiles.png' });

    // Ribbon customization: pinning a caret-menu command renders it inline in
    // its section. The menu keeps listing every command with a pin toggle.
    const documentGroup = toolbar.locator('[role="group"][aria-label="Document"]').first();
    const documentTiles = documentGroup.locator('.nuke-ribbon-item');
    const sectionMenu = page.locator('.nuke-ribbon-menu');
    await expect(documentTiles).toHaveCount(5);
    await documentGroup.locator('.nuke-ribbon-menu-trigger').click();
    await expect(sectionMenu).toBeVisible({ timeout: 10_000 });
    // The menu lists every Document command, inline ones included.
    await expect(sectionMenu.locator('[role="menuitem"]')).toHaveCount(6);
    const exportRow = sectionMenu.locator('.nuke-ribbon-menu-row', { hasText: 'Export as Python' }).first();
    await expect(exportRow.locator('[role="menuitem"]')).toContainText('Export as Python');
    await exportRow.locator('button[aria-label="Pin to toolbar"]').click();
    // Pinning never closes the menu or runs the command.
    await expect(sectionMenu).toBeVisible();
    await expect(exportRow.locator('button[aria-label="Unpin from toolbar"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sectionMenu).toBeHidden();

    // Export Python now sits inline after the five default Document tiles.
    await expect(documentTiles).toHaveCount(6);
    const exportTile = documentGroup.locator('.nuke-ribbon-item:has(.codicon-code)');
    await expect(exportTile).toBeVisible();
    await expect(exportTile).toContainText('Export as Python');

    // Reopening offers the inverse toggle; unpinning restores the defaults.
    await documentGroup.locator('.nuke-ribbon-menu-trigger').click();
    await expect(sectionMenu).toBeVisible({ timeout: 10_000 });
    await expect(exportRow.locator('button[aria-label="Unpin from toolbar"]')).toBeVisible();
    await exportRow.locator('button[aria-label="Unpin from toolbar"]').click();
    await expect(sectionMenu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sectionMenu).toBeHidden();
    await expect(documentTiles).toHaveCount(5);
    await expect(exportTile).toHaveCount(0);

    // Narrow the window: the bar must switch to caption menus, not wrap.
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(toolbar.locator('.nuke-ribbon-menus')).toBeVisible({ timeout: 10_000 });
    await expect(toolbar.locator('.nuke-ribbon-section')).toHaveCount(7);
    await expect(toolbar.locator('.cad-document-toolbar-search')).toBeVisible();
    const menuTriggers = toolbar.locator('.nuke-ribbon-menu-trigger');
    await expect(menuTriggers).toHaveCount(7);
    for (let index = 0; index < 7; index++) {
        await expect(menuTriggers.nth(index)).toBeVisible();
    }

    // One action row, no horizontal overflow.
    const box = await toolbar.boundingBox();
    expect(box, 'toolbar bounding box').not.toBeNull();
    expect(box!.height).toBeLessThan(80);
    const overflow = await toolbar.evaluate((element) => ({
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);

    // A section menu is portaled and closes on Escape; the disabled Pad row
    // states why it cannot run.
    await toolbar.locator('[role="group"][aria-label="Additive"] .nuke-ribbon-menu-trigger').click();
    const menu = page.locator('.nuke-ribbon-menu');
    await expect(menu).toBeVisible({ timeout: 10_000 });
    const padRow = menu.locator('[role="menuitem"]:has(.codicon-nuke-cad-pad)').first();
    await expect(padRow).toBeDisabled();
    await expect(padRow.locator('.nuke-ribbon-menu-item-reason')).toHaveText('Select a sketch first.');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});

test('Q shortcut bar opens in document mode and closes on Escape', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    // Start from a clean workbench so New CAD Document is enabled.
    await closeAllEditors(page);
    await runCommand(page, 'New CAD Document');
    const viewport = page.locator('.cad-viewport').first();
    await expect(viewport).toBeVisible({ timeout: 30_000 });

    const templatePicker = page.locator('.cad-template-picker').first();
    await expect(templatePicker).toBeVisible({ timeout: 10_000 });
    await templatePicker.locator('button', { hasText: 'Empty document' }).first().click();
    await expect(viewport.locator('.cad-viewport-document-empty')).toBeVisible({ timeout: 10_000 });
    // Overlay chrome mounts only after the controller's cold dynamic import
    // (~20 s fresh); wait for the toolbar before driving overlay UI.
    await expect(viewport.locator('.cad-document-toolbar').first()).toBeVisible({ timeout: 60_000 });

    // Focus the viewport container so the container-scoped Q handler fires.
    await viewport
        .locator('canvas')
        .first()
        .click({ position: { x: 200, y: 200 } });
    await viewport.focus();
    await page.waitForTimeout(100);
    await page.keyboard.press('q');

    const shortcutBar = viewport.locator('.cad-shortcut-bar').first();
    await expect(shortcutBar).toBeVisible({ timeout: 10_000 });
    // Document-mode bar exposes feature creation actions (Pad is disabled without a sketch).
    await expect(shortcutBar.locator('button .codicon-new-file').first()).toBeVisible();
    await expect(shortcutBar.locator('button .codicon-nuke-cad-sketch').first()).toBeVisible();
    const padButton = shortcutBar.locator('button:has(.codicon-nuke-cad-pad)').first();
    await expect(padButton).toBeDisabled();

    await page.keyboard.press('Escape');
    await expect(shortcutBar).toBeHidden();

    const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});

test('Q shortcut bar opens in sketch mode and closes on Escape', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    // Start from a clean workbench so New CAD Document is enabled.
    await closeAllEditors(page);
    await runCommand(page, 'New CAD Document');
    const viewport = page.locator('.cad-viewport').first();
    await expect(viewport).toBeVisible({ timeout: 30_000 });

    const templatePicker = page.locator('.cad-template-picker').first();
    await expect(templatePicker).toBeVisible({ timeout: 10_000 });
    await templatePicker.locator('button', { hasText: 'Empty document' }).first().click();
    await expect(viewport.locator('.cad-viewport-document-empty')).toBeVisible({ timeout: 10_000 });
    // Overlay chrome mounts only after the controller's cold dynamic import
    // (~20 s fresh); wait for the toolbar before driving overlay UI.
    await expect(viewport.locator('.cad-document-toolbar').first()).toBeVisible({ timeout: 60_000 });

    // Start a new sketch on the XY plane.
    await runCommand(page, 'New Sketch');
    const datumPicker = viewport.locator('.cad-sketch-datum-picker').first();
    await expect(datumPicker).toBeVisible({ timeout: 10_000 });
    await datumPicker.locator('button', { hasText: 'Start Sketch' }).first().click();
    await expect(viewport.locator('.cad-sketch-finish-button')).toBeVisible({ timeout: 30_000 });

    // Focus the viewport container and open the sketch shortcut bar.
    await viewport
        .locator('canvas')
        .first()
        .click({ position: { x: 200, y: 200 } });
    await viewport.focus();
    await page.waitForTimeout(100);
    await page.keyboard.press('q');

    const shortcutBar = viewport.locator('.cad-shortcut-bar').first();
    await expect(shortcutBar).toBeVisible({ timeout: 10_000 });
    // Sketch-mode bar exposes the six sketch tools.
    for (const icon of [
        'codicon-nuke-cad-select',
        'codicon-nuke-cad-point',
        'codicon-nuke-cad-line',
        'codicon-nuke-cad-circle',
        'codicon-nuke-cad-arc',
        'codicon-nuke-cad-rectangle'
    ]) {
        await expect(shortcutBar.locator(`button .${icon}`).first()).toBeVisible();
    }

    await page.keyboard.press('Escape');
    await expect(shortcutBar).toBeHidden();

    const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});

test('document toolbar command search runs ribbon actions and opens with /', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    // The pincell fixture has bodies, so body-dependent actions (Fillet) are
    // enabled; the empty document disables them.
    await openFileByQuickOpen(page, 'cad-pincell.nuke-cad');

    const viewport = page.locator('.cad-viewport').first();
    await expect(viewport).toBeVisible({ timeout: 30_000 });
    const toolbar = viewport.locator('.cad-document-toolbar').first();
    await expect(toolbar).toBeVisible({ timeout: 60_000 });

    // Wait for the backend build: the explode slider renders with the
    // tessellation, the banner when the CAD backend is unavailable.
    const errorBanner = viewport.locator('.cad-viewport-error-banner');
    const model = viewport.locator('.cad-viewport-explode input[type=range]');
    await expect(model.or(errorBanner).first()).toBeVisible({ timeout: 120_000 });
    if (await errorBanner.isVisible()) {
        test.skip(true, `CAD backend unavailable: ${(await errorBanner.textContent()) ?? 'build failed'}`);
    }

    const searchButton = toolbar.locator('.cad-document-toolbar-search');
    await expect(searchButton).toBeVisible();
    await expect(searchButton).toHaveAttribute('aria-label', 'Search CAD commands');

    // Button flow: filter the flattened ribbon table, then Enter runs Fillet.
    await searchButton.click();
    const popover = viewport.locator('.cad-command-search-popover');
    await expect(popover).toBeVisible();
    const search = popover.locator('.nuke-search-input-field');
    await expect(search).toBeFocused();

    await search.fill('groove');
    const rows = popover.locator('.cad-command-search-item');
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator('.cad-command-search-label')).toHaveText('Groove');
    await expect(rows.first().locator('.cad-command-search-group')).toHaveText('Additive');

    // A disabled row stays searchable and explains why it cannot run.
    await search.fill('pad');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toBeDisabled();
    await expect(rows.first().locator('.cad-command-search-label')).toHaveText('Pad (extrude add)');
    await expect(rows.first().locator('.cad-command-search-reason')).toHaveText('Select a sketch first.');

    await search.fill('fillet');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toBeEnabled();
    await expect(rows.first().locator('.cad-command-search-label')).toHaveText('Fillet');
    await expect(rows.first().locator('.cad-command-search-group')).toHaveText('Dress-up');
    await popover.screenshot({ path: 'test-results/cad-command-search.png' });

    await search.press('Enter');
    await expect(popover).toBeHidden();
    const dialog = viewport.locator('.nuke-dialog').first();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.nuke-dialog-title')).toHaveText('Fillet');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // `/` opens the same popover in document mode; Escape closes it without
    // running anything.
    await viewport
        .locator('canvas')
        .first()
        .click({ position: { x: 200, y: 200 } });
    await viewport.focus();
    await page.keyboard.press('/');
    await expect(popover).toBeVisible();
    await expect(search).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(page.locator('.nuke-dialog')).toBeHidden();

    const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});

async function openFileByQuickOpen(page: Page, name: string, waitForClose = true): Promise<void> {
    await page.locator('#theia-app-shell').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Control+P');
    const input = page.locator('.quick-input-widget input');
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(name);
    const row = page.locator('.quick-input-widget .monaco-list-row', { hasText: name }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    if (waitForClose) {
        await expect(input).toBeHidden();
    }
}
