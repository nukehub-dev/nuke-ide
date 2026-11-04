import { test, expect, type Locator, type Page } from '@playwright/test';
import { collectErrors, runCommand, waitForWorkbench } from './helpers';

/**
 * Empty right-area panels share one illustrated NukeEmptyState card. The CAD
 * panels also offer the action that resolves their empty state.
 */

interface EmptyPanelCase {
    readonly command: string;
    readonly selector: string;
}

const PANELS: readonly EmptyPanelCase[] = [
    { command: 'Open Feature Tree', selector: '.cad-feature-tree-panel' },
    { command: 'Open Model Outline', selector: '.cad-outline-panel' },
    { command: 'Open BOM', selector: '.cad-bom-panel' },
    { command: 'Open Dataset Inspector', selector: '.dataset-inspector-panel' },
    { command: 'Open Viewer Settings', selector: '.viewer-settings-panel' },
    { command: 'Open DAGMC Outline', selector: '.dagmc-outline-panel' },
    { command: 'Open CSG Outline', selector: '.csg-outline-panel' }
];

async function openEmptyPanel(page: Page, testCase: EmptyPanelCase): Promise<Locator> {
    await runCommand(page, testCase.command);
    const panel = page.locator(testCase.selector).first();
    await expect(panel).toBeVisible({ timeout: 30_000 });
    const empty = panel.locator('.nuke-empty-state').first();
    await expect(empty).toBeVisible();
    await expect(empty.locator('.nuke-empty-state-illustration')).toBeVisible();
    return empty;
}

test('empty right-area panels use the same illustrated card', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    for (const testCase of PANELS) {
        await openEmptyPanel(page, testCase);
    }

    await expect(page.locator('.nuke-domain-icon-csg').first()).toBeVisible();

    const featureTree = page.locator('.cad-feature-tree-panel .nuke-empty-state').first();
    await runCommand(page, 'Open Feature Tree');
    await expect(featureTree.getByRole('button', { name: 'New CAD Document' })).toBeVisible();
    await expect(featureTree.getByRole('button', { name: 'Open CAD Viewport' })).toBeVisible();

    await runCommand(page, 'Open Model Outline');
    const outline = page.locator('.cad-outline-panel .nuke-empty-state').first();
    await expect(outline.getByRole('button', { name: 'Open CAD Viewport' })).toBeVisible();

    await runCommand(page, 'Open BOM');
    const bom = page.locator('.cad-bom-panel .nuke-empty-state').first();
    await expect(bom.getByRole('button', { name: 'Open CAD Viewport' })).toBeVisible();

    expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
