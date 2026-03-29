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

import { CommandContribution, MenuContribution, MessageService } from '@theia/core/lib/common';
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
import { OpenMCContribution, XSPlotViewContribution, OpenMCTalliesViewContribution } from './openmc/openmc-contribution';
import { OpenMCTallySelector } from './openmc/tally-selector';
import { OpenMCTallyTreeWidget } from './openmc/openmc-tally-tree';
import { OpenMCPlotWidget } from './openmc/openmc-plot-widget';
import { OpenMCHeatmapWidget } from './openmc/openmc-heatmap-widget';
import { XSPlotWidget } from './openmc/xs-plot-widget';
import { OpenMCDepletionWidget } from './openmc/openmc-depletion-widget';
import { OpenMCDepletionCompareWidget } from './openmc/openmc-depletion-compare-widget';
import { OpenMCGeometryTreeWidget } from './openmc/openmc-geometry-tree';
import { OpenMCGeometry3DWidget } from './openmc/openmc-geometry-3d-widget';
import { OpenMCMaterialExplorerWidget } from './openmc/openmc-material-explorer';
import { OpenMCOverlapWidget } from './openmc/openmc-overlap-widget';
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
            warn: (message: string) => {
                // Warnings from base visualizer - log to output channel
                const channel = outputChannelManager.getChannel('Nuke Visualizer');
                channel.appendLine(`WARNING: ${message}`);
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
        createWidget: (options?: { uri: string; id?: string; volumeId?: number }) => {
            const widget = context.container.get<VisualizerWidget>(VisualizerWidget);
            if (options?.uri) {
                widget.setUri(new URI(options.uri), options.volumeId);
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
    
    // Bind OpenMC backend service proxy with client for receiving warnings
    bind(OpenMCBackendService).toDynamicValue(ctx => {
        const connectionProvider = ctx.container.get(WebSocketConnectionProvider);
        const messageService = ctx.container.get(MessageService);
        const outputChannelManager = ctx.container.get<OutputChannelManager>(OutputChannelManager);
        
        const client: VisualizerClient = {
            log: (message: string) => {
                const channel = outputChannelManager.getChannel('OpenMC');
                channel.appendLine(message);
            },
            error: (message: string) => {
                const channel = outputChannelManager.getChannel('OpenMC');
                channel.appendLine(`ERROR: ${message}`);
            },
            warn: (message: string) => {
                // Show warning notification immediately
                messageService.warn(message);
                // Also log to output channel
                const channel = outputChannelManager.getChannel('OpenMC');
                channel.appendLine(`WARNING: ${message}`);
            },
            onServerStop: (port: number) => {
                // Handle server stop if needed
                console.log(`[OpenMC] Server on port ${port} stopped`);
            }
        };
        
        return connectionProvider.createProxy<OpenMCBackendService>(OPENMC_BACKEND_PATH, client);
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

    // Bind XS plot widget
    bind(XSPlotWidget).toSelf().inTransientScope();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: XSPlotWidget.ID,
        createWidget: () => context.container.get<XSPlotWidget>(XSPlotWidget),
    })).inSingletonScope();

    // Bind heatmap widget
    bind(OpenMCHeatmapWidget).toSelf().inTransientScope();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: OpenMCHeatmapWidget.ID,
        createWidget: (options?: { id?: string }) => {
            const widget = context.container.get<OpenMCHeatmapWidget>(OpenMCHeatmapWidget);
            if (options?.id) {
                widget.id = options.id;
            }
            return widget;
        },
    })).inSingletonScope();

    // Bind XS Plot View Contribution (adds icon to sidebar)
    bindViewContribution(bind, XSPlotViewContribution);
    bind(FrontendApplicationContribution).toService(XSPlotViewContribution);

    // Bind OpenMC Tallies View Contribution (adds icon to sidebar)
    bindViewContribution(bind, OpenMCTalliesViewContribution);
    bind(FrontendApplicationContribution).toService(OpenMCTalliesViewContribution);

    // Bind depletion widget
    bind(OpenMCDepletionWidget).toSelf().inTransientScope();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: OpenMCDepletionWidget.ID,
        createWidget: (options?: { id?: string }) => {
            const widget = context.container.get<OpenMCDepletionWidget>(OpenMCDepletionWidget);
            if (options?.id) {
                widget.id = options.id;
            }
            return widget;
        },
    })).inSingletonScope();

    // Bind depletion comparison widget
    bind(OpenMCDepletionCompareWidget).toSelf().inTransientScope();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: OpenMCDepletionCompareWidget.ID,
        createWidget: (options?: { id?: string }) => {
            const widget = context.container.get<OpenMCDepletionCompareWidget>(OpenMCDepletionCompareWidget);
            if (options?.id) {
                widget.id = options.id;
            }
            return widget;
        },
    })).inSingletonScope();

    // Bind geometry tree widget
    bind(OpenMCGeometryTreeWidget).toSelf().inTransientScope();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: OpenMCGeometryTreeWidget.ID,
        createWidget: () => context.container.get<OpenMCGeometryTreeWidget>(OpenMCGeometryTreeWidget),
    })).inSingletonScope();

    // Bind geometry 3D widget
    bind(OpenMCGeometry3DWidget).toSelf().inTransientScope();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: OpenMCGeometry3DWidget.ID,
        createWidget: (options?: { id?: string }) => {
            const widget = context.container.get<OpenMCGeometry3DWidget>(OpenMCGeometry3DWidget);
            if (options?.id) {
                widget.id = options.id;
            }
            return widget;
        },
    })).inSingletonScope();

    // Bind material explorer widget
    bind(OpenMCMaterialExplorerWidget).toSelf().inTransientScope();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: OpenMCMaterialExplorerWidget.ID,
        createWidget: (options?: { uri?: string; id?: string }) => {
            const widget = context.container.get<OpenMCMaterialExplorerWidget>(OpenMCMaterialExplorerWidget);
            if (options?.uri) {
                widget.setFileUri(new URI(options.uri));
            }
            if (options?.id) {
                widget.id = options.id;
            }
            return widget;
        },
    })).inSingletonScope();

    // Bind overlap checker widget
    bind(OpenMCOverlapWidget).toSelf().inTransientScope();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: OpenMCOverlapWidget.ID,
        createWidget: (options?: { geometryUri?: string; id?: string }) => {
            const widget = context.container.get<OpenMCOverlapWidget>(OpenMCOverlapWidget);
            if (options?.geometryUri) {
                widget.setGeometryUri(new URI(options.geometryUri));
            }
            if (options?.id) {
                widget.id = options.id;
            }
            return widget;
        },
    })).inSingletonScope();
});
