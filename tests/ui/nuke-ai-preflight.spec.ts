import { test, expect } from '@playwright/test';
import { collectErrors, runCommand, waitForWorkbench } from './helpers';

/**
 * Contextual NukeAI diagnostics must stop at the prerequisite check instead of
 * opening a chat when the workspace has no matching loaded state. The command
 * remains available; the warning explains what to load first.
 */
test.describe('NukeAI contextual preflight', () => {
    test('warns without starting a chat when no statepoint is loaded', async ({ page }) => {
        const errors = collectErrors(page);
        await page.goto('/');
        await waitForWorkbench(page);
        await expect(page.locator('#theia-statusBar')).toBeVisible({ timeout: 60_000 });

        await runCommand(page, 'NukeAI: Diagnose Active Statepoint');

        const warning = page
            .locator('.theia-notifications-overlay')
            .getByText('Open a statepoint in the Visualizer before running this NukeAI action.')
            .first();
        await expect(warning).toBeVisible({ timeout: 10_000 });

        expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });

    test('warns without starting a chat when no DAGMC viewer is open', async ({ page }) => {
        const errors = collectErrors(page);
        await page.goto('/');
        await waitForWorkbench(page);
        await expect(page.locator('#theia-statusBar')).toBeVisible({ timeout: 60_000 });

        await runCommand(page, 'NukeAI: Capture DAGMC View');

        const warning = page
            .locator('.theia-notifications-overlay')
            .getByText('Open a DAGMC model in the Visualizer before running this NukeAI action.')
            .first();
        await expect(warning).toBeVisible({ timeout: 10_000 });

        expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });
});
