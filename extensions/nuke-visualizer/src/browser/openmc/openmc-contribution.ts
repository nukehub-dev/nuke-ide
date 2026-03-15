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

import { injectable, inject } from '@theia/core/shared/inversify';
import { Command, CommandRegistry, MenuModelRegistry } from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common';
import { 
    QuickInputService, 
    QuickPickValue,
    AbstractViewContribution
} from '@theia/core/lib/browser';
import { 
    LabelProvider, 
    ApplicationShell,
    FrontendApplicationContribution,
    OpenHandler,
    WidgetOpenerOptions,
    Widget,
    FrontendApplication
} from '@theia/core/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { WidgetManager } from '@theia/core/lib/browser';
import { OpenMCService, TallyVisualizationOptions } from './openmc-service';
import { OpenMCTallySelector } from './tally-selector';
import { OpenMCTallyTreeWidget } from './openmc-tally-tree';
import { OpenMCPlotWidget } from './openmc-plot-widget';
import { OpenMCHeatmapWidget } from './openmc-heatmap-widget';
import { XSPlotWidget } from './xs-plot-widget';
import { OpenMCDepletionWidget } from './openmc-depletion-widget';
import { PlotlyService } from '../plotly/plotly-service';
import { PlotlyUtils } from '../plotly/plotly-utils';
import { PlotlyFigure } from '../../common/visualizer-protocol';

export namespace OpenMCCommands {
    export const OPENMC_CATEGORY = 'OpenMC';
    
    export const LOAD_STATEPOINT: Command = {
        id: 'openmc.load-statepoint',
        category: OPENMC_CATEGORY,
        label: 'Load Statepoint File...',
        iconClass: 'codicon codicon-database'
    };
    
    export const VISUALIZE_TALLY: Command = {
        id: 'openmc.visualize-tally',
        category: OPENMC_CATEGORY,
        label: 'Visualize Tally...',
        iconClass: 'codicon codicon-graph'
    };
    
    export const VISUALIZE_SOURCE: Command = {
        id: 'openmc.visualize-source',
        category: OPENMC_CATEGORY,
        label: 'Visualize Source Distribution...',
        iconClass: 'codicon codicon-debug-breakpoint-log'
    };
    
    export const OVERLAY_TALLY_ON_GEOMETRY: Command = {
        id: 'openmc.overlay-tally',
        category: OPENMC_CATEGORY,
        label: 'Overlay Tally on Geometry...',
        iconClass: 'codicon codicon-layers'
    };
    
    export const SHOW_TALLY_INFO: Command = {
        id: 'openmc.show-tally-info',
        category: OPENMC_CATEGORY,
        label: 'Show Tally Information',
        iconClass: 'codicon codicon-info'
    };
    
    export const DISCOVER_OPENMC_FILES: Command = {
        id: 'openmc.discover-files',
        category: OPENMC_CATEGORY,
        label: 'Discover OpenMC Files in Directory...',
        iconClass: 'codicon codicon-search'
    };
    
    export const PLOT_CROSS_SECTIONS: Command = {
        id: 'openmc.plot-xs',
        category: OPENMC_CATEGORY,
        label: 'Plot Cross-Sections...',
        iconClass: 'codicon codicon-graph-line'
    };
    
    export const OPEN_DEPLETION_VIEWER: Command = {
        id: 'openmc.open-depletion',
        category: OPENMC_CATEGORY,
        label: 'View Depletion Results...',
        iconClass: 'codicon codicon-flame'
    };
}

@injectable()
export class OpenMCContribution implements FrontendApplicationContribution, OpenHandler {
    readonly id = 'openmc';
    readonly label = 'OpenMC Files';
    readonly priority = 100;

    @inject(OpenMCService)
    protected readonly openmcService: OpenMCService;

    @inject(LabelProvider)
    protected readonly labelProvider: LabelProvider;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(QuickInputService)
    protected readonly quickInput: QuickInputService;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(PlotlyService)
    protected readonly plotlyService: PlotlyService;
    
    private tallyTreeWidget: OpenMCTallyTreeWidget | undefined;

    private async getPlotWidget(tallyId: number, type: string): Promise<OpenMCPlotWidget> {
        const widgetId = `${OpenMCPlotWidget.ID}:${tallyId}:${type}`;
        return this.widgetManager.getOrCreateWidget<OpenMCPlotWidget>(OpenMCPlotWidget.ID, {
            id: widgetId
        } as any);
    }

    private async getHeatmapWidget(tallyId: number, score?: string): Promise<OpenMCHeatmapWidget> {
        const widgetId = `${OpenMCHeatmapWidget.ID}:${tallyId}:${score || 'default'}`;
        return this.widgetManager.getOrCreateWidget<OpenMCHeatmapWidget>(OpenMCHeatmapWidget.ID, {
            id: widgetId
        } as any);
    }

    private async getOrCreateXSPlotWidget(): Promise<XSPlotWidget> {
        return this.widgetManager.getOrCreateWidget<XSPlotWidget>(XSPlotWidget.ID, {
            id: XSPlotWidget.ID
        } as any);
    }

    canHandle(uri: URI, options?: WidgetOpenerOptions): number {
        const name = uri.path.base.toLowerCase();
        
        // Handle statepoint files
        if (name.startsWith('statepoint') && name.endsWith('.h5')) {
            return 200;
        }
        
        // Handle source files
        if (name === 'source.h5') {
            return 200;
        }
        
        // Handle depletion results files
        if (name.includes('depletion') && name.endsWith('.h5')) {
            return 200;
        }
        
        // Handle DAGMC geometry files
        if (name.endsWith('.h5m')) {
            return 150;
        }
        
        return 0;
    }

    async open(uri: URI, options?: WidgetOpenerOptions): Promise<Widget> {
        const name = uri.path.base.toLowerCase();
        
        if (name.startsWith('statepoint') && name.endsWith('.h5')) {
            // Load statepoint and show tally tree in sidebar
            const progress = await this.messageService.showProgress({
                text: 'Loading statepoint file...',
                options: { cancelable: false }
            });

            try {
                const info = await this.openmcService.loadStatepoint(uri);
                if (info && info.nTallies > 0) {
                    progress.report({ message: 'Opening tally tree...' });
                    await this.showTallyTree(uri);
                }
            } finally {
                progress.cancel();
            }
        } else if (name === 'source.h5') {
            // Visualize source distribution
            await this.openmcService.visualizeSource(uri);
        } else if (name.endsWith('.h5m')) {
            // Check for statepoint in same directory
            const files = await this.openmcService.discoverFilesInDirectory(uri.parent);
            if (files.statepoint) {
                // Ask user if they want to overlay tally
                const choice = await this.quickInput.showQuickPick([
                    { label: '$(graph) Visualize Geometry Only', value: 'geometry' },
                    { label: '$(layers) Overlay Tally Results', value: 'overlay' },
                ], {
                    title: 'OpenMC Geometry',
                    placeholder: 'Choose visualization option'
                });
                
                if (choice?.value === 'overlay') {
                    await this.showTallySelectorForOverlay(uri, files.statepoint);
                } else {
                    // Fall back to standard DAGMC visualization
                    // This will be handled by the existing visualizer contribution
                    throw new Error('Use standard visualizer for geometry-only view');
                }
            } else {
                // No statepoint, use standard visualization
                throw new Error('Use standard visualizer for geometry-only view');
            }
        } else if (name.includes('depletion') && name.endsWith('.h5')) {
            // Open depletion viewer
            await this.openDepletionFile(uri.toString(), uri.path.base);
        }
        
        // Return a dummy widget - actual visualization is handled by VisualizerWidget
        return new Widget();
    }

    initialize(): void {
        // Register keyboard shortcuts or other initialization
    }

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(OpenMCCommands.LOAD_STATEPOINT, {
            execute: () => this.loadStatepointCommand()
        });

        registry.registerCommand(OpenMCCommands.VISUALIZE_TALLY, {
            execute: () => this.visualizeTallyCommand(),
            isEnabled: () => this.openmcService.getCurrentStatepoint() !== null
        });

        registry.registerCommand(OpenMCCommands.VISUALIZE_SOURCE, {
            execute: () => this.visualizeSourceCommand()
        });

        registry.registerCommand(OpenMCCommands.OVERLAY_TALLY_ON_GEOMETRY, {
            execute: () => this.overlayTallyCommand()
        });

        registry.registerCommand(OpenMCCommands.SHOW_TALLY_INFO, {
            execute: () => this.showTallyInfoCommand(),
            isEnabled: () => this.openmcService.getCurrentStatepoint() !== null
        });

        registry.registerCommand(OpenMCCommands.DISCOVER_OPENMC_FILES, {
            execute: () => this.discoverFilesCommand()
        });

        registry.registerCommand(OpenMCCommands.PLOT_CROSS_SECTIONS, {
            execute: () => this.plotXSCommand()
        });
        
        registry.registerCommand(OpenMCCommands.OPEN_DEPLETION_VIEWER, {
            execute: () => this.openDepletionViewerCommand()
        });
    }

    registerMenus(registry: MenuModelRegistry): void {
        // Register OpenMC menu in the menubar
        registry.registerMenuAction(['menubar', 'openmc'], {
            commandId: OpenMCCommands.LOAD_STATEPOINT.id,
            label: 'OpenMC',
            order: '10'
        });

        // Add items to OpenMC menu
        registry.registerMenuAction(['openmc'], {
            commandId: OpenMCCommands.LOAD_STATEPOINT.id,
            order: '1'
        });

        registry.registerMenuAction(['openmc'], {
            commandId: OpenMCCommands.VISUALIZE_TALLY.id,
            order: '2'
        });

        registry.registerMenuAction(['openmc'], {
            commandId: OpenMCCommands.VISUALIZE_SOURCE.id,
            order: '3'
        });

        registry.registerMenuAction(['openmc'], {
            commandId: OpenMCCommands.OVERLAY_TALLY_ON_GEOMETRY.id,
            order: '4'
        });

        registry.registerMenuAction(['openmc'], {
            commandId: OpenMCCommands.SHOW_TALLY_INFO.id,
            order: '5'
        });

        registry.registerMenuAction(['openmc'], {
            commandId: OpenMCCommands.PLOT_CROSS_SECTIONS.id,
            order: '6'
        });
        
        registry.registerMenuAction(['openmc'], {
            commandId: OpenMCCommands.OPEN_DEPLETION_VIEWER.id,
            order: '7'
        });

        // Add context menu for OpenMC files
        registry.registerMenuAction(['explorer-context-menu', 'openmc'], {
            commandId: OpenMCCommands.LOAD_STATEPOINT.id,
            when: 'resourceExtname == .h5',
            order: '1'
        });
        
        // Add context menu for depletion files
        registry.registerMenuAction(['explorer-context-menu', 'openmc'], {
            commandId: OpenMCCommands.OPEN_DEPLETION_VIEWER.id,
            when: 'resourceFilename =~ /depletion.*\\.h5/',
            order: '2'
        });
    }

    private async loadStatepointCommand(): Promise<void> {
        const uri = await this.quickInput.showQuickPick(
            await this.getH5Files(),
            {
                title: 'Select OpenMC Statepoint File',
                placeholder: 'Choose a statepoint.h5 file'
            }
        );

        if (uri) {
            // Show loading progress
            const progress = await this.messageService.showProgress({
                text: 'Loading statepoint file...',
                options: { cancelable: false }
            });

            try {
                await this.openmcService.loadStatepoint(new URI(uri.value));
                
                // Show tally tree directly
                const tallies = this.openmcService.getCurrentTallies();
                if (tallies.length > 0) {
                    progress.report({ message: 'Opening tally tree...' });
                    await this.showTallyTree(new URI(uri.value));
                }
            } finally {
                progress.cancel();
            }
        }
    }

    private async visualizeTallyCommand(): Promise<void> {
        const statepoint = this.openmcService.getCurrentStatepoint();
        if (!statepoint) {
            return;
        }

        await this.showTallyTree(new URI(statepoint.file));
    }

    private async visualizeSourceCommand(): Promise<void> {
        const uri = await this.quickInput.showQuickPick(
            await this.getSourceFiles(),
            {
                title: 'Select Source File',
                placeholder: 'Choose a source.h5 file'
            }
        );

        if (uri) {
            await this.openmcService.visualizeSource(new URI(uri.value));
        }
    }

    private async overlayTallyCommand(): Promise<void> {
        // Select geometry file
        const geometryUri = await this.quickInput.showQuickPick(
            await this.getGeometryFiles(),
            {
                title: 'Select Geometry File',
                placeholder: 'Choose a DAGMC .h5m file'
            }
        );

        if (!geometryUri) return;

        // Select statepoint file
        const statepointUri = await this.quickInput.showQuickPick(
            await this.getStatepointFiles(),
            {
                title: 'Select Statepoint File',
                placeholder: 'Choose a statepoint.h5 file'
            }
        );

        if (!statepointUri) return;

        await this.showTallySelectorForOverlay(
            new URI(geometryUri.value),
            new URI(statepointUri.value)
        );
    }

    private async showTallyInfoCommand(): Promise<void> {
        const statepoint = this.openmcService.getCurrentStatepoint();
        const tallies = this.openmcService.getCurrentTallies();

        if (!statepoint || tallies.length === 0) {
            return;
        }

        const lines: string[] = [
            `OpenMC Statepoint: ${statepoint.file}`,
            `Batches: ${statepoint.batches}`,
            statepoint.kEff !== undefined ? `k-effective: ${statepoint.kEff.toFixed(6)} ± ${statepoint.kEffStd?.toFixed(6)}` : '',
            ``,
            `Tallies (${tallies.length}):`,
            ...tallies.map(t => {
                const desc = this.openmcService.getTallyDescription(t);
                return `  Tally ${t.id}: ${t.name}\n    ${desc}`;
            })
        ];

        // Show info in a message or output channel
        // For now, use a simple notification
        console.log(lines.join('\n'));
    }

    private async discoverFilesCommand(): Promise<void> {
        const workspaceRoots = this.workspaceService.tryGetRoots();
        if (workspaceRoots.length === 0) {
            return;
        }

        for (const root of workspaceRoots) {
            const rootUri = new URI((root as any).resource || root);
            const files = await this.openmcService.discoverFilesInDirectory(rootUri);
            
            const parts: string[] = [`Directory: ${rootUri.toString()}`];
            if (files.geometry) parts.push(`  Geometry: ${files.geometry.path.base}`);
            if (files.statepoint) parts.push(`  Statepoint: ${files.statepoint.path.base}`);
            if (files.source) parts.push(`  Source: ${files.source.path.base}`);

            if (parts.length > 1) {
                console.log(parts.join('\n'));
            }
        }
    }

    private async showTallyTree(statepointUri: URI): Promise<void> {
        const info = this.openmcService.getCurrentStatepoint();
        const tallies = this.openmcService.getCurrentTallies();
        
        if (tallies.length === 0 || !info) {
            return;
        }

        // Get or create the tally tree widget
        let widget = this.tallyTreeWidget;
        if (!widget || widget.isDisposed) {
            widget = await this.widgetManager.getOrCreateWidget<OpenMCTallyTreeWidget>(OpenMCTallyTreeWidget.ID);
            this.tallyTreeWidget = widget;
        }
        
        // Update the widget state
        widget.setStatepoint(statepointUri, info, tallies);
        
        // Add to right sidebar if not already there
        if (!widget.isAttached) {
            await this.shell.addWidget(widget, { area: 'right' });
        }
        
        // Activate the widget
        await this.shell.activateWidget(widget.id);
        
        // Listen for tally selection from tree (only once)
        if (!(widget as any)._selectionHandlerSet) {
            (widget as any)._selectionHandlerSet = true;
            widget.onTallySelected(async selection => {
                console.log(`[OpenMC] Tally selected: id=${selection.tallyId}, action=${selection.action}`);
                const options: TallyVisualizationOptions = {
                    tallyId: selection.tallyId,
                    score: selection.score,
                    nuclide: selection.nuclide
                };
                
                try {
                    const currentTallies = this.openmcService.getCurrentTallies();
                    const tallyInfo = currentTallies.find(t => t.id === selection.tallyId);
                    
                    if (selection.action === 'visualize') {
                        console.log(`[OpenMC] Visualizing mesh tally ${selection.tallyId}`);
                        await this.openmcService.visualizeMeshTally(statepointUri, options);
                    } else if (selection.action === 'spectrum') {
                        console.log(`[OpenMC] Plotting energy spectrum for tally ${selection.tallyId}`);
                        
                        // Resolve indices for spectrum plot
                        let scoreIdx = 0;
                        let nuclideIdx = 0;
                        if (tallyInfo) {
                            if (selection.score && tallyInfo.scores.includes(selection.score)) {
                                scoreIdx = tallyInfo.scores.indexOf(selection.score);
                            }
                            if (selection.nuclide && tallyInfo.nuclides.includes(selection.nuclide)) {
                                nuclideIdx = tallyInfo.nuclides.indexOf(selection.nuclide);
                            }
                        }

                        const data = await this.openmcService.getEnergySpectrum(
                            statepointUri, 
                            selection.tallyId, 
                            scoreIdx,
                            nuclideIdx
                        );
                        console.log(`[OpenMC] Spectrum data received:`, data);
                        const plotWidget = await this.getPlotWidget(selection.tallyId, 'spectrum');
                        plotWidget.setData(data, 'spectrum', `Tally ${selection.tallyId} Energy Spectrum`);
                        if (!plotWidget.isAttached) {
                            this.shell.addWidget(plotWidget, { area: 'main' });
                        }
                        this.shell.activateWidget(plotWidget.id);
                    } else if (selection.action === 'spatial') {
                        console.log(`[OpenMC] Plotting spatial distribution for tally ${selection.tallyId}`);
                        
                        // Resolve indices for spatial plot
                        let scoreIdx = 0;
                        let nuclideIdx = 0;
                        if (tallyInfo) {
                            if (selection.score && tallyInfo.scores.includes(selection.score)) {
                                scoreIdx = tallyInfo.scores.indexOf(selection.score);
                            }
                            if (selection.nuclide && tallyInfo.nuclides.includes(selection.nuclide)) {
                                nuclideIdx = tallyInfo.nuclides.indexOf(selection.nuclide);
                            }
                        }

                        const data = await this.openmcService.getSpatialPlot(
                            statepointUri, 
                            selection.tallyId, 
                            'z',
                            scoreIdx,
                            nuclideIdx
                        );
                        console.log(`[OpenMC] Spatial data received:`, data);
                        const plotWidget = await this.getPlotWidget(selection.tallyId, 'spatial');
                        plotWidget.setData(data, 'spatial', `Tally ${selection.tallyId} Spatial Plot (Z-axis)`);
                        if (!plotWidget.isAttached) {
                            this.shell.addWidget(plotWidget, { area: 'main' });
                        }
                        this.shell.activateWidget(plotWidget.id);
                    } else if (selection.action === 'heatmap') {
                        console.log(`[OpenMC] Creating 2D heatmap for tally ${selection.tallyId}`);
                        
                        // Resolve indices for heatmap
                        let scoreIdx = 0;
                        let nuclideIdx = 0;
                        let scoreName = 'total';
                        let nuclideName = 'total';
                        if (tallyInfo) {
                            if (selection.score && tallyInfo.scores.includes(selection.score)) {
                                scoreIdx = tallyInfo.scores.indexOf(selection.score);
                                scoreName = selection.score;
                            }
                            if (selection.nuclide && tallyInfo.nuclides.includes(selection.nuclide)) {
                                nuclideIdx = tallyInfo.nuclides.indexOf(selection.nuclide);
                                nuclideName = selection.nuclide;
                            }
                        }

                        const data = await this.openmcService.getHeatmapSlice(
                            statepointUri, 
                            selection.tallyId, 
                            'xy',
                            0,  // Start with first slice
                            scoreIdx,
                            nuclideIdx
                        );
                        console.log(`[OpenMC] Heatmap data received:`, data);
                        
                        if (data.error) {
                            this.messageService.error(`Heatmap error: ${data.error}`);
                            return;
                        }
                        
                        const heatmapWidget = await this.getHeatmapWidget(selection.tallyId, selection.score);
                        heatmapWidget.setData(
                            data,
                            statepointUri,
                            selection.tallyId,
                            scoreIdx,
                            nuclideIdx,
                            scoreName,
                            nuclideName,
                            `Tally ${selection.tallyId} 2D Heatmap`
                        );
                        if (!heatmapWidget.isAttached) {
                            this.shell.addWidget(heatmapWidget, { area: 'main' });
                        }
                        this.shell.activateWidget(heatmapWidget.id);
                    } else if (selection.action === 'spectrum-all-scores' && tallyInfo) {
                        const data = await this.openmcService.getMultiScoreSpectrum(statepointUri, selection.tallyId, tallyInfo.scores);
                        const traces = PlotlyUtils.createMultiScoreTraces(data, 'spectrum');
                        const figure: PlotlyFigure = {
                            data: traces,
                            layout: {
                                xaxis: { title: { text: 'Energy [eV]' }, type: 'log' },
                                yaxis: { title: { text: 'Tally Value' }, type: 'log' }
                            },
                            title: `Tally ${selection.tallyId} All Scores Spectrum`
                        };
                        const plotWidget = await this.getPlotWidget(selection.tallyId, 'spectrum-multi');
                        plotWidget.setFigure(figure);
                        if (!plotWidget.isAttached) {
                            this.shell.addWidget(plotWidget, { area: 'main' });
                        }
                        this.shell.activateWidget(plotWidget.id);
                    } else if (selection.action === 'spatial-all-scores' && tallyInfo) {
                        const data = await this.openmcService.getMultiScoreSpatialPlot(statepointUri, selection.tallyId, 'z', tallyInfo.scores);
                        const traces = PlotlyUtils.createMultiScoreTraces(data, 'spatial');
                        const figure: PlotlyFigure = {
                            data: traces,
                            layout: {
                                xaxis: { title: { text: 'Position [cm]' } },
                                yaxis: { title: { text: 'Tally Value' } }
                            },
                            title: `Tally ${selection.tallyId} All Scores Spatial Plot`
                        };
                        const plotWidget = await this.getPlotWidget(selection.tallyId, 'spatial-multi');
                        plotWidget.setFigure(figure);
                        if (!plotWidget.isAttached) {
                            this.shell.addWidget(plotWidget, { area: 'main' });
                        }
                        this.shell.activateWidget(plotWidget.id);
                    } else if (selection.action === 'spectrum-all-nuclides' && tallyInfo) {
                        console.log(`[OpenMC] Plotting all nuclides for tally ${selection.tallyId}`);
                        const scoreIdx = selection.score ? tallyInfo.scores.indexOf(selection.score) : 0;
                        const scoreName = selection.score || tallyInfo.scores[0];

                        const nuclideTraces = await Promise.all(tallyInfo.nuclides.map(async nuclide => {
                            const data = await this.openmcService.getEnergySpectrum(statepointUri, selection.tallyId, scoreIdx, tallyInfo.nuclides.indexOf(nuclide));
                            return PlotlyUtils.createSpectrumTrace(data, `${nuclide} (${scoreName})`);
                        }));

                        const figure: PlotlyFigure = {
                            data: nuclideTraces,
                            layout: {
                                xaxis: { title: { text: 'Energy [eV]' }, type: 'log' },
                                yaxis: { title: { text: 'Tally Value' }, type: 'log' }
                            },
                            title: `Tally ${selection.tallyId} All Nuclides - ${scoreName}`
                        };
                        const plotWidget = await this.getPlotWidget(selection.tallyId, 'spectrum-nuclides');
                        plotWidget.setFigure(figure);
                        if (!plotWidget.isAttached) {
                            this.shell.addWidget(plotWidget, { area: 'main' });
                        }
                        this.shell.activateWidget(plotWidget.id);
                    }
                } catch (error) {
                    console.error(`[OpenMC] Action ${selection.action} failed:`, error);
                    this.messageService.error(`Failed to perform action ${selection.action}: ${error}`);
                }
            });
        }
    }

    private async showTallySelectorForOverlay(geometryUri: URI, statepointUri: URI): Promise<void> {
        // Load tallies from statepoint
        await this.openmcService.loadTallyList(statepointUri);
        const tallies = this.openmcService.getCurrentTallies();
        
        if (tallies.length === 0) {
            return;
        }

        const selector = new OpenMCTallySelector(this.quickInput);
        const selection = await selector.show(tallies);

        if (selection) {
            const options: TallyVisualizationOptions = {
                tallyId: selection.tallyId,
                score: selection.score,
                nuclide: selection.nuclide,
                colorMap: selection.colorMap
            };

            await this.openmcService.visualizeTallyOnGeometry(geometryUri, statepointUri, options);
        }
    }

    private async getH5Files(): Promise<QuickPickValue<string>[]> {
        // Return empty - user will input path manually
        // In a full implementation, this would walk the workspace directories
        return [];
    }

    private async getStatepointFiles(): Promise<QuickPickValue<string>[]> {
        return [];
    }

    private async getSourceFiles(): Promise<QuickPickValue<string>[]> {
        return [];
    }

    private async getGeometryFiles(): Promise<QuickPickValue<string>[]> {
        return [];
    }

    private async openDepletionViewerCommand(): Promise<void> {
        // Find depletion results files
        const files = await this.getDepletionFiles();
        
        if (files.length === 0) {
            this.messageService.error('No depletion_results.h5 files found in workspace');
            return;
        }

        // If only one file, open it directly
        if (files.length === 1) {
            await this.openDepletionFile(files[0].value, files[0].label);
            return;
        }

        // Otherwise show picker
        const selection = await this.quickInput.showQuickPick(files, {
            title: 'Select Depletion Results File',
            placeholder: 'Choose a depletion_results.h5 file'
        });

        if (selection) {
            await this.openDepletionFile(selection.value, selection.label);
        }
    }

    private async openDepletionFile(filePath: string, fileName: string): Promise<void> {
        try {
            const widget = await this.widgetManager.getOrCreateWidget<OpenMCDepletionWidget>(
                OpenMCDepletionWidget.ID,
                { id: `${OpenMCDepletionWidget.ID}:${filePath}` } as any
            );

            widget.setDepletionFile(new URI(filePath), fileName);

            if (!widget.isAttached) {
                this.shell.addWidget(widget, { area: 'main' });
            }
            this.shell.activateWidget(widget.id);
        } catch (error) {
            this.messageService.error(`Failed to open depletion file: ${error}`);
        }
    }

    private async getDepletionFiles(): Promise<QuickPickValue<string>[]> {
        const workspace = this.workspaceService.workspace;
        if (!workspace) {
            return [];
        }

        const files: QuickPickValue<string>[] = [];
        
        try {
            const rootUri = workspace.resource;
            
            const collectH5Files = async (uri: URI): Promise<void> => {
                try {
                    const dirStat = await this.fileService.resolve(uri);
                    if (dirStat.children) {
                        for (const child of dirStat.children) {
                            if (child.isFile && child.name.includes('depletion') && child.name.endsWith('.h5')) {
                                files.push({
                                    value: child.resource.toString(),
                                    label: child.name,
                                    description: this.labelProvider.getLongName(child.resource)
                                });
                            } else if (child.isDirectory && !child.name.startsWith('.') && files.length < 20) {
                                // Recurse into subdirectories (limit to prevent too many requests)
                                await collectH5Files(child.resource);
                            }
                        }
                    }
                } catch (e) {
                    // Ignore errors for individual directories
                }
            };

            await collectH5Files(rootUri);
        } catch (e) {
            console.error('[OpenMC] Failed to search for depletion files:', e);
        }

        return files;
    }

    private async plotXSCommand(): Promise<void> {
        const widget = await this.getOrCreateXSPlotWidget();
        
        if (!widget.isAttached) {
            await this.shell.addWidget(widget, { area: 'right' });
        }
        
        await this.shell.activateWidget(widget.id);
    }
}

/**
 * View contribution for XS Plot widget - adds icon to sidebar
 */
@injectable()
export class XSPlotViewContribution extends AbstractViewContribution<XSPlotWidget> {
    
    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    constructor() {
        super({
            widgetId: XSPlotWidget.ID,
            widgetName: XSPlotWidget.LABEL,
            defaultWidgetOptions: {
                area: 'right',
                rank: 200
            },
            toggleCommandId: 'xsPlot.toggle',
            toggleKeybinding: 'ctrlcmd+shift+x'
        });
    }

    override registerCommands(commands: CommandRegistry): void {
        super.registerCommands(commands);
        
        commands.registerCommand({
            id: 'xsPlot.open',
            label: 'OpenMC: Open Cross-Section Plot'
        }, {
            execute: () => this.openView({ reveal: true, activate: true })
        });
    }

    async initializeLayout(app: FrontendApplication): Promise<void> {
        // Don't auto-open by default, but the icon will be available in the sidebar
    }
}

/**
 * View contribution for OpenMC Tallies widget - adds icon to sidebar
 */
@injectable()
export class OpenMCTalliesViewContribution extends AbstractViewContribution<OpenMCTallyTreeWidget> {
    
    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(OpenMCService)
    protected readonly openmcService: OpenMCService;

    constructor() {
        super({
            widgetId: OpenMCTallyTreeWidget.ID,
            widgetName: OpenMCTallyTreeWidget.LABEL,
            defaultWidgetOptions: {
                area: 'right',
                rank: 100
            },
            toggleCommandId: 'openmcTallies.toggle',
            toggleKeybinding: 'ctrlcmd+shift+t'
        });
    }

    override registerCommands(commands: CommandRegistry): void {
        super.registerCommands(commands);
        
        commands.registerCommand({
            id: 'openmcTallies.open',
            label: 'OpenMC: Open Tallies'
        }, {
            execute: () => this.openView({ reveal: true, activate: true }),
            isEnabled: () => this.openmcService.getCurrentStatepoint() !== null
        });
    }

    async initializeLayout(app: FrontendApplication): Promise<void> {
        // Don't auto-open by default, but the icon will be available in the sidebar
    }
}
