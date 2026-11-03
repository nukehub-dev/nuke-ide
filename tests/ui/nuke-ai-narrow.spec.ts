import { test, expect } from '@playwright/test';
import { collectErrors, waitForWorkbench } from './helpers';

/**
 * NukeAI at a low width: the chat view lives in a dockable right panel, and a
 * narrow window squeezes it to ~100 px. The welcome cards and the composer must
 * stay inside that panel instead of clipping or overlapping.
 */
test.describe('NukeAI low width', () => {
    test('chat welcome and composer fit a narrow docked panel', async ({ page }) => {
        const errors = collectErrors(page);
        await page.setViewportSize({ width: 380, height: 800 });
        await page.goto('/');
        await waitForWorkbench(page);

        await page.locator('#theia-app-shell').click({ position: { x: 10, y: 10 } });
        await page.keyboard.press('Control+Alt+I');
        const chatInput = page.locator('.theia-ChatInput');
        await expect(chatInput).toBeVisible({ timeout: 30_000 });

        const metrics = await page.evaluate(() => {
            const measure = (selector: string) => {
                const node = document.querySelector(selector) as HTMLElement | null;
                if (node === null) {
                    return undefined;
                }
                const rect = node.getBoundingClientRect();
                return { scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, right: Math.round(rect.right) };
            };
            return {
                quickActions: measure('.nuke-welcome-quick-actions'),
                options: measure('.theia-ChatInputOptions'),
                send: measure('.theia-ChatInputOptions-right .option'),
                input: measure('.theia-ChatInput')
            };
        });

        expect(metrics.quickActions, 'welcome quick actions must render').toBeDefined();
        expect(metrics.options, 'composer options must render').toBeDefined();
        expect(metrics.quickActions!.scrollWidth).toBeLessThanOrEqual(metrics.quickActions!.clientWidth + 1);
        expect(metrics.options!.scrollWidth).toBeLessThanOrEqual(metrics.options!.clientWidth + 1);
        expect(metrics.send!.right).toBeLessThanOrEqual(metrics.input!.right + 1);

        expect(errors, `console/page errors in the narrow chat layout:\n${errors.join('\n')}`).toEqual([]);
    });
});
