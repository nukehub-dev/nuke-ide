import { test, expect } from '@playwright/test';
import { collectErrors, waitForWorkbench, runCommand } from './helpers';

/**
 * Nuke Tools sidebar smoke: the activity-bar icon is present by default and the
 * sidebar can be opened from the command palette, showing the registered tool
 * categories.
 */
test.describe('nuke tools sidebar', () => {
    test('icon is visible in the left activity bar by default', async ({ page }) => {
        const errors = collectErrors(page);

        await page.goto('/');
        await waitForWorkbench(page);
        await expect(page.locator('#theia-statusBar')).toBeVisible({ timeout: 60_000 });

        const tab = page
            .locator('.theia-app-left.theia-app-sides .lm-TabBar-tab:not([id$="-hidden"])')
            .filter({ has: page.locator('.codicon-tools') });
        await expect(tab).toBeVisible();

        const iconOrder = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.theia-app-left.theia-app-sides .lm-TabBar-tab'))
                .filter((t) => (t as HTMLElement).offsetParent !== null)
                .map((t) => (t.querySelector('.codicon-tools') ? 'tools' : t.querySelector('.codicon-extensions') ? 'extensions' : 'other'))
        );
        const toolsIndex = iconOrder.indexOf('tools');
        const extensionsIndex = iconOrder.indexOf('extensions');
        expect(toolsIndex, `expected Nuke Tools just before Extensions, got order: ${JSON.stringify(iconOrder)}`).toBe(extensionsIndex - 1);
        expect(errors, `console/page errors during boot:\n${errors.join('\n')}`).toEqual([]);
    });

    test('can be focused from the command palette and lists core categories', async ({ page }) => {
        const errors = collectErrors(page);

        await page.goto('/');
        await waitForWorkbench(page);
        await expect(page.locator('#theia-statusBar')).toBeVisible({ timeout: 60_000 });

        await runCommand(page, 'Nuke: Focus Tools Sidebar');

        const widget = page.locator('#nuke-tools-sidebar');
        await expect(widget).toBeVisible();
        await expect(widget.locator('.nuke-tools-category-label', { hasText: 'Environment' })).toBeVisible();
        await expect(widget.locator('.nuke-tools-category-label', { hasText: 'Health & Diagnostics' })).toBeVisible();

        const topLevelLabels = await widget
            .locator('.nuke-tools-content > .nuke-tools-category > .nuke-tools-category-header > .nuke-tools-category-label')
            .allTextContents();
        expect(topLevelLabels).toEqual(['Environment', 'Health & Diagnostics', 'OpenMC Studio', 'Visualizer']);

        expect(errors, `console/page errors while opening sidebar:\n${errors.join('\n')}`).toEqual([]);
    });
});
