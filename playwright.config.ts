import { defineConfig } from '@playwright/test';

/**
 * Playwright configuration for the NukeIDE GUI smoke suite (tests/ui/).
 *
 * The browser app must already be bundled (`yarn build:browser`). Playwright
 * starts it itself via `webServer` (theia start on 127.0.0.1:3000) and tears
 * it down after the run — no external process management needed. First paint
 * of the Theia workbench is slow, so timeouts are generous.
 */
export default defineConfig({
    testDir: './tests/ui',
    outputDir: './test-results',
    timeout: 120_000,
    expect: { timeout: 30_000 },
    retries: 0,
    workers: 1,
    reporter: [['list']],
    use: {
        baseURL: 'http://127.0.0.1:3000',
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure'
    },
    projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
    webServer: {
        command: 'yarn --cwd applications/browser start',
        url: 'http://127.0.0.1:3000',
        timeout: 180_000,
        reuseExistingServer: !process.env.CI,
        stdout: 'pipe',
        stderr: 'pipe'
    }
});
