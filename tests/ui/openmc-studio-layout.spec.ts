import { test, expect } from '@playwright/test';
import { runCommand, waitForWorkbench } from './helpers';

/**
 * Layout regressions in the OpenMC Studio chrome: full-width gallery cards,
 * centered empty-state glyphs, and project brand marks that resolve to real
 * assets rather than an empty span.
 */

test.describe('openmc studio layout', () => {
    test('CSG surface gallery cards share the column width', async ({ page }) => {
        await page.goto('/');
        await waitForWorkbench(page);
        await runCommand(page, 'Open CSG Builder');

        const gallery = page.locator('.csg-builder .surface-gallery');
        await expect(gallery).toBeVisible({ timeout: 30_000 });
        const cards = gallery.locator('.surface-card');
        await expect(cards.first()).toBeVisible();

        const widths = await cards.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width));
        expect(widths.length).toBeGreaterThan(4);
        expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    });

    test('empty-state icons are centered in their card', async ({ page }) => {
        await page.goto('/');
        await waitForWorkbench(page);
        await runCommand(page, 'Open Tally Configurator');

        const emptyState = page.locator('.tally-configurator-container .empty-state').first();
        await expect(emptyState).toBeVisible({ timeout: 30_000 });
        const icon = emptyState.locator('i').first();
        await expect(icon).toBeVisible();

        const [stateBox, iconBox] = await Promise.all([emptyState.boundingBox(), icon.boundingBox()]);
        expect(stateBox).not.toBeNull();
        expect(iconBox).not.toBeNull();
        const stateCenter = stateBox!.x + stateBox!.width / 2;
        const iconCenter = iconBox!.x + iconBox!.width / 2;
        expect(Math.abs(stateCenter - iconCenter)).toBeLessThanOrEqual(2);
    });

    test('dashboard header uses the theme-aware OpenMC mark', async ({ page }) => {
        await page.goto('/');
        await waitForWorkbench(page);
        await runCommand(page, 'Open Simulation Dashboard');

        const mark = page.locator('.simulation-dashboard .project-info h2 .openmc-brand-openmc');
        await expect(mark).toBeVisible({ timeout: 30_000 });
        const styles = await mark.evaluate((element) => {
            const computed = getComputedStyle(element);
            return {
                mask: computed.maskImage || (computed as CSSStyleDeclaration & { webkitMaskImage?: string }).webkitMaskImage,
                backgroundImage: computed.backgroundImage,
                background: computed.backgroundColor
            };
        });
        expect(styles.mask).toMatch(/data:image\/svg\+xml/);
        expect(styles.backgroundImage).toBe('none');
        expect(styles.background).not.toBe('rgba(0, 0, 0, 0)');
    });

    test('DAGMC editor keeps the theme-aware mesh icon', async ({ page }) => {
        await page.goto('/');
        await waitForWorkbench(page);
        await runCommand(page, 'Open DAGMC Editor');

        const mark = page.locator('.dagmc-editor .dagmc-editor-header h2 i.codicon-openmc-mesh');
        await expect(mark).toBeVisible({ timeout: 30_000 });
        await expect(mark).toHaveCSS('mask-image', /data:image\/svg\+xml/);
    });

    test('collapsed tab labels use the shared tooltip, not native title', async ({ page }) => {
        await page.setViewportSize({ width: 420, height: 900 });
        await page.goto('/');
        await waitForWorkbench(page);
        await runCommand(page, 'Open Simulation Dashboard');

        const materials = page.locator('.simulation-dashboard').getByRole('button', { name: 'Materials' });
        await expect(materials).toBeVisible({ timeout: 30_000 });
        expect(await materials.getAttribute('title')).toBeNull();
        await materials.hover();
        await expect(page.locator('.nuke-tooltip')).toBeVisible();
        await expect(page.locator('.nuke-tooltip')).toHaveText('Materials');
    });

    test('simulation action buttons never clip their labels', async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 900 });
        await page.goto('/');
        await waitForWorkbench(page);
        await runCommand(page, 'Open Simulation Dashboard');

        const dashboard = page.locator('.simulation-dashboard');
        await expect(dashboard).toBeVisible({ timeout: 30_000 });
        await dashboard.getByRole('button', { name: 'Simulation' }).click();
        const run = dashboard.getByRole('button', { name: /Run Simulation/ });
        await expect(run).toBeVisible();
        const clipped = await run.evaluate((element) => element.scrollHeight - element.clientHeight);
        expect(clipped).toBeLessThanOrEqual(1);
    });
});
