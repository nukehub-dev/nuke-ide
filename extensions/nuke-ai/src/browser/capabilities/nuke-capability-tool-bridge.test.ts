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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CancellationTokenSource } from '@theia/core/lib/common/cancellation';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { ILogger } from '@theia/core/lib/common/logger';
import { ToolCallContent, ToolCallContentResult, ToolRequest } from '@theia/ai-core/lib/common/language-model';
import { ToolInvocationRegistry } from '@theia/ai-core/lib/common/tool-invocation-registry';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityContextService,
    NukeCapabilityRegistry,
    NukeCapabilityResult,
    NukeJsonSchema
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { NukePreviewBundle, NukePreviewSession } from '../../common/nuke-preview-protocol';
import { NukePreviewStore } from '../preview/nuke-preview-store';
import { NukeAiMetricsService } from './nuke-ai-metrics-service';
import { NukeCapabilityToolBridge } from './nuke-capability-tool-bridge';
import { NukeEditJournal } from './nuke-edit-journal';
import { toToolName } from './nuke-tool-schema';

vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class FileService {} }));
vi.mock('@theia/workspace/lib/browser', () => ({ WorkspaceService: class WorkspaceService {} }));

class FakeCapabilityRegistry implements NukeCapabilityRegistry {
    capabilities: NukeCapability[] = [];
    protected readonly onDidChangeEmitter = new Emitter<void>();

    readonly onDidChange = this.onDidChangeEmitter.event;
    readonly ready = Promise.resolve();

    register(capability: NukeCapability): void {
        this.capabilities.push(capability);
    }

    get(id: string): NukeCapability | undefined {
        return this.capabilities.find((capability) => capability.id === id);
    }

    getAll(): readonly NukeCapability[] {
        return [...this.capabilities];
    }

    getEnabled(context: NukeCapabilityContext): readonly NukeCapability[] {
        return this.capabilities.filter((capability) => !capability.when || capability.when(context));
    }

    fireChange(): void {
        this.onDidChangeEmitter.fire();
    }
}

class FakeContextService implements NukeCapabilityContextService {
    context: NukeCapabilityContext = { workspaceRoots: ['/workspace'] };
    subscribed = false;
    observedContextReadBeforeSubscription = false;
    protected readonly onDidChangeContextEmitter = new Emitter<void>();

    get onDidChangeContext(): Event<void> {
        this.subscribed = true;
        return this.onDidChangeContextEmitter.event;
    }

    async getContext(): Promise<NukeCapabilityContext> {
        if (!this.subscribed) {
            this.observedContextReadBeforeSubscription = true;
        }
        return this.context;
    }

    fireChange(): void {
        this.onDidChangeContextEmitter.fire();
    }
}

class FakeToolRegistry implements ToolInvocationRegistry {
    readonly tools = new Map<string, ToolRequest>();
    readonly onDidChange = Event.None;

    registerTool(tool: ToolRequest): void {
        this.tools.set(tool.id, tool);
    }

    unregisterTool(toolId: string): void {
        this.tools.delete(toolId);
    }

    unregisterAllTools(providerName: string): void {
        for (const [id, tool] of [...this.tools.entries()]) {
            if (tool.providerName === providerName) {
                this.tools.delete(id);
            }
        }
    }

    getFunction(toolId: string): ToolRequest | undefined {
        return this.tools.get(toolId);
    }

    getFunctions(...toolIds: string[]): ToolRequest[] {
        return toolIds.map((id) => this.tools.get(id)).filter((tool): tool is ToolRequest => tool !== undefined);
    }

    getAllFunctions(): ToolRequest[] {
        return [...this.tools.values()];
    }
}

class FakePreviewStore {
    readonly createSession = vi.fn(async (): Promise<NukePreviewSession> => ({
        id: 'session-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        rootDir: '/workspace'
    }));

    readonly capture = vi.fn(
        async (
            _session: NukePreviewSession,
            _capabilityId: string,
            _input: unknown,
            _result: NukeCapabilityResult
        ): Promise<NukePreviewBundle> => ({
            id: 'bundle-001',
            sessionId: 'session-1',
            createdAt: '2026-01-01T00:00:00.000Z'
        })
    );
}

class FakeMetricsService {
    readonly record = vi.fn(async () => undefined);
}

class FakeEditJournal {
    readonly record = vi.fn(async () => undefined);
}

function createLogger(): ILogger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
    return {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn()
    } as unknown as ILogger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}

function capability(overrides: Partial<NukeCapability> = {}): NukeCapability {
    return {
        id: 'nuke.example.describe',
        title: 'Describe',
        description: 'Describe the current state.',
        category: ['Example'],
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path' }
            },
            required: ['path']
        },
        risk: 'read',
        invoke: async () => ({ ok: true }),
        ...overrides
    };
}

interface SetupOptions {
    capabilities?: NukeCapability[];
    context?: NukeCapabilityContext;
}

function setup(options: SetupOptions = {}): {
    registry: FakeCapabilityRegistry;
    contextService: FakeContextService;
    toolRegistry: FakeToolRegistry;
    logger: ILogger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
    previewStore: FakePreviewStore;
    metrics: FakeMetricsService;
    editJournal: FakeEditJournal;
    bridge: NukeCapabilityToolBridge;
} {
    const registry = new FakeCapabilityRegistry();
    registry.capabilities = options.capabilities ?? [];
    const contextService = new FakeContextService();
    if (options.context) {
        contextService.context = options.context;
    }
    const toolRegistry = new FakeToolRegistry();
    const logger = createLogger();
    const previewStore = new FakePreviewStore();
    const metrics = new FakeMetricsService();
    const editJournal = new FakeEditJournal();
    const bridge = new NukeCapabilityToolBridge(
        registry,
        contextService,
        toolRegistry,
        logger,
        previewStore as unknown as NukePreviewStore,
        {} as FileService,
        metrics as unknown as NukeAiMetricsService,
        editJournal as unknown as NukeEditJournal
    );
    return { registry, contextService, toolRegistry, logger, previewStore, metrics, editJournal, bridge };
}

function contentOf(result: unknown): ToolCallContentResult[] {
    expect(result).toBeDefined();
    return (result as ToolCallContent).content;
}

describe('NukeCapabilityToolBridge', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('subscribes to context changes before the first tool refresh', async () => {
        const { contextService, bridge } = setup({ capabilities: [] });

        await bridge.onStart();

        expect(contextService.observedContextReadBeforeSubscription).toBe(false);
    });

    it('registers one tool per enabled capability with sanitized id and name, parameters, and provider', async () => {
        const dagmc = capability({
            id: 'nuke.cad.exportDagmc',
            title: 'Export DAGMC',
            description: 'Export the active CAD document as DAGMC.',
            category: ['CAD', 'Export'],
            examples: [
                { description: 'Export a model', input: { path: '/tmp/model' } },
                { description: 'Export a second model', input: { path: '/tmp/other' } }
            ],
            risk: 'write'
        });
        const run = capability({
            id: 'nuke.openmc.run',
            inputSchema: { type: 'object', properties: { threads: { type: 'integer', minimum: 1 } } }
        });
        const { toolRegistry, bridge } = setup({ capabilities: [dagmc, run] });

        await bridge.onStart();

        expect([...toolRegistry.tools.keys()]).toEqual([toToolName(dagmc.id), toToolName(run.id)]);
        expect(toToolName(dagmc.id)).toBe('nuke_cad_exportDagmc');
        const tool = toolRegistry.tools.get(toToolName(dagmc.id)) as ToolRequest;
        expect(tool.id).toBe('nuke_cad_exportDagmc');
        expect(tool.name).toBe('nuke_cad_exportDagmc');
        expect(tool.providerName).toBe('nuke-ai');
        expect(tool.description).toContain('Export the active CAD document as DAGMC.');
        expect(tool.description).toContain('Example: Export a model');
        expect(tool.description).toContain('Example: Export a second model');
        expect(tool.parameters).toEqual({
            type: 'object',
            properties: { path: { type: 'string', description: 'File path' } },
            required: ['path']
        });
    });

    it('coalesces concurrent refresh requests into one running pass', async () => {
        const { toolRegistry, bridge } = setup({ capabilities: [capability({ id: 'nuke.example.coalesced' })] });

        const first = bridge.refresh();
        const second = bridge.refresh();

        expect(first).toBe(second);
        await Promise.all([first, second]);
        expect(toolRegistry.tools.has(toToolName('nuke.example.coalesced'))).toBe(true);
    });

    it('skips capabilities whose when predicate is false and logs the skipped ids', async () => {
        const enabled = capability({ id: 'nuke.example.enabled' });
        const disabled = capability({ id: 'nuke.example.disabled', when: () => false });
        const { toolRegistry, logger, bridge } = setup({ capabilities: [enabled, disabled] });

        await bridge.onStart();

        expect([...toolRegistry.tools.keys()]).toEqual([toToolName(enabled.id)]);
        const messages = logger.info.mock.calls.map((call) => String(call[0])).join('\n');
        expect(messages).toContain('Registered 1 capability tool(s)');
        expect(messages).toContain('nuke.example.disabled');
    });

    it('refreshes on context change and removes tools that become disabled', async () => {
        const documentCapability = capability({
            id: 'nuke.cad.describeDocument',
            when: (context) => Boolean(context.activeCadDocument)
        });
        const { contextService, toolRegistry, bridge } = setup({ capabilities: [documentCapability] });
        await bridge.onStart();

        expect(toolRegistry.tools.has(toToolName(documentCapability.id))).toBe(false);

        contextService.context = { workspaceRoots: ['/workspace'], activeCadDocument: '/workspace/model.nuke-cad' };
        contextService.fireChange();
        await vi.advanceTimersByTimeAsync(0);

        expect(toolRegistry.tools.has(toToolName(documentCapability.id))).toBe(true);

        contextService.context = { workspaceRoots: ['/workspace'] };
        contextService.fireChange();
        await vi.advanceTimersByTimeAsync(0);

        expect(toolRegistry.tools.has(toToolName(documentCapability.id))).toBe(false);
    });

    it('re-registers on registry change and removes stale tools', async () => {
        const first = capability({ id: 'nuke.example.first' });
        const second = capability({ id: 'nuke.example.second' });
        const { registry, toolRegistry, bridge } = setup({ capabilities: [first, second] });
        await bridge.onStart();

        expect([...toolRegistry.tools.keys()]).toEqual([toToolName(first.id), toToolName(second.id)]);

        registry.capabilities = [first];
        registry.fireChange();
        await vi.advanceTimersByTimeAsync(0);

        expect([...toolRegistry.tools.keys()]).toEqual([toToolName(first.id)]);

        const third = capability({ id: 'nuke.example.third' });
        registry.capabilities = [first, third];
        registry.fireChange();
        await vi.advanceTimersByTimeAsync(0);

        expect([...toolRegistry.tools.keys()]).toEqual([toToolName(first.id), toToolName(third.id)]);
    });

    it('maps risk to confirmAlwaysAllow', async () => {
        const { toolRegistry, bridge } = setup({
            capabilities: [
                capability({ id: 'nuke.example.readRisk', risk: 'read' }),
                capability({ id: 'nuke.example.writeRisk', risk: 'write' }),
                capability({ id: 'nuke.example.executeRisk', risk: 'execute' }),
                capability({ id: 'nuke.example.destructiveRisk', risk: 'destructive' })
            ]
        });

        await bridge.onStart();

        expect(toolRegistry.tools.get(toToolName('nuke.example.readRisk'))?.confirmAlwaysAllow).toBeUndefined();
        expect(toolRegistry.tools.get(toToolName('nuke.example.writeRisk'))?.confirmAlwaysAllow).toBe(true);
        expect(toolRegistry.tools.get(toToolName('nuke.example.executeRisk'))?.confirmAlwaysAllow).toBe(true);
        expect(toolRegistry.tools.get(toToolName('nuke.example.destructiveRisk'))?.confirmAlwaysAllow).toBe(
            'This tool can overwrite or delete data. Review every argument before allowing auto-approval.'
        );
    });

    it('builds short labels from the first recognized argument', async () => {
        const { toolRegistry, bridge } = setup({ capabilities: [capability({ id: 'nuke.example.labels' })] });
        await bridge.onStart();
        const tool = toolRegistry.tools.get(toToolName('nuke.example.labels')) as ToolRequest;

        expect(tool.getArgumentsShortLabel?.('{"query":"box"}')).toEqual({
            label: 'box',
            hasMore: false
        });
        expect(tool.getArgumentsShortLabel?.('{"query":"box","path":"/tmp/model"}')).toEqual({
            label: '/tmp/model',
            hasMore: true
        });
        expect(tool.getArgumentsShortLabel?.('{"path":"/tmp/model","count":2}')).toEqual({
            label: '/tmp/model',
            hasMore: true
        });
        expect(tool.getArgumentsShortLabel?.('not json')).toBeUndefined();
        expect(tool.getArgumentsShortLabel?.('{"unrelated":1}')).toBeUndefined();
    });

    it('invokes a capability with parsed input and the merged context', async () => {
        const invoke = vi.fn(async () => ({
            ok: true,
            message: 'Exported.',
            data: { path: '/tmp/model.h5m' },
            artifacts: [{ kind: 'file' as const, label: 'DAGMC', path: '/tmp/model.h5m' }]
        }));
        const { toolRegistry, bridge } = setup({ capabilities: [capability({ id: 'nuke.cad.exportDagmc', invoke })] });
        await bridge.onStart();
        const tool = toolRegistry.tools.get(toToolName('nuke.cad.exportDagmc')) as ToolRequest;

        const result = await tool.handler('{"path":"/tmp/model"}', { toolCallId: 'call-1' });

        expect(invoke).toHaveBeenCalledTimes(1);
        const [input, context] = invoke.mock.calls[0] as unknown as [unknown, { workspaceRoots: string[]; signal: AbortSignal }];
        expect(input).toEqual({ path: '/tmp/model' });
        expect(context.workspaceRoots).toEqual(['/workspace']);
        expect(context.signal).toBeInstanceOf(AbortSignal);
        expect(context.signal.aborted).toBe(false);
        const content = contentOf(result);
        expect(content[0]).toEqual({ type: 'text', text: 'Exported.' });
        expect(content[1]).toMatchObject({ type: 'text' });
        expect(content[2]).toEqual({ type: 'text', text: 'DAGMC: /tmp/model.h5m' });
    });

    it('records one metric per successful invocation with the capability version and risk', async () => {
        const { toolRegistry, metrics, bridge } = setup({
            capabilities: [capability({ id: 'nuke.example.metric', version: 4, risk: 'write' })]
        });
        await bridge.onStart();
        const tool = toolRegistry.tools.get(toToolName('nuke.example.metric')) as ToolRequest;

        await tool.handler('{"path":"/tmp/model"}');

        expect(metrics.record).toHaveBeenCalledTimes(1);
        expect(metrics.record).toHaveBeenCalledWith({
            capabilityId: 'nuke.example.metric',
            version: 4,
            risk: 'write',
            ok: true,
            durationMs: expect.any(Number)
        });
    });

    it('records an unsuccessful metric for a returned error and a thrown error', async () => {
        const failed = capability({ id: 'nuke.example.failed', invoke: async () => ({ ok: false, message: 'No.' }) });
        const thrown = capability({
            id: 'nuke.example.thrown',
            invoke: async () => {
                throw new Error('boom');
            }
        });
        const { toolRegistry, metrics, bridge } = setup({ capabilities: [failed, thrown] });
        await bridge.onStart();

        await (toolRegistry.tools.get(toToolName(failed.id)) as ToolRequest).handler('{"path":"/tmp/model"}');
        await (toolRegistry.tools.get(toToolName(thrown.id)) as ToolRequest).handler('{"path":"/tmp/model"}');

        expect(metrics.record).toHaveBeenCalledTimes(2);
        expect(metrics.record).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ capabilityId: failed.id, version: 1, ok: false, risk: 'read' })
        );
        expect(metrics.record).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ capabilityId: thrown.id, version: 1, ok: false, risk: 'read' })
        );
    });

    it('records an unsuccessful metric when the invocation is cancelled', async () => {
        const invoke = vi.fn(async (_input: unknown, context: NukeCapabilityContext) =>
            context.signal?.aborted ? { ok: false, message: 'Cancelled.' } : { ok: true, message: 'Finished.' }
        );
        const { toolRegistry, metrics, bridge } = setup({ capabilities: [capability({ id: 'nuke.example.cancelled', invoke })] });
        await bridge.onStart();
        const tool = toolRegistry.tools.get(toToolName('nuke.example.cancelled')) as ToolRequest;
        const source = new CancellationTokenSource();
        source.cancel();

        await tool.handler('{"path":"/tmp/model"}', { cancellationToken: source.token });

        expect(metrics.record).toHaveBeenCalledWith(expect.objectContaining({ capabilityId: 'nuke.example.cancelled', ok: false }));
        source.dispose();
    });

    it('journals results that carry a change set or undo token and skips plain results', async () => {
        const changeSet = {
            id: 'proposal-1',
            title: 'Run settings',
            summary: 'Increase batches.',
            changes: [{ path: 'run.batches', label: 'Batches', kind: 'update' as const, before: 100, after: 200 }]
        };
        const journaled = capability({
            id: 'nuke.example.journaled',
            invoke: async () => ({ ok: true, changeSet, undoToken: 'undo-1' })
        });
        const plain = capability({ id: 'nuke.example.plain', invoke: async () => ({ ok: true, message: 'Done.' }) });
        const { toolRegistry, editJournal, bridge } = setup({ capabilities: [journaled, plain] });
        await bridge.onStart();

        await (toolRegistry.tools.get(toToolName(journaled.id)) as ToolRequest).handler('{"path":"/tmp/model"}');
        await (toolRegistry.tools.get(toToolName(plain.id)) as ToolRequest).handler('{"path":"/tmp/model"}');

        expect(editJournal.record).toHaveBeenCalledTimes(1);
        expect(editJournal.record).toHaveBeenCalledWith(journaled.id, { ok: true, changeSet, undoToken: 'undo-1' });
    });

    it('still returns the tool result when metrics and journaling fail', async () => {
        const changeSet = {
            id: 'proposal-1',
            title: 'Run settings',
            summary: 'Increase batches.',
            changes: []
        };
        const invoke = vi.fn(async () => ({ ok: true, message: 'Applied.', changeSet }));
        const { toolRegistry, logger, metrics, editJournal, bridge } = setup({
            capabilities: [capability({ id: 'nuke.example.journalFailure', invoke })]
        });
        metrics.record.mockRejectedValueOnce(new Error('metrics failed'));
        editJournal.record.mockRejectedValueOnce(new Error('journal failed'));
        await bridge.onStart();
        const tool = toolRegistry.tools.get(toToolName('nuke.example.journalFailure')) as ToolRequest;

        const content = contentOf(await tool.handler('{"path":"/tmp/model"}'));

        expect(content[0]).toEqual({ type: 'text', text: 'Applied.' });
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to record metrics'), expect.any(Error));
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to journal the edit'), expect.any(Error));
    });

    it('does not create or capture a preview session when the result has nothing to preview', async () => {
        const invoke = vi.fn(async () => ({ ok: true, message: 'Done.', data: { path: '/tmp/model' } }));
        const { toolRegistry, previewStore, bridge } = setup({ capabilities: [capability({ id: 'nuke.example.noPreview', invoke })] });
        await bridge.onStart();
        const tool = toolRegistry.tools.get(toToolName('nuke.example.noPreview')) as ToolRequest;

        const content = contentOf(await tool.handler('{"path":"/tmp/model"}'));

        expect(content[0]).toEqual({ type: 'text', text: 'Done.' });
        expect(previewStore.createSession).not.toHaveBeenCalled();
        expect(previewStore.capture).not.toHaveBeenCalled();
    });

    it('creates one preview session and captures every preview result once', async () => {
        const base64 = 'iVBORw0KGgo=';
        const result = {
            ok: true,
            message: 'Captured.',
            preview: {
                kind: 'image' as const,
                data: `data:image/png;base64,${base64}`,
                mimeType: 'image/png',
                caption: 'Viewport',
                truthful: true
            }
        };
        const invoke = vi.fn(async () => result);
        const { toolRegistry, previewStore, bridge } = setup({ capabilities: [capability({ id: 'nuke.viz.captureView', invoke })] });
        await bridge.onStart();
        const tool = toolRegistry.tools.get(toToolName('nuke.viz.captureView')) as ToolRequest;

        const first = contentOf(await tool.handler('{"path":"/tmp/model"}', { toolCallId: 'call-1' }));
        const second = contentOf(await tool.handler('{"path":"/tmp/model"}', { toolCallId: 'call-2' }));

        expect(first).toContainEqual({ type: 'image', base64data: base64, mimeType: 'image/png' });
        expect(second).toContainEqual({ type: 'image', base64data: base64, mimeType: 'image/png' });
        expect(previewStore.createSession).toHaveBeenCalledTimes(1);
        expect(previewStore.capture).toHaveBeenCalledTimes(2);
        const [session, capabilityId, input, capturedResult] = previewStore.capture.mock.calls[0];
        expect(session).toMatchObject({ id: 'session-1' });
        expect(capabilityId).toBe('nuke.viz.captureView');
        expect(input).toEqual({ path: '/tmp/model' });
        expect(capturedResult).toBe(result);
    });

    it('still returns the tool result when preview capture fails', async () => {
        const invoke = vi.fn(async () => ({
            ok: true,
            message: 'Captured.',
            preview: { kind: 'markdown' as const, data: 'A preview.', caption: 'Caption', truthful: true }
        }));
        const { toolRegistry, logger, previewStore, bridge } = setup({
            capabilities: [capability({ id: 'nuke.viz.captureView', invoke })]
        });
        previewStore.capture.mockRejectedValueOnce(new Error('disk full'));
        await bridge.onStart();
        const tool = toolRegistry.tools.get(toToolName('nuke.viz.captureView')) as ToolRequest;

        const content = contentOf(await tool.handler('{"path":"/tmp/model"}'));

        expect(content[0]).toEqual({ type: 'text', text: 'Captured.' });
        expect(content).toContainEqual({ type: 'text', text: 'A preview.' });
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to capture preview'), expect.any(Error));
    });

    it('returns an error for invalid JSON arguments', async () => {
        const { toolRegistry, bridge } = setup({ capabilities: [capability({ id: 'nuke.example.invalidJson' })] });
        await bridge.onStart();
        const tool = toolRegistry.tools.get(toToolName('nuke.example.invalidJson')) as ToolRequest;

        const content = contentOf(await tool.handler('{not json'));

        expect(content[0].type).toBe('error');
        expect(content[0].type === 'error' ? content[0].data : '').toContain('Invalid JSON arguments:');
    });

    it('returns an error for input that fails schema validation', async () => {
        const { toolRegistry, bridge } = setup({ capabilities: [capability({ id: 'nuke.example.invalidInput' })] });
        await bridge.onStart();
        const tool = toolRegistry.tools.get(toToolName('nuke.example.invalidInput')) as ToolRequest;

        const content = contentOf(await tool.handler('{}'));

        expect(content[0].type).toBe('error');
        expect(content[0].type === 'error' ? content[0].data : '').toContain('missing required input "path"');
    });

    it('returns a bounded error and logs when a capability throws', async () => {
        const invoke = vi.fn(async () => {
            throw new Error('boom');
        });
        const { toolRegistry, logger, bridge } = setup({ capabilities: [capability({ id: 'nuke.example.throws', invoke })] });
        await bridge.onStart();
        const tool = toolRegistry.tools.get(toToolName('nuke.example.throws')) as ToolRequest;

        const content = contentOf(await tool.handler('{"path":"/tmp/model"}'));

        expect(content[0]).toEqual({ type: 'error', data: 'Capability failed: boom' });
        expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('aborts the capability signal when the invocation is cancelled', async () => {
        let signal: AbortSignal | undefined;
        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => (markStarted = resolve));
        const invoke = vi.fn(async (_input: unknown, context: NukeCapabilityContext) => {
            signal = context.signal;
            markStarted();
            await new Promise<void>((resolve) => {
                if (context.signal?.aborted) {
                    resolve();
                } else {
                    context.signal?.addEventListener('abort', () => resolve(), { once: true });
                }
            });
            return { ok: true, message: 'Cancelled.' };
        });
        const { toolRegistry, bridge } = setup({ capabilities: [capability({ id: 'nuke.example.cancel', invoke })] });
        await bridge.onStart();
        const tool = toolRegistry.tools.get(toToolName('nuke.example.cancel')) as ToolRequest;
        const source = new CancellationTokenSource();

        const resultPromise = tool.handler('{"path":"/tmp/model"}', { cancellationToken: source.token });
        await started;
        expect(signal?.aborted).toBe(false);

        source.cancel();
        const content = contentOf(await resultPromise);

        expect(signal?.aborted).toBe(true);
        expect(content[0]).toEqual({ type: 'text', text: 'Cancelled.' });
        source.dispose();
    });

    it('keeps registering other capabilities when one schema is invalid', async () => {
        const broken = capability({
            id: 'nuke.example.brokenSchema',
            inputSchema: { type: 'array', properties: {} } as unknown as NukeJsonSchema
        });
        const good = capability({ id: 'nuke.example.good' });
        const { toolRegistry, logger, bridge } = setup({ capabilities: [broken, good] });

        await bridge.onStart();

        expect([...toolRegistry.tools.keys()]).toEqual([toToolName(good.id)]);
        expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('unregisters every owned tool and ignores later events after stop', async () => {
        const { registry, toolRegistry, bridge } = setup({ capabilities: [capability({ id: 'nuke.example.stopped' })] });
        await bridge.onStart();
        expect(toolRegistry.tools.size).toBe(1);

        bridge.onStop();
        expect(toolRegistry.tools.size).toBe(0);

        registry.fireChange();
        await vi.advanceTimersByTimeAsync(0);
        expect(toolRegistry.tools.size).toBe(0);
    });
});
