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
 * Nuke Tool Call Renderer
 *
 * Bridges finished Nuke capability calls to the pure presentational card. The
 * renderer only claims completed calls that are not waiting for confirmation;
 * every other state falls through to Theia's default tool renderer so progress
 * and Allow/Deny controls keep working unchanged.
 *
 * @module nuke-ai/browser/capabilities
 */

import { ChatResponseContent, ToolCallChatResponseContent } from '@theia/ai-chat/lib/common';
import { ChatResponsePartRenderer } from '@theia/ai-chat-ui/lib/browser/chat-response-part-renderer';
import { ResponseNode } from '@theia/ai-chat-ui/lib/browser/chat-tree-view/chat-view-tree-widget';
import { OpenerService, open } from '@theia/core/lib/browser';
import { URI } from '@theia/core/lib/common/uri';
import { inject, injectable } from '@theia/core/shared/inversify';
import * as React from '@theia/core/shared/react';
import { NukeNextActionService } from './nuke-next-action-service';
import { NukeToolCard, canHandleNukeToolCall, readIssues, readStatus } from './nuke-tool-call-card';
import { NukeToolCallArtifact, summarizeNukeToolResult } from './nuke-tool-call-summary';

@injectable()
export class NukeToolCallRenderer implements ChatResponsePartRenderer<ToolCallChatResponseContent> {
    @inject(OpenerService)
    protected readonly openerService: OpenerService;

    @inject(NukeNextActionService)
    protected readonly nextActionService: NukeNextActionService;

    canHandle(response: ChatResponseContent): number {
        return canHandleNukeToolCall(response);
    }

    render(response: ToolCallChatResponseContent, _parentNode: ResponseNode): React.ReactNode {
        const summary = summarizeNukeToolResult(response.result);
        const issues = readIssues(summary.data);
        const status = readStatus(summary, issues);
        const details = { arguments: parseArguments(response.arguments), result: summary };

        return (
            <NukeToolCard
                toolName={response.name ?? ''}
                summary={summary}
                issues={issues}
                status={status}
                details={details}
                onOpenArtifact={this.openArtifact.bind(this)}
                canRunDirectly={(capabilityId) => this.nextActionService.canRunDirectly(capabilityId)}
                onRunAction={(action) => this.nextActionService.run(action.capability, response)}
                onAskAction={(action) => this.nextActionService.ask(action.capability, action.reason)}
            />
        );
    }

    protected async openArtifact(artifact: NukeToolCallArtifact): Promise<void> {
        try {
            const uri =
                artifact.path !== undefined
                    ? URI.fromFilePath(artifact.path)
                    : artifact.uri !== undefined
                      ? new URI(artifact.uri)
                      : undefined;
            if (!uri) {
                return;
            }
            await open(this.openerService, uri);
        } catch {
            // An opener may reject for a removed or unsupported artifact; the card stays usable.
        }
    }
}

function parseArguments(raw: string | undefined): unknown {
    if (!raw || raw.trim().length === 0) {
        return undefined;
    }
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}
