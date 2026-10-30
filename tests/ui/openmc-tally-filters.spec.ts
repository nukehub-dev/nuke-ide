import { test, expect, Page } from '@playwright/test';
import { collectErrors, runCommand } from './helpers';

/**
 * Tally Configurator filter builder: structured cell-instance pairs, the
 * searchable reaction picker, and the narrow-panel layout. Backend-dependent
 * compatibility badges are asserted only through visible state; the specs do
 * not require a Python environment.
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

/** Add a tally and return the tally editor. */
async function addTally(page: Page, widget: ReturnType<Page['locator']>) {
    await widget.locator('.tally-list-panel .add-button').click();
    const editor = widget.locator('.tally-editor');
    await expect(editor).toBeVisible();
    return editor;
}

/** Add a default regular mesh so mesh-material filters are enabled. */
async function addMesh(page: Page, widget: ReturnType<Page['locator']>) {
    await widget.locator('.tally-configurator-tabs .tab-button', { hasText: 'Meshes' }).click();
    await widget.locator('.mesh-list-panel .add-button').click();
    await expect(widget.locator('.mesh-editor')).toBeVisible();
    await widget.locator('.tally-configurator-tabs .tab-button', { hasText: 'Tallies' }).click();
}

test('creates a cell-instance filter with a pair and keeps it editable', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForShell(page);

    const widget = await openConfigurator(page);
    const editor = await addTally(page, widget);
    await editor.getByRole('button', { name: '+ Cell Instance' }).click();

    const card = editor.locator('.filter-item[data-filter-type="cellinstance"]');
    await expect(card).toBeVisible();
    await expect(card.locator('.filter-label')).toHaveText('Cell Instance');
    await expect(card.locator('.filter-summary')).toContainText('cell instance');
    await card.getByRole('button', { name: '+ Add cell instance' }).click();

    await card.getByLabel('Cell instance 1 cell').fill('1');
    await card.getByLabel('Cell instance 1 instance').fill('0');
    await expect(card.locator('.filter-pair-count')).toContainText('1 pair');
    await expect(card.getByLabel('Cell instance 1 cell')).toHaveValue('1');
    await expect(card.getByLabel('Cell instance 1 instance')).toHaveValue('0');

    // The type badge uses the shared tooltip, never a native title.
    const badge = card.locator('.filter-type-badge');
    expect(await badge.getAttribute('title')).toBeNull();
    await badge.hover();
    await expect(page.locator('.nuke-tooltip')).toBeVisible();

    // Filter reorder/delete controls stay reachable.
    await expect(card.getByRole('button', { name: 'Move filter up' })).toBeDisabled();
    await expect(card.getByRole('button', { name: 'Remove Cell Instance filter' })).toBeVisible();

    expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('creates a reaction filter from the pinned and searchable MT/name picker', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForShell(page);

    const widget = await openConfigurator(page);
    const editor = await addTally(page, widget);
    const addReaction = editor.getByRole('button', { name: /\+ Reaction/ });
    await expect(addReaction.locator('.filter-add-compat')).toHaveText('0.16');
    await addReaction.click();

    const card = editor.locator('.filter-item[data-filter-type="reaction"]');
    await expect(card).toBeVisible();
    await expect(card.locator('.filter-label')).toHaveText('Reaction');

    await card.getByRole('button', { name: 'Add reaction (n,gamma)' }).click();
    await expect(card.locator('.filter-chip')).toContainText('(n,gamma) · MT 102');

    // Search by MT and add a second canonical reaction; names stay in insert order.
    await card.getByLabel('Search reactions').fill('16');
    await card.locator('.filter-reaction-results').getByRole('button', { name: 'Add reaction (n,2n)' }).click();
    const chips = card.locator('.filter-chip');
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toContainText('(n,gamma)');
    await expect(chips.nth(1)).toContainText('(n,2n)');

    // An unknown name is reported inline instead of silently dropped.
    await card.getByLabel('Search reactions').fill('(n,unicorn)');
    await card.getByRole('button', { name: '+ Add', exact: true }).click();
    await expect(card.locator('.validation-error')).toContainText('not a known OpenMC reaction');

    expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});

test('narrow panel stacks filter cards and scrolls pair tables inside the card', async ({ page }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 380, height: 900 });
    await page.goto('/');
    await waitForShell(page);

    const widget = await openConfigurator(page);
    await addMesh(page, widget);
    const editor = await addTally(page, widget);

    await editor.getByRole('button', { name: '+ Cell Instance' }).click();
    const cellCard = editor.locator('.filter-item[data-filter-type="cellinstance"]');
    await cellCard.getByRole('button', { name: '+ Add cell instance' }).click();
    await expect(cellCard.getByLabel('Cell instance 1 cell')).toBeVisible();

    await editor.getByRole('button', { name: '+ Mesh Material' }).click();
    const meshCard = editor.locator('.filter-item[data-filter-type="meshmaterial"]');
    await expect(meshCard).toBeVisible();
    await meshCard.getByRole('button', { name: '+ Add element/material' }).click();
    await expect(meshCard.getByLabel('Mesh material 1 element')).toBeVisible();

    // The pair tables scroll horizontally inside their own cards; the widget
    // itself never overflows.
    const overflow = await meshCard.locator('.filter-pair-scroll').evaluate((element) => getComputedStyle(element).overflowX);
    expect(['auto', 'scroll']).toContain(overflow);
    const [scrollWidth, clientWidth] = await widget.evaluate((element) => [element.scrollWidth, element.clientWidth]);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

    // Header actions wrap instead of clipping the delete button.
    for (const card of [cellCard, meshCard]) {
        const actions = card.locator('.filter-actions');
        await expect(actions).toBeVisible();
        const [cardBox, actionBox] = await Promise.all([card.boundingBox(), actions.boundingBox()]);
        expect(cardBox).not.toBeNull();
        expect(actionBox).not.toBeNull();
        expect(actionBox!.x + actionBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 1);
    }

    expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
