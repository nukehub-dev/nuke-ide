// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { ContainerModule, interfaces } from '@theia/core/shared/inversify';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { 
    VisualizerBackendService, 
    VISUALIZER_BACKEND_PATH,
    VisualizerClient,
    OpenMCBackendService,
    OPENMC_BACKEND_PATH
} from '../common/visualizer-protocol';
import { VisualizerBackendServiceImpl } from './visualizer-backend-service';
import { OpenMCBackendServiceImpl } from './openmc-backend-service';

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
    
    // === OpenMC Integration ===
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
