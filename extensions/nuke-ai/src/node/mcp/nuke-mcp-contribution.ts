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
 * Hosts a read-only MCP endpoint on Theia's external API router. The endpoint
 * is disabled unless `<configDir>/nuke-ai-mcp.json` says otherwise, requires a
 * matching bearer token, accepts only loopback peers, and rejects cross-origin
 * requests. Each MCP session gets its own `McpServer`,
 * `StreamableHTTPServerTransport`, and catalog built from the live frontend
 * capability registry.
 *
 * Only the explicit read-only allowlist can cross this boundary. Write,
 * execute, and destructive capabilities stay in the in-process AI chat.
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
import { CallToolResult, ErrorCode, McpError, isInitializeRequest, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import type { NukeCapabilityResult } from 'nuke-core/lib/common/nuke-capability-protocol';
import { NukeCapabilityDelegate, NukeCapabilityDescriptor, NukeMcpResourceDescriptor } from '../../common/nuke-capability-delegate';
import {
    boundedMcpText,
    boundedMcpValue,
    buildDiagnosticsPrompt,
    buildWorkflowPrompt,
    isAllowedMcpCapability,
    isAllowedMcpResourceUri,
    isReadOnlyMcpCapability,
    MCP_CONTEXT_RESOURCE_URI,
    MCP_MAX_RESOURCES,
    stringifyMcpResult,
    NUKE_DIAGNOSTICS_PROMPT_NAME,
    NUKE_WORKFLOW_PROMPT_NAME,
    NukeMcpToolSummary
} from '../../common/nuke-mcp-protocol';
import { hasOrigin, isAuthorizedBearer, isLoopbackAddress, MCP_DISABLED_MESSAGE } from './nuke-mcp-auth';
import { MCP_AUDIT_LIMIT, MCP_AUDIT_SUMMARY_LIMIT, NukeMcpAuditEntry, NukeMcpAuditLog, summarizeMcpInput } from './nuke-mcp-audit';
import { buildReadOnlyToolCatalog, NukeMcpCatalogTool } from './nuke-mcp-catalog';
import { NukeAIMcpConfigService } from './nuke-mcp-config-service';
import {
    MAX_MCP_SESSIONS,
    MCP_TOOL_RATE_LIMIT,
    MCP_TOOL_RATE_WINDOW_MS,
    NukeMcpManagedSession,
    NukeMcpSessionRegistry
} from './nuke-mcp-session-registry';

export { MAX_MCP_SESSIONS, MCP_SESSION_IDLE_MS, MCP_TOOL_RATE_LIMIT, MCP_TOOL_RATE_WINDOW_MS } from './nuke-mcp-session-registry';
export { redactMcpInput } from './nuke-mcp-audit';

/** Keep the advertised server version in sync with the released extension version. */
const { version: MCP_SERVER_VERSION } = require('../../../package.json') as { version: string };

/** MCP server identity reported during initialization. */
const MCP_SERVER_INFO = { name: 'nuke-ide', version: MCP_SERVER_VERSION };

/** Static context descriptor registered when the frontend catalog is unavailable. */
const CONTEXT_FALLBACK: NukeMcpResourceDescriptor = {
    uri: MCP_CONTEXT_RESOURCE_URI,
    name: 'Nuke context',
    description: 'Active NukeIDE workspace roots, CAD document, OpenMC project, and visualizer dataset.',
    mimeType: 'application/json'
};

interface McpSession extends NukeMcpManagedSession {
    readonly tools: ReadonlyMap<string, NukeMcpCatalogTool>;
}

/** External MCP endpoint for the live read-only catalog. */
@injectable()
export class NukeMcpContribution implements ExternalApiContribution {
    readonly path = '/nuke-ai-mcp';

    protected readonly audit = new NukeMcpAuditLog(MCP_AUDIT_LIMIT);
    protected sessionRegistry: NukeMcpSessionRegistry<McpSession> | undefined;
    protected pendingSessions = 0;

    constructor(
        @inject(NukeAIMcpConfigService) protected readonly configService: NukeAIMcpConfigService,
        @inject(NukeCapabilityDelegate) protected readonly delegate: NukeCapabilityDelegate,
        @inject(ILogger) protected readonly logger: ILogger
    ) {}

    configure(router: ExternalApiRouter): void {
        const previous = this.sessionRegistry;
        if (previous) {
            void previous.dispose();
        }
        const registry = new NukeMcpSessionRegistry<McpSession>((session) => this.closeSession(session));
        this.sessionRegistry = registry;
        router.toDispose.push(
            Disposable.create(() => {
                void registry.dispose();
                if (this.sessionRegistry === registry) {
                    this.sessionRegistry = undefined;
                }
            })
        );
        router.raw.use(express.json({ limit: '1mb' }));
        router.raw.all('/', (request, response) => {
            void this.handle(request, response, registry);
        });
    }

    /** Recent audit rows, newest first; read-only and never persisted. */
    getAuditEntries(limit = 20): readonly NukeMcpAuditEntry[] {
        return this.audit.recent(limit);
    }

    protected async handle(
        request: express.Request,
        response: express.Response,
        registry: NukeMcpSessionRegistry<McpSession>
    ): Promise<void> {
        try {
            await this.handleRequest(request, response, registry);
        } catch (error) {
            this.logger.error('[NukeAI] MCP request failed.', error);
            if (!response.headersSent) {
                response.status(500).json({ error: 'Internal MCP error.' });
            } else if (!response.writableEnded) {
                response.end();
            }
        }
    }

    protected async handleRequest(
        request: express.Request,
        response: express.Response,
        registry: NukeMcpSessionRegistry<McpSession>
    ): Promise<void> {
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
        if (!isLoopbackAddress(request.socket?.remoteAddress)) {
            this.writeError(response, 403, 'MCP only accepts loopback connections.');
            return;
        }
        if (!isAuthorizedBearer(request.headers.authorization, config.token)) {
            this.writeError(response, 401, 'Unauthorized.');
            return;
        }

        const sessionId = getSessionId(request);
        if (sessionId !== undefined) {
            const session = registry.get(sessionId);
            if (!session) {
                this.writeJsonRpcError(response, 404, -32001, 'Session not found', request.body);
                return;
            }
            if (this.rejectUnsafeToolCalls(request.body, session, sessionId, response)) {
                return;
            }
            await session.transport.handleRequest(request, response, request.body);
            return;
        }

        if (request.method !== 'POST' || !isInitializeRequest(request.body)) {
            this.writeJsonRpcError(response, 400, -32000, 'Bad Request: Mcp-Session-Id header is required', request.body);
            return;
        }
        if (registry.size + this.pendingSessions >= MAX_MCP_SESSIONS) {
            this.writeError(response, 503, 'Too many active MCP sessions. Try again later.');
            return;
        }

        this.pendingSessions += 1;
        let session: McpSession | undefined;
        try {
            session = await this.createSession(registry);
            await session.transport.handleRequest(request, response, request.body);
        } catch (error) {
            // An initialization request that fails before the session id is
            // registered would otherwise leak its server and transport until
            // the next routing rebuild.
            if (session && !session.transport.sessionId) {
                await this.closeSession(session);
            }
            throw error;
        } finally {
            this.pendingSessions -= 1;
        }
    }

    protected async createSession(registry: NukeMcpSessionRegistry<McpSession>): Promise<McpSession> {
        let initializedId: string | undefined;
        let session: McpSession | undefined;
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sessionId) => {
                initializedId = sessionId;
                if (!session || !registry.open(sessionId, session)) {
                    this.logger.warn('[NukeAI] MCP session rejected because the session limit was reached.');
                    void session?.server.close().catch(() => undefined);
                    void transport.close().catch(() => undefined);
                    return;
                }
                this.logger.info(`[NukeAI] MCP session opened (${registry.size} active).`);
            },
            onsessionclosed: (sessionId) => {
                registry.delete(sessionId);
                this.logger.info(`[NukeAI] MCP session closed (${registry.size} active).`);
            }
        });
        transport.onerror = () => this.logger.warn('[NukeAI] MCP transport error.');
        transport.onclose = () => {
            if (initializedId !== undefined) {
                registry.delete(initializedId);
            }
        };
        try {
            const created = await this.createServer(() => initializedId, registry);
            session = { server: created.server, transport, tools: created.tools };
            await created.server.connect(transport);
            return session;
        } catch (error) {
            if (session) {
                await this.closeSession(session);
            } else {
                await transport.close().catch(() => undefined);
            }
            throw error;
        }
    }

    protected async createServer(
        getSessionId: () => string | undefined,
        registry: NukeMcpSessionRegistry<McpSession>
    ): Promise<{ server: McpServer; tools: ReadonlyMap<string, NukeMcpCatalogTool> }> {
        const server = new McpServer(MCP_SERVER_INFO, {
            // Declare the capability up front so `tools/list` still answers with
            // an empty catalog when the frontend is unavailable.
            capabilities: { tools: {}, resources: {}, prompts: {} }
        });
        try {
            const catalog = await this.loadCatalog();
            const tools = new Map<string, NukeMcpCatalogTool>();
            for (const tool of catalog) {
                tools.set(tool.name, tool);
                server.registerTool(
                    tool.name,
                    {
                        title: tool.title,
                        description: tool.description,
                        inputSchema: tool.inputSchema,
                        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
                        annotations: tool.annotations
                    },
                    async (input) => this.invokeTool(tool, input, getSessionId(), registry)
                );
            }

            for (const resource of await this.loadResources()) {
                server.registerResource(
                    resource.name,
                    resource.uri,
                    {
                        title: resource.name,
                        description: resource.description,
                        mimeType: resource.mimeType
                    },
                    async (uri) => this.readResource(uri.toString(), resource.mimeType)
                );
            }

            const summaries: NukeMcpToolSummary[] = catalog.map((tool) => ({
                name: tool.name,
                capabilityId: tool.capabilityId,
                title: tool.title
            }));
            server.registerPrompt(
                NUKE_WORKFLOW_PROMPT_NAME,
                {
                    title: 'Nuke workflow',
                    description: 'Walk through the CAD to DAGMC to OpenMC to visualizer workflow using only the exposed read-only tools.'
                },
                () => promptResult(buildWorkflowPrompt(summaries))
            );
            server.registerPrompt(
                NUKE_DIAGNOSTICS_PROMPT_NAME,
                {
                    title: 'Nuke diagnostics',
                    description: 'Triage CAD, OpenMC, and statepoint findings with the exposed read-only diagnostics tools.'
                },
                () => promptResult(buildDiagnosticsPrompt(summaries))
            );
            return { server, tools };
        } catch (error) {
            await server.close().catch(() => undefined);
            throw error;
        }
    }

    /** Build the live catalog, or an empty one when the frontend is unavailable. */
    protected async loadCatalog(): Promise<readonly NukeMcpCatalogTool[]> {
        let descriptors: readonly NukeCapabilityDescriptor[] = [];
        try {
            const listed = await this.delegate.listCapabilities();
            if (!Array.isArray(listed)) {
                throw new Error('the capability delegate returned a malformed catalog.');
            }
            descriptors = listed;
        } catch (error) {
            this.logger.warn(
                `[NukeAI] MCP catalog unavailable: ${errorMessage(error)} Start the IDE frontend and reconnect the MCP client.`
            );
        }
        return buildReadOnlyToolCatalog(descriptors, this.logger).tools;
    }

    /** Build the resource list, falling back to `nuke://context` on any gap. */
    protected async loadResources(): Promise<readonly NukeMcpResourceDescriptor[]> {
        let listed: unknown;
        try {
            listed = await this.delegate.listResources();
        } catch (error) {
            this.logger.warn(
                `[NukeAI] MCP resource catalog unavailable: ${errorMessage(error)} Registering ${MCP_CONTEXT_RESOURCE_URI} only.`
            );
            return [CONTEXT_FALLBACK];
        }
        if (!Array.isArray(listed)) {
            this.logger.warn(`[NukeAI] MCP resource catalog was malformed. Registering ${MCP_CONTEXT_RESOURCE_URI} only.`);
            return [CONTEXT_FALLBACK];
        }
        const resources: NukeMcpResourceDescriptor[] = [];
        const seen = new Set<string>();
        for (const candidate of listed) {
            if (resources.length >= MCP_MAX_RESOURCES) {
                this.logger.debug?.(`[NukeAI] MCP resource catalog capped at ${MCP_MAX_RESOURCES}.`);
                break;
            }
            if (!isResourceDescriptor(candidate) || !isAllowedMcpResourceUri(candidate.uri) || seen.has(candidate.uri)) {
                continue;
            }
            seen.add(candidate.uri);
            resources.push({
                uri: candidate.uri,
                name: capText(candidate.name.trim() || candidate.uri, 120),
                description: capText(candidate.description.trim(), 400),
                mimeType: capText(candidate.mimeType.trim() || 'application/json', 100)
            });
        }
        if (!seen.has(MCP_CONTEXT_RESOURCE_URI)) {
            this.logger.warn(`[NukeAI] MCP resource catalog omitted ${MCP_CONTEXT_RESOURCE_URI}; registering it as a fallback.`);
            resources.unshift(CONTEXT_FALLBACK);
            if (resources.length > MCP_MAX_RESOURCES) {
                resources.length = MCP_MAX_RESOURCES;
            }
        }
        return resources;
    }

    /**
     * Repeat the capability boundary in the raw handler: every `tools/call` must
     * name a tool registered for this session and that tool must still be an
     * allowlisted read-only capability.
     */
    protected rejectUnsafeToolCalls(body: unknown, session: McpSession, sessionId: string, response: express.Response): boolean {
        for (const toolName of toolCallNames(body)) {
            if (toolName === undefined) {
                continue;
            }
            const tool = session.tools.get(toolName);
            if (!tool || !isAllowedMcpCapability(tool.capabilityId) || !isReadOnlyMcpCapability(tool.descriptor)) {
                const { inputHash } = summarizeMcpInput({ tool: toolName });
                this.recordAudit({
                    timestamp: Date.now(),
                    sessionId,
                    tool: capText(toolName, 128),
                    durationMs: 0,
                    ok: false,
                    inputHash,
                    inputSummary: '[rejected tool call]'
                });
                this.writeJsonRpcError(response, 403, -32601, 'Tool is not exposed by this read-only endpoint.', body);
                return true;
            }
        }
        return false;
    }

    protected async invokeTool(
        tool: NukeMcpCatalogTool,
        rawInput: unknown,
        rawSessionId: string | undefined,
        registry: NukeMcpSessionRegistry<McpSession>
    ): Promise<CallToolResult> {
        const sessionId = rawSessionId ?? 'uninitialized';
        const started = Date.now();
        const { inputHash, inputSummary } = summarizeMcpInput(rawInput);
        let summary = inputSummary;
        let ok = false;
        try {
            if (!isAllowedMcpCapability(tool.capabilityId) || !isReadOnlyMcpCapability(tool.descriptor)) {
                return toolError('Tool is not available on this read-only endpoint.');
            }
            const admission = registry.beginToolCall(sessionId);
            if (admission === 'unknown-session') {
                return toolError('Unknown MCP session. Reconnect the MCP client.');
            }
            if (admission === 'rate-limited') {
                summary = capText(`[rate limited] ${inputSummary}`, MCP_AUDIT_SUMMARY_LIMIT);
                return toolError(
                    `Rate limit exceeded: at most ${MCP_TOOL_RATE_LIMIT} tool calls per ${MCP_TOOL_RATE_WINDOW_MS / 1000} seconds per MCP session.`
                );
            }
            const parsed = parseToolInput(rawInput);
            if (!parsed.ok) {
                return toolError(parsed.message);
            }
            const result = await this.delegate.invoke(tool.capabilityId, parsed.value);
            if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
                throw new Error('The capability delegate returned an invalid result.');
            }
            ok = result.ok;
            return {
                structuredContent: boundedMcpValue(toStructuredContent(result)) as Record<string, unknown>,
                content: [{ type: 'text', text: stringifyMcpResult(result) }],
                isError: !result.ok
            };
        } catch (error) {
            return toolError(errorMessage(error));
        } finally {
            this.recordAudit({
                timestamp: started,
                sessionId,
                tool: tool.name,
                durationMs: Date.now() - started,
                ok,
                inputHash,
                inputSummary: summary
            });
            try {
                this.logger.info(
                    `[NukeAI] MCP tool=${tool.name} session=${sessionId} durationMs=${Date.now() - started} ok=${ok} inputHash=${inputHash}`
                );
            } catch {
                // Logging must never escape the tool handler.
            }
        }
    }

    protected recordAudit(entry: NukeMcpAuditEntry): void {
        try {
            this.audit.record(entry);
        } catch {
            // The audit ring must never break a tool call.
        }
    }

    protected async readResource(uri: string, mimeType: string): Promise<ReadResourceResult> {
        try {
            const text = await this.delegate.readResource(uri);
            if (typeof text !== 'string') {
                throw new Error('the resource delegate returned a non-text payload.');
            }
            return {
                contents: [{ uri, mimeType: mimeType || 'application/json', text: boundedMcpText(text) }]
            };
        } catch (error) {
            this.logger.warn(`[NukeAI] MCP resource read failed for ${uri}.`);
            throw new McpError(ErrorCode.InternalError, `Unable to read ${uri}: ${errorMessage(error)}`);
        }
    }

    protected async closeSession(session: McpSession): Promise<void> {
        await session.server.close().catch(() => undefined);
        await session.transport.close().catch(() => undefined);
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

/** Turn a capability result into the object shape required by `structuredContent`. */
function toStructuredContent(result: NukeCapabilityResult): Record<string, unknown> {
    if (result.data !== null && typeof result.data === 'object' && !Array.isArray(result.data)) {
        return result.data as Record<string, unknown>;
    }
    if (result.data !== undefined) {
        return { ok: result.ok, data: result.data };
    }
    return { ok: result.ok };
}

function toolError(message: string): CallToolResult {
    return {
        content: [{ type: 'text', text: message }],
        isError: true
    };
}

function parseToolInput(input: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
    if (input === undefined || input === null) {
        return { ok: true, value: {} };
    }
    if (typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, message: 'Tool arguments must be a JSON object.' };
    }
    return { ok: true, value: input };
}

function promptResult(text: string): { messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }> } {
    return {
        messages: [{ role: 'user', content: { type: 'text', text } }]
    };
}

function isResourceDescriptor(value: unknown): value is NukeMcpResourceDescriptor {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    const record = value as Partial<NukeMcpResourceDescriptor>;
    return (
        typeof record.uri === 'string' &&
        typeof record.name === 'string' &&
        typeof record.description === 'string' &&
        typeof record.mimeType === 'string'
    );
}

function capText(value: string, limit: number): string {
    if (value.length <= limit) {
        return value;
    }
    return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function toolCallNames(body: unknown): Array<string | undefined> {
    const messages = Array.isArray(body) ? body : [body];
    const names: Array<string | undefined> = [];
    for (const message of messages) {
        if (message === null || typeof message !== 'object' || (message as { method?: unknown }).method !== 'tools/call') {
            continue;
        }
        const params = (message as { params?: unknown }).params;
        const name = params !== null && typeof params === 'object' ? (params as { name?: unknown }).name : undefined;
        names.push(typeof name === 'string' ? name : undefined);
    }
    return names;
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
