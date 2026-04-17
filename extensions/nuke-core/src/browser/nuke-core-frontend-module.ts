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
 * Nuke Core Frontend Module
 * 
 * @module nuke-core/browser
 */

import { ContainerModule, interfaces } from '@theia/core/shared/inversify';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser';
import { MenuContribution } from '@theia/core/lib/common';
import {
    NukeCoreBackendService,
    NukeCoreBackendServiceInterface,
    NUKE_CORE_BACKEND_PATH
} from '../common/nuke-core-protocol';
import { NukeCoreService } from './nuke-core-service';
import { bindNukeCorePreferences } from './nuke-core-preferences';
import { NukeCoreMenuContribution } from './nuke-core-menus';

export default new ContainerModule((bind: interfaces.Bind) => {
    console.log('[NukeCore] Initializing frontend module...');

    // Menus
    bind(NukeCoreMenuContribution).toSelf().inSingletonScope();
    bind(MenuContribution).toService(NukeCoreMenuContribution);

    // Preferences (in main Settings panel, not Extensions)
    bindNukeCorePreferences(bind);

    // Backend service proxy
    bind<NukeCoreBackendServiceInterface>(NukeCoreBackendService).toDynamicValue(ctx => {
        const connectionProvider = ctx.container.get(WebSocketConnectionProvider);
        return connectionProvider.createProxy<NukeCoreBackendServiceInterface>(NUKE_CORE_BACKEND_PATH);
    }).inSingletonScope();

    // Frontend service
    bind(NukeCoreService).toSelf().inSingletonScope();

    console.log('[NukeCore] Frontend module initialized');
});

export { NukeCoreService };
export * from './nuke-core-menus';
