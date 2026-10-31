import { expect, test } from '@playwright/test';
import { collectErrors, runCommand, waitForWorkbench } from './helpers';

/**
 * Theia 1.76's `@theia/getting-started` extension owns the shared Welcome
 * contribution, while nuke-essentials supplies the Nuke widget. Registering
 * both view/command contributions produced a blank tab and duplicate warnings;
 * this guards the single-contribution binding.
 */
test('Welcome page renders the Nuke layout without duplicate registrations', async ({ page }) => {
    const errors = collectErrors(page);
    const duplicateWarnings: string[] = [];
    page.on('console', (message) => {
        if (message.type() === 'warning' && /getting\.started\.widget.*already registered/i.test(message.text())) {
            duplicateWarnings.push(message.text());
        }
    });

    await page.goto('/');
    await waitForWorkbench(page);
    await runCommand(page, 'Welcome');

    await expect(page.locator('.gs-header-title')).toHaveText('NukeIDE');
    await expect(page.locator('.gs-left-column')).toBeVisible();
    await expect(page.locator('.gs-main-column')).toHaveCount(0);

    expect(duplicateWarnings).toEqual([]);
    expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
