import { test, expect, Page } from '@playwright/test';
import { collectErrors, waitForWorkbench, openFileByQuickOpen, closeAllEditors, runCommand } from './helpers';

/**
 * CAD parameters and assembly chrome: the Model Outline parameter spreadsheet (edit-in-place
 * with validator reasons, rebuild scheduling), saved-measurement pins
 * (pin → rebuild → label survives), and the draggable/collapsible assembly
 * panel with its gated add-instance action.
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

/**
 * Open the Measurements popover from the Inspect section. At tiles/icons
 * density the button is promoted; in menus density it lives in the section
 * menu, which this helper opens first.
 */
async function openMeasurements(page: Page, viewport: ReturnType<Page['locator']>) {
    const inspect = viewport.locator('.cad-document-toolbar [role="group"][aria-label="Inspect"]');
    const promoted = inspect.locator('.nuke-ribbon-item:has(.codicon-list-unordered)');
    if (await promoted.isVisible()) {
        await promoted.click();
        return { trigger: promoted, promoted: true };
    }
    await inspect.locator('.nuke-ribbon-menu-trigger').click();
    const menuItem = page.locator('.nuke-ribbon-menu [role="menuitem"]:has(.codicon-list-unordered)').first();
    await expect(menuItem).toBeVisible();
    await menuItem.click();
    return { trigger: menuItem, promoted: false };
}

/** Resolve a Theia CSS custom property to its computed color value. */
async function resolveColorToken(page: Page, token: string): Promise<string> {
    return page.evaluate((name) => {
        const probe = document.createElement('span');
        probe.style.color = `var(${name})`;
        document.body.appendChild(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
    }, token);
}

test('assembly panel drags, collapses, and gates the instance action', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    await openCadDocument(page);

    const panel = page.locator('.cad-assembly-panel').first();
    await expect(panel).toBeVisible({ timeout: 30_000 });
    const header = panel.locator('.cad-assembly-header');
    await expect(header).toContainText('Assembly');
    await expect(panel.locator('.cad-assembly-count')).toHaveText('0 instances');
    await expect(panel.locator('.cad-assembly-empty-title')).toHaveText('No instances yet.');

    // The Instance action is inert until a non-empty part source exists.
    const partInput = panel.getByLabel('Assembly part');
    const addButton = panel.getByRole('button', { name: 'Instance' });
    await expect(addButton).toBeDisabled();
    await partInput.fill('./bracket.nuke-cad');
    await expect(addButton).toBeEnabled();

    // The header is the drag handle (the collapse button is excluded), so a
    // 40 px pointer drag moves the card and keeps the new spot.
    const before = await panel.boundingBox();
    const headerBox = await header.boundingBox();
    if (!before || !headerBox) {
        throw new Error('assembly panel needs laid-out boxes');
    }
    await page.mouse.move(headerBox.x + headerBox.width / 2, headerBox.y + headerBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(headerBox.x + headerBox.width / 2 + 40, headerBox.y + headerBox.height / 2 + 40, { steps: 6 });
    await page.mouse.up();
    const after = await panel.boundingBox();
    if (!after) {
        throw new Error('assembly panel needs a box after dragging');
    }
    expect(after.x - before.x).toBeGreaterThanOrEqual(30);
    expect(after.y - before.y).toBeGreaterThanOrEqual(30);

    // Collapse keeps the header (and its dragged position) while the body,
    // including the part input, is hidden; expand restores the typed value.
    await panel.getByRole('button', { name: 'Collapse assembly panel' }).click();
    const expandButton = panel.getByRole('button', { name: 'Expand assembly panel' });
    await expect(expandButton).toHaveAttribute('aria-expanded', 'false');
    await expect(partInput).toBeHidden();
    const collapsedBox = await panel.boundingBox();
    if (!collapsedBox) {
        throw new Error('assembly panel needs a box while collapsed');
    }
    expect(collapsedBox.y).toBeCloseTo(after.y, 0);
    await expandButton.click();
    await expect(partInput).toBeVisible();
    await expect(partInput).toHaveValue('./bracket.nuke-cad');

    await panel.screenshot({ path: 'test-results/cad-assembly-panel.png' });

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

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

test('document section summarizes metadata and sets units', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const { viewport, outline } = await openCadDocument(page);
    const section = outline.locator('.document-settings-section');
    await expect(section).toBeVisible({ timeout: 30_000 });
    const header = section.locator('.category-header');
    // The short "Document" label stays on one line at the default 200 px panel
    // width; the full "Document settings" wording lives in the title tooltip.
    await expect(header).toHaveText('Document');
    await expect(header).toHaveAttribute('title', 'Document settings');

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

    // Display-only preferences live under a DISPLAY subhead. The Color by
    // material row is full-width with a 4 px box inset so it shares the label
    // column instead of floating between Precision and Parameters.
    const subheads = section.locator('.document-settings-subhead');
    await expect(subheads).toHaveCount(2);
    await expect(subheads.nth(0)).toHaveText('Display');
    await expect(subheads.nth(1)).toHaveText('Design Properties');

    // NukeCheckbox hides its native input under a painted box, so toggle
    // through the label and assert the input's checked state.
    const colorRow = section.locator('.document-settings-color-row');
    const colorCheckbox = colorRow.locator('label.nuke-checkbox');
    const colorInput = colorRow.locator('input[type="checkbox"]');
    await expect(colorCheckbox).toContainText('Color by material');
    await expect(colorInput).not.toBeChecked();
    // No legend while the toggle is off.
    await expect(section.locator('.document-settings-material-legend')).toHaveCount(0);

    const colorRowBox = await colorRow.boundingBox();
    const colorCheckboxBox = await colorCheckbox.boundingBox();
    if (!colorRowBox || !colorCheckboxBox) {
        throw new Error('color-by-material row needs a laid-out checkbox');
    }
    expect(colorCheckboxBox.x - colorRowBox.x).toBeLessThanOrEqual(6);

    await colorCheckbox.click();
    await expect(colorInput).toBeChecked();
    // The pincell fixture tags no bodies: the legend explains the empty state
    // rather than disappearing silently while the toggle is on.
    const legend = section.locator('.document-settings-material-legend');
    await expect(legend).toBeVisible();
    await expect(legend).toContainText('No material tags yet');

    await outline.screenshot({ path: 'test-results/cad-document-settings.png' });

    await colorCheckbox.click();
    await expect(colorInput).not.toBeChecked();
    await expect(section.locator('.document-settings-material-legend')).toHaveCount(0);

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

    const chipRow = section.locator('.origin-axis-chips');
    await expect(chipRow).toHaveAttribute('role', 'group');
    await expect(chipRow).toHaveAttribute('aria-label', 'Origin axes');
    const chips = chipRow.locator('.origin-axis-chip');
    await expect(chips).toHaveCount(3);
    for (const [index, label] of ['X', 'Y', 'Z'].entries()) {
        await expect(chips.nth(index).locator('.origin-axis-chip-label')).toHaveText(label);
    }

    // Pressed chips mirror the viewport triad colors and the compact 26 px
    // grid (the mini glyph sits beside the bold axis letter).
    const axisColors = ['rgb(224, 82, 82)', 'rgb(76, 175, 80)', 'rgb(59, 130, 246)'];
    for (const [index, color] of axisColors.entries()) {
        const chip = chips.nth(index);
        await expect(chip).toHaveCSS('height', '26px');
        await expect(chip).toHaveCSS('color', color);
        await expect(chip).toHaveCSS('border-top-color', color);
        await expect(chip.locator('.origin-axis-chip-glyph')).toHaveCSS('width', '12px');
    }

    // The master switch gates the whole triad; the chips keep their own saved
    // state while it is off.
    const master = section.getByRole('switch', { name: 'Show origin axes' });
    await expect(master).toBeVisible();
    await expect(master).toHaveAttribute('aria-checked', 'true');
    const xChip = section.getByRole('button', { name: 'Hide X axis' });
    await expect(xChip).toHaveAttribute('aria-pressed', 'true');
    await xChip.click();
    await expect(section.getByRole('button', { name: 'Show X axis' })).toHaveAttribute('aria-pressed', 'false');
    await expect(section.getByRole('button', { name: 'Hide Y axis' })).toHaveAttribute('aria-pressed', 'true');
    await expect(section.getByRole('button', { name: 'Hide Z axis' })).toHaveAttribute('aria-pressed', 'true');

    // With the master off the chips are disabled but keep their saved pressed
    // state, so toggling back restores the per-axis choices.
    await master.click();
    await expect(master).toHaveAttribute('aria-checked', 'false');
    for (const name of ['Show X axis', 'Hide Y axis', 'Hide Z axis']) {
        const chip = section.getByRole('button', { name });
        await expect(chip).toBeDisabled();
        await expect(chip).toHaveAttribute('aria-disabled', 'true');
    }
    await expect(section.getByRole('button', { name: 'Show X axis' })).toHaveAttribute('aria-pressed', 'false');
    await master.click();
    await expect(master).toHaveAttribute('aria-checked', 'true');
    await expect(section.getByRole('button', { name: 'Show X axis' })).toBeEnabled();
    await expect(section.getByRole('button', { name: 'Show X axis' })).toHaveAttribute('aria-pressed', 'false');

    // Restore all axes before the reference screenshot.
    await section.getByRole('button', { name: 'Show X axis' }).click();
    await expect(section.getByRole('button', { name: 'Hide X axis' })).toHaveAttribute('aria-pressed', 'true');
    await expect(viewport.locator('.cad-viewport-error-banner')).toBeHidden();
    await outline.screenshot({ path: 'test-results/cad-origin-section.png' });
    await viewport.screenshot({ path: 'test-results/cad-origin-axes.png' });

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('pinned measurement survives a rebuild with its label', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);
    // Icons density keeps the Inspect measure buttons promoted (menus only
    // below 930 px of toolbar width).
    await page.setViewportSize({ width: 1440, height: 900 });

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
    const { trigger: measureButton, promoted } = await openMeasurements(page, viewport);
    const popover = viewport.locator('.cad-viewport-measure-popover');
    await expect(popover).toBeVisible({ timeout: 30_000 });
    const measureRow = popover.locator('.cad-measure-row').first();
    await expect(measureRow).toBeVisible({ timeout: 30_000 });
    await expect(measureRow.locator('.cad-measure-value')).not.toBeEmpty();

    // The popover clears the document toolbar at every ribbon density.
    const toolbarBox = await viewport.locator('.cad-document-toolbar').boundingBox();
    const popoverBox = await popover.boundingBox();
    expect(toolbarBox).not.toBeNull();
    expect(popoverBox).not.toBeNull();
    expect(popoverBox!.y).toBeGreaterThan(toolbarBox!.y + toolbarBox!.height);

    // Active Inspect action and popover buttons use the theme's own contrast
    // tokens instead of inheriting the primary white button foreground.
    const buttonForeground = await resolveColorToken(page, '--theia-button-foreground');
    const secondaryForeground = await resolveColorToken(page, '--theia-secondaryButton-foreground');
    if (promoted) {
        const focusBorder = await resolveColorToken(page, '--theia-focusBorder');
        await expect(measureButton).toHaveClass(/(?:^|\s)active(?:\s|$)/);
        await expect(measureButton).toHaveCSS('background-color', focusBorder);
        await expect(measureButton.locator('.codicon')).toHaveCSS('color', buttonForeground);
    }
    await expect(popover.locator('.cad-measure-header .cad-measure-row-remove')).toHaveCSS('color', secondaryForeground);
    await expect(popover.locator('.cad-measure-clear')).toHaveCSS('color', secondaryForeground);

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
