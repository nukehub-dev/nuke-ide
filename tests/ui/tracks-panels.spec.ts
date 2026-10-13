import { test, expect, Page } from '@playwright/test';
import { collectErrors, waitForWorkbench, openFileByQuickOpen, closeAllEditors, runCommand } from './helpers';

/**
 * Wave 1 output-viewer panels in the native tracks viewer: derived fields
 * (Calculator) + histogram, direction glyphs, and threshold coverage.
 *
 * Uses the tiny committed `tracks.h5` fixture (one neutron track, 4 states
 * along +x with decaying energy). Opening converts through the Python
 * backend (`openmc.tracks-vtk`, needs h5py + vtk in the detected env), so
 * the suite skips gracefully when the backend is unavailable: a missing
 * backend renders the `.openmc-output-viewer-dep-panel` error panel instead
 * of the canvas, and the tests skip without failing.
 *
 * Suite conventions (root AGENTS.md): Theia/lumino selectors only, Command
 * Palette via Ctrl+Shift+P + `>` prefix, zero console severity-error/pageerror
 * gate per test.
 */

test.setTimeout(180_000);

function severe(errors: string[]): string[] {
    return errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles') && !e.includes('INVALID tab'));
}

/** Open the tracks fixture; skip gracefully when the backend is missing. */
async function openTracksViewer(page: Page) {
    await closeAllEditors(page);
    await page.locator('#theia-app-shell').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Control+P');
    const warm = page.locator('.quick-input-widget input');
    await expect(warm).toBeVisible({ timeout: 10_000 });
    await warm.fill('fixtures');
    await expect(page.locator('.quick-input-widget .monaco-list-row').first()).toBeVisible({ timeout: 120_000 });
    await page.keyboard.press('Escape');
    await openFileByQuickOpen(page, 'tracks.h5');
    const container = page.locator('.openmc-output-viewer-container').first();
    await expect(container).toBeVisible({ timeout: 60_000 });
    const depPanel = container.locator('.openmc-output-viewer-dep-panel');
    if (await depPanel.isVisible()) {
        test.skip(true, `tracks backend unavailable: ${(await depPanel.textContent())?.trim().slice(0, 200)}`);
    }
    const canvas = container.locator('.openmc-output-viewer-viewarea canvas');
    await expect(canvas).toBeVisible({ timeout: 60_000 });
    return container;
}

async function openViewerSettings(page: Page) {
    await runCommand(page, 'Open Viewer Settings');
    const panel = page.locator('.viewer-settings-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    return panel;
}

test('calculator derives a field and the histogram covers the active array', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openTracksViewer(page);
    const card = container.locator('.openmc-output-viewer-card', { hasText: 'Derived field (Calculator)' });
    await expect(card).toBeVisible({ timeout: 30_000 });
    const expression = card.getByLabel('Derived field expression');
    await expect(expression).toBeVisible();

    // Invalid input is a panel error, never committed.
    await expression.fill('not an expression !!!');
    await card.getByRole('button', { name: 'Apply' }).click();
    await expect(card.locator('.openmc-derived-field-error')).toBeVisible({ timeout: 30_000 });

    // A valid derivation materializes a transient array the color-by
    // pipeline consumes like any parsed array.
    await expression.fill('energy/weight');
    await card.getByRole('button', { name: 'Apply' }).click();
    await expect(card.getByText(/Coloring by derived field.*energy\/weight/)).toBeVisible({ timeout: 30_000 });

    // The histogram covers the active color-by array as an SVG readout.
    const histogramCard = container.locator('.openmc-output-viewer-card', { hasText: 'Histogram' });
    await expect(histogramCard.locator('.openmc-histogram-svg')).toBeVisible({ timeout: 30_000 });
    await expect(histogramCard.locator('.openmc-derived-field-note').first()).not.toBeEmpty();
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('glyph rows appear and enabling cones reports live coverage', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openTracksViewer(page);
    const settings = await openViewerSettings(page);
    // The tracks viewer derives per-point direction vectors from the
    // polyline tangents, so the Glyphs rows show with density/size sliders.
    const glyphSwitch = settings.locator('.viewer-settings-glyph');
    await expect(glyphSwitch).toBeVisible({ timeout: 30_000 });
    await expect(settings.locator('.viewer-settings-glyph-density')).toBeVisible();
    await expect(settings.locator('.viewer-settings-glyph-scale')).toBeVisible();

    await glyphSwitch.click();
    const status = container.locator('.openmc-output-viewer-hint.nuke-viewer-status-line');
    await expect(status).toContainText(/glyphs \d+ of \d+/, { timeout: 30_000 });
    await expect(container.locator('.openmc-output-viewer-viewarea canvas')).toBeVisible();
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('threshold on the tracks viewer reports coverage', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openTracksViewer(page);
    const settings = await openViewerSettings(page);
    await settings.locator('.viewer-settings-color-by .nuke-select-trigger').click();
    await page.locator('.nuke-select-list').getByRole('option', { name: 'Point: energy' }).click();

    const thresholdWrap = settings.locator('.viewer-settings-range-wrap').filter({ has: page.locator('.viewer-settings-threshold') });
    await expect(thresholdWrap).toBeVisible({ timeout: 30_000 });
    await settings.locator('.viewer-settings-threshold').click();
    const status = container.locator('.openmc-output-viewer-hint.nuke-viewer-status-line');
    // Fixture energies (2.0/1.6/1.2/0.8) all sit inside the data range.
    await expect(status).toContainText('threshold 4 of 4 shown', { timeout: 30_000 });

    const minInput = thresholdWrap.locator('.viewer-settings-range-input').first();
    await minInput.fill('1.5');
    await minInput.press('Enter');
    await expect(status).toContainText('threshold 2 of 4 shown', { timeout: 30_000 });
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});
