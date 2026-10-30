import * as fs from 'fs';
import * as path from 'path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import {
    closeAllEditors,
    collectErrors,
    createBlankProject,
    dismissNotifications,
    expectNonEmptyContent,
    openFileByQuickOpen,
    runCommand,
    waitForWorkbench,
    warmQuickOpen
} from './helpers';

/**
 * Deterministic product screenshots for the in-IDE docs. The manifest
 * (`docs/screenshots.json`) owns every capture id and output path; this spec
 * only renders the scenarios.
 *
 * Skipped unless NUKE_DOCS_SCREENSHOTS=1 so the regular GUI smoke suite is
 * unaffected. The browser app must be bundled first (`yarn build:browser`).
 *
 * Captures are grouped by app area: each test boots the workbench once and
 * emits every image for that area. Fixed 1440x900 viewport, light theme,
 * animations disabled, caret hidden, and fonts awaited. Whole-workbench
 * images clip the dynamic status bar (clock, CPU, RAM).
 */

interface ScreenshotEntry {
    id: string;
    file: string;
    title: string;
    description: string;
}

interface ScreenshotManifest {
    version: number;
    screenshots: ScreenshotEntry[];
}

const CAPTURE_ENABLED = process.env.NUKE_DOCS_SCREENSHOTS === '1';
const REQUIRE_ALL_CAPTURES = process.env.NUKE_DOCS_SCREENSHOTS_PARTIAL !== '1';
const MANIFEST_PATH = path.resolve('docs/screenshots.json');
// Do not read the manifest when the suite is disabled: a missing or malformed
// manifest must not break the regular UI smoke suite.
const manifest: ScreenshotManifest = CAPTURE_ENABLED
    ? (JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as ScreenshotManifest)
    : { version: 1, screenshots: [] };
const entries = new Map(manifest.screenshots.map((entry) => [entry.id, entry]));
const captured = new Set<string>();

/** Ignore known upstream noise unrelated to the captured UI. */
function severeErrors(errors: readonly string[]): string[] {
    return errors.filter((error) => !error.includes('l10n') && !error.includes('localization bundles') && !error.includes('INVALID tab'));
}

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

/** Open the workbench in the documented light theme. */
async function openWorkbench(page: Page): Promise<void> {
    await page.addInitScript(() => {
        localStorage.setItem('theme', 'nukeide-light');
        localStorage.setItem('nuke-theme', JSON.stringify({ id: 'nukeide-light', label: 'Light' }));
    });
    await page.goto('/');
    await waitForWorkbench(page);
    await expect(page.locator('#theia-statusBar')).toBeVisible({ timeout: 60_000 });
    await expect
        .poll(
            () =>
                page.evaluate(() =>
                    getComputedStyle(document.documentElement).getPropertyValue('--theia-editor-background').trim().toLowerCase()
                ),
            { message: 'docs screenshots require the NukeIDE light theme' }
        )
        .toBe('#fdfcf9');
}

/** Wait for fonts and two rendered frames so transitions cannot leak into a capture. */
async function waitForStable(page: Page): Promise<void> {
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
}

/** Do not capture transient backend overlays. */
async function waitForNoLoadingOverlay(page: Page): Promise<void> {
    await expect(page.locator('.nuke-loading-overlay:visible')).toHaveCount(0, { timeout: 60_000 });
}

/** Full-workbench clip that stops above the dynamic status bar. */
async function clipAboveStatusBar(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
    const statusBar = page.locator('#theia-statusBar');
    await expect(statusBar).toBeVisible();
    const box = await statusBar.boundingBox();
    const viewport = page.viewportSize();
    if (!box || !viewport) {
        throw new Error('Cannot compute the workbench clip: status bar or viewport has no box.');
    }
    return { x: 0, y: 0, width: viewport.width, height: Math.floor(box.y) };
}

/**
 * Capture one manifest entry. A capture id without a manifest entry fails
 * immediately; successful ids are tracked for the completeness gate after the
 * suite. `target` selects a panel locator; otherwise the full workbench minus
 * the status bar is captured.
 */
interface CaptureOptions {
    mask?: Locator[];
}

async function capture(page: Page, id: string, target?: Locator, options?: CaptureOptions): Promise<void> {
    const entry = entries.get(id);
    if (!entry) {
        throw new Error(`Capture id '${id}' has no entry in docs/screenshots.json.`);
    }
    if (!entry.file.endsWith('.png')) {
        throw new Error(`Manifest entry '${id}' must point at a .png file, got '${entry.file}'.`);
    }

    const output = path.resolve(entry.file);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    await dismissNotifications(page);
    await waitForNoLoadingOverlay(page);
    await waitForStable(page);

    if (target) {
        await expect(target).toBeVisible({ timeout: 60_000 });
        await target.screenshot({
            path: output,
            animations: 'disabled',
            caret: 'hide',
            mask: options?.mask,
            maskColor: '#fdfcf9'
        });
    } else {
        const clip = await clipAboveStatusBar(page);
        await page.screenshot({ path: output, clip, animations: 'disabled', caret: 'hide' });
    }

    const size = fs.statSync(output).size;
    expect(size, `Generated screenshot ${entry.file} is empty`).toBeGreaterThan(0);
    captured.add(id);
    console.log(`docs screenshot ${id} -> ${entry.file} (${size} bytes)`);
}

/** Expand a Nuke Tools category once and verify the rendered state. */
async function expandCategory(sidebar: Locator, label: string): Promise<void> {
    const header = sidebar.locator('.nuke-tools-category-header', { hasText: new RegExp(`^${label}$`) });
    await expect(header, `Nuke Tools category '${label}' is missing`).toHaveCount(1);
    const category = header.locator('xpath=..');
    if ((await category.getAttribute('aria-expanded')) !== 'true') {
        await header.click();
    }
    await expect(category).toHaveAttribute('aria-expanded', 'true');
}

/** Open a committed OpenMC project fixture and one of its widgets. */
async function openFixtureWidget(page: Page, fixture: string, command: string, widget: string): Promise<Locator> {
    await closeAllEditors(page);
    await openFileByQuickOpen(page, fixture);
    await runCommand(page, command);
    const locator = page.locator(widget);
    await expect(locator).toBeVisible({ timeout: 30_000 });
    return locator;
}

/** Compare every open viewer by filename through the multi-select quick pick. */
async function compareOpenViews(page: Page, names: readonly string[]): Promise<void> {
    await page.locator('#theia-app-shell').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Control+Shift+P');
    const input = page.locator('.quick-input-widget input');
    await expect(input).toBeVisible();
    await input.fill('>Compare Open Views');
    const commandRow = page.locator('.quick-input-widget .monaco-list-row', { hasText: 'Compare Open Views' }).first();
    await expect(commandRow).toBeVisible();
    await commandRow.click();
    const picker = page.locator('.quick-input-widget');
    for (const name of names) {
        const row = picker.locator('.monaco-list-row', { hasText: name }).first();
        await expect(row).toBeVisible({ timeout: 60_000 });
        await row.click();
        await expect(row.locator('.monaco-checkbox')).toHaveAttribute('aria-checked', 'true');
    }
    await page.keyboard.press('Enter');
    await expect(page.locator('.nuke-viewer-comparison-badge')).toHaveCount(names.length, { timeout: 60_000 });
}

/** Create a project from a template card so captures show populated UI. */
async function createTemplateProject(page: Page, template: RegExp): Promise<Locator> {
    await runCommand(page, 'New Project');
    const dialog = page.locator('.new-project-dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole('radio', { name: template }).click();
    await dialog.getByRole('button', { name: 'Create Project' }).click();
    await expect(dialog).toBeHidden();
    const dashboard = page.locator('.simulation-dashboard');
    await expect(dashboard).toBeVisible({ timeout: 30_000 });
    return dashboard;
}

test.describe('docs screenshots', () => {
    test.skip(!CAPTURE_ENABLED, 'set NUKE_DOCS_SCREENSHOTS=1 to capture docs screenshots');

    test('workbench and Nuke Tools sidebar', async ({ page }) => {
        const errors = collectErrors(page);
        await openWorkbench(page);

        await runCommand(page, 'Nuke: Focus Tools Sidebar');
        const sidebar = page.locator('#nuke-tools-sidebar');
        await expect(sidebar).toBeVisible();

        await expandCategory(sidebar, 'OpenMC Studio');
        await expandCategory(sidebar, 'Project');
        await expandCategory(sidebar, 'Geometry');
        await expandCategory(sidebar, 'Simulation');
        await expect(sidebar.locator('.nuke-tools-item-label', { hasText: 'New Project' })).toBeVisible();
        await expect(sidebar.locator('.nuke-tools-item-label', { hasText: 'CSG Builder' })).toBeVisible();
        await expect(sidebar.locator('.nuke-tools-item-label', { hasText: 'Simulation Dashboard' })).toBeVisible();

        const dashboard = await createTemplateProject(page, /^Pin Cell/);
        await expectNonEmptyContent(dashboard, 100);

        await capture(page, 'workbench');
        await capture(page, 'tools-sidebar', sidebar);
        expect(severeErrors(errors), `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });

    test('OpenMC dashboard tabs and project templates', async ({ page }) => {
        const errors = collectErrors(page);
        await openWorkbench(page);
        await createBlankProject(page);

        const dashboard = page.locator('.simulation-dashboard');
        await expect(dashboard).toBeVisible({ timeout: 30_000 });
        const tabBar = dashboard.locator('.dashboard-tabs');
        await expect(tabBar).toBeVisible();

        const materials = tabBar.locator('.tab-button', { hasText: 'Materials' });
        await materials.click();
        await expect(materials).toHaveClass(/active/);
        await expect(dashboard.getByText('How to Create Materials')).toBeVisible();
        await capture(page, 'openmc-dashboard', dashboard);

        const settings = tabBar.locator('.tab-button', { hasText: 'Settings' });
        await settings.click();
        await expect(settings).toHaveClass(/active/);
        await expect(dashboard.getByText('Quick Start Guide')).toBeVisible();
        await capture(page, 'openmc-settings', dashboard);

        const simulation = tabBar.locator('.tab-button', { hasText: 'Simulation' });
        await simulation.click();
        await expect(simulation).toHaveClass(/active/);
        await expect(dashboard.getByRole('button', { name: 'Run Simulation' })).toBeVisible();
        await expect(dashboard.getByText(/\d+ \/ \d+ configured/)).toBeVisible();
        await capture(page, 'openmc-simulation', dashboard);

        await runCommand(page, 'New Project');
        const dialog = page.locator('.new-project-dialog');
        await expect(dialog).toBeVisible({ timeout: 30_000 });
        await expect(dialog.getByRole('radio')).toHaveCount(6);
        await expect(dialog.getByRole('radio').first()).toHaveAttribute('aria-checked', 'true');
        await dialog.getByRole('radio', { name: /^Pin Cell/ }).click();
        await expect(dialog.locator('.new-project-preview-summary')).toContainText('fuel pin');
        await expect(dialog.getByLabel('U-235 enrichment')).toBeVisible();
        await capture(page, 'openmc-templates', dialog);

        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();

        const pinDashboard = await createTemplateProject(page, /^Pin Cell/);
        await pinDashboard.getByRole('button', { name: 'Materials' }).click();
        const water = pinDashboard.locator('.material-card').filter({ hasText: 'Light water' });
        await expect(water).toBeVisible({ timeout: 30_000 });
        await water.locator('.material-actions button').nth(1).click();
        const materialForm = pinDashboard.locator('.material-form').first();
        await expect(materialForm).toBeVisible({ timeout: 30_000 });
        await expect(materialForm.locator('.thermal-section')).toBeVisible();
        await page.setViewportSize({ width: 1440, height: 1100 });
        await materialForm.evaluate((element) => element.scrollIntoView({ block: 'start', inline: 'nearest' }));
        await expect(materialForm.locator('.thermal-section')).toBeInViewport();
        await capture(page, 'openmc-material-form', pinDashboard);

        expect(severeErrors(errors), `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });

    test('OpenMC fixture widgets', async ({ page }) => {
        const errors = collectErrors(page);
        await openWorkbench(page);
        await warmQuickOpen(page);

        const csg = await openFixtureWidget(page, 'csg-assembly.nuke-openmc', 'Open CSG Builder', '.csg-builder');
        await expect(csg.locator('.csg-builder-tabs')).toBeVisible();
        await expect(csg.locator('.csg-builder-tabs .tab-button').first()).toBeVisible();
        await capture(page, 'openmc-csg-builder', csg);

        const tally = await openFixtureWidget(page, 'derived-tally.nuke-openmc', 'Open Tally Configurator', '.tally-configurator');
        await expect(tally.locator('.tally-configurator-tabs')).toBeVisible();
        await expect(tally.locator('.quick-add-panel')).toBeVisible();
        await capture(page, 'openmc-tally-config', tally);
        await tally.locator('.tally-card').first().click();
        await expect(tally.locator('.tally-editor')).toBeVisible({ timeout: 30_000 });
        await expect(tally.locator('.tally-editor .editor-header')).toContainText('Edit Tally');
        await capture(page, 'openmc-tally-editor', tally);

        const shutdown = await openFixtureWidget(page, 'shutdown-dose-project.nuke-openmc', 'Shutdown Dose', '.shutdown-dose-widget');
        await expect(shutdown.locator('.shutdown-dose-step')).toHaveCount(5);
        await expect(shutdown.locator('.shutdown-dose-result-card').first()).toBeVisible({ timeout: 30_000 });
        await capture(page, 'openmc-shutdown-dose', shutdown, {
            mask: [shutdown.locator('.shutdown-dose-output-path')]
        });

        const dagmc = await openFixtureWidget(page, 'dagmc-fuel-pin.nuke-openmc', 'Open DAGMC Editor', '.dagmc-editor');
        await expect(dagmc.locator('.volume-card')).toHaveCount(4, { timeout: 60_000 });
        await dagmc.locator('.volume-card').nth(2).click();
        await expect(dagmc.locator('.volume-details-panel')).toBeVisible({ timeout: 30_000 });
        await dagmc.locator('.volume-details-panel .edit-btn').click();
        await expect(dagmc.locator('.material-editor-inline')).toBeVisible();
        await capture(page, 'openmc-dagmc-editor', dagmc);
        expect(severeErrors(errors), `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });

    test('CAD viewport and sketch mode', async ({ page }) => {
        const errors = collectErrors(page);
        await openWorkbench(page);
        await closeAllEditors(page);
        await runCommand(page, 'Open CAD Viewport');

        const viewport = page.locator('.cad-viewport').first();
        await expect(viewport).toBeVisible({ timeout: 30_000 });
        await expect(viewport.locator('.cad-viewport-welcome')).toBeVisible({ timeout: 10_000 });
        await expect(viewport.locator('.cad-viewport-document-empty-primary')).toContainText('New Document');
        await capture(page, 'cad-start', viewport);

        await runCommand(page, 'New CAD Document');
        const picker = page.locator('.cad-template-picker').first();
        await expect(picker).toBeVisible({ timeout: 10_000 });
        await picker.locator('button', { hasText: 'Empty document' }).first().click();

        const datumPicker = viewport.locator('.cad-sketch-datum-picker').first();
        await expect(datumPicker).toBeVisible({ timeout: 30_000 });
        await expect(viewport.locator('.cad-document-toolbar').first()).toBeVisible({ timeout: 60_000 });
        await datumPicker.locator('button', { hasText: 'Start Sketch' }).first().click();

        await expect(viewport.locator('.cad-sketch-constraint-bar')).toBeVisible({ timeout: 30_000 });
        await expect(viewport.locator('.cad-sketch-finish-button')).toBeVisible();
        await expect(viewport.locator('.cad-sketch-status-badge').first()).toBeVisible();

        // Draw one rectangle so the guide shows sketch geometry and solver state,
        // not just an empty grid.
        const viewportBox = await viewport.boundingBox();
        if (!viewportBox) {
            throw new Error('CAD viewport has no bounding box.');
        }
        await page.keyboard.press('r');
        await page.mouse.click(viewportBox.x + 560, viewportBox.y + 390);
        await page.mouse.click(viewportBox.x + 820, viewportBox.y + 560);
        await page.waitForTimeout(250);
        await page.keyboard.press('Escape');
        await capture(page, 'cad-sketch', viewport);
        expect(severeErrors(errors), `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });

    test('native VTK viewer with settings sidebar', async ({ page }) => {
        const errors = collectErrors(page);
        await openWorkbench(page);
        await warmQuickOpen(page);
        await closeAllEditors(page);
        await openFileByQuickOpen(page, 'native-polydata.vtp');

        const viewer = page.locator('.openmc-output-viewer-container').first();
        await expect(viewer).toBeVisible({ timeout: 60_000 });
        await expect(viewer.locator('.openmc-output-viewer-viewarea canvas')).toBeVisible({ timeout: 60_000 });
        await expect(viewer.locator('.openmc-output-viewer-status.error')).toHaveCount(0);

        await runCommand(page, 'Open Viewer Settings');
        const settings = page.locator('.viewer-settings-panel');
        await expect(settings).toBeVisible({ timeout: 30_000 });
        await expect(settings.locator('.viewer-settings-title')).toContainText('native-polydata.vtp');
        await expect(settings.locator('.viewer-settings-category-header').first()).toBeVisible();

        await capture(page, 'native-viewer');
        expect(severeErrors(errors), `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });
});

test('CAD Feature Tree with a built pincell', async ({ page }) => {
    test.skip(!CAPTURE_ENABLED, 'set NUKE_DOCS_SCREENSHOTS=1 to capture docs screenshots');
    const errors = collectErrors(page);
    await openWorkbench(page);
    await warmQuickOpen(page);
    await closeAllEditors(page);
    await openFileByQuickOpen(page, 'cad-pincell.nuke-cad');

    const viewport = page.locator('.cad-viewport').first();
    await expect(viewport).toBeVisible({ timeout: 60_000 });
    await expect(viewport.locator('.nuke-loading-overlay')).toBeHidden({ timeout: 180_000 });
    const errorBanner = viewport.locator('.cad-viewport-error-banner');
    await expect(errorBanner).toBeHidden({ timeout: 30_000 });
    await expect(viewport.locator('canvas').first()).toBeVisible({ timeout: 30_000 });

    if (!(await page.locator('.cad-feature-tree-panel').first().isVisible())) {
        await runCommand(page, 'Open Feature Tree');
    }
    const tree = page.locator('.cad-feature-tree-panel').first();
    await expect(tree).toBeVisible({ timeout: 30_000 });
    const firstFeature = tree.locator('.feature-tree-row.feature').first();
    await expect(firstFeature).toBeVisible({ timeout: 30_000 });
    await firstFeature.locator('button:has(.codicon-edit)').click();

    const dialog = page.locator('.nuke-dialog:visible').first();
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.locator('.nuke-dialog-header')).toBeVisible();
    await capture(page, 'cad-feature-tree');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    expect(severeErrors(errors), `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('Visualizer four-pane comparison workspace', async ({ page }) => {
    test.skip(!CAPTURE_ENABLED, 'set NUKE_DOCS_SCREENSHOTS=1 to capture docs screenshots');
    const errors = collectErrors(page);
    await openWorkbench(page);
    await warmQuickOpen(page);
    await closeAllEditors(page);

    const fixtures = ['native-polydata.vtp', 'filter-pipeline.vtp', 'native-volume_1.vtu', 'capped-cube.vtu'];
    for (const fixture of fixtures) {
        await openFileByQuickOpen(page, fixture);
        await expect(
            page.locator('.openmc-output-viewer-container').filter({ has: page.locator('.nuke-view-badge', { hasText: fixture }) })
        ).toBeVisible({ timeout: 60_000 });
    }
    await compareOpenViews(page, fixtures);
    const panes = page.locator('.openmc-output-viewer-container');
    await expect(panes).toHaveCount(fixtures.length, { timeout: 60_000 });
    for (let index = 0; index < fixtures.length; index += 1) {
        await expect(panes.nth(index)).toBeVisible({ timeout: 60_000 });
    }
    await expect
        .poll(
            async () => {
                const boxes = await Promise.all(Array.from({ length: fixtures.length }, (_, index) => panes.nth(index).boundingBox()));
                if (boxes.some((box) => !box)) {
                    return false;
                }
                const xs = new Set(boxes.map((box) => Math.round(box!.x / 10)));
                const ys = new Set(boxes.map((box) => Math.round(box!.y / 10)));
                return xs.size === 2 && ys.size === 2;
            },
            { timeout: 30_000, message: 'four comparison panes should form a 2x2 grid' }
        )
        .toBe(true);
    await capture(page, 'visualizer-comparison');

    expect(severeErrors(errors), `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test.afterAll(() => {
    if (!CAPTURE_ENABLED || !REQUIRE_ALL_CAPTURES) {
        return;
    }
    const missing = manifest.screenshots.map((entry) => entry.id).filter((id) => !captured.has(id));
    expect(missing, `docs/screenshots.json ids that were never captured: ${missing.join(', ')}`).toEqual([]);
});
