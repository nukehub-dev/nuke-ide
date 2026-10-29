import { test, expect } from '@playwright/test';
import { collectErrors, runCommand, waitForWorkbench } from './helpers';

/**
 * Depletion tab advanced controls: CRAM substeps, reactivity control,
 * external feed/removal, and continuation. Uses the New Project flow so the
 * spec does not depend on a fixture file or backend data.
 */

test.setTimeout(240_000);

async function openDepletionTab(page: import('@playwright/test').Page) {
    await runCommand(page, 'New Project');
    const dashboard = page.locator('.simulation-dashboard');
    await expect(dashboard).toBeVisible({ timeout: 30_000 });

    const tab = dashboard.locator('.dashboard-tabs').getByRole('button', { name: 'Depletion' });
    await expect(tab).toBeVisible();
    await tab.click();

    const enable = dashboard.getByRole('button', { name: 'Enable' });
    await expect(enable).toBeVisible();
    await enable.click();

    const controls = dashboard.locator('.depletion-run-controls');
    await expect(controls).toBeVisible({ timeout: 30_000 });
    return { dashboard, controls };
}

test.describe('depletion advanced controls', () => {
    test('renders substeps, reactivity, feeds, and continuation', async ({ page }) => {
        const errors = collectErrors(page);
        await page.goto('/');
        await waitForWorkbench(page);

        const { dashboard, controls } = await openDepletionTab(page);

        await expect(controls.locator('#depletion-substeps')).toHaveValue('1');
        await expect(controls.getByText('Reactivity control', { exact: false })).toBeVisible();
        await expect(controls.getByText('External feed / removal', { exact: false })).toBeVisible();
        await expect(controls.getByText('No external feeds or removals', { exact: false })).toBeVisible();
        await expect(controls.getByText('Continuation', { exact: false })).toBeVisible();

        // Enabling the search reveals the parameter picker and the runtime warning.
        const reactivityToggle = controls.getByRole('checkbox', { name: /Hold a target k-effective/ });
        await reactivityToggle.check();
        await expect(controls.getByText('Search runs at each depletion step', { exact: false })).toBeVisible();
        await expect(controls.getByText('Parameter type', { exact: false })).toBeVisible();

        // Continuing timesteps without a results file surfaces an inline fix.
        await controls.getByRole('checkbox', { name: /Continue the previous timesteps/ }).check();
        await expect(controls.getByText('Continue timesteps needs a previous depletion results file', { exact: false })).toBeVisible();

        // The advanced panels never widen the page.
        expect(await dashboard.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);

        // The run summary reflects the advanced controls.
        await controls.locator('#depletion-substeps').fill('3');
        await controls.locator('.depletion-continuation-file input[type="text"]').fill('/tmp/old/depletion_results.h5');
        await dashboard.locator('.dashboard-tabs').getByRole('button', { name: 'Simulation' }).click();
        await expect(dashboard.getByText('Substeps:')).toBeVisible();
        await expect(dashboard.getByText('Reactivity Control:')).toBeVisible();
        await expect(dashboard.getByText('Continuation:')).toBeVisible();

        expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });

    test('stacks the advanced controls in a narrow panel', async ({ page }) => {
        const errors = collectErrors(page);
        await page.setViewportSize({ width: 700, height: 900 });
        await page.goto('/');
        await waitForWorkbench(page);

        const { dashboard, controls } = await openDepletionTab(page);
        await controls.getByRole('checkbox', { name: /Hold a target k-effective/ }).check();

        // Tabs stay reachable by accessible name and the panel does not grow a
        // page-level horizontal scrollbar.
        await expect(dashboard.locator('.dashboard-tabs').getByRole('button', { name: 'Depletion' })).toBeVisible();
        expect(await dashboard.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);

        const substeps = controls.locator('#depletion-substeps');
        await substeps.fill('3');
        await expect(substeps).toHaveValue('3');

        expect(errors, `console/page errors in narrow depletion panel:\n${errors.join('\n')}`).toEqual([]);
    });
});
