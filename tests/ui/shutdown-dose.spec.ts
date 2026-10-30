import { test, expect, Page } from '@playwright/test';
import { collectErrors, createBlankProject, expectNonEmptyContent, openFileByQuickOpen, runCommand, waitForWorkbench } from './helpers';

/**
 * Warm the workspace file index. The first Quick Open query builds the index
 * and can take ~40 s in a cold headless run; later queries are fast.
 */
async function warmFileSearch(page: Page): Promise<void> {
    await page.locator('#theia-app-shell').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Control+P');
    const input = page.locator('.quick-input-widget input');
    await input.fill('package.json');
    await expect(page.locator('.quick-input-widget .monaco-list-row').first()).toBeVisible({ timeout: 120_000 });
    await page.keyboard.press('Escape');
}

/**
 * Shutdown Dose wizard: method cards, gated navigation, empty states, saved
 * result cards, and narrow-panel layout. The project/result fixtures under
 * `tests/ui/fixtures/` point at a workspace-relative summary directory so no
 * machine-specific path is committed.
 */

test.setTimeout(300_000);

test.describe('shutdown dose wizard', () => {
    test('opens with method cards and blocks Next until a region is selected', async ({ page }) => {
        const errors = collectErrors(page);
        await page.goto('/');
        await waitForWorkbench(page);

        await createBlankProject(page);
        await runCommand(page, 'Shutdown Dose');

        const widget = page.locator('.shutdown-dose-widget');
        await expect(widget).toBeVisible({ timeout: 30_000 });
        await expect(widget.locator('.shutdown-dose-step')).toHaveCount(5);
        await expect(widget.locator('.shutdown-dose-method-card')).toHaveCount(2);

        // Empty project: the cell picker explains the next action and the
        // forward button stays blocked by the missing activation region.
        await expect(widget.getByText('No cells defined yet')).toBeVisible();
        const next = widget.locator('.shutdown-dose-footer .theia-button.primary');
        await expect(next).toBeDisabled();

        // D1S swaps the domain panel for the coupled-transport explanation.
        await widget.locator('.shutdown-dose-method-card', { hasText: 'D1S' }).click();
        await expect(widget.getByText('D1S uses one coupled transport solve')).toBeVisible();
        await widget.locator('.shutdown-dose-method-card', { hasText: 'R2S' }).click();
        await expect(widget.getByRole('heading', { name: /Activation domain/ })).toBeVisible();

        expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });

    test('loads a saved result and renders cards without overflow in a narrow panel', async ({ page }) => {
        const errors = collectErrors(page);
        await page.goto('/');
        await waitForWorkbench(page);

        await warmFileSearch(page);
        await openFileByQuickOpen(page, 'shutdown-dose-project');
        await runCommand(page, 'Shutdown Dose');

        const widget = page.locator('.shutdown-dose-widget');
        await expect(widget).toBeVisible({ timeout: 30_000 });
        await expect(widget.locator('.shutdown-dose-result-card').first()).toBeVisible({ timeout: 30_000 });
        await expect(widget.getByRole('heading', { name: /Dose response/ })).toBeVisible();
        await expect(widget.getByText('Total activity', { exact: true })).toBeVisible();
        await expect(widget.getByRole('heading', { name: /Photon tallies/ })).toBeVisible();
        await expect(widget.getByText('Co60, Ni65')).toBeVisible();
        await expectNonEmptyContent(widget, 200);

        // The method page exposes the explicit bounding-box override.
        await widget.getByRole('button', { name: /Method & model/ }).click();
        await expect(widget.getByText('Bounding box overrides (optional)')).toBeVisible();
        await widget.getByText('Bounding box overrides (optional)').click();
        await expect(widget.getByLabel('Cell 1 lower X')).toBeVisible();
        await widget.getByRole('button', { name: /Results/ }).click();

        // Narrow panel: stepper collapses labels, tables/cards stay inside.
        await page.setViewportSize({ width: 700, height: 900 });
        await expect(widget.locator('.shutdown-dose-stepper')).toBeVisible();
        const overflow = await widget.evaluate((element) => element.scrollWidth - element.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);
        await expect(widget.locator('.shutdown-dose-result-card').first()).toBeVisible();

        expect(errors, `console/page errors in narrow shutdown-dose panel:\n${errors.join('\n')}`).toEqual([]);
    });
});
