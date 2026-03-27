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

/**
 * Nuke Core Backend Module
 * 
 * @module nuke-core/node
 */

import { ContainerModule, interfaces } from '@theia/core/shared/inversify';
import { ConnectionHandler, JsonRpcConnectionHandler } from '@theia/core/lib/common';
import {
    NukeCoreBackendService,
    NUKE_CORE_BACKEND_PATH,
    NukeCoreBackendServiceInterface
} from '../common/nuke-core-protocol';
import { NukeCoreBackendServiceImpl } from './nuke-core-backend-service';

export default new ContainerModule((bind: interfaces.Bind) => {
    console.log('[NukeCore] Initializing backend module...');

    bind(NukeCoreBackendServiceImpl).toSelf().inSingletonScope();
    bind<NukeCoreBackendServiceInterface>(NukeCoreBackendService).toService(NukeCoreBackendServiceImpl);

    bind<ConnectionHandler>(ConnectionHandler).toDynamicValue(({ container }) =>
        new JsonRpcConnectionHandler<NukeCoreBackendServiceInterface>(NUKE_CORE_BACKEND_PATH, () => {
            return container.get<NukeCoreBackendServiceInterface>(NukeCoreBackendService);
        })
    ).inSingletonScope();

    console.log('[NukeCore] Backend module initialized');
});

export { NukeCoreBackendServiceImpl };
