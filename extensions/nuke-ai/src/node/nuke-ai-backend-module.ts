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
 * Nuke AI Backend Module
 *
 * Wires the skill-root service and the MCP capability delegate over JSON-RPC,
 * and registers the opt-in external MCP contribution on the external API
 * router. The capability tool bridge runs in the frontend because capabilities
 * invoke frontend services directly.
 *
 * @module nuke-ai/node
 */

import { ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionHandler } from '@theia/core/lib/common/messaging';
import { JsonRpcConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging/proxy-factory';
import { ExternalApiContribution } from '@theia/external-api/lib/node/external-api-contribution';
import { NukeCapabilityDelegate, NukeCapabilityDelegateClient, NukeCapabilityDelegatePath } from '../common/nuke-capability-delegate';
import { NukeAISkillService, NukeAISkillServicePath } from '../common/nuke-ai-protocol';
import { NukeAISkillServiceImpl } from './skills/nuke-skill-service';
import { NukeCapabilityDelegateImpl } from './mcp/nuke-capability-delegate';
import { NukeAIMcpConfigService } from './mcp/nuke-mcp-config-service';
import { NukeMcpContribution } from './mcp/nuke-mcp-contribution';

export default new ContainerModule((bind) => {
    bind(NukeAISkillServiceImpl).toSelf().inSingletonScope();
    bind(NukeAISkillService).toService(NukeAISkillServiceImpl);
    bind(ConnectionHandler)
        .toDynamicValue(
            (ctx) => new JsonRpcConnectionHandler(NukeAISkillServicePath, () => ctx.container.get<NukeAISkillService>(NukeAISkillService))
        )
        .inSingletonScope();

    bind(NukeAIMcpConfigService).toSelf().inSingletonScope();
    bind(NukeCapabilityDelegateImpl).toSelf().inSingletonScope();
    bind(NukeCapabilityDelegate).toService(NukeCapabilityDelegateImpl);
    bind(ConnectionHandler)
        .toDynamicValue(
            (ctx) =>
                new RpcConnectionHandler<NukeCapabilityDelegateClient>(NukeCapabilityDelegatePath, (client) => {
                    const delegate = ctx.container.get<NukeCapabilityDelegateImpl>(NukeCapabilityDelegateImpl);
                    delegate.setClient(client);
                    // This channel only registers the frontend delegate. The
                    // backend calls the injected singleton directly; exposing
                    // the delegate itself here would let any RPC client invoke
                    // write/execute capabilities without the chat confirmation.
                    return {};
                })
        )
        .inSingletonScope();

    bind(NukeMcpContribution).toSelf().inSingletonScope();
    bind(ExternalApiContribution).toService(NukeMcpContribution);
});
