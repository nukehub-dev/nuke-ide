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

/**
 * Nuke MCP Contribution
 *
 * Hosts a small, read-only MCP endpoint on Theia's external API router. The
 * endpoint is disabled unless `<configDir>/nuke-ai-mcp.json` says otherwise,
 * requires a matching bearer token, and rejects cross-origin requests. Each
 * MCP session gets its own `McpServer` and `StreamableHTTPServerTransport`
 * because the SDK connects a server to exactly one transport.
 *
 * @module nuke-ai/node/mcp
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { Disposable } from '@theia/core/lib/common/disposable';
import { ILogger } from '@theia/core/lib/common/logger';
import * as express from '@theia/core/shared/express';
import { ExternalApiContribution } from '@theia/external-api/lib/node/external-api-contribution';
import { ExternalApiRouter } from '@theia/external-api/lib/node/external-api-router';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolResult, isInitializeRequest, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import { fromJSONSchema } from 'zod';
import type { NukeJsonSchema } from 'nuke-core/lib/common/nuke-capability-protocol';
import { NukeCapabilityDelegate } from '../../common/nuke-capability-delegate';
import {
    NUKE_WORKFLOW_PROMPT,
    NUKE_WORKFLOW_PROMPT_NAME,
    SPIKE_CAD_RESOURCE_URI,
    SPIKE_CAPABILITY,
    SPIKE_CONTEXT_RESOURCE_URI,
    SPIKE_TOOL_NAME
} from '../../common/nuke-mcp-protocol';
import { hasOrigin, isAuthorizedBearer, MCP_DISABLED_MESSAGE } from './nuke-mcp-auth';
import { NukeAIMcpConfigService } from './nuke-mcp-config-service';

/** Maximum concurrent MCP sessions held by one contribution build. */
export const MAX_MCP_SESSIONS = 16;

/** MCP server identity reported during initialization. */
const MCP_SERVER_INFO = { name: 'nuke-ide', version: '0.1.3' };

const TOOL_DESCRIPTION = `${SPIKE_CAPABILITY.description} Example: {"includeSolids": true} returns one summary per solid in addition to the model totals.`;

const SENSITIVE_KEY = /(authorization|token|api[_-]?key|secret|password)/i;
const MAX_LOG_STRING = 200;
const TRUNCATION_SUFFIX = '... [truncated]';
const MAX_LOG_DEPTH = 5;
const MAX_LOG_ENTRIES = 50;

interface McpSession {
    readonly server: McpServer;
    readonly transport: StreamableHTTPServerTransport;
}

/** External MCP endpoint for the read-only CAD summary catalog. */
@injectable()
export class NukeMcpContribution implements ExternalApiContribution {
    readonly path = '/nuke-ai-mcp';

    constructor(
        @inject(NukeAIMcpConfigService) protected readonly configService: NukeAIMcpConfigService,
        @inject(NukeCapabilityDelegate) protected readonly delegate: NukeCapabilityDelegate,
        @inject(ILogger) protected readonly logger: ILogger
    ) {}

    configure(router: ExternalApiRouter): void {
        const sessions = new Map<string, McpSession>();
        router.toDispose.push(Disposable.create(() => void this.closeSessions(sessions)));
        router.raw.use(express.json({ limit: '1mb' }));
        router.raw.all('/', (request, response) => {
            void this.handle(request, response, sessions);
        });
    }

    protected async handle(request: express.Request, response: express.Response, sessions: Map<string, McpSession>): Promise<void> {
        try {
            await this.handleRequest(request, response, sessions);
        } catch (error) {
            this.logger.error('[NukeAI] MCP request failed.', error);
            if (!response.headersSent) {
                response.status(500).json({ error: 'Internal MCP error.' });
            } else if (!response.writableEnded) {
                response.end();
            }
        }
    }

    protected async handleRequest(request: express.Request, response: express.Response, sessions: Map<string, McpSession>): Promise<void> {
        const config = await this.configService.getConfig();
        if (!config || !config.enabled) {
            this.writeError(response, 404, 'MCP is not enabled.');
            return;
        }
        if (config.token.trim().length === 0) {
            this.writeError(response, 503, MCP_DISABLED_MESSAGE);
            return;
        }
        if (hasOrigin(request.headers)) {
            this.writeError(response, 403, 'Cross-origin requests are not allowed.');
            return;
        }
        if (!isAuthorizedBearer(request.headers.authorization, config.token)) {
            this.writeError(response, 401, 'Unauthorized.');
            return;
        }

        const sessionId = getSessionId(request);
        if (sessionId !== undefined) {
            const session = sessions.get(sessionId);
            if (!session) {
                this.writeJsonRpcError(response, 404, -32001, 'Session not found', request.body);
                return;
            }
            await session.transport.handleRequest(request, response, request.body);
            return;
        }

        if (request.method !== 'POST' || !isInitializeRequest(request.body)) {
            this.writeJsonRpcError(response, 400, -32000, 'Bad Request: Mcp-Session-Id header is required', request.body);
            return;
        }
        if (sessions.size >= MAX_MCP_SESSIONS) {
            this.writeError(response, 503, 'Too many active MCP sessions. Try again later.');
            return;
        }

        const session = await this.createSession(sessions);
        await session.transport.handleRequest(request, response, request.body);
    }

    protected async createSession(sessions: Map<string, McpSession>): Promise<McpSession> {
        const server = this.createServer();
        let initializedId: string | undefined;
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sessionId) => {
                initializedId = sessionId;
                sessions.set(sessionId, { server, transport });
                this.logger.info(`[NukeAI] MCP session opened (${sessions.size} active).`);
            },
            onsessionclosed: (sessionId) => {
                sessions.delete(sessionId);
                this.logger.info(`[NukeAI] MCP session closed (${sessions.size} active).`);
            }
        });
        transport.onerror = (error) => this.logger.warn('[NukeAI] MCP transport error.', error);
        transport.onclose = () => {
            if (initializedId !== undefined) {
                sessions.delete(initializedId);
            }
        };
        try {
            await server.connect(transport);
        } catch (error) {
            await server.close().catch(() => undefined);
            throw error;
        }
        return { server, transport };
    }

    protected createServer(): McpServer {
        const server = new McpServer(MCP_SERVER_INFO);
        server.registerTool(
            SPIKE_TOOL_NAME,
            {
                title: SPIKE_CAPABILITY.title,
                description: TOOL_DESCRIPTION,
                inputSchema: toZodSchema(SPIKE_CAPABILITY.inputSchema),
                outputSchema: SPIKE_CAPABILITY.outputSchema ? toZodSchema(SPIKE_CAPABILITY.outputSchema) : undefined,
                annotations: SPIKE_CAPABILITY.annotations
            },
            async (args) => this.invokeSpikeTool(args)
        );
        server.registerResource(
            'nuke-context',
            SPIKE_CONTEXT_RESOURCE_URI,
            {
                title: 'Nuke context',
                description: 'Active NukeIDE workspace roots, CAD document, OpenMC project, and visualizer dataset.',
                mimeType: 'application/json'
            },
            async (uri) => this.readSpikeResource(uri.toString())
        );
        server.registerResource(
            'nuke-cad-document',
            SPIKE_CAD_RESOURCE_URI,
            {
                title: 'Nuke CAD document',
                description: 'Build counts, selection, and manifest for the active CAD document.',
                mimeType: 'application/json'
            },
            async (uri) => this.readSpikeResource(uri.toString())
        );
        server.registerPrompt(
            NUKE_WORKFLOW_PROMPT_NAME,
            {
                title: 'Nuke workflow',
                description: 'Walk through the CAD to DAGMC to OpenMC to visualizer workflow without writing anything.'
            },
            () => ({
                messages: [
                    {
                        role: 'user',
                        content: { type: 'text', text: NUKE_WORKFLOW_PROMPT }
                    }
                ]
            })
        );
        return server;
    }

    protected async invokeSpikeTool(input: unknown): Promise<CallToolResult> {
        const started = Date.now();
        let ok = false;
        try {
            const result = await this.delegate.invoke(SPIKE_CAPABILITY.id, input);
            ok = result.ok;
            return {
                structuredContent: toStructuredContent(result),
                content: [{ type: 'text', text: stringifyResult(result) }],
                isError: !result.ok
            };
        } catch (error) {
            const message = errorMessage(error);
            return {
                structuredContent: { ok: false },
                content: [{ type: 'text', text: message }],
                isError: true
            };
        } finally {
            this.logger.info(
                `[NukeAI] MCP tool=${SPIKE_TOOL_NAME} durationMs=${Date.now() - started} ok=${ok} input=${redactMcpInput(input)}`
            );
        }
    }

    protected async readSpikeResource(uri: string): Promise<ReadResourceResult> {
        const text = await this.delegate.readResource(uri);
        return {
            contents: [{ uri, mimeType: 'application/json', text }]
        };
    }

    protected async closeSessions(sessions: Map<string, McpSession>): Promise<void> {
        if (sessions.size === 0) {
            return;
        }
        const closing = Array.from(sessions.values());
        sessions.clear();
        await Promise.allSettled(closing.map((session) => session.server.close()));
    }

    protected writeError(response: express.Response, status: number, message: string): void {
        response.status(status).json({ error: message });
    }

    protected writeJsonRpcError(response: express.Response, status: number, code: number, message: string, body: unknown): void {
        response.status(status).json({
            jsonrpc: '2.0',
            error: { code, message },
            id: requestId(body)
        });
    }
}

/** Coerce a capability JSON schema into the Zod schema accepted by the MCP SDK. */
function toZodSchema(schema: NukeJsonSchema) {
    return fromJSONSchema(schema as unknown as Parameters<typeof fromJSONSchema>[0]);
}

/** Turn a capability result into the object shape required by `structuredContent`. */
function toStructuredContent(result: { ok: boolean; data?: unknown }): Record<string, unknown> {
    if (result.data !== null && typeof result.data === 'object' && !Array.isArray(result.data)) {
        return result.data as Record<string, unknown>;
    }
    if (result.data !== undefined) {
        return { ok: result.ok, data: result.data };
    }
    return { ok: result.ok };
}

function stringifyResult(result: unknown): string {
    try {
        return JSON.stringify(result);
    } catch {
        return '{"ok":false,"message":"Unable to serialize the capability result."}';
    }
}

function requestId(body: unknown): string | number | null {
    const messages = Array.isArray(body) ? body : [body];
    for (const message of messages) {
        if (message !== null && typeof message === 'object' && 'id' in message) {
            const id = (message as { id?: unknown }).id;
            if (typeof id === 'string' || typeof id === 'number') {
                return id;
            }
        }
    }
    return null;
}

function getSessionId(request: express.Request): string | undefined {
    const header = request.headers['mcp-session-id'];
    if (Array.isArray(header)) {
        return header[0];
    }
    return header;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Redact secrets and cap long strings before an invocation input reaches the
 * IDE log. Never log the bearer token or any nested credential.
 */
export function redactMcpInput(input: unknown): string {
    try {
        return JSON.stringify(redactValue(input, 0, new WeakSet<object>())) ?? '[undefined input]';
    } catch {
        return '[unserializable input]';
    }
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        return capLogString(value);
    }
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (typeof value !== 'object') {
        return String(value);
    }
    if (depth >= MAX_LOG_DEPTH) {
        return '[truncated]';
    }
    if (seen.has(value)) {
        return '[circular]';
    }
    seen.add(value);
    if (Array.isArray(value)) {
        return value.slice(0, MAX_LOG_ENTRIES).map((entry) => redactValue(entry, depth + 1, seen));
    }
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value).slice(0, MAX_LOG_ENTRIES)) {
        result[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redactValue(entry, depth + 1, seen);
    }
    return result;
}

function capLogString(value: string): string {
    if (value.length <= MAX_LOG_STRING) {
        return value;
    }
    return value.slice(0, MAX_LOG_STRING - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}
