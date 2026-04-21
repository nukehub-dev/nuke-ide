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
 * Inversify {@link ContainerModule} that wires the Nuke Core backend services
 * and exposes them to the frontend through a JSON-RPC connection handler.
 *
 * DI bindings registered by this module:
 * | Symbol / Class                | Bound To                        | Scope     |
 * |-------------------------------|----------------------------------|-----------|
 * | {@link EnvironmentService}    | `toSelf()`                       | Singleton |
 * | {@link PackageService}        | `toSelf()`                       | Singleton |
 * | {@link HealthService}         | `toSelf()`                       | Singleton |
 * | {@link NukeCoreBackendServiceImpl} | `toSelf()`                  | Singleton |
 * | {@link NukeCoreBackendService} | `toService(NukeCoreBackendServiceImpl)` | Singleton |
 * | {@link ConnectionHandler}     | Dynamic {@link JsonRpcConnectionHandler} | Singleton |
 *
 * The JSON-RPC handler is mounted at {@link NUKE_CORE_BACKEND_PATH} so that
 * the frontend can call {@link NukeCoreBackendServiceInterface} methods.
 *
 * @module nuke-core/node
 * @see {@link NukeCoreBackendServiceImpl}
 * @see {@link NukeCoreBackendServiceInterface}
 */

import { ContainerModule, interfaces } from '@theia/core/shared/inversify';
import { ConnectionHandler, JsonRpcConnectionHandler } from '@theia/core/lib/common';
import {
    NukeCoreBackendService,
    NUKE_CORE_BACKEND_PATH,
    NukeCoreBackendServiceInterface
} from '../common/nuke-core-protocol';
import { NukeCoreBackendServiceImpl } from './nuke-core-backend-service';
import { EnvironmentService, PackageService, HealthService } from './services';

export default new ContainerModule((bind: interfaces.Bind) => {
    console.log('[NukeCore] Initializing backend module...');

    // Services
    bind(EnvironmentService).toSelf().inSingletonScope();
    bind(PackageService).toSelf().inSingletonScope();
    bind(HealthService).toSelf().inSingletonScope();

    // Main backend service
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
