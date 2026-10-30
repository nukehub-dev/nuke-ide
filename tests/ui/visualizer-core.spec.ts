import { test, expect, Page } from '@playwright/test';
import { collectErrors, waitForWorkbench, openFileByQuickOpen, closeAllEditors, runCommand } from './helpers';

/**
 * Native-viewer chrome: volume transfer function, orthoslice preview,
 * clip caps, dataset inspector, and the screenshot export menu.
 *
 * Uses the committed `volume-slice.vti` (4×4×4 cell grid with flux/std) and
 * `capped-cube.vtu` (closed unit cube). No backend conversion needed.
 */

test.setTimeout(180_000);

function severe(errors: string[]): string[] {
    return errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles') && !e.includes('INVALID tab'));
}

async function openViewer(page: Page, name: string) {
    await closeAllEditors(page);
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
    await expect(container.locator('.openmc-output-viewer-viewarea canvas')).toBeVisible({ timeout: 30_000 });
    return container;
}

async function openViewerSettings(page: Page) {
    await runCommand(page, 'Open Viewer Settings');
    const panel = page.locator('.viewer-settings-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    return panel;
}

test('volume section offers smooth, blend, shade, and opacity stops', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'volume-slice.vti');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    const settings = await openViewerSettings(page);

    const smooth = settings.locator('.viewer-settings-volume-smooth');
    await expect(smooth).toBeVisible({ timeout: 30_000 });
    await smooth.click();
    await expect(settings.locator('.viewer-settings-volume-shade')).toBeVisible();
    await expect(settings.locator('.viewer-settings-volume-blend')).toBeVisible();
    await expect(settings.locator('.viewer-settings-volume-stop').first()).toBeVisible();

    // Blend/shade and an opacity point edit apply without a reload.
    await settings.locator('.viewer-settings-volume-shade').click();
    const alpha = settings.locator('.viewer-settings-volume-stop-alpha').first();
    await expect(alpha).toBeVisible();
    await alpha.focus();
    await alpha.press('ArrowRight');
    await expect(container.locator('.openmc-output-viewer-viewarea canvas')).toBeVisible();
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('slice section renders a grid preview and switches axes', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'volume-slice.vti');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    const settings = await openViewerSettings(page);

    await expect(settings.locator('.slice-preview-canvas')).toBeVisible({ timeout: 30_000 });
    await settings.locator('.viewer-settings-slice-tabs').getByRole('button', { name: 'Y', exact: true }).click();
    await expect(settings.locator('.slice-preview-canvas')).toBeVisible();
    await expect(settings.locator('.viewer-settings-slice-smooth')).toBeVisible();
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('clip caps switch appears for closed triangle meshes', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'capped-cube.vtu');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    const settings = await openViewerSettings(page);

    const caps = settings.locator('.viewer-settings-clip-caps');
    await expect(caps).toBeVisible({ timeout: 30_000 });
    // Enable a clip plane through the master switch, then toggle caps off/on.
    await settings.locator('.viewer-settings-clip-master').click();
    await expect(caps).toBeVisible();
    await caps.click();
    await caps.click();
    await expect(container.locator('.openmc-output-viewer-viewarea canvas')).toBeVisible();
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('dataset inspector lists arrays and rows for the active viewer', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'volume-slice.vti');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    await container.locator('.viewer-nav-dataset-inspector').click();
    const panel = page.locator('.dataset-inspector-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel).toContainText('Arrays');
    await expect(panel).toContainText('flux');
    await expect(panel).toContainText('Statistics');
    await expect(panel.locator('.dataset-inspector-table-row, .dataset-inspector-row').first()).toBeVisible({ timeout: 30_000 });

    const table = panel.locator('.dataset-inspector-table');
    await expect(table.locator('thead th').first()).toHaveText('#');
    const firstRow = table.locator('tbody tr').first();
    await expect(firstRow.locator('th').first()).toHaveClass(/dataset-inspector-row-number/);
    await expect(firstRow.locator('th.dataset-inspector-row-number')).toHaveText('1');

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('dataset inspector aggregates DAGMC volume blocks', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'native-volumes.vtm');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    await container.locator('.viewer-nav-dataset-inspector').click();
    const panel = page.locator('.dataset-inspector-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('.dataset-inspector-title')).toContainText('native-volumes.vtm');

    // Both one-triangle blocks aggregate into one logical polydata dataset.
    await expect(panel.locator('.dataset-inspector-row').filter({ hasText: 'Kind' }).locator('.dataset-inspector-value')).toHaveText(
        'PolyData'
    );
    await expect(panel.locator('.dataset-inspector-row').filter({ hasText: 'Points' }).locator('.dataset-inspector-value')).toHaveText('6');
    await expect(panel.locator('.dataset-inspector-row').filter({ hasText: 'Cells' }).locator('.dataset-inspector-value')).toHaveText('2');

    // The shared volume_id cell array is one catalogue entry with both tuples,
    // and the table pages across the block boundary.
    const volumeRows = panel.locator('.dataset-inspector-array-row').filter({ hasText: 'volume_id' });
    await expect(volumeRows).toHaveCount(1);
    await expect(volumeRows).toContainText('2 tuples');
    await expect(panel.locator('.dataset-inspector-table-status')).toContainText('Showing 2 of 2 rows');
    await expect(panel.locator('.dataset-inspector-table thead')).toContainText('volume_id');
    await expect(panel.locator('.dataset-inspector-table tbody tr')).toHaveCount(2);

    const table = panel.locator('.dataset-inspector-table');
    await expect(table.locator('thead th').first()).toHaveText('#');
    const firstRow = table.locator('tbody tr').first();
    await expect(firstRow.locator('th').first()).toHaveClass(/dataset-inspector-row-number/);
    await expect(firstRow.locator('th.dataset-inspector-row-number')).toHaveText('1');

    await expect(panel).toContainText('Statistics');
    await expect(panel).toContainText('Integral (area)');

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('screenshot export menu downloads a selected format', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'volume-slice.vti');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    await expect(container.locator('.viewer-quality-trigger')).toBeVisible();

    await container.locator('.viewer-export-trigger').click();
    const popover = page.locator('.viewer-export-popover');
    await expect(popover).toBeVisible({ timeout: 30_000 });
    await expect(popover.locator('.viewer-export-data-csv')).toBeVisible();
    await expect(popover.locator('.viewer-export-data-vtk')).toBeVisible();
    const download = page.waitForEvent('download', { timeout: 30_000 });
    await popover.locator('.viewer-export-export').click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.png$/);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});
