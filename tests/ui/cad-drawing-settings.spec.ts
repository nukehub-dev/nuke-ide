import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@playwright/test';
import { closeAllEditors, collectErrors, openFileByQuickOpen, runCommand, waitForWorkbench } from './helpers';

/**
 * Drawing Sheet settings: the inspector changes the persisted sheet size and
 * hides dimensions (keeping their list rows) without rebuilding geometry.
 *
 * The committed fixture is copied to a scratch workspace path because the
 * drawing edits auto-save before HLR and must never dirty the source.
 */

test.setTimeout(240_000);

test('sheet size and dimension visibility refresh the drawing without a geometry rebuild', async ({ page }) => {
    const errors = collectErrors(page);
    const fixtureDir = path.join(process.cwd(), 'tests/ui/fixtures');
    const documentPath = path.join(fixtureDir, 'drawing-settings-smoke.nuke-cad');
    fs.copyFileSync(path.join(fixtureDir, 'cad-drawing.nuke-cad'), documentPath);
    const cleanup = (): void => {
        for (const entry of [
            'drawing-settings-smoke.nuke-cad',
            'drawing-settings-smoke.step',
            'drawing-settings-smoke.step.key',
            'drawing-settings-smoke.tess.json',
            'drawing-settings-smoke.nuke-cache.zip'
        ]) {
            fs.rmSync(path.join(fixtureDir, entry), { force: true });
        }
    };
    try {
        await page.goto('/');
        await waitForWorkbench(page);
        await closeAllEditors(page);
        await openFileByQuickOpen(page, 'drawing-settings-smoke.nuke-cad');
        const viewport = page.locator('.cad-viewport').first();
        await expect(viewport).toBeVisible({ timeout: 60_000 });
        const geometryOverlay = viewport.locator('.nuke-loading-overlay');
        await expect(geometryOverlay).toBeHidden({ timeout: 120_000 });
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
        await expect(drawing.locator('.nuke-cad-drawing-svg')).toHaveAttribute('aria-label', 'Drawing sheet Sheet 1');
        await expect(drawing.locator('.nuke-cad-drawing-view')).toHaveCount(1);
        await expect(drawing.locator('.nuke-cad-drawing-dimension-row')).toHaveCount(1);

        const status = drawing.locator('.nuke-cad-drawing-status-build').first();
        const waitForDrawingIdle = async (): Promise<void> => {
            // Let the store-change auto-save/refresh reach `Building…` before
            // polling, so an idle poll cannot match the pre-edit state.
            await page.waitForTimeout(500);
            await expect
                .poll(async () => (await status.textContent().catch(() => ''))?.trim(), { timeout: 180_000 })
                .toMatch(/Up to date|Build failed/);
            await expect(drawing.locator('.nuke-cad-drawing-notice.error')).toHaveCount(0);
            await expect(geometryOverlay).toBeHidden();
        };

        // The public refresh command focuses the sheet and rebuilds only its
        // HLR linework, never the CAD geometry.
        await runCommand(page, 'Refresh Drawing Sheet');
        await expect(drawing.locator('.nuke-cad-drawing-view')).toHaveCount(1);
        await waitForDrawingIdle();
        expect(await drawing.locator('.nuke-cad-drawing-visible').count()).toBeGreaterThan(0);
        await expect(drawing.locator('.nuke-cad-drawing-dimension')).toHaveCount(1);

        const sizeSelect = drawing.getByRole('combobox', { name: 'Sheet size', exact: true });
        await expect(sizeSelect).toHaveText('A4');
        await sizeSelect.click();
        const a3Option = page.locator('.nuke-select-list .nuke-select-option', { hasText: 'A3' }).first();
        await expect(a3Option).toBeVisible();
        await a3Option.click();
        await expect(sizeSelect).toHaveText('A3');
        await expect(drawing.locator('.nuke-cad-drawing-status-sheet')).toContainText('A3');
        await waitForDrawingIdle();
        await expect(geometryOverlay).toBeHidden();

        const dimensionRow = drawing.locator('.nuke-cad-drawing-dimension-row').first();
        await drawing.getByRole('button', { name: 'Hide dimension dim-1' }).click();
        await expect(drawing.locator('.nuke-cad-drawing-dimension')).toHaveCount(0);
        await expect(dimensionRow).toBeVisible();
        await expect(dimensionRow.getByText('hidden', { exact: true })).toBeVisible();
        await expect(drawing.getByRole('button', { name: 'Show dimension dim-1' })).toBeVisible();
        await waitForDrawingIdle();
        await expect(drawing.locator('.nuke-cad-drawing-dimension')).toHaveCount(0);
        await expect(geometryOverlay).toBeHidden();

        await drawing.getByRole('button', { name: 'Show dimension dim-1' }).click();
        await expect(drawing.locator('.nuke-cad-drawing-dimension')).toHaveCount(1);
        await expect(dimensionRow.getByText('hidden', { exact: true })).toHaveCount(0);
        await expect(drawing.getByRole('button', { name: 'Hide dimension dim-1' })).toBeVisible();
        await waitForDrawingIdle();
        await expect(drawing.locator('.nuke-cad-drawing-dimension')).toHaveCount(1);
        await expect(geometryOverlay).toBeHidden();
        await expect(buildBanner).toBeHidden();

        await page.screenshot({ path: 'test-results/cad-drawing-settings.png' });

        const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
        expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
    } finally {
        cleanup();
    }
});
