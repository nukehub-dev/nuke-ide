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
import { OpenMCService } from './openmc-service';
import { OpenMCTallyInfo, OpenMCStatepointInfo } from '../../common/visualizer-protocol';
import { URI } from '@theia/core/lib/common/uri';

export interface TallySelection {
    tallyId: number;
    score?: string;
    nuclide?: string;
    action?: 'visualize' | 'spectrum' | 'spatial' | 'heatmap' | 'spectrum-all-scores' | 'spatial-all-scores' | 'spectrum-all-nuclides';
}

@injectable()
export class OpenMCTallyTreeWidget extends ReactWidget {
    static readonly ID = 'openmc-tally-tree-widget';
    static readonly LABEL = 'OpenMC Tallies';

    @inject(OpenMCService)
    protected readonly openmcService!: OpenMCService;

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
        this.title.closable = true;
        
        // Ensure the widget can be focused
        this.node.tabIndex = 0;
        this.update();
    }

    focus(): void {
        this.node.focus();
    }

    setStatepoint(uri: URI, info: OpenMCStatepointInfo, tallies: OpenMCTallyInfo[]): void {
        this.statepointUri = uri;
        this.statepointInfo = info;
        this.tallies = tallies; // Show all tallies now
        this.update();
    }

    protected render(): React.ReactNode {
        if (!this.statepointInfo) {
            return (
                <div className="openmc-tally-tree empty">
                    <div className="placeholder">
                        <i className="fa fa-cube"></i>
                        <div>Open a statepoint file to view tallies</div>
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
                            <i className="fa fa-file-code-o"></i>
                            {fileName}
                        </span>
                        <button 
                            className="close-btn" 
                            onClick={() => this.close()}
                            title="Close"
                        >
                            <i className="fa fa-times"></i>
                        </button>
                    </div>
                    {this.statepointInfo.kEff !== undefined && (
                        <div className="keff-info">
                            k<sub>eff</sub>: {this.statepointInfo.kEff.toFixed(5)} ± {this.statepointInfo.kEffStd?.toFixed(5)}
                        </div>
                    )}
                    <div className="batches-info">
                        {this.statepointInfo.batches} batches, {this.tallies.length} tallies
                    </div>
                </div>
                
                <div className="tree-content">
                    {this.tallies.map(tally => this.renderTally(tally))}
                </div>
            </div>
        );
    }

    private renderTally(tally: OpenMCTallyInfo): React.ReactNode {
        const isExpanded = this.expandedTallies.has(tally.id);
        const meshFilter = tally.filters.find(f => f.type === 'mesh');
        const energyFilter = tally.filters.find(f => f.type === 'energy');
        
        // Detect mesh type label
        const meshTypeLabel = meshFilter?.meshType === 'cylindrical' ? 'Cylindrical' : 'Regular (Cartesian)';
        
        return (
            <div key={tally.id} className="tally-item">
                <div 
                    className="tally-header"
                    onClick={() => this.toggleTally(tally.id)}
                >
                    <i className={`fa fa-chevron-${isExpanded ? 'down' : 'right'}`}></i>
                    <span className="tally-id">Tally {tally.id}</span>
                    <span className="tally-name">{tally.name}</span>
                    {meshFilter?.meshDimensions && (
                        <span className="mesh-dims">
                            {meshFilter.meshDimensions.join('×')}
                        </span>
                    )}
                </div>
                
                {isExpanded && (
                    <div className="tally-details">
                        {/* Scores */}
                        {tally.scores.length > 0 && (
                            <div className="detail-section">
                                <div className="detail-label">Scores:</div>
                                <div className="detail-items">
                                    {tally.scores.map(score => (
                                        <span key={score} className="detail-item score">{score}</span>
                                    ))}
                                </div>
                            </div>
                        )}
                        
                        {/* Nuclides */}
                        {tally.nuclides.length > 0 && tally.nuclides[0] !== 'total' && (
                            <div className="detail-section">
                                <div className="detail-label">Nuclides:</div>
                                <div className="detail-items">
                                    {tally.nuclides.map(nuclide => (
                                        <span key={nuclide} className="detail-item nuclide">
                                            {nuclide}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}
                        
                        {/* Filters */}
                        <div className="detail-section">
                            <div className="detail-label">Filters:</div>
                            <div className="detail-items">
                                {tally.filters.map((filter, idx) => (
                                    <span key={idx} className="detail-item filter">
                                        {filter.type} ({filter.bins} bins)
                                    </span>
                                ))}
                            </div>
                        </div>
                        
                        {/* Mesh Info */}
                        {meshFilter && (
                            <div className="detail-section">
                                <div className="detail-label">Mesh Info:</div>
                                <div className="mesh-info">
                                    <div className="mesh-row">
                                        <span className="mesh-label">Type:</span>
                                        <span className="mesh-value">{meshTypeLabel}</span>
                                    </div>
                                    {meshFilter.meshDimensions && (
                                        <div className="mesh-row">
                                            <span className="mesh-label">Dimensions:</span>
                                            <span className="mesh-value">{meshFilter.meshDimensions.join(' × ')} cells</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                        
                        {/* Action Buttons */}
                        <div className="tally-actions">
                            {tally.hasMesh && (
                                <>
                                    <button 
                                        className="tally-action-btn visualize"
                                        onClick={() => this.selectTally(tally.id, tally.scores[0], 'total', 'visualize')}
                                        title="Visualize 3D Mesh Tally"
                                    >
                                        <i className="fa fa-cube"></i>
                                        3D View
                                    </button>
                                    <button 
                                        className="tally-action-btn heatmap"
                                        onClick={() => this.selectTally(tally.id, tally.scores[0], 'total', 'heatmap')}
                                        title="2D Heatmap Slices"
                                    >
                                        <i className="fa fa-th"></i>
                                        2D Heatmap
                                    </button>
                                    <div className="button-group">
                                        <button 
                                            className="tally-action-btn spatial"
                                            onClick={() => this.selectTally(tally.id, tally.scores[0], 'total', 'spatial')}
                                            title="Plot 1D Spatial Distribution"
                                        >
                                            <i className="fa fa-line-chart"></i>
                                            Spatial Plot
                                        </button>
                                        {tally.scores.length > 1 && (
                                            <button 
                                                className="tally-action-btn spatial-multi"
                                                onClick={() => this.selectTally(tally.id, undefined, 'total', 'spatial-all-scores')}
                                                title="Plot All Scores (Spatial)"
                                            >
                                                <i className="fa fa-plus"></i>
                                            </button>
                                        )}
                                    </div>
                                </>
                            )}
                            
                            {energyFilter && (
                                <div className="button-group">
                                    <button 
                                        className="tally-action-btn spectrum"
                                        onClick={() => this.selectTally(tally.id, tally.scores[0], 'total', 'spectrum')}
                                        title="Plot Energy Spectrum"
                                    >
                                        <i className="fa fa-area-chart"></i>
                                        Spectrum
                                    </button>
                                    {tally.scores.length > 1 && (
                                        <button 
                                            className="tally-action-btn spectrum-multi"
                                            onClick={() => this.selectTally(tally.id, undefined, 'total', 'spectrum-all-scores')}
                                            title="Plot All Scores (Spectrum)"
                                        >
                                            <i className="fa fa-plus"></i>
                                        </button>
                                    )}
                                    {tally.nuclides.length > 1 && (
                                        <button 
                                            className="tally-action-btn spectrum-nuclide-multi"
                                            onClick={() => this.selectTally(tally.id, tally.scores[0], undefined, 'spectrum-all-nuclides')}
                                            title="Plot All Nuclides (Spectrum)"
                                        >
                                            <i className="fa fa-users"></i>
                                        </button>
                                    )}
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
