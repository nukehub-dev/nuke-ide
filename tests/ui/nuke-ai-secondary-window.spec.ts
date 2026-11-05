import { test, expect } from '@playwright/test';
import { collectErrors, waitForWorkbench } from './helpers';

/**
 * A Theia secondary window loads its own CSS bundle. The NukeAI chat widget is
 * moved into that window, so the welcome cards and tool cards must keep their
 * styling instead of falling back to an unstyled list.
 */
test.describe('NukeAI secondary window', () => {
    test('keeps welcome and card styles after detaching the chat', async ({ page, context }) => {
        const errors = collectErrors(page);
        await page.goto('/');
        await waitForWorkbench(page);

        await page.locator('#theia-app-shell').click({ position: { x: 10, y: 10 } });
        await page.keyboard.press('Control+Alt+I');
        await expect(page.locator('.theia-ChatInput')).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('.nuke-welcome-quick-actions')).toBeVisible({ timeout: 30_000 });

        const extract = page.locator('#extract-widget').first();
        await expect(extract).toBeVisible();
        const secondaryPagePromise = context.waitForEvent('page');
        await extract.click();
        const secondary = await secondaryPagePromise;
        await secondary.waitForLoadState('domcontentloaded');
        await expect(secondary.locator('.nuke-welcome-quick-actions')).toBeVisible({ timeout: 30_000 });

        const styles = await secondary.evaluate(() => {
            const actions = document.querySelector('.nuke-welcome-quick-actions') as HTMLElement;
            const action = document.querySelector('.nuke-welcome-quick-action') as HTMLElement;
            return {
                display: getComputedStyle(actions).display,
                padding: getComputedStyle(actions).padding,
                actionDisplay: getComputedStyle(action).display,
                actionBorder: getComputedStyle(action).borderTopWidth
            };
        });
        expect(styles.display).toBe('flex');
        expect(styles.padding).not.toBe('0px');
        expect(styles.actionDisplay).toBe('flex');
        expect(styles.actionBorder).not.toBe('0px');

        expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });
});
