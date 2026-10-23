import { test, expect } from '@playwright/test';
import { closeAllEditors, collectErrors, runCommand, waitForWorkbench } from './helpers';

/**
 * Sketch right-click menu: empty-canvas actions, selection-aware constraints
 * and dimensions, and the unsaved dot clearing the Finish Sketch pill.
 * Runs at 1280 px so the top-right chrome has its production spacing.
 */

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(180_000);

test('sketch context menu is selection-aware and the dirty dot clears Finish Sketch', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    await closeAllEditors(page);
    await runCommand(page, 'New CAD Document');
    const viewport = page.locator('.cad-viewport').first();
    await expect(viewport).toBeVisible({ timeout: 30_000 });

    const templatePicker = page.locator('.cad-template-picker').first();
    await expect(templatePicker).toBeVisible({ timeout: 10_000 });
    await templatePicker.locator('button', { hasText: 'Empty document' }).first().click();
    await expect(viewport.locator('.cad-viewport-document-empty')).toBeVisible({ timeout: 10_000 });
    await expect(viewport.locator('.cad-document-toolbar').first()).toBeVisible({ timeout: 60_000 });

    await runCommand(page, 'New Sketch');
    const datumPicker = viewport.locator('.cad-sketch-datum-picker').first();
    await expect(datumPicker).toBeVisible({ timeout: 10_000 });
    await datumPicker.locator('button', { hasText: 'Start Sketch' }).first().click();
    const finish = viewport.locator('.cad-sketch-finish-button');
    await expect(finish).toBeVisible({ timeout: 30_000 });

    // The unsaved dot lives inside the Finish Sketch anchor, immediately left
    // of the pill and clear of the centered constraint bar at every width.
    const dirtyDot = viewport.locator('.cad-sketch-finish-dirty');
    const constraintBar = viewport.locator('.cad-sketch-constraint-bar').first();
    await expect(dirtyDot).toBeVisible();
    const assertDotClear = async (): Promise<void> => {
        const [dot, pill, bar] = await Promise.all([dirtyDot.boundingBox(), finish.boundingBox(), constraintBar.boundingBox()]);
        expect(dot, 'dirty marker has no bounding box').not.toBeNull();
        expect(pill, 'finish button has no bounding box').not.toBeNull();
        expect(bar, 'constraint bar has no bounding box').not.toBeNull();
        expect(dot!.x + dot!.width).toBeLessThanOrEqual(pill!.x);
        expect(dot!.x).toBeGreaterThanOrEqual(bar!.x + bar!.width);
    };
    await assertDotClear();

    const viewportBox = await viewport.boundingBox();
    expect(viewportBox, 'viewport has no bounding box').not.toBeNull();
    const click = async (x: number, y: number, button: 'left' | 'right' = 'left'): Promise<void> => {
        await page.mouse.click(viewportBox!.x + x, viewportBox!.y + y, { button });
    };

    // Empty canvas: fit/grid/finish actions, dismissed with Escape.
    await click(700, 420, 'right');
    const menu = page.locator('.cad-sketch-context-menu').first();
    const menuItem = (label: string) => menu.locator('.cad-viewport-context-menu-item').filter({ hasText: label });
    await expect(menu).toBeVisible();
    for (const label of ['Fit Sketch', 'Hide Grid', 'Finish Sketch']) {
        await expect(menu.locator('.cad-viewport-context-menu-label').filter({ hasText: label })).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    // Draw a horizontal line, then select it and open the entity menu.
    const toolbar = viewport.locator('.cad-sketch-toolbar').first();
    await toolbar.locator('button:has(.codicon-nuke-cad-line)').click();
    await click(430, 420);
    await click(760, 420);
    await toolbar.locator('button:has(.codicon-nuke-cad-select)').click();
    await click(595, 420);

    await click(595, 420, 'right');
    await expect(menu).toBeVisible();
    for (const label of ['Horizontal', 'Vertical', 'Add Length Dimension…', 'Make Construction', 'Delete', 'Clear Selection']) {
        await expect(menu.locator('.cad-viewport-context-menu-label').filter({ hasText: label })).toBeVisible();
    }
    await expect(menu.locator('.cad-viewport-context-menu-label').filter({ hasText: 'Coincident' })).toHaveCount(0);
    await page.screenshot({ path: 'test-results/cad-sketch-context-menu.png' });

    // Construction toggling round-trips through the selection's current state.
    await menuItem('Make Construction').click();
    await click(595, 420, 'right');
    await expect(menu.locator('.cad-viewport-context-menu-label').filter({ hasText: 'Make Normal' })).toBeVisible();
    await menuItem('Make Normal').click();
    await click(595, 420, 'right');
    await expect(menuItem('Add Length Dimension…')).toBeVisible();

    // The value action seeds the existing value box with the line endpoints.
    await menuItem('Add Length Dimension…').click();
    const valueInput = viewport.locator('.cad-sketch-value-input input').first();
    await expect(valueInput).toBeVisible();
    await valueInput.fill('20');
    await valueInput.press('Enter');
    await expect(valueInput).toBeHidden();
    await page.waitForTimeout(500);

    // The dot survives the edit and still clears both pieces of top chrome,
    // including when the constraint bar is forced into its narrow layout.
    await expect(dirtyDot).toBeVisible();
    await assertDotClear();
    await page.setViewportSize({ width: 760, height: 800 });
    await page.waitForTimeout(300);
    await assertDotClear();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'test-results/cad-sketch-context-menu-dimension.png' });

    const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});
