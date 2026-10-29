import { test, expect } from '@playwright/test';
import { collectErrors, dismissNotifications, runCommand, waitForWorkbench } from './helpers';

/**
 * New Project template picker: card content, keyboard selection, blank default,
 * live preview, creation into the Simulation tab, and narrow-panel stacking.
 */

const TEMPLATE_CARDS = [
    { name: 'Blank Project', header: 'Untitled Project' },
    { name: 'Pin Cell', header: 'Pin Cell', parameter: { label: 'U-235 enrichment', value: '3.5', preview: '3.5%' } },
    { name: '17x17 PWR Assembly', header: '17x17 PWR Assembly', preview: '264 fuel pins' },
    { name: 'Demonstration Core', header: 'Demonstration Core', preview: '3x3 assemblies' },
    { name: 'Shielding', header: 'Shielding', parameter: { label: 'Lead thickness', value: '25', preview: '25 cm lead' } },
    { name: 'Criticality Safety', header: 'Criticality Safety', preview: 'HEU sphere' }
];

test.describe('new project templates', () => {
    test('picker shows all cards, blank selected by default, and the readiness note', async ({ page }) => {
        const errors = collectErrors(page);
        await page.goto('/');
        await waitForWorkbench(page);
        await runCommand(page, 'New Project');

        const dialog = page.locator('.new-project-dialog');
        await expect(dialog).toBeVisible({ timeout: 30_000 });
        await expect(dialog.getByRole('heading', { name: 'New Project' })).toBeVisible();
        await expect(dialog.getByRole('radio')).toHaveCount(TEMPLATE_CARDS.length);
        await expect(dialog.getByRole('radio').first()).toHaveAttribute('aria-checked', 'true');
        await expect(dialog.getByRole('radio').first()).toContainText('Blank Project');
        await expect(dialog.getByText('No parameters', { exact: false })).toBeVisible();
        await expect(dialog.getByText('cross-section library', { exact: false })).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Create Project' })).toBeEnabled();
        await expect(dialog.getByRole('radio').first().locator('i')).toHaveClass(/codicon/);

        // Product hints stay on the shared tooltip layer, never native title.
        await expect(dialog.getByRole('button', { name: 'Close' })).not.toHaveAttribute('title');
        await dialog.getByRole('button', { name: 'Close' }).hover();
        await expect(page.locator('.nuke-tooltip')).toBeVisible();
        await expect(page.locator('.nuke-tooltip')).toHaveText('Close');

        expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });

    test('cards are keyboard-selectable and expose the live parameter preview', async ({ page }) => {
        await page.goto('/');
        await waitForWorkbench(page);
        await runCommand(page, 'New Project');
        const dialog = page.locator('.new-project-dialog');
        await expect(dialog).toBeVisible({ timeout: 30_000 });

        const pin = dialog.getByRole('radio', { name: /^Pin Cell/ });
        await pin.focus();
        await page.keyboard.press('Enter');
        await expect(pin).toHaveAttribute('aria-checked', 'true');

        const enrichment = dialog.getByLabel('U-235 enrichment');
        await enrichment.fill('3.2');
        await expect(dialog.locator('.new-project-preview-summary')).toContainText('3.2%');
        await expect(dialog.getByLabel('Project name')).toHaveValue('Pin Cell');

        // Arrow navigation moves the roving selection without losing content.
        await pin.focus();
        await page.keyboard.press('ArrowDown');
        const assembly = dialog.getByRole('radio', { name: /^17x17 PWR Assembly/ });
        await expect(assembly).toHaveAttribute('aria-checked', 'true');
        await expect(dialog.locator('.new-project-preview-summary')).toContainText('264 fuel pins');
    });

    test('creates every template and opens the dashboard on the Simulation tab', async ({ page }) => {
        test.setTimeout(180_000);
        const errors = collectErrors(page);
        await page.goto('/');
        await waitForWorkbench(page);

        for (const card of TEMPLATE_CARDS) {
            await dismissNotifications(page);
            await runCommand(page, 'New Project');
            const dialog = page.locator('.new-project-dialog');
            await expect(dialog).toBeVisible({ timeout: 30_000 });
            const option = dialog.getByRole('radio', { name: new RegExp(`^${card.name}`) });
            await option.click();
            await expect(option).toHaveAttribute('aria-checked', 'true');

            if (card.parameter) {
                await dialog.getByLabel(card.parameter.label).fill(card.parameter.value);
                await expect(dialog.locator('.new-project-preview-summary')).toContainText(card.parameter.preview!);
            } else if (card.preview) {
                await expect(dialog.locator('.new-project-preview-summary')).toContainText(card.preview);
            }

            if (card.name !== 'Blank Project') {
                await dialog.getByLabel('Project name').fill(`${card.name} Example`);
            }
            await dialog.getByRole('button', { name: 'Create Project' }).click();
            await expect(dialog).toBeHidden();
            await dismissNotifications(page);

            const dashboard = page.locator('.simulation-dashboard');
            await expect(dashboard).toBeVisible();
            const activeTab = dashboard.locator('.dashboard-tabs .tab-button.active');
            await expect(activeTab).toHaveText('Simulation');
            await expect(dashboard.locator('.project-info h2')).toContainText(
                card.header === 'Untitled Project' ? 'Untitled Project' : `${card.name} Example`
            );
        }

        expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });

    test('narrow panel stacks cards and never overflows horizontally', async ({ page }) => {
        await page.setViewportSize({ width: 420, height: 900 });
        await page.goto('/');
        await waitForWorkbench(page);
        await runCommand(page, 'New Project');

        const dashboard = page.locator('.simulation-dashboard');
        const dialog = page.locator('.new-project-dialog');
        await expect(dialog).toBeVisible({ timeout: 30_000 });
        const overflow = await dashboard.evaluate((element) => element.scrollWidth - element.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);

        const cards = dialog.getByRole('radio');
        const first = await cards.nth(0).boundingBox();
        const second = await cards.nth(1).boundingBox();
        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(Math.abs(first!.x - second!.x)).toBeLessThanOrEqual(1);
        expect(second!.y).toBeGreaterThan(first!.y + first!.height - 1);
    });
});
