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
 * Nuke Core Frontend Module
 *
 * Theia {@link @theia/core/shared/inversify#ContainerModule | ContainerModule} that wires up all
 * Nuke Core frontend contributions, services, preferences, and menu bindings.
 *
 * DI bindings registered by this module:
 * - {@link NukeCoreMenuContribution} → {@link @theia/core/lib/common#MenuContribution}
 * - {@link NukeHealthCommandContribution}, {@link NukeEnvironmentCommandContribution},
 *   {@link NukePackageCommandContribution} → {@link @theia/core/lib/common#CommandContribution}
 * - {@link NukeCoreStatusBarContribution}, {@link WorkspaceEnvContribution} →
 *   {@link @theia/core/lib/browser#FrontendApplicationContribution}
 * - {@link NukePreferenceLayoutProvider} → rebinding of {@link @theia/preferences/lib/browser/util/preference-layout#PreferenceLayoutProvider}
 * - {@link NukeCoreBackendServiceInterface} proxy via {@link @theia/core/lib/browser#WebSocketConnectionProvider}
 * - {@link NukeCoreService}, {@link EnvironmentActionsHelper}, {@link NukeCoreVisibilityService}
 *   as local singletons
 *
 * @module nuke-core/browser
 * @see {@link ./nuke-core-menus | Nuke Core Menus}
 * @see {@link ./nuke-core-preferences | Nuke Core Preferences}
 * @see {@link ./nuke-core-preference-layout | Nuke Preference Layout}
 */

import { ContainerModule, interfaces } from '@theia/core/shared/inversify';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser';
import { MenuContribution, CommandContribution } from '@theia/core/lib/common';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { PreferenceLayoutProvider } from '@theia/preferences/lib/browser/util/preference-layout';
import {
    NukeCoreBackendService,
    NukeCoreBackendServiceInterface,
    NukeCoreStatusBarVisibility,
    NUKE_CORE_BACKEND_PATH
} from '../common/nuke-core-protocol';
import { EnvironmentActionsHelper, NukeCoreService, NukeCoreVisibilityService } from './services';
import { bindNukeCorePreferences } from './nuke-core-preferences';
import { NukeCoreMenuContribution } from './nuke-core-menus';
import { NukePreferenceLayoutProvider } from './nuke-core-preference-layout';
import { NukeCoreStatusBarContribution, WorkspaceEnvContribution } from './contributions';
import { NukeHealthCommandContribution, NukeEnvironmentCommandContribution, NukePackageCommandContribution } from './commands';

export default new ContainerModule(
    (bind: interfaces.Bind, unbind: interfaces.Unbind, isBound: interfaces.IsBound, rebind: interfaces.Rebind) => {
        console.log('[NukeCore] Initializing frontend module...');

        // Menus
        bind(NukeCoreMenuContribution).toSelf().inSingletonScope();
        bind(MenuContribution).toService(NukeCoreMenuContribution);

        // Commands
        bind(NukeHealthCommandContribution).toSelf().inSingletonScope();
        bind(CommandContribution).toService(NukeHealthCommandContribution);
        bind(NukeEnvironmentCommandContribution).toSelf().inSingletonScope();
        bind(CommandContribution).toService(NukeEnvironmentCommandContribution);
        bind(NukePackageCommandContribution).toSelf().inSingletonScope();
        bind(CommandContribution).toService(NukePackageCommandContribution);

        // Status Bar
        bind(NukeCoreStatusBarContribution).toSelf().inSingletonScope();
        bind(FrontendApplicationContribution).toService(NukeCoreStatusBarContribution);

        // Workspace env file auto-detection
        bind(WorkspaceEnvContribution).toSelf().inSingletonScope();
        bind(FrontendApplicationContribution).toService(WorkspaceEnvContribution);

        // Override preference layout to add "Nuke Utils" category
        bind(NukePreferenceLayoutProvider).toSelf().inSingletonScope();
        rebind(PreferenceLayoutProvider).toService(NukePreferenceLayoutProvider);

        // Preferences
        bindNukeCorePreferences(bind);

        // Backend service proxy
        bind<NukeCoreBackendServiceInterface>(NukeCoreBackendService)
            .toDynamicValue((ctx) => {
                const connectionProvider = ctx.container.get(WebSocketConnectionProvider);
                return connectionProvider.createProxy<NukeCoreBackendServiceInterface>(NUKE_CORE_BACKEND_PATH);
            })
            .inSingletonScope();

        // Frontend service
        bind(NukeCoreService).toSelf().inSingletonScope();

        // Environment actions helper (shared between status bar and commands)
        bind(EnvironmentActionsHelper).toSelf().inSingletonScope();

        // Status bar visibility service (for dependent extensions)
        bind(NukeCoreVisibilityService).toSelf().inSingletonScope();
        bind(NukeCoreStatusBarVisibility).toService(NukeCoreVisibilityService);

        console.log('[NukeCore] Frontend module initialized');
    }
);

/** Re-export of the core frontend service for convenience. @see {@link ./services/nuke-core-service | NukeCoreService} */
export { NukeCoreService } from './services';
/** Re-export of menu contributions. @see {@link ./nuke-core-menus | NukeCoreMenuContribution} */
export * from './nuke-core-menus';
/** Re-export of the preference binding helper. @see {@link ./nuke-core-preferences | bindNukeCorePreferences} */
export { bindNukeCorePreferences } from './nuke-core-preferences';
/** Re-export of the status bar contribution. @see {@link ./contributions/status-bar-contribution | NukeCoreStatusBarContribution} */
export { NukeCoreStatusBarContribution } from './contributions/status-bar-contribution';
/** Re-export of the visibility service. @see {@link ./services/nuke-core-visibility-service | NukeCoreVisibilityService} */
export { NukeCoreVisibilityService } from './services/nuke-core-visibility-service';
/** Re-export of protocol symbols and interfaces. @see {@link ../common/nuke-core-protocol | nuke-core-protocol} */
export { NukeCoreStatusBarVisibility, NukeCoreStatusBarVisibilityService } from '../common/nuke-core-protocol';
