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
 * Nuke Capability Tool Bridge
 *
 * Mirrors every enabled {@link NukeCapability} from nuke-core into Theia's
 * {@link ToolInvocationRegistry}. Registration is refreshed when capabilities
 * or ambient context change, so `when` predicates and context-dependent tool
 * lists stay current. Invocation happens in-process: capability handlers are
 * called directly and their results are rendered as bounded tool content.
 *
 * @module nuke-ai/browser/capabilities
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import type { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { Disposable, DisposableCollection } from '@theia/core/lib/common/disposable';
import { ILogger } from '@theia/core/lib/common/logger';
import { ToolInvocationContext, ToolRequest, ToolCallResult, createToolCallError } from '@theia/ai-core/lib/common/language-model';
import { ToolInvocationRegistry } from '@theia/ai-core/lib/common/tool-invocation-registry';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityContextService,
    NukeCapabilityRegistry,
    NukeCapabilityResult,
    NukeCapabilityRisk
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { validateCapabilityInput } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import { NukePreviewBundle, NukePreviewSession } from '../../common/nuke-preview-protocol';
import { NukePreviewStore } from '../preview/nuke-preview-store';
import { NukeAiMetricsService } from './nuke-ai-metrics-service';
import { NukeEditJournal } from './nuke-edit-journal';
import { toToolName, toToolParameters } from './nuke-tool-schema';
import { toToolCallContent } from './nuke-tool-result';

const PROVIDER_NAME = 'nuke-ai';
const MAX_DESCRIPTION_EXAMPLES = 3;
const SHORT_LABEL_KEYS = ['path', 'documentPath', 'projectPath', 'statepointPath', 'workingDirectory', 'query'] as const;
const DESTRUCTIVE_CONFIRMATION = 'This tool can overwrite or delete data. Review every argument before allowing auto-approval.';

/** Keep enabled capabilities registered as Theia AI tools. */
@injectable()
export class NukeCapabilityToolBridge implements FrontendApplicationContribution, Disposable {
    protected readonly toDispose = new DisposableCollection();
    protected refreshTimer: ReturnType<typeof setTimeout> | undefined;
    protected refreshPromise: Promise<void> | undefined;
    protected refreshQueued = false;
    protected started = false;
    protected stopped = false;
    protected previewSession: Promise<NukePreviewSession> | undefined;

    constructor(
        @inject(NukeCapabilityRegistry) protected readonly capabilityRegistry: NukeCapabilityRegistry,
        @inject(NukeCapabilityContextService) protected readonly contextService: NukeCapabilityContextService,
        @inject(ToolInvocationRegistry) protected readonly toolRegistry: ToolInvocationRegistry,
        @inject(ILogger) protected readonly logger: ILogger,
        @inject(NukePreviewStore) protected readonly previewStore: NukePreviewStore,
        @inject(FileService) protected readonly fileService: FileService,
        @inject(NukeAiMetricsService) protected readonly metrics: NukeAiMetricsService,
        @inject(NukeEditJournal) protected readonly editJournal: NukeEditJournal
    ) {}

    async onStart(): Promise<void> {
        if (this.started) {
            return;
        }
        this.started = true;
        this.stopped = false;
        // Subscribe before the first refresh: a document can open while the
        // registry becomes ready or the first tool pass runs, and that change
        // must not be lost between the initial context read and subscription.
        this.toDispose.push(this.capabilityRegistry.onDidChange(() => this.scheduleRefresh()));
        this.toDispose.push(this.contextService.onDidChangeContext(() => this.scheduleRefresh()));
        try {
            await this.capabilityRegistry.ready;
        } catch (error) {
            this.logger.error('[NukeAi] Capability registry did not become ready:', error);
        }
        await this.refresh();
    }

    onStop(): void {
        this.dispose();
    }

    /**
     * Rebuild the complete tool set for this provider. Concurrent callers share
     * the running pass and request one follow-up pass if state changed meanwhile.
     */
    refresh(): Promise<void> {
        if (this.refreshPromise) {
            this.refreshQueued = true;
            return this.refreshPromise;
        }
        const run = this.runRefreshLoop().finally(() => {
            this.refreshPromise = undefined;
        });
        this.refreshPromise = run;
        return run;
    }

    dispose(): void {
        this.stopped = true;
        if (this.refreshTimer !== undefined) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }
        this.toDispose.dispose();
        this.toolRegistry.unregisterAllTools(PROVIDER_NAME);
    }

    protected scheduleRefresh(): void {
        if (this.stopped || this.refreshTimer !== undefined) {
            return;
        }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            void this.refresh();
        }, 0);
    }

    protected async runRefreshLoop(): Promise<void> {
        try {
            do {
                this.refreshQueued = false;
                await this.performRefresh();
            } while (this.refreshQueued && !this.stopped);
        } catch (error) {
            this.logger.error('[NukeAi] Capability tool refresh failed:', error);
        }
    }

    protected async performRefresh(): Promise<void> {
        if (this.stopped) {
            return;
        }
        const context = await this.readContext();
        this.toolRegistry.unregisterAllTools(PROVIDER_NAME);
        if (this.stopped) {
            return;
        }
        let all: readonly NukeCapability[] = [];
        let enabled: readonly NukeCapability[] = [];
        try {
            all = this.capabilityRegistry.getAll();
            enabled = this.capabilityRegistry.getEnabled(context);
        } catch (error) {
            this.logger.error('[NukeAi] Failed to read capabilities for tool registration:', error);
            return;
        }
        const enabledIds = new Set(enabled.map((capability) => capability.id));
        const skipped = all.filter((capability) => !enabledIds.has(capability.id)).map((capability) => capability.id);
        let registered = 0;
        for (const capability of enabled) {
            if (this.stopped) {
                break;
            }
            try {
                this.registerCapability(capability);
                registered++;
            } catch (error) {
                this.logger.error(`[NukeAi] Failed to expose capability ${capability.id} as a tool:`, error);
            }
        }
        this.logger.info(
            `[NukeAi] Registered ${registered} capability tool(s); skipped ${skipped.length} by when(): ${skipped.join(', ') || 'none'}`
        );
    }

    protected async readContext(): Promise<NukeCapabilityContext> {
        try {
            return await this.contextService.getContext();
        } catch (error) {
            this.logger.error('[NukeAi] Failed to read capability context:', error);
            return { workspaceRoots: [] };
        }
    }

    protected registerCapability(capability: NukeCapability): void {
        // Theia keys tools by id and models call them by name, so both must use the sanitized tool name.
        const toolName = toToolName(capability.id);
        const tool: ToolRequest = {
            id: toolName,
            name: toolName,
            description: describeCapability(capability),
            parameters: toToolParameters(capability.inputSchema),
            providerName: PROVIDER_NAME,
            confirmAlwaysAllow: confirmationFor(capability.risk),
            getArgumentsShortLabel: (args) => shortLabel(args),
            handler: (argString, ctx) => this.invokeCapability(capability, argString, ctx)
        };
        this.toolRegistry.registerTool(tool);
    }

    protected async invokeCapability(capability: NukeCapability, argString: string, ctx?: ToolInvocationContext): Promise<ToolCallResult> {
        const startedAt = Date.now();
        let ok = false;
        try {
            let input: unknown;
            try {
                input = argString && argString.trim().length > 0 ? JSON.parse(argString) : {};
            } catch (error) {
                return createToolCallError(`Invalid JSON arguments: ${errorMessage(error)}`);
            }
            const inputErrors = validateCapabilityInput(capability, input);
            if (inputErrors.length > 0) {
                return createToolCallError(inputErrors.join('; '));
            }
            const baseContext = await this.readContext();
            const controller = new AbortController();
            const token = ctx?.cancellationToken;
            let cancellationListener: Disposable | undefined;
            if (token) {
                if (token.isCancellationRequested) {
                    controller.abort();
                } else {
                    cancellationListener = token.onCancellationRequested(() => controller.abort());
                }
            }
            try {
                let result: NukeCapabilityResult;
                try {
                    result = await capability.invoke(input, { ...baseContext, signal: controller.signal });
                } catch (error) {
                    this.logger.error(`[NukeAi] Capability ${capability.id} failed:`, error);
                    return createToolCallError(`Capability failed: ${errorMessage(error)}`);
                }
                ok = result.ok;
                const bundle = await this.capturePreview(capability, input, result);
                await this.recordEditJournal(capability, result);
                try {
                    return await toToolCallContent(
                        result,
                        this.fileService,
                        bundle?.previewPath ? { previewPath: bundle.previewPath } : undefined
                    );
                } catch (error) {
                    this.logger.error(`[NukeAi] Failed to render the result of ${capability.id}:`, error);
                    return createToolCallError(`Failed to render capability result: ${errorMessage(error)}`);
                }
            } finally {
                cancellationListener?.dispose();
            }
        } finally {
            await this.recordMetrics(capability, ok, Date.now() - startedAt);
        }
    }

    /** Record one invocation for the local journal; journaling never fails the tool call. */
    protected async recordMetrics(capability: NukeCapability, ok: boolean, durationMs: number): Promise<void> {
        try {
            await this.metrics.record({
                capabilityId: capability.id,
                version: capability.version ?? 1,
                risk: capability.risk,
                ok,
                durationMs
            });
        } catch (error) {
            this.logger.error(`[NukeAi] Failed to record metrics for ${capability.id}:`, error);
        }
    }

    /** Journal results that carry a change set or undo token; failures never fail the tool call. */
    protected async recordEditJournal(capability: NukeCapability, result: NukeCapabilityResult): Promise<void> {
        if (!result.changeSet && !result.undoToken) {
            return;
        }
        try {
            await this.editJournal.record(capability.id, result);
        } catch (error) {
            this.logger.error(`[NukeAi] Failed to journal the edit for ${capability.id}:`, error);
        }
    }

    /**
     * Persist a preview bundle only when the result carries something worth
     * recording. Capture failures are logged and never change the tool result.
     */
    protected async capturePreview(
        capability: NukeCapability,
        input: unknown,
        result: NukeCapabilityResult
    ): Promise<NukePreviewBundle | undefined> {
        if (!result.preview && (!result.artifacts || result.artifacts.length === 0)) {
            return undefined;
        }
        try {
            const session = await this.getPreviewSession();
            return await this.previewStore.capture(session, capability.id, input, result);
        } catch (error) {
            this.logger.error(`[NukeAi] Failed to capture preview for ${capability.id}:`, error);
            return undefined;
        }
    }

    protected getPreviewSession(): Promise<NukePreviewSession> {
        if (!this.previewSession) {
            this.previewSession = this.previewStore.createSession().catch((error) => {
                this.previewSession = undefined;
                throw error;
            });
        }
        return this.previewSession;
    }
}

function describeCapability(capability: NukeCapability): string {
    const examples = (capability.examples ?? [])
        .slice(0, MAX_DESCRIPTION_EXAMPLES)
        .filter((example) => example.description.trim().length > 0)
        .map((example) => `Example: ${example.description}`);
    return [capability.description, ...examples].join('\n');
}

function confirmationFor(risk: NukeCapabilityRisk): boolean | string | undefined {
    switch (risk) {
        case 'read':
            return undefined;
        case 'destructive':
            return DESTRUCTIVE_CONFIRMATION;
        case 'write':
        case 'execute':
        default:
            return true;
    }
}

function shortLabel(args: string): { label: string; hasMore: boolean } | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(args);
    } catch {
        return undefined;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record);
    for (const key of SHORT_LABEL_KEYS) {
        const value = record[key];
        if (value !== undefined) {
            return { label: String(value), hasMore: keys.length > 1 };
        }
    }
    return undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
