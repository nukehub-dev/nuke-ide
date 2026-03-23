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
import './openmc-tally-tree.css';
import { Emitter, Event } from '@theia/core';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { OpenMCService } from './openmc-service';
import { OpenMCTallyInfo, OpenMCStatepointInfo } from '../../common/visualizer-protocol';
import { URI } from '@theia/core/lib/common/uri';

export interface TallySelection {
    tallyId: number;
    score?: string;
    nuclide?: string;
    action?: 'visualize' | 'spectrum' | 'spatial' | 'heatmap' | 'spectrum-all-scores' | 'spatial-all-scores' | 'spectrum-all-nuclides' | 'overlay-geometry';
    geometryUri?: string;
}

@injectable()
export class OpenMCTallyTreeWidget extends ReactWidget {
    static readonly ID = 'openmc-tally-tree-widget';
    static readonly LABEL = 'OpenMC Tallies';

    @inject(OpenMCService)
    protected readonly openmcService!: OpenMCService;

    @inject(FileDialogService)
    protected readonly fileDialogService!: FileDialogService;

    private statepointUri: URI | null = null;
    private statepointInfo: OpenMCStatepointInfo | null = null;
    private tallies: OpenMCTallyInfo[] = [];
    private selectedTally: TallySelection | null = null;
    private expandedTallies: Set<number> = new Set();

    private readonly _onTallySelected = new Emitter<TallySelection>();
    readonly onTallySelected: Event<TallySelection> = this._onTallySelected.event;

    @postConstruct()
    protected init(): void {
        this.id = OpenMCTallyTreeWidget.ID;
        this.title.label = OpenMCTallyTreeWidget.LABEL;
        this.title.caption = OpenMCTallyTreeWidget.LABEL;
        this.title.iconClass = codicon('list-tree');
        this.title.closable = false; // Don't allow closing the widget itself
        
        this.node.tabIndex = 0;
        this.update();
    }

    focus(): void {
        this.node.focus();
    }

    setStatepoint(uri: URI, info: OpenMCStatepointInfo, tallies: OpenMCTallyInfo[]): void {
        this.statepointUri = uri;
        this.statepointInfo = info;
        this.tallies = tallies;
        this.update();
    }

    clearStatepoint(): void {
        this.statepointUri = null;
        this.statepointInfo = null;
        this.tallies = [];
        this.expandedTallies.clear();
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
                await this.loadStatepoint(uri);
            }
        } catch (error) {
            console.error('[TallyTree] Error browsing for file:', error);
        }
    }

    protected async loadStatepoint(uri: URI): Promise<void> {
        try {
            await this.openmcService.loadStatepoint(uri);
            const info = this.openmcService.getCurrentStatepoint();
            const tallies = this.openmcService.getCurrentTallies();
            if (info && tallies.length > 0) {
                this.setStatepoint(uri, info, tallies);
            }
        } catch (error) {
            console.error('[TallyTree] Error loading statepoint:', error);
        }
    }

    protected handleClose(): void {
        this.openmcService.clearStatepoint();
        this.clearStatepoint();
    }

    protected render(): React.ReactNode {
        if (!this.statepointInfo) {
            return (
                <div className="openmc-tally-tree empty">
                    <div className="placeholder">
                        <i className={codicon('database')}></i>
                        <div>No statepoint file loaded</div>
                        <button 
                            className="browse-file-btn"
                            onClick={() => this.handleBrowse()}
                        >
                            <i className="fa fa-folder"></i>
                            Browse Statepoint File
                        </button>
                    </div>
                </div>
            );
        }

        const fileName = this.statepointUri?.path.base || 'Unknown';

        return (
            <div className="openmc-tally-tree">
                <div className="tree-header">
                    <div className="header-title">
                        <span className="file-name" title={fileName}>
                            <i className={codicon('database')}></i>
                            {fileName}
                        </span>
                        <button 
                            className="close-btn" 
                            onClick={() => this.handleClose()}
                            title="Close Statepoint"
                        >
                            <i className={codicon('close')}></i>
                        </button>
                    </div>
                    
                    {this.statepointInfo.kEff !== undefined && (
                        <span className="keff-badge">
                            <i className={codicon('flame')}></i>
                            k<sub>eff</sub> = {this.statepointInfo.kEff.toFixed(5)} ± {this.statepointInfo.kEffStd?.toFixed(5)}
                        </span>
                    )}
                    
                    <div className="batches-info">
                        {this.statepointInfo.batches} batches · {this.tallies.length} tallies
                    </div>
                </div>
                
                <div className="tree-content">
                    {this.tallies.map(tally => this.renderTallyCard(tally))}
                </div>
            </div>
        );
    }

    private renderTallyCard(tally: OpenMCTallyInfo): React.ReactNode {
        const isExpanded = this.expandedTallies.has(tally.id);
        const meshFilter = tally.filters.find(f => f.type === 'mesh');
        const energyFilter = tally.filters.find(f => f.type === 'energy');
        const cellFilter = tally.filters.find(f => f.type === 'cell');
        
        return (
            <div 
                key={tally.id} 
                className={`tally-card ${isExpanded ? 'expanded' : ''}`}
            >
                <div 
                    className="tally-header"
                    onClick={() => this.toggleTally(tally.id)}
                >
                    <i className={`${codicon('chevron-right')} tally-expand-icon`}></i>
                    <span className="tally-id-badge">Tally {tally.id}</span>
                    <span className="tally-name" title={tally.name}>{tally.name}</span>
                    
                    <div className="tally-badges">
                        {meshFilter && (
                            <span className="tally-badge mesh" title="Mesh Tally">
                                <i className="fa fa-th"></i>
                            </span>
                        )}
                        {cellFilter && (
                            <span className="tally-badge cell" title="Cell Filter">
                                <i className={codicon('square')}></i>
                            </span>
                        )}
                        {energyFilter && (
                            <span className="tally-badge energy" title="Energy Filter">
                                <i className={codicon('zap')}></i>
                            </span>
                        )}
                    </div>
                </div>
                
                {isExpanded && (
                    <div className="tally-details">
                        {/* Info Grid */}
                        <div className="info-grid">
                            <div className="info-item">
                                <span className="info-label">Scores</span>
                                <span className="info-value scores">
                                    {tally.scores.slice(0, 3).map(s => (
                                        <span key={s} className="score-tag">{s}</span>
                                    ))}
                                    {tally.scores.length > 3 && (
                                        <span className="score-tag">+{tally.scores.length - 3}</span>
                                    )}
                                </span>
                            </div>
                            
                            <div className="info-item">
                                <span className="info-label">Nuclides</span>
                                <span className="info-value">
                                    {tally.nuclides.length > 0 && tally.nuclides[0] !== 'total' 
                                        ? `${tally.nuclides.length} nuclides`
                                        : 'Total'
                                    }
                                </span>
                            </div>
                        </div>
                        
                        {/* Mesh Info */}
                        {meshFilter?.meshDimensions && (
                            <div className="mesh-info-card">
                                <div className="mesh-info-header">
                                    <i className={codicon('layout')}></i>
                                    {meshFilter.meshType === 'cylindrical' ? 'Cylindrical Mesh' : 'Cartesian Mesh'}
                                </div>
                                <div className="mesh-dims-grid">
                                    {meshFilter.meshDimensions.map((dim, idx) => (
                                        <div key={idx} className="mesh-dim-item">
                                            <div className="mesh-dim-value">{dim}</div>
                                            <div className="mesh-dim-label">
                                                {meshFilter.meshType === 'cylindrical' 
                                                    ? ['R', 'φ', 'Z'][idx] 
                                                    : ['X', 'Y', 'Z'][idx]
                                                }
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                        
                        {/* Actions */}
                        <div className="actions-section">
                            <div className="actions-label">Visualizations</div>
                            
                            {tally.hasMesh && (
                                <>
                                    {/* Primary Visualizations */}
                                    <div className="action-group">
                                        <button 
                                            className="action-btn primary"
                                            onClick={() => this.selectTally(tally.id, tally.scores[0], 'total', 'visualize')}
                                            title="Visualize 3D Mesh Tally"
                                        >
                                            <i className="fa fa-cube"></i>
                                            <span>3D View</span>
                                        </button>
                                        
                                        <button 
                                            className="action-btn accent"
                                            onClick={() => this.selectTally(tally.id, tally.scores[0], 'total', 'overlay-geometry')}
                                            title="Overlay on DAGMC Geometry"
                                        >
                                            <i className={codicon('layers')}></i>
                                            <span>Overlay</span>
                                        </button>
                                        
                                        <button 
                                            className="action-btn info"
                                            onClick={() => this.selectTally(tally.id, tally.scores[0], 'total', 'heatmap')}
                                            title="2D Heatmap Slices"
                                        >
                                            <i className="fa fa-th"></i>
                                            <span>Heatmap</span>
                                        </button>
                                    </div>
                                    
                                    {/* Plot Actions */}
                                    <div className="actions-label">Plots</div>
                                    <div className="action-group small">
                                        <div className="action-btn-group">
                                            <button 
                                                className="action-btn"
                                                onClick={() => this.selectTally(tally.id, tally.scores[0], 'total', 'spatial')}
                                                title="Plot 1D Spatial Distribution"
                                            >
                                                <i className={codicon('graph-line')}></i>
                                                <span>Spatial</span>
                                            </button>
                                            {tally.scores.length > 1 && (
                                                <button 
                                                    className="action-btn"
                                                    onClick={() => this.selectTally(tally.id, undefined, 'total', 'spatial-all-scores')}
                                                    title="Plot All Scores"
                                                >
                                                    <i className={codicon('add')}></i>
                                                </button>
                                            )}
                                        </div>
                                        
                                        {energyFilter && (
                                            <div className="action-btn-group">
                                                <button 
                                                    className="action-btn"
                                                    onClick={() => this.selectTally(tally.id, tally.scores[0], 'total', 'spectrum')}
                                                    title="Plot Energy Spectrum"
                                                >
                                                    <i className="fa fa-area-chart"></i>
                                                    <span>Spectrum</span>
                                                </button>
                                                {tally.scores.length > 1 && (
                                                    <button 
                                                        className="action-btn"
                                                        onClick={() => this.selectTally(tally.id, undefined, 'total', 'spectrum-all-scores')}
                                                        title="Plot All Scores"
                                                    >
                                                        <i className={codicon('add')}></i>
                                                    </button>
                                                )}
                                                {tally.nuclides.length > 1 && (
                                                    <button 
                                                        className="action-btn"
                                                        onClick={() => this.selectTally(tally.id, tally.scores[0], undefined, 'spectrum-all-nuclides')}
                                                        title="Plot All Nuclides"
                                                    >
                                                        <i className={codicon('organization')}></i>
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </>
                            )}
                            
                            {/* Non-mesh tallies with only energy filter */}
                            {!tally.hasMesh && energyFilter && (
                                <div className="action-group small">
                                    <div className="action-btn-group">
                                        <button 
                                            className="action-btn"
                                            onClick={() => this.selectTally(tally.id, tally.scores[0], 'total', 'spectrum')}
                                            title="Plot Energy Spectrum"
                                        >
                                            <i className="fa fa-area-chart"></i>
                                            <span>Spectrum</span>
                                        </button>
                                        {tally.scores.length > 1 && (
                                            <button 
                                                className="action-btn"
                                                onClick={() => this.selectTally(tally.id, undefined, 'total', 'spectrum-all-scores')}
                                                title="Plot All Scores"
                                            >
                                                <i className="fa fa-plus"></i>
                                            </button>
                                        )}
                                        {tally.nuclides.length > 1 && (
                                            <button 
                                                className="action-btn"
                                                onClick={() => this.selectTally(tally.id, tally.scores[0], undefined, 'spectrum-all-nuclides')}
                                                title="Plot All Nuclides"
                                            >
                                                <i className="fa fa-users"></i>
                                            </button>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        );
    }

    private toggleTally(tallyId: number): void {
        if (this.expandedTallies.has(tallyId)) {
            this.expandedTallies.delete(tallyId);
        } else {
            this.expandedTallies.add(tallyId);
        }
        this.update();
    }

    private selectTally(tallyId: number, score?: string, nuclide?: string, action?: TallySelection['action']): void {
        this.selectedTally = { tallyId, score, nuclide, action };
        this._onTallySelected.fire(this.selectedTally);
    }

    protected onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.node.focus();
    }
}
