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
 * Nuke AI Frontend Module
 *
 * Wires the dedicated NukeAI chat agent, the contextual action commands and
 * service, the Nuke Tools sidebar section, the capability tool bridge, the
 * NukeAI skill root, the `#nukeContext` variable, the read-only resource
 * service, and the opt-in external MCP commands and delegate into the frontend
 * application. The bridge publishes enabled Nuke capabilities to Theia's tool
 * registry so the AI chat can invoke them directly, without an HTTP or MCP hop.
 *
 * @module nuke-ai/browser
 */

import { ContainerModule } from '@theia/core/shared/inversify';
import { Agent } from '@theia/ai-core';
import { ChatAgent } from '@theia/ai-chat/lib/common/chat-agents';
import { CommandContribution } from '@theia/core/lib/common/command';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { ChatResponsePartRenderer } from '@theia/ai-chat-ui/lib/browser/chat-response-part-renderer';
import { AIVariableContribution } from '@theia/ai-core/lib/common/variable-service';
import { SkillDirectoryContribution } from '@theia/ai-core/lib/browser/skill-service';
import { NukeToolsContribution } from 'nuke-core/lib/common/nuke-tools-protocol';
import { NukeCapabilityToolBridge } from './capabilities/nuke-capability-tool-bridge';
import { NukeToolCallRenderer } from './capabilities/nuke-tool-call-renderer';
import { NukePreviewStore } from './preview/nuke-preview-store';
import { NukeSkillDirectoryContribution } from './skills/nuke-skill-directory-contribution';
import { NukeContextVariableContribution } from './context/nuke-context-variable-contribution';
import { NukeResourceService } from './resources/nuke-resource-service';
import { NukeCapabilityDelegateClient } from '../common/nuke-capability-delegate';
import { NukeCapabilityDelegateClientImpl, NukeCapabilityDelegateConnectionContribution } from './mcp/nuke-capability-delegate-client';
import { NukeMcpCommandContribution } from './mcp/nuke-mcp-commands';
import { bindNukeMcpPreferences } from './mcp/nuke-mcp-preferences';
import { NukeChatAgent } from './agent/nuke-chat-agent';
import { NukeAiActionService } from './actions/nuke-ai-action-service';
import { NukeAiCommandContribution } from './actions/nuke-ai-commands';
import { NukeAiToolsContribution } from './actions/nuke-ai-tools-contribution';
import './capabilities/nuke-tool-call.css';

export default new ContainerModule((bind) => {
    bind(NukeChatAgent).toSelf().inSingletonScope();
    bind(Agent).toService(NukeChatAgent);
    bind(ChatAgent).toService(NukeChatAgent);

    bind(NukeAiActionService).toSelf().inSingletonScope();

    bind(NukeAiCommandContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(NukeAiCommandContribution);

    bind(NukeAiToolsContribution).toSelf().inSingletonScope();
    bind(NukeToolsContribution).toService(NukeAiToolsContribution);

    bind(NukeCapabilityToolBridge).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(NukeCapabilityToolBridge);
    bind(NukePreviewStore).toSelf().inSingletonScope();

    bind(NukeToolCallRenderer).toSelf().inSingletonScope();
    bind(ChatResponsePartRenderer).toService(NukeToolCallRenderer);

    bind(NukeSkillDirectoryContribution).toSelf().inSingletonScope();
    bind(SkillDirectoryContribution).toService(NukeSkillDirectoryContribution);

    bind(NukeContextVariableContribution).toSelf().inSingletonScope();
    bind(AIVariableContribution).toService(NukeContextVariableContribution);

    bind(NukeResourceService).toSelf().inSingletonScope();

    bind(NukeCapabilityDelegateClient).to(NukeCapabilityDelegateClientImpl).inSingletonScope();
    bind(NukeCapabilityDelegateConnectionContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(NukeCapabilityDelegateConnectionContribution);

    bindNukeMcpPreferences(bind);

    bind(NukeMcpCommandContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(NukeMcpCommandContribution);
});

export { NukeChatAgent, NUKE_CHAT_AGENT_ID } from './agent/nuke-chat-agent';
export { NukeAiActionService } from './actions/nuke-ai-action-service';
export { NukeAiCommandContribution, NukeAiCommands } from './actions/nuke-ai-commands';
export { NukeAiToolsContribution } from './actions/nuke-ai-tools-contribution';
export { NukeCapabilityToolBridge } from './capabilities/nuke-capability-tool-bridge';
export { NukeToolCallRenderer } from './capabilities/nuke-tool-call-renderer';
export { NukePreviewStore } from './preview/nuke-preview-store';
export { NukeSkillDirectoryContribution } from './skills/nuke-skill-directory-contribution';
export { NukeContextVariableContribution } from './context/nuke-context-variable-contribution';
export { NukeResourceService } from './resources/nuke-resource-service';
export { NukeCapabilityDelegateClientImpl } from './mcp/nuke-capability-delegate-client';
export { NukeMcpCommandContribution } from './mcp/nuke-mcp-commands';
export { NukeMcpPreferenceSchema } from './mcp/nuke-mcp-preferences';
