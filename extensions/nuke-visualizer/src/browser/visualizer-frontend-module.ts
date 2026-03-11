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
import { VisualizerWidget } from './visualizer-widget';
import { VisualizerContribution } from './visualizer-contribution';
import { WidgetFactory, FrontendApplicationContribution, OpenHandler, bindViewContribution } from '@theia/core/lib/browser';
import { WidgetStatusBarContribution, noopWidgetStatusBarContribution } from '@theia/core/lib/browser';
import { VisualizerBackendService, VISUALIZER_BACKEND_PATH } from '../common/visualizer-protocol';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser';
import { bindVisualizerPreferences } from './visualizer-preferences';

export default new ContainerModule((bind: interfaces.Bind) => {
    // Bind preferences
    bindVisualizerPreferences(bind);

    // Bind backend service proxy
    bind(VisualizerBackendService).toDynamicValue(ctx => {
        const connectionProvider = ctx.container.get(WebSocketConnectionProvider);
        return connectionProvider.createProxy<VisualizerBackendService>(VISUALIZER_BACKEND_PATH);
    }).inSingletonScope();

    // Bind contributions
    bindViewContribution(bind, VisualizerContribution);
    bind(FrontendApplicationContribution).toService(VisualizerContribution);
    bind(OpenHandler).toService(VisualizerContribution);
    
    // Bind widget - NOT as singleton so fresh instances are created when reopened
    bind(VisualizerWidget).toSelf().inTransientScope();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: VisualizerWidget.ID,
        createWidget: () => context.container.get<VisualizerWidget>(VisualizerWidget),
    })).inSingletonScope();
    
    // Optional: bind status bar contribution (noop if not needed)
    bind(WidgetStatusBarContribution).toConstantValue(noopWidgetStatusBarContribution(VisualizerWidget));
});
