import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@playwright/test';
import { closeAllEditors, collectErrors, openFileByQuickOpen, runCommand, waitForWorkbench } from './helpers';

/**
 * Drawing Sheet workspace smoke: the start card creates a framed sheet, the
 * HLR linework lands, and the inspector/canvas controls stay wired.
 *
 * The pincell fixture is copied to a gitignored test-results path so the
 * drawing edits (which auto-save before HLR) never dirty the committed
 * fixture. The CAD build must succeed, so the test skips when the backend is
 * unavailable rather than failing on environment setup.
 */

test.setTimeout(240_000);

test('drawing sheet workspace creates, builds, and exposes canvas controls', async ({ page }) => {
    const errors = collectErrors(page);
    const fixtureDir = path.join(process.cwd(), 'tests/ui/fixtures');
    const documentPath = path.join(fixtureDir, 'drawing-sheet-smoke.nuke-cad');
    fs.copyFileSync(path.join(process.cwd(), 'tests/ui/fixtures/cad-pincell.nuke-cad'), documentPath);
    const cleanup = (): void => {
        for (const entry of [
            'drawing-sheet-smoke.nuke-cad',
            'drawing-sheet-smoke.step',
            'drawing-sheet-smoke.step.key',
            'drawing-sheet-smoke.tess.json',
            'drawing-sheet-smoke.nuke-cache.zip'
        ]) {
            fs.rmSync(path.join(fixtureDir, entry), { force: true });
        }
    };
    try {
        await page.goto('/');
        await waitForWorkbench(page);
        await closeAllEditors(page);
        await openFileByQuickOpen(page, 'drawing-sheet-smoke.nuke-cad');
        const viewport = page.locator('.cad-viewport').first();
        await expect(viewport).toBeVisible({ timeout: 60_000 });
        await expect(viewport.locator('.nuke-loading-overlay')).toBeHidden({ timeout: 120_000 });
        const buildBanner = viewport.locator('.cad-viewport-error-banner');
        if (await buildBanner.isVisible()) {
            const text = ((await buildBanner.textContent()) ?? '').trim();
            if (/install|missing|not installed|unavailable|environment|python/i.test(text)) {
                test.skip(true, `CAD backend unavailable: ${text.slice(0, 200)}`);
            }
            expect(buildBanner, `CAD build failed: ${text}`).toBeHidden();
        }
        await expect(viewport.locator('.cad-viewport-explode input[type=range]').first()).toBeVisible({ timeout: 120_000 });

        await runCommand(page, 'Open Drawing Sheet');
        const drawing = page.locator('.nuke-cad-drawing-root').first();
        await expect(drawing).toBeVisible({ timeout: 30_000 });
        const startCard = drawing.locator('.nuke-cad-drawing-start-card').first();
        await expect(startCard).toBeVisible();
        await startCard.locator('button', { hasText: 'Front' }).first().click();

        const status = drawing.locator('.nuke-cad-drawing-status-build').first();
        await expect
            .poll(async () => (await status.textContent().catch(() => ''))?.trim(), { timeout: 180_000 })
            .toMatch(/Up to date|Build failed/);
        await expect(drawing.locator('.nuke-cad-drawing-notice.error')).toHaveCount(0);
        expect(await drawing.locator('.nuke-cad-drawing-visible').count()).toBeGreaterThan(0);

        await drawing.locator('.nuke-cad-drawing-view-row-main').first().click();
        const selected = drawing.locator('.nuke-section', { hasText: 'Selected view' }).first();
        await expect(selected).toBeVisible();
        await expect(selected.getByRole('button', { name: 'Fit' })).toBeVisible();
        await expect(selected.getByRole('checkbox', { name: 'Show hidden lines' })).toBeVisible();

        const grid = drawing.getByRole('button', { name: 'Toggle grid' });
        await expect(grid).toHaveAttribute('aria-pressed', 'true');
        await expect(grid).not.toHaveClass(/secondary/);
        await grid.click();
        await expect(grid).toHaveAttribute('aria-pressed', 'false');
        await expect(grid).toHaveClass(/secondary/);
        await grid.click();

        const zoomLabel = drawing.locator('.nuke-cad-drawing-zoom-label');
        await expect(zoomLabel).toHaveText('100%');
        await drawing.getByRole('button', { name: 'Zoom in' }).click();
        await expect(zoomLabel).toHaveText('115%');
        await zoomLabel.click();
        await expect(zoomLabel).toHaveText('100%');

        await expect(drawing.getByRole('button', { name: 'Save' })).toBeVisible();
        await expect(drawing.getByRole('button', { name: 'SVG' })).toBeVisible();
        await expect(drawing.getByRole('button', { name: 'DXF' })).toBeVisible();
        await page.screenshot({ path: 'test-results/cad-drawing-sheet.png' });

        const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
        expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
    } finally {
        cleanup();
    }
});
