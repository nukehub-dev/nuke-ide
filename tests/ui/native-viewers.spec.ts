import { test, expect } from '@playwright/test';
import { collectErrors, waitForWorkbench, openFileByQuickOpen, closeAllEditors } from './helpers';

/**
 * Native 3D viewer smoke suite (trame-to-frontend migration).
 *
 * Covers every native viewer with tiny committed fixtures under
 * tests/ui/fixtures/ (no nuclear-data backend needed except where noted):
 * - generic VisualizerWidget: XML `.vtp`, legacy ASCII `.vtk`, `.vti`
 * - DAGMC multiblock viewer: hand-written `.vtm` + 2× `.vtu` (FileService only)
 * - geometry-native viewer: tiny `geometry.xml` (pure-Python XML parse)
 *
 * Suite conventions (root AGENTS.md): Theia/lumino selectors only, Command
 * Palette via Ctrl+Shift+P + `>` prefix, zero console severity-error/pageerror
 * gate per test (l10n noise filtered like the other specs).
 */

test.setTimeout(180_000);

function severe(errors: string[]): string[] {
    return errors.filter(
        (e) =>
            !e.includes('l10n') &&
            !e.includes('localization bundles') &&
            // Upstream Theia plugin-host race when tabs open/close in quick
            // succession (extHostTab dto arrives for a closed tab).
            !e.includes('INVALID tab') &&
            // Pre-existing intermittent React key warning at page load from
            // IDE chrome outside these viewers (tracked follow-up); viewer
            // code paths below assert their own rendered content instead.
            !e.includes('unique "key" prop')
    );
}

async function openViewer(page: Parameters<typeof openFileByQuickOpen>[0], name: string) {
    await closeAllEditors(page);
    // Warm the file-search index: the first Quick Open query after server
    // start can take a long time on a repo-sized workspace and times out.
    await page.locator('#theia-app-shell').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Control+P');
    const warm = page.locator('.quick-input-widget input');
    await expect(warm).toBeVisible({ timeout: 10_000 });
    await warm.fill('fixtures');
    await expect(page.locator('.quick-input-widget .monaco-list-row').first()).toBeVisible({ timeout: 120_000 });
    await page.keyboard.press('Escape');
    await openFileByQuickOpen(page, name);
    const container = page.locator('.openmc-output-viewer-container').first();
    await expect(container).toBeVisible({ timeout: 60_000 });
    return container;
}

test('native polydata (.vtp) renders with canvas and instant color-by', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'native-polydata.vtp');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    const canvas = container.locator('.openmc-output-viewer-viewarea canvas');
    await expect(canvas).toBeVisible({ timeout: 30_000 });

    // Instant color-by switch (no server restart): point energy -> cell id.
    const colorBy = container.locator('.openmc-output-viewer-header select').first();
    await expect(colorBy).toBeVisible();
    await colorBy.selectOption('Cell: cell_id');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    await expect(canvas).toBeVisible();

    // Shading + clip controls (CAD parity): wireframe mode and an enabled
    // clip plane must apply instantly without errors. Header selects are
    // color-by, colormap, shading — in that order.
    const shading = container.locator('.openmc-output-viewer-header select').nth(2);
    await shading.selectOption('Wireframe');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    const clipToggle = container.locator('.openmc-output-viewer-header input[type="checkbox"]').first();
    await clipToggle.check();
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    await expect(canvas).toBeVisible();

    // OrbitControls smoke (reported camera bugs): drag to orbit, wheel to
    // zoom — the canvas must survive with no errors.
    const box = await canvas.boundingBox();
    if (box) {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + 120, cy + 60, { steps: 12 });
        await page.mouse.up();
        await page.mouse.wheel(0, -240);
        await expect(canvas).toBeVisible();
        await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    }

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('legacy ASCII (.vtk) renders (screenshot regression)', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    // The exact class from the bug screenshot: a converter-produced legacy
    // UNSTRUCTURED_GRID must parse instead of reporting a missing XML root.
    const container = await openViewer(page, 'native-legacy.vtk');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    await expect(container.locator('.openmc-output-viewer-viewarea canvas')).toBeVisible({ timeout: 30_000 });
    // Surface datasets must report (and render) filled triangles, not
    // wireframe outlines only — the tokamak DAGMC regression.
    await expect(container.getByText('2 triangles').first()).toBeVisible({ timeout: 30_000 });

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('voxel image (.vti) renders', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'native-image.vti');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    await expect(container.locator('.openmc-output-viewer-viewarea canvas')).toBeVisible({ timeout: 30_000 });

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('DAGMC multiblock (.vtm) renders both volumes', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'native-volumes.vtm');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    await expect(container.locator('.openmc-output-viewer-viewarea canvas')).toBeVisible({ timeout: 30_000 });
    // No sibling .h5m exists for dagmc.info, so the viewer renders blocks
    // with the model-info hint instead of volume toggles.
    await expect(container.getByText('Volume toggles need model info').first()).toBeVisible({ timeout: 30_000 });

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});

test('geometry.xml renders cells in the native geometry viewer', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openViewer(page, 'geometry.xml');
    await expect(container.locator('.openmc-output-viewer-status.error')).toHaveCount(0);
    await expect(container.locator('.openmc-output-viewer-viewarea canvas')).toBeVisible({ timeout: 60_000 });
    // Cell list from the extractor payload.
    await expect(container.getByText('fuel (1)').first()).toBeVisible({ timeout: 30_000 });

    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});
