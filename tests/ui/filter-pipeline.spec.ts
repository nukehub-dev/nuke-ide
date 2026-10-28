import { test, expect, Page } from '@playwright/test';
import { collectErrors, waitForWorkbench, openFileByQuickOpen, closeAllEditors, runCommand } from './helpers';

/**
 * Filter-pipeline chrome in the generic native viewer (no backend
 * needed — FileService read + client-side settings only).
 *
 * Uses the tiny committed `filter-pipeline.vtp` fixture: a 2-triangle square
 * with a scalar `energy` point array (1/2/3/4) and a 3-component `DISP`
 * vector point array, so the Viewer Settings sidebar shows the Warp and
 * Threshold rows. Glyph rows are tracks/collision-viewer-only (covered in
 * tracks-panels.spec.ts); the calculator lives in the output data panels
 * (same file).
 *
 * Suite conventions (root AGENTS.md): Theia/lumino selectors only, Command
 * Palette via Ctrl+Shift+P + `>` prefix, zero console severity-error/pageerror
 * gate per test.
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

async function selectNukeOption(page: Page, scopeText: string, hookClass: string, optionName: string) {
    const scope = page.locator(scopeText);
    await scope.locator(`.${hookClass} .nuke-select-trigger`).click();
    await page.locator('.nuke-select-list').getByRole('option', { name: optionName }).click();
}

test('warp row appears for vector arrays and enabling it reports the applied factor', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'filter-pipeline.vtp');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    const settings = await openViewerSettings(page);
    const warpSwitch = settings.locator('.viewer-settings-warp');
    await expect(warpSwitch).toBeVisible({ timeout: 30_000 });
    await expect(settings.locator('.viewer-settings-warp-array .nuke-select-trigger')).toBeVisible();

    // Enabling warp applies client-side and the status line reports the
    // applied exaggeration factor (describeModel `warped x…` suffix).
    await warpSwitch.click();
    const status = container.locator('.openmc-output-viewer-hint.nuke-viewer-status-line');
    await expect(status).toContainText('warped x', { timeout: 30_000 });
    await expect(container.locator('.openmc-output-viewer-viewarea canvas')).toBeVisible();
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('threshold row hides cells and the count text changes', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'filter-pipeline.vtp');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    const settings = await openViewerSettings(page);
    // The Threshold row appears once a color-by array is active.
    await selectNukeOption(page, '.viewer-settings-panel', 'viewer-settings-color-by', 'Point: energy');
    const thresholdWrap = settings.locator('.viewer-settings-range-wrap').filter({ has: page.locator('.viewer-settings-threshold') });
    await expect(thresholdWrap).toBeVisible({ timeout: 30_000 });

    const status = container.locator('.openmc-output-viewer-hint.nuke-viewer-status-line');
    await settings.locator('.viewer-settings-threshold').click();
    await expect(status).toContainText('threshold 4 of 4 shown', { timeout: 30_000 });

    // Narrow the window above the two lowest samples (1.0, 2.0): the folded
    // triangles drop the coverage to 2 of 4.
    const minInput = thresholdWrap.locator('.viewer-settings-range-input').first();
    await minInput.fill('2.5');
    await minInput.press('Enter');
    await expect(status).toContainText('threshold 2 of 4 shown', { timeout: 30_000 });
    await expect(container.locator('.openmc-output-viewer-viewarea canvas')).toBeVisible();
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('linked-cameras toggle enables on the viewer tab', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'filter-pipeline.vtp');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    // The nav-bar link toggle is per-view opt-in state, default off; flipping
    // it on a single view must apply cleanly (same-file multi-tab sync rides
    // the tally mesh/source tabs in tally-panels.spec.ts, the only UI path
    // that opens two tabs keyed by one file).
    const toggle = container.locator('.viewer-nav-link-cameras');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveClass(/active/);

    // Orbiting the linked view keeps the canvas healthy with no errors.
    const canvas = container.locator('.openmc-output-viewer-viewarea canvas');
    const box = await canvas.boundingBox();
    if (box) {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + 120, cy + 60, { steps: 12 });
        await page.mouse.up();
    }
    await expect(canvas).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});
