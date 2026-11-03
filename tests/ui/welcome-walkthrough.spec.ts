import { test, expect } from '@playwright/test';
import { collectErrors, waitForWorkbench } from './helpers';

/**
 * Walkthrough smoke: the contributed AI walkthrough is selectable and the
 * NukeIDE Welcome widget renders it. The widget replaces Theia's Welcome, so a
 * regression here leaves `walkthrough.open` closing its picker with nothing on
 * screen.
 */
test.describe('welcome walkthrough', () => {
    test('selecting a walkthrough renders it in the Welcome view', async ({ page }) => {
        const errors = collectErrors(page);

        await page.goto('/');
        await waitForWorkbench(page);

        await page.locator('#theia-app-shell').click({ position: { x: 10, y: 10 } });
        await page.keyboard.press('Control+Shift+P');
        const input = page.locator('.quick-input-widget input');
        await expect(input).toBeVisible();
        await input.fill('>Open Walkthrough');
        const command = page.locator('.quick-input-widget .monaco-list-row', { hasText: 'Open Walkthrough' }).first();
        await expect(command).toBeVisible();
        await command.click();

        // The same quick input reopens with the contributed walkthroughs.
        const item = page.locator('.quick-input-widget .monaco-list-row').filter({ hasText: 'Get started with AI' }).first();
        await item.waitFor({ state: 'visible', timeout: 30_000 });
        await item.click();

        await expect(page.locator('.gs-walkthrough-container')).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('.gs-walkthrough-container')).toContainText('Get started with AI');

        expect(errors, `console/page errors during the walkthrough flow:\n${errors.join('\n')}`).toEqual([]);
    });
});
