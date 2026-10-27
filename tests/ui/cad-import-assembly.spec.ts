import { test, expect } from '@playwright/test';
import { closeAllEditors, collectErrors, runCommand, waitForWorkbench } from './helpers';

/**
 * One-click CAD import wiring: the assembly and imported-body actions are
 * offered on both empty states and the Document command search resolves both.
 * The headless browser does not surface Theia's native file dialog, so the
 * actual file-pick, dialog, and cancel paths are covered by the pure
 * path/store/widget suites instead of driving a dialog this suite cannot
 * observe.
 */

test.setTimeout(120_000);

test('Import CAD is offered on empty states and wired into command search', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    await closeAllEditors(page);
    await runCommand(page, 'Open CAD Viewport');
    const viewport = page.locator('.cad-viewport').first();
    await expect(viewport).toBeVisible({ timeout: 30_000 });

    // Welcome card (no document).
    const welcome = viewport.locator('.cad-viewport-welcome');
    await expect(welcome).toBeVisible({ timeout: 10_000 });
    await expect(welcome.locator('button', { hasText: 'Import CAD…' })).toBeVisible();
    await expect(welcome.locator('button', { hasText: 'Import CAD as Body…' })).toBeVisible();

    // Empty document card keeps Create Sketch / Open CAD Model and adds Import.
    await runCommand(page, 'New CAD Document');
    const picker = page.locator('.cad-template-picker').first();
    await expect(picker).toBeVisible({ timeout: 10_000 });
    await picker.locator('button', { hasText: 'Empty document' }).first().click();

    // The empty template opens the Create Sketch plane picker directly;
    // cancel it to inspect the launcher that backs the panel.
    const datumPicker = viewport.locator('.cad-sketch-datum-picker').first();
    await expect(datumPicker).toBeVisible({ timeout: 30_000 });
    await datumPicker.locator('button[aria-label="Cancel sketch setup"]').click();
    await expect(datumPicker).toBeHidden();

    const emptyCard = viewport.locator('.cad-viewport-document-empty').first();
    await expect(emptyCard).toBeVisible({ timeout: 10_000 });
    await expect(emptyCard.locator('.cad-viewport-document-empty-title')).toHaveText('Start a model');
    await expect(emptyCard.locator('.cad-viewport-document-empty-primary')).toContainText('Create Sketch');
    await expect(emptyCard.locator('.cad-viewport-document-empty-action')).toHaveCount(3);
    await expect(emptyCard.locator('button', { hasText: 'Create Sketch' })).toBeVisible();
    await expect(emptyCard.locator('button', { hasText: 'Open CAD Model…' })).toBeVisible();
    await expect(emptyCard.locator('button.import-cad-assembly-button')).toHaveText(/Import CAD…/);
    await expect(emptyCard.locator('button.import-cad-body-button')).toHaveText(/Import CAD as Body…/);

    // The same actions resolve through the shared command registry/search.
    const toolbar = viewport.locator('.cad-document-toolbar').first();
    await expect(toolbar).toBeVisible({ timeout: 60_000 });
    await viewport.locator('.cad-command-search-trigger').click();
    const popover = viewport.locator('.cad-command-search-popover');
    await expect(popover).toBeVisible();
    const search = popover.locator('.nuke-search-input-field');
    await search.fill('import cad');
    const rows = popover.locator('.cad-command-search-item');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Import CAD as Assembly…');
    await expect(rows.nth(0).locator('.cad-command-search-group')).toHaveText('Document');
    await expect(rows.nth(1)).toContainText('Import CAD as Body…');
    await expect(rows.nth(1).locator('.cad-command-search-group')).toHaveText('Document');
    await expect(rows.nth(1)).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();

    // Opening the search/registry never mutates the empty document.
    await expect(emptyCard).toBeVisible();
    await expect(viewport.locator('.cad-assembly-panel')).toBeHidden();
    await expect(toolbar.locator('.cad-document-toolbar-name')).toContainText('Untitled');

    const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});
