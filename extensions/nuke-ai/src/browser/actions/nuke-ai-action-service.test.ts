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

import { describe, expect, it, vi } from 'vitest';
import type { CommandRegistry } from '@theia/core/lib/common/command';
import type { ILogger } from '@theia/core/lib/common/logger';
import type { MessageService } from '@theia/core/lib/common/message-service';
import { ChatAgentLocation } from '@theia/ai-chat/lib/common';
import type { ChatAgent, ChatService, ChatSession } from '@theia/ai-chat/lib/common';
import type { ChatAgentService } from '@theia/ai-chat/lib/common/chat-agent-service';
import type {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityContextService,
    NukeCapabilityRegistry
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { NUKE_CHAT_AGENT_ID } from '../agent/nuke-chat-agent';
import { NUKE_DIAGNOSTICS_AGENT_ID } from '../agent/nuke-diagnostics-agent';
import { NUKE_CONTEXT_VARIABLE } from '../context/nuke-context-variable-contribution';
import { ADD_CONTEXT_VARIABLE_COMMAND, NukeAiActionService } from './nuke-ai-action-service';

const agent = { id: NUKE_CHAT_AGENT_ID } as ChatAgent;
const diagnosticsAgent = { id: NUKE_DIAGNOSTICS_AGENT_ID } as ChatAgent;
const session = { id: 'session-1' } as ChatSession;

interface HarnessOptions {
    agentAvailable?: boolean;
    diagnosticsAgentAvailable?: boolean;
    activeSession?: ChatSession;
    undefinedRequest?: boolean;
    createError?: Error;
    sendError?: Error;
    commandError?: Error;
    context?: NukeCapabilityContext;
    capabilities?: readonly NukeCapability[];
}

function createHarness(options: HarnessOptions = {}): {
    service: NukeAiActionService;
    createSession: ReturnType<typeof vi.fn>;
    sendRequest: ReturnType<typeof vi.fn>;
    getActiveSession: ReturnType<typeof vi.fn>;
    getAgent: ReturnType<typeof vi.fn>;
    executeCommand: ReturnType<typeof vi.fn>;
    getContext: ReturnType<typeof vi.fn>;
    getEnabled: ReturnType<typeof vi.fn>;
    getCapability: ReturnType<typeof vi.fn>;
    messageService: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
    logger: { error: ReturnType<typeof vi.fn> };
} {
    let activeSession = options.activeSession;
    const createSession = vi.fn(() => {
        if (options.createError) {
            throw options.createError;
        }
        activeSession = session;
        return session;
    });
    const sendRequest = vi.fn(async () => {
        if (options.sendError) {
            throw options.sendError;
        }
        return options.undefinedRequest ? undefined : {};
    });
    const getActiveSession = vi.fn(() => activeSession);
    const getAgent = vi.fn((id: string) => {
        if (id === NUKE_DIAGNOSTICS_AGENT_ID) {
            return options.diagnosticsAgentAvailable === false ? undefined : diagnosticsAgent;
        }
        return options.agentAvailable === false ? undefined : agent;
    });
    const executeCommand = vi.fn(async () => {
        if (options.commandError) {
            throw options.commandError;
        }
        return undefined;
    });
    const messageService = { warn: vi.fn(), error: vi.fn() };
    const logger = { error: vi.fn() };
    const capabilities = options.capabilities ?? [];
    const getContext = vi.fn(async () => options.context ?? { workspaceRoots: ['/workspace'] });
    const getEnabled = vi.fn((context: NukeCapabilityContext) =>
        capabilities.filter((capability) => !capability.when || capability.when(context))
    );
    const getCapability = vi.fn((id: string) => capabilities.find((capability) => capability.id === id));
    const service = new NukeAiActionService(
        { createSession, sendRequest, getActiveSession } as unknown as ChatService,
        { getAgent } as unknown as ChatAgentService,
        messageService as unknown as MessageService,
        { getContext } as unknown as NukeCapabilityContextService,
        { getEnabled, get: getCapability } as unknown as NukeCapabilityRegistry,
        { executeCommand } as unknown as CommandRegistry,
        logger as unknown as ILogger
    );
    return {
        service,
        createSession,
        sendRequest,
        getActiveSession,
        getAgent,
        executeCommand,
        getContext,
        getEnabled,
        getCapability,
        messageService,
        logger
    };
}

describe('NukeAiActionService', () => {
    it('creates a focused panel session pinned to the NukeAI agent and sends the prompt with nukeContext', async () => {
        const harness = createHarness();

        await harness.service.ask('Summarize the active model.', 'Ask About Active Context');

        expect(harness.getAgent).toHaveBeenCalledWith(NUKE_CHAT_AGENT_ID);
        expect(harness.createSession).toHaveBeenCalledWith(ChatAgentLocation.Panel, { focus: true }, agent);
        expect(harness.sendRequest).toHaveBeenCalledWith('session-1', {
            text: 'Summarize the active model.',
            displayText: 'Ask About Active Context',
            variables: [{ variable: NUKE_CONTEXT_VARIABLE }]
        });
        expect(harness.messageService.warn).not.toHaveBeenCalled();
        expect(harness.messageService.error).not.toHaveBeenCalled();
    });

    it('pins the requested diagnostics agent when it is available', async () => {
        const harness = createHarness();

        await harness.service.ask('Diagnose the active model.', 'Diagnose Active CAD Model', NUKE_DIAGNOSTICS_AGENT_ID);

        expect(harness.getAgent).toHaveBeenCalledWith(NUKE_DIAGNOSTICS_AGENT_ID);
        expect(harness.createSession).toHaveBeenCalledWith(ChatAgentLocation.Panel, { focus: true }, diagnosticsAgent);
        expect(harness.sendRequest).toHaveBeenCalledWith('session-1', {
            text: 'Diagnose the active model.',
            displayText: 'Diagnose Active CAD Model',
            variables: [{ variable: NUKE_CONTEXT_VARIABLE }]
        });
    });

    it('falls back to the NukeAI agent when the requested agent is unavailable', async () => {
        const harness = createHarness({ diagnosticsAgentAvailable: false });

        await harness.service.ask('Diagnose the active model.', 'Diagnose Active CAD Model', NUKE_DIAGNOSTICS_AGENT_ID);

        expect(harness.getAgent).toHaveBeenCalledWith(NUKE_DIAGNOSTICS_AGENT_ID);
        expect(harness.getAgent).toHaveBeenCalledWith(NUKE_CHAT_AGENT_ID);
        expect(harness.createSession).toHaveBeenCalledWith(ChatAgentLocation.Panel, { focus: true }, agent);
    });

    it('creates an unpinned session when the requested and fallback agents are unavailable', async () => {
        const harness = createHarness({ diagnosticsAgentAvailable: false, agentAvailable: false });

        await harness.service.ask('Diagnose the active model.', 'Diagnose Active CAD Model', NUKE_DIAGNOSTICS_AGENT_ID);

        expect(harness.createSession).toHaveBeenCalledWith(ChatAgentLocation.Panel, { focus: true }, undefined);
        expect(harness.sendRequest).toHaveBeenCalledTimes(1);
    });

    it('creates an unpinned focused session when the NukeAI agent is unavailable', async () => {
        const harness = createHarness({ agentAvailable: false });

        await harness.service.ask('Summarize the active model.', 'Ask About Active Context');

        expect(harness.createSession).toHaveBeenCalledWith('panel', { focus: true }, undefined);
        expect(harness.sendRequest).toHaveBeenCalledTimes(1);
    });

    it('warns without starting a chat when the required context is missing', async () => {
        const harness = createHarness();

        await harness.service.ask('Diagnose the statepoint.', 'Diagnose Active Statepoint', undefined, {
            kind: 'context',
            field: 'activeDataset',
            message: 'Open a statepoint in the Visualizer first.'
        });

        expect(harness.messageService.warn).toHaveBeenCalledWith('Open a statepoint in the Visualizer first.');
        expect(harness.createSession).not.toHaveBeenCalled();
        expect(harness.sendRequest).not.toHaveBeenCalled();
    });

    it('warns without starting a chat when no DAGMC viewer is open', async () => {
        const harness = createHarness({ context: { workspaceRoots: ['/workspace'], hasDagmcViewer: false } });

        await harness.service.ask('Capture the DAGMC view.', 'Capture DAGMC View', undefined, {
            kind: 'context',
            field: 'hasDagmcViewer',
            message: 'Open a DAGMC model in the Visualizer first.'
        });

        expect(harness.messageService.warn).toHaveBeenCalledWith('Open a DAGMC model in the Visualizer first.');
        expect(harness.createSession).not.toHaveBeenCalled();
        expect(harness.sendRequest).not.toHaveBeenCalled();
    });

    it('starts the chat when the required context is present', async () => {
        const harness = createHarness({ context: { workspaceRoots: ['/workspace'], activeDataset: '/workspace/statepoint.100.h5' } });

        await harness.service.ask('Diagnose the statepoint.', 'Diagnose Active Statepoint', undefined, {
            kind: 'context',
            field: 'activeDataset',
            message: 'Open a statepoint in the Visualizer first.'
        });

        expect(harness.messageService.warn).not.toHaveBeenCalled();
        expect(harness.createSession).toHaveBeenCalledTimes(1);
        expect(harness.sendRequest).toHaveBeenCalledTimes(1);
    });

    it('warns without starting a chat when a capability reports no active run', async () => {
        const getRunStatus = {
            id: 'nuke.openmc.getRunStatus',
            title: 'Get run status',
            description: 'Read the active run.',
            category: ['OpenMC'],
            inputSchema: { type: 'object', properties: {} },
            risk: 'read',
            invoke: vi.fn(async () => ({ ok: true, data: { running: false } }))
        } as unknown as NukeCapability;
        const harness = createHarness({ capabilities: [getRunStatus] });

        await harness.service.ask('Diagnose the run.', 'Diagnose OpenMC Run', undefined, {
            kind: 'capability',
            capability: 'nuke.openmc.getRunStatus',
            message: 'Start or open an OpenMC run first.',
            isReady: (result) => Boolean((result.data as { running?: unknown } | undefined)?.running)
        });

        expect(harness.messageService.warn).toHaveBeenCalledWith('Start or open an OpenMC run first.');
        expect(harness.createSession).not.toHaveBeenCalled();
        expect(harness.sendRequest).not.toHaveBeenCalled();
    });

    it('starts the run chat when the capability reports an active run', async () => {
        const getRunStatus = {
            id: 'nuke.openmc.getRunStatus',
            title: 'Get run status',
            description: 'Read the active run.',
            category: ['OpenMC'],
            inputSchema: { type: 'object', properties: {} },
            risk: 'read',
            invoke: vi.fn(async () => ({ ok: true, data: { running: true } }))
        } as unknown as NukeCapability;
        const harness = createHarness({ capabilities: [getRunStatus] });

        await harness.service.ask('Diagnose the run.', 'Diagnose OpenMC Run', undefined, {
            kind: 'capability',
            capability: 'nuke.openmc.getRunStatus',
            message: 'Start or open an OpenMC run first.',
            isReady: (result) => Boolean((result.data as { running?: unknown } | undefined)?.running)
        });

        expect(harness.messageService.warn).not.toHaveBeenCalled();
        expect(harness.createSession).toHaveBeenCalledTimes(1);
        expect(harness.sendRequest).toHaveBeenCalledTimes(1);
    });

    it('warns when the request cannot be started', async () => {
        const harness = createHarness({ undefinedRequest: true });

        await harness.service.ask('Summarize the active model.', 'Ask About Active Context');

        expect(harness.messageService.warn).toHaveBeenCalledWith(expect.stringContaining('could not start the chat request'));
        expect(harness.messageService.error).not.toHaveBeenCalled();
    });

    it('catches session creation failures and reports them', async () => {
        const harness = createHarness({ createError: new Error('chat unavailable') });

        await expect(harness.service.ask('Summarize the active model.', 'Ask About Active Context')).resolves.toBeUndefined();

        expect(harness.logger.error).toHaveBeenCalledWith(expect.stringContaining('contextual action'), expect.any(Error));
        expect(harness.messageService.error).toHaveBeenCalledWith(expect.stringContaining('chat unavailable'));
        expect(harness.sendRequest).not.toHaveBeenCalled();
    });

    it('catches request failures and reports them', async () => {
        const harness = createHarness({ sendError: new Error('request failed') });

        await expect(harness.service.ask('Summarize the active model.', 'Ask About Active Context')).resolves.toBeUndefined();

        expect(harness.messageService.error).toHaveBeenCalledWith(expect.stringContaining('request failed'));
    });

    it('creates a focused NukeAI session before attaching context when none is active', async () => {
        const harness = createHarness();

        await harness.service.attachContext();

        expect(harness.createSession).toHaveBeenCalledWith('panel', { focus: true }, agent);
        expect(harness.executeCommand).toHaveBeenCalledWith(ADD_CONTEXT_VARIABLE_COMMAND, 'nukeContext', undefined);
        expect(harness.messageService.error).not.toHaveBeenCalled();
    });

    it('reuses the active session and attaches context through the public command', async () => {
        const harness = createHarness({ activeSession: session });

        await harness.service.attachContext();

        expect(harness.getActiveSession).toHaveBeenCalled();
        expect(harness.createSession).not.toHaveBeenCalled();
        expect(harness.executeCommand).toHaveBeenCalledWith(ADD_CONTEXT_VARIABLE_COMMAND, 'nukeContext', undefined);
    });

    it('reports a context attachment failure instead of failing silently', async () => {
        const harness = createHarness({ commandError: new Error('variable unavailable') });

        await expect(harness.service.attachContext()).resolves.toBeUndefined();

        expect(harness.logger.error).toHaveBeenCalledWith(expect.stringContaining('active context'), expect.any(Error));
        expect(harness.messageService.error).toHaveBeenCalledWith(expect.stringContaining('variable unavailable'));
    });
});
