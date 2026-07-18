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
import { NukeCoreBackendService, NUKE_CORE_BACKEND_PATH, NukeCoreBackendServiceInterface } from '../common/nuke-core-protocol';
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

    bind<ConnectionHandler>(ConnectionHandler)
        .toDynamicValue(
            ({ container }) =>
                new JsonRpcConnectionHandler<NukeCoreBackendServiceInterface>(NUKE_CORE_BACKEND_PATH, () => {
                    return container.get<NukeCoreBackendServiceInterface>(NukeCoreBackendService);
                })
        )
        .inSingletonScope();

    console.log('[NukeCore] Backend module initialized');
});

export { NukeCoreBackendServiceImpl };
