import { test, expect } from '@playwright/test';
import { collectErrors, waitForWorkbench } from './helpers';

/**
 * Walkthrough smoke: the Help menu offers a named NukeAI walkthrough, the
 * NukeIDE Welcome widget renders it, and its copy is NukeAI's rather than
 * Theia's generic AI onboarding.
 */
test.describe('NukeAI walkthrough', () => {
    test('Help opens the NukeAI walkthrough in the Welcome view', async ({ page }) => {
        const errors = collectErrors(page);

        await page.goto('/');
        await waitForWorkbench(page);

        await page.locator('.lm-MenuBar-item', { hasText: 'Help' }).first().click();
        const items = page.locator('.lm-Menu-item .lm-Menu-itemLabel');
        const labels = (await items.allInnerTexts()).map((label) => label.trim());
        expect(labels).toContain('Welcome');
        expect(labels).toContain('Documentation');
        expect(labels).toContain('NukeAI Walkthrough...');
        expect(labels).toContain('About');
        expect(labels).not.toContain('Open Walkthrough...');
        expect(labels.indexOf('Welcome')).toBeLessThan(labels.indexOf('Documentation'));
        expect(labels.indexOf('Documentation')).toBeLessThan(labels.indexOf('NukeAI Walkthrough...'));
        expect(labels.indexOf('NukeAI Walkthrough...')).toBeLessThan(labels.indexOf('About'));

        await page.locator('.lm-Menu-item', { hasText: 'NukeAI Walkthrough...' }).first().click();

        const container = page.locator('.gs-walkthrough-container');
        await expect(container).toBeVisible({ timeout: 30_000 });
        await expect(container).toContainText('Get started with NukeAI');
        await expect(container).toContainText('NukeAI in NukeIDE');

        // The service opens the first pending step; select the opening slide.
        await container.locator('.gs-walkthrough-step-item', { hasText: 'NukeAI in NukeIDE' }).first().click();
        await expect(container).toContainText('Read the NukeAI guide');
        await expect(container).toContainText('NukeIDE on GitHub');
        await expect(container).not.toContainText('theia-ide.org');

        expect(errors, `console/page errors during the walkthrough flow:\n${errors.join('\n')}`).toEqual([]);
    });
});
