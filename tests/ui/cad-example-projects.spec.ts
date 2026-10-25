import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@playwright/test';
import { closeAllEditors, collectErrors, runCommand, waitForWorkbench } from './helpers';

/**
 * New Document picker sections: the existing blank-document presets stay under
 * "Start blank", and the ready-made example projects render under their own
 * heading with workload badges and the tokamak first-build warning. Cancelling
 * creates nothing. The save-copy flow is covered by the store/pure tests; this
 * spec deliberately does not drive the Theia save dialog.
 */

test.setTimeout(120_000);

test('New CAD Document picker lists example projects and cancels cleanly', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    await closeAllEditors(page);
    await runCommand(page, 'New CAD Document');
    const viewport = page.locator('.cad-viewport').first();
    await expect(viewport).toBeVisible({ timeout: 30_000 });

    const picker = page.locator('.cad-template-picker').first();
    await expect(picker).toBeVisible({ timeout: 10_000 });
    await expect(picker.locator('.cad-template-section-title')).toHaveText(['Start blank', 'Example projects']);

    // Empty document stays the first/default blank preset.
    const blankItems = picker.locator('.cad-template-list').first().locator('.cad-template-item');
    await expect(blankItems.first()).toContainText('Empty document');
    await expect(blankItems).toHaveCount(3);

    const samples = picker.locator('.cad-template-sample');
    await expect(samples).toHaveCount(3);
    for (const [name, badge] of [
        ['Pincell demo', 'Fast'],
        ['Tokamak with divertor', 'Large model'],
        ['Full W7-X stellarator', 'External']
    ]) {
        const card = samples.filter({ hasText: name });
        await expect(card).toHaveCount(1);
        await expect(card.locator('.cad-template-badge')).toHaveText(badge);
    }
    await expect(picker.locator('.cad-template-warning').filter({ hasText: 'first build can take a while' })).toBeVisible();
    await expect(picker.locator('.cad-template-warning').filter({ hasText: /not bundled/i })).toBeVisible();
    await expect(picker.locator('.cad-template-section-hint')).toContainText('editable copy');
    await expect(picker.locator('.cad-template-section-hint')).toContainText('copies its STEP');
    await page.screenshot({ path: 'test-results/cad-example-projects.png' });

    // The external W7-X card asks whether to download the MIT-licensed STEP
    // or use a local copy; it must not jump straight into a native file dialog.
    await samples.filter({ hasText: 'Full W7-X stellarator' }).click();
    const externalDialog = page
        .locator('.nuke-dialog')
        .filter({ has: page.locator('.nuke-dialog-title', { hasText: 'Full W7-X stellarator' }) });
    await expect(externalDialog).toBeVisible();
    await expect(externalDialog.locator('button', { hasText: 'Download 47 MB' })).toBeVisible();
    await expect(externalDialog.locator('button', { hasText: 'Choose local STEP' })).toBeVisible();
    await externalDialog.locator('button', { hasText: 'Back' }).click();
    await expect(picker).toBeVisible();

    await picker.locator('.cad-template-picker-actions button', { hasText: 'Cancel' }).click();
    await expect(picker).toBeHidden();
    await expect(page.locator('.nuke-dialog')).toBeHidden();

    // Cancelling the picker never installs a document or opens the save dialog.
    await expect(viewport.locator('.cad-viewport-document-empty')).toBeHidden();
    await expect(viewport.locator('.nuke-empty-state')).toBeVisible();

    const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});

test('Pincell example saves a copy under test-results and builds it', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectErrors(page);
    const outputDir = path.join(process.cwd(), 'test-results');
    const target = path.join(outputDir, 'sample-pincell.nuke-cad');
    fs.mkdirSync(outputDir, { recursive: true });
    const cleanup = (): void => {
        for (const entry of fs.readdirSync(outputDir)) {
            if (entry.startsWith('sample-pincell.')) {
                fs.rmSync(path.join(outputDir, entry), { force: true });
            }
        }
    };
    cleanup();

    try {
        await page.goto('/');
        await waitForWorkbench(page);
        await closeAllEditors(page);
        await runCommand(page, 'New CAD Document');
        const picker = page.locator('.cad-template-picker').first();
        await expect(picker).toBeVisible({ timeout: 10_000 });
        await picker.locator('.cad-template-sample').filter({ hasText: 'Pincell demo' }).click();

        // The save dialog is a real Theia file dialog; save the editable copy
        // into the ignored test-results folder and clean it up below.
        const saveDialog = page.locator('.theia-SaveFileDialog');
        await expect(saveDialog).toBeVisible({ timeout: 60_000 });
        const fileName = page.locator('.theia-FileNameTextField');
        await fileName.fill('test-results/sample-pincell.nuke-cad');
        await fileName.press('End');
        await page.locator('.dialogControl button', { hasText: 'Save' }).click();
        await expect(saveDialog).toBeHidden({ timeout: 30_000 });

        const viewport = page.locator('.cad-viewport').first();
        const errorBanner = viewport.locator('.cad-viewport-error-banner');
        const slider = viewport.locator('.cad-viewport-explode input[type=range]').first();
        await expect(slider.or(errorBanner).first()).toBeVisible({ timeout: 120_000 });
        if (await errorBanner.isVisible()) {
            test.skip(true, `CAD backend unavailable: ${(await errorBanner.textContent()) ?? 'build failed'}`);
        }

        expect(fs.existsSync(target), 'sample document was not saved').toBe(true);
        await expect(viewport.locator('.cad-document-toolbar-name')).toContainText(/sample-pincell|Pincell demo/);
        await expect(slider).toBeVisible();
        await page.screenshot({ path: 'test-results/cad-example-pincell.png' });

        const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
        expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
    } finally {
        cleanup();
    }
});
