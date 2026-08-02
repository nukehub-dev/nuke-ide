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

/** Assert a locator has meaningful (non-blank) text content. */
export async function expectNonEmptyContent(locator: ReturnType<Page['locator']>, minLength = 50): Promise<void> {
    await expect(locator).toBeVisible();
    const text = (await locator.textContent()) ?? '';
    expect(text.replace(/\s+/g, ' ').trim().length).toBeGreaterThan(minLength);
}
