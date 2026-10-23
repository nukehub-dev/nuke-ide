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
    // document-mode hint should be shown instead.
    await expect(viewport.locator('.nuke-empty-state')).toBeHidden();
    const hint = viewport.locator('.cad-viewport-document-hint').first();
    await expect(hint).toBeVisible({ timeout: 10_000 });

    // The redesigned header toolbar should render with the document title on the
    // left and grouped action buttons on the right.
    // The overlay chrome (toolbar, shortcut bar, datum picker) mounts only
    // after the viewport controller initializes, which awaits a cold dynamic
    // import of the OrbitControls chunk (~20 s on a fresh page load — file
    // flows mask this behind backend-build waits, new-document flows do not).
    const toolbar = page.locator('.cad-document-toolbar').first();
    await expect(toolbar).toBeVisible({ timeout: 60_000 });
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
    await toolbar.screenshot({ path: 'test-results/cad-ribbon-tiles.png' });

    // Narrow the window: the bar must switch to caption menus, not wrap.
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(toolbar.locator('.nuke-ribbon-menus')).toBeVisible({ timeout: 10_000 });
    await expect(toolbar.locator('.nuke-ribbon-section')).toHaveCount(7);
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

    // A section menu is portaled and closes on Escape.
    await toolbar.locator('[role="group"][aria-label="Additive"] .nuke-ribbon-menu-trigger').click();
    const menu = page.locator('.nuke-ribbon-menu');
    await expect(menu).toBeVisible({ timeout: 10_000 });
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
    await expect(viewport.locator('.cad-viewport-document-hint')).toBeVisible({ timeout: 10_000 });
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
    await expect(viewport.locator('.cad-viewport-document-hint')).toBeVisible({ timeout: 10_000 });
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
