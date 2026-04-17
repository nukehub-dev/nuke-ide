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

import * as React from 'react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import { Message } from '@lumino/messaging';
import './statepoint-viewer.css';
import { Emitter, Event } from '@theia/core';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { QuickInputService, WidgetManager, ApplicationShell } from '@theia/core/lib/browser';
import { OpenMCService } from './openmc-service';
import { 
    OpenMCStatepointFullInfo, 
    OpenMCTallyInfo, 
    OpenMCKGenerationData
} from '../../common/visualizer-protocol';
import { URI } from '@theia/core/lib/common/uri';
import { SimpleLoadingSpinner, EmptyState, LoadingAnimations } from 'nuke-essentials/lib/theme/browser/components/loading-spinner';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { PlotlyComponent } from '../plotly/plotly-component';

export interface StatepointTallySelection {
    tallyId: number;
    action: 'view-3d' | 'overlay-geometry' | 'heatmap' | 'spectrum' | 'spatial';
    score?: string;
    nuclide?: string;
}

@injectable()
export class OpenMCStatepointViewerWidget extends ReactWidget {
    static readonly ID = 'openmc-statepoint-viewer-widget';
    static readonly LABEL = 'OpenMC Statepoint Viewer';

    @inject(OpenMCService)
    protected readonly openmcService!: OpenMCService;

    @inject(FileDialogService)
    protected readonly fileDialogService!: FileDialogService;

    @inject(QuickInputService)
    protected readonly quickInput!: QuickInputService;

    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    private statepointUri: URI | null = null;
    private statepointInfo: OpenMCStatepointFullInfo | null = null;
    private tallies: OpenMCTallyInfo[] = [];
    private kGenerationData: OpenMCKGenerationData | null = null;
    private isLoading: boolean = false;
    private loadingMessage: string = 'Loading...';
    private activeTab: string = 'overview';

    private readonly _onTallySelected = new Emitter<StatepointTallySelection>();
    readonly onTallySelected: Event<StatepointTallySelection> = this._onTallySelected.event;

    private readonly _onViewTallyTree = new Emitter<void>();
    readonly onViewTallyTree: Event<void> = this._onViewTallyTree.event;

    private readonly _onViewSource = new Emitter<void>();
    readonly onViewSource: Event<void> = this._onViewSource.event;

    private onTallySelectedHandler: ((selection: StatepointTallySelection) => void) | undefined;
    private onViewTallyTreeHandler: (() => void) | undefined;
    private onViewSourceHandler: (() => void) | undefined;

    setEventHandlers(
        onTallySelected: (selection: StatepointTallySelection) => void,
        onViewTallyTree: () => void,
        onViewSource: () => void
    ): void {
        this.onTallySelectedHandler = onTallySelected;
        this.onViewTallyTreeHandler = onViewTallyTree;
        this.onViewSourceHandler = onViewSource;
    }

    private fireTallySelected(selection: StatepointTallySelection): void {
        this._onTallySelected.fire(selection);
        if (this.onTallySelectedHandler) {
            this.onTallySelectedHandler(selection);
        }
    }

    private fireViewTallyTree(): void {
        this._onViewTallyTree.fire();
        if (this.onViewTallyTreeHandler) {
            this.onViewTallyTreeHandler();
        }
    }

    private fireViewSource(): void {
        this._onViewSource.fire();
        if (this.onViewSourceHandler) {
            this.onViewSourceHandler();
        }
    }

    getStatepointUri(): URI | null {
        return this.statepointUri;
    }

    private async getOrCreatePlotWidget(widgetId: string): Promise<any> {
        const existingWidget = this.shell.widgets.find(w => w.id === widgetId);
        if (existingWidget) {
            return existingWidget;
        }
        const { OpenMCPlotWidget } = await import('./openmc-plot-widget');
        return this.widgetManager.getOrCreateWidget<any>(OpenMCPlotWidget.ID, { id: widgetId } as any);
    }

    private async getOrCreateHeatmapWidget(widgetId: string): Promise<any> {
        const existingWidget = this.shell.widgets.find(w => w.id === widgetId);
        if (existingWidget) {
            return existingWidget;
        }
        const { OpenMCHeatmapWidget } = await import('./openmc-heatmap-widget');
        return this.widgetManager.getOrCreateWidget<any>(OpenMCHeatmapWidget.ID, { id: widgetId } as any);
    }
    
    private async getOrCreateTallyTreeWidget(): Promise<any> {
        const existingWidget = this.shell.widgets.find(w => w.id === 'openmc-tally-tree-widget');
        if (existingWidget) {
            return existingWidget;
        }
        const { OpenMCTallyTreeWidget } = await import('./openmc-tally-tree');
        return this.widgetManager.getOrCreateWidget<any>(OpenMCTallyTreeWidget.ID);
    }
    
    private async openWidgetInMainArea(widget: any, widgetId: string): Promise<void> {
        if (!widget.isAttached) {
            await this.shell.addWidget(widget, { area: 'main' });
        }
        await this.shell.activateWidget(widgetId);
    }

    private async openWidgetInRightArea(widget: any, widgetId: string): Promise<void> {
        if (!widget.isAttached) {
            await this.shell.addWidget(widget, { area: 'right' });
        }
        await this.shell.activateWidget(widgetId);
    }

    setLoading(loading: boolean, message: string = 'Loading...'): void {
        this.isLoading = loading;
        this.loadingMessage = message;
        this.update();
    }

    @postConstruct()
    protected init(): void {
        this.id = OpenMCStatepointViewerWidget.ID;
        this.title.label = OpenMCStatepointViewerWidget.LABEL;
        this.title.caption = OpenMCStatepointViewerWidget.LABEL;
        this.title.iconClass = codicon('database');
        this.title.closable = true;
        
        this.node.tabIndex = 0;
        this.update();
    }

    focus(): void {
        this.node.focus();
    }

    setStatepoint(uri: URI, info: OpenMCStatepointFullInfo, tallies: OpenMCTallyInfo[], kData?: OpenMCKGenerationData): void {
        this.statepointUri = uri;
        this.statepointInfo = info;
        this.tallies = tallies;
        this.kGenerationData = kData || null;
        this.update();
    }

    clearStatepoint(): void {
        this.statepointUri = null;
        this.statepointInfo = null;
        this.tallies = [];
        this.kGenerationData = null;
        this.update();
    }

    protected async handleBrowse(): Promise<void> {
        try {
            const fileUri = await this.fileDialogService.showOpenDialog({
                title: 'Select OpenMC Statepoint File',
                openLabel: 'Open',
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'HDF5 Files': ['h5'],
                    'All Files': ['*']
                }
            });
            
            if (fileUri) {
                const uri = Array.isArray(fileUri) ? fileUri[0] : fileUri;
                                
const handlers = {
                    onTallySelected: async (selection: StatepointTallySelection) => {
                        const statepointUri = this.statepointUri;
                        if (!statepointUri) return;
                        
                        const options = { tallyId: selection.tallyId, score: selection.score || 'total', nuclide: selection.nuclide || 'total' };
                        
                        if (selection.action === 'view-3d') {
                            await this.openmcService.visualizeMeshTally(statepointUri, options);
                        } else if (selection.action === 'overlay-geometry') {
                            // Show file dialog for user to select geometry file (DAGMC or XML)
                            const fileUri = await this.fileDialogService.showOpenDialog({
                                title: 'Select Geometry File',
                                openLabel: 'Select',
                                canSelectFiles: true,
                                canSelectFolders: false,
                                canSelectMany: false,
                                filters: {
                                    'Geometry Files': ['h5m', 'xml'],
                                    'DAGMC Files': ['h5m'],
                                    'OpenMC Geometry': ['xml'],
                                    'All Files': ['*']
                                }
                            });
                            
                            if (fileUri) {
                                const geometryUri = Array.isArray(fileUri) ? fileUri[0] : fileUri;
                                // Validate the URI has a valid path
                                if (!geometryUri || !geometryUri.path.toString() || geometryUri.path.toString() === '/') {
                                    console.error('[StatepointViewer] Invalid geometry URI:', geometryUri);
                                    return;
                                }
                                
                                const isGeometryXml = geometryUri.path.toString().endsWith('.xml') && !geometryUri.path.toString().endsWith('.h5m');
                                
                                // Skip graveyard filtering for XML files
                                let filterGraveyard = false;
                                if (!isGeometryXml) {
                                    // Ask about graveyard filtering only for DAGMC files
                                    const filterChoice = await this.quickInput.showQuickPick([
                                        { value: 'filter', label: '$(eye-closed) Filter Graveyard', description: 'Hide large graveyard surfaces' },
                                        { value: 'nofilter', label: '$(eye) Show Full Geometry', description: 'Include graveyard surfaces' }
                                    ], {
                                        title: 'Graveyard Surface Filtering',
                                        placeholder: 'Select visualization mode'
                                    });
                                    
                                    if (!filterChoice) return;
                                    filterGraveyard = filterChoice.value === 'filter';
                                }
                                
                                const options: any = { 
                                    tallyId: selection.tallyId, 
                                    score: selection.score || 'total', 
                                    nuclide: selection.nuclide || 'total',
                                    filterGraveyard
                                };
                                
                                await this.openmcService.visualizeTallyOnGeometry(geometryUri, statepointUri, options);
                            }
                        } else if (selection.action === 'heatmap') {
                            const tallyInfo = this.openmcService.getCurrentTallies().find(t => t.id === selection.tallyId);
                            if (tallyInfo) {
                                let scoreIdx = 0;
                                let nuclideIdx = 0;
                                if (selection.score && tallyInfo.scores.includes(selection.score)) {
                                    scoreIdx = tallyInfo.scores.indexOf(selection.score);
                                }
                                if (selection.nuclide && tallyInfo.nuclides.includes(selection.nuclide)) {
                                    nuclideIdx = tallyInfo.nuclides.indexOf(selection.nuclide);
                                }
                                const data = await this.openmcService.getHeatmapSlice(statepointUri, selection.tallyId, 'xy', 0, scoreIdx, nuclideIdx);
                                const heatmapWidgetId = `${(await import('./openmc-heatmap-widget')).OpenMCHeatmapWidget.ID}:${selection.tallyId}:${selection.score || 'default'}`;
                                const heatmapWidget = await this.getOrCreateHeatmapWidget(heatmapWidgetId);
                                heatmapWidget.setData(
                                    data,
                                    statepointUri,
                                    selection.tallyId,
                                    scoreIdx,
                                    nuclideIdx,
                                    selection.score || 'total',
                                    selection.nuclide || 'total',
                                    `Tally ${selection.tallyId} 2D Heatmap`
                                );
                                await this.openWidgetInMainArea(heatmapWidget, heatmapWidgetId);
                            }
                        } else if (selection.action === 'spectrum') {
                            const tallyInfo = this.openmcService.getCurrentTallies().find(t => t.id === selection.tallyId);
                            if (tallyInfo) {
                                let scoreIdx = 0;
                                let nuclideIdx = 0;
                                if (selection.score && tallyInfo.scores.includes(selection.score)) {
                                    scoreIdx = tallyInfo.scores.indexOf(selection.score);
                                }
                                if (selection.nuclide && tallyInfo.nuclides.includes(selection.nuclide)) {
                                    nuclideIdx = tallyInfo.nuclides.indexOf(selection.nuclide);
                                }
                                const data = await this.openmcService.getEnergySpectrum(statepointUri, selection.tallyId, scoreIdx, nuclideIdx);
                                const { OpenMCPlotWidget } = await import('./openmc-plot-widget');
                                const widgetId = `${OpenMCPlotWidget.ID}:${selection.tallyId}:spectrum`;
                                const plotWidget = await this.getOrCreatePlotWidget(widgetId);
                                (plotWidget as any).setData(data, 'spectrum', `Tally ${selection.tallyId} Energy Spectrum`);
                                await this.openWidgetInMainArea(plotWidget, widgetId);
                            }
                        } else if (selection.action === 'spatial') {
                            const tallyInfo = this.openmcService.getCurrentTallies().find(t => t.id === selection.tallyId);
                            if (tallyInfo) {
                                let scoreIdx = 0;
                                let nuclideIdx = 0;
                                if (selection.score && tallyInfo.scores.includes(selection.score)) {
                                    scoreIdx = tallyInfo.scores.indexOf(selection.score);
                                }
                                if (selection.nuclide && tallyInfo.nuclides.includes(selection.nuclide)) {
                                    nuclideIdx = tallyInfo.nuclides.indexOf(selection.nuclide);
                                }
                                const data = await this.openmcService.getSpatialPlot(statepointUri, selection.tallyId, 'z', scoreIdx, nuclideIdx);
                                const { OpenMCPlotWidget } = await import('./openmc-plot-widget');
                                const widgetId = `${OpenMCPlotWidget.ID}:${selection.tallyId}:spatial`;
                                const plotWidget = await this.getOrCreatePlotWidget(widgetId);
                                (plotWidget as any).setData(data, 'spatial', `Tally ${selection.tallyId} Spatial Plot (Z-axis)`);
                                await this.openWidgetInMainArea(plotWidget, widgetId);
                            }
                        }
                    },
                    onViewTallyTree: async () => {
                        // Fire event for external listeners
                        this._onViewTallyTree.fire();
                        
                        // Also directly handle - get or create tally tree widget
                        const statepointUri = this.statepointUri;
                        if (!statepointUri) return;
                        
                        // Load statepoint first (like tally-tree does)
                        await this.openmcService.loadStatepoint(statepointUri);
                        const info = this.openmcService.getCurrentStatepoint();
                        const tallies = this.openmcService.getCurrentTallies();
                        if (info && tallies.length > 0) {
                            const widget = await this.getOrCreateTallyTreeWidget();
                            widget.setStatepoint(statepointUri, info, tallies);
                            await this.openWidgetInRightArea(widget, 'openmc-tally-tree-widget');
                        }
                    },
                    onViewSource: async () => {
                        const statepointUri = this.statepointUri;
                        if (statepointUri) {
                            // Fire event for external listeners
                            this._onViewSource.fire();
                            await this.openmcService.visualizeStatepointSource(statepointUri);
                        }
                    }
                };
                
                await this.loadStatepoint(uri, handlers);
            }
        } catch (error) {
            console.error('[StatepointViewer] Error browsing for file:', error);
        }
    }

    protected async loadStatepoint(uri: URI, handlers?: {
        onTallySelected?: (selection: StatepointTallySelection) => void;
        onViewTallyTree?: () => void;
        onViewSource?: () => void;
    }): Promise<void> {
        this.setLoading(true);
        
        if (handlers) {
            this.setEventHandlers(
                handlers.onTallySelected || (() => {}),
                handlers.onViewTallyTree || (() => {}),
                handlers.onViewSource || (() => {})
            );
        }
        
        try {
            await this.openmcService.loadStatepointFull(uri);
            const info = this.openmcService.getCurrentStatepointFull();
            const tallies = this.openmcService.getCurrentTallies();
            const kData = await this.openmcService.getKGenerationData(uri);
            if (info) {
                this.setStatepoint(uri, info, tallies, kData);
            }
        } catch (error) {
            console.error('[StatepointViewer] Error loading statepoint:', error);
        } finally {
            this.setLoading(false);
        }
    }

    protected handleClose(): void {
        this.openmcService.clearStatepoint();
        this.clearStatepoint();
    }

    protected setActiveTab(tab: string): void {
        this.activeTab = tab;
        this.update();
    }

    protected render(): React.ReactNode {
        if (this.isLoading) {
            return (
                <div className="statepoint-viewer statepoint-viewer--empty">
                    <LoadingAnimations />
                    <SimpleLoadingSpinner message={this.loadingMessage} />
                </div>
            );
        }

        if (!this.statepointInfo) {
            return (
                <div className="statepoint-viewer statepoint-viewer--empty">
                    <EmptyState 
                        icon="database"
                        message="No statepoint file loaded"
                        actionLabel="Browse Statepoint File"
                        onAction={() => this.handleBrowse()}
                    />
                </div>
            );
        }

        const fileName = this.statepointUri?.path.base || 'Unknown';
        const info = this.statepointInfo;

        return (
            <div className="statepoint-viewer">
                {/* Professional Header */}
                <div className="header">
                    <div className="header-main">
                        <div className="file-info">
                            <i className={codicon('database')}></i>
                            <div>
                                <div className="file-name">{fileName}</div>
                                <div className="file-path">{this.statepointUri?.path.toString()}</div>
                            </div>
                        </div>
                        <div className="header-actions">
                            <span className={`run-mode run-mode-${info.runMode}`}>{info.runMode}</span>
                            <Tooltip content="Close" position="top">
                                <button className="close-btn" onClick={() => this.handleClose()}>
                                    <i className={codicon('close')}></i>
                                </button>
                            </Tooltip>
                        </div>
                    </div>
                    
                    {/* Tab Navigation */}
                    <div className="tabs">
                        <button 
                            className={`tab ${this.activeTab === 'overview' ? 'active' : ''}`}
                            onClick={() => this.setActiveTab('overview')}
                        >
                            <i className={codicon('dashboard')}></i>
                            Overview
                        </button>
                        <button 
                            className={`tab ${this.activeTab === 'kinetics' ? 'active' : ''}`}
                            onClick={() => this.setActiveTab('kinetics')}
                        >
                            <i className={codicon('flame')}></i>
                            K-Effective
                        </button>
                        <button 
                            className={`tab ${this.activeTab === 'tallies' ? 'active' : ''}`}
                            onClick={() => this.setActiveTab('tallies')}
                        >
                            <i className={codicon('graph')}></i>
                            Tallies ({this.tallies.length})
                        </button>
                        <button 
                            className={`tab ${this.activeTab === 'performance' ? 'active' : ''}`}
                            onClick={() => this.setActiveTab('performance')}
                        >
                            <i className={codicon('pulse')}></i>
                            Performance
                        </button>
                    </div>
                </div>

                {/* Content Area */}
                <div className="content">
                    {this.activeTab === 'overview' && this.renderOverview()}
                    {this.activeTab === 'kinetics' && this.renderKinetics()}
                    {this.activeTab === 'tallies' && this.renderTallies()}
                    {this.activeTab === 'performance' && this.renderPerformance()}
                </div>
            </div>
        );
    }

    private renderOverview(): React.ReactNode {
        const info = this.statepointInfo!;
        
        const activeBatches = info.nBatches - info.nInactive;
        const totalParticles = info.nParticles * activeBatches;
        
        return (
            <div className="tab-content">
                {/* Hero Section - k-effective highlight */}
                {info.kCombined && (
                    <div className="overview-hero">
                        <div className="hero-content">
                            <div className="hero-k">
                                <div className="hero-k-value">{info.kCombined[0].toFixed(5)}</div>
                                <div className="hero-k-uncertainty">± {info.kCombined[1].toFixed(5)}</div>
                            </div>
                            <div className="hero-label">Combined k-effective</div>
                            {this.kGenerationData && (
                                <div className="hero-stats">
                                    <div className="hero-stat">
                                        <span className="hero-stat-value">{this.kGenerationData.batches.length}</span>
                                        <span className="hero-stat-label">Generations</span>
                                    </div>
                                    <div className="hero-stat">
                                        <span className="hero-stat-value">{(info.kCombined[1] / info.kCombined[0] * 100).toFixed(2)}%</span>
                                        <span className="hero-stat-label">Relative Error</span>
                                    </div>
                                </div>
                            )}
                        </div>
                        <div className="hero-actions">
                            <button className="hero-btn" onClick={() => this.setActiveTab('kinetics')}>
                                <i className={codicon('graph-line')}></i>
                                Convergence
                            </button>
                        </div>
                    </div>
                )}

                {/* Key Metrics - Modern Cards */}
                <div className="overview-metrics">
                    <div className="overview-metric-card">
                        <div className="overview-metric-header">
                            <div className="overview-metric-icon overview-metric-icon--batches">
                                <i className={codicon('layers')}></i>
                            </div>
                            <div className="overview-metric-badge">Batch Statistics</div>
                        </div>
                        <div className="overview-metric-body">
                            <div className="overview-metric-main-value">{info.nBatches}</div>
                            <div className="overview-metric-sub">total batches</div>
                        </div>
                        <div className="overview-metric-footer">
                            <div className="overview-metric-stat">
                                <span className="overview-metric-stat-label">Active</span>
                                <span className="overview-metric-stat-value">{activeBatches}</span>
                            </div>
                            <div className="overview-metric-stat">
                                <span className="overview-metric-stat-label">Inactive</span>
                                <span className="overview-metric-stat-value">{info.nInactive}</span>
                            </div>
                        </div>
                    </div>

                    <div className="overview-metric-card">
                        <div className="overview-metric-header">
                            <div className="overview-metric-icon overview-metric-icon--particles">
                                <i className={codicon('organization')}></i>
                            </div>
                            <div className="overview-metric-badge">Particle Statistics</div>
                        </div>
                        <div className="overview-metric-body">
                            <div className="overview-metric-main-value">{info.nParticles.toLocaleString()}</div>
                            <div className="overview-metric-sub">particles per batch</div>
                        </div>
                        <div className="overview-metric-footer">
                            <div className="overview-metric-stat">
                                <span className="overview-metric-stat-label">Total Simulated</span>
                                <span className="overview-metric-stat-value">{(totalParticles / 1e6).toFixed(2)}M</span>
                            </div>
                        </div>
                    </div>

                    <div className="overview-metric-card">
                        <div className="overview-metric-header">
                            <div className="overview-metric-icon overview-metric-icon--tallies">
                                <i className={codicon('graph')}></i>
                            </div>
                            <div className="overview-metric-badge">Tally Count</div>
                        </div>
                        <div className="overview-metric-body">
                            <div className="overview-metric-main-value">{this.tallies.length}</div>
                            <div className="overview-metric-sub">defined tallies</div>
                        </div>
                        <div className="overview-metric-footer">
                            <button className="overview-metric-link" onClick={() => this.fireViewTallyTree()}>
                                <i className={codicon('list-tree')}></i>
                                View Tally Tree
                            </button>
                        </div>
                    </div>

                    {info.hasSourceBank && (
                        <div className="overview-metric-card overview-metric-card--accent">
                            <div className="overview-metric-header">
                                <div className="overview-metric-icon overview-metric-icon--source">
                                    <i className={codicon('activate-breakpoints')}></i>
                                </div>
                                <div className="overview-metric-badge">Source Bank</div>
                            </div>
                            <div className="overview-metric-body">
                                <div className="overview-metric-main-value">{info.nSourceParticles.toLocaleString()}</div>
                                <div className="overview-metric-sub">source particles</div>
                            </div>
                            <div className="overview-metric-footer">
                                <button className="overview-metric-btn" onClick={() => this.fireViewSource()}>
                                    <i className={codicon('globe')}></i>
                                    Visualize 3D
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                {/* Two Column Layout */}
                <div className="overview-grid">
                    {/* Simulation Configuration */}
                    <div className="overview-section">
                        <div className="overview-section-header">
                            <i className={codicon('settings')}></i>
                            <h3>Simulation Configuration</h3>
                        </div>
                        <div className="overview-config-grid">
                            <div className="config-item">
                                <div className="config-label">Run Mode</div>
                                <div className="config-value">
                                    <span className={`config-badge config-badge--${info.runMode.toLowerCase()}`}>
                                        {info.runMode}
                                    </span>
                                </div>
                            </div>
                            <div className="config-item">
                                <div className="config-label">Energy Mode</div>
                                <div className="config-value">{info.energyMode}</div>
                            </div>
                            <div className="config-item">
                                <div className="config-label">OpenMC Version</div>
                                <div className="config-value">{info.version || 'Unknown'}</div>
                            </div>
                            <div className="config-item">
                                <div className="config-label">Random Seed</div>
                                <div className="config-value config-value--mono">{info.seed}</div>
                            </div>
                            <div className="config-item">
                                <div className="config-label">Generations per Batch</div>
                                <div className="config-value">{info.generationsPerBatch}</div>
                            </div>
                            <div className="config-item">
                                <div className="config-label">Active Batches</div>
                                <div className="config-value">{info.nRealizations}</div>
                            </div>
                        </div>
                    </div>

                    {/* k-Estimators */}
{(info.kColAbs !== undefined || info.kColTra !== undefined || info.kAbsTra !== undefined) && (
                        <div className="overview-section">
                            <div className="overview-section-header">
                                <i className={codicon('math-formula')}></i>
                                <h3>k-Estimators</h3>
                            </div>
                            <div className="overview-estimators">
                                {info.kColAbs !== undefined && (
                                    <div className="overview-estimator-item">
                                        <span className="overview-estimator-name">Collision/Absorption</span>
                                        <span className="overview-estimator-value">{info.kColAbs.toFixed(5)}</span>
                                    </div>
                                )}
                                {info.kColTra !== undefined && (
                                    <div className="overview-estimator-item">
                                        <span className="overview-estimator-name">Collision/Transport</span>
                                        <span className="overview-estimator-value">{info.kColTra.toFixed(5)}</span>
                                    </div>
                                )}
                                {info.kAbsTra !== undefined && (
                                    <div className="overview-estimator-item">
                                        <span className="overview-estimator-name">Absorption/Transport</span>
                                        <span className="overview-estimator-value">{info.kAbsTra.toFixed(5)}</span>
                                    </div>
                                )}
                            </div>
                        </div>
                        )}
                </div>
            </div>
        );
    }

    private renderKinetics(): React.ReactNode {
        const info = this.statepointInfo!;
        
        return (
            <div className="tab-content">
                {info.kCombined ? (
                    <>
                        {/* Hero Display */}
                        <div className="kinetics-hero">
                            <div className="kinetics-hero-content">
                                <div className="kinetics-k">
                                    <div className="kinetics-k-value">{info.kCombined[0].toFixed(5)}</div>
                                    <div className="kinetics-k-uncertainty">± {info.kCombined[1].toFixed(5)}</div>
                                </div>
                                <div className="kinetics-k-label">Combined k-effective</div>
                                {this.kGenerationData && (
                                    <div className="kinetics-stats">
                                        <div className="kinetics-stat">
                                            <span className="kinetics-stat-value">{this.kGenerationData.batches.length}</span>
                                            <span className="kinetics-stat-label">Generations</span>
                                        </div>
                                        <div className="kinetics-stat">
                                            <span className="kinetics-stat-value">{(info.kCombined[1] / info.kCombined[0] * 100).toFixed(2)}%</span>
                                            <span className="kinetics-stat-label">Rel. Error</span>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Convergence Plot */}
                        {this.kGenerationData && (
                            <div className="kinetics-section">
                                <div className="kinetics-section-header">
                                    <i className={codicon('trending-up')}></i>
                                    <h3>Convergence History</h3>
                                </div>
                                <div className="kinetics-plot">
                                    <KGenerationPlot data={this.kGenerationData} />
                                </div>
                            </div>
                        )}

                        {/* k-Estimators */}
                        {(info.kColAbs !== undefined || info.kColTra !== undefined || info.kAbsTra !== undefined) && (
                        <div className="kinetics-section">
                            <div className="kinetics-section-header">
                                <i className={codicon('math-formula')}></i>
                                <h3>k-Estimators</h3>
                            </div>
                            <div className="kinetics-estimators-grid">
                                {info.kCombined && (
                                    <div className="kinetics-estimator-row">
                                        <span className="kinetics-estimator-label">k-combined</span>
                                        <span className="kinetics-estimator-value">{info.kCombined[0].toFixed(5)}</span>
                                    </div>
                                )}
                                {info.kColAbs && (
                                    <div className="kinetics-estimator-row">
                                        <span className="kinetics-estimator-label">Collision/Absorption</span>
                                        <span className="kinetics-estimator-value">{info.kColAbs.toFixed(5)}</span>
                                    </div>
                                )}
                                {info.kColTra && (
                                    <div className="kinetics-estimator-row">
                                        <span className="kinetics-estimator-label">Collision/Transport</span>
                                        <span className="kinetics-estimator-value">{info.kColTra.toFixed(5)}</span>
                                    </div>
                                )}
                                {info.kAbsTra && (
                                    <div className="kinetics-estimator-row">
                                        <span className="kinetics-estimator-label">Absorption/Transport</span>
                                        <span className="kinetics-estimator-value">{info.kAbsTra.toFixed(5)}</span>
                                    </div>
                                )}
                            </div>
                        </div>
                        )}
                    </>
                ) : (
                    <div className="kinetics-empty">
                        <i className={codicon('info')}></i>
                        <p>No k-effective data available for this simulation.</p>
                    </div>
                )}
            </div>
        );
    }

    private renderTallies(): React.ReactNode {
        return (
            <div className="tab-content">
                <div className="tallies-header">
                    <div className="tallies-header-content">
                        <i className={codicon('graph')}></i>
                        <h3>User Tallies</h3>
                        <span className="tallies-count">{this.tallies.length}</span>
                    </div>
                    <Tooltip content="View tally tree structure" position="top">
                        <button className="tallies-action-btn" onClick={() => this.fireViewTallyTree()}>
                            <i className={codicon('list-tree')}></i>
                            View Tally Tree
                        </button>
                    </Tooltip>
                </div>
                
                <div className="tallies-grid">
                    {this.tallies.map(tally => this.renderTallyCard(tally))}
                </div>
            </div>
        );
    }

    private renderTallyCard(tally: OpenMCTallyInfo): React.ReactNode {
        const meshFilter = tally.filters.find(f => f.type === 'mesh');
        const energyFilter = tally.filters.find(f => f.type === 'energy');
        const cellFilter = tally.filters.find(f => f.type === 'cell');
        
        return (
            <div key={tally.id} className="tally-card">
                <div className="tally-card-header">
                    <div className="tally-card-id">Tally {tally.id}</div>
                    <div className="tally-card-badges">
                        {meshFilter && <span className="tally-card-badge tally-card-badge--mesh">Mesh</span>}
                        {cellFilter && <span className="tally-card-badge tally-card-badge--cell">Cell</span>}
                        {energyFilter && <span className="tally-card-badge tally-card-badge--energy">Energy</span>}
                    </div>
                </div>
                
                <div className="tally-card-name">{tally.name}</div>
                
                <div className="tally-card-details">
                    <div className="tally-card-row">
                        <span className="tally-card-label">Scores</span>
                        <span className="tally-card-value">{tally.scores.join(', ')}</span>
                    </div>
                    <div className="tally-card-row">
                        <span className="tally-card-label">Nuclides</span>
                        <span className="tally-card-value">
                            {tally.nuclides.length > 3 
                                ? `${tally.nuclides.slice(0, 3).join(', ')} +${tally.nuclides.length - 3}`
                                : tally.nuclides.join(', ')
                            }
                        </span>
                    </div>
                    {meshFilter?.meshDimensions && (
                        <div className="tally-card-row">
                            <span className="tally-card-label">Mesh</span>
                            <span className="tally-card-value">{meshFilter.meshDimensions.join(' × ')}</span>
                        </div>
                    )}
                </div>
                
                <div className="tally-card-actions">
                    {tally.hasMesh && (
                        <>
                            <Tooltip content="View tally in 3D visualization" position="top">
                                <button 
                                    className="tally-card-btn tally-card-btn--primary"
                                    onClick={() => this.fireTallySelected({ 
                                        tallyId: tally.id, 
                                        action: 'view-3d',
                                        score: tally.scores[0]
                                    })}
                                >
                                    <i className={codicon('globe')}></i>
                                    3D
                                </button>
                            </Tooltip>
                            <Tooltip content="Overlay tally on geometry" position="top">
                                <button 
                                    className="tally-card-btn"
                                    onClick={() => this.fireTallySelected({ 
                                        tallyId: tally.id, 
                                        action: 'overlay-geometry',
                                        score: tally.scores[0]
                                    })}
                                >
                                    <i className={codicon('layers')}></i>
                                </button>
                            </Tooltip>
                            <Tooltip content="View tally as 2D heatmap" position="top">
                                <button 
                                    className="tally-card-btn"
                                    onClick={() => this.fireTallySelected({ 
                                        tallyId: tally.id, 
                                        action: 'heatmap',
                                        score: tally.scores[0]
                                    })}
                                >
                                    <i className="fa fa-th"></i>
                                </button>
                            </Tooltip>
                            <Tooltip content="View spatial distribution" position="top">
                                <button 
                                    className="tally-card-btn"
                                    onClick={() => this.fireTallySelected({ 
                                        tallyId: tally.id, 
                                        action: 'spatial',
                                        score: tally.scores[0]
                                    })}
                                >
                                    <i className={codicon('map')}></i>
                                </button>
                            </Tooltip>
                        </>
                    )}
                    {energyFilter && (
                        <Tooltip content="View energy spectrum" position="top">
                            <button 
                                className="tally-card-btn"
                                onClick={() => this.fireTallySelected({ 
                                    tallyId: tally.id, 
                                    action: 'spectrum',
                                    score: tally.scores[0]
                                })}
                            >
                                <i className={codicon('graph-line')}></i>
                            </button>
                        </Tooltip>
                    )}
                </div>
            </div>
        );
    }

    private renderPerformance(): React.ReactNode {
        const info = this.statepointInfo!;
        const runtime = info.runtime;
        
        if (!runtime || Object.keys(runtime).length === 0) {
            return (
                <div className="tab-content">
                    <div className="performance-empty">
                        <i className={codicon('info')}></i>
                        <p>No runtime data available.</p>
                    </div>
                </div>
            );
        }

        const runtimeData = [
            { name: 'Initialization', value: runtime.initialization || 0 },
            { name: 'Reading XS', value: runtime.readingCrossSections || 0 },
            { name: 'Inactive Batches', value: runtime.inactiveBatches || 0 },
            { name: 'Active Batches', value: runtime.activeBatches || 0 },
            { name: 'Simulation', value: runtime.simulation || 0 },
            { name: 'Transport', value: runtime.transport || 0 },
            { name: 'Fission Bank Sync', value: runtime.synchronizingFissionBank || 0 },
            { name: 'Source Sampling', value: runtime.samplingSourceSites || 0 },
            { name: 'Tally Accumulation', value: runtime.accumulatingTallies || 0 },
            { name: 'Statepoint Write', value: runtime.writingStatepoints || 0 },
        ].filter(item => item.value > 0);

        let total = runtime.total;
        if (!total || total === 0) {
            total = runtimeData.length > 0 
                ? runtimeData.reduce((sum, item) => sum + item.value, 0)
                : 0;
        }
        
        if (runtimeData.length === 0 && total && total > 0) {
            runtimeData.push({ name: 'Total Runtime', value: total });
        }

        return (
            <div className="tab-content">
                {/* Total Runtime Hero */}
                <div className="performance-hero">
                    <div className="performance-hero-content">
                        <i className={codicon('clock')}></i>
                        <div className="performance-hero-main">
                            <div className="performance-hero-value">{this.formatTime(total)}</div>
                            <div className="performance-hero-label">Total Runtime</div>
                        </div>
                    </div>
                </div>

                {/* Runtime Breakdown */}
                <div className="performance-section">
                    <div className="performance-section-header">
                        <i className={codicon('chart-bar')}></i>
                        <h3>Runtime Breakdown</h3>
                    </div>
                    <div className="performance-plot">
                        <RuntimePlot data={runtimeData} />
                    </div>
                </div>

                {/* Quick Stats */}
                <div className="performance-stats">
                    <div className="performance-stat-card">
                        <i className={codicon('zap')}></i>
                        <div className="performance-stat-value">{runtimeData.length}</div>
                        <div className="performance-stat-label">Operations</div>
                    </div>
                    <div className="performance-stat-card">
                        <i className={codicon('clock')}></i>
                        <div className="performance-stat-value">{this.formatTime(total / 60)}</div>
                        <div className="performance-stat-label">Avg/Minute</div>
                    </div>
                </div>
            </div>
        );
    }

    private formatTime(seconds: number): string {
        if (seconds < 60) {
            return `${seconds.toFixed(1)}s`;
        } else if (seconds < 3600) {
            return `${(seconds / 60).toFixed(1)}m`;
        } else {
            return `${(seconds / 3600).toFixed(2)}h`;
        }
    }

    protected onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.node.focus();
    }
}

// Plotly Components

interface KGenerationPlotProps {
    data: OpenMCKGenerationData;
}

const KGenerationPlot: React.FC<KGenerationPlotProps> = ({ data }) => {
    const traces: Partial<Plotly.Data>[] = [
        {
            x: data.batches,
            y: data.kValues,
            mode: 'lines',
            name: 'k per batch',
            line: { color: '#f37524', width: 2 },
            hovertemplate: 'Batch: %{x}<br>k: %{y:.5f}<extra></extra>'
        },
        {
            x: data.batches,
            y: data.cumulativeMean,
            mode: 'lines',
            name: 'Cumulative mean',
            line: { color: '#4a9eff', width: 2, dash: 'dash' },
            hovertemplate: 'Batch: %{x}<br>Mean: %{y:.5f}<extra></extra>'
        },
        {
            x: [...data.batches, ...data.batches.slice().reverse()],
            y: [...data.upperBound, ...data.lowerBound.slice().reverse()],
            fill: 'toself',
            fillcolor: 'rgba(243, 117, 36, 0.15)',
            line: { color: 'transparent' },
            name: '±2σ',
            hoverinfo: 'skip',
            showlegend: true
        }
    ];

    const layout: Partial<Plotly.Layout> = {
        xaxis: { title: { text: 'Batch' } },
        yaxis: { title: { text: 'k-effective' } },
        hovermode: 'x unified'
    };

    const config: Partial<Plotly.Config> = {
        modeBarButtonsToRemove: ['lasso2d', 'select2d']
    };

    return <PlotlyComponent data={traces} layout={layout} config={config} style={{ width: '100%', height: '400px' }} />;
};

interface RuntimePlotProps {
    data: { name: string; value: number }[];
}

const RuntimePlot: React.FC<RuntimePlotProps> = ({ data }) => {
    const sortedData = [...data].sort((a, b) => b.value - a.value);
    
    const traces: Partial<Plotly.Data>[] = [{
        x: sortedData.map(d => d.name),
        y: sortedData.map(d => d.value),
        type: 'bar',
        marker: {
            color: sortedData.map((_, i) => {
                const colors = ['#f37524', '#4a9eff', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];
                return colors[i % colors.length];
            })
        },
        text: sortedData.map(d => {
            if (d.value < 60) return `${d.value.toFixed(1)}s`;
            if (d.value < 3600) return `${(d.value / 60).toFixed(1)}m`;
            return `${(d.value / 3600).toFixed(2)}h`;
        }),
        textposition: 'outside',
        hovertemplate: '%{x}: %{y:.2f}s<extra></extra>'
    }];

    const barHeight = Math.max(350, sortedData.length * 40);
    
    const layout: Partial<Plotly.Layout> = {
        xaxis: { 
            type: 'category',
            tickangle: -45
        },
        yaxis: { 
            title: { text: 'Time (seconds)' },
            rangemode: 'tozero'
        },
        showlegend: false,
        margin: { t: 20, r: 20, b: Math.max(100, sortedData.length * 15), l: 60 }
    };

    const config: Partial<Plotly.Config> = {
        displayModeBar: false
    };

    return <PlotlyComponent data={traces} layout={layout} config={config} style={{ width: '100%', height: `${barHeight}px` }} />;
};

