import { test, expect, Page, Locator } from '@playwright/test';
import { collectErrors, waitForWorkbench, openFileByQuickOpen, closeAllEditors, runCommand } from './helpers';

/**
 * Comparison workspace over the native viewers.
 *
 * Flow: open two different fixtures as separate tabs (`native-polydata.vtp`,
 * `filter-pipeline.vtp` — both carry an `energy` point array, so the shared
 * color-range union exists without a backend) → `Compare Open Views...` →
 * multi-select both rows in the quick pick → side-by-side panes with A/B
 * badges → Comparison section in Viewer Settings (shared range off/on) →
 * `Stop Comparison` removes the badges.
 *
 * Suite conventions (root AGENTS.md): Theia/lumino selectors only, Command
 * Palette via Ctrl+Shift+P + `>` prefix, zero console severity-error/pageerror
 * gate per test (l10n noise and the plugin-host INVALID tab race filtered).
 */

test.setTimeout(240_000);

const FIRST_FIXTURE = 'native-polydata.vtp';
const SECOND_FIXTURE = 'filter-pipeline.vtp';

function severe(errors: string[]): string[] {
    return errors.filter(
        (e) =>
            !e.includes('l10n') &&
            !e.includes('localization bundles') &&
            // Upstream Theia plugin-host race when tabs open/close in quick
            // succession (extHostTab dto arrives for a closed tab).
            !e.includes('INVALID tab')
    );
}

/** Warm the file-search index once (first Quick Open on a repo-sized workspace is slow). */
async function warmFileSearch(page: Page): Promise<void> {
    await page.locator('#theia-app-shell').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Control+P');
    const input = page.locator('.quick-input-widget input');
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill('fixtures');
    await expect(page.locator('.quick-input-widget .monaco-list-row').first()).toBeVisible({ timeout: 120_000 });
    await page.keyboard.press('Escape');
}

/**
 * Open a fixture and assert its tab is frontmost with a live canvas. Lumino
 * hides the previously active tab's widget, so each viewer must be checked
 * while it is the one that was just opened.
 */
async function openFixture(page: Page, name: string): Promise<Locator> {
    await openFileByQuickOpen(page, name);
    const container = page.locator('.openmc-output-viewer-container').filter({ has: page.locator('.nuke-view-badge', { hasText: name }) });
    await expect(container).toBeVisible({ timeout: 60_000 });
    await expect(container.locator('.openmc-output-viewer-viewarea canvas')).toBeVisible({ timeout: 30_000 });
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    return container;
}

/**
 * Pick a NukeSelect option: the dropdown portals to document.body, so the
 * option is located from the page root, not the settings panel.
 */
async function selectNukeOption(page: Page, scope: Locator, hookClass: string, optionName: string): Promise<void> {
    await scope.locator(`.${hookClass} .nuke-select-trigger`).click();
    await page.locator('.nuke-select-list').getByRole('option', { name: optionName }).click();
}

/**
 * Generic viewers start on Solid Color; choose the scalar array so the
 * comparison range bus has a data range to union.
 */
async function selectEnergyColorBy(page: Page, settings: Locator): Promise<void> {
    const trigger = settings.locator('.viewer-settings-color-by .nuke-select-trigger');
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    await selectNukeOption(page, settings, 'viewer-settings-color-by', 'Point: energy');
}

/**
 * Run `Compare Open Views...` and pick both fixture rows in the multi-select
 * quick pick. Clicking the command row swaps the palette for a `canPickMany`
 * quick pick: row clicks toggle checkboxes and Enter accepts the selection.
 */
async function compareOpenViews(page: Page, firstFixture = FIRST_FIXTURE, secondFixture = SECOND_FIXTURE): Promise<void> {
    await page.locator('#theia-app-shell').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Control+Shift+P');
    const input = page.locator('.quick-input-widget input');
    await expect(input).toBeVisible();
    await input.fill('>Compare Open Views');
    const commandRow = page.locator('.quick-input-widget .monaco-list-row', { hasText: 'Compare Open Views' }).first();
    await expect(commandRow).toBeVisible();
    await commandRow.click();

    const picker = page.locator('.quick-input-widget');
    const firstRow = picker.locator('.monaco-list-row', { hasText: firstFixture }).first();
    const secondRow = picker.locator('.monaco-list-row', { hasText: secondFixture }).first();
    try {
        await expect(firstRow).toBeVisible({ timeout: 60_000 });
        await expect(secondRow).toBeVisible({ timeout: 60_000 });
    } catch (error) {
        // Playwright's failure artifacts already capture a screenshot; attach
        // the picker DOM so a changed flow reports evidence, not a guess.
        const dom = await picker.evaluate((element) => element.outerHTML).catch(() => '<quick pick DOM unavailable>');
        await test.info().attach('comparison-quick-pick-dom', { contentType: 'text/html', body: dom });
        throw error;
    }

    await firstRow.click();
    await expect(firstRow.locator('.monaco-checkbox')).toHaveAttribute('aria-checked', 'true');
    await secondRow.click();
    await expect(secondRow.locator('.monaco-checkbox')).toHaveAttribute('aria-checked', 'true');
    // Multi-select stays open while toggling; Enter commits both panes.
    await expect(input).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(input).toBeHidden({ timeout: 30_000 });
}

test('comparison workspace splits two views, shares the range, and stops cleanly', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);
    await closeAllEditors(page);

    await warmFileSearch(page);
    await openFixture(page, FIRST_FIXTURE);

    // Generic viewers default to Solid Color; give each pane a scalar so the
    // shared-range union has data to publish.
    await runCommand(page, 'Open Viewer Settings');
    const comparisonSettings = page.locator('.viewer-settings-panel');
    await expect(comparisonSettings).toBeVisible({ timeout: 30_000 });
    await selectEnergyColorBy(page, comparisonSettings);

    await openFixture(page, SECOND_FIXTURE);
    await selectEnergyColorBy(page, comparisonSettings);

    // Both viewers exist as tabs. The inactive tab's widget is hidden by
    // Lumino, so assert attachment plus the canvases the helpers just checked
    // while each tab was frontmost.
    const panes = page.locator('.openmc-output-viewer-container');
    await expect(panes).toHaveCount(2, { timeout: 30_000 });
    await expect(panes.nth(0)).toBeAttached();
    await expect(panes.nth(1)).toBeAttached();
    await expect(page.locator('.openmc-output-viewer-viewarea canvas')).toHaveCount(2, { timeout: 30_000 });

    await compareOpenViews(page);

    // Exactly two panes remain, both visible and side by side.
    await expect(panes).toHaveCount(2, { timeout: 60_000 });
    const firstPane = panes.nth(0);
    const secondPane = panes.nth(1);
    await expect(firstPane).toBeVisible({ timeout: 60_000 });
    await expect(secondPane).toBeVisible({ timeout: 60_000 });
    await expect(firstPane.locator('.openmc-output-viewer-viewarea canvas')).toBeVisible({ timeout: 30_000 });
    await expect(secondPane.locator('.openmc-output-viewer-viewarea canvas')).toBeVisible({ timeout: 30_000 });

    await expect
        .poll(
            async () => {
                const [a, b] = await Promise.all([firstPane.boundingBox(), secondPane.boundingBox()]);
                if (!a || !b) {
                    return false;
                }
                return Math.abs(a.y - b.y) < 30 && Math.abs(a.x - b.x) > 100;
            },
            { timeout: 30_000, message: 'comparison panes should be laid out side by side' }
        )
        .toBe(true);

    const [firstBox, secondBox] = await Promise.all([firstPane.boundingBox(), secondPane.boundingBox()]);
    if (!firstBox || !secondBox) {
        throw new Error('comparison test needs laid-out panes');
    }
    expect(Math.abs(firstBox.y - secondBox.y)).toBeLessThan(30);
    expect(Math.abs(firstBox.x - secondBox.x)).toBeGreaterThan(100);

    // Each pane carries an A/B badge; the labels are the session's pane labels.
    const badges = page.locator('.nuke-viewer-comparison-badge');
    await expect(badges).toHaveCount(2, { timeout: 60_000 });
    await expect(firstPane.locator('.nuke-viewer-comparison-badge')).toHaveCount(1);
    await expect(secondPane.locator('.nuke-viewer-comparison-badge')).toHaveCount(1);
    await expect(badges.nth(0)).toBeVisible();
    await expect(badges.nth(1)).toBeVisible();
    const labels = (await badges.allTextContents()).map((label) => label.trim()).sort();
    expect(labels).toEqual(['A', 'B']);

    // Comparison section: link cameras and shared range start enabled, and the
    // shared-range value comes from the panes' union (both panes color by energy).
    const settings = comparisonSettings;
    await expect(settings).toBeVisible({ timeout: 30_000 });
    const linkSwitch = settings.locator('.viewer-settings-comparison-link');
    const rangeSwitch = settings.locator('.viewer-settings-comparison-range');
    const rangeValue = settings.locator('.viewer-settings-comparison-range-value');
    await expect(linkSwitch).toBeVisible();
    await expect(linkSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(rangeSwitch).toBeVisible();
    await expect(rangeSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(rangeValue).toBeVisible({ timeout: 30_000 });

    // Per-pane shared-range opt-out and re-enable must not disturb the viewer.
    await rangeSwitch.click();
    await expect(rangeSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('.openmc-output-viewer-container .openmc-output-viewer-status.error')).toHaveCount(0);

    await rangeSwitch.click();
    await expect(rangeSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(rangeValue).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.openmc-output-viewer-container .openmc-output-viewer-status.error')).toHaveCount(0);

    // Leave is offered per pane; Stop Comparison is exercised instead below.
    await expect(settings.locator('.viewer-settings-comparison-leave')).toBeVisible();

    await runCommand(page, 'Stop Comparison');
    await expect(page.locator('.nuke-viewer-comparison-badge')).toHaveCount(0, { timeout: 30_000 });
    // Panes stay open and split after stopping.
    await expect(panes).toHaveCount(2);
    await expect(page.locator('.openmc-output-viewer-container .openmc-output-viewer-status.error')).toHaveCount(0);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('comparison workspace includes the DAGMC viewer', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);
    await closeAllEditors(page);

    await warmFileSearch(page);
    await openFixture(page, 'native-volumes.vtm');
    await openFixture(page, FIRST_FIXTURE);

    await compareOpenViews(page, 'native-volumes.vtm', FIRST_FIXTURE);

    const panes = page.locator('.openmc-output-viewer-container');
    await expect(panes).toHaveCount(2, { timeout: 60_000 });
    await expect(panes.nth(0)).toBeVisible({ timeout: 60_000 });
    await expect(panes.nth(1)).toBeVisible({ timeout: 60_000 });
    await expect
        .poll(
            async () => {
                const [a, b] = await Promise.all([panes.nth(0).boundingBox(), panes.nth(1).boundingBox()]);
                return !!a && !!b && Math.abs(a.y - b.y) < 30 && Math.abs(a.x - b.x) > 100;
            },
            { timeout: 30_000 }
        )
        .toBe(true);

    const badges = page.locator('.nuke-viewer-comparison-badge');
    await expect(badges).toHaveCount(2, { timeout: 30_000 });
    expect((await badges.allTextContents()).map((label) => label.trim()).sort()).toEqual(['A', 'B']);

    const settings = page.locator('.viewer-settings-panel');
    await expect(settings).toBeVisible({ timeout: 30_000 });
    await expect(settings.locator('.viewer-settings-comparison-link')).toBeVisible();
    await expect(settings.locator('.viewer-settings-comparison-range')).toBeVisible();
    await expect(page.locator('.openmc-output-viewer-container .openmc-output-viewer-status.error')).toHaveCount(0);

    await runCommand(page, 'Stop Comparison');
    await expect(page.locator('.nuke-viewer-comparison-badge')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator('.openmc-output-viewer-container .openmc-output-viewer-status.error')).toHaveCount(0);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});
