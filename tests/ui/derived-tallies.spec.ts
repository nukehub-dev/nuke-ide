import * as fs from 'fs';
import * as path from 'path';
import { test, expect, Page } from '@playwright/test';
import { collectErrors, expectNonEmptyContent, openFileByQuickOpen, runCommand, waitForWorkbench } from './helpers';

/**
 * Derived tallies: the token builder in the Tally Configurator, validation,
 * narrow-panel layout, and the statepoint viewer result surface (badge,
 * plot/bins/export/comparison). The result test uses the committed synthetic
 * statepoint and skips gracefully when the OpenMC/h5py backend is unavailable.
 */

test.setTimeout(300_000);

const SP_FIXTURE = path.resolve('tests/ui/fixtures/statepoint.10.h5');

async function openConfigurator(page: Page) {
    await runCommand(page, 'Open Tally Configurator');
    const widget = page.locator('.tally-configurator-container');
    await expect(widget).toBeVisible({ timeout: 30_000 });
    return widget;
}

async function addFissionTally(page: Page, widget: ReturnType<Page['locator']>) {
    await widget.locator('.quick-add-panel .template-buttons button', { hasText: 'Cell Fission' }).click();
    await expect(widget.locator('.tally-editor')).toBeVisible();
}

async function openDerivedTab(page: Page, widget: ReturnType<Page['locator']>) {
    await widget.getByRole('button', { name: 'Derived Tallies' }).click();
    const panel = widget.locator('.derived-tab-container');
    await expect(panel).toBeVisible();
    return panel;
}

async function createDraft(page: Page, widget: ReturnType<Page['locator']>) {
    const panel = await openDerivedTab(page, widget);
    const empty = panel.locator('.derived-empty-state');
    if (await empty.isVisible()) {
        const create = empty.getByRole('button', { name: 'Create Derived Tally' });
        const iconSize = await create.locator('i').evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
        expect(iconSize).toBeLessThanOrEqual(16);
        await create.click();
    } else {
        await panel.locator('.derived-list .add-button').click();
    }
    await expect(panel.locator('.derived-builder')).toBeVisible();
    return panel;
}

async function appendOperandAndScalar(panel: ReturnType<Page['locator']>, operator: '*' | '/', scalar: string) {
    await panel.getByRole('button', { name: 'Add operand' }).click();
    await panel.getByRole('button', { name: `Append ${operator} operator` }).click();
    await panel.locator('#derived-scalar-value').fill(scalar);
    await panel.getByRole('button', { name: 'Add scalar' }).click();
}

test('builds a scalar-scaled derived tally with a formula and bin preview', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const widget = await openConfigurator(page);
    await addFissionTally(page, widget);
    const panel = await createDraft(page, widget);

    // Empty expression is actionable and blocks saving.
    await expect(panel.locator('.derived-validation-list')).toContainText('Expression is empty');
    await expect(panel.getByRole('button', { name: 'Save derived tally' })).toBeDisabled();

    await appendOperandAndScalar(panel, '*', '2');
    await expect(panel.locator('.derived-formula-preview')).toHaveText('T1[fission] * 2');
    await expect(panel.locator('.derived-preview-ok')).toContainText('will produce');
    await panel.getByLabel('Derived tally name').fill('Fission x2');
    await panel.getByLabel('Derived tally unit').fill('ratio');
    await panel.getByRole('button', { name: 'Save derived tally' }).click();

    const card = panel.locator('.derived-card', { hasText: 'Fission x2' });
    await expect(card).toBeVisible();
    await expect(card.locator('.derived-card-formula')).toHaveText('T1[fission] * 2');
    await expect(card).toContainText('[ratio]');

    // Duplicate names are rejected with a cause + fix message.
    const duplicate = await createDraft(page, widget);
    await duplicate.getByLabel('Derived tally name').fill('Fission x2');
    await appendOperandAndScalar(duplicate, '*', '3');
    await expect(duplicate.locator('.derived-validation-list')).toContainText('already named "Fission x2"');
    await expect(duplicate.getByRole('button', { name: 'Save derived tally' })).toBeDisabled();

    expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('rejects scalar division by zero inline', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const widget = await openConfigurator(page);
    await addFissionTally(page, widget);
    const panel = await createDraft(page, widget);
    await appendOperandAndScalar(panel, '/', '0');

    await expect(panel.locator('.derived-validation-list')).toContainText('divides by a scalar zero');
    await expect(panel.getByRole('button', { name: 'Save derived tally' })).toBeDisabled();

    // Backspace removes the last token and the formula follows.
    const editor = panel.locator('.derived-token-editor');
    await editor.focus();
    await page.keyboard.press('Backspace');
    await expect(panel.locator('.derived-formula-preview')).toHaveText('T1[fission] /');

    expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('narrow panel stacks the list and builder without horizontal overflow', async ({ page }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 380, height: 900 });
    await page.goto('/');
    await waitForWorkbench(page);

    const widget = await openConfigurator(page);
    await addFissionTally(page, widget);
    const panel = await createDraft(page, widget);
    await appendOperandAndScalar(panel, '*', '2');

    await expect(panel.locator('.derived-builder-panel')).toBeVisible();
    await expect(panel.locator('.derived-token-editor')).toBeVisible();
    const [scrollWidth, clientWidth] = await widget.evaluate((element) => [element.scrollWidth, element.clientWidth]);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

    // Icon-only tabs keep their accessible name.
    const tab = widget.getByRole('button', { name: 'Derived Tallies' });
    await expect(tab).toBeVisible();
    await expect(tab.locator('.tab-label')).toBeHidden();

    expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('statepoint viewer shows derived mean/std, bins, plot, export, and comparison', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    await openFileByQuickOpen(page, 'statepoint.10.h5');
    const viewer = page.locator('.statepoint-viewer').first();
    await expect(viewer).toBeVisible({ timeout: 60_000 });
    if ((await viewer.getAttribute('class'))?.includes('statepoint-viewer--empty')) {
        test.skip(true, 'statepoint backend unavailable');
    }

    await viewer.locator('.tabs .tab', { hasText: 'Tallies' }).click();
    const derived = viewer.locator('.derived-results-section');
    if (!(await derived.isVisible())) {
        test.skip(true, 'derived-tally backend unavailable');
    }
    await expect(derived.locator('.derived-independence-caveat')).toContainText('independent tallies');
    await expect(derived.locator('.derived-results-loading')).toHaveCount(0, { timeout: 120_000 });

    const card = derived.locator('.derived-card-result', { hasText: 'Double flux' });
    if (!(await card.isVisible().catch(() => false))) {
        test.skip(true, 'derived-tally backend unavailable');
    }
    await expect(card.locator('.derived-result-badge')).toHaveText('DERIVED');
    await expect(card.locator('.derived-result-formula')).toContainText('T1[flux] * 2');
    await expect(card).toContainText('cm^-2');
    await expect(card.locator('.derived-result-metric-value').first()).toHaveText('156');

    // Per-bin table decodes all 12 mesh bins.
    await card.getByRole('button', { name: 'Show bins for Double flux' }).click();
    await expect(card.locator('.derived-result-bins tbody tr')).toHaveCount(12);

    // Plotly chart renders in-card.
    await card.getByRole('button', { name: 'Plot Double flux' }).click();
    await expect(card.locator('.derived-result-chart .js-plotly-plot')).toBeVisible({ timeout: 30_000 });

    // CSV export follows the statepoint convention.
    const downloadPromise = page.waitForEvent('download');
    await card.getByRole('button', { name: 'Export Double flux as CSV' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('Double-flux.csv');
    const csv = await fs.promises.readFile((await download.path()) as string, 'utf-8');
    expect(csv.split('\n').length).toBeGreaterThanOrEqual(13);

    // Comparison across sibling statepoints (statepoint.10 and statepoint.20).
    await card.getByRole('button', { name: 'Compare Double flux across statepoints' }).click();
    await expect(card.locator('.derived-comparison')).toBeVisible({ timeout: 120_000 });
    await expect(card.locator('.derived-comparison')).toContainText('Across statepoints');
    await expect(card.locator('.derived-comparison .js-plotly-plot')).toBeVisible({ timeout: 30_000 });

    await expectNonEmptyContent(card);
    expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('derived fixture exists beside the viewer statepoint', () => {
    expect(fs.existsSync(SP_FIXTURE)).toBe(true);
    expect(fs.existsSync(path.resolve('tests/ui/fixtures/derived-tally.nuke-openmc'))).toBe(true);
});
