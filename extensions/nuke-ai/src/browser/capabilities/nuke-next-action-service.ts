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
 * Nuke Next Action Service
 *
 * Executes follow-up capabilities suggested by a finished Nuke tool card.
 * Read-only capabilities run directly and replace the card result. Write,
 * execute, and destructive capabilities never run from the card: they open a
 * NukeAI chat prompt so the normal confirmation flow stays in charge. A
 * structured change set applies through the same chat path, and an applied
 * change is undone only after an explicit notification confirmation.
 *
 * @module nuke-ai/browser/capabilities
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { ILogger } from '@theia/core/lib/common/logger';
import { MessageService } from '@theia/core/lib/common/message-service';
import type { ToolCallChatResponseContent } from '@theia/ai-chat/lib/common';
import {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityContextService,
    NukeCapabilityRegistry,
    NukeChangeSet
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { validateCapabilityInput } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import { NukeUndoService } from 'nuke-core/lib/browser/capabilities/nuke-undo-service';
import { NukeAiActionService } from '../actions/nuke-ai-action-service';
import { NukeToolCallChangeSet } from './nuke-tool-call-summary';
import { toToolName } from './nuke-tool-schema';

/** Chat response surface needed to replace a finished card's result. */
export type NukeNextActionResponse = Pick<ToolCallChatResponseContent, 'updateResult'>;

/** Change-set shape accepted by the card, whether parsed or fresh from a capability. */
export type NukeApplyChangeSet = NukeChangeSet | NukeToolCallChangeSet;

const UNDO_ACTION = 'Undo';

/** Run read-only next actions in place and route state-changing actions to chat. */
@injectable()
export class NukeNextActionService {
    protected readonly running = new Set<string>();
    protected readonly undoing = new Set<string>();

    constructor(
        @inject(NukeCapabilityRegistry) protected readonly capabilityRegistry: NukeCapabilityRegistry,
        @inject(NukeCapabilityContextService) protected readonly contextService: NukeCapabilityContextService,
        @inject(NukeAiActionService) protected readonly actionService: NukeAiActionService,
        @inject(NukeUndoService) protected readonly undoService: NukeUndoService,
        @inject(MessageService) protected readonly messageService: MessageService,
        @inject(ILogger) protected readonly logger: ILogger
    ) {}

    /** True only for an existing capability that is read-only and needs no confirmation. */
    canRunDirectly(capabilityId: string): boolean {
        const capability = this.capabilityRegistry.get(capabilityId);
        return capability?.risk === 'read' && capability.requiresConfirmation !== true;
    }

    /**
     * Run a suggested follow-up. Only read-only capabilities are invoked from
     * the card; every state-changing risk asks NukeAI instead.
     */
    async run(capabilityId: string, response: NukeNextActionResponse): Promise<void> {
        if (this.running.has(capabilityId)) {
            return;
        }
        const capability = this.capabilityRegistry.get(capabilityId);
        if (!capability) {
            this.messageService.warn(`NukeAI could not find the next action "${capabilityId}".`);
            return;
        }
        this.running.add(capabilityId);
        try {
            if (capability.risk !== 'read' || capability.requiresConfirmation === true) {
                await this.ask(capabilityId, `Run the ${capability.title} step.`);
                return;
            }
            const context = await this.contextService.getContext();
            if (capability.when && !this.isAvailable(capability, context)) {
                this.messageService.warn(`${capability.title} is not available in the current context.`);
                return;
            }
            const inputErrors = validateCapabilityInput(capability, {});
            if (inputErrors.length > 0) {
                await this.ask(capabilityId, `Collect the missing inputs before running this step: ${inputErrors.join('; ')}.`);
                return;
            }
            const result = await capability.invoke({}, context);
            response.updateResult(result);
        } catch (error) {
            this.logger.error(`[NukeAI] Failed to run next action ${capabilityId}:`, error);
            this.messageService.error(`NukeAI could not run ${capability.title}: ${errorMessage(error)}`);
        } finally {
            this.running.delete(capabilityId);
        }
    }

    /**
     * Ask NukeAI to perform the next step through chat. The prompt keeps the
     * normal read/write split and never invokes the capability directly.
     */
    async ask(capabilityId: string, reason: string): Promise<void> {
        const capability = this.capabilityRegistry.get(capabilityId);
        try {
            await this.actionService.ask(this.buildPrompt(capabilityId, capability, reason), 'Run next action');
        } catch (error) {
            this.logger.error(`[NukeAI] Failed to ask about next action ${capabilityId}:`, error);
            this.messageService.error(`NukeAI could not start the next action: ${errorMessage(error)}`);
        }
    }

    /**
     * Route a structured change set to NukeAI. The card never applies a change
     * set directly: the apply capability must exist and be write or execute,
     * and the chat prompt keeps the normal confirmation flow in charge.
     */
    async applyChangeSet(changeSet: NukeApplyChangeSet): Promise<void> {
        const capabilityId = changeSet.applyCapability?.trim();
        if (!capabilityId) {
            this.messageService.warn('This change has no apply capability. Ask NukeAI to preview the settings change again.');
            return;
        }
        const capability = this.capabilityRegistry.get(capabilityId);
        if (!capability) {
            this.messageService.warn(`NukeAI could not find the apply capability "${capabilityId}" for this change.`);
            return;
        }
        if (capability.risk !== 'write' && capability.risk !== 'execute') {
            this.messageService.warn(`${capability.title} cannot apply this change from the card. Ask NukeAI to preview it again.`);
            return;
        }
        try {
            await this.actionService.ask(this.buildApplyPrompt(changeSet, capability), 'Apply settings changes');
        } catch (error) {
            this.logger.error(`[NukeAI] Failed to ask to apply change set ${changeSet.id}:`, error);
            this.messageService.error(`NukeAI could not start applying this change: ${errorMessage(error)}`);
        }
    }

    /**
     * Undo an applied change after an explicit confirmation. The card result is
     * replaced only when the undo handler reports success.
     */
    async undo(token: string, response: NukeNextActionResponse): Promise<void> {
        if (this.undoing.has(token)) {
            return;
        }
        this.undoing.add(token);
        try {
            const choice = await this.messageService.warn('Undo this change and restore the previous settings?', UNDO_ACTION);
            if (choice !== UNDO_ACTION) {
                return;
            }
            const result = await this.undoService.undo(token);
            if (result.ok) {
                response.updateResult(result);
                return;
            }
            this.messageService.error(result.message ?? 'The change could not be undone.');
        } catch (error) {
            this.logger.error(`[NukeAI] Failed to undo change ${token}:`, error);
            this.messageService.error(`NukeAI could not undo this change: ${errorMessage(error)}`);
        } finally {
            this.undoing.delete(token);
        }
    }

    protected isAvailable(capability: NukeCapability, context: NukeCapabilityContext): boolean {
        try {
            return capability.when ? capability.when(context) : true;
        } catch (error) {
            this.logger.error(`[NukeAI] Availability check failed for ${capability.id}:`, error);
            return false;
        }
    }

    protected buildApplyPrompt(changeSet: NukeApplyChangeSet, capability: NukeCapability): string {
        const toolName = toToolName(capability.id);
        const lines = [
            `Apply the NukeIDE change "${changeSet.title}" (proposal "${changeSet.id}") with the \`${toolName}\` tool.`,
            `Capability: ${capability.id}.`,
            `Summary: ${changeSet.summary}`
        ];
        if (changeSet.changes.length > 0) {
            lines.push(`Changed paths: ${changeSet.changes.map((change) => change.path).join(', ')}.`);
        }
        lines.push(
            'Preview the change first and show every before and after value.',
            'Apply only the exact paths from the proposal and never invent values.',
            'This is a write action: ask for confirmation before applying, then report whether the change can be undone.'
        );
        return lines.join('\n');
    }

    protected buildPrompt(capabilityId: string, capability: NukeCapability | undefined, reason: string): string {
        const title = capability?.title ?? (capabilityId.length > 0 ? capabilityId : 'Next step');
        const toolName = capabilityId.length > 0 ? toToolName(capabilityId) : undefined;
        const lines = [
            `Run the next NukeIDE step "${title}"${toolName ? ` with the \`${toolName}\` tool` : ''}.`,
            'Inspect the current state first through #nukeContext and never invent documents, projects, datasets, or run state.',
            'If required inputs are missing, ask for them instead of guessing.'
        ];
        const trimmedReason = reason.trim();
        if (trimmedReason.length > 0) {
            lines.push(`Reason: ${trimmedReason}`);
        }
        if (capability?.risk === 'read') {
            lines.push('This step is read-only: do not write files or change state.');
        } else {
            lines.push(
                'This step can change state: ask for confirmation before any write, execute, or destructive tool and explain what will change.'
            );
        }
        return lines.join('\n');
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
