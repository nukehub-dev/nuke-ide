import { Page, expect } from '@playwright/test';

/**
 * Shared helpers for the GUI smoke suite: console/page-error collection and
 * Theia Command Palette interaction. Selectors target Theia/lumino classes
 * and widget ids — no testing-only hooks in the app.
 */

/** Attach listeners that collect console messages of severity 'error' and uncaught page errors. */
export function collectErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on('console', (message) => {
        if (message.type() === 'error') {
            errors.push(message.text());
        }
    });
    page.on('pageerror', (error) => {
        errors.push(String(error));
    });
    return errors;
}

/** Wait for the Theia workbench shell to be attached and visible. */
export async function waitForWorkbench(page: Page): Promise<void> {
    const shell = page.locator('#theia-app-shell');
    await expect(shell).toBeVisible({ timeout: 60_000 });
    // The preload splash can still sit above the shell after it becomes
    // visible; clicks would be intercepted until it clears (startup flake).
    const preload = page.locator('.theia-preload');
    if ((await preload.count()) > 0) {
        await expect(preload).toBeHidden({ timeout: 120_000 });
    }
}

/**
 * Close all open editor tabs so subsequent tests start from a clean workbench
 * state. Uses Theia's "Close All Tabs" command when any tabs are present.
 */
export async function closeAllEditors(page: Page): Promise<void> {
    const tabs = page.locator('.p-TabBar-tab');
    if ((await tabs.count()) === 0) {
        return;
    }
    await runCommand(page, 'Close All Tabs');
}

/**
 * Execute a command via the Command Palette (Ctrl+Shift+P — F1 is a browser
 * help shortcut in headless Chromium and never reaches Theia). `label` is
 * matched as an exact quick-pick row label.
 */
export async function runCommand(page: Page, label: string): Promise<void> {
    // Focus the app shell first so the keybinding reaches Theia
    await page.locator('#theia-app-shell').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Control+Shift+P');
    const input = page.locator('.quick-input-widget input');
    await expect(input).toBeVisible();
    // The quick-open needs the '>' prefix to search commands (not files)
    await input.fill(`>${label}`);
    const row = page.locator('.quick-input-widget .monaco-list-row', { hasText: label }).first();
    await expect(row).toBeVisible();
    await row.click();
    // Palette closes on execution
    await expect(input).toBeHidden();
}

/**
 * Open a workspace file via Quick Open (Ctrl+P). `waitForClose` false keeps
 * the quick-input open, e.g. to snapshot a loading state mid-open.
 */
export async function openFileByQuickOpen(page: Page, name: string, waitForClose = true): Promise<void> {
    await page.locator('#theia-app-shell').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Control+P');
    const input = page.locator('.quick-input-widget input');
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(name);
    const row = page.locator('.quick-input-widget .monaco-list-row', { hasText: name }).first();
    // The first Quick Open query warms the workspace index and can be slow.
    await expect(row).toBeVisible({ timeout: 120_000 });
    await row.click();
    if (waitForClose) {
        await expect(input).toBeHidden();
    }
}

/** Assert a locator has meaningful (non-blank) text content. */
export async function expectNonEmptyContent(locator: ReturnType<Page['locator']>, minLength = 50): Promise<void> {
    await expect(locator).toBeVisible();
    const text = (await locator.textContent()) ?? '';
    expect(text.replace(/\s+/g, ' ').trim().length).toBeGreaterThan(minLength);
}

/** Dismiss Theia notification toasts so they cannot intercept later clicks. */
export async function dismissNotifications(page: Page): Promise<void> {
    await page.evaluate(() => {
        const closers = document.querySelectorAll('.theia-notifications-overlay .theia-notification-actions li.codicon-close');
        closers.forEach((element) => (element as HTMLElement).click());
    });
    await page.waitForTimeout(50);
}

/**
 * Run the New Project command and accept the default Blank template.
 * The template picker is the New Project entry point; specs that only need an
 * empty project use this helper instead of clicking through the cards.
 */
export async function createBlankProject(page: Page): Promise<void> {
    await runCommand(page, 'New Project');
    const dialog = page.locator('.new-project-dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Create Project' }).click();
    await expect(dialog).toBeHidden();
}
