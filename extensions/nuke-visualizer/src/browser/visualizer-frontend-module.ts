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

import { CommandContribution, MenuContribution, MessageService } from '@theia/core/lib/common';
import { ContainerModule, interfaces } from '@theia/core/shared/inversify';
import { VisualizerWidget } from './visualizer-widget';
import { VisualizerContribution } from './visualizer-contribution';
import { WidgetFactory, FrontendApplicationContribution, OpenHandler, bindViewContribution } from '@theia/core/lib/browser';
import { WidgetStatusBarContribution, noopWidgetStatusBarContribution } from '@theia/core/lib/browser';
import { 
    VisualizerBackendService, 
    VISUALIZER_BACKEND_PATH, 
    VisualizerClient
} from '../common/base-visualizer-protocol';
import {
    OpenMCBackendService,
    OPENMC_BACKEND_PATH
} from '../common/openmc-protocol';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser';
import { bindVisualizerPreferences } from './visualizer-preferences';
import { OutputChannelManager } from '@theia/output/lib/browser/output-channel';
import URI from '@theia/core/lib/common/uri';
import { OpenMCService } from './plugins/openmc/openmc-service';
import { OpenMCWidgetFactory } from './plugins/openmc/services/openmc-widget-factory';
import { OpenMCFileDiscoveryService } from './plugins/openmc/services/openmc-file-discovery';
import { OpenMCContribution, XSPlotViewContribution, OpenMCTalliesViewContribution } from './plugins/openmc/openmc-contribution';
import { OpenMCStatepointCommands } from './plugins/openmc/commands/statepoint-commands';
import { OpenMCGeometryCommands } from './plugins/openmc/commands/geometry-commands';
import { OpenMCPlottingCommands } from './plugins/openmc/commands/plotting-commands';
import { OpenMCDepletionCommands } from './plugins/openmc/commands/depletion-commands';
import { OpenMCTallySelector } from './plugins/openmc/widgets/statepoint/tally-selector';
import { OpenMCTallyTreeWidget } from './plugins/openmc/widgets/statepoint/openmc-tally-tree';
import { OpenMCPlotWidget } from './plugins/openmc/widgets/plotting/openmc-plot-widget';
import { OpenMCHeatmapWidget } from './plugins/openmc/widgets/plotting/openmc-heatmap-widget';
import { XSPlotWidget } from './plugins/openmc/widgets/plotting/xs-plot-widget';
import { OpenMCDepletionWidget } from './plugins/openmc/widgets/depletion/openmc-depletion-widget';
import { OpenMCDepletionCompareWidget } from './plugins/openmc/widgets/depletion/openmc-depletion-compare-widget';
import { OpenMCGeometryTreeWidget } from './plugins/openmc/widgets/geometry/openmc-geometry-tree';
import { OpenMCGeometry3DWidget } from './plugins/openmc/widgets/geometry/openmc-geometry-3d-widget';
import { OpenMCMaterialExplorerWidget } from './plugins/openmc/widgets/materials/openmc-material-explorer';
import { OpenMCOverlapWidget } from './plugins/openmc/widgets/geometry/openmc-overlap-widget';
import { OpenMCStatepointViewerWidget } from './plugins/openmc/widgets/statepoint/statepoint-viewer';
import { PlotlyService, PlotlyServiceImpl } from './plotly/plotly-service';
import { HealthCheckFramework } from './services/health-check-framework';

export default new ContainerModule((bind: interfaces.Bind) => {
    // Bind Plotly service
    bind(PlotlyService).to(PlotlyServiceImpl).inSingletonScope();
    // Bind health check framework
    bind(HealthCheckFramework).toSelf().inSingletonScope();
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
    
    // Bind OpenMC frontend services
    bind(OpenMCService).toSelf().inSingletonScope();
    bind(OpenMCWidgetFactory).toSelf().inSingletonScope();
    bind(OpenMCFileDiscoveryService).toSelf().inSingletonScope();
    
    // Bind OpenMC contribution
    bind(OpenMCContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(OpenMCContribution);
    bind(CommandContribution).toService(OpenMCContribution);
    bind(MenuContribution).toService(OpenMCContribution);
    bind(OpenHandler).toService(OpenMCContribution);

    // OpenMC plugin command contributions
    bind(OpenMCStatepointCommands).toSelf().inSingletonScope();
    bind(CommandContribution).toService(OpenMCStatepointCommands);
    bind(OpenMCGeometryCommands).toSelf().inSingletonScope();
    bind(CommandContribution).toService(OpenMCGeometryCommands);
    bind(OpenMCPlottingCommands).toSelf().inSingletonScope();
    bind(CommandContribution).toService(OpenMCPlottingCommands);
    bind(OpenMCDepletionCommands).toSelf().inSingletonScope();
    bind(CommandContribution).toService(OpenMCDepletionCommands);
    
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

    // Bind statepoint viewer widget
    bind(OpenMCStatepointViewerWidget).toSelf().inTransientScope();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: OpenMCStatepointViewerWidget.ID,
        createWidget: (options?: { id?: string }) => {
            const widget = context.container.get<OpenMCStatepointViewerWidget>(OpenMCStatepointViewerWidget);
            if (options?.id) {
                widget.id = options.id;
            }
            return widget;
        },
    })).inSingletonScope();
});
