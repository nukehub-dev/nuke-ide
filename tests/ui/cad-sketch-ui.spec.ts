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
    await expect(viewport.locator('.cad-viewport-document-empty')).toBeVisible({ timeout: 10_000 });
    // The overlay mounts after the viewport's cold controller import.
    await expect(viewport.locator('.cad-document-toolbar').first()).toBeVisible({ timeout: 60_000 });

    await runCommand(page, 'New Sketch');
    const datumPicker = viewport.locator('.cad-sketch-datum-picker').first();
    await expect(datumPicker).toBeVisible({ timeout: 10_000 });
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
