import { test, expect, Page, Locator } from '@playwright/test';
import { collectErrors, runCommand, waitForWorkbench } from './helpers';

/**
 * Variance-reduction smoke: multiple weight-window sets, checkpoints, a
 * reusable file, an inline source-energy bias, and the narrow-panel layout.
 * Selectors use product classes and ARIA labels, not testing hooks.
 */

/** Choose an option from a NukeSelect trigger (portal listbox). */
async function chooseOption(page: Page, trigger: Locator, option: string): Promise<void> {
    await trigger.click();
    const list = page.locator('.nuke-select-list').last();
    await expect(list).toBeVisible();
    await list.getByRole('option').filter({ hasText: option }).first().click();
}

test.describe('openmc variance reduction', () => {
    test('adds weight-window sets, file, checkpoints, and an inline energy bias in a narrow panel', async ({ page }) => {
        const errors = collectErrors(page);
        await page.setViewportSize({ width: 1280, height: 1000 });
        await page.goto('/');
        await waitForWorkbench(page);

        // A weight-window set needs a mesh: create one in the Tally Configurator.
        await runCommand(page, 'Open Tally Configurator');
        const tallyWidget = page.locator('.tally-configurator');
        await expect(tallyWidget).toBeVisible({ timeout: 30_000 });
        await tallyWidget.getByRole('button', { name: 'Meshes', exact: true }).click();
        await tallyWidget.locator('.mesh-list-panel .add-button').click();
        await expect(tallyWidget.locator('.mesh-card')).toHaveCount(1);

        await runCommand(page, 'Open Simulation Dashboard');
        const dashboard = page.locator('.simulation-dashboard');
        await expect(dashboard).toBeVisible({ timeout: 30_000 });
        await dashboard.getByRole('button', { name: 'Variance Reduction' }).click();

        const editor = dashboard.locator('.weight-window-editor');
        await expect(editor).toBeVisible();

        // UFS requires an explicit regular mesh and shows the readiness error.
        const ufs = dashboard.locator('.ufs-section');
        await ufs.getByLabel('Enable Uniform Fission Site').check();
        await expect(ufs).toContainText('Select a regular mesh');
        await chooseOption(page, ufs.locator('.ufs-mesh-picker .nuke-select-trigger'), 'Mesh 1 (regular)');
        await expect(ufs.locator('.form-error')).toHaveCount(0);

        await editor.getByRole('button', { name: 'Add weight-window set' }).click();
        await expect(editor.locator('.ww-set-card')).toHaveCount(1);
        await editor.getByRole('button', { name: 'Add weight-window set' }).click();
        await expect(editor.locator('.ww-set-card')).toHaveCount(2);
        await expect(editor.locator('.ww-list-summary')).toContainText('2 sets');
        await expect(editor.getByLabel('Enable weight windows')).toBeChecked();

        // Checkpoints wrap and the surface toggle is independent of collision.
        await editor.getByLabel('Surface crossing').check();
        await expect(editor.getByLabel('Surface crossing')).toBeChecked();
        await expect(editor.getByLabel('Collision')).toBeChecked();

        // Reusable HDF5 file.
        await editor.getByLabel('Weight-window file').fill('weight_windows.h5');
        await expect(editor.getByLabel('Weight-window file')).toHaveValue('weight_windows.h5');
        await expect(editor).toContainText('Generator runs overwrite this file');

        // Inline source energy bias.
        await dashboard.getByRole('button', { name: 'Settings', exact: true }).click();
        const sourceCard = dashboard.locator('.source-card').first();
        await expect(sourceCard).toBeVisible({ timeout: 30_000 });
        const energySection = sourceCard
            .locator('.source-section')
            .filter({ has: page.locator('.source-section-title', { hasText: 'Energy Distribution' }) })
            .first();
        await chooseOption(page, energySection.locator('.nuke-select-trigger').first(), 'Uniform');
        const biasToggle = energySection.locator('.source-bias-toggle-label').filter({ hasText: 'Bias sampling' });
        await biasToggle.locator('input').check();
        await expect(energySection.locator('.source-bias-editor')).toBeVisible();
        await expect(sourceCard.locator('.source-summary-card .source-bias-badge')).toHaveText('biased');

        // Narrow panel: bound editors stack and the tab never scrolls sideways.
        await page.setViewportSize({ width: 420, height: 900 });
        await dashboard.getByRole('button', { name: 'Variance Reduction' }).click();
        await expect(editor.locator('.ww-set-card')).toHaveCount(2);
        const columns = await editor
            .locator('.ww-bound-grid')
            .first()
            .evaluate(
                (element) =>
                    getComputedStyle(element)
                        .gridTemplateColumns.split(' ')
                        .filter((part) => part.length > 0).length
            );
        expect(columns).toBeLessThanOrEqual(1);
        const overflow = await dashboard
            .locator('.variance-reduction-tab')
            .evaluate((element) => element.scrollWidth - element.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);

        expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });
});
