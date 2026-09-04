import { test, expect, type Page } from '@playwright/test';
import { collectErrors, waitForWorkbench, openFileByQuickOpen } from './helpers';

/**
 * Viewport right-click context menu and draggable feature dialog smoke.
 *
 * Right-clicking the canvas opens the viewport's own menu (no browser
 * default): on a solid it offers Edit Feature (attributed through the solid's
 * body), the three measure tools, and Fit to Solid; on empty space it offers
 * Fit All and Reset Explode (disabled at 0%). The feature dialog it opens
 * drags by its header and resets on a header double-click, like the sketch
 * chrome panels.
 *
 * The menu only appears once a tessellation is on screen, which requires a
 * working CAD backend. Without one the build fails and the viewport shows its
 * error banner instead — that environment skips (same philosophy as the
 * backend env gates in the Python e2e suite).
 */

test.setTimeout(180_000);

interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

async function rectOf(locator: ReturnType<Page['locator']>): Promise<Rect> {
    const rect = await locator.boundingBox();
    expect(rect).not.toBeNull();
    return rect as Rect;
}

test('right-click context menu and draggable feature dialog', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    await openFileByQuickOpen(page, 'gui_pincell.nuke-cad');

    const viewport = page.locator('.cad-viewport').first();
    const canvas = viewport.locator('canvas').first();
    const errorBanner = viewport.locator('.cad-viewport-error-banner');
    // The canvas element exists before the build finishes; wait for the model
    // (navigation cluster) or the build-failure banner.
    const navCluster = viewport.locator('.cad-viewport-nav');
    await expect(navCluster.or(errorBanner).first()).toBeVisible({ timeout: 120_000 });
    if (await errorBanner.isVisible()) {
        test.skip(true, `CAD backend unavailable: ${(await errorBanner.textContent()) ?? 'build failed'}`);
    }
    await expect(canvas).toBeVisible();
    const box = await rectOf(canvas);
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const menu = viewport.locator('.cad-viewport-context-menu');

    // Solid surface: Edit Feature (attributed), the three measure tools, Fit to Solid.
    await page.mouse.click(center.x, center.y, { button: 'right' });
    await expect(menu).toBeVisible();
    const solidLabels = (await menu.locator('.cad-viewport-context-menu-item').allTextContents()).map((t) => t.trim());
    expect(solidLabels).toEqual(['Edit Feature…', 'Measure Distance', 'Measure Angle', 'Measure Radius', 'Fit to Solid']);
    const editItem = menu.locator('.cad-viewport-context-menu-item', { hasText: 'Edit Feature…' });
    await expect(editItem).toBeEnabled();

    // Measure Distance activates the tool: the status pill takes over the hint.
    await menu.locator('.cad-viewport-context-menu-item', { hasText: 'Measure Distance' }).click();
    await expect(menu).toBeHidden();
    await expect(viewport.locator('.cad-viewport-shading-hint')).toContainText('Measure: click the first point');
    await page.keyboard.press('Escape');
    await expect(viewport.locator('.cad-viewport-shading-hint')).toBeHidden();

    // Escape closed the menu without activating anything.
    await page.mouse.click(center.x, center.y, { button: 'right' });
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    // Empty space: bottom-left corner (clear of the model, toolbar, status pill, and nav cluster).
    await page.mouse.click(box.x + 20, box.y + box.height - 20, { button: 'right' });
    await expect(menu).toBeVisible();
    const emptyLabels = (await menu.locator('.cad-viewport-context-menu-item').allTextContents()).map((t) => t.trim());
    expect(emptyLabels).toEqual(['Fit All', 'Reset Explode']);
    await expect(menu.locator('.cad-viewport-context-menu-item', { hasText: 'Reset Explode' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    // Edit Feature… opens the dialog; drag by the header; double-click resets.
    await page.mouse.click(center.x, center.y, { button: 'right' });
    await expect(menu).toBeVisible();
    await menu.locator('.cad-viewport-context-menu-item', { hasText: 'Edit Feature…' }).click();
    const dialog = viewport.locator('.nuke-dialog');
    await expect(dialog).toBeVisible();
    const header = dialog.locator('.nuke-dialog-header');
    const initial = await rectOf(dialog);
    const handle = await rectOf(header);
    await page.mouse.move(handle.x + 40, handle.y + 8);
    await page.mouse.down();
    await page.mouse.move(handle.x + 160, handle.y + 68, { steps: 6 });
    await page.mouse.up();
    const dragged = await rectOf(dialog);
    expect(Math.abs(dragged.x - initial.x) + Math.abs(dragged.y - initial.y)).toBeGreaterThan(60);
    // The header moved with the dialog: re-locate it before the reset gesture.
    const movedHandle = await rectOf(header);
    await page.mouse.dblclick(movedHandle.x + 40, movedHandle.y + 8);
    const reset = await rectOf(dialog);
    expect(Math.abs(reset.x - initial.x)).toBeLessThan(5);
    expect(Math.abs(reset.y - initial.y)).toBeLessThan(5);
    await dialog.locator('.nuke-dialog-close').click();
    await expect(dialog).toBeHidden();

    const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});
