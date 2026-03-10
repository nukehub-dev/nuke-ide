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
import { TrameWidget } from './trame-widget';
import { TrameContribution } from './trame-contribution';
import { WidgetFactory, FrontendApplicationContribution, OpenHandler, bindViewContribution } from '@theia/core/lib/browser';
import { WidgetStatusBarContribution, noopWidgetStatusBarContribution } from '@theia/core/lib/browser';
import { TrameBackendService, TRAME_BACKEND_PATH } from '../common/trame-protocol';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser';
import { bindVisualizerPreferences } from './trame-preferences';

export default new ContainerModule((bind: interfaces.Bind) => {
    // Bind preferences
    bindVisualizerPreferences(bind);

    // Bind backend service proxy
    bind(TrameBackendService).toDynamicValue(ctx => {
        const connectionProvider = ctx.container.get(WebSocketConnectionProvider);
        return connectionProvider.createProxy<TrameBackendService>(TRAME_BACKEND_PATH);
    }).inSingletonScope();

    // Bind contributions
    bindViewContribution(bind, TrameContribution);
    bind(FrontendApplicationContribution).toService(TrameContribution);
    bind(OpenHandler).toService(TrameContribution);
    
    // Bind widget as singleton so it's reused
    bind(TrameWidget).toSelf().inSingletonScope();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: TrameWidget.ID,
        createWidget: () => context.container.get<TrameWidget>(TrameWidget),
    })).inSingletonScope();
    
    // Optional: bind status bar contribution (noop if not needed)
    bind(WidgetStatusBarContribution).toConstantValue(noopWidgetStatusBarContribution(TrameWidget));
});
