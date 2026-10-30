import { test, expect, Page, Locator } from '@playwright/test';
import { collectErrors, runCommand, waitForWorkbench } from './helpers';

/**
 * Source editor smoke: source-type switching, the shared distribution editors
 * (tabular energy, mu-phi direction, time distribution), and the narrow-panel
 * controls. Selectors use product classes and ARIA labels, not testing hooks.
 */

/** Locate a collapsible source section by its title. */
function sourceSection(page: Page, title: string): Locator {
    return page
        .locator('.source-card .source-section')
        .filter({ has: page.locator('.source-section-title', { hasText: title }) })
        .first();
}

/** Choose an option from a NukeSelect trigger (portal listbox). */
async function chooseOption(page: Page, trigger: Locator, option: string): Promise<void> {
    await trigger.click();
    const list = page.locator('.nuke-select-list').last();
    await expect(list).toBeVisible();
    // Option rows include a codicon glyph in their accessible name; match the
    // visible label instead.
    await list.getByRole('option').filter({ hasText: option }).first().click();
}

test.describe('openmc source editor', () => {
    test('switches types, edits distributions, and stays inside a narrow panel', async ({ page }) => {
        const errors = collectErrors(page);
        await page.setViewportSize({ width: 1280, height: 1000 });
        await page.goto('/');
        await waitForWorkbench(page);
        await runCommand(page, 'Open Simulation Dashboard');

        const dashboard = page.locator('.simulation-dashboard');
        await expect(dashboard).toBeVisible({ timeout: 30_000 });
        await dashboard.getByRole('button', { name: 'Settings', exact: true }).click();
        const sourceCard = dashboard.locator('.source-card').first();
        await expect(sourceCard).toBeVisible({ timeout: 30_000 });
        await expect(sourceCard.locator('.source-summary-card')).toContainText('Box');

        // Source type: segmented control on a wide panel, file round trip.
        const typeSection = sourceSection(page, 'Source Type');
        await typeSection.getByRole('button', { name: 'File', exact: true }).click();
        await expect(sourceCard.locator('input[placeholder="surface_source.h5"]')).toBeVisible();
        await typeSection.getByRole('button', { name: 'Independent', exact: true }).click();
        await expect(sourceSection(page, 'Spatial Distribution')).toBeVisible();

        // Tabular spectrum through the shared table editor.
        const energySection = sourceSection(page, 'Energy Distribution');
        await chooseOption(page, energySection.locator('.nuke-select-trigger').first(), 'Tabular');
        const energyTable = energySection.locator('.source-table');
        await expect(energyTable).toBeVisible();
        await energyTable.getByLabel('Energy (eV) row 1').fill('1000');
        await energyTable.getByLabel('Probability density row 1').fill('0.2');
        await energyTable.getByLabel('Energy (eV) row 2').fill('14000000');
        await energyTable.getByLabel('Probability density row 2').fill('0.8');
        await expect(sourceCard.locator('.source-summary-card')).toContainText('Tabular');

        // Mu-phi direction with reference vectors.
        const directionSection = sourceSection(page, 'Direction');
        await directionSection.locator('.source-section-header').click();
        await chooseOption(page, directionSection.locator('.nuke-select-trigger').first(), 'Polar-azimuthal (mu-phi)');
        await expect(directionSection.getByLabel('Polar reference (uvw) X')).toBeVisible();
        await expect(directionSection.getByLabel('Azimuthal reference (vwu) X')).toBeVisible();
        await expect(sourceCard.locator('.source-summary-card')).toContainText('Mu-phi');

        // Time distribution (seconds).
        const timeSection = sourceSection(page, 'Time');
        await timeSection.locator('.source-section-header').click();
        await chooseOption(page, timeSection.locator('.nuke-select-trigger').first(), 'Uniform range');
        await expect(timeSection.locator('input[type="number"]').first()).toBeVisible();
        await expect(sourceCard.locator('.source-summary-card')).toContainText('t 0 s');

        // Narrow panel: segmented control collapses to a select, tables scroll
        // inside their card, and the editor never scrolls the page horizontally.
        await page.setViewportSize({ width: 420, height: 900 });
        await expect(sourceCard.locator('.source-type-segments')).toBeHidden();
        await expect(sourceCard.locator('.source-type-select-control')).toBeVisible();
        const overflow = await sourceCard.locator('.source-editor').evaluate((element) => element.scrollWidth - element.clientWidth);
        if (overflow > 1) {
            const offenders = await sourceCard.locator('.source-editor').evaluate((element) =>
                Array.from(element.querySelectorAll<HTMLElement>('*'))
                    .filter((child) => child.scrollWidth > child.clientWidth + 1)
                    .map((child) => `${child.tagName}.${child.className}: ${child.scrollWidth} > ${child.clientWidth}`)
            );
            console.log('source editor overflow offenders', offenders);
        }
        expect(overflow).toBeLessThanOrEqual(1);

        expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });

    test('expands secondary source cards from the header', async ({ page }) => {
        const errors = collectErrors(page);
        await page.goto('/');
        await waitForWorkbench(page);
        await runCommand(page, 'Open Simulation Dashboard');

        const dashboard = page.locator('.simulation-dashboard');
        await expect(dashboard).toBeVisible({ timeout: 30_000 });
        await dashboard.getByRole('button', { name: 'Settings', exact: true }).click();

        const sourcesSection = dashboard.locator('.settings-section[data-section-title="Sources"]');
        const addSource = sourcesSection.locator('h3 .theia-button');
        const cards = dashboard.locator('.source-card');
        await addSource.click();
        await expect(cards).toHaveCount(2);
        await addSource.click();
        await expect(cards).toHaveCount(3);
        const second = cards.nth(1);
        const third = cards.nth(2);

        await expect(second.locator('.source-card-toggle')).toHaveAttribute('aria-expanded', 'false');
        await second.locator('.source-card-toggle').click();
        await expect(second.locator('.source-card-toggle')).toHaveAttribute('aria-expanded', 'true');
        await expect(second.locator('.source-card-body')).toBeVisible();

        await third.locator('.source-card-toggle').click();
        await expect(third.locator('.source-card-toggle')).toHaveAttribute('aria-expanded', 'true');
        await expect(third.locator('.source-card-body')).toBeVisible();

        expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
    });
});
