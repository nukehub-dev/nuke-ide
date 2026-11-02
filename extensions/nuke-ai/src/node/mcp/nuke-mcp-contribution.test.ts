// *****************************************************************************
// Copyright (C) 2026 NukeHub and others.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice,
//    this list of conditions and the following disclaimer.
//
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.
// SPDX-License-Identifier: BSD-2-Clause
// *****************************************************************************

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { once } from 'events';
import express = require('@theia/core/shared/express');
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { ILogger } from '@theia/core/lib/common/logger';
import { ExternalApiRouter } from '@theia/external-api/lib/node/external-api-router';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { NukeCapabilityDelegate, NukeMcpResourceDescriptor } from '../../common/nuke-capability-delegate';
import {
    MCP_CAD_RESOURCE_URI,
    MCP_CONTEXT_RESOURCE_URI,
    MCP_OPENMC_RESOURCE_URI,
    MCP_SKILL_RESOURCE_PREFIX,
    MCP_VISUALIZER_RESOURCE_URI,
    NUKE_DIAGNOSTICS_PROMPT_NAME,
    NUKE_WORKFLOW_PROMPT_NAME
} from '../../common/nuke-mcp-protocol';
import type { NukeCapabilityDescriptor } from '../../common/nuke-capability-delegate';
import { FRONTEND_NOT_CONNECTED } from './nuke-capability-delegate';
import { NukeAIMcpConfig, NukeAIMcpConfigService } from './nuke-mcp-config-service';
import { MCP_DISABLED_MESSAGE } from './nuke-mcp-auth';
import { MCP_SESSION_IDLE_MS, MCP_TOOL_RATE_LIMIT, MAX_MCP_SESSIONS } from './nuke-mcp-session-registry';
import { NukeMcpContribution, redactMcpInput } from './nuke-mcp-contribution';

const TOKEN = 'test-token';
const AUTHORIZATION = `Bearer ${TOKEN}`;

const CAD_TOOL = 'nuke_cad_summarize_document';
const INSPECT_TOOL = 'nuke_cad_inspect_selection';
const OPENMC_DIAGNOSE_TOOL = 'nuke_openmc_diagnose_project';
const VIZ_SUMMARIZE_TOOL = 'nuke_viz_summarize_statepoint';
const WRITE_TOOL = 'nuke_openmc_run_simulation';

const SUMMARY = {
    documentPath: '/workspace/model.nuke-cad',
    success: true,
    selection: { solidId: 1 }
};

function capability(id: string, overrides: Partial<NukeCapabilityDescriptor> = {}): NukeCapabilityDescriptor {
    return {
        id,
        title: `Title ${id}`,
        description: `Read-only description for ${id}.`,
        category: ['Test'],
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        risk: 'read',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        ...overrides
    };
}

const CAD_CAPABILITY = capability('nuke.cad.summarizeDocument', {
    title: 'Summarize CAD document',
    description: 'Return build counts, selection, and manifest coverage for the active CAD document.',
    inputSchema: {
        type: 'object',
        properties: { includeSolids: { type: 'boolean', default: false } },
        additionalProperties: false
    },
    outputSchema: {
        type: 'object',
        properties: {
            documentPath: { type: 'string' },
            success: { type: 'boolean' },
            selection: {
                type: 'object',
                properties: { solidId: { type: 'integer' } },
                additionalProperties: false
            }
        },
        required: ['documentPath', 'success', 'selection'],
        additionalProperties: false
    },
    examples: [{ description: 'Summarize the active document', input: { includeSolids: true } }]
});

const INSPECT_CAPABILITY = capability('nuke.cad.inspectSelection', {
    title: 'Inspect CAD selection',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true }
});

const OPENMC_DIAGNOSE_CAPABILITY = capability('nuke.openmc.diagnoseProject', {
    title: 'Diagnose OpenMC project'
});

const VIZ_SUMMARIZE_CAPABILITY = capability('nuke.viz.summarizeStatepoint', {
    title: 'Summarize OpenMC statepoint'
});

const RESOURCES: NukeMcpResourceDescriptor[] = [
    {
        uri: MCP_CONTEXT_RESOURCE_URI,
        name: 'Nuke context',
        description: 'Active NukeIDE context.',
        mimeType: 'application/json'
    },
    {
        uri: MCP_CAD_RESOURCE_URI,
        name: 'Nuke CAD document',
        description: 'Active CAD document.',
        mimeType: 'application/json'
    },
    {
        uri: MCP_OPENMC_RESOURCE_URI,
        name: 'Nuke OpenMC project',
        description: 'Active OpenMC project.',
        mimeType: 'application/json'
    },
    {
        uri: MCP_VISUALIZER_RESOURCE_URI,
        name: 'Nuke visualizer dataset',
        description: 'Active visualizer dataset.',
        mimeType: 'application/json'
    },
    {
        uri: `${MCP_SKILL_RESOURCE_PREFIX}nuke-workflow`,
        name: 'nuke-workflow',
        description: 'Workflow skill.',
        mimeType: 'text/markdown'
    }
];

const INITIALIZE_REQUEST = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'nuke-mcp-test', version: '1.0.0' }
    }
};

interface FakeDelegate {
    readonly setClient: ReturnType<typeof vi.fn>;
    readonly listCapabilities: ReturnType<typeof vi.fn>;
    readonly listResources: ReturnType<typeof vi.fn>;
    readonly invoke: ReturnType<typeof vi.fn>;
    readonly readResource: ReturnType<typeof vi.fn>;
    readonly readUris: string[];
}

interface Harness {
    readonly contribution: NukeMcpContribution;
    readonly delegate: FakeDelegate;
    readonly logger: ReturnType<typeof createLogger>;
    readonly url: string;
    readonly router: ExternalApiRouter;
    readonly server: Server;
    close(): Promise<void>;
}

const openHarnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(openHarnesses.splice(0).map((harness) => harness.close()));
});

function createLogger(): ILogger & {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
} {
    return {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    } as unknown as ILogger & {
        debug: ReturnType<typeof vi.fn>;
        info: ReturnType<typeof vi.fn>;
        warn: ReturnType<typeof vi.fn>;
        error: ReturnType<typeof vi.fn>;
    };
}

function createDelegate(): FakeDelegate {
    const readUris: string[] = [];
    return {
        setClient: vi.fn(),
        listCapabilities: vi.fn(async () => [
            CAD_CAPABILITY,
            INSPECT_CAPABILITY,
            OPENMC_DIAGNOSE_CAPABILITY,
            VIZ_SUMMARIZE_CAPABILITY,
            capability('nuke.openmc.runSimulation', { risk: 'execute', requiresConfirmation: true }),
            capability('nuke.cad.exportDagmc', { risk: 'execute' }),
            capability('nuke.openmc.previewSettings'),
            capability('nuke.openmc.validateProject', { requiresConfirmation: true })
        ]),
        listResources: vi.fn(async () => RESOURCES),
        invoke: vi.fn(async (capabilityId: string) =>
            capabilityId === 'nuke.cad.summarizeDocument' ? { ok: true, data: SUMMARY } : { ok: true, data: { capabilityId } }
        ),
        readResource: vi.fn(async (uri: string) => {
            readUris.push(uri);
            return JSON.stringify({ uri });
        }),
        readUris
    } as unknown as FakeDelegate;
}

async function createHarness(options: { config?: NukeAIMcpConfig | null; delegate?: FakeDelegate } = {}): Promise<Harness> {
    const config = options.config === undefined ? { enabled: true, token: TOKEN, port: 3210 } : options.config;
    const configService = {
        getConfig: vi.fn(async () => config ?? undefined)
    } as unknown as NukeAIMcpConfigService;
    const delegate = options.delegate ?? createDelegate();
    const logger = createLogger();
    const contribution = new NukeMcpContribution(configService, delegate as unknown as NukeCapabilityDelegate, logger);
    const router = {
        raw: express.Router(),
        toDispose: new DisposableCollection()
    } as unknown as ExternalApiRouter;
    contribution.configure(router);

    const app = express();
    app.use('/nuke-ai-mcp', router.raw);
    const server = createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const harness: Harness = {
        contribution,
        delegate,
        logger,
        url: `http://127.0.0.1:${port}/nuke-ai-mcp`,
        router,
        server,
        close: async () => {
            router.toDispose.dispose();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    };
    openHarnesses.push(harness);
    return harness;
}

async function connectClient(
    harness: Harness,
    token: string = TOKEN
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
    const transport = new StreamableHTTPClientTransport(new URL(harness.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
    });
    const client = new Client({ name: 'nuke-mcp-test-client', version: '1.0.0' });
    await client.connect(transport);
    return { client, transport };
}

async function requestStatus(
    harness: Harness,
    options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{
    status: number;
    body: string;
}> {
    const response = await fetch(harness.url, {
        method: options.method ?? 'GET',
        headers: options.headers,
        body: options.body
    });
    return { status: response.status, body: await response.text() };
}

async function initializeSession(harness: Harness): Promise<string> {
    const response = await fetch(harness.url, {
        method: 'POST',
        headers: {
            Authorization: AUTHORIZATION,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify(INITIALIZE_REQUEST)
    });
    expect(response.status).toBe(200);
    const sessionId = response.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await response.text();
    return sessionId as string;
}

function textOf(result: unknown): string {
    return ((result as { content?: unknown }).content as Array<{ type: string; text: string }>)[0].text;
}

describe('NukeMcpContribution authentication', () => {
    it('returns 404 when the config file is missing', async () => {
        const harness = await createHarness({ config: null });

        const response = await requestStatus(harness);

        expect(response.status).toBe(404);
        expect(response.body).toContain('not enabled');
    });

    it('returns 404 when the config file disables the endpoint', async () => {
        const harness = await createHarness({ config: { enabled: false, token: TOKEN, port: 3210 } });

        expect((await requestStatus(harness, { headers: { Authorization: AUTHORIZATION } })).status).toBe(404);
    });

    it('returns 503 with the exact message when the token is empty', async () => {
        const harness = await createHarness({ config: { enabled: true, token: '', port: 3210 } });

        const response = await requestStatus(harness, { headers: { Authorization: AUTHORIZATION } });

        expect(response.status).toBe(503);
        expect(JSON.parse(response.body).error).toBe(MCP_DISABLED_MESSAGE);
    });

    it('returns 403 for any request carrying an Origin header', async () => {
        const harness = await createHarness();

        const response = await requestStatus(harness, {
            headers: { Authorization: AUTHORIZATION, Origin: 'https://example.com' }
        });

        expect(response.status).toBe(403);
    });

    it('returns 401 for a missing or wrong bearer token', async () => {
        const harness = await createHarness();

        expect((await requestStatus(harness)).status).toBe(401);
        expect((await requestStatus(harness, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
        expect((await requestStatus(harness, { headers: { Authorization: `basic ${TOKEN}` } })).status).toBe(401);
    });

    it('returns a JSON-RPC 404 for an unknown session', async () => {
        const harness = await createHarness();

        const response = await requestStatus(harness, {
            method: 'POST',
            headers: {
                Authorization: AUTHORIZATION,
                'Content-Type': 'application/json',
                'mcp-session-id': 'missing-session'
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })
        });

        expect(response.status).toBe(404);
        expect(JSON.parse(response.body)).toMatchObject({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session not found' },
            id: 7
        });
    });

    it('returns 400 for a non-initialize request without a session', async () => {
        const harness = await createHarness();

        const response = await requestStatus(harness, {
            method: 'POST',
            headers: { Authorization: AUTHORIZATION, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' })
        });

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body).error.code).toBe(-32000);
    });

    it('caps the session map at 16 sessions', async () => {
        const harness = await createHarness();
        for (let index = 0; index < 16; index += 1) {
            await initializeSession(harness);
        }

        const response = await requestStatus(harness, {
            method: 'POST',
            headers: { Authorization: AUTHORIZATION, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...INITIALIZE_REQUEST, id: 99 })
        });

        expect(response.status).toBe(503);
        expect(response.body).toContain('Too many active MCP sessions');
    });

    it('enforces the session cap when initialize requests race', async () => {
        const harness = await createHarness();
        const responses = await Promise.all(
            Array.from({ length: MAX_MCP_SESSIONS + 4 }, (_, index) =>
                fetch(harness.url, {
                    method: 'POST',
                    headers: {
                        Authorization: AUTHORIZATION,
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream'
                    },
                    body: JSON.stringify({ ...INITIALIZE_REQUEST, id: index + 100 })
                })
            )
        );
        const statuses = await Promise.all(
            responses.map(async (response) => {
                await response.text();
                return response.status;
            })
        );

        expect(statuses.filter((status) => status === 200)).toHaveLength(MAX_MCP_SESSIONS);
        expect(statuses.filter((status) => status === 503)).toHaveLength(4);
    });
});

describe('NukeMcpContribution MCP contract', () => {
    it('round-trips the live read-only catalog, resources, prompts, and audit rows', async () => {
        const harness = await createHarness();
        const { client } = await connectClient(harness);
        try {
            const tools = await client.listTools();
            expect(tools.tools.map((tool) => tool.name)).toEqual([CAD_TOOL, INSPECT_TOOL, OPENMC_DIAGNOSE_TOOL, VIZ_SUMMARIZE_TOOL]);
            expect(tools.tools.map((tool) => tool.name)).not.toContain(WRITE_TOOL);
            const cadTool = tools.tools[0];
            expect(cadTool.title).toBe('Summarize CAD document');
            expect(cadTool.annotations).toMatchObject({
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            });
            expect(cadTool.description).toContain('Summarize the active document');
            expect(cadTool.outputSchema).toMatchObject({ type: 'object' });
            expect((cadTool.outputSchema as { required?: string[] }).required).toEqual(['documentPath', 'success', 'selection']);

            const call = await client.callTool({ name: CAD_TOOL, arguments: { includeSolids: true } });
            expect(call.isError).toBeFalsy();
            expect(call.structuredContent).toEqual(SUMMARY);
            expect(call.content).toEqual([{ type: 'text', text: JSON.stringify({ ok: true, data: SUMMARY }) }]);
            expect(harness.delegate.invoke).toHaveBeenCalledWith('nuke.cad.summarizeDocument', { includeSolids: true });

            const inspect = await client.callTool({ name: INSPECT_TOOL, arguments: { token: 'secret' } });
            expect(inspect.structuredContent).toEqual({ capabilityId: 'nuke.cad.inspectSelection' });
            expect(harness.delegate.invoke).toHaveBeenLastCalledWith('nuke.cad.inspectSelection', { token: 'secret' });

            const resources = await client.listResources();
            expect(resources.resources.map((resource) => resource.uri).sort()).toEqual(RESOURCES.map((resource) => resource.uri).sort());
            const context = await client.readResource({ uri: MCP_CONTEXT_RESOURCE_URI });
            expect(harness.delegate.readUris).toContain(MCP_CONTEXT_RESOURCE_URI);
            expect((context.contents[0] as { text?: string }).text).toBe(JSON.stringify({ uri: MCP_CONTEXT_RESOURCE_URI }));
            for (const uri of [MCP_CAD_RESOURCE_URI, MCP_OPENMC_RESOURCE_URI, MCP_VISUALIZER_RESOURCE_URI]) {
                const resource = await client.readResource({ uri });
                expect((resource.contents[0] as { text?: string }).text).toBe(JSON.stringify({ uri }));
            }
            const skill = await client.readResource({ uri: `${MCP_SKILL_RESOURCE_PREFIX}nuke-workflow` });
            expect(skill.contents[0].mimeType).toBe('text/markdown');

            const prompts = await client.listPrompts();
            expect(prompts.prompts.map((prompt) => prompt.name).sort()).toEqual(
                [NUKE_DIAGNOSTICS_PROMPT_NAME, NUKE_WORKFLOW_PROMPT_NAME].sort()
            );
            const workflow = await client.getPrompt({ name: NUKE_WORKFLOW_PROMPT_NAME });
            const workflowText = (workflow.messages[0].content as { type: string; text: string }).text;
            expect(workflowText).toContain(CAD_TOOL);
            expect(workflowText).toContain(OPENMC_DIAGNOSE_TOOL);
            expect(workflowText).toContain(VIZ_SUMMARIZE_TOOL);
            expect(workflowText).not.toContain('nuke.openmc.runSimulation');
            expect(workflowText).not.toContain('nuke.cad.exportDagmc');
            const diagnostics = await client.getPrompt({ name: NUKE_DIAGNOSTICS_PROMPT_NAME });
            const diagnosticsText = (diagnostics.messages[0].content as { type: string; text: string }).text;
            expect(diagnosticsText).toContain(OPENMC_DIAGNOSE_TOOL);
            expect(diagnosticsText).toContain('Prioritize findings by severity');

            const audit = harness.contribution.getAuditEntries(2);
            expect(audit).toHaveLength(2);
            expect(audit[0].tool).toBe(INSPECT_TOOL);
            expect(audit[1].tool).toBe(CAD_TOOL);
            expect(audit[0].inputHash).toMatch(/^[0-9a-f]{16}$/);
            expect(audit[0].inputSummary).toContain('[redacted]');
            expect(audit[0].inputSummary).not.toContain('secret');

            const invocationLogs = harness.logger.info.mock.calls.filter(([message]) => String(message).includes('MCP tool='));
            expect(invocationLogs).toHaveLength(2);
            for (const [message] of invocationLogs) {
                expect(String(message)).not.toContain('includeSolids');
                expect(String(message)).not.toContain('secret');
                expect(String(message)).toContain('inputHash=');
            }
            expect(JSON.stringify(harness.logger.info.mock.calls)).not.toContain(TOKEN);
        } finally {
            await client.close();
        }
    });

    it('returns a tool error when the frontend delegate is not connected', async () => {
        const delegate = createDelegate();
        delegate.invoke.mockRejectedValue(new Error(FRONTEND_NOT_CONNECTED));
        const harness = await createHarness({ delegate });
        const { client } = await connectClient(harness);
        try {
            const result = await client.callTool({ name: CAD_TOOL, arguments: {} });

            expect(result.isError).toBe(true);
            expect(textOf(result)).toBe(FRONTEND_NOT_CONNECTED);
            expect(result.structuredContent).toEqual(undefined);
            expect(harness.contribution.getAuditEntries(1)[0]).toMatchObject({ tool: CAD_TOOL, ok: false });
        } finally {
            await client.close();
        }
    });

    it('opens a session with no tools and the context fallback when the frontend catalog is unavailable', async () => {
        const delegate = createDelegate();
        delegate.listCapabilities.mockRejectedValue(new Error(FRONTEND_NOT_CONNECTED));
        delegate.listResources.mockRejectedValue(new Error(FRONTEND_NOT_CONNECTED));
        const harness = await createHarness({ delegate });
        const { client } = await connectClient(harness);
        try {
            expect((await client.listTools()).tools).toEqual([]);
            expect((await client.listResources()).resources.map((resource) => resource.uri)).toEqual([MCP_CONTEXT_RESOURCE_URI]);
            expect((await client.listPrompts()).prompts.map((prompt) => prompt.name).sort()).toEqual(
                [NUKE_DIAGNOSTICS_PROMPT_NAME, NUKE_WORKFLOW_PROMPT_NAME].sort()
            );
            expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining('catalog unavailable'));
            expect(harness.logger.warn).toHaveBeenCalledWith(expect.stringContaining('resource catalog unavailable'));
        } finally {
            await client.close();
        }
    });

    it('rejects unexposed tool calls in the raw handler', async () => {
        const harness = await createHarness();
        const { client } = await connectClient(harness);
        try {
            await expect(client.callTool({ name: WRITE_TOOL, arguments: {} })).rejects.toThrow(/not exposed/);

            expect(harness.delegate.invoke).not.toHaveBeenCalled();
            expect(harness.contribution.getAuditEntries(1)[0]).toMatchObject({
                tool: WRITE_TOOL,
                ok: false,
                inputSummary: '[rejected tool call]'
            });
        } finally {
            await client.close();
        }
    });

    it('filters resources outside the read-only scope', async () => {
        const delegate = createDelegate();
        delegate.listResources.mockResolvedValue([
            ...RESOURCES,
            { uri: 'file:///etc/passwd', name: 'passwd', description: 'escape', mimeType: 'text/plain' },
            { uri: 'nuke://skills/../secret', name: 'escape', description: 'escape', mimeType: 'text/plain' },
            { uri: MCP_CONTEXT_RESOURCE_URI, name: 'duplicate', description: 'duplicate', mimeType: 'text/plain' }
        ]);
        const harness = await createHarness({ delegate });
        const { client } = await connectClient(harness);
        try {
            const resources = await client.listResources();
            const uris = resources.resources.map((resource) => resource.uri);
            expect(uris).toEqual(RESOURCES.map((resource) => resource.uri));
            expect(uris).not.toContain('file:///etc/passwd');
            expect(uris).not.toContain('nuke://skills/../secret');
        } finally {
            await client.close();
        }
    });

    it('returns a resource error without stopping the server', async () => {
        const delegate = createDelegate();
        delegate.readResource.mockImplementation(async (uri: string) => {
            if (uri === MCP_CAD_RESOURCE_URI) {
                throw new Error('backend offline');
            }
            return JSON.stringify({ uri });
        });
        const harness = await createHarness({ delegate });
        const { client } = await connectClient(harness);
        try {
            await expect(client.readResource({ uri: MCP_CAD_RESOURCE_URI })).rejects.toThrow(/backend offline/);
            await expect(client.readResource({ uri: 'nuke://missing' })).rejects.toThrow();
            expect((await client.listTools()).tools).toHaveLength(4);
            expect(harness.logger.warn).toHaveBeenCalledWith(
                expect.stringContaining(`MCP resource read failed for ${MCP_CAD_RESOURCE_URI}`)
            );
        } finally {
            await client.close();
        }
    });

    it(`rate-limits one session at ${MCP_TOOL_RATE_LIMIT} calls per minute and audits the excess`, async () => {
        const harness = await createHarness();
        const { client } = await connectClient(harness);
        try {
            for (let index = 0; index < MCP_TOOL_RATE_LIMIT; index += 1) {
                const result = await client.callTool({ name: INSPECT_TOOL, arguments: {} });
                expect(result.isError).toBeFalsy();
            }

            const limited = await client.callTool({ name: INSPECT_TOOL, arguments: {} });
            expect(limited.isError).toBe(true);
            expect(textOf(limited)).toContain('Rate limit exceeded');
            expect(harness.contribution.getAuditEntries(1)[0]).toMatchObject({
                tool: INSPECT_TOOL,
                ok: false
            });
            expect(harness.contribution.getAuditEntries(1)[0].inputSummary).toContain('[rate limited]');
        } finally {
            await client.close();
        }
    });

    it('clears sessions when the routing rebuilds', async () => {
        const harness = await createHarness();
        const sessionId = await initializeSession(harness);

        harness.router.toDispose.dispose();
        await new Promise((resolve) => setTimeout(resolve, 20));

        const afterDispose = await requestStatus(harness, {
            method: 'POST',
            headers: {
                Authorization: AUTHORIZATION,
                'Content-Type': 'application/json',
                'mcp-session-id': sessionId
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' })
        });
        expect(afterDispose.status).toBe(404);
    });

    it('closes and deregisters a session on DELETE', async () => {
        const harness = await createHarness();
        const sessionId = await initializeSession(harness);

        const removed = await requestStatus(harness, {
            method: 'DELETE',
            headers: { Authorization: AUTHORIZATION, 'mcp-session-id': sessionId }
        });
        expect(removed.status).toBe(200);

        const afterDelete = await requestStatus(harness, {
            method: 'POST',
            headers: {
                Authorization: AUTHORIZATION,
                'Content-Type': 'application/json',
                'mcp-session-id': sessionId
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' })
        });
        expect(afterDelete.status).toBe(404);
    });

    it('redacts secrets and caps long strings in invocation logs', () => {
        const redacted = JSON.parse(
            redactMcpInput({
                authorization: 'Bearer secret',
                token: 'secret',
                nested: { apiKey: 'secret', password: 'secret' },
                long: 'a'.repeat(300)
            })
        );

        expect(redacted.authorization).toBe('[redacted]');
        expect(redacted.token).toBe('[redacted]');
        expect(redacted.nested.apiKey).toBe('[redacted]');
        expect(redacted.nested.password).toBe('[redacted]');
        expect(String(redacted.long).length).toBeLessThanOrEqual(200);
        expect(String(redacted.long)).toContain('[truncated]');
    });
});

describe('NukeMcpContribution idle policy', () => {
    it('exposes a 30-minute idle timeout', () => {
        expect(MCP_SESSION_IDLE_MS).toBe(30 * 60 * 1000);
    });
});
