import { test, expect, Page } from '@playwright/test';
import { collectErrors, runCommand, waitForWorkbench } from './helpers';

/**
 * Advanced settings navigation: named groups, name search, inline validation,
 * and a narrow editor panel with no horizontal page scroll.
 */

/**
 * Open the dashboard with the Settings tab active and expand Advanced.
 * @param page - Playwright page.
 * @returns The dashboard locator.
 */
async function openAdvanced(page: Page) {
    await page.goto('/');
    await waitForWorkbench(page);
    await runCommand(page, 'Open Simulation Dashboard');
    const dashboard = page.locator('.simulation-dashboard');
    await expect(dashboard).toBeVisible({ timeout: 30_000 });
    const advanced = dashboard.locator('.settings-section[data-section-title="Advanced"]');
    await expect(advanced).toBeVisible({ timeout: 30_000 });
    await advanced.locator('> h3').click();
    await expect(advanced.locator('.advanced-search input')).toBeVisible();
    return { dashboard, advanced };
}

test.describe('advanced settings', () => {
    test('groups are navigable and the filter narrows them by setting name', async ({ page }) => {
        const errors = collectErrors(page);
        const { advanced } = await openAdvanced(page);

        for (const group of ['Execution', 'Convergence', 'Physics', 'Limits', 'Diagnostics']) {
            await expect(advanced.locator(`.settings-section[data-section-title="${group}"]`)).toBeVisible();
        }

        const filter = advanced.locator('.advanced-search input');
        await filter.fill('keff_trigger');
        await expect(advanced.locator('.settings-section[data-section-title="Convergence"]')).toBeVisible();
        await expect(advanced.locator('.settings-section[data-section-title="Execution"]')).toHaveCount(0);
        await expect(advanced.locator('.settings-section[data-section-title="Limits"]')).toHaveCount(0);

        await filter.fill('max_secondaries');
        await expect(advanced.locator('.settings-section[data-section-title="Limits"]')).toBeVisible();
        await expect(advanced.locator('.settings-section[data-section-title="Convergence"]')).toHaveCount(0);

        await filter.fill('not_a_setting');
        await expect(advanced.locator('.advanced-empty')).toContainText('No setting matches');

        await filter.fill('');
        await expect(advanced.locator('.settings-section[data-section-title="Execution"]')).toBeVisible();
        expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });

    test('invalid threads show a group error dot and inline message', async ({ page }) => {
        const errors = collectErrors(page);
        const { advanced } = await openAdvanced(page);

        const execution = advanced.locator('.settings-section[data-section-title="Execution"]');
        await execution.locator('> h3').click();
        const threads = execution.getByLabel('OpenMP threads');
        await threads.fill('0');
        await expect(execution.locator('.section-status-dot.error')).toBeVisible();
        await expect(execution.locator('.section-status-message')).toContainText('OpenMP threads must be a whole number');

        await threads.fill('');
        await expect(execution.locator('.section-status-dot')).toHaveCount(0);
        expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });

    test('advanced groups stay usable in a narrow panel without page scroll', async ({ page }) => {
        const errors = collectErrors(page);
        await page.setViewportSize({ width: 420, height: 820 });
        const { advanced } = await openAdvanced(page);

        const filter = advanced.locator('.advanced-search input');
        await expect(filter).toBeVisible();
        await filter.fill('free_gas_threshold');
        const physics = advanced.locator('.settings-section[data-section-title="Physics"]');
        await expect(physics).toBeVisible();
        await expect(physics.getByLabel('Free-gas threshold (kT)')).toBeVisible();

        const horizontalOverflow = await advanced.evaluate((el) => Math.max(el.scrollWidth - el.clientWidth, 0));
        expect(horizontalOverflow, 'Advanced panel must not scroll horizontally in a narrow panel').toBeLessThanOrEqual(1);

        expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });
});
