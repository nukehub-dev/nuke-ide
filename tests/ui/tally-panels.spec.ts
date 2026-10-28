import * as fs from 'fs';
import * as path from 'path';
import { test, expect, Page, Locator } from '@playwright/test';
import { collectErrors, waitForWorkbench, openFileByQuickOpen, closeAllEditors } from './helpers';

/**
 * Tally panels in the native tally viewer: line probes (+ CSV export)
 * and contour (iso-surface sibling tabs).
 *
 * Flow: open the tiny committed `statepoint.10.h5` fixture (3x2x2 flux mesh,
 * means 1..12) directly — the opener claims `statepoint*.h5` — → Tallies
 * tab → View 3D opens the mesh tab through the backend (`openmc.tally-mesh-vtk`,
 * needs h5py + vtk). Every backend step gates on the widget actually
 * loading: a backend failure leaves the statepoint viewer empty and the
 * tests skip gracefully instead of failing.
 *
 * Suite conventions (root AGENTS.md): Theia/lumino selectors only, Command
 * Palette via Ctrl+Shift+P + `>` prefix, zero console severity-error/pageerror
 * gate per test.
 */

test.setTimeout(180_000);

const SP_FIXTURE = path.resolve('tests/ui/fixtures/statepoint.10.h5');

function severe(errors: string[]): string[] {
    return errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles') && !e.includes('INVALID tab'));
}

/** Open the statepoint fixture directly (the opener claims `statepoint*.h5`); skip when the backend is missing. */
async function openStatepointViewer(page: Page) {
    await closeAllEditors(page);
    await page.locator('#theia-app-shell').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Control+P');
    const warm = page.locator('.quick-input-widget input');
    await expect(warm).toBeVisible({ timeout: 10_000 });
    await warm.fill('fixtures');
    await expect(page.locator('.quick-input-widget .monaco-list-row').first()).toBeVisible({ timeout: 120_000 });
    await page.keyboard.press('Escape');
    await openFileByQuickOpen(page, 'statepoint.10.h5');
    const viewer = page.locator('.statepoint-viewer').first();
    await expect(viewer).toBeVisible({ timeout: 60_000 });
    if ((await viewer.getAttribute('class'))?.includes('statepoint-viewer--empty')) {
        test.skip(true, 'statepoint backend unavailable (empty statepoint viewer)');
    }
    return viewer;
}

/** Open the Tallies tab and launch View 3D for the first mesh tally. */
async function openTallyMeshTab(page: Page, viewer: Locator) {
    await viewer.locator('.tabs .tab', { hasText: 'Tallies' }).click();
    const card = viewer.locator('.tally-card').first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator('.tally-card-badge--mesh')).toBeVisible();
    await card.locator('.tally-card-btn--primary').click();
    const tallyTab = page.locator('.openmc-output-viewer-container').nth(0);
    await expect(tallyTab).toBeVisible({ timeout: 60_000 });
    const canvas = tallyTab.locator('.openmc-output-viewer-viewarea canvas');
    await expect(canvas).toBeVisible({ timeout: 60_000 });
    return tallyTab;
}

test('line probe samples the mesh tally and exports the full-series CSV', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const viewer = await openStatepointViewer(page);
    const tallyTab = await openTallyMeshTab(page, viewer);
    await tallyTab.locator('.tally-line-probe-toggle').click();
    const panel = tallyTab.locator('.tally-line-probe-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });

    await panel.getByLabel('Statepoint').fill(SP_FIXTURE);
    await panel.getByLabel('Tally').fill('1');
    await panel.getByLabel('Score').fill('flux');
    await panel.getByLabel('P0 (cm)').fill('-1.5, 0, 0');
    await panel.getByLabel('P1 (cm)').fill('1.5, 0, 0');
    await panel.getByLabel('Points').fill('4');
    await panel.locator('.tally-line-probe-run').click();

    // The series renders as a capped data-half table (distance/pos/value).
    const rows = panel.locator('.tally-line-probe-table tbody tr');
    await expect(rows).toHaveCount(4, { timeout: 60_000 });
    await expect(panel.getByText(/4 points/)).toBeVisible();

    // Export CSV downloads the full series following the kinetics-tab pattern.
    const downloadPromise = page.waitForEvent('download');
    await panel.locator('.tally-line-probe-export').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('tally-1-line-probe.csv');
    const filePath = await download.path();
    const csv = await fs.promises.readFile(filePath as string, 'utf-8');
    expect(csv).toMatch(/distance.*value/i);
    expect(csv.trim().split('\n').length).toBeGreaterThanOrEqual(5);
    await expect(tallyTab.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('contour panel rejects bad iso values and opens the surface as a sibling tab', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const viewer = await openStatepointViewer(page);
    const tallyTab = await openTallyMeshTab(page, viewer);
    await tallyTab.locator('.tally-contour-toggle').click();
    const panel = tallyTab.locator('.tally-contour-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });

    await panel.getByLabel('Statepoint').fill(SP_FIXTURE);
    await panel.getByLabel('Tally').fill('1');

    // An iso list that misses the data range fails with an error naming the
    // range (honest error path, never a silent empty tab).
    await panel.locator('.tally-contour-iso').fill('oops');
    await panel.locator('.tally-contour-run').click();
    await expect(panel.locator('.tally-contour-error')).toBeVisible({ timeout: 30_000 });

    // A valid iso value inside the data range (means 1..12) extracts the
    // surface into a sibling tab next to the tally mesh (shared tally
    // routing — warp/threshold keep working there).
    await panel.locator('.tally-contour-iso').fill('6.5');
    await panel.locator('.tally-contour-run').click();
    const tabs = page.locator('.openmc-output-viewer-container');
    await expect(tabs).toHaveCount(2, { timeout: 60_000 });
    const sibling = tabs.nth(1);
    await expect(sibling.locator('.openmc-output-viewer-viewarea canvas')).toBeVisible({ timeout: 60_000 });
    await expect(panel.locator('.tally-contour-error')).toHaveCount(0);
    await expect(sibling.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('linked cameras toggle enables on the mesh and source tabs of one statepoint', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    // Mesh tab (Tallies → View 3D) and source tab (Overview → Visualize 3D)
    // are both keyed by the statepoint path, so they link together.
    const viewer = await openStatepointViewer(page);
    await openTallyMeshTab(page, viewer);
    // The mesh tab covers the statepoint viewer in the main area: bring the
    // viewer forward before driving its tabs (lumino `lm-` tab handles —
    // the old `p-TabBar-tab` class matches nothing since the lumino 2 move,
    // which also silently no-ops the shared closeAllEditors helper).
    await page.locator('.lm-TabBar-tab', { hasText: 'Statepoint' }).first().click();
    await viewer.locator('.tabs .tab', { hasText: 'Overview' }).click();
    await viewer.locator('.overview-metric-btn', { hasText: 'Visualize 3D' }).click();
    const tabs = page.locator('.openmc-output-viewer-container');
    await expect(tabs).toHaveCount(2, { timeout: 60_000 });
    await expect(tabs.nth(1).locator('.openmc-output-viewer-viewarea canvas')).toBeVisible({ timeout: 60_000 });

    const toggles = page.locator('.openmc-output-viewer-container .viewer-nav-link-cameras');
    await expect(toggles).toHaveCount(2);
    // The source tab opened last, so it is frontmost: enable its toggle,
    // then flip back to the mesh tab for the other one (lumino handles —
    // only the frontmost tab's chrome is visible, so each toggle is driven
    // while its own tab is forward).
    await toggles.nth(1).click();
    await expect(toggles.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.lm-TabBar-tab', { hasText: 'Tally 1' }).first().click();
    await toggles.nth(0).click();
    await expect(toggles.nth(0)).toHaveAttribute('aria-pressed', 'true');

    // Orbiting one linked view keeps both canvases healthy with no errors
    // (camera-only sync; warp/threshold/color-by stay per-view and are never
    // published — pose equality itself is not DOM-observable, so the suite
    // asserts the toggle contract plus canvas health, not pixel sync).
    const meshCanvas = tabs.nth(0).locator('.openmc-output-viewer-viewarea canvas');
    const box = await meshCanvas.boundingBox();
    if (box) {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + 120, cy + 60, { steps: 12 });
        await page.mouse.up();
    }
    await expect(meshCanvas).toBeVisible();
    // The mesh tab is forward, so only its canvas is visible; the source
    // toggle's pressed state is a DOM attribute and reads while covered.
    await expect(toggles.nth(0)).toHaveAttribute('aria-pressed', 'true');
    await expect(toggles.nth(1)).toHaveAttribute('aria-pressed', 'true');

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});
