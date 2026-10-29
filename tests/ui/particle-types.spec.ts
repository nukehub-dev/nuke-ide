import { test, expect, Page, Locator } from '@playwright/test';
import { collectErrors, runCommand, waitForWorkbench } from './helpers';

/**
 * Generalized particle selector smoke: source presets and a custom PDG with a
 * resolved-name preview, the tally particle multi-select, the weight-window
 * neutron/photon restriction, and the narrow-panel layout.
 */

/** Open the simulation dashboard and return its root. */
async function openDashboard(page: Page): Promise<Locator> {
    await runCommand(page, 'Open Simulation Dashboard');
    const dashboard = page.locator('.simulation-dashboard');
    await expect(dashboard).toBeVisible({ timeout: 30_000 });
    return dashboard;
}

/** Locate a collapsible source section by title. */
function sourceSection(page: Page, title: string): Locator {
    return page
        .locator('.source-card .source-section')
        .filter({ has: page.locator('.source-section-title', { hasText: title }) })
        .first();
}

test.describe('openmc particle types', () => {
    test('selects a source preset and a custom PDG with a resolved preview', async ({ page }) => {
        const errors = collectErrors(page);
        await page.setViewportSize({ width: 1280, height: 1000 });
        await page.goto('/');
        await waitForWorkbench(page);
        const dashboard = await openDashboard(page);
        await dashboard.getByRole('button', { name: 'Settings', exact: true }).click();

        const sourceCard = dashboard.locator('.source-card').first();
        await expect(sourceCard).toBeVisible({ timeout: 30_000 });
        const advanced = sourceSection(page, 'Advanced');
        await advanced.locator('.source-section-header').click();

        const selector = advanced.locator('.particle-type-selector');
        await expect(selector).toBeVisible();
        await expect(selector.getByRole('button', { name: 'Neutron', exact: true })).toHaveAttribute('aria-pressed', 'true');

        // A non-default preset writes the shared particle model.
        await selector.getByRole('button', { name: 'Electron', exact: true }).click();
        await expect(selector.getByRole('button', { name: 'Electron', exact: true })).toHaveAttribute('aria-pressed', 'true');

        // Custom PDG resolves the canonical OpenMC name.
        await selector.getByRole('button', { name: 'Custom PDG…' }).click();
        const pdgInput = selector.getByLabel('Particle type custom PDG');
        await pdgInput.fill('1000020040');
        await expect(selector.locator('.particle-type-preview')).toContainText('He4');
        await expect(selector.locator('.particle-type-preview')).toContainText('PDG 1000020040');

        // The tooltip carries the canonical name and PDG, not a native title.
        const info = selector.locator('.particle-type-info');
        expect(await info.getAttribute('title')).toBeNull();
        await info.hover();
        const tooltip = page.locator('.nuke-tooltip').last();
        await expect(tooltip).toBeVisible();
        await expect(tooltip).toContainText('OpenMC name: He4');
        await expect(tooltip).toContainText('PDG 1000020040');

        // Narrow panel: segments collapse to a select and the custom row stacks.
        await page.setViewportSize({ width: 420, height: 900 });
        await expect(selector.locator('.particle-type-segments')).toBeHidden();
        await expect(selector.locator('.particle-type-select-control')).toBeVisible();
        const direction = await selector.locator('.particle-type-custom').evaluate((element) => getComputedStyle(element).flexDirection);
        expect(direction).toBe('column');
        const overflow = await sourceCard.locator('.source-editor').evaluate((element) => element.scrollWidth - element.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);

        expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });

    test('adds preset and custom particle bins to a tally filter', async ({ page }) => {
        const errors = collectErrors(page);
        await page.setViewportSize({ width: 1100, height: 1000 });
        await page.goto('/');
        await waitForWorkbench(page);

        await runCommand(page, 'Open Tally Configurator');
        const widget = page.locator('.tally-configurator-container');
        await expect(widget).toBeVisible({ timeout: 30_000 });
        await widget.locator('.tally-list-panel .add-button').click();
        const editor = widget.locator('.tally-editor');
        await expect(editor).toBeVisible();

        await editor.getByRole('button', { name: '+ Particle', exact: true }).click();
        const card = editor.locator('.filter-item[data-filter-type="particle"]');
        await expect(card).toBeVisible();
        await expect(card.locator('.filter-label')).toHaveText('Particle');

        // The default neutron preset is selected; add electron and a custom He4 bin.
        const multi = card.locator('.particle-type-multi');
        await expect(multi.getByLabel('Neutron')).toBeChecked();
        await multi.getByLabel('Electron').check();
        await expect(multi.getByLabel('Electron')).toBeChecked();

        const customInput = multi.getByLabel('Particle filter bins custom PDG');
        await customInput.fill('1000922350');
        await expect(multi.locator('.particle-type-preview')).toContainText('U235');
        await multi.getByRole('button', { name: 'Add particle' }).click();
        await expect(multi.locator('.particle-type-chip')).toContainText('U235');

        expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });

    test('weight-window particle selectors expose only neutron and photon', async ({ page }) => {
        const errors = collectErrors(page);
        await page.setViewportSize({ width: 1280, height: 1000 });
        await page.goto('/');
        await waitForWorkbench(page);

        // A weight-window set needs a mesh.
        await runCommand(page, 'Open Tally Configurator');
        const tallyWidget = page.locator('.tally-configurator-container');
        await expect(tallyWidget).toBeVisible({ timeout: 30_000 });
        await tallyWidget.getByRole('button', { name: 'Meshes', exact: true }).click();
        await tallyWidget.locator('.mesh-list-panel .add-button').click();
        await expect(tallyWidget.locator('.mesh-card')).toHaveCount(1);

        const dashboard = await openDashboard(page);
        await dashboard.getByRole('button', { name: 'Variance Reduction' }).click();
        const editor = dashboard.locator('.weight-window-editor');
        await editor.getByRole('button', { name: 'Add weight-window set' }).click();
        const selector = editor.locator('.ww-set-card .particle-type-selector').first();
        await expect(selector.getByRole('button', { name: 'Neutron', exact: true })).toBeVisible();
        await expect(selector.getByRole('button', { name: 'Photon', exact: true })).toBeVisible();
        await expect(selector.getByRole('button', { name: 'Electron', exact: true })).toHaveCount(0);
        await expect(selector.getByRole('button', { name: 'Custom PDG…' })).toHaveCount(0);
        await expect(selector).toContainText('only apply to neutrons and photons');

        expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });
});
