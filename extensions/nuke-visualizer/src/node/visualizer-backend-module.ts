// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
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

import { ContainerModule, interfaces } from '@theia/core/shared/inversify';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { 
    VisualizerBackendService, 
    VISUALIZER_BACKEND_PATH,
    VisualizerClient
} from '../common/base-visualizer-protocol';
import {
    OpenMCBackendService,
    OPENMC_BACKEND_PATH
} from '../common/openmc-protocol';
import { VisualizerBackendServiceImpl } from './visualizer-backend-service';
import { OpenMCBackendServiceImpl } from './plugins/openmc/openmc-backend-service';
import { PythonCommandHelper } from './services/python-command-helper';
import { OpenMCStatepointService, OpenMCGeometryService, OpenMCXSService, OpenMCDepletionService } from './plugins/openmc/services';

export default new ContainerModule((bind: interfaces.Bind, unbind: interfaces.Unbind, isBound: interfaces.IsBound, rebind: interfaces.Rebind) => {
    bind(VisualizerBackendServiceImpl).toSelf().inSingletonScope();
    bind(VisualizerBackendService).toService(VisualizerBackendServiceImpl);
    bind(BackendApplicationContribution).toService(VisualizerBackendServiceImpl);
    
    bind(ConnectionHandler).toDynamicValue(ctx =>
        new RpcConnectionHandler<VisualizerClient>(VISUALIZER_BACKEND_PATH, client => {
            const server = ctx.container.get<VisualizerBackendServiceImpl>(VisualizerBackendServiceImpl);
            server.setClient(client);
            return server;
        })
    ).inSingletonScope();
    
    // === Shared Backend Services ===
    bind(PythonCommandHelper).toSelf().inSingletonScope();
    
    // === OpenMC Integration ===
    bind(OpenMCStatepointService).toSelf().inSingletonScope();
    bind(OpenMCGeometryService).toSelf().inSingletonScope();
    bind(OpenMCXSService).toSelf().inSingletonScope();
    bind(OpenMCDepletionService).toSelf().inSingletonScope();
    bind(OpenMCBackendServiceImpl).toSelf().inSingletonScope();
    bind(OpenMCBackendService).toService(OpenMCBackendServiceImpl);
    
    bind(ConnectionHandler).toDynamicValue(ctx =>
        new RpcConnectionHandler<VisualizerClient>(OPENMC_BACKEND_PATH, client => {
            const server = ctx.container.get<OpenMCBackendServiceImpl>(OpenMCBackendServiceImpl);
            server.setClient(client);
            return server;
        })
    ).inSingletonScope();
});
