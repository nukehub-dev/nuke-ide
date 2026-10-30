import { test, expect, Page } from '@playwright/test';
import { collectErrors, waitForWorkbench, openFileByQuickOpen, closeAllEditors } from './helpers';

/**
 * Time-series animation export in the Exodus viewer: the header Export
 * button shows the export dialog (confirm row), and starting the capture
 * either records the loaded steps to WebM through the browser-built-in
 * MediaRecorder or — where the headless shell lacks it — fails with the
 * honest `Animation export needs the MediaRecorder API` error instead of
 * silently doing nothing. Success is never faked: the test accepts exactly
 * these two outcomes.
 *
 * Uses the tiny committed `exodus-wave.e` fixture (8 nodes, 3 steps,
 * `temperature` nodal variable). Loading extracts through the Python backend
 * (`base.exodus-series`, needs netCDF4/meshio), so the suite skips gracefully
 * when the backend is unavailable.
 *
 * Suite conventions (root AGENTS.md): Theia/lumino selectors only, zero
 * console severity-error/pageerror gate per test.
 */

test.setTimeout(180_000);

function severe(errors: string[]): string[] {
    return errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles') && !e.includes('INVALID tab'));
}

/** Open the Exodus fixture; skip gracefully when the backend is missing. */
async function openExodusViewer(page: Page) {
    await closeAllEditors(page);
    await page.locator('#theia-app-shell').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Control+P');
    const warm = page.locator('.quick-input-widget input');
    await expect(warm).toBeVisible({ timeout: 10_000 });
    await warm.fill('fixtures');
    await expect(page.locator('.quick-input-widget .monaco-list-row').first()).toBeVisible({ timeout: 120_000 });
    await page.keyboard.press('Escape');
    await openFileByQuickOpen(page, 'exodus-wave.e');
    const container = page.locator('.openmc-output-viewer-container').first();
    await expect(container).toBeVisible({ timeout: 60_000 });
    const depPanel = container.locator('.openmc-output-viewer-dep-panel');
    if (await depPanel.isVisible()) {
        test.skip(true, `exodus backend unavailable: ${(await depPanel.textContent())?.trim().slice(0, 200)}`);
    }
    const canvas = container.locator('.openmc-output-viewer-viewarea canvas');
    await expect(canvas).toBeVisible({ timeout: 60_000 });
    return container;
}

test('export dialog confirms the scope and the capture finishes honestly', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    const container = await openExodusViewer(page);

    // The header Export button opens the confirm dialog: step count plus the
    // WYSIWYG color-by scope (per-step re-ranging stays off by design).
    await container.getByRole('button', { name: 'Export animation as WebM' }).click();
    await expect(container.getByText('Export 3 steps as WebM')).toBeVisible({ timeout: 30_000 });

    await container.getByRole('button', { name: 'Start animation export' }).click();

    // Honest terminal states only: a done notice naming the WebM file, or
    // the MediaRecorder-absence error. Never a silent no-op.
    const doneNotice = container.getByText(/\.webm/i);
    const exportError = container.getByRole('alert');
    await expect(doneNotice.or(exportError)).toBeVisible({ timeout: 120_000 });
    if (await exportError.isVisible()) {
        await expect(exportError).toContainText('MediaRecorder');
    }
    await expect(container.locator('.openmc-output-viewer-viewarea canvas')).toBeVisible();
    const bad = severe(errors);
    expect(bad, `unexpected severe errors:\n${bad.join('\n')}`).toEqual([]);
});
