import { test, expect } from '@playwright/test';
import { collectErrors, waitForWorkbench } from './helpers';

/**
 * Boot smoke: the app loads, the workbench renders, and nothing errors at the
 * page level. This catches DI binding failures at startup, preload script
 * crashes, and unhandled exceptions during first paint.
 */
test.describe('boot', () => {
    test('workbench loads with zero console errors', async ({ page }) => {
        const errors = collectErrors(page);

        await page.goto('/');
        await waitForWorkbench(page);

        // The status bar renders only after the backend contributions are up —
        // a good proxy for "frontend + backend finished booting".
        await expect(page.locator('#theia-statusBar')).toBeVisible({ timeout: 60_000 });

        expect(errors, `console/page errors during boot:\n${errors.join('\n')}`).toEqual([]);
    });
});
