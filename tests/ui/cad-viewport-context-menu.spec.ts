import { test, expect, type Page } from '@playwright/test';
import { collectErrors, waitForWorkbench, openFileByQuickOpen, runCommand } from './helpers';

/**
 * Viewport right-click context menu and draggable feature dialog smoke.
 *
 * Right-clicking the canvas opens the viewport's own menu (no browser
 * default): on a solid it offers Edit Feature (attributed through the solid's
 * body), Find in Feature Tree, the three measure tools, Fit to Solid, and
 * Hide/Isolate; on empty space it offers Fit All and Reset Explode (disabled
 * at 0%). Clear Selection (Esc) appears only while something is selected, and
 * the real bindings carry right-aligned hints (F, Esc). Select Other… appears
 * when the pointer ray crosses more than one distinct face, opens an anchored
 * candidate list, and advertises Alt+click cycling. The feature dialog it
 * opens drags by its header and resets on a header double-click, like the
 * sketch chrome panels.
 *
 * The menu only appears once a tessellation is on screen, which requires a
 * working CAD backend. Without one the build fails and the viewport shows its
 * error banner instead — that environment skips (same philosophy as the
 * backend env gates in the Python e2e suite).
 */

test.setTimeout(180_000);

interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

async function rectOf(locator: ReturnType<Page['locator']>): Promise<Rect> {
    const rect = await locator.boundingBox();
    expect(rect).not.toBeNull();
    return rect as Rect;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('right-click context menu and draggable feature dialog', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    await openFileByQuickOpen(page, 'gui_pincell.nuke-cad');

    const viewport = page.locator('.cad-viewport').first();
    const canvas = viewport.locator('canvas').first();
    const errorBanner = viewport.locator('.cad-viewport-error-banner');
    // The canvas element exists before the build finishes; wait for the model
    // (explode slider, which renders with the tessellation) or the
    // build-failure banner.
    const navCluster = viewport.locator('.cad-viewport-explode input[type=range]');
    await expect(navCluster.or(errorBanner).first()).toBeVisible({ timeout: 120_000 });
    if (await errorBanner.isVisible()) {
        test.skip(true, `CAD backend unavailable: ${(await errorBanner.textContent()) ?? 'build failed'}`);
    }
    await expect(canvas).toBeVisible();
    // The Select Other assertion needs the Model Outline's selected row; open
    // it explicitly if the fresh profile did not reveal it with the model.
    if (!(await page.locator('.cad-outline-panel').isVisible())) {
        await runCommand(page, 'Open Model Outline');
    }
    const outline = page.locator('.cad-outline-panel').first();
    await expect(outline).toBeVisible({ timeout: 30_000 });
    const box = await rectOf(canvas);
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const menu = viewport.locator('.cad-viewport-context-menu');

    // Select the solid first: Clear Selection is selection-aware.
    await page.mouse.click(center.x, center.y);
    await page.mouse.click(center.x, center.y, { button: 'right' });
    await expect(menu).toBeVisible();
    const labelTexts = async (): Promise<string[]> =>
        (await menu.locator('.cad-viewport-context-menu-label').allTextContents()).map((text) => text.trim());
    const solidLabels = await labelTexts();
    expect(solidLabels).toEqual([
        'Edit Feature…',
        'Find in Feature Tree',
        'Select Other…',
        'Appearance…',
        'Measure Distance',
        'Measure Angle',
        'Measure Radius',
        'Fit to Solid',
        'Hide Solid',
        'Isolate Solid',
        'Clear Selection'
    ]);
    const editItem = menu.locator('.cad-viewport-context-menu-item', { hasText: 'Edit Feature…' });
    await expect(editItem).toBeEnabled();
    const selectOtherItem = menu.locator('.cad-viewport-context-menu-item', { hasText: 'Select Other…' });
    await expect(selectOtherItem).toBeVisible();
    await expect(selectOtherItem.locator('.cad-viewport-context-menu-hint')).toHaveText('Alt+click');
    await expect(selectOtherItem).toHaveAttribute('aria-keyshortcuts', 'Alt+click');
    const fitItem = menu.locator('.cad-viewport-context-menu-item', { hasText: 'Fit to Solid' });
    await expect(fitItem.locator('.cad-viewport-context-menu-hint')).toHaveText('F');
    await expect(fitItem).toHaveAttribute('aria-keyshortcuts', 'F');
    const clearItem = menu.locator('.cad-viewport-context-menu-item', { hasText: 'Clear Selection' });
    await expect(clearItem.locator('.cad-viewport-context-menu-hint')).toHaveText('Esc');
    await expect(clearItem).toHaveAttribute('aria-keyshortcuts', 'Escape');
    await menu.screenshot({ path: 'test-results/cad-context-menu.png' });

    // Measure Distance activates the tool: the status pill takes over the hint.
    await menu.locator('.cad-viewport-context-menu-item', { hasText: 'Measure Distance' }).click();
    await expect(menu).toBeHidden();
    await expect(viewport.locator('.cad-viewport-shading-hint')).toContainText('Measure: click the first point');
    await page.keyboard.press('Escape');
    await expect(viewport.locator('.cad-viewport-shading-hint')).toBeHidden();

    // Escape closes the menu without activating anything, and the menu owns the
    // key: the selection survives for the empty-space menu below.
    await page.mouse.click(center.x, center.y, { button: 'right' });
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    // Select Other… lists the overlapping faces under the pointer, labelled by
    // body. Picking a row selects that face; the Model Outline highlights the
    // owning body. The candidate labels must not all be the nearest solid.
    await page.mouse.click(center.x, center.y, { button: 'right' });
    await expect(menu).toBeVisible();
    await menu.locator('.cad-viewport-context-menu-item', { hasText: 'Select Other…' }).click();
    await expect(menu).toBeHidden();
    const selectOther = viewport.locator('.cad-select-other-menu');
    await expect(selectOther).toBeVisible();
    const candidateRows = selectOther.locator('.cad-select-other-row');
    await expect(candidateRows.first()).toBeVisible();
    expect(await candidateRows.count()).toBeGreaterThanOrEqual(2);
    const candidateLabels = (await selectOther.locator('.cad-select-other-label').allTextContents()).map((text) => text.trim());
    expect(new Set(candidateLabels).size).toBeGreaterThanOrEqual(2);
    const secondRow = candidateRows.nth(1);
    const pickedBodyLabel = ((await secondRow.locator('.cad-select-other-label').textContent()) ?? '').trim();
    const pickedSolidId = (await secondRow.getAttribute('data-solid-id')) ?? '';
    await expect(secondRow.locator('.cad-select-other-detail')).toHaveText(/^face \d+$/);
    await expect(secondRow.locator('.cad-select-other-distance')).toHaveText(/^\d/);
    await selectOther.screenshot({ path: 'test-results/cad-select-other.png' });
    await secondRow.click();
    await expect(selectOther).toBeHidden();
    // With a region manifest the row carries the body label; documents built
    // without one (this pincell fixture) fall back to `mat_<solidId>`.
    const selectedOutlineLabel = outline.locator('.outline-row.selected .outline-row-label-text').first();
    await expect(selectedOutlineLabel).toHaveText(new RegExp(`^(?:${escapeRegExp(pickedBodyLabel)}|mat_${pickedSolidId})$`));

    // Empty space: bottom-left corner (clear of the model, toolbar, status pill, and nav cluster).
    await page.mouse.click(box.x + 20, box.y + box.height - 20, { button: 'right' });
    await expect(menu).toBeVisible();
    const emptyLabels = await labelTexts();
    expect(emptyLabels).toEqual(['Clear Selection', 'Fit All', 'Reset Explode', 'Show All Solids', 'Show Section View']);
    await expect(
        menu.locator('.cad-viewport-context-menu-item', { hasText: 'Clear Selection' }).locator('.cad-viewport-context-menu-hint')
    ).toHaveText('Esc');
    await expect(menu.locator('.cad-viewport-context-menu-item', { hasText: 'Reset Explode' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    // Edit Feature… opens the dialog; drag by the header; double-click resets.
    await page.mouse.click(center.x, center.y, { button: 'right' });
    await expect(menu).toBeVisible();
    await menu.locator('.cad-viewport-context-menu-item', { hasText: 'Edit Feature…' }).click();
    const dialog = viewport.locator('.nuke-dialog');
    await expect(dialog).toBeVisible();
    const header = dialog.locator('.nuke-dialog-header');
    const initial = await rectOf(dialog);
    const handle = await rectOf(header);
    await page.mouse.move(handle.x + 40, handle.y + 8);
    await page.mouse.down();
    await page.mouse.move(handle.x + 160, handle.y + 68, { steps: 6 });
    await page.mouse.up();
    const dragged = await rectOf(dialog);
    expect(Math.abs(dragged.x - initial.x) + Math.abs(dragged.y - initial.y)).toBeGreaterThan(60);
    // The header moved with the dialog: re-locate it before the reset gesture.
    const movedHandle = await rectOf(header);
    await page.mouse.dblclick(movedHandle.x + 40, movedHandle.y + 8);
    const reset = await rectOf(dialog);
    expect(Math.abs(reset.x - initial.x)).toBeLessThan(5);
    expect(Math.abs(reset.y - initial.y)).toBeLessThan(5);
    await dialog.locator('.nuke-dialog-close').click();
    await expect(dialog).toBeHidden();

    // Fillet dialog offers the tangent-chain option for edge picks. Toggling it
    // arms the pick without blocking the dialog; the pick stays cancellable.
    const toolbar = viewport.locator('.cad-document-toolbar').first();
    await expect(toolbar).toBeVisible();
    await toolbar.locator('.cad-document-toolbar-search').click();
    const commandSearch = viewport.locator('.cad-command-search-popover');
    await expect(commandSearch).toBeVisible();
    const commandInput = commandSearch.locator('.nuke-search-input-field');
    await commandInput.fill('fillet');
    await commandInput.press('Enter');
    await expect(commandSearch).toBeHidden();
    const filletDialog = viewport.locator('.nuke-dialog').first();
    await expect(filletDialog).toBeVisible();
    await expect(filletDialog.locator('.nuke-dialog-title')).toHaveText('Fillet');
    const tangentChain = filletDialog.getByLabel('Tangent chain');
    await expect(tangentChain).toBeVisible();
    await expect(tangentChain).not.toBeChecked();
    // NukeCheckbox hides the native input; click its label to toggle it.
    await filletDialog.locator('label.nuke-checkbox', { hasText: 'Tangent chain' }).click();
    await expect(tangentChain).toBeChecked();
    await filletDialog.locator('button', { hasText: 'Pick edge' }).click();
    const cancelPick = filletDialog.locator('button', { hasText: 'Cancel pick' });
    await expect(cancelPick).toBeVisible();
    await expect(tangentChain).toBeChecked();
    await cancelPick.click();
    await expect(filletDialog.locator('button', { hasText: 'Pick edge' })).toBeVisible();
    await filletDialog.locator('.nuke-dialog-footer button', { hasText: 'Cancel' }).click();
    await expect(filletDialog).toBeHidden();

    // Escape clears a document-mode selection: select, press Escape, reopen the
    // menu, and Clear Selection is gone.
    await page.mouse.click(center.x, center.y);
    await page.keyboard.press('Escape');
    await page.mouse.click(center.x, center.y, { button: 'right' });
    await expect(menu).toBeVisible();
    const afterEscapeLabels = await labelTexts();
    expect(afterEscapeLabels).toEqual([
        'Edit Feature…',
        'Find in Feature Tree',
        'Select Other…',
        'Appearance…',
        'Measure Distance',
        'Measure Angle',
        'Measure Radius',
        'Fit to Solid',
        'Hide Solid',
        'Isolate Solid'
    ]);

    // Appearance… opens the per-body display-only override dialog. The menu is
    // already open here; the dialog's opacity number input is the keyboard- and
    // test-friendly mirror of the slider.
    const openAppearance = async (point: { x: number; y: number } = center) => {
        await page.mouse.click(point.x, point.y, { button: 'right' });
        await expect(menu).toBeVisible();
        await menu.locator('.cad-viewport-context-menu-item', { hasText: 'Appearance…' }).click();
        const dialog = viewport.locator('.nuke-dialog');
        await expect(dialog).toBeVisible();
        return dialog;
    };

    await menu.locator('.cad-viewport-context-menu-item', { hasText: 'Appearance…' }).click();
    let appearanceDialog = viewport.locator('.nuke-dialog');
    await expect(appearanceDialog).toBeVisible();
    await expect(appearanceDialog.locator('.nuke-dialog-title')).toContainText('Appearance');
    await expect(appearanceDialog.locator('.cad-body-appearance-subtitle')).not.toBeEmpty();
    // Single-body selection: the multi-body option stays hidden.
    await expect(appearanceDialog.getByLabel('Apply to all selected bodies')).toHaveCount(0);
    const opacityPercent = appearanceDialog.getByLabel('Opacity percent');
    await expect(opacityPercent).toHaveValue('100');

    // Preset library: save the current draft, apply it back, then delete it.
    // Presets are user preferences, not document data.
    const presetTrigger = appearanceDialog.getByRole('combobox', { name: 'Appearance preset' });
    await expect(presetTrigger).toContainText('None');
    const colorTrigger = appearanceDialog.locator('.nuke-color-picker-trigger');
    await colorTrigger.click();
    let hexInput = page.locator('.nuke-color-hex-input input');
    await expect(hexInput).toBeVisible();
    await hexInput.fill('#ff8800');
    await hexInput.press('Enter');
    await expect(appearanceDialog.locator('.nuke-color-value')).toHaveText('#FF8800');
    await opacityPercent.fill('50');
    await appearanceDialog.locator('button', { hasText: 'Save preset…' }).click();
    const presetNameInput = page.locator('.quick-input-widget input');
    await expect(presetNameInput).toBeVisible({ timeout: 30_000 });
    await presetNameInput.fill('Highlight');
    await presetNameInput.press('Enter');
    await expect(presetNameInput).toBeHidden({ timeout: 30_000 });
    await expect(presetTrigger).toContainText('Highlight');

    // Change the draft, then select the preset: color and opacity come back.
    await opacityPercent.fill('20');
    await colorTrigger.click();
    hexInput = page.locator('.nuke-color-hex-input input');
    await hexInput.fill('#00ff00');
    await hexInput.press('Enter');
    await expect(appearanceDialog.locator('.nuke-color-value')).toHaveText('#00FF00');
    await presetTrigger.click();
    const presetList = page.locator('.nuke-select-list');
    await expect(presetList.getByRole('option', { name: 'Highlight' })).toBeVisible();
    await presetList.getByRole('option', { name: 'Highlight' }).click();
    await expect(opacityPercent).toHaveValue('50');
    await expect(appearanceDialog.locator('.nuke-color-value')).toHaveText('#ff8800');

    // Delete the selected preset; the option disappears and the trigger falls
    // back to None.
    await appearanceDialog.getByLabel('Delete preset').click();
    await expect(presetTrigger).toContainText('None');
    await presetTrigger.click();
    await expect(presetList.getByRole('option', { name: 'Highlight' })).toHaveCount(0);
    await appearanceDialog.locator('.nuke-dialog-title').click();

    await opacityPercent.fill('50');
    await appearanceDialog.locator('button', { hasText: 'OK' }).click();
    await expect(appearanceDialog).toBeHidden();
    await viewport.screenshot({ path: 'test-results/cad-body-appearance.png' });

    // The override persists in the document: reopening prefills 50, and
    // Remove override clears it back to the default 100.
    appearanceDialog = await openAppearance();
    await expect(appearanceDialog.getByLabel('Opacity percent')).toHaveValue('50');
    await appearanceDialog.locator('button', { hasText: 'Remove override' }).click();
    await expect(appearanceDialog).toBeHidden();

    appearanceDialog = await openAppearance();
    await expect(appearanceDialog.getByLabel('Opacity percent')).toHaveValue('100');
    await appearanceDialog.locator('.nuke-dialog-close').click();
    await expect(appearanceDialog).toBeHidden();

    // Multi-body apply: select the centre solid, add a volume row from the
    // outline, then apply the appearance to every body owning the selection.
    await page.mouse.click(center.x, center.y);
    const outlineRows = page.locator('.cad-outline-panel').first().locator('.outline-row');
    await outlineRows.first().click({ modifiers: ['Control'] });
    appearanceDialog = await openAppearance();
    const applyAll = appearanceDialog.getByLabel('Apply to all selected bodies');
    await expect(applyAll).toBeVisible();
    await expect(applyAll).not.toBeChecked();
    await appearanceDialog.locator('label.nuke-checkbox', { hasText: 'Apply to all selected bodies' }).click();
    await expect(applyAll).toBeChecked();
    await appearanceDialog.getByLabel('Opacity percent').fill('50');
    await appearanceDialog.locator('button', { hasText: 'OK' }).click();
    await expect(appearanceDialog).toBeHidden();

    // The centre body (part of the selection) carries the override; the
    // multi-body commit itself is covered by the store unit tests.
    appearanceDialog = await openAppearance();
    await expect(appearanceDialog.getByLabel('Opacity percent')).toHaveValue('50');
    await appearanceDialog.locator('.nuke-dialog-close').click();
    await expect(appearanceDialog).toBeHidden();

    // Find in Feature Tree selects the attributed feature and opens its panel.
    // Last canvas-coordinate step: the panel shrinks the viewport.
    await page.mouse.click(center.x, center.y, { button: 'right' });
    await expect(menu).toBeVisible();
    await menu.locator('.cad-viewport-context-menu-item', { hasText: 'Find in Feature Tree' }).click();
    const featureTree = page.locator('.cad-feature-tree-panel');
    await expect(featureTree).toBeVisible();
    await expect(featureTree.locator('.feature-tree-row.feature.selected').first()).toBeVisible();

    const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});
