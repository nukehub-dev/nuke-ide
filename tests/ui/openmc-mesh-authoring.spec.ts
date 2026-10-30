import { test, expect, Page } from '@playwright/test';
import { collectErrors, runCommand } from './helpers';

/**
 * Tally Configurator mesh authoring: rectilinear grids (token editor +
 * bounds/divisions helper), unstructured file controls, mesh-filter transforms,
 * and the narrow-panel layout. Backend-dependent file checks are asserted only
 * through their visible status; the specs never require a Python environment.
 */

test.setTimeout(300_000);

/** Wait for the workbench shell, tolerating a slow first paint of the bundle. */
async function waitForShell(page: Page): Promise<void> {
    const shell = page.locator('#theia-app-shell');
    await expect(shell).toBeVisible({ timeout: 180_000 });
    const preload = page.locator('.theia-preload');
    if ((await preload.count()) > 0) {
        await expect(preload).toBeHidden({ timeout: 180_000 });
    }
}

/** Open the Tally Configurator and return its root locator. */
async function openConfigurator(page: Page) {
    await runCommand(page, 'Open Tally Configurator');
    const widget = page.locator('.tally-configurator-container');
    await expect(widget).toBeVisible({ timeout: 30_000 });
    return widget;
}

/** Switch to the Meshes tab and add a mesh. */
async function addMesh(page: Page, widget: ReturnType<Page['locator']>) {
    await widget.locator('.tally-configurator-tabs .tab-button', { hasText: 'Meshes' }).click();
    await widget.locator('.mesh-list-panel .add-button').click();
    await expect(widget.locator('.mesh-editor')).toBeVisible();
}

test('creates a rectilinear mesh with the token editor and bounds helper', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForShell(page);

    const widget = await openConfigurator(page);
    await addMesh(page, widget);

    const cards = widget.locator('.mesh-type-cards');
    await expect(cards).toBeVisible();
    await expect(cards.locator('.mesh-type-card')).toHaveCount(5);
    await cards.locator('.mesh-type-card[data-mesh-type="rectilinear"]').click();

    const editor = widget.locator('.mesh-editor');
    await expect(editor.locator('.mesh-summary')).toContainText('Rectilinear');
    await expect(editor.locator('.mesh-grid-editor')).toHaveCount(3);

    // Default grids are 2×2×2; typing explicit boundaries updates cells.
    await editor.getByLabel('X boundaries').fill('0 0.5 1');
    await editor.getByLabel('Y boundaries').fill('0 0.5 1');
    await editor.getByLabel('Z boundaries').fill('-1 1');
    await expect(editor.locator('.mesh-grid-stats')).toContainText('2 × 2 × 1');
    await expect(editor.locator('.mesh-grid-stats')).toContainText('Total elements: 4');

    // Bounds + divisions helper replaces all three grids.
    await editor.getByLabel('X lower bound').fill('0');
    await editor.getByLabel('X upper bound').fill('2');
    await editor.getByLabel('X divisions').fill('4');
    await editor.getByLabel('Y lower bound').fill('-1');
    await editor.getByLabel('Y upper bound').fill('1');
    await editor.getByLabel('Y divisions').fill('2');
    await editor.getByLabel('Z lower bound').fill('0');
    await editor.getByLabel('Z upper bound').fill('1');
    await editor.getByLabel('Z divisions').fill('1');
    await editor.locator('.mesh-grid-helper-apply').click();

    await expect(editor.getByLabel('X boundaries')).toHaveValue('0 0.5 1 1.5 2');
    await expect(editor.getByLabel('Y boundaries')).toHaveValue('-1 0 1');
    await expect(editor.getByLabel('Z boundaries')).toHaveValue('0 1');
    await expect(editor.locator('.mesh-grid-stats')).toContainText('Total elements: 8');

    // An invalid grid is reported inline instead of being silently dropped.
    await editor.getByLabel('Z boundaries').fill('0 0 1');
    await expect(editor.locator('.mesh-grid-editor[data-axis="z"] .validation-error')).toContainText('strictly increase');

    expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('switches to an unstructured mesh and reports a missing file', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForShell(page);

    const widget = await openConfigurator(page);
    await addMesh(page, widget);

    await widget.locator('.mesh-type-card[data-mesh-type="unstructured"]').click();
    const editor = widget.locator('.mesh-editor');
    await expect(editor.locator('.mesh-file-input')).toBeVisible();
    await expect(editor.locator('.mesh-file-browse')).toBeVisible();
    await expect(editor.locator('.mesh-dependency-hint')).toContainText('MOAB');

    // An extension outside the selected library is a field-level error.
    await editor.locator('.mesh-file-input').fill('/tmp/core.vtk');
    const trigger = editor.locator('.nuke-select-trigger').last();
    await trigger.click();
    await page
        .locator('.nuke-select-list')
        .getByRole('option', { name: /libMesh/ })
        .click();
    await expect(editor.locator('.validation-error')).toContainText('.vtk is not supported by the libmesh library');

    // Switching back to MOAB clears the error and checks the (missing) file.
    await trigger.click();
    await page.locator('.nuke-select-list').getByRole('option', { name: /MOAB/ }).click();
    await expect(editor.locator('.validation-error')).toHaveCount(0);
    await expect(editor.locator('.mesh-file-warning')).toContainText('File not found', { timeout: 90_000 });
    await expect(editor.locator('.mesh-file-warning')).not.toHaveAttribute('title');

    expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('mesh filter transform controls round-trip through the filter editor', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForShell(page);

    const widget = await openConfigurator(page);
    await addMesh(page, widget);

    // Add a tally and a mesh filter.
    await widget.locator('.tally-configurator-tabs .tab-button', { hasText: 'Tallies' }).click();
    await widget.locator('.tally-list-panel .add-button').click();
    const tallyEditor = widget.locator('.tally-editor');
    await expect(tallyEditor).toBeVisible();
    await tallyEditor.getByRole('button', { name: '+ Mesh Filter', exact: true }).click();

    const transform = tallyEditor.locator('.mesh-transform');
    await expect(transform).toBeVisible();
    await transform.locator('summary').click();

    await transform.getByLabel('Translate mesh (cm)').check();
    await transform.getByLabel('Translation X').fill('1');
    await transform.getByLabel('Translation Y').fill('2');
    await transform.getByLabel('Translation Z').fill('3');

    await transform.getByLabel('Rotate mesh (degrees)').check();
    await transform.getByLabel('Rotation phi').fill('10');
    await transform.getByLabel('Rotation theta').fill('20');
    await transform.getByLabel('Rotation psi').fill('30');

    const badge = tallyEditor.locator('.filter-header .mesh-transform-badge', { hasText: 'rotated' });
    await expect(badge).toBeVisible();
    expect(await badge.getAttribute('title')).toBeNull();

    // Environments without MeshFilter.rotation (release default) warn inline.
    const warning = transform.locator('.validation-warning');
    if ((await warning.count()) > 0) {
        await expect(warning).toContainText('requires OpenMC 0.16');
    }

    expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('narrow panel collapses the type cards and stacks transform fields', async ({ page }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 380, height: 900 });
    await page.goto('/');
    await waitForShell(page);

    const widget = await openConfigurator(page);
    await addMesh(page, widget);

    await expect(widget.locator('.mesh-type-cards')).toBeHidden();
    const select = widget.locator('.mesh-type-select');
    await expect(select).toBeVisible();
    await select.locator('.nuke-select-trigger').click();
    await page.locator('.nuke-select-list').getByRole('option', { name: 'Rectilinear' }).click();
    await expect(widget.locator('.mesh-grid-editor')).toHaveCount(3);

    // Transform fields stack under the container breakpoint.
    await widget.locator('.tally-configurator-tabs .tab-button').first().click();
    await widget.locator('.tally-list-panel .add-button').click();
    const tallyEditor = widget.locator('.tally-editor');
    await tallyEditor.getByRole('button', { name: '+ Mesh Filter', exact: true }).click();
    const transform = tallyEditor.locator('.mesh-transform');
    await transform.locator('summary').click();
    await transform.getByLabel('Rotate mesh (degrees)').check();
    const columns = await transform
        .locator('.mesh-transform-fields')
        .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
    expect(columns).toBe(1);

    // The widget never overflows horizontally; wide content scrolls inside cards.
    const [scrollWidth, clientWidth] = await widget.evaluate((element) => [element.scrollWidth, element.clientWidth]);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

    expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
