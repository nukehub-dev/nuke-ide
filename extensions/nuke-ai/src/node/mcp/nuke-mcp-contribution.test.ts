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
import { NukeCapabilityDelegate } from '../../common/nuke-capability-delegate';
import {
    NUKE_WORKFLOW_PROMPT_NAME,
    SPIKE_CAD_RESOURCE_URI,
    SPIKE_CAPABILITY,
    SPIKE_CONTEXT_RESOURCE_URI,
    SPIKE_TOOL_NAME
} from '../../common/nuke-mcp-protocol';
import { FRONTEND_NOT_CONNECTED } from './nuke-capability-delegate';
import { NukeAIMcpConfig, NukeAIMcpConfigService } from './nuke-mcp-config-service';
import { MCP_DISABLED_MESSAGE } from './nuke-mcp-auth';
import { MAX_MCP_SESSIONS, NukeMcpContribution, redactMcpInput } from './nuke-mcp-contribution';

const TOKEN = 'test-token';
const AUTHORIZATION = `Bearer ${TOKEN}`;

const SUMMARY = {
    documentPath: '/workspace/model.nuke-cad',
    success: true,
    solidCount: 2,
    faceCount: 12,
    triangleCount: 24,
    boundingBox: { min: [0, 0, 0], max: [1, 1, 1] },
    warnings: [],
    selection: { solidId: 1 },
    manifest: { volumes: [], surfaces: [] }
};

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
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
} {
    return {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    } as unknown as ILogger & {
        info: ReturnType<typeof vi.fn>;
        warn: ReturnType<typeof vi.fn>;
        error: ReturnType<typeof vi.fn>;
    };
}

function createDelegate(): FakeDelegate {
    const readUris: string[] = [];
    return {
        setClient: vi.fn(),
        listCapabilities: vi.fn(async () => [SPIKE_CAPABILITY]),
        invoke: vi.fn(async () => ({ ok: true, data: SUMMARY })),
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

    it(`caps the session map at ${MAX_MCP_SESSIONS} sessions`, async () => {
        const harness = await createHarness();
        for (let index = 0; index < MAX_MCP_SESSIONS; index += 1) {
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
});

describe('NukeMcpContribution MCP contract', () => {
    it('round-trips tools, output schema, structured content, annotations, resources, and prompts', async () => {
        const harness = await createHarness();
        const { client } = await connectClient(harness);
        try {
            const tools = await client.listTools();
            expect(tools.tools).toHaveLength(1);
            const tool = tools.tools[0];
            expect(tool.name).toBe(SPIKE_TOOL_NAME);
            expect(tool.title).toBe(SPIKE_CAPABILITY.title);
            expect(tool.annotations).toMatchObject({
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            });
            expect(tool.outputSchema).toMatchObject({ type: 'object' });
            expect((tool.outputSchema as { required?: string[] }).required).toEqual(['documentPath', 'success', 'selection']);

            const call = await client.callTool({ name: SPIKE_TOOL_NAME, arguments: { includeSolids: true } });
            expect(call.isError).toBeFalsy();
            expect(call.structuredContent).toEqual(SUMMARY);
            expect(call.content).toEqual([{ type: 'text', text: JSON.stringify({ ok: true, data: SUMMARY }) }]);
            expect(harness.delegate.invoke).toHaveBeenCalledWith(SPIKE_CAPABILITY.id, { includeSolids: true });

            const resources = await client.listResources();
            expect(resources.resources.map((resource) => resource.uri).sort()).toEqual(
                [SPIKE_CAD_RESOURCE_URI, SPIKE_CONTEXT_RESOURCE_URI].sort()
            );

            const resource = await client.readResource({ uri: SPIKE_CONTEXT_RESOURCE_URI });
            expect(harness.delegate.readUris).toContain(SPIKE_CONTEXT_RESOURCE_URI);
            const resourceText = (resource.contents[0] as { text?: string }).text;
            expect(resourceText).toBe(JSON.stringify({ uri: SPIKE_CONTEXT_RESOURCE_URI }));

            const prompts = await client.listPrompts();
            expect(prompts.prompts.map((prompt) => prompt.name)).toEqual([NUKE_WORKFLOW_PROMPT_NAME]);
            const prompt = await client.getPrompt({ name: NUKE_WORKFLOW_PROMPT_NAME });
            const promptText = (prompt.messages[0].content as { type: string; text: string }).text;
            expect(promptText).toContain('nuke.cad.summarizeDocument');
            expect(promptText).toContain('nuke.openmc.runSimulation');
            expect(promptText).toContain('nuke.viz.openStatepoint');

            const invocationLogs = harness.logger.info.mock.calls.filter(([message]) =>
                String(message).includes(`MCP tool=${SPIKE_TOOL_NAME}`)
            );
            expect(invocationLogs).toHaveLength(1);
            expect(String(invocationLogs[0][0])).toContain('ok=true');
            expect(String(invocationLogs[0][0])).toContain('durationMs=');
        } finally {
            await client.close();
        }
    });

    it('returns a tool error when the frontend delegate is not connected', async () => {
        const delegate = {
            ...createDelegate(),
            invoke: vi.fn(async () => {
                throw new Error(FRONTEND_NOT_CONNECTED);
            })
        } as FakeDelegate;
        const harness = await createHarness({ delegate });
        const { client } = await connectClient(harness);
        try {
            const result = await client.callTool({ name: SPIKE_TOOL_NAME, arguments: {} });

            expect(result.isError).toBe(true);
            expect((result.content as Array<{ type: string; text: string }>)[0].text).toBe(FRONTEND_NOT_CONNECTED);
            expect(result.structuredContent).toEqual({ ok: false });
        } finally {
            await client.close();
        }
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
