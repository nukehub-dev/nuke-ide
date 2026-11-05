import * as path from 'path';
import { test, expect, type Page } from '@playwright/test';
import { closeAllEditors, collectErrors, createBlankProject, openFileByQuickOpen, runCommand, waitForWorkbench } from './helpers';

/**
 * Embedded NukeAI action menus. The command-backed rows come from the neutral
 * context-action registry; these tests cover the visible entry points, menu
 * order, keyboard dismissal, and the existing preflight warning path.
 */

test.setTimeout(180_000);

const STATEPOINT_FIXTURE = path.resolve('tests/ui/fixtures/statepoint.10.h5');

function severe(errors: readonly string[]): string[] {
    return errors.filter((e) => !e.includes('l10n') && !e.includes('localization bundles') && !e.includes('INVALID tab'));
}

/** Warm Quick Open and open a file from the committed fixtures. */
async function openFixture(page: Page, name: string): Promise<void> {
    await closeAllEditors(page);
    await page.locator('#theia-app-shell').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Control+P');
    const input = page.locator('.quick-input-widget input');
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill('fixtures');
    await expect(page.locator('.quick-input-widget .monaco-list-row').first()).toBeVisible({ timeout: 120_000 });
    await page.keyboard.press('Escape');
    await openFileByQuickOpen(page, name);
}

test('statepoint viewer exposes the statepoint action menu and closes it with Escape', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);
    await openFixture(page, 'statepoint.10.h5');

    const viewer = page.locator('.statepoint-viewer').first();
    await expect(viewer).toBeVisible({ timeout: 60_000 });
    if ((await viewer.getAttribute('class'))?.includes('statepoint-viewer--empty')) {
        test.skip(true, 'statepoint backend unavailable');
    }
    await expect(viewer).toContainText(path.basename(STATEPOINT_FIXTURE));

    const trigger = viewer.getByRole('button', { name: 'NukeAI actions' });
    await expect(trigger).toBeVisible();
    await expect(trigger.locator('.codicon-hubot')).toHaveCount(1);
    await trigger.click();
    const menu = viewer.locator('.nuke-action-menu-popup');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.nuke-action-menu-item-label')).toHaveText([
        'Ask About Context',
        'Explain Statepoint',
        'Diagnose Statepoint'
    ]);

    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // The trigger is icon-only; the accessible name and tooltip carry the label.
    await expect(trigger).toHaveClass(/nuke-action-menu-trigger-icon-only/);
    await expect(trigger.locator('.nuke-action-menu-label')).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-label', 'NukeAI actions');

    expect(severe(errors), `unexpected severe errors:\n${severe(errors).join('\n')}`).toEqual([]);
});

test('DAGMC editor action menu keeps actions enabled and the command preflight warns without a viewer', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    await runCommand(page, 'Open DAGMC Editor');
    const editor = page.locator('.dagmc-editor').first();
    await expect(editor).toBeVisible({ timeout: 30_000 });

    const trigger = editor.getByRole('button', { name: 'NukeAI actions' });
    await expect(trigger).toBeVisible();
    await expect(trigger.locator('.codicon-hubot')).toHaveCount(1);
    await expect(trigger).toHaveClass(/nuke-action-menu-trigger-icon-only/);
    await expect(trigger.locator('.nuke-action-menu-label')).toHaveCount(0);
    await trigger.click();
    const menu = editor.locator('.nuke-action-menu-popup');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.nuke-action-menu-item-label')).toHaveText(['Capture View', 'Ask About Context']);
    await expect(menu.getByRole('menuitem', { name: /Capture View/ })).toBeEnabled();

    // The menu stays enabled; the existing command preflight explains the
    // missing DAGMC viewer instead of the widget inventing a second gate.
    await menu.getByRole('menuitem', { name: /Capture View/ }).click();
    await expect(
        page
            .locator('.theia-notifications-overlay')
            .getByText('Open a DAGMC model in the Visualizer before running this NukeAI action.')
            .first()
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.theia-ChatInput')).not.toBeFocused();

    expect(severe(errors), `unexpected severe errors:\n${severe(errors).join('\n')}`).toEqual([]);
});

test('simulation dashboard keeps the validation and run action groups visible', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    await runCommand(page, 'Open Simulation Dashboard');
    const dashboard = page.locator('.simulation-dashboard');
    await expect(dashboard).toBeVisible({ timeout: 30_000 });
    await createBlankProject(page);
    await dashboard.getByRole('button', { name: 'Simulation', exact: true }).click();

    const actions = dashboard.locator('.nuke-ai-actions');
    await expect(actions).toBeVisible();
    await expect(actions.locator('.nuke-ai-action-group-label .codicon-hubot').first()).toBeVisible();
    await expect(actions.locator('.nuke-ai-action-group-label').first()).toHaveCSS('text-transform', 'none');
    for (const label of ['Diagnose Project', 'Validate and Explain', 'Diagnose CSG Geometry', 'Diagnose DAGMC Model']) {
        await expect(actions.getByRole('button', { name: label })).toBeVisible();
    }
    for (const label of ['Diagnose Run', 'Explain Run']) {
        await expect(actions.getByRole('button', { name: label })).toBeVisible();
    }

    expect(severe(errors), `unexpected severe errors:\n${severe(errors).join('\n')}`).toEqual([]);
});
