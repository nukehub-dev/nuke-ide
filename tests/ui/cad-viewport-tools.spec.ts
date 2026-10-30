import * as fs from 'fs';
import * as path from 'path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { closeAllEditors, collectErrors, openFileByQuickOpen, runCommand, waitForWorkbench } from './helpers';

/**
 * CAD viewport control audit: every ribbon section action, the document
 * actions behind it, the empty-state launchers, and the canvas chrome
 * (standard views, ViewCube, shading, section, explode, measure).
 *
 * The fixture-based tests need the CAD backend; when it is unavailable the
 * viewport shows its error banner and the test skips, matching the rest of the
 * GUI suite. Ribbon rows are read from the section menus so caret-menu tails
 * (`Export as Python`, `Lattice`, …) are audited together with the promoted
 * tiles. Feature buttons are clicked and their dialog is closed, which covers
 * command wiring without committing geometry.
 */

test.setTimeout(300_000);

/** A ribbon section's menu row, as rendered in the portal. */
interface RibbonRow {
    readonly label: string;
    readonly disabled: boolean;
    readonly reason: string | null;
}

/** Console/page errors that are unrelated to app regressions. */
function severeErrors(errors: readonly string[]): string[] {
    return errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles') && !e.includes('INVALID tab'));
}

/** Warm the workspace file index so the first Quick Open query can be slow. */
async function warmQuickOpen(page: Page): Promise<void> {
    await page.locator('#theia-app-shell').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Control+P');
    const input = page.locator('.quick-input-widget input');
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill('fixtures');
    await expect(page.locator('.quick-input-widget .monaco-list-row').first()).toBeVisible({ timeout: 120_000 });
    await page.keyboard.press('Escape');
}

/** Open a CAD fixture and wait for its first build; skip without a CAD backend. */
async function openCadFixture(page: Page, fileName: string): Promise<{ viewport: Locator; toolbar: Locator }> {
    await page.setViewportSize({ width: 2000, height: 900 });
    await warmQuickOpen(page);
    await openFileByQuickOpen(page, fileName);
    const viewport = page.locator('.cad-viewport').first();
    const model = viewport.locator('.cad-viewport-explode input[type=range]');
    const banner = viewport.locator('.cad-viewport-error-banner');
    await expect(model.or(banner).first()).toBeVisible({ timeout: 120_000 });
    if (await banner.isVisible()) {
        test.skip(true, `CAD backend unavailable: ${(await banner.allTextContents())[0] ?? 'build failed'}`);
    }
    await expect(model).toBeVisible({ timeout: 30_000 });
    const toolbar = viewport.locator('.cad-document-toolbar').first();
    await expect(toolbar).toBeVisible({ timeout: 60_000 });
    return { viewport, toolbar };
}

/** Open a section's caret menu; the menu is portaled to the page body. */
async function openRibbonMenu(page: Page, toolbar: Locator, group: string): Promise<Locator> {
    const section = toolbar.locator(`[role="group"][aria-label="${group}"]`);
    await expect(section).toBeVisible();
    await section.locator('.nuke-ribbon-menu-trigger').click();
    const menu = page.locator('.nuke-ribbon-menu');
    await expect(menu).toBeVisible();
    return menu;
}

/** Read every action row (label, disabled state, reason) from a section menu. */
async function readRibbonMenu(page: Page, toolbar: Locator, group: string): Promise<RibbonRow[]> {
    const menu = await openRibbonMenu(page, toolbar, group);
    const rows = await menu.locator('[role="menuitem"]').evaluateAll((elements) =>
        elements.map((element) => ({
            label: element.querySelector('.nuke-ribbon-menu-item-label')?.textContent?.trim() ?? '',
            disabled: (element as HTMLButtonElement).disabled,
            reason: element.querySelector('.nuke-ribbon-menu-item-reason')?.textContent?.trim() ?? null
        }))
    );
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    return rows;
}

/** Run one section-menu row; a disabled row fails with its reason. */
async function runRibbonCommand(page: Page, toolbar: Locator, group: string, label: string): Promise<void> {
    const menu = await openRibbonMenu(page, toolbar, group);
    const labels = (await menu.locator('.nuke-ribbon-menu-item-label').allTextContents()).map((text) => text.trim());
    const index = labels.indexOf(label);
    if (index < 0) {
        throw new Error(`Ribbon command '${label}' is missing from the ${group} menu; rows: ${labels.join(', ')}`);
    }
    const row = menu.locator('[role="menuitem"]').nth(index);
    if (await row.isDisabled()) {
        const reason = (await row.locator('.nuke-ribbon-menu-item-reason').allTextContents())[0] ?? 'no reason';
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        throw new Error(`Ribbon command '${label}' is disabled: ${reason}`);
    }
    await row.click();
    await expect(menu).toBeHidden();
}

/**
 * Prefer the visible icon/tile button (the controls the user clicks); fall
 * back to the section menu when the command is a caret-menu-only tail or the
 * toolbar is in menus density.
 */
async function runPromotedOrMenuCommand(page: Page, toolbar: Locator, group: string, label: string): Promise<void> {
    const section = toolbar.locator(`[role="group"][aria-label="${group}"]`);
    const tile = section.getByRole('button', { name: label, exact: true });
    if ((await tile.count()) > 0 && (await tile.isVisible().catch(() => false))) {
        await expect(tile).toBeEnabled();
        await tile.click();
        return;
    }
    await runRibbonCommand(page, toolbar, group, label);
}

/** Assert a feature dialog opened with the expected title, then cancel it. */
async function expectFeatureDialogThenCancel(page: Page, title: string): Promise<void> {
    const dialog = page.locator('.nuke-dialog').first();
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.locator('.nuke-dialog-title')).toHaveText(title);
    await dialog.locator('.nuke-dialog-footer button', { hasText: 'Cancel' }).click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });
}

/** Wait for a Theia file picker and cancel it without touching the document. */
async function cancelTheiaFileDialog(page: Page): Promise<void> {
    const shell = page.locator('#theia-dialog-shell');
    await expect(shell).toBeVisible({ timeout: 30_000 });
    await shell.getByRole('button', { name: 'Cancel', exact: true }).first().click();
    await expect(shell).toBeHidden({ timeout: 30_000 });
}

/** Save the active document to a fresh copy under test-results; returns its absolute path. */
async function saveDocumentCopy(page: Page, relativePath: string): Promise<string> {
    const target = path.resolve(relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.rmSync(target, { force: true });
    await runCommand(page, 'Save CAD Document As');
    const shell = page.locator('#theia-dialog-shell');
    await expect(shell).toBeVisible({ timeout: 30_000 });
    const fileName = page.locator('.theia-FileNameTextField');
    await fileName.fill(relativePath);
    await fileName.press('End');
    await page.locator('.dialogControl button', { hasText: 'Save' }).click();
    await expect(shell).toBeHidden({ timeout: 30_000 });
    // The picker can hide before the backend write settles.
    await expect.poll(() => fs.existsSync(target), { timeout: 15_000, message: 'Save As did not write the copy' }).toBe(true);
    return target;
}

/** Select the first sketch in the Feature Tree so sketch-dependent commands enable. */
async function selectFirstSketch(page: Page): Promise<void> {
    const tree = page.locator('.cad-feature-tree-panel').first();
    if (!(await tree.isVisible().catch(() => false))) {
        await runCommand(page, 'Open Feature Tree');
    }
    await expect(tree).toBeVisible({ timeout: 30_000 });
    const sketch = tree.locator('.feature-tree-row.sketch').first();
    await expect(sketch).toBeVisible();
    await sketch.click();
    await expect(tree.locator('.feature-tree-row.sketch.selected').first()).toBeVisible();
}

test('ribbon inventory and every action opens its expected surface', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);
    const { viewport, toolbar } = await openCadFixture(page, 'cad-viewport-tools.nuke-cad');
    // Finish Sketch auto-saves the active document, so audit a working copy
    // under the ignored test-results folder instead of the committed fixture.
    const workingCopy = await saveDocumentCopy(page, 'test-results/cad-viewport-tools-audit.nuke-cad');
    await selectFirstSketch(page);

    // Seven sections, one caret menu each. The fixture has bodies, three
    // sketches, and one curve, so every command except the four document
    // history actions is enabled.
    await expect(toolbar.locator('.nuke-ribbon-section')).toHaveCount(7);
    const documentRows = await readRibbonMenu(page, toolbar, 'Document');
    expect(documentRows).toEqual([
        { label: 'New Document', disabled: true, reason: 'A document is already open.' },
        { label: 'Save Document', disabled: true, reason: 'No unsaved changes.' },
        { label: 'Undo (Ctrl+Z)', disabled: true, reason: 'Nothing to undo.' },
        { label: 'Redo (Ctrl+Shift+Z / Ctrl+Y)', disabled: true, reason: 'Nothing to redo.' },
        { label: 'Rebuild Geometry', disabled: false, reason: null },
        { label: 'Export as Python', disabled: false, reason: null },
        { label: 'Import CAD as Assembly…', disabled: false, reason: null },
        { label: 'Import CAD as Body…', disabled: false, reason: null },
        { label: 'Create W7-X Generator…', disabled: false, reason: null },
        { label: 'Create W7-X Coil Study…', disabled: false, reason: null },
        { label: 'Create W7-X Coil Shape Study…', disabled: false, reason: null }
    ]);
    expect(await readRibbonMenu(page, toolbar, 'Sketch')).toEqual([
        { label: 'New Sketch', disabled: false, reason: null },
        { label: 'Edit Selected Sketch', disabled: false, reason: null }
    ]);
    expect(await readRibbonMenu(page, toolbar, 'Additive')).toEqual([
        { label: 'Pad (extrude add)', disabled: false, reason: null },
        { label: 'Pocket (extrude cut)', disabled: false, reason: null },
        { label: 'Revolve', disabled: false, reason: null },
        { label: 'Groove', disabled: false, reason: null },
        { label: 'Loft (join sketch sections)', disabled: false, reason: null },
        { label: 'Sweep (sketch along curve)', disabled: false, reason: null },
        { label: 'Pipe (circle along curve)', disabled: false, reason: null },
        { label: 'Helical Sweep (sketch along helix)', disabled: false, reason: null },
        { label: 'Coil Sweep (rectangular section along curve)', disabled: false, reason: null }
    ]);
    expect(await readRibbonMenu(page, toolbar, 'Boolean')).toEqual([
        { label: 'Boolean Fuse', disabled: false, reason: null },
        { label: 'Boolean Cut', disabled: false, reason: null },
        { label: 'Boolean Common', disabled: false, reason: null }
    ]);
    expect(await readRibbonMenu(page, toolbar, 'Dress-up')).toEqual([
        { label: 'Fillet', disabled: false, reason: null },
        { label: 'Chamfer', disabled: false, reason: null },
        { label: 'Shell', disabled: false, reason: null },
        { label: 'Draft', disabled: false, reason: null },
        { label: 'Move (translate body)', disabled: false, reason: null }
    ]);
    expect(await readRibbonMenu(page, toolbar, 'Pattern')).toEqual([
        { label: 'Linear Pattern', disabled: false, reason: null },
        { label: 'Circular Pattern', disabled: false, reason: null },
        { label: 'Mirror', disabled: false, reason: null },
        { label: 'Lattice', disabled: false, reason: null },
        { label: 'Hole', disabled: false, reason: null }
    ]);
    expect(await readRibbonMenu(page, toolbar, 'Inspect')).toEqual([
        { label: 'Measure (distance, angle, radius)', disabled: false, reason: null },
        { label: 'Measurements', disabled: false, reason: null },
        { label: 'Feature Tree', disabled: false, reason: null },
        { label: 'Model Outline', disabled: false, reason: null }
    ]);

    // Every feature command opens its own dialog with the right title.
    const featureDialogs: ReadonlyArray<readonly [string, string, string]> = [
        ['Additive', 'Pad (extrude add)', 'Pad'],
        ['Additive', 'Pocket (extrude cut)', 'Pocket'],
        ['Additive', 'Revolve', 'Revolve'],
        ['Additive', 'Groove', 'Groove'],
        ['Additive', 'Loft (join sketch sections)', 'Loft'],
        ['Additive', 'Sweep (sketch along curve)', 'Sweep'],
        ['Additive', 'Pipe (circle along curve)', 'Pipe'],
        ['Additive', 'Helical Sweep (sketch along helix)', 'HelicalSweep'],
        ['Additive', 'Coil Sweep (rectangular section along curve)', 'Coil Sweep'],
        ['Boolean', 'Boolean Fuse', 'BooleanFuse'],
        ['Boolean', 'Boolean Cut', 'BooleanCut'],
        ['Boolean', 'Boolean Common', 'BooleanCommon'],
        ['Dress-up', 'Fillet', 'Fillet'],
        ['Dress-up', 'Chamfer', 'Chamfer'],
        ['Dress-up', 'Shell', 'Shell'],
        ['Dress-up', 'Draft', 'Draft'],
        ['Dress-up', 'Move (translate body)', 'Translate'],
        ['Pattern', 'Linear Pattern', 'LinearPattern'],
        ['Pattern', 'Circular Pattern', 'CircularPattern'],
        ['Pattern', 'Mirror', 'Mirror'],
        ['Pattern', 'Lattice', 'Lattice'],
        ['Pattern', 'Hole', 'Hole']
    ];
    for (const [group, command, title] of featureDialogs) {
        await runPromotedOrMenuCommand(page, toolbar, group, command);
        await expectFeatureDialogThenCancel(page, title);
    }

    // New Sketch opens the datum picker; cancelling leaves the document alone.
    await runPromotedOrMenuCommand(page, toolbar, 'Sketch', 'New Sketch');
    const datumPicker = viewport.locator('.cad-sketch-datum-picker').first();
    await expect(datumPicker).toBeVisible({ timeout: 30_000 });
    await datumPicker.locator('button[aria-label="Cancel sketch setup"]').click();
    await expect(datumPicker).toBeHidden();

    // Edit Selected Sketch enters sketch mode; Finish Sketch returns to the model.
    await selectFirstSketch(page);
    await runPromotedOrMenuCommand(page, toolbar, 'Sketch', 'Edit Selected Sketch');
    const finish = viewport.locator('.cad-sketch-finish-button');
    await expect(finish).toBeVisible({ timeout: 30_000 });
    await finish.click();
    await expect(finish).toBeHidden({ timeout: 60_000 });
    await expect(viewport.locator('.cad-viewport-explode input[type=range]')).toBeVisible({ timeout: 120_000 });

    // Inspect actions have visible effects: the measurement status pill and
    // the two side panels.
    await runPromotedOrMenuCommand(page, toolbar, 'Inspect', 'Measure (distance, angle, radius)');
    const hint = viewport.locator('.cad-viewport-shading-hint');
    await expect(hint).toContainText('Measure: click the first point');
    await page.keyboard.press('Escape');
    await expect(hint).toBeHidden();
    await runPromotedOrMenuCommand(page, toolbar, 'Inspect', 'Measurements');
    const measureList = viewport.locator('.cad-measure-popover, .cad-viewport-measure-popover').first();
    await expect(measureList).toBeVisible();
    await measureList.locator('.cad-measure-header .cad-measure-row-remove').click();
    await expect(measureList).toBeHidden();
    await runPromotedOrMenuCommand(page, toolbar, 'Inspect', 'Feature Tree');
    await expect(page.locator('.cad-feature-tree-panel').first()).toBeVisible({ timeout: 30_000 });
    await runPromotedOrMenuCommand(page, toolbar, 'Inspect', 'Model Outline');
    await expect(page.locator('.cad-outline-panel').first()).toBeVisible({ timeout: 30_000 });

    // Rebuild stays healthy.
    await runPromotedOrMenuCommand(page, toolbar, 'Document', 'Rebuild Geometry');
    await expect(viewport.locator('.cad-viewport-explode input[type=range]')).toBeVisible({ timeout: 120_000 });
    await expect(viewport.locator('.cad-viewport-error-banner')).toBeHidden();

    // File-picker actions open the real Theia dialog; cancelling is inert.
    for (const command of [
        'Export as Python',
        'Import CAD as Assembly…',
        'Import CAD as Body…',
        'Create W7-X Generator…',
        'Create W7-X Coil Study…',
        'Create W7-X Coil Shape Study…'
    ]) {
        await runRibbonCommand(page, toolbar, 'Document', command);
        await cancelTheiaFileDialog(page);
    }

    expect(severeErrors(errors), `unexpected severe errors:\n${severeErrors(errors).join('\n')}`).toEqual([]);
    fs.rmSync(workingCopy, { force: true });
});

test('document actions save, undo, redo, and rebuild on a copy', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);
    const { viewport, toolbar } = await openCadFixture(page, 'cad-pincell.nuke-cad');

    // Save As a copy under the ignored test-results folder so Save writes never
    // touch the committed fixture.
    const target = await saveDocumentCopy(page, 'test-results/cad-viewport-tools-copy.nuke-cad');

    const units = toolbar.locator('.cad-document-toolbar-units .nuke-select-trigger');
    const dirty = toolbar.locator('.cad-document-toolbar-dirty');
    const saveTile = toolbar.locator('.nuke-ribbon-item:has(.codicon-save)');
    const undoTile = toolbar.locator('.nuke-ribbon-item:has(.codicon-nuke-cad-undo)');
    const redoTile = toolbar.locator('.nuke-ribbon-item:has(.codicon-nuke-cad-redo)');
    await expect(units).toHaveText('Unitless');
    await expect(dirty).toHaveCount(0);
    await expect(saveTile).toBeDisabled();
    await expect(undoTile).toBeDisabled();
    await expect(redoTile).toBeDisabled();

    // A store edit enables Save/Undo; Undo makes Redo available.
    await units.click();
    await page.locator('.nuke-select-list').first().getByRole('option', { name: 'mm' }).click();
    await expect(units).toHaveText('mm');
    await expect(dirty).toHaveCount(1);
    await expect(saveTile).toBeEnabled();
    await expect(undoTile).toBeEnabled();
    await expect(redoTile).toBeDisabled();

    await undoTile.click();
    await expect(units).toHaveText('Unitless');
    // Undo is a normal history restore: the document stays dirty until saved.
    await expect(dirty).toHaveCount(1);
    await expect(saveTile).toBeEnabled();
    await expect(redoTile).toBeEnabled();

    await redoTile.click();
    await expect(units).toHaveText('mm');
    await expect(dirty).toHaveCount(1);
    await expect(saveTile).toBeEnabled();

    // Save writes the active copy, not the fixture it came from.
    await saveTile.click();
    await expect(dirty).toHaveCount(0, { timeout: 15_000 });
    await expect(saveTile).toBeDisabled();
    const saved = JSON.parse(fs.readFileSync(target, 'utf8')) as { units?: string };
    expect(saved.units).toBe('mm');

    // Rebuild stays on the same model and never shows the failure banner.
    await runPromotedOrMenuCommand(page, toolbar, 'Document', 'Rebuild Geometry');
    await expect(viewport.locator('.cad-viewport-explode input[type=range]')).toBeVisible({ timeout: 120_000 });
    await expect(viewport.locator('.cad-viewport-error-banner')).toBeHidden();

    // Command-search actions return focus to the viewport: Escape must end
    // Measure instead of being ignored because focus fell back to <body>.
    const hint = viewport.locator('.cad-viewport-shading-hint');
    const searchTrigger = viewport.locator('.cad-command-search-trigger');
    await searchTrigger.click();
    const search = viewport.locator('.cad-command-search-popover');
    await expect(search).toBeVisible();
    await search.locator('.nuke-search-input-field').fill('Measure (distance');
    await search.locator('.cad-command-search-item').first().click();
    await expect(hint).toContainText('Measure: click the first point');
    await page.keyboard.press('Escape');
    await expect(hint).toBeHidden();

    const severe = severeErrors(errors);
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
    fs.rmSync(target, { force: true });
});

test('viewport chrome controls drive views, shading, section, explode, and measure', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);
    const { viewport } = await openCadFixture(page, 'cad-pincell.nuke-cad');

    const nav = viewport.locator('.nuke-viewer-nav-bar');
    const badge = viewport.locator('.nuke-view-badge');
    const hint = viewport.locator('.cad-viewport-shading-hint');
    const canvas = viewport.locator('canvas').first();
    await expect(nav).toBeVisible();
    await expect(nav.locator('button')).toHaveCount(9);
    await expect(viewport.locator('.nuke-view-cube-knob')).toHaveCount(6);
    await expect(badge).toHaveText('User view');

    // The four standard views update the badge, then fit + zoom change raster.
    await nav.locator('button', { hasText: 'ISO' }).click();
    await expect(badge).toHaveText('Iso view');
    await nav.locator('button', { hasText: 'T' }).click();
    await expect(badge).toHaveText('Top view');
    await nav.locator('button', { hasText: 'F' }).click();
    await expect(badge).toHaveText('Front view');
    await nav.locator('button', { hasText: 'R' }).click();
    await expect(badge).toHaveText('Right view');

    const fitted = await canvas.screenshot();
    await nav.locator('.codicon-zoom-in').click();
    await page.waitForTimeout(300);
    const zoomed = await canvas.screenshot();
    expect(zoomed.equals(fitted), 'Zoom in must change the rendered canvas').toBe(false);
    await nav.locator('.codicon-zoom-out').click();
    await nav.locator('.codicon-screen-full').click();
    await page.waitForTimeout(300);
    await expect(canvas).toBeVisible();

    // ViewCube knobs snap all six directions.
    const knob = (axis: string, negative: boolean) =>
        viewport.locator(
            `.nuke-view-cube-knob.nuke-view-cube-axis-${axis}${negative ? '.nuke-view-cube-knob-negative' : ':not(.nuke-view-cube-knob-negative)'}`
        );
    await knob('x', false).click();
    await expect(badge).toHaveText('Right view');
    await knob('y', false).click();
    await expect(badge).toHaveText('Back view');
    await knob('z', false).click();
    await expect(badge).toHaveText('Top view');
    await knob('x', true).click();
    await expect(badge).toHaveText('Left view');
    await knob('y', true).click();
    await expect(badge).toHaveText('Front view');
    await knob('z', true).click();
    await expect(badge).toHaveText('Bottom view');

    // Shading popover: four modes, x-ray ghost slider, opaque restore.
    const shadingTrigger = nav.locator('.cad-viewport-nav-button').first();
    const sectionTrigger = nav.locator('.cad-viewport-nav-button').nth(1);
    const popover = viewport.locator('.cad-viewport-nav-popover');
    await shadingTrigger.click();
    await expect(popover).toBeVisible();
    await expect(popover.locator('.cad-viewport-shading-item')).toHaveCount(4);
    await expect(popover.locator('.cad-viewport-shading-item.active')).toHaveText('Shaded');
    await popover
        .locator('.cad-viewport-shading-item')
        .filter({ hasText: /^Shaded \+ Edges$/ })
        .click();
    await expect(shadingTrigger).toHaveClass(/active/);
    await shadingTrigger.click();
    await expect(popover.locator('.cad-viewport-shading-item.active')).toHaveText('Shaded + Edges');
    await popover
        .locator('.cad-viewport-shading-item')
        .filter({ hasText: /^Edges Only$/ })
        .click();
    await expect(hint).toContainText('Edges-only: face/solid picking disabled');
    await shadingTrigger.click();
    await popover
        .locator('.cad-viewport-shading-item')
        .filter({ hasText: /^X-Ray$/ })
        .click();
    await expect(shadingTrigger).toHaveClass(/active/);
    await shadingTrigger.click();
    const ghost = popover.locator('.cad-viewport-ghost-row input[type=range]');
    await expect(ghost).toBeVisible();
    await ghost.focus();
    await page.keyboard.press('End');
    await expect(popover.locator('.cad-viewport-ghost-row span')).toHaveText('60%');
    await popover
        .locator('.cad-viewport-shading-item')
        .filter({ hasText: /^Shaded$/ })
        .click();
    await expect(shadingTrigger).not.toHaveClass(/active/);

    // Section mode: popover axes/flip/offset, status hint, Escape exits.
    await sectionTrigger.click();
    await expect(sectionTrigger).toHaveClass(/active/);
    const section = viewport.locator('.cad-viewport-section-popover');
    await expect(section).toBeVisible();
    await expect(hint).toContainText(/Section: Z @ \d+% — Esc to exit/);
    const axes = section.locator('.cad-viewport-section-axis');
    await expect(axes).toHaveCount(3);
    await axes.nth(0).click();
    await expect(axes.nth(0)).toHaveClass(/active/);
    await axes.nth(1).click();
    await expect(axes.nth(1)).toHaveClass(/active/);
    await axes.nth(2).click();
    await expect(axes.nth(2)).toHaveClass(/active/);
    const flip = section.locator('.cad-viewport-section-flip');
    await flip.click();
    await expect(flip).toHaveClass(/active/);
    const offset = section.locator('.cad-viewport-section-slider-row input[type=range]');
    await offset.focus();
    await page.keyboard.press('End');
    await expect(hint).toContainText(/Section: Z @ 100% — Esc to exit/);
    // Range inputs consume Escape; focus the viewport container first.
    await viewport.focus();
    await page.keyboard.press('Escape');
    await expect(section).toBeHidden();
    await expect(sectionTrigger).not.toHaveClass(/active/);
    await expect(hint).toBeHidden();

    // Explode is viewport-only and reaches 100% / returns to assembled at 0%.
    const explode = viewport.locator('.cad-viewport-explode input[type=range]');
    await explode.focus();
    await page.keyboard.press('End');
    await expect(viewport.locator('.cad-viewport-explode-value')).toHaveText('100%');
    await expect(hint).toContainText('Explode 100%');
    await page.keyboard.press('Home');
    await expect(viewport.locator('.cad-viewport-explode-value')).toHaveText('0%');
    await expect(hint).toBeHidden();

    // Measure: ribbon toggle, escape, and the list's three capture modes.
    const measureTile = viewport.locator('.nuke-ribbon-item:has(.codicon-nuke-cad-measure)');
    await measureTile.click();
    await expect(hint).toContainText('Measure: click the first point');
    await page.keyboard.press('Escape');
    await expect(hint).toBeHidden();
    const measureListTile = viewport.locator('.nuke-ribbon-item:has(.codicon-list-unordered)');
    await measureListTile.click();
    const measureList = viewport.locator('.cad-measure-popover, .cad-viewport-measure-popover').first();
    await expect(measureList).toBeVisible();
    await expect(measureList.locator('.cad-measure-mode')).toHaveCount(3);
    await expect(measureList.locator('.cad-measure-clear')).toBeDisabled();
    await measureList.locator('.cad-measure-mode', { hasText: 'Angle' }).click();
    await expect(measureList.locator('.cad-measure-mode', { hasText: 'Angle' })).toHaveClass(/active/);
    await measureList.locator('.cad-measure-header .cad-measure-row-remove').click();
    await expect(measureList).toBeHidden();
    await measureTile.click();
    await expect(hint).toContainText('Measure: click the first point');
    await page.keyboard.press('Escape');
    await measureListTile.click();
    await measureList.locator('.cad-measure-mode', { hasText: 'Radius' }).click();
    await measureList.locator('.cad-measure-header .cad-measure-row-remove').click();
    await measureTile.click();
    await expect(hint).toContainText('Measure: click a circular edge');
    await page.keyboard.press('Escape');
    await expect(hint).toBeHidden();
    // Restore the default capture mode before the command-search regression.
    await measureListTile.click();
    await expect(measureList).toBeVisible();
    await measureList.locator('.cad-measure-mode', { hasText: 'Distance' }).click();
    await measureList.locator('.cad-measure-header .cad-measure-row-remove').click();
    await expect(measureList).toBeHidden();

    // Command search runs an action and keeps the viewport keyboard live.
    await viewport.locator('.cad-command-search-trigger').click();
    const search = viewport.locator('.cad-command-search-popover');
    await expect(search).toBeVisible();
    await search.locator('.nuke-search-input-field').fill('Model Outline');
    await search.locator('.cad-command-search-item').first().click();
    await expect(page.locator('.cad-outline-panel').first()).toBeVisible({ timeout: 30_000 });
    await viewport.locator('.cad-command-search-trigger').click();
    await expect(search).toBeVisible();
    await search.locator('.nuke-search-input-field').fill('Measure (distance');
    await search.locator('.cad-command-search-item').first().click();
    await expect(hint).toContainText('Measure: click the first point');
    await page.keyboard.press('Escape');
    await expect(hint).toBeHidden();

    const severe = severeErrors(errors);
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});

test('empty viewport launchers open their pickers and cancel cleanly', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);
    await closeAllEditors(page);
    await runCommand(page, 'Open CAD Viewport');

    const viewport = page.locator('.cad-viewport').first();
    await expect(viewport).toBeVisible({ timeout: 30_000 });
    const welcome = viewport.locator('.cad-viewport-welcome');
    await expect(welcome).toBeVisible({ timeout: 10_000 });
    const primary = welcome.locator('.cad-viewport-document-empty-primary');
    const openModel = welcome.locator('.open-cad-model-button');
    const importAssembly = welcome.locator('.import-cad-assembly-button');
    const importBody = welcome.locator('.import-cad-body-button');
    await expect(primary).toContainText('New Document');
    await expect(openModel).toBeVisible();
    await expect(importAssembly).toBeVisible();
    await expect(importBody).toBeVisible();

    // New Document opens the template picker; Cancel closes it untouched.
    await primary.click();
    const picker = page.locator('.cad-template-picker').first();
    await expect(picker).toBeVisible({ timeout: 10_000 });
    await picker.locator('.cad-template-picker-actions button', { hasText: 'Cancel' }).click();
    await expect(picker).toBeHidden();
    await expect(welcome).toBeVisible();

    // The three file-backed launchers all open the Theia picker.
    for (const button of [openModel, importAssembly, importBody]) {
        await button.click();
        await cancelTheiaFileDialog(page);
        await expect(welcome).toBeVisible();
    }

    const severe = severeErrors(errors);
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});
