import * as fs from 'fs';
import * as path from 'path';
import { test, expect, type Locator } from '@playwright/test';
import { closeAllEditors, collectErrors, openFileByQuickOpen, runCommand, waitForWorkbench } from './helpers';

/**
 * Drawing Sheet workspace smoke: the start card creates a framed sheet, the
 * HLR linework lands, and the inspector/canvas controls stay wired.
 *
 * The pincell fixture is copied to a gitignored test-results path so the
 * drawing edits (which auto-save before HLR) never dirty the committed
 * fixture. The CAD build must succeed, so the test skips when the backend is
 * unavailable rather than failing on environment setup.
 */

test.setTimeout(240_000);

test('dragging an unbuilt view keeps its placeholder, frame, and chip together', async ({ page }) => {
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
    await expect(viewport.locator('.cad-document-toolbar').first()).toBeVisible({ timeout: 60_000 });

    await runCommand(page, 'Open Drawing Sheet');
    const drawing = page.locator('.nuke-cad-drawing-root').first();
    await expect(drawing).toBeVisible({ timeout: 30_000 });
    const startCard = drawing.locator('.nuke-cad-drawing-start-card').first();
    await expect(startCard).toBeVisible({ timeout: 30_000 });
    await startCard.locator('button', { hasText: 'Front' }).first().click();

    // An untitled document makes the first auto-refresh ask for a save path.
    // Cancel it so the view stays in the unbuilt placeholder state.
    const saveShell = page.locator('#theia-dialog-shell');
    try {
        await saveShell.waitFor({ state: 'visible', timeout: 30_000 });
    } catch {
        // No save prompt (the browser picker may resolve immediately).
    }
    if (await saveShell.isVisible().catch(() => false)) {
        await saveShell.getByRole('button', { name: 'Cancel' }).click();
        await expect(saveShell).toBeHidden();
    }
    // Cancelling the save picker can return focus to the CAD viewport; bring
    // the drawing tab back before interacting with the sheet.
    await runCommand(page, 'Open Drawing Sheet');
    await expect(drawing).toBeVisible({ timeout: 30_000 });

    const view = drawing.locator('.nuke-cad-drawing-view').first();
    const placeholder = view.locator('.nuke-cad-drawing-placeholder-card');
    await expect(placeholder).toBeVisible();
    const frame = view.locator('.nuke-cad-drawing-view-frame');
    const chip = view.locator('.nuke-cad-drawing-view-chip');

    const centerOf = async (locator: Locator): Promise<{ x: number; y: number }> => {
        const box = await locator.boundingBox();
        expect(box).not.toBeNull();
        return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
    };
    const expectFrameOnPlaceholder = async (): Promise<void> => {
        const card = await centerOf(placeholder);
        const selection = await centerOf(frame);
        expect(Math.abs(card.x - selection.x)).toBeLessThanOrEqual(3);
        expect(Math.abs(card.y - selection.y)).toBeLessThanOrEqual(3);
        const chipBox = await chip.boundingBox();
        const cardBox = await placeholder.boundingBox();
        expect(chipBox).not.toBeNull();
        expect(cardBox).not.toBeNull();
        // The chip hugs the placeholder's top-left; a double-translated frame
        // would leave it far away from the card.
        expect(Math.abs(chipBox!.x - cardBox!.x)).toBeLessThanOrEqual(4);
        expect(chipBox!.y).toBeLessThan(cardBox!.y);
    };

    const start = await placeholder.boundingBox();
    expect(start).not.toBeNull();
    const grabX = start!.x + start!.width / 2;
    const grabY = start!.y + start!.height / 2;
    await page.mouse.move(grabX, grabY);
    await page.mouse.down();
    await page.mouse.move(grabX + 120, grabY + 80, { steps: 6 });
    await page.waitForTimeout(200);
    await expectFrameOnPlaceholder();

    await page.mouse.up();
    await expect(placeholder).toBeVisible();
    await expectFrameOnPlaceholder();

    const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});

test('drawing sheet workspace creates, builds, and exposes canvas controls', async ({ page }) => {
    const errors = collectErrors(page);
    const fixtureDir = path.join(process.cwd(), 'tests/ui/fixtures');
    const documentPath = path.join(fixtureDir, 'drawing-sheet-smoke.nuke-cad');
    fs.copyFileSync(path.join(process.cwd(), 'tests/ui/fixtures/cad-pincell.nuke-cad'), documentPath);
    const cleanup = (): void => {
        for (const entry of [
            'drawing-sheet-smoke.nuke-cad',
            'drawing-sheet-smoke.step',
            'drawing-sheet-smoke.step.key',
            'drawing-sheet-smoke.tess.json',
            'drawing-sheet-smoke.nuke-cache.zip'
        ]) {
            fs.rmSync(path.join(fixtureDir, entry), { force: true });
        }
    };
    try {
        await page.goto('/');
        await waitForWorkbench(page);
        await closeAllEditors(page);
        await openFileByQuickOpen(page, 'drawing-sheet-smoke.nuke-cad');
        const viewport = page.locator('.cad-viewport').first();
        await expect(viewport).toBeVisible({ timeout: 60_000 });
        await expect(viewport.locator('.nuke-loading-overlay')).toBeHidden({ timeout: 120_000 });
        const buildBanner = viewport.locator('.cad-viewport-error-banner');
        if (await buildBanner.isVisible()) {
            const text = ((await buildBanner.textContent()) ?? '').trim();
            if (/install|missing|not installed|unavailable|environment|python/i.test(text)) {
                test.skip(true, `CAD backend unavailable: ${text.slice(0, 200)}`);
            }
            expect(buildBanner, `CAD build failed: ${text}`).toBeHidden();
        }
        await expect(viewport.locator('.cad-viewport-explode input[type=range]').first()).toBeVisible({ timeout: 120_000 });

        await runCommand(page, 'Open Drawing Sheet');
        const drawing = page.locator('.nuke-cad-drawing-root').first();
        await expect(drawing).toBeVisible({ timeout: 30_000 });
        const startCard = drawing.locator('.nuke-cad-drawing-start-card').first();
        await expect(startCard).toBeVisible();
        await startCard.locator('button', { hasText: 'Front' }).first().click();

        const status = drawing.locator('.nuke-cad-drawing-status-build').first();
        const waitForDrawingIdle = async (): Promise<void> => {
            // Let the store-change auto-save/refresh reach `Building…` before
            // polling, so an idle poll cannot match the pre-edit state.
            await page.waitForTimeout(500);
            await expect
                .poll(async () => (await status.textContent().catch(() => ''))?.trim(), { timeout: 180_000 })
                .toMatch(/Up to date|Build failed/);
            await expect(drawing.locator('.nuke-cad-drawing-notice.error')).toHaveCount(0);
        };
        await expect
            .poll(async () => (await status.textContent().catch(() => ''))?.trim(), { timeout: 180_000 })
            .toMatch(/Up to date|Build failed/);
        await expect(drawing.locator('.nuke-cad-drawing-notice.error')).toHaveCount(0);
        expect(await drawing.locator('.nuke-cad-drawing-visible').count()).toBeGreaterThan(0);

        await drawing.locator('.nuke-cad-drawing-view-row-main').first().click();
        const selected = drawing.locator('.nuke-section', { hasText: 'Selected view' }).first();
        await expect(selected).toBeVisible();
        await expect(selected.getByRole('button', { name: 'Fit' })).toBeVisible();
        await expect(selected.getByRole('checkbox', { name: 'Show hidden lines' })).toBeVisible();

        // Status segment: kind/orientation, scale, and naked linework extent.
        const viewStatus = drawing.locator('.nuke-cad-drawing-status-view');
        await expect(viewStatus).toBeVisible();
        await expect(viewStatus).toHaveText(/^base front · \d+(?:\.\d+)?:\d+(?:\.\d+)? · \d+(?:\.\d+)? × \d+(?:\.\d+)? mm$/);
        const paper = drawing.locator('.nuke-cad-drawing-paper');
        const paperBox = await paper.boundingBox();
        expect(paperBox).not.toBeNull();
        await page.mouse.click(paperBox!.x + 6, paperBox!.y + 6);
        await expect(drawing.locator('.nuke-cad-drawing-view.selected')).toHaveCount(0);
        await expect(viewStatus).toHaveCount(0);
        await drawing.locator('.nuke-cad-drawing-view-row-main').first().click();
        await expect(viewStatus).toBeVisible();

        const grid = drawing.getByRole('button', { name: 'Toggle grid' });
        await expect(grid).toHaveAttribute('aria-pressed', 'true');
        await expect(grid).not.toHaveClass(/secondary/);
        await grid.click();
        await expect(grid).toHaveAttribute('aria-pressed', 'false');
        await expect(grid).toHaveClass(/secondary/);
        await grid.click();

        const zoomLabel = drawing.locator('.nuke-cad-drawing-zoom-label');
        await expect(zoomLabel).toHaveText('100%');
        await drawing.getByRole('button', { name: 'Zoom in' }).click();
        await expect(zoomLabel).toHaveText('115%');
        await zoomLabel.click();
        await expect(zoomLabel).toHaveText('100%');

        // Direct manipulation: the label and the invisible grab area work even
        // when the projection is tiny, and a committed drag must stick.
        const viewChip = drawing.locator('.nuke-cad-drawing-view-chip').first();
        const chipStart = await viewChip.boundingBox();
        expect(chipStart).not.toBeNull();
        await page.mouse.click(chipStart!.x + chipStart!.width / 2, chipStart!.y + chipStart!.height / 2);
        await expect(drawing.locator('.nuke-cad-drawing-view.selected')).toHaveCount(1);
        await page.mouse.move(chipStart!.x + chipStart!.width / 2, chipStart!.y + chipStart!.height / 2);
        await page.mouse.down();
        await page.mouse.move(chipStart!.x + chipStart!.width / 2 + 60, chipStart!.y + chipStart!.height / 2 + 30, { steps: 6 });
        await page.mouse.up();
        await expect.poll(async () => (await viewChip.boundingBox())?.x ?? Number.NEGATIVE_INFINITY).toBeGreaterThan(chipStart!.x + 20);
        await expect.poll(async () => (await viewChip.boundingBox())?.y ?? Number.NEGATIVE_INFINITY).toBeGreaterThan(chipStart!.y + 10);
        await waitForDrawingIdle();

        const canvas = drawing.locator('.nuke-cad-drawing-canvas');
        await canvas.hover();
        await page.mouse.wheel(0, -120);
        await expect(zoomLabel).not.toHaveText('100%');
        await zoomLabel.click();
        await expect(zoomLabel).toHaveText('100%');

        // Cursor-centered wheel zoom: the stage point under the pointer stays
        // under the pointer (100% -> 112%), not at the stage center.
        await page.waitForTimeout(150);
        const zoomAnchor = await viewChip.boundingBox();
        expect(zoomAnchor).not.toBeNull();
        const anchorX = zoomAnchor!.x + zoomAnchor!.width / 2;
        const anchorY = zoomAnchor!.y + zoomAnchor!.height / 2;
        await page.mouse.move(anchorX, anchorY);
        await page.mouse.wheel(0, -120);
        await expect(zoomLabel).toHaveText('112%');
        await page.waitForTimeout(150);
        const zoomedAnchor = await viewChip.boundingBox();
        expect(zoomedAnchor).not.toBeNull();
        expect(Math.abs(zoomedAnchor!.x + zoomedAnchor!.width / 2 - anchorX)).toBeLessThanOrEqual(2);
        expect(Math.abs(zoomedAnchor!.y + zoomedAnchor!.height / 2 - anchorY)).toBeLessThanOrEqual(2);
        await zoomLabel.click();
        await expect(zoomLabel).toHaveText('100%');
        await page.waitForTimeout(150);

        // Space + left-drag pans from anywhere on the canvas, including over a
        // view (the view must bubble instead of starting a drag). Focus the
        // canvas first; toolbar buttons keep their native Space activation.
        const stage = drawing.locator('.nuke-cad-drawing-stage');
        const canvasBox = await canvas.boundingBox();
        expect(canvasBox).not.toBeNull();
        await page.mouse.click(canvasBox!.x + 5, canvasBox!.y + 5);
        const panAnchor = await viewChip.boundingBox();
        expect(panAnchor).not.toBeNull();
        const panX = panAnchor!.x + panAnchor!.width / 2;
        const panY = panAnchor!.y + panAnchor!.height / 2;
        await page.mouse.move(panX, panY);
        await page.keyboard.down('Space');
        await expect(canvas).toHaveClass(/is-pan-ready/);
        await page.mouse.down();
        await expect(canvas).toHaveClass(/is-panning/);
        await page.mouse.move(panX + 60, panY + 30, { steps: 6 });
        await page.mouse.up();
        await expect(canvas).toHaveClass(/is-pan-ready/);
        await expect(canvas).not.toHaveClass(/is-panning/);
        const stageTransform = await stage.evaluate((element) => (element as HTMLElement).style.transform);
        expect(stageTransform).toMatch(/translate\((?!0px, 0px\))[-\d.]+px, [-\d.]+px\)/);
        await page.keyboard.up('Space');
        await expect(canvas).not.toHaveClass(/is-pan-ready/);
        await zoomLabel.click();
        await expect(zoomLabel).toHaveText('100%');
        await page.waitForTimeout(150);

        const menuItem = (scope: Locator, label: string) => scope.locator('.cad-viewport-context-menu-item', { hasText: label });

        // Right-click blank paper opens the sheet-level menu (not the browser
        // menu, and not the selected-view menu).
        const openSheetMenu = async () => {
            const box = await paper.boundingBox();
            expect(box).not.toBeNull();
            await page.mouse.click(box!.x + 6, box!.y + 6, { button: 'right' });
            const menu = drawing.locator('.cad-viewport-context-menu');
            await expect(menu).toBeVisible();
            return menu;
        };
        const sheetMenu = await openSheetMenu();
        for (const label of [
            'Fit sheet',
            'Add front base view',
            'Hide grid',
            'Hide frame and title block',
            'Disable 5 mm snapping',
            'Refresh linework',
            'Export SVG',
            'Export DXF',
            'Delete sheet'
        ]) {
            await expect(menuItem(sheetMenu, label)).toBeVisible();
        }
        await page.keyboard.press('Escape');
        await expect(sheetMenu).toBeHidden();

        // Presentation toggles share state with the toolbar.
        const gridMenu = await openSheetMenu();
        await menuItem(gridMenu, 'Hide grid').click();
        await expect(grid).toHaveAttribute('aria-pressed', 'false');
        await grid.click();
        await expect(grid).toHaveAttribute('aria-pressed', 'true');

        const frameMenu = await openSheetMenu();
        await menuItem(frameMenu, 'Hide frame and title block').click();
        await expect(drawing.locator('.nuke-cad-drawing-title-block')).toHaveCount(0);
        await drawing.getByRole('button', { name: 'Toggle frame and title block' }).click();
        await expect(drawing.locator('.nuke-cad-drawing-title-block')).toHaveCount(1);

        const snapToggle = drawing.getByRole('button', { name: 'Toggle 5 mm snapping' });
        const snapMenu = await openSheetMenu();
        await menuItem(snapMenu, 'Disable 5 mm snapping').click();
        await expect(snapToggle).toHaveAttribute('aria-pressed', 'false');
        await snapToggle.click();
        await expect(snapToggle).toHaveAttribute('aria-pressed', 'true');

        // Fit sheet resets zoom/pan like the toolbar reset.
        await drawing.getByRole('button', { name: 'Zoom in' }).click();
        await expect(zoomLabel).not.toHaveText('100%');
        const fitSheetMenu = await openSheetMenu();
        await menuItem(fitSheetMenu, 'Fit sheet').click();
        await expect(zoomLabel).toHaveText('100%');

        // Right-click a view: compact actions anchored at the pointer.
        const openViewMenu = async () => {
            const chip = drawing.locator('.nuke-cad-drawing-view-chip').first();
            const box = await chip.boundingBox();
            expect(box).not.toBeNull();
            await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, { button: 'right' });
            const menu = drawing.locator('.cad-viewport-context-menu');
            await expect(menu).toBeVisible();
            return menu;
        };
        const menu = await openViewMenu();
        for (const label of ['Fit view', 'Show hidden lines', '1:1', '1:2', '2:1', '5:1', 'Scale…', 'Delete view']) {
            await expect(menuItem(menu, label)).toBeVisible();
        }
        // Escape dismisses the menu without activating anything.
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        const scaleTrigger = drawing.locator('.nuke-cad-drawing-scale-row .nuke-select-trigger');
        const actionsMenu = await openViewMenu();
        await menuItem(actionsMenu, 'Scale…').click();
        await expect(scaleTrigger).toBeFocused();

        const hiddenMenu = await openViewMenu();
        await menuItem(hiddenMenu, 'Show hidden lines').click();
        await expect(drawing.getByRole('checkbox', { name: 'Show hidden lines' })).toBeChecked();
        await waitForDrawingIdle();

        const scaleMenu = await openViewMenu();
        await menuItem(scaleMenu, '1:2').click();
        await expect(scaleTrigger).toHaveText('1:2');
        await expect(viewStatus).toContainText('1:2');
        await waitForDrawingIdle();

        // Double-clicking a view fits it (the inspector Fit path).
        await viewChip.dblclick();
        await expect(scaleTrigger).not.toHaveText('1:2');
        await expect(scaleTrigger).toHaveText(/^\d+(?:\.\d+)?:\d+$/);
        await waitForDrawingIdle();

        // The menu Fit entry performs the same store mutation.
        const refitMenu = await openViewMenu();
        await menuItem(refitMenu, '1:2').click();
        await waitForDrawingIdle();
        const fitMenu = await openViewMenu();
        await menuItem(fitMenu, 'Fit view').click();
        await expect(scaleTrigger).not.toHaveText('1:2');
        await waitForDrawingIdle();

        await expect(drawing.getByRole('button', { name: 'Save' })).toBeVisible();
        await expect(drawing.getByRole('button', { name: 'SVG' })).toBeVisible();
        await expect(drawing.getByRole('button', { name: 'DXF' })).toBeVisible();
        await page.screenshot({ path: 'test-results/cad-drawing-sheet.png' });

        // Delete the view from the menu; selection and status segment clear.
        const deleteMenu = await openViewMenu();
        await menuItem(deleteMenu, 'Delete view').click();
        await expect(drawing.locator('.nuke-cad-drawing-view-chip')).toHaveCount(0);
        await expect(drawing.locator('.nuke-cad-drawing-view-row')).toHaveCount(0);
        await expect(viewStatus).toHaveCount(0);
        await waitForDrawingIdle();

        // The paper menu can delete the sheet too, leaving the start card.
        const deleteSheetMenu = await openSheetMenu();
        await menuItem(deleteSheetMenu, 'Delete sheet').click();
        await expect(drawing.locator('.nuke-cad-drawing-start-card')).toBeVisible();

        const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
        expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
    } finally {
        cleanup();
    }
});
