import { test, expect, Page, Locator } from '@playwright/test';
import { collectErrors, waitForWorkbench, openFileByQuickOpen, closeAllEditors, runCommand } from './helpers';

/**
 * Bivariate (mean + relative error) tally rendering.
 *
 * The committed `tally-bivariate.vti` is a 2×2×2 image grid whose cell data
 * carries `flux-mean`, `flux-std`, and `flux-rel-err` (finite, non-zero).
 * Workbook flow: open the fixture, color by the mean cell array, enable the
 * Viewer Settings Uncertainty section, edit the channel, then verify a bare
 * `-std` array (no mean pair) hides the section again. Zero console errors.
 */

test.setTimeout(180_000);

function severe(errors: string[]): string[] {
    return errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles') && !e.includes('INVALID tab'));
}

async function openViewer(page: Page, name: string) {
    await closeAllEditors(page);
    // Warm the file-search index: the first Quick Open query after server
    // start can be slow on a repo-sized workspace.
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

/** Pick a NukeSelect option (the portal list lives under document.body). */
async function selectNukeOption(page: Page, scope: Locator, hookClass: string, optionName: string) {
    await scope.locator(`.${hookClass} .nuke-select-trigger`).click();
    await page.locator('.nuke-select-list').getByRole('option', { name: optionName }).click();
}

test('uncertainty section pairs flux-mean with rel-err and edits live', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'tally-bivariate.vti');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    const settings = await openViewerSettings(page);

    // The mean cell array names its companion via the `-rel-err` suffix.
    await selectNukeOption(page, settings, 'viewer-settings-color-by', 'Cell: flux-mean');
    const toggle = settings.locator('.viewer-settings-bivariate');
    await expect(toggle).toBeVisible({ timeout: 30_000 });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    // Disabled: the section exists, the editor stays collapsed.
    await expect(settings.locator('.uncertainty-editor')).toHaveCount(0);
    await expect(settings.locator('.viewer-settings-uncertainty-note')).toContainText('mean-only');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    const editor = settings.locator('.uncertainty-editor');
    await expect(editor).toBeVisible();
    await expect(editor.locator('.uncertainty-editor-legend-swatch')).toHaveCount(11);
    await expect(editor.locator('.uncertainty-editor-channel .nuke-select-trigger')).toHaveText('Opacity');

    // Channel edits apply through the settings patch without a reload.
    await selectNukeOption(page, editor, 'uncertainty-editor-channel', 'Desaturate');
    await expect(editor.locator('.uncertainty-editor-channel .nuke-select-trigger')).toHaveText('Desaturate');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    await expect(container.locator('.openmc-output-viewer-viewarea canvas')).toBeVisible();

    // A bare std array has no mean pair, so the section hides instead of
    // guessing `flux-std` + anything.
    await selectNukeOption(page, settings, 'viewer-settings-color-by', 'Cell: flux-std');
    await expect(settings.locator('.viewer-settings-bivariate')).toHaveCount(0);

    // Returning to the mean restores the section and keeps the switch on.
    await selectNukeOption(page, settings, 'viewer-settings-color-by', 'Cell: flux-mean');
    await expect(settings.locator('.viewer-settings-bivariate')).toHaveAttribute('aria-checked', 'true');
    await expect(settings.locator('.uncertainty-editor')).toBeVisible();

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});
