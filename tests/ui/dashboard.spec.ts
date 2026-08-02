import { test, expect } from '@playwright/test';
import { collectErrors, expectNonEmptyContent, runCommand, waitForWorkbench } from './helpers';

/**
 * Simulation dashboard: opens via the command, every registered tab renders
 * non-empty content, and the New Project flow reveals a populated dashboard
 * (the blank-dashboard regression class).
 */

const DASHBOARD_TABS = ['Settings', 'Materials', 'Tallies', 'Depletion', 'Variance Reduction', 'Random Ray', 'Simulation'];

test.describe('simulation dashboard', () => {
    test('opens with non-empty content and all tabs render', async ({ page }) => {
        const errors = collectErrors(page);
        await page.goto('/');
        await waitForWorkbench(page);

        await runCommand(page, 'Open Simulation Dashboard');
        const dashboard = page.locator('.simulation-dashboard');
        await expect(dashboard).toBeVisible({ timeout: 30_000 });

        const tabBar = dashboard.locator('.dashboard-tabs');
        await expect(tabBar).toBeVisible();

        for (const label of DASHBOARD_TABS) {
            const button = tabBar.locator('.tab-button', { hasText: label });
            await expect(button, `tab button '${label}' missing`).toBeVisible();
            await button.click();
            // Each tab must paint meaningful content — a blank area here is
            // the ReactWidget-never-updates bug class.
            await expectNonEmptyContent(dashboard, 100);
        }

        expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });

    test('New Project creates a populated dashboard', async ({ page }) => {
        const errors = collectErrors(page);
        await page.goto('/');
        await waitForWorkbench(page);

        await runCommand(page, 'New Project');
        const dashboard = page.locator('.simulation-dashboard');
        await expect(dashboard).toBeVisible({ timeout: 30_000 });

        // The new untitled project must show real content, not an empty shell
        await expectNonEmptyContent(dashboard, 100);
        await expect(tabBarHasTabs(dashboard)).resolves.toBe(true);

        expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });
});

async function tabBarHasTabs(dashboard: ReturnType<import('@playwright/test').Page['locator']>): Promise<boolean> {
    return (await dashboard.locator('.dashboard-tabs .tab-button').count()) >= 5;
}
