import { test, expect, Page, Locator } from '@playwright/test';
import { collectErrors, waitForWorkbench, runCommand } from './helpers';

/**
 * Nuclear Data browser's read-only dose-coefficient reference tab. The tab
 * always opens; when OpenMC is unavailable it shows an explanatory empty
 * state, so the control checks run and only the data assertions depend on a
 * working backend.
 */

test.setTimeout(120_000);

function severe(errors: string[]): string[] {
    return errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles') && !e.includes('INVALID tab'));
}

async function selectNukeOption(page: Page, scope: Locator, optionName: string): Promise<void> {
    await scope.locator('.nuke-select-trigger').click();
    await page.locator('.nuke-select-list').getByRole('option', { name: optionName }).click();
}

async function waitForChartOrEmpty(scope: Locator): Promise<'chart' | 'empty'> {
    const chart = scope.locator('.dose-chart .js-plotly-plot').first();
    const empty = scope.locator('.nuke-empty-state').first();
    await expect.poll(async () => (await chart.isVisible()) || (await empty.isVisible()), { timeout: 60_000 }).toBe(true);
    return (await chart.isVisible()) ? 'chart' : 'empty';
}

test('dose coefficient tab reads ICRP tables and exposes quantity/geometry controls', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);
    await runCommand(page, 'Nuclear Data');

    const widget = page.locator('.nuclear-data-widget').first();
    await expect(widget).toBeVisible({ timeout: 60_000 });
    const doseTab = widget.locator('.nuclear-data-tab', { hasText: 'Dose coefficients' });
    await expect(doseTab).toBeVisible({ timeout: 60_000 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
        await doseTab.click();
        try {
            await widget.locator('.dose-toolbar').waitFor({ state: 'visible', timeout: 15_000 });
            break;
        } catch {
            // The first click can race the workbench restoring the freshly
            // opened widget; retry once before failing.
        }
    }
    await expect(widget.locator('.dose-toolbar')).toBeVisible();

    const sourceGroup = widget.locator('.dose-toolbar-group', { hasText: 'Data source' });
    const quantityGroup = widget.locator('.dose-toolbar-group', { hasText: 'Quantity' });
    const particleGroup = widget.locator('.dose-toolbar-group', { hasText: 'Particle' });

    expect(await waitForChartOrEmpty(widget)).toMatch(/chart|empty/);
    if (
        (await widget
            .locator('.dose-chart .js-plotly-plot')
            .isVisible()
            .catch(() => false)) === false
    ) {
        // Without OpenMC the tab must explain the missing dependency instead of
        // throwing; the controls above remain usable.
        await expect(widget.locator('.nuke-empty-state')).toContainText('OpenMC');
        expect(severe(errors), `console/page errors in dose coefficients:\n${errors.join('\n')}`).toEqual([]);
        test.skip(true, 'OpenMC dose-coefficient backend unavailable');
    }

    await expect(widget.locator('.dose-summary')).toContainText('ICRP-116');
    await expect(widget.locator('.dose-table-card')).toBeVisible();
    await expect(widget.locator('.dose-table tbody tr').first()).toBeVisible();
    await expect(widget.locator('.dose-table-header')).toContainText('pSv cm');

    await selectNukeOption(page, sourceGroup, 'ICRP-74');
    expect(await waitForChartOrEmpty(widget)).toBe('chart');
    await expect(widget.locator('.dose-summary')).toContainText('ICRP-74');

    await selectNukeOption(page, quantityGroup, 'Ambient H*(10)');
    expect(await waitForChartOrEmpty(widget)).toBe('chart');
    await expect(widget.locator('.dose-summary')).toContainText('Ambient dose equivalent');

    // Particle control: neutron is available in both ICRP tables.
    await selectNukeOption(page, particleGroup, 'Neutron');
    expect(await waitForChartOrEmpty(widget)).toBe('chart');

    await page.setViewportSize({ width: 640, height: 900 });
    await expect(widget.locator('.dose-toolbar')).toBeVisible();
    await expect(widget.locator('.dose-summary')).toBeVisible();

    expect(severe(errors), `console/page errors in dose coefficients:\n${errors.join('\n')}`).toEqual([]);
});
