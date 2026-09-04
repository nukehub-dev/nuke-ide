import { test, expect } from '@playwright/test';
import { collectErrors, waitForWorkbench, openFileByQuickOpen } from './helpers';

/**
 * Explode-view smoke: opening a document model shows the explode slider in the
 * viewport navigation cluster; moving the slider re-renders the canvas with
 * the solids displaced, and returning to 0 restores the assembled view.
 *
 * The slider only renders once a tessellation is on screen, which requires a
 * working CAD backend. Without one the build fails and the viewport shows its
 * error banner instead — that environment skips (same philosophy as the
 * backend env gates in the Python e2e suite).
 */

test.setTimeout(180_000);

test('explode slider displaces solids and reassembles at zero', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    await openFileByQuickOpen(page, 'gui_pincell.nuke-cad');

    const viewport = page.locator('.cad-viewport').first();
    const slider = viewport.locator('.cad-viewport-explode input[type=range]').first();
    const errorBanner = viewport.locator('.cad-viewport-error-banner');
    await expect(slider.or(errorBanner).first()).toBeVisible({ timeout: 120_000 });
    if (await errorBanner.isVisible()) {
        test.skip(true, `CAD backend unavailable: ${(await errorBanner.textContent()) ?? 'build failed'}`);
    }

    // Drive the real slider with the keyboard: End = 100%. Solids move, so
    // the raster must change.
    const before = await viewport.screenshot();
    await slider.focus();
    await page.keyboard.press('End');
    await expect(viewport.locator('.cad-viewport-explode-value')).toHaveText('100%');
    await page.waitForTimeout(250);
    const exploded = await viewport.screenshot();
    expect(exploded.equals(before), 'exploded view must re-render the canvas').toBe(false);

    // Back to zero (Home): the assembled model renders identically again.
    await page.keyboard.press('Home');
    await expect(viewport.locator('.cad-viewport-explode-value')).toHaveText('0%');
    await page.waitForTimeout(250);
    const reassembled = await viewport.screenshot();
    expect(reassembled.equals(exploded), 'reassembling must re-render the canvas').toBe(false);
    expect(reassembled.equals(before), 'factor 0 restores the assembled view').toBe(true);

    const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});
