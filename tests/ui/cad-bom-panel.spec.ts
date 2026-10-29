import { test, expect } from '@playwright/test';
import { runCommand, waitForWorkbench } from './helpers';

/**
 * BOM panel is registered as a widget factory and opens through the command,
 * Nuke Tools row, and CAD Studio menu. The empty state is one card — the panel
 * no longer repeats its own header or the empty message.
 */
test('BOM panel opens bound and shows one empty state', async ({ page }) => {
    await page.goto('/');
    await waitForWorkbench(page);
    await runCommand(page, 'Open BOM');

    const panel = page.locator('.cad-bom-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    const empty = panel.locator('.cad-bom-empty');
    await expect(empty).toBeVisible();
    await expect(empty.locator('p')).toHaveText('No assembly instances');
    await expect(panel.locator('.cad-bom-header')).toHaveCount(0);
    await expect(empty.locator('.empty-hint')).toContainText('CAD viewport assembly panel');
});
