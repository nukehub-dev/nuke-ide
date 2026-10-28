import { test, expect, Page, Locator } from '@playwright/test';
import { collectErrors, waitForWorkbench, openFileByQuickOpen, closeAllEditors } from './helpers';

/**
 * Tally series: one tally score across the depletion history.
 *
 * Flow: open the committed `statepoint.20.h5` fixture (sibling of the
 * committed `statepoint.10.h5` fixture) directly — the opener claims
 * `statepoint*.h5` — → Tallies tab → the series button on the first tally
 * card opens the tally-series widget, which runs the headless
 * `openmc.tally-series` command over the sibling statepoints. A missing
 * backend (h5py) renders `.tally-series-error` and the test skips instead of
 * failing; a healthy backend renders the Plotly chart, the two-step slider,
 * and the "Open 3D at this step" action into the native tally viewer.
 *
 * Suite conventions (root AGENTS.md): Theia/lumino selectors only, Command
 * Palette via Ctrl+Shift+P + `>` prefix, zero console severity-error/pageerror
 * gate per test.
 */

test.setTimeout(180_000);

function severe(errors: string[]): string[] {
    return errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles') && !e.includes('INVALID tab'));
}

/** Open the two-statepoint fixture directly (the opener claims `statepoint*.h5`); skip when the backend is missing. */
async function openStatepointViewer(page: Page): Promise<Locator> {
    await closeAllEditors(page);
    await page.locator('#theia-app-shell').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Control+P');
    const warm = page.locator('.quick-input-widget input');
    await expect(warm).toBeVisible({ timeout: 10_000 });
    await warm.fill('fixtures');
    await expect(page.locator('.quick-input-widget .monaco-list-row').first()).toBeVisible({ timeout: 120_000 });
    await page.keyboard.press('Escape');
    await openFileByQuickOpen(page, 'statepoint.20.h5');
    const viewer = page.locator('.statepoint-viewer').first();
    await expect(viewer).toBeVisible({ timeout: 60_000 });
    if ((await viewer.getAttribute('class'))?.includes('statepoint-viewer--empty')) {
        test.skip(true, 'statepoint backend unavailable (empty statepoint viewer)');
    }
    return viewer;
}

test('tally card series charts the score across statepoints and opens 3D at a step', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const viewer = await openStatepointViewer(page);
    await viewer.locator('.tabs .tab', { hasText: 'Tallies' }).click();
    const card = viewer.locator('.tally-card').first();
    await expect(card).toBeVisible({ timeout: 30_000 });

    // Every tally card carries the series action, not only mesh tallies.
    await card.locator('.tally-card-btn--series').click();
    const widget = page.locator('.tally-series-widget').first();
    await expect(widget).toBeVisible({ timeout: 60_000 });

    // The widget either renders the chart or reports a backend error; the
    // latter (h5py missing) skips instead of timing out on the chart.
    const chart = widget.locator('.tally-series-chart .js-plotly-plot');
    const error = widget.locator('.tally-series-error');
    await expect.poll(async () => (await chart.isVisible()) || (await error.isVisible()), { timeout: 60_000 }).toBe(true);
    if (await error.isVisible()) {
        test.skip(true, `tally series backend unavailable: ${((await error.textContent()) ?? '').trim().slice(0, 200)}`);
    }
    await expect(chart).toBeVisible({ timeout: 60_000 });

    // Two sibling statepoints (10, 20) → two steps, starting at the first.
    await expect(widget.locator('.tally-series-slider')).toBeVisible();
    await expect(widget.locator('.tally-series-step-label')).toContainText('Step 1 of 2');
    await widget.getByRole('button', { name: 'Next step' }).click();
    await expect(widget.locator('.tally-series-step-label')).toContainText('Step 2 of 2');

    // Open this step's mesh tally in the native 3D viewer (shared color range
    // keeps every statepoint on one scale — no mesh is preloaded earlier).
    await widget.locator('.tally-series-open-3d').click();
    const tallyTab = page.locator('.openmc-output-viewer-container').first();
    await expect(tallyTab).toBeVisible({ timeout: 60_000 });
    await expect(tallyTab.locator('.openmc-output-viewer-viewarea canvas')).toBeVisible({ timeout: 60_000 });
    await expect(tallyTab.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});
