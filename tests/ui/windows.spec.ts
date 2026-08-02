import { test, expect } from '@playwright/test';
import { collectErrors, expectNonEmptyContent, runCommand, waitForWorkbench } from './helpers';

/**
 * Dedicated windows: each opens via its command and paints non-empty content
 * with zero console errors. This catches DI binding failures ("No matching
 * bindings found") and blank widgets that never update().
 */

const WINDOWS: { label: string; widgetSelector: string }[] = [
    { label: 'Volume Calculation', widgetSelector: '.volume-calc-widget' },
    { label: 'MGXS Generator', widgetSelector: '.mgxs-generator-widget' },
    { label: 'Native Plotting', widgetSelector: '.native-plotting-widget' },
    { label: 'Nuclear Data', widgetSelector: '.nuclear-data-widget' }
];

test.describe('dedicated windows', () => {
    for (const { label, widgetSelector } of WINDOWS) {
        test(`'${label}' opens with content and no errors`, async ({ page }) => {
            const errors = collectErrors(page);
            await page.goto('/');
            await waitForWorkbench(page);

            await runCommand(page, label);

            // A new main-area tab must appear with non-empty content
            const widget = page.locator(widgetSelector);
            await expect(widget).toBeVisible({ timeout: 30_000 });
            await expectNonEmptyContent(widget, 30);

            expect(errors, `console/page errors while opening '${label}':\n${errors.join('\n')}`).toEqual([]);
        });
    }
});
