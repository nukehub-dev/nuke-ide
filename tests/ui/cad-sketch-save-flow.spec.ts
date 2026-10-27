import { expect, test } from '@playwright/test';
import { closeAllEditors, collectErrors, runCommand, waitForWorkbench } from './helpers';

/**
 * Finish Sketch on an unsaved document: the explicit save-to-build prompt must
 * replace the generic native save dialog, keep the in-memory sketch, and
 * re-arm itself when the user cancels the save picker.
 */

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(180_000);

test('finish sketch on an unsaved document asks to save before building', async ({ page }) => {
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

    const box = await viewport.boundingBox();
    expect(box).not.toBeNull();
    await page.keyboard.press('l');
    await page.mouse.click(box!.x + 430, box!.y + 420);
    await page.mouse.click(box!.x + 760, box!.y + 420);
    await page.waitForTimeout(300);

    await finish.click();
    const prompt = page.locator('.nuke-dialog.cad-sketch-save-prompt');
    await expect(prompt).toBeVisible({ timeout: 30_000 });
    await expect(prompt.locator('.nuke-dialog-title')).toHaveText('Sketch saved in memory');
    await expect(prompt).toContainText('Save the document to build the model.');
    // The generic save dialog must not be what the user sees at finish.
    await expect(page.locator('#theia-dialog-shell')).toBeHidden();

    // Cancelling the native save picker reopens the prompt with the sketch intact.
    await prompt.getByRole('button', { name: 'Save…' }).click();
    const saveDialog = page.locator('#theia-dialog-shell');
    await expect(saveDialog).toBeVisible({ timeout: 30_000 });
    await saveDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(saveDialog).toBeHidden();
    await expect(prompt).toBeVisible();

    // Deferring keeps the sketch in the document and closes the prompt.
    await prompt.getByRole('button', { name: 'Not now' }).click();
    await expect(prompt).toBeHidden();
    await expect(page.locator('#theia-dialog-shell')).toBeHidden();
    await expect(page.locator('.feature-tree-row.sketch')).toHaveCount(1);

    const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});
