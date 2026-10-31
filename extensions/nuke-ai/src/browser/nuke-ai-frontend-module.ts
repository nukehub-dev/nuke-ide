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
 * Wires the capability tool bridge, the NukeAI skill root, the
 * `#nukeContext` variable, the read-only resource service, and the opt-in
 * external MCP commands and delegate into the frontend application. The bridge
 * publishes enabled Nuke capabilities to Theia's tool registry so the AI chat
 * can invoke them directly, without an HTTP or MCP hop.
 *
 * @module nuke-ai/browser
 */

import { ContainerModule } from '@theia/core/shared/inversify';
import { CommandContribution } from '@theia/core/lib/common/command';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { AIVariableContribution } from '@theia/ai-core/lib/common/variable-service';
import { SkillDirectoryContribution } from '@theia/ai-core/lib/browser/skill-service';
import { NukeCapabilityToolBridge } from './capabilities/nuke-capability-tool-bridge';
import { NukePreviewStore } from './preview/nuke-preview-store';
import { NukeSkillDirectoryContribution } from './skills/nuke-skill-directory-contribution';
import { NukeContextVariableContribution } from './context/nuke-context-variable-contribution';
import { NukeResourceService } from './resources/nuke-resource-service';
import { NukeCapabilityDelegateClient } from '../common/nuke-capability-delegate';
import { NukeCapabilityDelegateClientImpl, NukeCapabilityDelegateConnectionContribution } from './mcp/nuke-capability-delegate-client';
import { NukeMcpCommandContribution } from './mcp/nuke-mcp-commands';
import { bindNukeMcpPreferences } from './mcp/nuke-mcp-preferences';

export default new ContainerModule((bind) => {
    bind(NukeCapabilityToolBridge).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(NukeCapabilityToolBridge);
    bind(NukePreviewStore).toSelf().inSingletonScope();

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

export { NukeCapabilityToolBridge } from './capabilities/nuke-capability-tool-bridge';
export { NukePreviewStore } from './preview/nuke-preview-store';
export { NukeSkillDirectoryContribution } from './skills/nuke-skill-directory-contribution';
export { NukeContextVariableContribution } from './context/nuke-context-variable-contribution';
export { NukeResourceService } from './resources/nuke-resource-service';
export { NukeCapabilityDelegateClientImpl } from './mcp/nuke-capability-delegate-client';
export { NukeMcpCommandContribution } from './mcp/nuke-mcp-commands';
export { NukeMcpPreferenceSchema } from './mcp/nuke-mcp-preferences';
