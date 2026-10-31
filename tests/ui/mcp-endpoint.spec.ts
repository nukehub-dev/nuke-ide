import { expect, test } from '@playwright/test';
import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { collectErrors, dismissNotifications, waitForWorkbench } from './helpers';

// This smoke test enables the real endpoint, which writes the IDE's user-scoped
// external API preferences and the MCP config file. Keep it opt-in so the
// regular UI suite never changes a developer's local settings.
test.skip(!process.env.NUKE_MCP_E2E, 'set NUKE_MCP_E2E=1 to run the MCP endpoint smoke test');

const MCP_URL = 'http://127.0.0.1:3210/nuke-ai-mcp';
const CONFIG_PATH = path.join(os.homedir(), '.nuke-ide', 'nuke-ai-mcp.json');

// Never overwrite a developer's existing MCP token or client configuration.
test.skip(existsSync(CONFIG_PATH), 'an MCP config already exists; refusing to overwrite it');

async function runEnableCommand(page: import('@playwright/test').Page): Promise<void> {
    await page.locator('#theia-app-shell').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Control+Shift+P');
    const input = page.locator('.quick-input-widget input');
    await expect(input).toBeVisible();
    await input.fill('>NukeAI: Enable MCP Endpoint');
    const row = page.locator('.quick-input-widget .monaco-list-row', { hasText: 'NukeAI: Enable MCP Endpoint' }).first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(input).toBeVisible();
    await input.press('Enter');
}

async function waitForConfig(): Promise<{ enabled: boolean; token: string; port: number }> {
    for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
            return JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
    throw new Error(`MCP config was not written at ${CONFIG_PATH}`);
}

async function waitForServer(): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
            const response = await fetch(MCP_URL, { method: 'GET' });
            if (response.status === 401 || response.status === 200) {
                return;
            }
        } catch {
            // not listening yet
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('MCP endpoint did not start');
}

test('MCP endpoint can be enabled, used by a real client, and disabled', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectErrors(page);
    await page.goto('/');
    await waitForWorkbench(page);

    await runEnableCommand(page);
    const config = await waitForConfig();
    expect(config.enabled).toBe(true);
    expect(config.port).toBe(3210);
    expect(config.token).toMatch(/^[0-9a-f-]{36}$/);

    await waitForServer();

    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
        requestInit: { headers: { Authorization: `Bearer ${config.token}` } }
    });
    const client = new Client({ name: 'nuke-ide-e2e', version: '1.0.0' });
    await client.connect(transport);
    try {
        const tools = await client.listTools();
        const toolNames = tools.tools.map((tool) => tool.name);
        expect(toolNames.length).toBeGreaterThan(0);
        for (const name of toolNames) {
            expect(name).toMatch(/^[a-z0-9_]{1,128}$/);
        }
        expect(toolNames).toContain('nuke_viz_summarize_statepoint');
        for (const forbidden of [
            'nuke_cad_export_dagmc',
            'nuke_openmc_run_simulation',
            'nuke_openmc_import_cad',
            'nuke_openmc_apply_settings',
            'nuke_openmc_preview_settings'
        ]) {
            expect(toolNames).not.toContain(forbidden);
        }
        for (const tool of tools.tools) {
            expect(tool.annotations?.readOnlyHint).toBe(true);
        }

        const resources = await client.listResources();
        const resourceUris = resources.resources.map((resource) => resource.uri);
        expect(resourceUris).toContain('nuke://context');
        for (const uri of resourceUris) {
            expect(uri).toMatch(/^nuke:\/\/(context|cad\/document|openmc\/project|visualizer\/dataset|skills\/[a-z0-9-]+)$/);
        }

        const context = await client.readResource({ uri: 'nuke://context' });
        expect((context.contents[0] as { text?: string }).text).toContain('workspaceRoots');

        const prompts = await client.listPrompts();
        const promptNames = prompts.prompts.map((prompt) => prompt.name);
        expect(promptNames).toContain('nuke-workflow');
        expect(promptNames).toContain('nuke-diagnostics');
        const workflow = await client.getPrompt({ name: 'nuke-workflow' });
        const workflowText = (workflow.messages[0].content as { type: string; text: string }).text;
        for (const name of toolNames) {
            expect(workflowText).toContain(name);
        }
    } finally {
        await client.close();
    }

    const unauthorized = await fetch(MCP_URL, { method: 'GET' });
    expect(unauthorized.status).toBe(401);
    const crossOrigin = await fetch(MCP_URL, {
        method: 'GET',
        headers: { Origin: 'https://example.com', Authorization: `Bearer ${config.token}` }
    });
    expect(crossOrigin.status).toBe(403);

    await dismissNotifications(page);
    await page.locator('#theia-app-shell').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Control+Shift+P');
    const input = page.locator('.quick-input-widget input');
    await expect(input).toBeVisible();
    await input.fill('>NukeAI: Disable MCP Endpoint');
    const row = page.locator('.quick-input-widget .monaco-list-row', { hasText: 'NukeAI: Disable MCP Endpoint' }).first();
    await expect(row).toBeVisible();
    await row.click();

    await expect
        .poll(async () => {
            try {
                await fs.stat(CONFIG_PATH);
                return false;
            } catch {
                return true;
            }
        })
        .toBe(true);

    await expect
        .poll(async () => {
            try {
                const response = await fetch(MCP_URL, { method: 'GET' });
                return response.status;
            } catch {
                return 'closed';
            }
        })
        .not.toBe(200);

    expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
