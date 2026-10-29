import { test, expect, Page, Locator } from '@playwright/test';
import { collectErrors, runCommand, waitForWorkbench } from './helpers';

/**
 * Native Plotting appearance controls: background/reset, mask picker, overlap
 * toggles, and the narrow-panel layout. Materials are created through the
 * dashboard so the mask picker has real material domains without a workspace
 * fixture.
 */

async function createMaterial(page: Page, dashboard: Locator, template: RegExp): Promise<void> {
    await dashboard.getByRole('button', { name: 'Add Material' }).click();
    const form = dashboard.locator('.material-form-container');
    await expect(form).toBeVisible();
    await form.locator('.template-selector .nuke-select-trigger').click();
    await page.locator('.nuke-select-list').getByRole('option', { name: template }).click();
    await form.getByRole('button', { name: 'Create Material' }).click();
    await expect(form).toBeHidden();
}

async function openAppearanceEditor(page: Page): Promise<Locator> {
    await runCommand(page, 'Open Simulation Dashboard');
    const dashboard = page.locator('.simulation-dashboard');
    await expect(dashboard).toBeVisible({ timeout: 30_000 });
    await dashboard.locator('.dashboard-tabs').getByRole('button', { name: 'Materials' }).click();
    await createMaterial(page, dashboard, /Light Water/);
    await createMaterial(page, dashboard, /Graphite/);

    await runCommand(page, 'Native Plotting');
    const widget = page.locator('.native-plotting-widget');
    await expect(widget).toBeVisible({ timeout: 30_000 });
    const empty = widget.locator('.native-plotting-empty');
    await expect(empty).toBeVisible();
    await empty.locator('.plot-type-card', { hasText: 'Slice' }).click();
    await expect(widget.locator('.plot-card')).toHaveCount(1);
    await widget.locator('.plot-editor > .settings-section > h3', { hasText: 'Appearance' }).click();
    await expect(widget.locator('.plot-appearance')).toBeVisible();
    return widget;
}

test.describe('native plotting appearance', () => {
    test('background, mask picker, and overlap controls update the plot', async ({ page }) => {
        const errors = collectErrors(page);
        await page.goto('/');
        await waitForWorkbench(page);
        const widget = await openAppearanceEditor(page);

        // Background color picker starts at OpenMC's black default.
        const background = widget.locator('.plot-appearance > .plot-color-field').first();
        const trigger = background.locator('.nuke-color-picker-trigger');
        await expect(trigger).toContainText('#000000');
        await expect(background.locator('.plot-color-reset')).toHaveCount(0);
        expect(await trigger.getAttribute('title')).toBeNull();

        await trigger.click();
        const hexInput = page.locator('.nuke-color-picker-popup .nuke-color-hex-input input');
        await hexInput.fill('#112233');
        await hexInput.press('Enter');
        await expect(trigger).toContainText('#112233');
        await background.locator('.plot-color-reset').click();
        await expect(trigger).toContainText('#000000');
        await expect(background.locator('.plot-color-reset')).toHaveCount(0);

        // Masking: check the toggle, pick one material, and read the summary.
        const maskToggle = widget.locator('.plot-mask-toggle');
        await maskToggle.check();
        await expect(widget.locator('.plot-mask-picker')).toBeVisible();
        await expect(widget.locator('.plot-mask-summary')).toContainText('No materials selected');
        await widget.locator('.plot-mask-picker .nuke-searchable-multi-select-trigger').click();
        await page.locator('.nuke-searchable-multi-select-item', { hasText: 'Water' }).click();
        await page.keyboard.press('Escape');
        await expect(widget.locator('.plot-mask-summary')).toContainText('1 of 2 materials visible');
        await expect(widget.locator('.plot-appearance > .plot-color-field')).toHaveCount(2);

        // Overlap highlighting reveals the color control and explains the requirement.
        await widget.locator('.plot-overlap-toggle').check();
        await expect(widget.locator('.plot-overlap-color .nuke-color-picker-trigger')).toBeVisible();
        await expect(widget.locator('.plot-overlap-toggle-row')).toContainText('Overlap Checker');

        expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });

    test('narrow panels stack appearance controls without horizontal overflow', async ({ page }) => {
        const errors = collectErrors(page);
        await page.setViewportSize({ width: 700, height: 900 });
        await page.goto('/');
        await waitForWorkbench(page);
        const widget = await openAppearanceEditor(page);

        const overflow = await widget.evaluate((element) => element.scrollWidth - element.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);

        const colorDirection = await widget
            .locator('.plot-appearance > .plot-color-field .plot-color-control')
            .first()
            .evaluate((element) => {
                return getComputedStyle(element).flexDirection;
            });
        expect(colorDirection).toBe('column');

        await widget.locator('.plot-mask-toggle').check();
        await expect(widget.locator('.plot-mask-picker .nuke-searchable-multi-select-trigger')).toBeVisible();

        expect(errors, `console/page errors in narrow plotting panel:\n${errors.join('\n')}`).toEqual([]);
    });
});
