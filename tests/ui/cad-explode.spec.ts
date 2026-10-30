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
    // PNG bytes differ under any pixel change (compression amplifies), so
    // decode both in-page (browser-native, zero deps) and count pixels
    // whose channels actually differ. Dimensions are clamped to the common
    // area; a resize mid-test would show up as a huge diff, not silence.
    const counts = await page.evaluate(
        ([a64, b64]: [string, string]) => {
            const load = (b64: string): Promise<ImageBitmap> =>
                fetch(`data:image/png;base64,${b64}`)
                    .then((r) => r.blob())
                    .then((b) => createImageBitmap(b));
            const diffOf = (x: Uint8ClampedArray, y: Uint8ClampedArray): number => {
                let n = 0;
                for (let i = 0; i < x.length; i += 4) {
                    if (Math.abs(x[i] - y[i]) > 2 || Math.abs(x[i + 1] - y[i + 1]) > 2 || Math.abs(x[i + 2] - y[i + 2]) > 2) {
                        n++;
                    }
                }
                return n;
            };
            return load(a64).then((a) =>
                load(b64).then((b) => {
                    const w = Math.min(a.width, b.width);
                    const h = Math.min(a.height, b.height);
                    const cv = document.createElement('canvas');
                    cv.width = w;
                    cv.height = h;
                    const cx = cv.getContext('2d')!;
                    cx.drawImage(a, 0, 0);
                    const da = cx.getImageData(0, 0, w, h).data;
                    cx.clearRect(0, 0, w, h);
                    cx.drawImage(b, 0, 0);
                    const db = cx.getImageData(0, 0, w, h).data;
                    return { diff: diffOf(da, db), total: w * h };
                })
            );
        },
        [before.toString('base64'), reassembled.toString('base64')] as [string, string]
    );
    const { diff: diffPixels, total: totalPixels } = counts;
    // Pixel allowance covers headless-renderer noise; a structural
    // misplacement moves tens of thousands of pixels.
    console.log(`explode reassemble: ${diffPixels}/${totalPixels} pixels differ`);
    expect(diffPixels / totalPixels).toBeLessThan(0.0005);

    const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});
