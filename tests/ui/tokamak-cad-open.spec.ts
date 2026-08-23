import { test, expect, Page } from '@playwright/test';
import { collectErrors, waitForWorkbench, runCommand } from './helpers';

/**
 * GUI regression snapshots for the nuke-cad chrome:
 * 1. Empty-state card is centered and not clipped.
 * 2. Loading the tokamak document shows a centered loading overlay (regression for
 *    the right-edge clipping caused by the imperative three.js canvas pushing the
 *    spinner out of the flex container).
 */

test.setTimeout(120_000);

test('CAD Viewport empty state is centered and readable', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    await runCommand(page, 'Open CAD Viewport');
    const viewport = page.locator('.cad-viewport.empty').first();
    await expect(viewport).toBeVisible({ timeout: 30_000 });

    await viewport.screenshot({ path: 'test-results/cad-viewport-empty.png' });
    await page.screenshot({ path: 'test-results/cad-viewport-empty-full.png' });

    const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});

test('tokamak nuke-cad fixture loading overlay is centered', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    await openFileByQuickOpen(page, 'tokamak_with_divertor.nuke-cad');

    const viewport = page.locator('.cad-viewport').first();
    await expect(viewport).toBeVisible({ timeout: 30_000 });

    await page.waitForTimeout(2000);
    await viewport.screenshot({ path: 'test-results/tokamak-cad-loading.png' });

    // Spot-check that the message text is centered (x within 30 %..70 % of viewport).
    const messageRect = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('*')).find(
            (e) => e.children.length === 0 && (e.textContent ?? '').trim().startsWith('Building')
        );
        return el ? el.getBoundingClientRect() : null;
    });
    expect(messageRect, 'loading message not found').not.toBeNull();
    const viewportRect = await viewport.boundingBox();
    expect(viewportRect, 'viewport bounding box').not.toBeNull();
    const center = messageRect!.x + messageRect!.width / 2;
    const viewportCenter = viewportRect!.x + viewportRect!.width / 2;
    expect(Math.abs(center - viewportCenter)).toBeLessThan(viewportRect!.width * 0.2);

    // Intentionally do not wait for the full backend build in this snapshot test.
    const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});

test('document-mode header toolbar renders with grouped actions and hides welcome card', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    await runCommand(page, 'New CAD Document');
    const viewport = page.locator('.cad-viewport').first();
    await expect(viewport).toBeVisible({ timeout: 30_000 });

    // After creating a document the welcome card should be hidden and the
    // document-mode hint should be shown instead.
    await expect(viewport.locator('.nuke-empty-state')).toBeHidden();
    const hint = viewport.locator('.cad-viewport-document-hint').first();
    await expect(hint).toBeVisible({ timeout: 10_000 });

    // The redesigned header toolbar should render with the document title on the
    // left and grouped action buttons on the right.
    const toolbar = page.locator('.cad-document-toolbar').first();
    await expect(toolbar).toBeVisible({ timeout: 10_000 });
    await expect(toolbar.locator('.cad-document-toolbar-name')).toContainText('Untitled');
    await expect(toolbar.locator('.nuke-toolbar-group')).toHaveCount(6);
    await expect(toolbar.locator('[role="group"][aria-label="Document"]')).toBeVisible();
    await expect(toolbar.locator('[role="group"][aria-label="Sketch"]')).toBeVisible();
    await expect(toolbar.locator('[role="group"][aria-label="Additive"]')).toBeVisible();
    await expect(toolbar.locator('[role="group"][aria-label="Boolean"]')).toBeVisible();
    await expect(toolbar.locator('[role="group"][aria-label="Dress-up"]')).toBeVisible();
    await expect(toolbar.locator('[role="group"][aria-label="Pattern"]')).toBeVisible();

    await viewport.screenshot({ path: 'test-results/cad-viewport-document-toolbar.png' });

    // Pad is disabled until a sketch is selected; verify the toolbar state is
    // sensible and no dialog opens when a disabled feature button is clicked.
    const padButton = toolbar.locator('button', { hasText: 'Pad' }).first();
    await expect(padButton).toBeVisible();
    await expect(padButton).toBeDisabled();
    await padButton.click({ force: true });
    await expect(page.locator('.nuke-dialog').first()).toBeHidden();

    const severe = errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles'));
    expect(severe, `unexpected severe errors:\n${severe.join('\n')}`).toEqual([]);
});

async function openFileByQuickOpen(page: Page, name: string): Promise<void> {
    await page.locator('#theia-app-shell').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Control+P');
    const input = page.locator('.quick-input-widget input');
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(name);
    const row = page.locator('.quick-input-widget .monaco-list-row', { hasText: name }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    await expect(input).toBeHidden();
}
