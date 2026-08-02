import { test, expect } from '@playwright/test';
import { collectErrors, runCommand, waitForWorkbench } from './helpers';

/**
 * Controlled-select regression: changing a select in the settings tab must
 * stick (the select must not snap back to its previous value on the next
 * render pass).
 */
test.describe('controlled selects', () => {
    test('settings tab select value sticks after change', async ({ page }) => {
        const errors = collectErrors(page);
        await page.goto('/');
        await waitForWorkbench(page);

        await runCommand(page, 'Open Simulation Dashboard');
        const dashboard = page.locator('.simulation-dashboard');
        await expect(dashboard).toBeVisible({ timeout: 30_000 });

        // The Settings tab is the default; find the first select with > 1 option
        const select = dashboard.locator('select').first();
        await expect(select).toBeVisible({ timeout: 30_000 });

        const options = await select.locator('option').allTextContents();
        expect(options.length, 'settings select should offer multiple options').toBeGreaterThan(1);

        const current = await select.inputValue();
        const optionValues = await select.locator('option').evaluateAll((nodes) => nodes.map((n) => (n as HTMLOptionElement).value));
        const next = optionValues.find((v) => v !== current);
        expect(next, 'no alternative option found').toBeTruthy();

        await select.selectOption(next!);

        // Let any state round-trip / re-render settle, then verify it stuck
        await page.waitForTimeout(500);
        await expect(select).toHaveValue(next!);

        expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });
});
