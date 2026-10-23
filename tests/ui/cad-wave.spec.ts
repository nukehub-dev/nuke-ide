import { test, expect, Page } from '@playwright/test';
import { collectErrors, waitForWorkbench, openFileByQuickOpen, closeAllEditors, runCommand } from './helpers';

/**
 * Wave C CAD chrome: the Model Outline parameter spreadsheet (edit-in-place
 * with validator reasons, rebuild scheduling) and saved-measurement pins
 * (pin → rebuild → label survives).
 *
 * Uses the tiny committed `cad-pincell.nuke-cad` fixture (3-cylinder
 * pincell with `fuelRadius`/`cladRadius`/`pitch` parameters bound to sketch
 * dimensions, so a parameter edit rebuilds real geometry). Document builds
 * run through the CAD backend (OCP/build123d), so the suite skips gracefully
 * when the backend is unavailable: the viewport shows the
 * `.cad-viewport-error-banner` naming the missing dependency instead of a
 * model, and the tests skip without failing.
 *
 * Suite conventions (root AGENTS.md): Theia/lumino selectors only, Command
 * Palette via Ctrl+Shift+P + `>` prefix, zero console severity-error/pageerror
 * gate per test.
 */

test.setTimeout(180_000);

function severe(errors: string[]): string[] {
    return errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles') && !e.includes('INVALID tab'));
}

/** Open the CAD fixture and wait for the document build; skip without a backend. */
async function openCadDocument(page: Page) {
    await closeAllEditors(page);
    await page.locator('#theia-app-shell').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Control+P');
    const warm = page.locator('.quick-input-widget input');
    await expect(warm).toBeVisible({ timeout: 10_000 });
    await warm.fill('fixtures');
    await expect(page.locator('.quick-input-widget .monaco-list-row').first()).toBeVisible({ timeout: 120_000 });
    await page.keyboard.press('Escape');
    await openFileByQuickOpen(page, 'cad-pincell.nuke-cad');
    const viewport = page.locator('.cad-viewport').first();
    await expect(viewport).toBeVisible({ timeout: 60_000 });

    // The document build runs on open: either the model lands (canvas + no
    // error banner) or the banner names the missing backend (skip).
    await expect(viewport.locator('.nuke-loading-overlay')).toBeHidden({ timeout: 120_000 });
    const banner = viewport.locator('.cad-viewport-error-banner');
    if (await banner.isVisible()) {
        const text = ((await banner.textContent()) ?? '').trim();
        if (/install|missing|not installed|unavailable|environment|python/i.test(text)) {
            test.skip(true, `CAD backend unavailable: ${text.slice(0, 200)}`);
        }
        expect(banner, `CAD build failed: ${text}`).toBeHidden();
    }
    await expect(viewport.locator('canvas').first()).toBeVisible({ timeout: 30_000 });

    // The canvas element exists before the build finishes, and the viewport
    // context menu only appears once a tessellation is on screen: wait for
    // the explode slider (which renders with the tessellation, same gate as
    // the pre-existing explode spec) or the build-failure banner, so later
    // interactions hit a live model instead of a still-building canvas.
    // (The old `.cad-viewport-nav` container the context-menu spec waits for
    // no longer exists in the widget — only its `-button`/`-divider` parts.)
    const explode = viewport.locator('.cad-viewport-explode input[type=range]');
    await expect(explode.or(banner).first()).toBeVisible({ timeout: 120_000 });
    if (await banner.isVisible()) {
        const text = ((await banner.textContent()) ?? '').trim();
        if (/install|missing|not installed|unavailable|environment|python/i.test(text)) {
            test.skip(true, `CAD backend unavailable: ${text.slice(0, 200)}`);
        }
        expect(banner, `CAD build failed: ${text}`).toBeHidden();
    }

    // The Model Outline reveals itself with the model; open it explicitly if
    // it did not (fresh profile state).
    if (!(await page.locator('.cad-outline-panel').isVisible())) {
        await runCommand(page, 'Open Model Outline');
    }
    const outline = page.locator('.cad-outline-panel').first();
    await expect(outline).toBeVisible({ timeout: 30_000 });
    await expect(outline.locator('.cad-outline-body-count')).toHaveText(/^\d+ bod(y|ies)$/);
    return { viewport, outline };
}

function paramRow(outline: ReturnType<Page['locator']>, name: string) {
    return outline.locator('.param-table-tr', { hasText: name });
}

test('parameter spreadsheet rejects invalid input and rebuilds on valid edit', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const { viewport, outline } = await openCadDocument(page);
    const table = outline.locator('.param-table');
    await expect(table).toBeVisible({ timeout: 30_000 });
    const row = paramRow(outline, 'fuelRadius');
    await expect(row).toBeVisible({ timeout: 30_000 });
    // `fuelRadius` drives sketch dimensions, so used-by is non-empty.
    await expect(row.locator('.param-table-cell.used-by')).not.toHaveText('—');

    // Invalid input shows the validator reason inline and never commits.
    await row.locator('.param-table-cell.value.editable').click();
    const editor = row.locator('.param-input');
    await expect(editor).toBeVisible();
    await editor.fill('not-a-number');
    await editor.press('Enter');
    await expect(outline.locator('.param-error')).toBeVisible({ timeout: 30_000 });
    await editor.press('Escape');

    // A valid edit commits through the normal store path and rebuilds.
    await row.locator('.param-table-cell.value.editable').click();
    const editor2 = row.locator('.param-input');
    await expect(editor2).toBeVisible();
    await editor2.fill('0.45');
    await editor2.press('Enter');
    await expect(row.locator('.param-table-cell.value.editable')).toHaveText('0.45', { timeout: 30_000 });
    await expect(viewport.locator('.nuke-loading-overlay')).toBeHidden({ timeout: 120_000 });
    await expect(viewport.locator('.cad-viewport-error-banner')).toBeHidden();
    await expect(viewport.locator('canvas').first()).toBeVisible();

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('named views save, restore, and delete from the outline', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const { viewport, outline } = await openCadDocument(page);
    const section = outline.locator('.named-views-section');
    await expect(section).toBeVisible({ timeout: 30_000 });
    await expect(section.locator('.named-view-empty')).toBeVisible();

    // Save the live camera through the header button's quick-input prompt.
    await section.locator('button[aria-label="Save current view"]').click();
    const input = page.locator('.quick-input-widget input');
    await expect(input).toBeVisible({ timeout: 30_000 });
    await input.fill('Overview');
    await input.press('Enter');
    await expect(input).toBeHidden({ timeout: 30_000 });

    const row = section.locator('.named-view-row', { hasText: 'Overview' });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await outline.screenshot({ path: 'test-results/cad-named-views.png' });

    // Row click restores the saved pose through the viewport widget.
    await row.locator('.named-view-restore').click();
    await expect(viewport.locator('.cad-viewport-error-banner')).toBeHidden();

    // The hover trash button deletes the stored entry; the empty state returns.
    await row.hover();
    await row.locator('.named-view-delete').click();
    await expect(row).toBeHidden({ timeout: 30_000 });
    await expect(section.locator('.named-view-empty')).toBeVisible();

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('document settings summarize metadata and set units', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const { viewport, outline } = await openCadDocument(page);
    const section = outline.locator('.document-settings-section');
    await expect(section).toBeVisible({ timeout: 30_000 });
    await expect(section.locator('.category-header')).toContainText('Document Settings');

    const row = (label: string) => section.locator('.document-settings-row', { hasText: label });
    await expect(row('Name').locator('.document-settings-value')).toHaveText('pincell');
    await expect(row('Parameters').locator('.document-settings-value')).toHaveText('3');
    await expect(row('Bodies').locator('.document-settings-value')).toHaveText('3');
    await expect(row('Schema').locator('.document-settings-value')).toHaveText('v3');

    const outlineUnits = section.locator('.document-settings-units .nuke-select-trigger');
    await expect(outlineUnits).toHaveText('Unitless');

    // The outline select writes through the shared store, so the document
    // toolbar's units select follows immediately.
    await outlineUnits.click();
    await page.locator('.nuke-select-list').getByRole('option', { name: 'mm' }).click();
    await expect(outlineUnits).toHaveText('mm');
    await expect(page.locator('.cad-document-toolbar-units .nuke-select-trigger')).toHaveText('mm');
    await expect(viewport.locator('.nuke-loading-overlay')).toBeHidden({ timeout: 120_000 });
    await expect(viewport.locator('.cad-viewport-error-banner')).toBeHidden();

    // Display precision: defaults are 2 length / 1 angle decimal places and
    // the fields commit through the user preference scope.
    const lengthPrecision = section.getByLabel('Length decimal places');
    const anglePrecision = section.getByLabel('Angle decimal places');
    await expect(lengthPrecision).toHaveValue('2');
    await expect(anglePrecision).toHaveValue('1');
    await lengthPrecision.fill('0');
    await expect(lengthPrecision).toHaveValue('0');
    await lengthPrecision.fill('2');
    await expect(lengthPrecision).toHaveValue('2');
    await expect(outlineUnits).toHaveText('mm');

    await outline.screenshot({ path: 'test-results/cad-document-settings.png' });

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('origin axes section toggles per-axis visibility', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const { viewport, outline } = await openCadDocument(page);
    const section = outline.locator('.origin-section');
    await expect(section).toBeVisible({ timeout: 30_000 });
    await expect(section.locator('.category-header')).toContainText('Origin');

    const rows = section.locator('.origin-axis-row');
    await expect(rows).toHaveCount(3);
    for (const [index, label] of ['X', 'Y', 'Z'].entries()) {
        await expect(rows.nth(index).locator('.origin-axis-label')).toHaveText(label);
    }

    // Each eye toggle reflects its axis preference. X starts visible (schema
    // default) and flips through the same user-scoped preference the viewport
    // subscribes to.
    const xToggle = rows.nth(0).locator('.origin-axis-toggle');
    await expect(xToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(xToggle).toHaveAttribute('aria-label', 'Hide X axis');
    await xToggle.click();
    await expect(xToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(xToggle).toHaveAttribute('aria-label', 'Show X axis');
    await expect(rows.nth(1).locator('.origin-axis-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(rows.nth(2).locator('.origin-axis-toggle')).toHaveAttribute('aria-pressed', 'true');

    // Restore all axes before the reference screenshot.
    await xToggle.click();
    await expect(xToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(xToggle).toHaveAttribute('aria-label', 'Hide X axis');
    await expect(viewport.locator('.cad-viewport-error-banner')).toBeHidden();
    await viewport.screenshot({ path: 'test-results/cad-origin-axes.png' });

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('pinned measurement survives a rebuild with its label', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const { viewport, outline } = await openCadDocument(page);
    const canvas = viewport.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (!box) {
        throw new Error('measure test needs a laid-out canvas');
    }

    // Focus the viewport container (scoped key handling) and fit the model
    // so the canvas center hits the clad cylinder.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await viewport.focus();
    await page.keyboard.press('f');

    // Arm the distance tool from the viewport context menu (no testing hooks).
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    const menu = viewport.locator('.cad-viewport-context-menu');
    await expect(menu).toBeVisible({ timeout: 30_000 });
    await menu.locator('.cad-viewport-context-menu-item', { hasText: 'Measure Distance' }).click();
    await expect(menu).toBeHidden({ timeout: 30_000 });
    // The status pill takes over the hint while the tool captures clicks
    // (same armed-tool signal the pre-existing viewport spec asserts).
    await expect(viewport.locator('.cad-viewport-shading-hint')).toContainText('Measure: click the first point');

    // Two spread clicks on the clad top face commit a non-zero segment (the
    // CAD tool never commits degenerate zero-length legs, unlike the native
    // viewer's same-point `0` readout): the overlay label renders the value.
    await page.mouse.click(box.x + box.width * 0.45, box.y + box.height / 2);
    await expect(viewport.locator('.cad-viewport-shading-hint')).toContainText('click the second point');
    await page.mouse.click(box.x + box.width * 0.55, box.y + box.height / 2);
    await expect(viewport.locator('.cad-measure-label:not(.cad-measure-label-pending)').first()).toBeVisible({
        timeout: 30_000
    });

    // The Measurements list popover (toolbar Inspect group) hosts the rows;
    // it renders on toggle, never on commit.
    await viewport.locator('.cad-document-toolbar button:has(.codicon-list-unordered)').click();
    const popover = viewport.locator('.cad-viewport-measure-popover');
    await expect(popover).toBeVisible({ timeout: 30_000 });
    const measureRow = popover.locator('.cad-measure-row').first();
    await expect(measureRow).toBeVisible({ timeout: 30_000 });
    await expect(measureRow.locator('.cad-measure-value')).not.toBeEmpty();

    // Pin persists the annotation into the document's `measurements` block
    // (the row button flips to the unpin treatment once stored).
    await measureRow.locator('button:has(.codicon-pin)').click();
    await expect(measureRow.locator('button:has(.codicon-pinned)')).toBeVisible({ timeout: 30_000 });

    // A parameter edit rebuilds the model; the pinned label re-renders
    // afterwards while unpinned rows would clear.
    const row = paramRow(outline, 'fuelRadius');
    await row.locator('.param-table-cell.value.editable').click();
    const editor = row.locator('.param-input');
    await editor.fill('0.5');
    await editor.press('Enter');
    await expect(row.locator('.param-table-cell.value.editable')).toHaveText('0.5', { timeout: 30_000 });
    await expect(viewport.locator('.nuke-loading-overlay')).toBeHidden({ timeout: 120_000 });
    await expect(viewport.locator('.cad-viewport-error-banner')).toBeHidden();
    // The armed tool's hidden pending label shares the class — exclude it.
    await expect(viewport.locator('.cad-measure-label:not(.cad-measure-label-pending)').first()).toBeVisible({
        timeout: 30_000
    });
    await expect(popover.locator('.cad-measure-row')).toHaveCount(1);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});
