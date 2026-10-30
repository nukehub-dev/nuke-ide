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

import './icons/domain-icon-classes.css';
import { CommandContribution, MenuContribution, MessageService } from '@theia/core/lib/common';
import { ContainerModule, interfaces } from '@theia/core/shared/inversify';
import { VisualizerWidget } from './visualizer-widget';
import { WidgetFactory, FrontendApplicationContribution, OpenHandler, bindViewContribution } from '@theia/core/lib/browser';
import { VisualizerViewContribution } from './contributions/visualizer-view-contribution';
import { VisualizerOpenHandler } from './contributions/visualizer-open-handler';
import { VisualizerCommandContribution } from './commands/visualizer-command-contribution';
import { VisualizerComparisonContribution } from './contributions/visualizer-comparison-contribution';
import { VisualizerMenuContribution } from './contributions/visualizer-menu-contribution';
import { VisualizerToolsContribution } from './contributions/visualizer-tools-contribution';
import { NukeToolsContribution } from 'nuke-core/lib/common/nuke-tools-protocol';
import { WidgetStatusBarContribution, noopWidgetStatusBarContribution } from '@theia/core/lib/browser';
import { VisualizerBackendService, VISUALIZER_BACKEND_PATH, VisualizerClient } from '../common/base-visualizer-protocol';
import { OpenMCBackendService, OPENMC_BACKEND_PATH } from '../common/openmc-protocol';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser';
import { bindVisualizerPreferences } from './visualizer-preferences';
import { OutputChannelManager } from '@theia/output/lib/browser/output-channel';
import URI from '@theia/core/lib/common/uri';
import { OpenMCService } from './plugins/openmc/openmc-service';
import { OpenMCWidgetFactory } from './plugins/openmc/services/openmc-widget-factory';
import { OpenMCFileDiscoveryService } from './plugins/openmc/services/openmc-file-discovery';
import { OpenMCContribution } from './plugins/openmc/openmc-contribution';
import { OpenMCFileDiscovery } from './plugins/openmc/contributions/openmc-file-discovery';
import { OpenMCStatepointContribution } from './plugins/openmc/contributions/openmc-statepoint-contribution';
import { OpenMCGeometryContribution } from './plugins/openmc/contributions/openmc-geometry-contribution';
import { OpenMCDepletionContribution } from './plugins/openmc/contributions/openmc-depletion-contribution';
import { OpenMCOverlayContribution } from './plugins/openmc/contributions/openmc-overlay-contribution';
import { OpenMCPlottingContribution } from './plugins/openmc/contributions/openmc-plotting-contribution';
import { OpenMCMenuContribution } from './plugins/openmc/contributions/openmc-menu-contribution';
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
import { OpenMCMaterialExplorerWidget } from './plugins/openmc/widgets/materials/openmc-material-explorer';
import { OpenMCOverlapWidget } from './plugins/openmc/widgets/geometry/openmc-overlap-widget';
import { OpenMCStatepointViewerWidget } from './plugins/openmc/widgets/statepoint/statepoint-viewer';
import { OpenMCTallySeriesWidget } from './plugins/openmc/widgets/statepoint/tally-series-widget';
import { TallyNativeViewerWidget } from './plugins/openmc/widgets/tally-native/tally-native-viewer-widget';
import { PlotlyService, PlotlyServiceImpl } from './plotly/plotly-service';
import { HealthCheckFramework } from './services/health-check-framework';
import { VisualizerHealthService } from './services/visualizer-health-service';
import { bindContributionProvider } from '@theia/core/lib/common/contribution-provider';
import { OutputViewerContribution, OutputViewerRegistry } from './output-viewer/output-viewer-registry';
import { OpenMCTracksViewerWidget } from './plugins/openmc/widgets/tracks/openmc-tracks-viewer-widget';
import { OpenMCCollisionTrackViewerWidget } from './plugins/openmc/widgets/collision-track/openmc-collision-track-viewer-widget';
import { OpenMCWeightWindowsViewerWidget } from './plugins/openmc/widgets/weight-windows/openmc-weight-windows-viewer-widget';
import { OpenMCTracksViewerContribution } from './plugins/openmc/contributions/openmc-tracks-viewer-contribution';
import { OpenMCCollisionTrackViewerContribution } from './plugins/openmc/contributions/openmc-collision-track-viewer-contribution';
import { OpenMCWeightWindowsViewerContribution } from './plugins/openmc/contributions/openmc-weight-windows-viewer-contribution';
import { OpenMCRandomRayResultsWidget } from './plugins/openmc/widgets/random-ray/random-ray-results-widget';
import { OpenMCRandomRayCommands } from './plugins/openmc/commands/random-ray-commands';
import { DagmcViewerWidget } from './plugins/openmc/widgets/dagmc/dagmc-viewer-widget';
import { OpenMCDagmcViewerContribution } from './plugins/openmc/contributions/openmc-dagmc-viewer-contribution';
import { GeometryNativeViewerWidget } from './plugins/openmc/widgets/geometry-native/geometry-native-viewer-widget';
import { OpenMCGeometryNativeViewerContribution } from './plugins/openmc/contributions/openmc-geometry-native-contribution';
import { OpenMCParticleRestartWidget } from './plugins/openmc/widgets/particle-restart/openmc-particle-restart-widget';
import { OpenMCParticleRestartViewerContribution } from './plugins/openmc/contributions/openmc-particle-restart-viewer-contribution';
import { NuclearDataWidget } from './plugins/openmc/widgets/nuclear-data/nuclear-data-widget';
import { OpenMCNuclearDataCommands } from './plugins/openmc/commands/nuclear-data-commands';
import { OpenMCVoxelPlotViewerContribution } from './plugins/openmc/contributions/openmc-voxel-plot-viewer-contribution';
import { OpenMCSummaryViewerContribution } from './plugins/openmc/contributions/openmc-summary-viewer-contribution';
import { ExodusTimeSliderWidget } from './plugins/openmc/widgets/exodus-series/exodus-time-slider-widget';
import { OpenMCExodusViewerContribution } from './plugins/openmc/contributions/openmc-exodus-viewer-contribution';
import { ViewerSettingsWidget } from './viewer-settings/viewer-settings-widget';
import { ViewerSettingsContribution } from './viewer-settings/viewer-settings-contribution';
import { DatasetInspectorWidget } from './dataset-inspector/dataset-inspector-widget';
import { DatasetInspectorContribution } from './dataset-inspector/dataset-inspector-contribution';
import { DagmcOutlineWidget } from './dagmc-outline/dagmc-outline-widget';
import { DagmcOutlineContribution } from './dagmc-outline/dagmc-outline-contribution';
import { CsgOutlineWidget } from './csg-outline/csg-outline-widget';
import { CsgOutlineContribution } from './csg-outline/csg-outline-contribution';

export default new ContainerModule((bind: interfaces.Bind) => {
    // Bind Plotly service
    bind(PlotlyService).to(PlotlyServiceImpl).inSingletonScope();
    // Bind health check framework
    bind(HealthCheckFramework).toSelf().inSingletonScope();
    bind(VisualizerHealthService).toSelf().inSingletonScope();
    // Bind preferences
    bindVisualizerPreferences(bind);

    // Output viewer registry: OpenMC output-file viewers (tracks, collision
    // tracks, weight windows, ...) register as OutputViewerContributions and
    // are consulted first by VisualizerOpenHandler and OpenMCContribution.
    bindContributionProvider(bind, OutputViewerContribution);
    bind(OutputViewerRegistry).toSelf().inSingletonScope();

    // Bind tracks viewer widget
    bind(OpenMCTracksViewerWidget).toSelf().inTransientScope();
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
            id: OpenMCTracksViewerWidget.ID,
            createWidget: (options?: { id?: string }) => {
                const widget = context.container.get<OpenMCTracksViewerWidget>(OpenMCTracksViewerWidget);
                if (options?.id) {
                    widget.id = options.id;
                }
                return widget;
            }
        }))
        .inSingletonScope();
    bind(OpenMCTracksViewerContribution).toSelf().inSingletonScope();
    bind(OutputViewerContribution).toService(OpenMCTracksViewerContribution);

    // Bind collision track viewer widget
    bind(OpenMCCollisionTrackViewerWidget).toSelf().inTransientScope();
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
            id: OpenMCCollisionTrackViewerWidget.ID,
            createWidget: (options?: { id?: string }) => {
                const widget = context.container.get<OpenMCCollisionTrackViewerWidget>(OpenMCCollisionTrackViewerWidget);
                if (options?.id) {
                    widget.id = options.id;
                }
                return widget;
            }
        }))
        .inSingletonScope();
    bind(OpenMCCollisionTrackViewerContribution).toSelf().inSingletonScope();
    bind(OutputViewerContribution).toService(OpenMCCollisionTrackViewerContribution);

    // Bind weight windows viewer widget
    bind(OpenMCWeightWindowsViewerWidget).toSelf().inTransientScope();
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
            id: OpenMCWeightWindowsViewerWidget.ID,
            createWidget: (options?: { id?: string }) => {
                const widget = context.container.get<OpenMCWeightWindowsViewerWidget>(OpenMCWeightWindowsViewerWidget);
                if (options?.id) {
                    widget.id = options.id;
                }
                return widget;
            }
        }))
        .inSingletonScope();
    bind(OpenMCWeightWindowsViewerContribution).toSelf().inSingletonScope();
    bind(OutputViewerContribution).toService(OpenMCWeightWindowsViewerContribution);

    // Bind native DAGMC viewer widget (renders natively, no server)
    bind(DagmcViewerWidget).toSelf().inTransientScope();
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
            id: DagmcViewerWidget.ID,
            createWidget: (options?: { id?: string }) => {
                const widget = context.container.get<DagmcViewerWidget>(DagmcViewerWidget);
                if (options?.id) {
                    widget.id = options.id;
                }
                return widget;
            }
        }))
        .inSingletonScope();
    bind(OpenMCDagmcViewerContribution).toSelf().inSingletonScope();
    bind(OutputViewerContribution).toService(OpenMCDagmcViewerContribution);

    // Bind native geometry viewer widget (tree View 3D target)
    bind(GeometryNativeViewerWidget).toSelf().inTransientScope();
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
            id: GeometryNativeViewerWidget.ID,
            createWidget: (options?: { id?: string }) => {
                const widget = context.container.get<GeometryNativeViewerWidget>(GeometryNativeViewerWidget);
                if (options?.id) {
                    widget.id = options.id;
                }
                return widget;
            }
        }))
        .inSingletonScope();
    bind(OpenMCGeometryNativeViewerContribution).toSelf().inSingletonScope();
    bind(OutputViewerContribution).toService(OpenMCGeometryNativeViewerContribution);

    // Bind random-ray results widget + open command (no OutputViewerContribution:
    // random-ray outputs are plain <name>.vtk files with no distinctive pattern,
    // so they keep the standard VTK handler and this command is the opt-in)
    bind(OpenMCRandomRayResultsWidget).toSelf().inTransientScope();
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
            id: OpenMCRandomRayResultsWidget.ID,
            createWidget: (options?: { id?: string }) => {
                const widget = context.container.get<OpenMCRandomRayResultsWidget>(OpenMCRandomRayResultsWidget);
                if (options?.id) {
                    widget.id = options.id;
                }
                return widget;
            }
        }))
        .inSingletonScope();
    bind(OpenMCRandomRayCommands).toSelf().inSingletonScope();
    bind(CommandContribution).toService(OpenMCRandomRayCommands);

    // Bind particle restart preview widget (tabular — no trame pipeline)
    bind(OpenMCParticleRestartWidget).toSelf().inTransientScope();
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
            id: OpenMCParticleRestartWidget.ID,
            createWidget: (options?: { id?: string }) => {
                const widget = context.container.get<OpenMCParticleRestartWidget>(OpenMCParticleRestartWidget);
                if (options?.id) {
                    widget.id = options.id;
                }
                return widget;
            }
        }))
        .inSingletonScope();
    bind(OpenMCParticleRestartViewerContribution).toSelf().inSingletonScope();
    bind(OutputViewerContribution).toService(OpenMCParticleRestartViewerContribution);

    // Bind nuclear data browser widget + open command
    bind(NuclearDataWidget).toSelf().inTransientScope();
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
            id: NuclearDataWidget.ID,
            createWidget: () => context.container.get<NuclearDataWidget>(NuclearDataWidget)
        }))
        .inSingletonScope();
    bind(OpenMCNuclearDataCommands).toSelf().inSingletonScope();
    bind(CommandContribution).toService(OpenMCNuclearDataCommands);

    // Voxel plot files (*voxel*.h5, plot_*.h5) route to the random-ray results
    // viewer (it converts them via openmc.voxel-vtk)
    bind(OpenMCVoxelPlotViewerContribution).toSelf().inSingletonScope();
    bind(OutputViewerContribution).toService(OpenMCVoxelPlotViewerContribution);

    // summary.h5 routes to the geometry hierarchy + 3D view
    bind(OpenMCSummaryViewerContribution).toSelf().inSingletonScope();
    bind(OutputViewerContribution).toService(OpenMCSummaryViewerContribution);

    // Bind backend service proxy with client implementation for logging
    bind(VisualizerBackendService)
        .toDynamicValue((ctx) => {
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
                    // No frontend widget tracks server ports anymore (all
                    // viewers render natively); the backend still reports
                    // process exits for the output channel.
                    console.log(`[Visualizer] Server on port ${port} stopped`);
                }
            };

            const proxy = connectionProvider.createProxy<VisualizerBackendService>(VISUALIZER_BACKEND_PATH, client);
            return proxy;
        })
        .inSingletonScope();

    // Bind view contribution (registers default view command + keybinding)
    bindViewContribution(bind, VisualizerViewContribution);
    // Bind open handler
    bind(VisualizerOpenHandler).toSelf().inSingletonScope();
    bind(OpenHandler).toService(VisualizerOpenHandler);
    // Bind custom commands
    bind(VisualizerCommandContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(VisualizerCommandContribution);
    // Bind comparison workspace commands (compare open views / stop comparison)
    bind(VisualizerComparisonContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(VisualizerComparisonContribution);
    // Bind custom menus
    bind(VisualizerMenuContribution).toSelf().inSingletonScope();
    bind(MenuContribution).toService(VisualizerMenuContribution);

    // Nuke Tools sidebar contribution
    bind(VisualizerToolsContribution).toSelf().inSingletonScope();
    bind(NukeToolsContribution).toService(VisualizerToolsContribution);

    // Note: XS Plot and OpenMC Tallies are handled by OpenMCContribution (not AbstractViewContribution)
    // to avoid automatic View-menu registration. They use manual Command+Menu+Keybinding contributions.

    // Bind widget - NOT as singleton so fresh instances are created when reopened
    bind(VisualizerWidget).toSelf().inTransientScope();
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
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
            }
        }))
        .inSingletonScope();

    // Optional: bind status bar contribution (noop if not needed)
    bind(WidgetStatusBarContribution).toConstantValue(noopWidgetStatusBarContribution(VisualizerWidget));

    // === OpenMC Integration ===

    // Bind OpenMC backend service proxy with client for receiving warnings
    bind(OpenMCBackendService)
        .toDynamicValue((ctx) => {
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
        })
        .inSingletonScope();

    // Bind OpenMC frontend services
    bind(OpenMCService).toSelf().inSingletonScope();
    bind(OpenMCWidgetFactory).toSelf().inSingletonScope();
    bind(OpenMCFileDiscoveryService).toSelf().inSingletonScope();

    // Bind OpenMC contribution classes
    bind(OpenMCFileDiscovery).toSelf().inSingletonScope();
    bind(OpenMCStatepointContribution).toSelf().inSingletonScope();
    bind(OpenMCGeometryContribution).toSelf().inSingletonScope();
    bind(OpenMCDepletionContribution).toSelf().inSingletonScope();
    bind(OpenMCOverlayContribution).toSelf().inSingletonScope();
    bind(OpenMCPlottingContribution).toSelf().inSingletonScope();
    bind(OpenMCMenuContribution).toSelf().inSingletonScope();

    // Bind OpenMC contribution
    bind(OpenMCContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(OpenMCContribution);
    bind(MenuContribution).toService(OpenMCMenuContribution);
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
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
            id: OpenMCTallyTreeWidget.ID,
            createWidget: () => context.container.get<OpenMCTallyTreeWidget>(OpenMCTallyTreeWidget)
        }))
        .inSingletonScope();

    // Bind plot widget
    bind(OpenMCPlotWidget).toSelf().inTransientScope();
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
            id: OpenMCPlotWidget.ID,
            createWidget: (options?: { id?: string }) => {
                const widget = context.container.get<OpenMCPlotWidget>(OpenMCPlotWidget);
                if (options?.id) {
                    widget.id = options.id;
                }
                return widget;
            }
        }))
        .inSingletonScope();

    // Bind XS plot widget
    bind(XSPlotWidget).toSelf().inTransientScope();
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
            id: XSPlotWidget.ID,
            createWidget: () => context.container.get<XSPlotWidget>(XSPlotWidget)
        }))
        .inSingletonScope();

    // Bind heatmap widget
    bind(OpenMCHeatmapWidget).toSelf().inTransientScope();
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
            id: OpenMCHeatmapWidget.ID,
            createWidget: (options?: { id?: string }) => {
                const widget = context.container.get<OpenMCHeatmapWidget>(OpenMCHeatmapWidget);
                if (options?.id) {
                    widget.id = options.id;
                }
                return widget;
            }
        }))
        .inSingletonScope();

    // Bind depletion widget
    bind(OpenMCDepletionWidget).toSelf().inTransientScope();
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
            id: OpenMCDepletionWidget.ID,
            createWidget: (options?: { id?: string }) => {
                const widget = context.container.get<OpenMCDepletionWidget>(OpenMCDepletionWidget);
                if (options?.id) {
                    widget.id = options.id;
                }
                return widget;
            }
        }))
        .inSingletonScope();

    // Bind depletion comparison widget
    bind(OpenMCDepletionCompareWidget).toSelf().inTransientScope();
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
            id: OpenMCDepletionCompareWidget.ID,
            createWidget: (options?: { id?: string }) => {
                const widget = context.container.get<OpenMCDepletionCompareWidget>(OpenMCDepletionCompareWidget);
                if (options?.id) {
                    widget.id = options.id;
                }
                return widget;
            }
        }))
        .inSingletonScope();

    // Bind geometry tree widget
    bind(OpenMCGeometryTreeWidget).toSelf().inTransientScope();
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
            id: OpenMCGeometryTreeWidget.ID,
            createWidget: () => context.container.get<OpenMCGeometryTreeWidget>(OpenMCGeometryTreeWidget)
        }))
        .inSingletonScope();

    // Bind material explorer widget
    bind(OpenMCMaterialExplorerWidget).toSelf().inTransientScope();
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
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
            }
        }))
        .inSingletonScope();

    // Bind overlap checker widget
    bind(OpenMCOverlapWidget).toSelf().inTransientScope();
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
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
            }
        }))
        .inSingletonScope();

    // Bind statepoint viewer widget
    bind(OpenMCStatepointViewerWidget).toSelf().inTransientScope();
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
            id: OpenMCStatepointViewerWidget.ID,
            createWidget: (options?: { id?: string }) => {
                const widget = context.container.get<OpenMCStatepointViewerWidget>(OpenMCStatepointViewerWidget);
                if (options?.id) {
                    widget.id = options.id;
                }
                return widget;
            }
        }))
        .inSingletonScope();

    // Bind native tally viewer widget (no contribution: the tally flows open
    // it programmatically after convert → FileService.read → setTallyText)
    bind(TallyNativeViewerWidget).toSelf().inTransientScope();
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
            id: TallyNativeViewerWidget.ID,
            createWidget: (options?: { id?: string }) => {
                const widget = context.container.get<TallyNativeViewerWidget>(TallyNativeViewerWidget);
                if (options?.id) {
                    widget.id = options.id;
                }
                return widget;
            }
        }))
        .inSingletonScope();

    // Bind native Exodus time-slider widget (*.e/*.exo* via base.exodus-series, no trame server)
    bind(ExodusTimeSliderWidget).toSelf().inTransientScope();
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
            id: ExodusTimeSliderWidget.ID,
            createWidget: (options?: { id?: string }) => {
                const widget = context.container.get<ExodusTimeSliderWidget>(ExodusTimeSliderWidget);
                if (options?.id) {
                    widget.id = options.id;
                }
                return widget;
            }
        }))
        .inSingletonScope();
    bind(OpenMCExodusViewerContribution).toSelf().inSingletonScope();
    bind(OutputViewerContribution).toService(OpenMCExodusViewerContribution);

    // Bind native tally-series widget (one score across sibling statepoints,
    // opened from a statepoint viewer tally card; no trame server)
    bind(OpenMCTallySeriesWidget).toSelf().inTransientScope();
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
            id: OpenMCTallySeriesWidget.ID,
            createWidget: (options?: { id?: string }) => {
                const widget = context.container.get<OpenMCTallySeriesWidget>(OpenMCTallySeriesWidget);
                if (options?.id) {
                    widget.id = options.id;
                }
                return widget;
            }
        }))
        .inSingletonScope();

    // Viewer Settings sidebar (right area): one panel bound to the active
    // native viewer through the shared ViewerSettingsHost surface
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
            id: ViewerSettingsWidget.ID,
            createWidget: () => context.container.get<ViewerSettingsWidget>(ViewerSettingsWidget)
        }))
        .inSingletonScope();
    bind(ViewerSettingsWidget).toSelf();
    bind(ViewerSettingsContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(ViewerSettingsContribution);

    // Dataset Inspector sidebar (right area): summary + array table for the
    // active viewer through the ViewerDatasetHost surface.
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
            id: DatasetInspectorWidget.ID,
            createWidget: () => context.container.get<DatasetInspectorWidget>(DatasetInspectorWidget)
        }))
        .inSingletonScope();
    bind(DatasetInspectorWidget).toSelf();
    bind(DatasetInspectorContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(DatasetInspectorContribution);

    // DAGMC Outline sidebar (right area): volume/material/group visibility
    // for the active DAGMC viewer through the DagmcOutlineHost surface
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
            id: DagmcOutlineWidget.ID,
            createWidget: () => context.container.get<DagmcOutlineWidget>(DagmcOutlineWidget)
        }))
        .inSingletonScope();
    bind(DagmcOutlineWidget).toSelf();
    bind(DagmcOutlineContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(DagmcOutlineContribution);

    // CSG Outline sidebar (right area): cell/material visibility for the
    // active native geometry viewer through the CsgOutlineHost surface
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
            id: CsgOutlineWidget.ID,
            createWidget: () => context.container.get<CsgOutlineWidget>(CsgOutlineWidget)
        }))
        .inSingletonScope();
    bind(CsgOutlineWidget).toSelf();
    bind(CsgOutlineContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(CsgOutlineContribution);
});
