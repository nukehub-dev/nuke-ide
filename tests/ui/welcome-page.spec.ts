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
    await expect(page.locator('.gs-quote-text')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.gs-main-column')).toHaveCount(0);

    const container = page.locator('.gs-container');
    const scroll = await container.evaluate((element) => ({
        overflowY: getComputedStyle(element).overflowY,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight
    }));
    expect(scroll.overflowY).toBe('auto');
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
    const scrollTop = await container.evaluate((element) => {
        element.scrollTo(0, element.scrollHeight);
        return element.scrollTop;
    });
    expect(scrollTop).toBeGreaterThan(0);

    const recent = page.locator('.gs-link-recent').first();
    if ((await recent.count()) > 0) {
        await recent.hover();
        expect(await recent.evaluate((element) => getComputedStyle(element).textDecorationLine)).toBe('none');
    }

    expect(duplicateWarnings).toEqual([]);
    expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
