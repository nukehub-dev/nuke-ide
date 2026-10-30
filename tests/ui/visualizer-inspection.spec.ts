import { test, expect, Page } from '@playwright/test';
import { collectErrors, waitForWorkbench, openFileByQuickOpen, closeAllEditors, runCommand } from './helpers';

/** Viewer inspection chrome: Find Data, axes grid, and saved viewer state. */

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

test('Find Data selects matching tuples and clears the highlight', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'volume-slice.vti');
    await container.locator('.viewer-nav-find-data').click();
    const dialog = page.locator('.find-data-dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.locator('.find-data-dialog-query').fill('value > 5');
    await expect(dialog.locator('.find-data-dialog-count')).toContainText('of 64', { timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Select', exact: true }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('axes grid toggles its projected labels', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'volume-slice.vti');
    const settings = await openViewerSettings(page);
    const grid = settings.locator('.viewer-settings-axes-grid');
    await expect(grid).toBeVisible({ timeout: 30_000 });
    await grid.click();
    await expect(page.locator('.axes-grid-overlay').first()).toBeVisible({ timeout: 30_000 });
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('save and restore view state', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'volume-slice.vti');
    const settings = await openViewerSettings(page);
    await settings.locator('.viewer-settings-save-view').click();
    const restore = settings.locator('.viewer-settings-restore-view');
    await expect(restore).toBeEnabled({ timeout: 30_000 });
    await restore.click();
    await expect(container.locator('.openmc-output-viewer-viewarea canvas')).toBeVisible();
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});
