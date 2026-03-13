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

import { CommandContribution, MenuContribution } from '@theia/core/lib/common';
import { ContainerModule, interfaces } from '@theia/core/shared/inversify';
import { VisualizerWidget } from './visualizer-widget';
import { VisualizerContribution } from './visualizer-contribution';
import { WidgetFactory, FrontendApplicationContribution, OpenHandler, bindViewContribution } from '@theia/core/lib/browser';
import { WidgetStatusBarContribution, noopWidgetStatusBarContribution } from '@theia/core/lib/browser';
import { 
    VisualizerBackendService, 
    VISUALIZER_BACKEND_PATH, 
    VisualizerClient,
    OpenMCBackendService,
    OPENMC_BACKEND_PATH
} from '../common/visualizer-protocol';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser';
import { bindVisualizerPreferences } from './visualizer-preferences';
import { OutputChannelManager } from '@theia/output/lib/browser/output-channel';
import URI from '@theia/core/lib/common/uri';
import { OpenMCService } from './openmc/openmc-service';
import { OpenMCContribution } from './openmc/openmc-contribution';
import { OpenMCTallySelector } from './openmc/tally-selector';
import { OpenMCTallyTreeWidget } from './openmc/openmc-tally-tree';
import { OpenMCPlotWidget } from './openmc/openmc-plot-widget';
import { PlotlyService, PlotlyServiceImpl } from './plotly/plotly-service';

export default new ContainerModule((bind: interfaces.Bind) => {
    // Bind Plotly service
    bind(PlotlyService).to(PlotlyServiceImpl).inSingletonScope();
    // Bind preferences
    bindVisualizerPreferences(bind);

    // Bind backend service proxy with client implementation for logging
    bind(VisualizerBackendService).toDynamicValue(ctx => {
        const connectionProvider = ctx.container.get(WebSocketConnectionProvider);
        const outputChannelManager = ctx.container.get<OutputChannelManager>(OutputChannelManager);
        
        const client: VisualizerClient = {
            log: (message: string) => {
                const channel = outputChannelManager.getChannel('Nuke Visualizer');
                channel.appendLine(message);
            },
            error: (message: string) => {
                const channel = outputChannelManager.getChannel('Nuke Visualizer');
                channel.appendLine(`ERROR: ${message}`);
            },
            onServerStop: (port: number) => {
                VisualizerWidget.onServerStop(port);
            }
        };
        
        const proxy = connectionProvider.createProxy<VisualizerBackendService>(VISUALIZER_BACKEND_PATH, client);
        return proxy;
    }).inSingletonScope();

    // Bind contributions
    bindViewContribution(bind, VisualizerContribution);
    bind(FrontendApplicationContribution).toService(VisualizerContribution);
    bind(OpenHandler).toService(VisualizerContribution);
    
    // Bind widget - NOT as singleton so fresh instances are created when reopened
    bind(VisualizerWidget).toSelf().inTransientScope();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: VisualizerWidget.ID,
        createWidget: (options?: { uri: string; id?: string }) => {
            const widget = context.container.get<VisualizerWidget>(VisualizerWidget);
            if (options?.uri) {
                widget.setUri(new URI(options.uri));
            }
            // Allow setting a custom widget ID for multiple instances
            if (options?.id) {
                widget.id = options.id;
            }
            return widget;
        },
    })).inSingletonScope();
    
    // Optional: bind status bar contribution (noop if not needed)
    bind(WidgetStatusBarContribution).toConstantValue(noopWidgetStatusBarContribution(VisualizerWidget));

    // === OpenMC Integration ===
    
    // Bind OpenMC backend service proxy
    bind(OpenMCBackendService).toDynamicValue(ctx => {
        const connectionProvider = ctx.container.get(WebSocketConnectionProvider);
        return connectionProvider.createProxy<OpenMCBackendService>(OPENMC_BACKEND_PATH);
    }).inSingletonScope();
    
    // Bind OpenMC frontend service
    bind(OpenMCService).toSelf().inSingletonScope();
    
    // Bind OpenMC contribution
    bind(OpenMCContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(OpenMCContribution);
    bind(CommandContribution).toService(OpenMCContribution);
    bind(MenuContribution).toService(OpenMCContribution);
    bind(OpenHandler).toService(OpenMCContribution);
    
    // Bind tally selector
    bind(OpenMCTallySelector).toSelf().inSingletonScope();
    
    // Bind tally tree widget
    bind(OpenMCTallyTreeWidget).toSelf().inTransientScope();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: OpenMCTallyTreeWidget.ID,
        createWidget: () => context.container.get<OpenMCTallyTreeWidget>(OpenMCTallyTreeWidget),
    })).inSingletonScope();

    // Bind plot widget
    bind(OpenMCPlotWidget).toSelf().inTransientScope();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: OpenMCPlotWidget.ID,
        createWidget: (options?: { id?: string }) => {
            const widget = context.container.get<OpenMCPlotWidget>(OpenMCPlotWidget);
            if (options?.id) {
                widget.id = options.id;
            }
            return widget;
        },
    })).inSingletonScope();
});
