import * as fs from 'fs';
import * as path from 'path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { collectErrors, openFileByQuickOpen, runCommand, waitForWorkbench } from './helpers';

/**
 * CSG Builder geometry workflows: rectangular/hexagonal lattice editing,
 * universe assignment, cell transforms, periodic pairing, the validation
 * banner, 3D preview, and the narrow-panel layout.
 *
 * The fixture-based tests copy the committed project under the fixtures tree
 * first: Preview 3D regenerates geometry.xml beside the project file, and the
 * committed fixture must never be overwritten.
 */

test.setTimeout(300_000);

const FIXTURE = path.resolve('tests/ui/fixtures/csg-assembly.nuke-openmc');

/** Console/page errors unrelated to app regressions. */
function severeErrors(errors: readonly string[]): string[] {
    return errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles') && !e.includes('INVALID tab'));
}

/** Copy the fixture under the non-ignored fixtures tree so Quick Open sees it. */
function prepareProject(name: string): { file: string; directory: string } {
    const directory = path.resolve('tests/ui/fixtures/csg-smoke', name);
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${name}.nuke-openmc`);
    fs.copyFileSync(FIXTURE, file);
    return { file, directory };
}

test.afterAll(() => {
    fs.rmSync(path.resolve('tests/ui/fixtures/csg-smoke'), { recursive: true, force: true });
});

/** Warm the repo-sized file index before the first Quick Open query. */
async function warmQuickOpen(page: Page): Promise<void> {
    await page.locator('#theia-app-shell').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Control+P');
    const input = page.locator('.quick-input-widget input');
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill('fixtures');
    await expect(page.locator('.quick-input-widget .monaco-list-row').first()).toBeVisible({ timeout: 120_000 });
    await page.keyboard.press('Escape');
}

/** Open a copied project and then the CSG Builder. */
async function openProjectInBuilder(page: Page, file: string): Promise<void> {
    await page.goto('/');
    await waitForWorkbench(page);
    await warmQuickOpen(page);
    await openFileByQuickOpen(page, path.basename(file));
    await runCommand(page, 'Open CSG Builder');
    await expect(page.locator('.csg-builder')).toBeVisible({ timeout: 30_000 });
}

/** Open the CSG Builder on the default (empty) project. */
async function openEmptyBuilder(page: Page): Promise<void> {
    await page.goto('/');
    await waitForWorkbench(page);
    await runCommand(page, 'Open CSG Builder');
    await expect(page.locator('.csg-builder')).toBeVisible({ timeout: 30_000 });
}

/** Click one of the CSG Builder tabs by its accessible name. */
async function selectTab(page: Page, name: string): Promise<void> {
    await page.locator('.csg-builder .csg-builder-tabs').getByRole('button', { name }).click();
}

/** Pick an option from a NukeSelect (the list portals to document.body). */
async function selectNukeOption(page: Page, trigger: Locator, option: string | RegExp): Promise<void> {
    await trigger.click();
    await page.locator('.nuke-select-list').getByRole('option', { name: option }).click();
}

/** Wait for the native geometry viewer canvas. */
async function expectGeometryViewer(page: Page): Promise<void> {
    const viewer = page.locator('.openmc-output-viewer-container').first();
    await expect(viewer).toBeVisible({ timeout: 90_000 });
    await expect(viewer.locator('.openmc-output-viewer-viewarea canvas')).toBeVisible({ timeout: 90_000 });
}

test.describe('CSG Builder geometry', () => {
    test('creates a 2×2 rectangular lattice, assigns universes, and previews it', async ({ page }) => {
        const errors = collectErrors(page);
        const { file, directory } = prepareProject('csg-rect-lattice');
        await openProjectInBuilder(page, file);
        await selectTab(page, 'Lattices');

        await page.locator('.lattices-tab .tab-toolbar-actions').getByRole('button', { name: 'Create rectangular lattice' }).click();
        const editor = page.locator('.lattice-editor').first();
        await expect(editor).toBeVisible();

        await editor.getByLabel('Cells X').fill('2');
        await editor.getByLabel('Cells Y').fill('2');
        await editor.getByRole('button', { name: 'Fill all' }).click();
        await selectNukeOption(page, editor.getByRole('combobox', { name: 'Universe brush value' }), /#2 Guide tube/);
        await editor.getByRole('button', { name: /Row 0, column 1:/ }).click();

        // The painted cell resolves to universe 2 and the others stay 1.
        await expect(editor.getByRole('button', { name: /Row 0, column 1: Universe #2/ })).toBeVisible();
        await expect(editor.getByRole('button', { name: /Row 0, column 0: Universe #1/ })).toBeVisible();

        await editor.getByRole('button', { name: 'Save Lattice' }).click();
        await expect(editor).toHaveCount(0);

        const card = page.locator('.lattice-card').filter({ hasText: 'Lattice 11' });
        await expect(card).toBeVisible();
        await expect(card.locator('.lattice-summary')).toContainText('2×2×1');

        // Preview regenerates geometry.xml beside the copied project.
        await page.locator('.lattices-tab .tab-toolbar-actions').getByRole('button', { name: 'Preview 3D' }).click();
        const geometryXml = path.join(directory, 'geometry.xml');
        await expect
            .poll(() => (fs.existsSync(geometryXml) ? fs.readFileSync(geometryXml, 'utf8') : ''), { timeout: 60_000 })
            .toContain('<lattice id="11"');
        const xml = fs.readFileSync(geometryXml, 'utf8');
        expect(xml).toContain('<dimension>2 2</dimension>');
        expect(xml).toMatch(/<universes>\s+1 2\s+1 1\s+<\/universes>/);
        await expectGeometryViewer(page);

        expect(severeErrors(errors), `unexpected errors:\n${severeErrors(errors).join('\n')}`).toEqual([]);
    });

    test('creates a hexagonal lattice with rings and axial stacks', async ({ page }) => {
        const errors = collectErrors(page);
        const { file } = prepareProject('csg-hex-lattice');
        await openProjectInBuilder(page, file);
        await selectTab(page, 'Lattices');

        await page.locator('.lattices-tab .tab-toolbar-actions').getByRole('button', { name: 'Create hex lattice' }).click();
        const editor = page.locator('.lattice-editor').first();
        await expect(editor).toBeVisible();
        await expect(editor.locator('.lattice-ring-group')).toHaveCount(2);

        await editor.getByLabel('Axial Levels (1 = 2D)').fill('2');
        await selectNukeOption(page, editor.getByRole('combobox', { name: 'Universe brush value' }), /#2 Guide tube/);
        await editor.getByRole('button', { name: 'Fill ring 0 with the selected universe' }).click();
        await expect(editor.getByRole('button', { name: /Ring 0, position 0: Universe #2/ })).toBeVisible();

        await editor.getByRole('button', { name: 'Save Lattice' }).click();
        const card = page.locator('.lattice-card').filter({ hasText: 'Hex Lattice 11' });
        await expect(card).toBeVisible();
        await expect(card.locator('.lattice-summary')).toContainText('2 rings');
        await expect(card.locator('.lattice-summary')).toContainText('2 axial');
        await expect(card.locator('.lattice-ring-chip')).toHaveCount(2);
        await expect(page.locator('.lattices-tab h3 i.codicon-openmc-lattice')).toHaveCSS('mask-image', /data:image\/svg\+xml/);

        expect(severeErrors(errors), `unexpected errors:\n${severeErrors(errors).join('\n')}`).toEqual([]);
    });

    test('sets a cell rotation/translation and writes it to geometry.xml', async ({ page }) => {
        const errors = collectErrors(page);
        const { file, directory } = prepareProject('csg-cell-transform');
        await openProjectInBuilder(page, file);
        await selectTab(page, 'Cells');

        const cellCard = page.locator('#csg-focus-cells-3');
        await cellCard.getByRole('button', { name: 'Edit cell #3' }).click();
        const form = page.locator('.cell-form-container');
        await expect(form).toBeVisible();
        await form.getByLabel('Rotation φ in degrees').fill('0');
        await form.getByLabel('Rotation θ in degrees').fill('0');
        await form.getByLabel('Rotation ψ in degrees').fill('90');
        await form.getByLabel('Translation x in cm').fill('0.1');
        await form.getByLabel('Translation y in cm').fill('0.1');
        await form.getByLabel('Translation z in cm').fill('0');
        await form.getByRole('button', { name: 'Update Cell' }).click();

        await expect(cellCard.locator('.cell-transform-badge').filter({ hasText: 'rot' })).toContainText('90°');
        await expect(cellCard.locator('.cell-transform-badge').filter({ hasText: 'move' })).toContainText('0.1 0.1 0');

        // Reopen to confirm the transform persisted through state.
        await cellCard.getByRole('button', { name: 'Edit cell #3' }).click();
        await expect(page.locator('.cell-form-container').getByLabel('Rotation ψ in degrees')).toHaveValue('90');
        await expect(page.locator('.cell-form-container').getByLabel('Translation x in cm')).toHaveValue('0.1');
        await page.locator('.cell-form-container').getByRole('button', { name: 'Cancel' }).click();

        await page.locator('.csg-builder-header').getByRole('button', { name: 'Preview 3D' }).click();
        const geometryXml = path.join(directory, 'geometry.xml');
        await expect
            .poll(() => (fs.existsSync(geometryXml) ? fs.readFileSync(geometryXml, 'utf8') : ''), { timeout: 60_000 })
            .toContain('rotation="0 0 90"');
        expect(fs.readFileSync(geometryXml, 'utf8')).toContain('translation="0.1 0.1 0"');
        await expectGeometryViewer(page);

        expect(severeErrors(errors), `unexpected errors:\n${severeErrors(errors).join('\n')}`).toEqual([]);
    });

    test('pairs and unpairs periodic surfaces with reciprocal badges', async ({ page }) => {
        const errors = collectErrors(page);
        const { file } = prepareProject('csg-periodic-pair');
        await openProjectInBuilder(page, file);
        await selectTab(page, 'Surfaces');

        const first = page.locator('#csg-focus-surfaces-8');
        const second = page.locator('#csg-focus-surfaces-9');
        await expect(first.locator('.surface-periodic-badge')).toContainText('paired with #9');
        await expect(second.locator('.surface-periodic-badge')).toContainText('paired with #8');
        await expect(first.locator('.surface-periodic-badge i.codicon-openmc-periodic')).toHaveCSS('mask-image', /data:image\/svg\+xml/);

        // Break the pair through the editor: both sides must clear together.
        await first.getByRole('button', { name: 'Edit surface #8' }).click();
        const panel = page.locator('.surface-editor-panel');
        await selectNukeOption(page, panel.getByRole('combobox', { name: 'Periodic partner surface' }), 'No partner selected');
        await panel.getByRole('button', { name: 'Save Changes' }).click();
        await expect(first.locator('.surface-periodic-badge')).toContainText('unpaired');
        await expect(second.locator('.surface-periodic-badge')).toContainText('unpaired');

        const banner = page.locator('.csg-validation-banner');
        await expect(banner).toBeVisible();
        await expect(banner).toContainText('periodic boundary has no partner surface');
        await expect(banner).toContainText('Surfaces');

        // Re-pair with the opposite periodic plane.
        await first.getByRole('button', { name: 'Edit surface #8' }).click();
        await selectNukeOption(
            page,
            page.locator('.surface-editor-panel').getByRole('combobox', { name: 'Periodic partner surface' }),
            /#9: x-plane/
        );
        await page.locator('.surface-editor-panel').getByRole('button', { name: 'Save Changes' }).click();
        await expect(first.locator('.surface-periodic-badge')).toContainText('paired with #9');
        await expect(second.locator('.surface-periodic-badge')).toContainText('paired with #8');
        await expect(page.locator('.csg-validation-banner')).toHaveCount(0);

        expect(severeErrors(errors), `unexpected errors:\n${severeErrors(errors).join('\n')}`).toEqual([]);
    });

    test('validation banner groups issues and jumps to the owning tab', async ({ page }) => {
        const errors = collectErrors(page);
        await openEmptyBuilder(page);
        const banner = page.locator('.csg-validation-banner');
        await expect(banner).toBeVisible();
        await expect(banner).toContainText(/blocks? this model/);

        await selectTab(page, 'Lattices');
        await page.locator('.lattices-tab .tab-toolbar-actions').getByRole('button', { name: 'Create rectangular lattice' }).click();
        await expect(page.locator('.lattice-editor')).toBeVisible();
        // Lattices persist on Save; unsaved drafts are not part of validation.
        await page.locator('.lattice-editor').getByRole('button', { name: 'Save Lattice' }).click();
        await expect(page.locator('.lattice-editor')).toHaveCount(0);
        await selectTab(page, 'Cells');

        // The default lattice references universe 0, which OpenMC cannot use.
        const issue = banner.locator('.csg-validation-issue').filter({ hasText: 'used as a lattice fill' }).first();
        await expect(issue).toBeVisible();
        await expect(banner).toContainText('Lattices');
        await issue.click();

        await expect(page.locator('.csg-builder .tab-button.active')).toContainText('Lattices');
        await expect(page.locator('.lattice-editor')).toBeVisible();

        expect(severeErrors(errors), `unexpected errors:\n${severeErrors(errors).join('\n')}`).toEqual([]);
    });

    test('narrow panels keep the lattice editor usable without page overflow', async ({ page }) => {
        const errors = collectErrors(page);
        const { file } = prepareProject('csg-narrow-panel');
        await page.setViewportSize({ width: 520, height: 900 });
        await openProjectInBuilder(page, file);
        await selectTab(page, 'Lattices');

        const builder = page.locator('.csg-builder');
        const width = await builder.evaluate((element) => element.clientWidth);
        expect(width).toBeLessThanOrEqual(520);
        const overflow = await builder.evaluate((element) => element.scrollWidth - element.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);

        await page.locator('.lattices-tab .tab-toolbar-actions').getByRole('button', { name: 'Create rectangular lattice' }).click();
        const editor = page.locator('.lattice-editor').first();
        await expect(editor).toBeVisible();

        const firstCell = editor.locator('.lattice-grid-cell').first();
        await expect(firstCell).toBeVisible();
        const box = await firstCell.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.width).toBeGreaterThanOrEqual(28);
        expect(box!.height).toBeGreaterThanOrEqual(28);

        // The grid scrolls inside its card; the page itself stays put.
        const gridScroll = await editor.locator('.lattice-grid-scroll').evaluate((element) => getComputedStyle(element).overflowX);
        expect(gridScroll).toBe('auto');
        expect(await builder.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);

        // Forms stack under the container threshold.
        await selectTab(page, 'Cells');
        await page.locator('#csg-focus-cells-3').getByRole('button', { name: 'Edit cell #3' }).click();
        const direction = await page
            .locator('.cell-form-container .form-row')
            .first()
            .evaluate((element) => getComputedStyle(element).flexDirection);
        expect(direction).toBe('column');

        expect(severeErrors(errors), `unexpected errors:\n${severeErrors(errors).join('\n')}`).toEqual([]);
    });
});
