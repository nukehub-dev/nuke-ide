import { test, expect, Page, Locator } from '@playwright/test';
import { collectErrors, waitForWorkbench, openFileByQuickOpen, closeAllEditors } from './helpers';

/**
 * Analysis surfaces: entropy convergence, contact dose rate, and decay
 * spectra. The statepoint fixture has a real entropy history; the depletion
 * fixture is a real activation result. Contact dose and spectra additionally
 * need OPENMC_CHAIN_FILE (and OpenMC) in the app environment — without it the
 * viewer must render the explanatory empty state instead of hanging.
 */

test.setTimeout(180_000);

function severe(errors: string[]): string[] {
    return errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles') && !e.includes('INVALID tab'));
}

/** Pick a NukeSelect option; the dropdown portals to document.body. */
async function selectNukeOption(page: Page, scope: Locator, optionName: string): Promise<void> {
    await scope.locator('.nuke-select-trigger').click();
    await page.locator('.nuke-select-list').getByRole('option', { name: optionName }).click();
}

/** Wait for a chart or the explanatory empty state, whichever the backend yields. */
async function waitForChartOrEmpty(scope: Locator): Promise<'chart' | 'empty'> {
    const chart = scope.locator('.js-plotly-plot').first();
    const empty = scope.locator('.nuke-empty-state').first();
    await expect.poll(async () => (await chart.isVisible()) || (await empty.isVisible()), { timeout: 90_000 }).toBe(true);
    return (await chart.isVisible()) ? 'chart' : 'empty';
}

test('entropy tab plots the convergence history and inactive-batch marker', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);
    await closeAllEditors(page);
    await openFileByQuickOpen(page, 'statepoint.6.h5');

    const viewer = page.locator('.statepoint-viewer').first();
    await expect(viewer).toBeVisible({ timeout: 60_000 });
    if ((await viewer.getAttribute('class'))?.includes('statepoint-viewer--empty')) {
        test.skip(true, 'statepoint backend unavailable');
    }

    await viewer.locator('.tabs .tab', { hasText: 'Entropy' }).click();
    await expect(viewer.locator('.entropy-tab')).toBeVisible();
    await expect(viewer.locator('.entropy-toolbar')).toBeVisible();
    await expect(viewer.locator('.entropy-mode', { hasText: 'Shannon entropy' })).toBeVisible();
    await expect(viewer.locator('.entropy-marker-note')).toContainText('Active batches start after batch 2');
    await expect(viewer.locator('.entropy-summary')).toContainText('bits');
    await expect(viewer.locator('.entropy-chart .js-plotly-plot')).toBeVisible({ timeout: 30_000 });

    expect(severe(errors), `console/page errors in entropy tab:\n${errors.join('\n')}`).toEqual([]);
});

test('entropy tab explains a missing entropy mesh', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);
    await closeAllEditors(page);
    await openFileByQuickOpen(page, 'statepoint.10.h5');

    const viewer = page.locator('.statepoint-viewer').first();
    await expect(viewer).toBeVisible({ timeout: 60_000 });
    if ((await viewer.getAttribute('class'))?.includes('statepoint-viewer--empty')) {
        test.skip(true, 'statepoint backend unavailable');
    }

    await viewer.locator('.tabs .tab', { hasText: 'Entropy' }).click();
    await expect(viewer.locator('.nuke-empty-state')).toContainText('No entropy mesh');
    await expect(viewer.locator('.nuke-empty-state')).toContainText('Simulation');

    expect(severe(errors), `console/page errors in entropy empty state:\n${errors.join('\n')}`).toEqual([]);
});

test('depletion contact-dose and decay-spectrum controls work', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);
    await closeAllEditors(page);
    await openFileByQuickOpen(page, 'depletion_results.h5');

    const viewer = page.locator('.openmc-depletion-viewer').first();
    await expect(viewer).toBeVisible({ timeout: 60_000 });
    await expect
        .poll(
            async () =>
                (await viewer
                    .locator('.depletion-header')
                    .isVisible()
                    .catch(() => false)) ||
                (await viewer
                    .locator('.nuke-empty-state')
                    .isVisible()
                    .catch(() => false)),
            { timeout: 60_000 }
        )
        .toBe(true);
    if (
        !(await viewer
            .locator('.depletion-header')
            .isVisible()
            .catch(() => false))
    ) {
        test.skip(true, 'depletion backend unavailable');
    }

    const plotSelect = viewer.locator('.depletion-toolbar-plot');
    await selectNukeOption(page, plotSelect, 'Contact dose rate (absorbed-air, Gy/h)');
    await expect(viewer.locator('.depletion-number-input')).toBeVisible();
    await expect(viewer.locator('.depletion-toolbar-group', { hasText: 'By nuclide' }).locator('input[type="checkbox"]')).toBeVisible();

    let state = await waitForChartOrEmpty(viewer);
    if (state === 'chart') {
        await expect(viewer.locator('.depletion-analysis-summary')).toContainText('Final dose rate');
        await expect(viewer.locator('.depletion-caveat')).toContainText('Bremsstrahlung');
    } else {
        await expect(viewer.locator('.depletion-analysis-empty')).toContainText('chain');
    }

    // The build-up control is a real input; changing it reloads or keeps the
    // explanatory empty state without console errors.
    const buildUp = viewer.locator('.depletion-number-input');
    await buildUp.fill('3');
    await buildUp.blur();

    // By-nuclide is a real toggle: a chart with data gets the table.
    const byNuclide = viewer.locator('.depletion-toolbar-group', { hasText: 'By nuclide' }).locator('input[type="checkbox"]');
    await byNuclide.check();
    if (state === 'chart') {
        await expect(viewer.locator('.depletion-table-card')).toBeVisible({ timeout: 60_000 });
        await expect(viewer.locator('.depletion-table')).toContainText('Nuclide');
    }
    await byNuclide.uncheck();

    // Effective dose uses the same chart/toolbar with the Sv/h label.
    await selectNukeOption(page, plotSelect, 'Contact dose rate (effective, Sv/h)');
    state = await waitForChartOrEmpty(viewer);
    if (state === 'chart') {
        await expect(viewer.locator('.depletion-analysis-summary')).toContainText('Sv/h');
    }

    // Decay spectrum: step selector + log (default) + CSV export.
    await selectNukeOption(page, plotSelect, 'Decay photon spectrum');
    await expect(viewer.locator('.depletion-toolbar-group', { hasText: 'Step' })).toBeVisible();
    await expect(viewer.locator('.depletion-scale-toggle input')).toBeChecked();
    state = await waitForChartOrEmpty(viewer);
    if (state === 'chart') {
        await expect(viewer.locator('.depletion-analysis-summary')).toContainText('Total activity');
        await expect(viewer.locator('.depletion-toolbar-actions button')).toBeEnabled();
        await expect(viewer.locator('.depletion-analysis-pane')).toContainText('photons');
        await viewer.locator('.depletion-scale-toggle input').uncheck();
        await expect(viewer.locator('.depletion-scale-toggle input')).not.toBeChecked();
        await viewer.locator('.depletion-scale-toggle input').check();
    } else {
        await expect(viewer.locator('.depletion-analysis-empty')).toContainText('chain');
    }

    // Narrow panel: toolbar wraps and stays interactive.
    await page.setViewportSize({ width: 640, height: 900 });
    await expect(viewer.locator('.depletion-chart-toolbar')).toBeVisible();
    await expect(viewer.locator('.depletion-header')).toBeVisible();

    expect(severe(errors), `console/page errors in depletion analysis:\n${errors.join('\n')}`).toEqual([]);
});
