import * as fs from 'fs';
import { test, expect, Page, Locator } from '@playwright/test';
import { collectErrors, waitForWorkbench, openFileByQuickOpen, closeAllEditors, runCommand } from './helpers';

/**
 * Generic probe in the native viewer: point sampling and line profiles.
 *
 * Flow: open the committed `volume-slice.vti` fixture (4×4×4 cell grid with
 * flux/std), map `Cell: flux` in Viewer Settings (generic viewers start on
 * Solid Color, where a picked point has no value), then drive the floating
 * probe dialog:
 * - Point tab: arm picking, click the canvas center, read the sample, export CSV.
 * - Line tab: default endpoints span the dataset X axis; run the headless
 *   `base.probe` profile, chart + table + CSV. The backend needs `vtk`, so a
 *   missing-dependency error skips the line half instead of failing.
 *
 * Suite conventions (root AGENTS.md): Theia/lumino selectors only, Command
 * Palette via Ctrl+Shift+P + `>` prefix, zero console severity-error/pageerror
 * gate per test (l10n/INVALID-tab noise filtered like the other specs).
 */

test.setTimeout(180_000);

function severe(errors: string[]): string[] {
    return errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles') && !e.includes('INVALID tab'));
}

async function openViewer(page: Page, name: string) {
    await closeAllEditors(page);
    // Warm the file-search index: the first Quick Open query after server
    // start can take a long time on a repo-sized workspace and times out.
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

/** Open the Viewer Settings sidebar (it binds to the last-active viewer tab). */
async function openViewerSettings(page: Page) {
    await runCommand(page, 'Open Viewer Settings');
    const panel = page.locator('.viewer-settings-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    return panel;
}

/**
 * Pick a NukeSelect option: the dropdown portals to document.body, so the
 * option is located from the page root, not the settings panel.
 */
async function selectNukeOption(page: Page, scope: Locator, hookClass: string, optionName: string) {
    await scope.locator(`.${hookClass} .nuke-select-trigger`).click();
    await page.locator('.nuke-select-list').getByRole('option', { name: optionName }).click();
}

/** `base.probe` imports VTK lazily; without it the line profile reports a dependency error. */
function vtkUnavailable(text: string): boolean {
    return /vtk/i.test(text) || /not installed/i.test(text) || /no module named/i.test(text);
}

test('probe dialog picks a point value and runs an X-axis line profile with CSV exports', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'volume-slice.vti');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    const canvas = container.locator('.openmc-output-viewer-viewarea canvas');

    // Generic viewers start on Solid Color (coordinates only, empty value):
    // map the cell flux array first so picked points read a real value.
    const settings = await openViewerSettings(page);
    await selectNukeOption(page, settings, 'viewer-settings-color-by', 'Cell: flux');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    // Probe trigger lives in the native viewer bottom bar, next to Find Data.
    const probeTrigger = container.locator('.viewer-nav-probe');
    await expect(probeTrigger).toBeVisible();
    await probeTrigger.click();
    const dialog = container.locator('.probe-dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });

    // --- Point tab: arm picking, click the canvas center, read the sample. ---
    await dialog.locator('.probe-pick-toggle').click();
    const box = await canvas.boundingBox();
    if (!box) {
        throw new Error('probe point test needs a laid-out canvas');
    }
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    const rows = dialog.locator('.probe-sample-table tbody tr');
    await expect(rows).toHaveCount(1, { timeout: 30_000 });
    // Row layout is X/Y/Z, active array, value — the value is the trailing cell.
    const valueCell = rows.first().locator('td').last();
    await expect(valueCell).toBeVisible();
    expect((await valueCell.textContent())?.trim() ?? '').not.toBe('');

    // Export CSV downloads the samples following the kinetics-tab pattern.
    const samplesDownload = page.waitForEvent('download');
    await dialog.locator('.probe-export').click();
    const samplesFile = await samplesDownload;
    expect(samplesFile.suggestedFilename()).toMatch(/probe/i);
    const samplesPath = await samplesFile.path();
    expect(samplesPath).toBeTruthy();
    const samplesCsv = await fs.promises.readFile(samplesPath as string, 'utf-8');
    expect(samplesCsv).toMatch(/x\s*,\s*y\s*,\s*z/i);
    expect(samplesCsv).toContain('flux');
    expect(samplesCsv.trim().split('\n').length).toBeGreaterThanOrEqual(2);

    // Disarm picking before leaving the point tab (a later dataset rebuild or
    // dialog close would otherwise leave the canvas click-armed).
    await dialog.locator('.probe-pick-toggle').click();

    // --- Line tab: the default endpoints span the dataset X axis. ---
    await dialog.locator('.probe-tab-line').click();
    await expect(dialog.locator('.probe-array')).toBeVisible();
    await expect(dialog.locator('.probe-start')).toBeVisible();
    await expect(dialog.locator('.probe-end')).toBeVisible();
    await expect(dialog.locator('.probe-samples')).toBeVisible();

    await dialog.locator('.probe-run').click();
    // The profile either renders a Plotly chart or reports an inline error;
    // the latter (VTK missing in the active Python env) skips the line half.
    const chart = dialog.locator('.probe-profile-chart .js-plotly-plot');
    const profileError = dialog.locator('.probe-profile-error');
    await expect.poll(async () => (await chart.isVisible()) || (await profileError.isVisible()), { timeout: 120_000 }).toBe(true);
    if (await profileError.isVisible()) {
        const text = ((await profileError.textContent()) ?? '').trim();
        test.skip(vtkUnavailable(text), `line probe backend unavailable: ${text.slice(0, 200)}`);
        throw new Error(`line probe failed: ${text}`);
    }
    await expect(chart).toBeVisible({ timeout: 30_000 });
    const profileRows = dialog.locator('.probe-profile-table tbody tr');
    await expect(profileRows.first()).toBeVisible({ timeout: 30_000 });
    expect(await profileRows.count()).toBeGreaterThan(0);

    // Export CSV downloads the full profile series.
    const profileDownload = page.waitForEvent('download');
    await dialog.locator('.probe-profile-export').click();
    const profileFile = await profileDownload;
    expect(profileFile.suggestedFilename()).toMatch(/\.csv$/i);
    const profilePath = await profileFile.path();
    expect(profilePath).toBeTruthy();
    const profileCsv = await fs.promises.readFile(profilePath as string, 'utf-8');
    expect(profileCsv).toMatch(/distance/i);
    expect(profileCsv.trim().split('\n').length).toBeGreaterThanOrEqual(2);

    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});
