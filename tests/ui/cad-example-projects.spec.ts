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
    await expect(samples).toHaveCount(5);
    for (const [name, badge] of [
        ['Pincell demo', 'Fast'],
        ['Tokamak with divertor', 'Large model'],
        ['Full W7-X stellarator', 'External'],
        ['W7-X generator (parametric)', 'External'],
        ['W7-X coil shape study (native)', 'Fast']
    ]) {
        const card = samples.filter({ hasText: name });
        await expect(card).toHaveCount(1);
        await expect(card.locator('.cad-template-badge')).toHaveText(badge);
    }
    await expect(picker.locator('.cad-template-warning').filter({ hasText: 'first build can take a while' })).toBeVisible();
    await expect(picker.locator('.cad-template-warning').filter({ hasText: /not bundled/i })).toBeVisible();
    const generatorCard = samples.filter({ hasText: 'W7-X generator (parametric)' });
    await expect(generatorCard).toContainText('10 exact coil bodies');
    await expect(generatorCard).toContainText('55 assembly instances');
    await expect(generatorCard.locator('.cad-template-warning')).toContainText('validated 5-module layout only (50 coils)');
    const shapeCard = samples.filter({ hasText: 'W7-X coil shape study (native)' });
    await expect(shapeCard).toContainText('10 editable native coil sweeps');
    await expect(shapeCard).toContainText('no external STEP');
    await expect(shapeCard.locator('.cad-template-warning')).toContainText('Approximate native sweeps, not the reference B-rep');
    await expect(shapeCard.locator('.cad-template-warning')).toContainText('simulation export disabled');
    await expect(picker.locator('.cad-template-section-hint')).toContainText('editable copy');
    await expect(picker.locator('.cad-template-section-hint')).toContainText('copy their STEP');
    await expect(picker.locator('.cad-template-section-hint')).toContainText('ten editable coil sweeps without a STEP');
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

    // The generator card uses the same source flow but builds the parametric
    // 15-body / 55-instance project; it never opens the native picker here.
    await generatorCard.click();
    const generatorDialog = page
        .locator('.nuke-dialog')
        .filter({ has: page.locator('.nuke-dialog-title', { hasText: 'W7-X generator (parametric)' }) });
    await expect(generatorDialog).toBeVisible();
    await expect(generatorDialog.locator('button', { hasText: 'Download 47 MB' })).toBeVisible();
    await expect(generatorDialog.locator('button', { hasText: 'Choose local STEP' })).toBeVisible();
    await generatorDialog.locator('button', { hasText: 'Back' }).click();
    await expect(picker).toBeVisible();

    await picker.locator('.cad-template-picker-actions button', { hasText: 'Cancel' }).click();
    await expect(picker).toBeHidden();
    await expect(page.locator('.nuke-dialog')).toBeHidden();

    // Cancelling the picker never installs a document or opens the save dialog.
    await expect(viewport.locator('.cad-viewport-document-empty')).toBeHidden();
    await expect(viewport.locator('.cad-viewport-welcome')).toBeVisible();

    const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});

test('Create W7-X Generator is searchable from the document toolbar', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    await closeAllEditors(page);
    await runCommand(page, 'New CAD Document');
    const viewport = page.locator('.cad-viewport').first();
    await expect(viewport).toBeVisible({ timeout: 30_000 });
    const picker = page.locator('.cad-template-picker').first();
    await expect(picker).toBeVisible({ timeout: 10_000 });
    await picker.locator('button', { hasText: 'Empty document' }).first().click();

    // The empty template opens the Create Sketch plane picker directly;
    // dismiss it before driving the document toolbar.
    const autoPicker = viewport.locator('.cad-sketch-datum-picker').first();
    await expect(autoPicker).toBeVisible({ timeout: 30_000 });
    await autoPicker.locator('button[aria-label="Cancel sketch setup"]').click();
    await expect(autoPicker).toBeHidden();

    const toolbar = viewport.locator('.cad-document-toolbar').first();
    await expect(toolbar).toBeVisible({ timeout: 60_000 });
    await toolbar.locator('.cad-document-toolbar-search').click();
    const popover = viewport.locator('.cad-command-search-popover');
    await expect(popover).toBeVisible();
    const search = popover.locator('.nuke-search-input-field');
    await search.fill('w7-x generator');

    const rows = popover.locator('.cad-command-search-item');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Create W7-X Generator…');
    await expect(rows.first().locator('.cad-command-search-group')).toHaveText('Document');
    await expect(rows.first()).toBeEnabled();
    await page.screenshot({ path: 'test-results/cad-w7x-generator-command.png' });

    // The experimental coil study is a sibling Document action; searching its
    // own name keeps it distinguishable from the valid generator.
    await search.fill('coil study');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Create W7-X Coil Study…');
    await expect(rows.first().locator('.cad-command-search-group')).toHaveText('Document');
    await expect(rows.first()).toBeEnabled();
    await page.screenshot({ path: 'test-results/cad-w7x-coil-study-command.png' });

    // The native shape study is self-contained (no STEP); its row must be
    // reachable from the same Document search without opening a file dialog.
    await search.fill('coil shape study');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Create W7-X Coil Shape Study…');
    await expect(rows.first().locator('.cad-command-search-group')).toHaveText('Document');
    await expect(rows.first()).toBeEnabled();
    await page.screenshot({ path: 'test-results/cad-w7x-coil-shape-study-command.png' });

    // Search/registry wiring must not open a native file dialog or mutate the
    // empty document; the actual generation path is covered by widget tests.
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(viewport.locator('.cad-viewport-document-empty')).toBeVisible();
    await expect(toolbar.locator('.cad-document-toolbar-name')).toContainText('Untitled');

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

        // Closing the viewport disposes its scene; reopening must restore the
        // active model instead of showing the empty-document card.
        await runCommand(page, 'Close All Tabs');
        await runCommand(page, 'Open CAD Viewport');
        const reopened = page.locator('.cad-viewport').first();
        await expect(reopened.locator('.cad-viewport-document-empty')).toBeHidden({ timeout: 60_000 });
        await expect(reopened.locator('.cad-viewport-explode input[type=range]').first()).toBeVisible({ timeout: 60_000 });
        await expect(reopened.locator('.nuke-loading-overlay')).toBeHidden({ timeout: 60_000 });
        await expect(page.locator('.cad-feature-tree-panel')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('.cad-outline-panel')).toHaveCount(1);

        // New Document must not restore or rebuild the previous model behind
        // the picker; choosing Empty clears the geometry and lists.
        await runCommand(page, 'New CAD Document');
        const newPicker = page.locator('.cad-template-picker').first();
        await expect(newPicker).toBeVisible({ timeout: 15_000 });
        await newPicker.locator('button', { hasText: 'Empty document' }).first().click();
        const autoPicker = reopened.locator('.cad-sketch-datum-picker').first();
        await expect(autoPicker).toBeVisible({ timeout: 30_000 });
        await autoPicker.locator('button[aria-label="Cancel sketch setup"]').click();
        await expect(autoPicker).toBeHidden();
        await expect(reopened.locator('.cad-viewport-document-empty')).toBeVisible({ timeout: 15_000 });
        await expect(reopened.locator('.cad-viewport-explode input[type=range]')).toHaveCount(0);
        await expect(reopened.locator('.nuke-loading-overlay')).toHaveCount(0);

        const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
        expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
    } finally {
        cleanup();
    }
});

test('W7-X shape study dialog inputs follow the active theme', async ({ page }) => {
    const outputDir = path.join(process.cwd(), 'test-results');
    const cleanup = (): void => {
        for (const entry of ['theme-probe.nuke-cad', 'theme-probe.step', 'theme-probe.tess.json']) {
            fs.rmSync(path.join(outputDir, entry), { force: true });
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
        await picker.locator('.cad-template-sample').filter({ hasText: 'W7-X coil shape study (native)' }).click();
        const saveDialog = page.locator('.theia-SaveFileDialog');
        await expect(saveDialog).toBeVisible({ timeout: 30_000 });
        const fileName = page.locator('.theia-FileNameTextField');
        await fileName.fill('test-results/theme-probe.nuke-cad');
        await fileName.press('End');
        await page.locator('.dialogControl button', { hasText: 'Save' }).click();
        await expect(saveDialog).toBeHidden({ timeout: 30_000 });

        const dialog = page
            .locator('.nuke-dialog')
            .filter({ has: page.locator('.nuke-dialog-title', { hasText: 'Create W7-X Coil Shape Study' }) });
        await expect(dialog).toBeVisible({ timeout: 15_000 });
        const backgrounds = await dialog
            .locator('input[type=number]')
            .first()
            .evaluate((input) => {
                const root = document.documentElement;
                const original = root.style.getPropertyValue('--theia-input-background');
                root.style.setProperty('--theia-input-background', '#123456');
                const themed = getComputedStyle(input).backgroundColor;
                if (original.length > 0) {
                    root.style.setProperty('--theia-input-background', original);
                } else {
                    root.style.removeProperty('--theia-input-background');
                }
                return { themed, expected: 'rgb(18, 52, 86)' };
            });
        expect(backgrounds.themed).toBe(backgrounds.expected);
        await dialog.locator('button', { hasText: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
    } finally {
        cleanup();
    }
});
