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

import { injectable, inject } from '@theia/core/shared/inversify';
import { MessageService } from '@theia/core/lib/common';
import { QuickInputService, QuickPickValue, LabelProvider, ApplicationShell, WidgetManager } from '@theia/core/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { OpenMCService, TallyVisualizationOptions } from '../openmc-service';
import { OpenMCTallyTreeWidget, TallySelection } from '../widgets/statepoint/openmc-tally-tree';
import { OpenMCStatepointViewerWidget, StatepointTallySelection } from '../widgets/statepoint/statepoint-viewer';
import { PlotlyService } from '../../../plotly/plotly-service';
import { PlotlyUtils } from '../../../plotly/plotly-utils';
import { PlotlyFigure } from '../../../../common/base-visualizer-protocol';
import { OpenMCFileDiscovery } from './openmc-file-discovery';
import { HDF5_FILE_FILTER } from '../../../../common/openmc-protocol';
import { OpenMCOverlayContribution } from './openmc-overlay-contribution';
import { OpenMCWidgetFactory } from '../services/openmc-widget-factory';

@injectable()
export class OpenMCStatepointContribution {
    @inject(OpenMCService)
    protected readonly openmcService: OpenMCService;

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(QuickInputService)
    protected readonly quickInput: QuickInputService;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(FileDialogService)
    protected readonly fileDialogService: FileDialogService;

    @inject(LabelProvider)
    protected readonly labelProvider: LabelProvider;

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(PlotlyService)
    protected readonly plotlyService: PlotlyService;

    @inject(OpenMCFileDiscovery)
    protected readonly fileDiscovery: OpenMCFileDiscovery;

    @inject(OpenMCOverlayContribution)
    protected readonly overlay: OpenMCOverlayContribution;

    @inject(OpenMCWidgetFactory)
    protected readonly widgetFactory: OpenMCWidgetFactory;

    private tallyTreeWidget: OpenMCTallyTreeWidget | undefined;
    private statepointViewerWidget: OpenMCStatepointViewerWidget | undefined;

    initialize(): void {
        // Track widget creation and attach event handlers
        this.widgetManager.onDidCreateWidget(async ({ widget }) => {
            if (widget instanceof OpenMCTallyTreeWidget) {
                this.tallyTreeWidget = widget;
                
                widget.onTallySelected(async (selection: TallySelection) => {
                    await this.handleTallySelection(selection);
                });
            }
        });
    }

    async loadStatepointCommand(): Promise<void> {
        let files = await this.fileDiscovery.getStatepointFiles();
        
        const options: QuickPickValue<string>[] = [
            { value: '__browse__', label: '$(folder-opened) Browse...', description: 'Select statepoint file from any location' }
        ];
        
        if (files.length > 0) {
            options.push({ type: 'separator', label: 'Workspace Files' } as any, ...files);
        }

        const uri = await this.quickInput.showQuickPick(
            options,
            {
                title: 'Select OpenMC Statepoint File',
                placeholder: 'Choose a statepoint.[values].h5 file'
            }
        );

        if (uri) {
            if (uri.value === '__browse__') {
                const fileUri = await this.fileDialogService.showOpenDialog({
                    title: 'Select Statepoint File',
                    openLabel: 'Open',
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    filters: HDF5_FILE_FILTER
                });
                
                if (fileUri) {
                    const uri = Array.isArray(fileUri) ? fileUri[0] : fileUri;
                    await this.openStatepointViewer(uri);
                }
            } else {
                await this.openStatepointViewer(new URI(uri.value));
            }
        }
    }

    async visualizeTallyCommand(): Promise<void> {
        const statepoint = this.openmcService.getCurrentStatepoint();
        if (!statepoint) {
            return;
        }

        await this.showTallyTree(new URI(statepoint.file));
    }

    async showTallyInfoCommand(): Promise<void> {
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

    async openTalliesWidget(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget<OpenMCTallyTreeWidget>(OpenMCTallyTreeWidget.ID);
        this.tallyTreeWidget = widget;
        if (!widget.isAttached) {
            await this.shell.addWidget(widget, { area: 'right' });
        }
        await this.shell.activateWidget(widget.id);
    }

    async showTallyTree(statepointUri: URI, geometryUri?: URI): Promise<void> {
        const info = this.openmcService.getCurrentStatepoint();
        const tallies = this.openmcService.getCurrentTallies();
        
        // Get or create the tally tree widget
        let widget = this.tallyTreeWidget;
        
        if (tallies.length === 0 || !info) {
            // Clear the widget if no tallies
            if (widget && !widget.isDisposed) {
                widget.clearStatepoint();
            }
            return;
        }

        // Create widget if needed
        if (!widget || widget.isDisposed) {
            widget = await this.widgetManager.getOrCreateWidget<OpenMCTallyTreeWidget>(OpenMCTallyTreeWidget.ID);
            this.tallyTreeWidget = widget;
        }
        
        // Store geometry URI for overlay (if provided)
        if (geometryUri) {
            (widget as any)._geometryUri = geometryUri;
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
        // Note: Handlers are also attached in initialize() via onDidCreateWidget
        if (!(widget as any)._handlerSet) {
            (widget as any)._handlerSet = true;
            
            // Handle tally selection - delegates to handleTallySelection method
            widget.onTallySelected(async (selection: TallySelection) => {
                await this.handleTallySelection(selection);
            });
        }
    }

    async openStatepointViewer(statepointUri: URI): Promise<void> {
        const info = this.openmcService.getCurrentStatepointFull();
        const tallies = this.openmcService.getCurrentTallies();
        const kData = await this.openmcService.getKGenerationData(statepointUri);
        
        if (!info) {
            this.messageService.error('Failed to load statepoint information');
            return;
        }

        // Create unique widget ID based on file path
        const widgetId = `${OpenMCStatepointViewerWidget.ID}:${statepointUri.toString()}`;
        
        // Get or create the statepoint viewer widget
        let widget = this.statepointViewerWidget;
        
        if (!widget || widget.isDisposed || widget.id !== widgetId) {
            widget = await this.widgetManager.getOrCreateWidget<OpenMCStatepointViewerWidget>(
                OpenMCStatepointViewerWidget.ID,
                { id: widgetId } as any
            );
            this.statepointViewerWidget = widget;
            
            // Set up event handlers
            widget.onTallySelected(async (selection: StatepointTallySelection) => {
                await this.handleStatepointTallySelection(selection);
            });
            
            widget.onViewTallyTree(async () => {
                await this.showTallyTree(statepointUri);
            });
            
            widget.onViewSource(async () => {
                await this.openmcService.visualizeStatepointSource(statepointUri);
            });
        }
        
        // Update the widget state
        widget.setStatepoint(statepointUri, info, tallies, kData || undefined);
        
        // Add to main area if not already there
        if (!widget.isAttached) {
            await this.shell.addWidget(widget, { area: 'main' });
        }
        
        // Activate the widget
        await this.shell.activateWidget(widget.id);
    }

    async handleStatepointTallySelection(selection: StatepointTallySelection): Promise<void> {
        const currentStatepoint = this.openmcService.getCurrentStatepoint();
        if (!currentStatepoint) {
            this.messageService.error('No statepoint loaded');
            return;
        }
        const currentStatepointUri = new URI(currentStatepoint.file);
        
        const options: TallyVisualizationOptions = {
            tallyId: selection.tallyId,
            score: selection.score,
            nuclide: selection.nuclide || 'total'
        };
        
        try {
            if (selection.action === 'view-3d') {
                await this.openmcService.visualizeMeshTally(currentStatepointUri, options);
            } else if (selection.action === 'overlay-geometry') {
                await this.overlay.handleOverlayOnGeometry(selection, currentStatepointUri);
            } else if (selection.action === 'overlay-source') {
                await this.overlay.handleOverlayOnGeometry(selection, currentStatepointUri, undefined, true);
            } else if (selection.action === 'heatmap') {
                // Handle heatmap - delegate to existing heatmap logic
                const tallySelection: TallySelection = {
                    tallyId: selection.tallyId,
                    score: selection.score,
                    nuclide: selection.nuclide,
                    action: 'heatmap'
                };
                await this.handleTallySelection(tallySelection);
            } else if (selection.action === 'spectrum') {
                // Handle spectrum - delegate to existing spectrum logic
                const tallySelection: TallySelection = {
                    tallyId: selection.tallyId,
                    score: selection.score,
                    nuclide: selection.nuclide,
                    action: 'spectrum'
                };
                await this.handleTallySelection(tallySelection);
            } else if (selection.action === 'spatial') {
                // Handle spatial - delegate to existing spatial logic
                const tallySelection: TallySelection = {
                    tallyId: selection.tallyId,
                    score: selection.score,
                    nuclide: selection.nuclide,
                    action: 'spatial'
                };
                await this.handleTallySelection(tallySelection);
            }
        } catch (error) {
            console.error('[OpenMC] Error handling tally selection:', error);
            this.messageService.error(`Failed to visualize tally: ${error}`);
        }
    }

    async handleTallySelection(selection: TallySelection): Promise<void> {
        console.log(`[OpenMC] Tally selected: id=${selection.tallyId}, action=${selection.action}`);
        
        // Get CURRENT statepoint URI (not the captured one from closure)
        const currentStatepoint = this.openmcService.getCurrentStatepoint();
        if (!currentStatepoint) {
            this.messageService.error('No statepoint loaded');
            return;
        }
        const currentStatepointUri = new URI(currentStatepoint.file);
        
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
                await this.openmcService.visualizeMeshTally(currentStatepointUri, options);
            } else if (selection.action === 'overlay-geometry') {
                console.log(`[OpenMC] Overlaying tally ${selection.tallyId} on geometry`);
                // Use stored geometry URI if available
                const storedGeometryUri = this.tallyTreeWidget ? (this.tallyTreeWidget as any)._geometryUri as URI | undefined : undefined;
                await this.overlay.handleOverlayOnGeometry(selection, currentStatepointUri, storedGeometryUri);
            } else if (selection.action === 'overlay-source') {
                console.log(`[OpenMC] Overlaying tally ${selection.tallyId} on geometry with source`);
                const storedGeometryUri = this.tallyTreeWidget ? (this.tallyTreeWidget as any)._geometryUri as URI | undefined : undefined;
                await this.overlay.handleOverlayOnGeometry(selection, currentStatepointUri, storedGeometryUri, true);
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
                    currentStatepointUri, 
                    selection.tallyId, 
                    scoreIdx,
                    nuclideIdx
                );
                const plotWidget = await this.widgetFactory.getPlotWidget(selection.tallyId, 'spectrum');
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
                    currentStatepointUri, 
                    selection.tallyId, 
                    'z',
                    scoreIdx,
                    nuclideIdx
                );
                const plotWidget = await this.widgetFactory.getPlotWidget(selection.tallyId, 'spatial');
                plotWidget.setData(data, 'spatial', `Tally ${selection.tallyId} Spatial Plot (Z-axis)`);
                if (!plotWidget.isAttached) {
                    this.shell.addWidget(plotWidget, { area: 'main' });
                }
                this.shell.activateWidget(plotWidget.id);
            } else if (selection.action === 'heatmap') {
                
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
                    currentStatepointUri, 
                    selection.tallyId, 
                    'xy',
                    0,  // Start with first slice
                    scoreIdx,
                    nuclideIdx
                );
                
                if (data.error) {
                    this.messageService.error(`Heatmap error: ${data.error}`);
                    return;
                }
                
                const heatmapWidget = await this.widgetFactory.getHeatmapWidget(selection.tallyId, selection.score);
                heatmapWidget.setData(
                    data,
                    currentStatepointUri,
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
                const data = await this.openmcService.getMultiScoreSpectrum(currentStatepointUri, selection.tallyId, tallyInfo.scores);
                const traces = PlotlyUtils.createMultiScoreTraces(data, 'spectrum');
                const figure: PlotlyFigure = {
                    data: traces,
                    layout: {
                        xaxis: { title: { text: 'Energy [eV]' }, type: 'log' },
                        yaxis: { title: { text: 'Tally Value' }, type: 'log' }
                    },
                    title: `Tally ${selection.tallyId} All Scores Spectrum`
                };
                const plotWidget = await this.widgetFactory.getPlotWidget(selection.tallyId, 'spectrum-multi');
                plotWidget.setFigure(figure);
                if (!plotWidget.isAttached) {
                    this.shell.addWidget(plotWidget, { area: 'main' });
                }
                this.shell.activateWidget(plotWidget.id);
            } else if (selection.action === 'spatial-all-scores' && tallyInfo) {
                const data = await this.openmcService.getMultiScoreSpatialPlot(currentStatepointUri, selection.tallyId, 'z', tallyInfo.scores);
                const traces = PlotlyUtils.createMultiScoreTraces(data, 'spatial');
                const figure: PlotlyFigure = {
                    data: traces,
                    layout: {
                        xaxis: { title: { text: 'Position [cm]' } },
                        yaxis: { title: { text: 'Tally Value' } }
                    },
                    title: `Tally ${selection.tallyId} All Scores Spatial Plot`
                };
                const plotWidget = await this.widgetFactory.getPlotWidget(selection.tallyId, 'spatial-multi');
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
                    const data = await this.openmcService.getEnergySpectrum(currentStatepointUri, selection.tallyId, scoreIdx, tallyInfo.nuclides.indexOf(nuclide));
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
                const plotWidget = await this.widgetFactory.getPlotWidget(selection.tallyId, 'spectrum-nuclides');
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
    }
}
