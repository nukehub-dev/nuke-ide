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
 * NukeAI Action Service
 *
 * Bridges NukeAI commands to the Theia chat. Every action opens or reuses a
 * focused panel session, pins the requested agent (falling back to NukeAI when
 * it is unavailable), and attaches `#nukeContext` to the request. Failures are
 * reported to the user and never escape to the command handler.
 *
 * @module nuke-ai/browser/actions
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { ILogger } from '@theia/core/lib/common/logger';
import { MessageService } from '@theia/core/lib/common/message-service';
import { ChatAgent, ChatAgentLocation, ChatService } from '@theia/ai-chat/lib/common';
import { ChatAgentService } from '@theia/ai-chat/lib/common/chat-agent-service';
import { NUKE_CHAT_AGENT_ID } from '../agent/nuke-chat-agent';
import { NUKE_CONTEXT_VARIABLE } from '../context/nuke-context-variable-contribution';

/** Public Theia command that adds a context variable to the active chat. */
export const ADD_CONTEXT_VARIABLE_COMMAND = 'add-context-variable';

/** Create focused NukeAI sessions and send contextual requests. */
@injectable()
export class NukeAiActionService {
    constructor(
        @inject(ChatService) protected readonly chatService: ChatService,
        @inject(ChatAgentService) protected readonly chatAgentService: ChatAgentService,
        @inject(MessageService) protected readonly messageService: MessageService,
        @inject(CommandRegistry) protected readonly commandRegistry: CommandRegistry,
        @inject(ILogger) protected readonly logger: ILogger
    ) {}

    /**
     * Open a focused panel session and send a read-only request with the active
     * Nuke context attached. `agentId` selects the chat agent; when it is not
     * available the request falls back to the default NukeAI agent.
     */
    async ask(prompt: string, displayText: string, agentId: string = NUKE_CHAT_AGENT_ID): Promise<void> {
        try {
            const agent = this.resolveAgent(agentId);
            const session = this.chatService.createSession(ChatAgentLocation.Panel, { focus: true }, agent);
            const invocation = await this.chatService.sendRequest(session.id, {
                text: prompt,
                displayText,
                variables: [{ variable: NUKE_CONTEXT_VARIABLE }]
            });
            if (!invocation) {
                this.messageService.warn('NukeAI could not start the chat request. Open the AI Chat view and try again.');
            }
        } catch (error) {
            this.logger.error('[NukeAI] Failed to run a contextual action.', error);
            this.messageService.error(`NukeAI could not run the action: ${errorMessage(error)}`);
        }
    }

    /**
     * Ensure a chat session exists and add `#nukeContext` to it through the
     * public Theia command. This keeps the chip behavior identical to the chat
     * toolbar without importing the chat UI implementation.
     */
    async attachContext(): Promise<void> {
        try {
            if (!this.chatService.getActiveSession()) {
                const agent = this.findNukeAgent();
                this.chatService.createSession(ChatAgentLocation.Panel, { focus: true }, agent);
            }
            await this.commandRegistry.executeCommand(ADD_CONTEXT_VARIABLE_COMMAND, NUKE_CONTEXT_VARIABLE.name, undefined);
        } catch (error) {
            this.logger.error('[NukeAI] Failed to attach the active context.', error);
            this.messageService.error(`NukeAI could not attach the active context: ${errorMessage(error)}`);
        }
    }

    /** Resolve the requested agent, falling back to NukeAI when it is absent. */
    protected resolveAgent(agentId: string): ChatAgent | undefined {
        const requested = this.chatAgentService.getAgent(agentId);
        if (requested || agentId === NUKE_CHAT_AGENT_ID) {
            return requested;
        }
        return this.findNukeAgent();
    }

    /** Resolve the NukeAI agent, or undefined when it is disabled or unavailable. */
    protected findNukeAgent(): ChatAgent | undefined {
        return this.chatAgentService.getAgent(NUKE_CHAT_AGENT_ID);
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
