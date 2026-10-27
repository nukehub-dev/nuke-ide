import { test, expect } from '@playwright/test';
import { closeAllEditors, collectErrors, runCommand, waitForWorkbench } from './helpers';

/**
 * Sketch-mode chrome parity with FreeCAD's Sketcher: primary constraint chips
 * (plus a More select for the tail kinds), a solver/DOF status badge row, and
 * explicit snap/grid state. Also covers the labelled, scrollable tool palette
 * clearing the status line. Runs at 1280 px so the constraint bar has to clear
 * the top-right Finish Sketch pill.
 */

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(180_000);

test('sketch constraint chips, solver badges, grid toggle, and palette groups', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    await closeAllEditors(page);
    await runCommand(page, 'New CAD Document');
    const viewport = page.locator('.cad-viewport').first();
    await expect(viewport).toBeVisible({ timeout: 30_000 });

    const templatePicker = page.locator('.cad-template-picker').first();
    await expect(templatePicker).toBeVisible({ timeout: 10_000 });
    await templatePicker.locator('button', { hasText: 'Empty document' }).first().click();
    // The empty template opens the Create Sketch plane picker directly.
    const datumPicker = viewport.locator('.cad-sketch-datum-picker').first();
    await expect(datumPicker).toBeVisible({ timeout: 30_000 });
    // The overlay mounts after the viewport's cold controller import.
    await expect(viewport.locator('.cad-document-toolbar').first()).toBeVisible({ timeout: 60_000 });
    await datumPicker.locator('button', { hasText: 'Start Sketch' }).first().click();
    await expect(viewport.locator('.cad-sketch-finish-button')).toBeVisible({ timeout: 30_000 });

    const constraintBar = viewport.locator('.cad-sketch-constraint-bar').first();
    await expect(constraintBar).toBeVisible();
    for (const label of [
        'Coincident',
        'Horizontal',
        'Vertical',
        'Parallel',
        'Perpendicular',
        'Tangent',
        'Equal',
        'Distance',
        'Radius',
        'Angle'
    ]) {
        await expect(constraintBar.getByRole('button', { name: label, exact: true })).toBeVisible();
    }

    // Clicking a chip arms the constraint; clicking it again (or Escape) cancels.
    const horizontal = constraintBar.getByRole('button', { name: 'Horizontal', exact: true });
    await horizontal.click();
    await expect(horizontal).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(horizontal).toHaveAttribute('aria-pressed', 'false');

    // The tail kinds stay reachable through the compact More select.
    const moreConstraints = constraintBar.locator('.nuke-select-trigger');
    await expect(moreConstraints.locator('.nuke-select-value')).toHaveText('More');
    await moreConstraints.click();
    const constraintOptions = page.locator('.nuke-select-list').first();
    await expect(constraintOptions).toBeVisible();
    for (const label of ['None', 'Fix', 'Concentric', 'Symmetry', 'Point on Object']) {
        await expect(constraintOptions.locator('.nuke-select-option-label', { hasText: label })).toHaveText(label);
    }
    await page.keyboard.press('Escape');
    await expect(constraintOptions).toBeHidden();

    const dofBadge = viewport.locator('.cad-sketch-status-badge.cad-sketch-status-dof');
    await expect(dofBadge).toHaveText(/^\d+ DOF$|^Fully constrained$/);
    await expect(viewport.locator('.cad-sketch-status-badge').filter({ hasText: /^Snap / })).toBeVisible();

    // Explicit grid toggle: visible state and aria-pressed stay in sync.
    const gridToggle = viewport.getByRole('button', { name: 'Toggle Sketch Grid' });
    await expect(gridToggle).toHaveAttribute('aria-pressed', 'true');
    await gridToggle.click();
    await expect(gridToggle).toHaveAttribute('aria-pressed', 'false');
    await gridToggle.click();
    await expect(gridToggle).toHaveAttribute('aria-pressed', 'true');

    // The palette labels its groups and its bottom edge clears the status line.
    const toolbar = viewport.locator('.cad-sketch-toolbar').first();
    await expect(toolbar).toBeVisible();
    const groupLabels = toolbar.locator('.cad-sketch-toolbar-group-label');
    await expect(groupLabels).toHaveCount(4);
    for (const caption of ['Draw', 'Reference', 'Inspect', 'Transform']) {
        const label = groupLabels.filter({ hasText: caption });
        await expect(label).toHaveCount(1);
        await expect(label).toBeVisible();
    }
    // Focusing the grid toggle can scroll the body; reset before checking the
    // first caption, then verify scrolling still reaches the last group.
    const toolbarBody = toolbar.locator('.cad-sketch-toolbar-body');
    await toolbarBody.evaluate((element) => {
        element.scrollTop = 0;
    });
    await expect(groupLabels.filter({ hasText: 'Draw' })).toBeInViewport();
    const statusLine = viewport.locator('.cad-sketch-status-line').first();
    const [toolbarBox, statusBox] = await Promise.all([toolbar.boundingBox(), statusLine.boundingBox()]);
    expect(toolbarBox, 'sketch toolbar has no bounding box').not.toBeNull();
    expect(statusBox, 'status line has no bounding box').not.toBeNull();
    expect(toolbarBox!.y + toolbarBox!.height).toBeLessThanOrEqual(statusBox!.y + 0.5);

    // The body scrolls under a fixed header; the last transform action stays reachable.
    const joinButton = toolbar.locator('button:has(.codicon-nuke-cad-join)');
    await expect(joinButton).toHaveCount(1);
    await toolbarBody.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
    });
    expect(await toolbarBody.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(joinButton).toBeInViewport({ ratio: 0.9 });
    await expect(groupLabels.filter({ hasText: 'Transform' })).toBeInViewport();
    await expect(toolbar.locator('.cad-sketch-toolbar-title')).toBeInViewport();
    await toolbarBody.evaluate((element) => {
        element.scrollTop = 0;
    });

    // The constraint row never overlaps the top-right Finish Sketch pill.
    const [barBox, finishBox] = await Promise.all([
        constraintBar.boundingBox(),
        viewport.locator('.cad-sketch-finish-button').boundingBox()
    ]);
    expect(barBox, 'constraint bar has no bounding box').not.toBeNull();
    expect(finishBox, 'finish button has no bounding box').not.toBeNull();
    expect(barBox!.x + barBox!.width).toBeLessThan(finishBox!.x + 1);

    expect(await viewport.evaluate((element) => element.scrollTop)).toBe(0);
    await viewport.screenshot({ path: 'test-results/cad-sketch-ui.png' });
    await page.screenshot({ path: 'test-results/cad-sketch-ui-full.png' });

    const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});

test('New Sketch opens the datum picker after reopening the CAD viewport', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);
    await closeAllEditors(page);

    await runCommand(page, 'Open CAD Viewport');
    const viewport = page.locator('.cad-viewport').first();
    await expect(viewport).toBeVisible({ timeout: 30_000 });

    // Close and reopen the viewport; New Sketch must not stop at an empty
    // document while the controller's lazy mount is still pending.
    await closeAllEditors(page);
    await runCommand(page, 'Open CAD Viewport');
    await expect(viewport).toBeVisible({ timeout: 30_000 });
    await runCommand(page, 'New Sketch');

    await expect(viewport.locator('.cad-sketch-datum-picker')).toBeVisible({ timeout: 90_000 });
    await expect(viewport.locator('.cad-viewport-document-empty')).toBeHidden();
    await expect(viewport.locator('.cad-viewport-welcome')).toBeHidden();

    const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});

test('edit sketch re-enters directly and transform tools use the selected geometry', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);
    await closeAllEditors(page);
    await runCommand(page, 'New CAD Document');
    const viewport = page.locator('.cad-viewport').first();
    await expect(viewport).toBeVisible({ timeout: 30_000 });

    const templatePicker = page.locator('.cad-template-picker').first();
    await expect(templatePicker).toBeVisible({ timeout: 10_000 });
    await templatePicker.locator('button', { hasText: 'Empty document' }).first().click();
    const datumPicker = viewport.locator('.cad-sketch-datum-picker').first();
    await expect(datumPicker).toBeVisible({ timeout: 30_000 });
    await expect(viewport.locator('.cad-document-toolbar').first()).toBeVisible({ timeout: 60_000 });
    await datumPicker.locator('button', { hasText: 'Start Sketch' }).first().click();
    const finish = viewport.locator('.cad-sketch-finish-button');
    await expect(finish).toBeVisible({ timeout: 30_000 });
    const sketchToolbar = viewport.locator('.cad-sketch-toolbar').first();
    const selectionBadge = viewport.locator('.cad-sketch-status-badge').filter({ hasText: /^\d+ selected$/ });
    const constructionBadge = viewport.locator('.cad-sketch-status-badge').filter({ hasText: /^Construction$/ });
    const transformIcons = ['move', 'copy', 'rotate', 'mirror', 'scale', 'array', 'offset'];
    const transformButton = (icon: string) => sketchToolbar.locator(`button:has(.codicon-nuke-cad-${icon})`);

    // An empty selection hides the selection badge and disables every
    // selection transform, so the action cannot only fail after the click.
    await expect(selectionBadge).toBeHidden();
    await expect(constructionBadge).toBeHidden();
    for (const icon of transformIcons) {
        await expect(transformButton(icon)).toBeDisabled();
    }

    const viewportBox = await viewport.boundingBox();
    expect(viewportBox, 'viewport has no bounding box').not.toBeNull();
    const click = async (x: number, y: number): Promise<void> => {
        await page.mouse.click(viewportBox!.x + x, viewportBox!.y + y);
        await page.waitForTimeout(120);
    };
    const hint = viewport.locator('.cad-sketch-status-line .cad-sketch-status-hints');
    // Finishing a sketch on an unsaved document can prompt for a save path
    // (the rebuild auto-save); the in-memory document is enough for this test.
    const dismissSaveDialog = async (): Promise<void> => {
        const shell = page.locator('#theia-dialog-shell');
        try {
            await shell.waitFor({ state: 'visible', timeout: 3000 });
        } catch {
            return;
        }
        await shell.getByRole('button', { name: 'Cancel' }).click();
        await expect(shell).toBeHidden();
    };

    // First sketch: one horizontal line.
    await page.keyboard.press('l');
    await click(430, 420);
    await click(760, 420);
    await finish.click();
    await expect(viewport.locator('.cad-document-toolbar').first()).toBeVisible({ timeout: 30_000 });
    await dismissSaveDialog();

    // Edit Selected Sketch must enter directly on the stored datum and put
    // keyboard focus back on the viewport for the single-key shortcuts.
    await page.locator('.feature-tree-row.sketch').first().click();
    await viewport.getByRole('button', { name: 'Edit Selected Sketch' }).click();
    await expect(finish).toBeVisible({ timeout: 30_000 });
    await expect(datumPicker).toBeHidden();
    await page.keyboard.press('l');
    await expect(viewport.locator('.cad-sketch-toolbar button:has(.codicon-nuke-cad-line).active')).toHaveCount(1);
    await click(500, 520);
    await click(700, 520);

    // Snapping off must not break picking: select the first line, move it, then
    // mirror it across a fresh axis line.
    const snap = viewport.locator('.cad-sketch-toolbar button:has(.codicon-nuke-cad-snap)');
    if ((await snap.getAttribute('class'))?.includes('active')) {
        await snap.click();
    }
    await page.keyboard.press('s');
    await click(600, 420);
    // Selecting a primitive shows the selection badge and arms the transforms.
    await expect(selectionBadge).toHaveText('1 selected');
    for (const icon of transformIcons) {
        await expect(transformButton(icon)).toBeEnabled();
    }

    // Construction is a status-line state, not only a toolbar highlight.
    const constructionToggle = sketchToolbar.locator('button:has(.codicon-nuke-cad-construction)');
    await constructionToggle.click();
    await expect(constructionBadge).toHaveText('Construction');
    await expect(constructionBadge).toBeVisible();
    await constructionToggle.click();
    await expect(constructionBadge).toBeHidden();

    // The transform value popovers must escape the palette's scroll clipping.
    await transformButton('scale').click();
    const scalePopover = page.locator('.cad-sketch-dimension-popover').filter({ hasText: 'Scale' });
    await expect(scalePopover).toBeVisible();
    await scalePopover.getByRole('button', { name: 'Cancel' }).click();
    await expect(scalePopover).toBeHidden();
    await page.keyboard.press('v');
    await click(600, 420);
    await click(600, 470);
    await expect(hint).not.toContainText('needs a selection');

    // Clearing the selection hides the badge and re-disables the transforms.
    await page.keyboard.press('Escape');
    await expect(selectionBadge).toBeHidden();
    for (const icon of transformIcons) {
        await expect(transformButton(icon)).toBeDisabled();
    }
    await finish.click();
    await expect(viewport.locator('.cad-document-toolbar').first()).toBeVisible({ timeout: 30_000 });
    await dismissSaveDialog();

    const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});
