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

/**
 * Simulation Comparison Widget
 * 
 * Compare k-effective values and tally results from multiple OpenMC statepoint files.
 * Features:
 * - Select multiple statepoint files
 * - Compare k-effective values with statistical analysis
 * - Side-by-side tally results comparison
 * - Export comparison results
 * 
 * @module openmc-studio/browser
 */

import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { MessageService } from '@theia/core/lib/common/message-service';
import { FileDialogService, OpenFileDialogProps, SaveFileDialogProps } from '@theia/filesystem/lib/browser';
import { Tooltip, useTooltip } from 'nuke-essentials/lib/theme/browser/components';
import { WidgetManager, ApplicationShell } from '@theia/core/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import { 
    OpenMCStudioBackendService, 
    StatepointInfo, 
    StatepointTally,
    StatisticalTests,
    KeffConvergenceAnalysis,
    DepletionResults
} from '../../../common/openmc-studio-protocol';

// Import Plotly component from nuke-visualizer
import { PlotlyComponent } from 'nuke-visualizer/lib/browser/plotly/plotly-component';

// Statepoint data structure
// Extended statepoint info with local state
interface StatepointInfoExtended extends StatepointInfo {
    localId: string;
    loading?: boolean;
    loaded?: boolean;
}

const ConvergenceSparkBar: React.FC<{ height: number, content: string }> = ({ height, content }) => {
    const { onMouseEnter, onMouseLeave, tooltipElement } = useTooltip(content, 'top');
    return (
        <div 
            className='spark-bar'
            style={{ height: `${Math.max(height, 5)}%` }}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            {tooltipElement}
        </div>
    );
};

const KeffChartBar: React.FC<{ 
    left: string, 
    width: string, 
    isAbove: boolean, 
    content: string 
}> = ({ left, width, isAbove, content }) => {
    const { onMouseEnter, onMouseLeave, tooltipElement } = useTooltip(content, 'top');
    return (
        <div 
            className={`chart-bar ${isAbove ? 'above-mean' : 'below-mean'}`}
            style={{ left, width }}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            {tooltipElement}
        </div>
    );
};

type ComparisonTab = 'overview' | 'keff' | 'tallies' | 'statistics' | 'convergence' | 'burnup';

@injectable()
export class SimulationComparisonWidget extends ReactWidget {
    static readonly ID = 'openmc-simulation-comparison';
    static readonly LABEL = 'Simulation Comparison';

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    @inject(FileDialogService)
    protected readonly fileDialogService!: FileDialogService;

    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    @inject(OpenMCStudioBackendService)
    protected readonly backendService!: OpenMCStudioBackendService;

    @inject(FileService)
    protected readonly fileService!: FileService;

    private statepoints: StatepointInfoExtended[] = [];
    private activeTab: ComparisonTab = 'overview';
    private selectedTallyId?: number;
    private isLoading = false;
    private statisticalTests?: StatisticalTests;
    private convergenceAnalysis?: Map<string, KeffConvergenceAnalysis>;
    private analyzingIds: Set<string> = new Set();
    private depletionResults: Map<string, DepletionResults> = new Map();
    private selectedDepletionFile?: string;
    
    // Depletion visualization state
    private selectedNuclides: Set<string> = new Set(['U235', 'U238', 'Pu239', 'Pu240', 'Xe135']);
    private selectedMaterialId?: string;
    private burnupPlotType: 'concentration' | 'keff' = 'concentration';
    private burnupXAxis: 'time' | 'burnup' = 'burnup';
    private burnupScale: 'linear' | 'log' = 'log';

    @postConstruct()
    protected init(): void {
        this.id = SimulationComparisonWidget.ID;
        this.title.label = SimulationComparisonWidget.LABEL;
        this.title.caption = SimulationComparisonWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-git-compare';
        this.update();
    }

    protected render(): React.ReactNode {
        return (
            <div className='simulation-comparison'>
                {this.renderHeader()}
                {(this.statepoints.length > 0 || this.depletionResults.size > 0) && this.renderTabs()}
                {this.renderContent()}
            </div>
        );
    }

    private renderHeader(): React.ReactNode {
        const loadedCount = this.statepoints.filter(s => s.loaded).length;
        const depletionCount = this.depletionResults.size;
        
        let description = 'Compare k-effective and tally results from multiple simulations';
        if (this.statepoints.length > 0 || depletionCount > 0) {
            const parts = [];
            if (this.statepoints.length > 0) {
                parts.push(`${this.statepoints.length} simulations (${loadedCount} successful)`);
            }
            if (depletionCount > 0) {
                parts.push(`${depletionCount} depletion results`);
            }
            description = parts.join(' + ');
        }
        
        return (
            <div className='comparison-header'>
                <div className='header-info'>
                    <h2>
                        <i className='codicon codicon-git-compare'></i>
                        Simulation Comparison
                    </h2>
                    <p className='header-description'>{description}</p>
                </div>
                
                <div className='header-actions'>
                    <Tooltip content='Add statepoint files to compare' position='bottom'>
                        <button
                            className='theia-button primary'
                            onClick={() => this.openAddDialog()}
                        >
                            <i className='codicon codicon-add'></i>
                            Add Statepoints
                        </button>
                    </Tooltip>
                    
                    <Tooltip content='Add depletion results files for burnup analysis' position='bottom'>
                        <button
                            className='theia-button secondary'
                            onClick={() => this.openAddDepletionDialog()}
                        >
                            <i className='codicon codicon-flame'></i>
                            Add Depletion
                        </button>
                    </Tooltip>
                    
                    {(this.statepoints.length > 0 || this.depletionResults.size > 0) && (
                        <Tooltip content='Clear all comparisons' position='bottom'>
                            <button
                                className='theia-button secondary'
                                onClick={() => this.clearAll()}
                            >
                                <i className='codicon codicon-clear-all'></i>
                                Clear
                            </button>
                        </Tooltip>
                    )}
                    
                    {(this.statepoints.length > 0 || this.depletionResults.size > 0) && (
                        <Tooltip content='Export comparison results' position='bottom'>
                            <button
                                className='theia-button secondary'
                                onClick={() => this.exportResults()}
                            >
                                <i className='codicon codicon-export'></i>
                                Export
                            </button>
                        </Tooltip>
                    )}
                </div>
            </div>
        );
    }

    private renderTabs(): React.ReactNode {
        const hasEigenvalue = this.statepoints.some(s => s.loaded && s.kEff);
        const hasDepletion = this.depletionResults.size > 0;
        
        const tabs: { id: ComparisonTab; label: string; icon: string }[] = [
            { id: 'overview', label: 'Overview', icon: 'preview' }
        ];
        
        if (hasEigenvalue) {
            tabs.push({ id: 'keff', label: 'k-effective', icon: 'symbol-numeric' });
        }
        
        tabs.push({ id: 'tallies', label: 'Tallies', icon: 'graph' });
        
        if (hasEigenvalue) {
            tabs.push({ id: 'statistics', label: 'Statistics', icon: 'pie-chart' });
            tabs.push({ id: 'convergence', label: 'Convergence', icon: 'history' });
        }
        
        if (hasDepletion) {
            tabs.push({ id: 'burnup', label: 'Burnup', icon: 'flame' });
        }

        return (
            <div className='comparison-tabs'>
                {tabs.map(tab => (
                    <button
                        key={tab.id}
                        className={`tab-button ${this.activeTab === tab.id ? 'active' : ''}`}
                        onClick={() => { this.activeTab = tab.id; this.update(); }}
                    >
                        <i className={`codicon codicon-${tab.icon}`}></i>
                        {tab.label}
                    </button>
                ))}
            </div>
        );
    }

    private renderContent(): React.ReactNode {
        if (this.isLoading) {
            return (
                <div className='comparison-content loading'>
                    <i className='codicon codicon-loading codicon-modifier-spin'></i>
                    <h3>Loading simulation files...</h3>
                </div>
            );
        }

        // Show empty state only if there's no statepoints AND no depletion results
        const hasNoData = this.statepoints.length === 0 && this.depletionResults.size === 0;

        if (hasNoData) {
            return (
                <div className='comparison-content empty-dashboard'>
                    <div className='welcome-section'>
                        <div className='welcome-icon'>
                            <i className='codicon codicon-git-compare'></i>
                        </div>
                        <h3>Simulation Comparison & Analysis</h3>
                        <p>Select your simulation output files to begin side-by-side comparison and statistical analysis.</p>
                    </div>

                    <div className='get-started-grid'>
                        <div className='start-card' onClick={() => this.openAddDialog()}>
                            <div className='card-icon statepoint'>
                                <i className='codicon codicon-database'></i>
                            </div>
                            <div className='card-content'>
                                <h4>Statepoint Files</h4>
                                <p>Compare k-effective, tally results, and convergence from .h5 output files.</p>
                                <button className='theia-button primary'>
                                    <i className='codicon codicon-add'></i> Add Statepoints
                                </button>
                            </div>
                        </div>

                        <div className='start-card' onClick={() => this.openAddDepletionDialog()}>
                            <div className='card-icon depletion'>
                                <i className='codicon codicon-flame'></i>
                            </div>
                            <div className='card-content'>
                                <h4>Depletion Results</h4>
                                <p>Analyze burnup, nuclide evolution, and material composition over time.</p>
                                <button className='theia-button secondary'>
                                    <i className='codicon codicon-add'></i> Add Depletion
                                </button>
                            </div>
                        </div>
                    </div>

                    <div className='dashboard-footer'>
                        <p><i className='codicon codicon-info'></i> Tip: You can load multiple files at once to perform statistical consistency tests.</p>
                    </div>
                </div>
            );
        }

        return (
            <div className='comparison-content'>
                {this.activeTab === 'overview' && this.renderOverviewTab()}
                {this.activeTab === 'keff' && this.renderKeffTab()}
                {this.activeTab === 'tallies' && this.renderTalliesTab()}
                {this.activeTab === 'statistics' && this.renderStatisticsTab()}
                {this.activeTab === 'convergence' && this.renderConvergenceTab()}
                {this.activeTab === 'burnup' && this.renderBurnupTab()}
            </div>
        );
    }

    private renderOverviewTab(): React.ReactNode {
        const loadedStatepoints = this.statepoints.filter(s => s.loaded && !s.error);
        const depletionCount = this.depletionResults.size;
        
        // Calculate statistics
        const keffValues = loadedStatepoints
            .filter(s => s.kEff)
            .map(s => s.kEff!.value);
        
        const avgKeff = keffValues.length > 0 
            ? keffValues.reduce((a, b) => a + b, 0) / keffValues.length 
            : null;
        
        const keffRange = keffValues.length > 0
            ? { min: Math.min(...keffValues), max: Math.max(...keffValues) }
            : null;

        return (
            <div className='overview-tab'>
                {/* Summary Cards */}
                <div className='summary-cards'>
                    <div className='summary-card'>
                        <div className='card-icon'>
                            <i className='codicon codicon-file'></i>
                        </div>
                        <div className='card-info'>
                            <div className='card-value'>{this.statepoints.length}</div>
                            <div className='card-label'>Simulations</div>
                        </div>
                    </div>
                    
                    <div className='summary-card'>
                        <div className='card-icon keff'>
                            <i className='codicon codicon-symbol-numeric'></i>
                        </div>
                        <div className='card-info'>
                            <div className='card-value'>
                                {avgKeff ? avgKeff.toFixed(5) : '—'}
                            </div>
                            <div className='card-label'>Average k-eff</div>
                        </div>
                    </div>
                    
                    <div className='summary-card'>
                        <div className='card-icon range'>
                            <i className='codicon codicon-arrow-swap'></i>
                        </div>
                        <div className='card-info'>
                            <div className='card-value'>
                                {keffRange ? (keffRange.max - keffRange.min).toFixed(5) : '—'}
                            </div>
                            <div className='card-label'>k-eff Range</div>
                        </div>
                    </div>
                    
                    <div className='summary-card'>
                        <div className='card-icon depletion'>
                            <i className='codicon codicon-flame'></i>
                        </div>
                        <div className='card-info'>
                            <div className='card-value'>{depletionCount}</div>
                            <div className='card-label'>Depletion Sets</div>
                        </div>
                    </div>
                </div>

                <div className='overview-grid-sections'>
                    {/* Statepoint List */}
                    {this.statepoints.length > 0 && (
                        <div className='statepoint-list-section'>
                            <h3><i className='codicon codicon-list-flat'></i> Loaded Simulations</h3>
                            <div className='statepoint-list'>
                                {this.statepoints.map((sp, index) => this.renderStatepointCard(sp, index))}
                            </div>
                        </div>
                    )}

                    {/* Depletion Summary List */}
                    {depletionCount > 0 && (
                        <div className='depletion-summary-section'>
                            <h3><i className='codicon codicon-flame'></i> Depletion Results</h3>
                            <div className='depletion-list-mini'>
                                {Array.from(this.depletionResults.values()).map((data, idx) => (
                                    <div key={idx} className='depletion-summary-card' onClick={() => { this.activeTab = 'burnup'; this.selectedDepletionFile = data.filePath; this.update(); }}>
                                        <div className='dep-info'>
                                            <span className='dep-name'>{data.fileName}</span>
                                            <span className='dep-meta'>
                                                {data.finalBurnup?.toFixed(2)} MWd/kg • {data.numberOfMaterials} materials
                                            </span>
                                        </div>
                                        <i className='codicon codicon-chevron-right'></i>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    private renderStatepointCard(sp: StatepointInfoExtended, index: number): React.ReactNode {
        return (
            <div key={sp.localId} className={`statepoint-card ${sp.error ? 'error' : ''} ${sp.loading ? 'loading' : ''}`}>
                <div className='card-main'>
                    <div className='sp-index'>#{index + 1}</div>
                    <div className='sp-info'>
                        <Tooltip content={sp.filePath} position='top'>
                            <div className='sp-name'>{sp.fileName}</div>
                        </Tooltip>
                        <div className='sp-meta'>
                            {sp.error ? (
                                <span className='error-text'><i className='codicon codicon-error'></i> {sp.error}</span>
                            ) : sp.loading ? (
                                <span className='loading-text'><i className='codicon codicon-loading codicon-modifier-spin'></i> Loading...</span>
                            ) : (
                                <>
                                    {sp.kEff && (
                                        <span className='keff-badge'>
                                            k<sub>eff</sub> = {sp.kEff.value.toFixed(5)} ± {sp.kEff.stdDev.toFixed(5)}
                                        </span>
                                    )}
                                    {sp.batches && <span>{sp.batches} batches</span>}
                                    {sp.tallies && <span>{sp.tallies.length} tallies</span>}
                                    {sp.fileSizeMB > 0 && <span>{sp.fileSizeMB.toFixed(1)} MB</span>}
                                </>
                            )}
                        </div>
                    </div>
                    <div className='sp-actions'>
                        <Tooltip content='Remove from comparison' position='top'>
                            <button 
                                className='action-btn remove'
                                onClick={() => this.removeStatepoint(sp.localId)}
                            >
                                <i className='codicon codicon-close'></i>
                            </button>
                        </Tooltip>
                    </div>
                </div>
            </div>
        );
    }

    private renderKeffTab(): React.ReactNode {
        const loadedStatepoints = this.statepoints.filter(s => s.loaded && s.kEff && !s.error);
        
        if (loadedStatepoints.length === 0) {
            return (
                <div className='tab-content empty'>
                    <i className='codicon codicon-symbol-numeric'></i>
                    <h3>No k-effective Data</h3>
                    <p className='hint'>None of the loaded statepoints contain k-effective values.</p>
                </div>
            );
        }

        // Calculate statistics
        const keffValues = loadedStatepoints.map(s => s.kEff!.value);
        const mean = keffValues.reduce((a, b) => a + b, 0) / keffValues.length;
        const variance = keffValues.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / keffValues.length;
        const stdDev = Math.sqrt(variance);
        const min = Math.min(...keffValues);
        const max = Math.max(...keffValues);

        return (
            <div className='keff-tab'>
                {/* Statistics Panel */}
                <div className='stats-panel'>
                    <h4><i className='codicon codicon-pie-chart'></i> Statistical Summary</h4>
                    <div className='stats-grid'>
                        <div className='stat-item'>
                            <span className='stat-label'>Mean k<sub>eff</sub></span>
                            <span className='stat-value'>{mean.toFixed(6)}</span>
                        </div>
                        <div className='stat-item'>
                            <span className='stat-label'>Std Deviation</span>
                            <span className='stat-value'>{stdDev.toFixed(6)}</span>
                        </div>
                        <div className='stat-item'>
                            <span className='stat-label'>Minimum</span>
                            <span className='stat-value'>{min.toFixed(6)}</span>
                        </div>
                        <div className='stat-item'>
                            <span className='stat-label'>Maximum</span>
                            <span className='stat-value'>{max.toFixed(6)}</span>
                        </div>
                        <div className='stat-item'>
                            <span className='stat-label'>Range</span>
                            <span className='stat-value'>{(max - min).toFixed(6)}</span>
                        </div>
                        <div className='stat-item'>
                            <span className='stat-label'>Relative Error</span>
                            <span className='stat-value'>{((stdDev / mean) * 100).toFixed(3)}%</span>
                        </div>
                    </div>
                </div>

                {/* k-eff Comparison Table */}
                <div className='comparison-table-container'>
                    <h4><i className='codicon codicon-table'></i> k-effective Comparison</h4>
                    <table className='comparison-table'>
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>File</th>
                                <th>k<sub>eff</sub></th>
                                <th>Std Dev</th>
                                <th>Diff from Mean</th>
                                <th>Rel. Diff (%)</th>
                            </tr>
                        </thead>
                        <tbody>
                            {loadedStatepoints.map((sp, idx) => {
                                const diff = sp.kEff!.value - mean;
                                const relDiff = (diff / mean) * 100;
                                
                                return (
                                    <tr key={sp.localId}>
                                        <td>{idx + 1}</td>
                                        <td className='filename-cell'>
                                            <Tooltip content={sp.filePath} position='top'>
                                                <span>{sp.fileName}</span>
                                            </Tooltip>
                                        </td>
                                        <td className='numeric'>{sp.kEff!.value.toFixed(6)}</td>
                                        <td className='numeric'>±{sp.kEff!.stdDev.toFixed(6)}</td>
                                        <td className={`numeric ${diff > 0 ? 'positive' : 'negative'}`}>
                                            {diff > 0 ? '+' : ''}{diff.toFixed(6)}
                                        </td>
                                        <td className={`numeric ${relDiff > 0 ? 'positive' : 'negative'}`}>
                                            {relDiff > 0 ? '+' : ''}{relDiff.toFixed(3)}%
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>

                {/* Visual Bar Chart */}
                <div className='keff-chart'>
                    <h4><i className='codicon codicon-graph'></i> Visual Comparison</h4>
                    <div className='chart-container'>
                        <div className='chart-axis-info'>
                            <span className='axis-label'>Min: {min.toFixed(5)}</span>
                            <span className='axis-label mean'>Mean: {mean.toFixed(5)}</span>
                            <span className='axis-label'>Max: {max.toFixed(5)}</span>
                        </div>
                        {loadedStatepoints.map((sp, idx) => {
                            const keff = sp.kEff!.value;
                            const meanPos = ((mean - min) / (max - min || 1)) * 100;
                            const valPos = ((keff - min) / (max - min || 1)) * 100;
                            const isAbove = keff >= mean;
                            const barWidth = Math.abs(valPos - meanPos);
                            const barLeft = isAbove ? meanPos : valPos;
                            
                            return (
                                <div key={sp.localId} className='chart-row'>
                                    <Tooltip content={sp.filePath} position='top'>
                                        <div className='chart-label'>
                                            #{idx + 1} {sp.fileName.substring(0, 20)}
                                            {sp.fileName.length > 20 ? '...' : ''}
                                        </div>
                                    </Tooltip>
                                    <div className='chart-bar-wrapper'>
                                        <div className='chart-bar-container'>
                                            <div className='mean-marker' style={{ left: `${meanPos}%` }} />
                                            <KeffChartBar 
                                                left={`${barLeft}%`}
                                                width={`${Math.max(barWidth, 0.5)}%`}
                                                isAbove={isAbove}
                                                content={`k-eff: ${keff.toFixed(5)} (${isAbove ? '+' : ''}${((keff - mean) / mean * 100).toFixed(3)}% from mean)`}
                                            />
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        );
    }

    private renderTalliesTab(): React.ReactNode {
        const loadedStatepoints = this.statepoints.filter(s => s.loaded && !s.error);
        const allTallies = new Map<number, { tally: StatepointTally; statepoints: { sp: StatepointInfoExtended; result: StatepointTally }[] }>();
        
        // Collect all tallies across statepoints
        loadedStatepoints.forEach(sp => {
            sp.tallies?.forEach(tally => {
                if (!allTallies.has(tally.id)) {
                    allTallies.set(tally.id, { tally, statepoints: [] });
                }
                allTallies.get(tally.id)!.statepoints.push({ sp, result: tally });
            });
        });

        if (allTallies.size === 0) {
            return (
                <div className='tab-content empty'>
                    <i className='codicon codicon-graph'></i>
                    <h3>No Tally Data</h3>
                    <p className='hint'>None of the loaded statepoints contain tally results.</p>
                </div>
            );
        }

        const tallyList = Array.from(allTallies.entries());
        const selectedTally = this.selectedTallyId !== undefined 
            ? allTallies.get(this.selectedTallyId)
            : tallyList[0]?.[1];

        return (
            <div className='tallies-tab'>
                <div className='tallies-layout'>
                    {/* Tally Selector */}
                    <div className='tally-selector'>
                        <h4><i className='codicon codicon-list-flat'></i> Tallies</h4>
                        <div className='tally-list'>
                            {tallyList.map(([id, data]) => (
                                <button
                                    key={id}
                                    className={`tally-item ${selectedTally?.tally.id === id ? 'active' : ''}`}
                                    onClick={() => { this.selectedTallyId = Number(id); this.update(); }}
                                >
                                    <div className='tally-id'>Tally {id}</div>
                                    <div className='tally-meta'>
                                        {data.tally.name || 'Unnamed'}
                                        <span className='sp-count'>{data.statepoints.length} sims</span>
                                    </div>
                                    <div className='tally-scores'>
                                        {data.tally.scores.slice(0, 3).join(', ')}
                                        {data.tally.scores.length > 3 && '...'}
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Tally Comparison */}
                    <div className='tally-comparison'>
                        {selectedTally && this.renderTallyComparison(selectedTally)}
                    </div>
                </div>
            </div>
        );
    }

    private renderTallyComparison(data: { tally: StatepointTally; statepoints: { sp: StatepointInfoExtended; result: StatepointTally }[] }): React.ReactNode {
        const { tally, statepoints } = data;
        
        // Calculate means for comparison
        const means = statepoints.map(({ result }) => result.mean[0] || 0);
        const overallMean = means.reduce((a, b) => a + b, 0) / means.length || 1;

        return (
            <div className='tally-detail'>
                <div className='tally-header'>
                    <h4>Tally {tally.id}{tally.name ? `: ${tally.name}` : ''}</h4>
                    <div className='tally-badges'>
                        <span className='badge'>Scores: {tally.scores.join(', ')}</span>
                        {tally.filters && tally.filters.length > 0 && (
                            <span className='badge'>{tally.filters.length} filters</span>
                        )}
                    </div>
                </div>

                <div className='tally-results-table-container'>
                    <table className='comparison-table tallies'>
                        <thead>
                            <tr>
                                <th>Simulation</th>
                                <th>Mean</th>
                                <th>Std Dev</th>
                                <th>Rel. Error</th>
                                <th>Diff from Avg</th>
                            </tr>
                        </thead>
                        <tbody>
                            {statepoints.map(({ sp, result }) => {
                                const mean = result.mean[0] || 0;
                                const stdDev = result.stdDev[0] || 0;
                                const relErr = mean !== 0 ? (stdDev / Math.abs(mean)) * 100 : 0;
                                const diff = mean - overallMean;
                                const relDiff = overallMean !== 0 ? (diff / overallMean) * 100 : 0;

                                return (
                                    <tr key={sp.localId}>
                                        <td className='filename-cell'>
                                            <Tooltip content={sp.filePath} position='top'>
                                                <span>{sp.fileName}</span>
                                            </Tooltip>
                                        </td>
                                        <td className='numeric'>{mean.toExponential(4)}</td>
                                        <td className='numeric'>{stdDev.toExponential(4)}</td>
                                        <td className={`numeric ${relErr > 5 ? 'warning' : ''}`}>{relErr.toFixed(2)}%</td>
                                        <td className={`numeric ${relDiff > 0 ? 'positive' : 'negative'}`}>
                                            {relDiff > 0 ? '+' : ''}{relDiff.toFixed(2)}%
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>

                {/* Visual Comparison */}
                <div className='tally-chart'>
                    <h5>Relative Comparison (%)</h5>
                    <div className='mini-chart'>
                        {statepoints.map(({ sp, result }) => {
                            const mean = result.mean[0] || 0;
                            const relDiff = overallMean !== 0 ? ((mean - overallMean) / overallMean) * 100 : 0;
                            const isPositive = relDiff >= 0;
                            const barWidth = Math.min(Math.abs(relDiff), 50); // Max 50% width per side

                            return (
                                <div key={sp.localId} className='mini-chart-row'>
                                    <Tooltip content={sp.filePath} position='top'>
                                        <span className='mini-label'>
                                            {sp.fileName.substring(0, 15)}{sp.fileName.length > 15 ? '...' : ''}
                                        </span>
                                    </Tooltip>
                                    <div className='mini-bar-track-wrapper'>
                                        <div className='mini-bar-track'>
                                            <div className='center-line' />
                                            <div 
                                                className={`mini-bar ${isPositive ? 'positive' : 'negative'}`}
                                                style={{ 
                                                    width: `${barWidth}%`,
                                                    left: isPositive ? '50%' : 'auto',
                                                    right: !isPositive ? '50%' : 'auto'
                                                }}
                                            />
                                        </div>
                                    </div>
                                    <span className={`mini-value ${isPositive ? 'positive' : 'negative'}`}>
                                        {relDiff > 0 ? '+' : ''}{relDiff.toFixed(1)}%
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        );
    }


    // ============================================================================
    // Tabs: Statistics, Convergence, Burnup
    // ============================================================================

    private renderStatisticsTab(): React.ReactNode {
        const loadedStatepoints = this.statepoints.filter(s => s.loaded && !s.error);
        const stats = this.statisticalTests;
        
        if (loadedStatepoints.length === 0) {
            return (
                <div className='tab-content empty'>
                    <i className='codicon codicon-pie-chart'></i>
                    <h3>No Statistics Available</h3>
                    <p className='hint'>Load statepoints to view statistical analysis.</p>
                </div>
            );
        }

        return (
            <div className='statistics-tab'>
                <div className='stats-grid-main'>
                    {/* Chi-Square Test Results */}
                    {stats?.kEffective && (
                        <div className='stats-panel chi-square'>
                            <div className='panel-header'>
                                <h4><i className='codicon codicon-symbol-numeric'></i> k-effective Consistency Test</h4>
                                <span className={`consistency-badge ${stats.kEffective.consistency}`}>
                                    {stats.kEffective.consistency.toUpperCase()}
                                </span>
                            </div>
                            <div className='chi-square-results'>
                                <div className='chi-square-metric-main'>
                                    <div className='metric-large'>
                                        <span className='label'>Reduced χ² (χ²/ndof)</span>
                                        <span className={`value ${stats.kEffective.consistency === 'inconsistent' ? 'warning' : 'success'}`}>
                                            {stats.kEffective.reducedChi2?.toFixed(3) || '—'}
                                        </span>
                                    </div>
                                </div>
                                <div className='stats-mini-grid'>
                                    <div className='stat-item'>
                                        <span className='stat-label'>Weighted Mean k<sub>eff</sub></span>
                                        <span className='stat-value'>{stats.kEffective.weightedMean.toFixed(6)}</span>
                                    </div>
                                    <div className='stat-item'>
                                        <span className='stat-label'>Weighted Uncertainty</span>
                                        <span className='stat-value'>±{stats.kEffective.weightedUncertainty.toFixed(6)}</span>
                                    </div>
                                    <div className='stat-item'>
                                        <span className='stat-label'>Chi-Square (χ²)</span>
                                        <span className='stat-value'>{stats.kEffective.chi2.toFixed(3)}</span>
                                    </div>
                                    <div className='stat-item'>
                                        <span className='stat-label'>Degrees of Freedom</span>
                                        <span className='stat-value'>{stats.kEffective.ndof}</span>
                                    </div>
                                </div>
                                <div className='chi-square-hint'>
                                    <i className='codicon codicon-info'></i>
                                    Reduced χ² {'<'} 3.0 indicates consistent results. 
                                    Higher values suggest systematic differences between simulations.
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Confidence Interval Overlap */}
                    {stats?.kEffective?.confidenceIntervals && (
                        <div className='stats-panel confidence-intervals'>
                            <h4><i className='codicon codicon-git-compare'></i> Confidence Interval Overlap</h4>
                            <div className='ci-visualization'>
                                {(() => {
                                    const intervals = stats.kEffective.confidenceIntervals.intervals;
                                    const allLowers = intervals.map(i => i.lower);
                                    const allUppers = intervals.map(i => i.upper);
                                    const minVal = Math.min(...allLowers);
                                    const maxVal = Math.max(...allUppers);
                                    const range = maxVal - minVal || 1e-6;
                                    
                                    // Add 20% padding to the visual range
                                    const paddedMin = minVal - range * 0.2;
                                    const paddedMax = maxVal + range * 0.2;
                                    const paddedRange = paddedMax - paddedMin;

                                    return intervals.map((ci, idx) => {
                                        const left = ((ci.lower - paddedMin) / paddedRange) * 100;
                                        const width = ((ci.upper - ci.lower) / paddedRange) * 100;
                                        const center = ((ci.value - paddedMin) / paddedRange) * 100;

                                        return (
                                            <div key={idx} className='ci-row'>
                                                <div className='ci-info'>
                                                    <span className='ci-label'>Sim {idx + 1}</span>
                                                    <span className='ci-value-text'>{ci.value.toFixed(5)}</span>
                                                </div>
                                                <div className='ci-bar-container'>
                                                    <div className='ci-track' />
                                                    <div 
                                                        className='ci-bar' 
                                                        style={{ 
                                                            left: `${left}%`,
                                                            width: `${width}%`
                                                        }}
                                                    >
                                                        <div className='ci-center-dot' style={{ left: `${(center - left) / (width / 100)}%` }} />
                                                    </div>
                                                </div>
                                                <span className='ci-range'>[{ci.lower.toFixed(5)}, {ci.upper.toFixed(5)}]</span>
                                            </div>
                                        );
                                    });
                                })()}
                            </div>
                            <div className={`ci-overlap-status ${stats.kEffective.confidenceIntervals.overlapExists ? 'success' : 'warning'}`}>
                                {stats.kEffective.confidenceIntervals.overlapExists ? (
                                    <>
                                        <i className='codicon codicon-check'></i> 
                                        <span>Confidence intervals overlap in range: <strong>[{stats.kEffective.confidenceIntervals.overlapLower?.toFixed(5)}, {stats.kEffective.confidenceIntervals.overlapUpper?.toFixed(5)}]</strong></span>
                                    </>
                                ) : (
                                    <>
                                        <i className='codicon codicon-warning'></i> 
                                        <span>No overlap in confidence intervals - results may be significantly different</span>
                                    </>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {/* Tally Consistency */}
                {stats?.tallies && Object.keys(stats.tallies).length > 0 && (
                    <div className='stats-panel tally-consistency'>
                        <h4><i className='codicon codicon-graph'></i> Tally Consistency</h4>
                        <div className='tally-stats-grid'>
                            {Object.entries(stats.tallies).map(([tallyKey, tallyStat]) => (
                                <div key={tallyKey} className={`tally-stat-card ${tallyStat.consistent ? 'consistent' : 'inconsistent'}`}>
                                    <div className='tally-stat-header'>
                                        <span className='tally-name'>{tallyKey.replace('tally_', 'Tally ')}</span>
                                        <span className={`consistency-indicator ${tallyStat.consistent ? 'ok' : 'warning'}`}>
                                            {tallyStat.consistent ? '✓ Consistent' : '⚠ Variable'}
                                        </span>
                                    </div>
                                    <div className='tally-stat-metrics'>
                                        <div className='metric'>
                                            <span className='label'>Mean</span>
                                            <span className='value'>{tallyStat.mean.toExponential(4)}</span>
                                        </div>
                                        <div className='metric'>
                                            <span className='label'>Max Deviation</span>
                                            <span className='value'>{tallyStat.maxDeviation.toExponential(4)}</span>
                                        </div>
                                        <div className='metric'>
                                            <span className='label'>Rel. Std Dev</span>
                                            <span className={`value-badge ${tallyStat.relativeStdDev > 5 ? 'warning' : 'success'}`}>
                                                {tallyStat.relativeStdDev.toFixed(2)}%
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Simulation Metadata */}
                <div className='stats-overview'>
                    <h4><i className='codicon codicon-info'></i> Simulation Metadata</h4>
                    <div className='metadata-grid'>
                        {loadedStatepoints.map((sp, idx) => (
                            <div key={sp.localId} className='metadata-card'>
                                <div className='meta-header'>
                                    <span className='meta-index'>#{idx + 1}</span>
                                    <Tooltip content={sp.filePath} position='top'>
                                        <span className='meta-name'>{sp.fileName}</span>
                                    </Tooltip>
                                </div>
                                <div className='meta-details'>
                                    <div className='meta-row'>
                                        <span className='meta-label'>Run Mode</span>
                                        <span className='meta-value'>{sp.runMode || 'Unknown'}</span>
                                    </div>
                                    <div className='meta-row'>
                                        <span className='meta-label'>Batches</span>
                                        <span className='meta-value'>{sp.batches || '—'}</span>
                                    </div>
                                    <div className='meta-row'>
                                        <span className='meta-label'>Particles/Batch</span>
                                        <span className='meta-value'>
                                            {sp.particles ? sp.particles.toLocaleString() : '—'}
                                        </span>
                                    </div>
                                    <div className='meta-row'>
                                        <span className='meta-label'>Tallies</span>
                                        <span className='meta-value'>{sp.tallies?.length || 0}</span>
                                    </div>
                                    {sp.version && (
                                        <div className='meta-row'>
                                            <span className='meta-label'>OpenMC Version</span>
                                            <span className='meta-value'>{sp.version}</span>
                                        </div>
                                    )}
                                    {sp.date && (
                                        <div className='meta-row'>
                                            <span className='meta-label'>Date</span>
                                            <span className='meta-value'>
                                                {new Date(sp.date).toLocaleString()}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        );
    }

    private renderConvergenceTab(): React.ReactNode {
        const loadedStatepoints = this.statepoints.filter(s => s.loaded && s.kEff && !s.error);
        
        if (loadedStatepoints.length === 0) {
            return (
                <div className='tab-content empty'>
                    <i className='codicon codicon-history'></i>
                    <h3>No Convergence Data</h3>
                    <p className='hint'>Load eigenvalue statepoints to analyze k-effective convergence.</p>
                </div>
            );
        }

        return (
            <div className='convergence-tab'>
                <div className='convergence-header'>
                    <h4><i className='codicon codicon-history'></i> k-effective Convergence Analysis</h4>
                    <p className='hint'>Analyzes the convergence of k-effective across batches for each simulation.</p>
                </div>
                
                <div className='convergence-grid'>
                    {loadedStatepoints.map((sp, idx) => {
                        const analysis = this.convergenceAnalysis?.get(sp.localId);
                        
                        return (
                            <div key={sp.localId} className='convergence-card'>
                                <div className='conv-header'>
                                    <span className='conv-index'>#{idx + 1}</span>
                                    <Tooltip content={sp.filePath} position='top'>
                                        <span className='conv-name'>{sp.fileName}</span>
                                    </Tooltip>
                                    {analysis?.converged !== undefined && (
                                        <span className={`conv-status ${analysis.converged ? 'converged' : 'not-converged'}`}>
                                            {analysis.converged ? '✓ Converged' : '⚠ Not Converged'}
                                        </span>
                                    )}
                                </div>
                                
                                {analysis?.success ? (
                                    <div className='conv-content'>
                                        <div className='conv-report-grid'>
                                            <div className='conv-metric-card main'>
                                                <span className='label'>Final k-effective</span>
                                                <span className='value'>{analysis.finalValue.toFixed(6)}</span>
                                                <div className='sub-label'>Result from last batch</div>
                                            </div>
                                            <div className='conv-metric-card'>
                                                <span className='label'>Stability (Drift)</span>
                                                <span className={`value ${analysis.driftPercent && analysis.driftPercent > 1 ? 'warning' : 'success'}`}>
                                                    {analysis.driftPercent !== undefined ? `${analysis.driftPercent.toFixed(3)}%` : '—'}
                                                </span>
                                                <div className='sub-label'>Relative trend</div>
                                            </div>
                                            <div className='conv-metric-card'>
                                                <span className='label'>Batches Analyzed</span>
                                                <span className='value'>{analysis.runningAverage?.length || '—'}</span>
                                                <div className='sub-label'>Sample size</div>
                                            </div>
                                        </div>
                                        
                                        {analysis.recommendation && (
                                            <div className={`conv-status-banner ${analysis.converged ? 'good' : 'warning'}`}>
                                                <div className='banner-icon'>
                                                    <i className={`codicon ${analysis.converged ? 'codicon-check' : 'codicon-warning'}`}></i>
                                                </div>
                                                <div className='banner-text'>
                                                    <strong>{analysis.converged ? 'Stable Result' : 'Convergence Warning'}</strong>
                                                    <p>{analysis.recommendation}</p>
                                                </div>
                                            </div>
                                        )}
                                        
                                        {/* Running Average Chart */}
                                        {analysis.runningAverage && analysis.runningAverage.length > 0 && (
                                            <div className='conv-chart-section'>
                                                <div className='chart-header'>
                                                    <span className='chart-title'>Batch Evolution (Running Average)</span>
                                                    <div className='chart-legend'>
                                                        <span className='legend-item'><span className='dot min' /> Min</span>
                                                        <span className='legend-item'><span className='dot max' /> Max</span>
                                                    </div>
                                                </div>
                                                <div className='sparkline-container'>
                                                    {(() => {
                                                        const avg = analysis.runningAverage;
                                                        const minVal = Math.min(...avg);
                                                        const maxVal = Math.max(...avg);
                                                        const range = maxVal - minVal || 1e-6;
                                                        
                                                        return avg.map((val, i) => {
                                                            const height = ((val - minVal) / range) * 100;
                                                            const isMin = val === minVal;
                                                            const isMax = val === maxVal;
                                                            
                                                            return (
                                                                <ConvergenceSparkBar 
                                                                    key={i}
                                                                    height={height}
                                                                    content={`Batch ${i + 1}: ${val.toFixed(6)}${isMin ? ' (Min)' : ''}${isMax ? ' (Max)' : ''}`}
                                                                />
                                                            );
                                                        });
                                                    })()}
                                                </div>
                                                <div className='sparkline-axis'>
                                                    <span className='axis-point'>Batch 1</span>
                                                    <span className='axis-point middle'>Convergence Progress</span>
                                                    <span className='axis-point'>Batch {analysis.runningAverage.length}</span>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <div className='conv-loading'>
                                        {this.analyzingIds.has(sp.localId) ? (
                                            <div className='analyzing-spinner'>
                                                <i className='codicon codicon-loading codicon-modifier-spin'></i>
                                                <span>Analyzing Convergence...</span>
                                            </div>
                                        ) : (
                                            <button 
                                                className='theia-button secondary small'
                                                onClick={() => this.analyzeConvergence(sp.localId, sp.filePath)}
                                            >
                                                <i className='codicon codicon-play'></i> Analyze Convergence
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        );
    }

    private async analyzeConvergence(localId: string, filePath: string): Promise<void> {
        if (this.analyzingIds.has(localId)) return;
        
        this.analyzingIds.add(localId);
        this.update();
        
        try {
            const result = await this.backendService.analyzeConvergence({ filePath });
            if (!this.convergenceAnalysis) {
                this.convergenceAnalysis = new Map();
            }
            this.convergenceAnalysis.set(localId, result);
        } catch (error) {
            this.messageService.error(`Failed to analyze convergence: ${error}`);
        } finally {
            this.analyzingIds.delete(localId);
            this.update();
        }
    }

    private renderBurnupTab(): React.ReactNode {
        if (this.depletionResults.size === 0) {
            return (
                <div className='tab-content empty'>
                    <i className='codicon codicon-flame'></i>
                    <h3>No Depletion Results</h3>
                    <p className='hint'>
                        Add depletion results files (depletion_results.h5) to analyze burnup and nuclide evolution.
                    </p>
                    <button className='theia-button primary' onClick={() => this.openAddDepletionDialog()}>
                        <i className='codicon codicon-add'></i> Add Depletion Results
                    </button>
                </div>
            );
        }

        const depletionList = Array.from(this.depletionResults.entries());
        const selectedDepletion = this.selectedDepletionFile 
            ? this.depletionResults.get(this.selectedDepletionFile)
            : depletionList[0]?.[1];

        return (
            <div className='burnup-tab'>
                <div className='burnup-layout'>
                    {/* Depletion File Selector */}
                    <div className='depletion-selector'>
                        <h4><i className='codicon codicon-list-flat'></i> Depletion Results</h4>
                        <div className='depletion-list'>
                            {depletionList.map(([path, data]) => (
                                <button
                                    key={path}
                                    className={`depletion-item ${this.selectedDepletionFile === path ? 'active' : ''}`}
                                    onClick={() => { this.selectedDepletionFile = path; this.update(); }}
                                >
                                    <div className='dep-name'>{data.fileName}</div>
                                    <div className='dep-meta'>
                                        {data.finalBurnup !== undefined && (
                                            <span>{data.finalBurnup.toFixed(2)} MWd/kg</span>
                                        )}
                                        <span>{data.numberOfMaterials} materials</span>
                                    </div>
                                </button>
                            ))}
                        </div>
                        <button className='theia-button secondary small' onClick={() => this.openAddDepletionDialog()}>
                            <i className='codicon codicon-add'></i> Add More
                        </button>
                    </div>

                    {/* Depletion Details */}
                    <div className='depletion-details'>
                        {selectedDepletion && this.renderDepletionDetails(selectedDepletion)}
                    </div>
                </div>
            </div>
        );
    }

    private renderDepletionDetails(data: DepletionResults): React.ReactNode {
        if (!data.materials || Object.keys(data.materials).length === 0) {
            return (
                <div className='empty-state-mini'>
                    <i className='codicon codicon-info'></i>
                    <p>No material data available in this depletion file.</p>
                </div>
            );
        }

        const materialList = Object.entries(data.materials);
        
        // Auto-select material if none selected
        if (!this.selectedMaterialId || !data.materials[this.selectedMaterialId]) {
            this.selectedMaterialId = materialList[0][0];
        }

        return (
            <div className='depletion-content'>
                <div className='dep-header'>
                    <h4>{data.fileName}</h4>
                    <div className='dep-badges'>
                        {data.finalBurnup !== undefined && (
                            <span className='badge burnup'>Final Burnup: {data.finalBurnup.toFixed(2)} MWd/kg</span>
                        )}
                        <span className='badge'>{data.numberOfMaterials} Materials</span>
                        {data.timeSteps && (
                            <span className='badge'>{data.timeSteps.length} Time Steps</span>
                        )}
                    </div>
                </div>

                {/* Depletion Controls */}
                <div className='depletion-controls'>
                    <div className='control-group'>
                        <label>Plot Type:</label>
                        <div className='toggle-group'>
                            <button 
                                className={`theia-button secondary small ${this.burnupPlotType === 'concentration' ? 'active' : ''}`}
                                onClick={() => { this.burnupPlotType = 'concentration'; this.update(); }}
                            >
                                <i className='codicon codicon-graph-line'></i> Nuclides
                            </button>
                            <button 
                                className={`theia-button secondary small ${this.burnupPlotType === 'keff' ? 'active' : ''}`}
                                onClick={() => { this.burnupPlotType = 'keff'; this.update(); }}
                                disabled={!data.keff}
                                title={!data.keff ? 'No k-effective data available' : ''}
                            >
                                <i className='codicon codicon-pulse'></i> k-effective
                            </button>
                        </div>
                    </div>
                    
                    <div className='control-group'>
                        <label>X-Axis:</label>
                        <div className='toggle-group'>
                            <button 
                                className={`theia-button secondary small ${this.burnupXAxis === 'burnup' ? 'active' : ''}`}
                                onClick={() => { this.burnupXAxis = 'burnup'; this.update(); }}
                                disabled={!data.burnupSteps}
                            >
                                Burnup
                            </button>
                            <button 
                                className={`theia-button secondary small ${this.burnupXAxis === 'time' ? 'active' : ''}`}
                                onClick={() => { this.burnupXAxis = 'time'; this.update(); }}
                            >
                                Time
                            </button>
                        </div>
                    </div>

                    <div className='control-group'>
                        <label>Scale:</label>
                        <div className='toggle-group'>
                            <button 
                                className={`theia-button secondary small ${this.burnupScale === 'linear' ? 'active' : ''}`}
                                onClick={() => { this.burnupScale = 'linear'; this.update(); }}
                            >
                                Linear
                            </button>
                            <button 
                                className={`theia-button secondary small ${this.burnupScale === 'log' ? 'active' : ''}`}
                                onClick={() => { this.burnupScale = 'log'; this.update(); }}
                            >
                                Log
                            </button>
                        </div>
                    </div>
                </div>

                {/* Depletion Chart Area */}
                <div className='depletion-chart-container'>
                    {this.renderDepletionChart(data)}
                </div>

                {/* Materials Selection (if plotting concentrations) */}
                {this.burnupPlotType === 'concentration' && (
                    <div className='material-selector-bar'>
                        <label>Material:</label>
                        <select 
                            value={this.selectedMaterialId} 
                            onChange={(e) => { this.selectedMaterialId = e.target.value; this.update(); }}
                        >
                            {materialList.map(([id, mat]) => (
                                <option key={id} value={id}>{mat.name} (ID: {id})</option>
                            ))}
                        </select>
                        <div className='nuclide-quick-select'>
                            <span>Quick Select:</span>
                            <button className='theia-button secondary small' onClick={() => { this.selectedNuclides = new Set(['U235', 'U238', 'Pu239', 'Pu240']); this.update(); }}>Actinides</button>
                            <button className='theia-button secondary small' onClick={() => { this.selectedNuclides = new Set(['Xe135', 'Sm149', 'I135', 'Cs137']); this.update(); }}>Fission Products</button>
                        </div>
                    </div>
                )}

                {/* Materials Grid / Nuclide Table */}
                <div className='materials-accordion'>
                    {materialList.map(([matId, mat]) => (
                        <div key={matId} className={`material-accordion-item ${this.selectedMaterialId === matId ? 'selected' : ''}`}>
                            <div className='material-header' onClick={() => { this.selectedMaterialId = matId; this.update(); }}>
                                <i className={`codicon ${this.selectedMaterialId === matId ? 'codicon-chevron-down' : 'codicon-chevron-right'}`}></i>
                                <span className='material-name'>{mat.name}</span>
                                <span className='material-nuclide-count'>{Object.keys(mat.nuclides).length} nuclides</span>
                            </div>
                            {this.selectedMaterialId === matId && (
                                <div className='nuclide-table-container'>
                                    <table className='nuclide-table'>
                                        <thead>
                                            <tr>
                                                <th className='select-col'></th>
                                                <th>Nuclide</th>
                                                <th className='numeric'>Initial (g/cm³)</th>
                                                <th className='numeric'>Final (g/cm³)</th>
                                                <th className='numeric'>Change</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {Object.entries(mat.nuclides)
                                                .sort((a, b) => b[1].final - a[1].final) // Sort by final concentration
                                                .slice(0, 50) // Show top 50
                                                .map(([nuclide, nucData]) => {
                                                    const change = nucData.final - nucData.initial;
                                                    const changePercent = nucData.initial !== 0 
                                                        ? (change / nucData.initial) * 100 
                                                        : 0;
                                                    const isSelected = this.selectedNuclides.has(nuclide);
                                                    
                                                    return (
                                                        <tr 
                                                            key={nuclide} 
                                                            className={isSelected ? 'selected' : ''}
                                                            onClick={() => {
                                                                if (isSelected) this.selectedNuclides.delete(nuclide);
                                                                else this.selectedNuclides.add(nuclide);
                                                                this.update();
                                                            }}
                                                        >
                                                            <td className='select-col'>
                                                                <input type='checkbox' checked={isSelected} readOnly />
                                                            </td>
                                                            <td className='nuclide-name'>{nuclide}</td>
                                                            <td className='numeric'>{nucData.initial.toExponential(3)}</td>
                                                            <td className='numeric'>{nucData.final.toExponential(3)}</td>
                                                            <td className={`numeric ${change > 0 ? 'positive' : change < 0 ? 'negative' : ''}`}>
                                                                {change > 0 ? '+' : ''}{changePercent.toFixed(1)}%
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                        </tbody>
                                    </table>
                                    {Object.keys(mat.nuclides).length > 50 && (
                                        <div className='more-nuclides'>
                                            +{Object.keys(mat.nuclides).length - 50} more nuclides
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    private renderDepletionChart(data: DepletionResults): React.ReactNode {
        if (this.burnupPlotType === 'keff' && data.keff) {
            return this.renderKeffDepletionChart(data);
        }

        if (this.selectedNuclides.size === 0) {
            return (
                <div className='chart-placeholder'>
                    <div className='chart-info'>
                        <i className='codicon codicon-graph-line'></i>
                        <p>Select nuclides from the table below to visualize their evolution over time.</p>
                    </div>
                </div>
            );
        }

        const selectedMaterial = this.selectedMaterialId ? data.materials[this.selectedMaterialId] : undefined;
        if (!selectedMaterial) {
            return (
                <div className='chart-placeholder'>
                    <div className='chart-info'>
                        <i className='codicon codicon-warning'></i>
                        <p>Select a material to visualize nuclide concentrations.</p>
                    </div>
                </div>
            );
        }

        // Get x-axis data
        let xValues: number[] = [];
        let xLabel = '';
        
        if (this.burnupXAxis === 'burnup' && data.burnupSteps) {
            xValues = data.burnupSteps;
            xLabel = 'Burnup (MWd/kg)';
        } else if (data.timeSteps) {
            xValues = data.timeSteps.map(t => t / (24 * 3600)); // Convert to days
            xLabel = 'Time (days)';
        } else {
            return <div className='chart-placeholder'>No x-axis data (time/burnup) available.</div>;
        }

        // Prepare traces
        const traces: any[] = [];
        const colors = [
            '#2196f3', '#f44336', '#4caf50', '#ff9800', '#9c27b0',
            '#00bcd4', '#795548', '#607d8b', '#e91e63', '#8bc34a'
        ];

        let colorIdx = 0;
        for (const nuclide of this.selectedNuclides) {
            const nucData = selectedMaterial.nuclides[nuclide];
            if (nucData && nucData.concentrations) {
                traces.push({
                    x: xValues,
                    y: nucData.concentrations,
                    name: nuclide,
                    type: 'scatter',
                    mode: 'lines+markers',
                    marker: { size: 6 },
                    line: { width: 2, color: colors[colorIdx % colors.length] }
                });
                colorIdx++;
            }
        }

        const bgColor = this.getCssColor('--theia-editor-background', '#1e1e1e');
        const fgColor = this.getCssColor('--theia-foreground', '#cccccc');
        const gridColor = this.getCssColor('--theia-panel-border', '#333333');

        const layout: any = {
            paper_bgcolor: bgColor,
            plot_bgcolor: bgColor,
            margin: { t: 40, r: 30, b: 50, l: 80 },
            hovermode: 'closest',
            font: { color: fgColor, size: 11 },
            xaxis: {
                title: { text: xLabel, font: { size: 12, color: fgColor } },
                gridcolor: gridColor,
                tickfont: { color: fgColor },
                linecolor: gridColor
            },
            yaxis: {
                title: { text: 'Concentration (g/cm³)', font: { size: 12, color: fgColor } },
                type: this.burnupScale,
                gridcolor: gridColor,
                tickfont: { color: fgColor },
                linecolor: gridColor,
                exponentformat: 'e'
            },
            legend: {
                font: { color: fgColor },
                bgcolor: 'rgba(0,0,0,0)'
            }
        };

        const config = {
            responsive: true,
            displayModeBar: false
        };

        return <PlotlyComponent data={traces} layout={layout} config={config} />;
    }

    private renderKeffDepletionChart(data: DepletionResults): React.ReactNode {
        if (!data.keff) return null;

        let xValues: number[] = [];
        let xLabel = '';
        
        if (this.burnupXAxis === 'burnup' && data.burnupSteps) {
            xValues = data.burnupSteps;
            xLabel = 'Burnup (MWd/kg)';
        } else if (data.timeSteps) {
            xValues = data.timeSteps.map(t => t / (24 * 3600));
            xLabel = 'Time (days)';
        }

        const traces: any[] = [
            {
                x: xValues,
                y: data.keff.map(k => k.value),
                error_y: {
                    type: 'data',
                    array: data.keff.map(k => k.stdDev * 2), // 2-sigma
                    visible: true,
                    color: 'rgba(76, 175, 80, 0.5)'
                },
                name: 'k-effective',
                type: 'scatter',
                mode: 'lines+markers',
                line: { color: '#4caf50', width: 3 },
                marker: { size: 8, color: '#4caf50' }
            }
        ];

        const bgColor = this.getCssColor('--theia-editor-background', '#1e1e1e');
        const fgColor = this.getCssColor('--theia-foreground', '#cccccc');
        const gridColor = this.getCssColor('--theia-panel-border', '#333333');

        const layout: any = {
            paper_bgcolor: bgColor,
            plot_bgcolor: bgColor,
            margin: { t: 40, r: 30, b: 50, l: 80 },
            font: { color: fgColor, size: 11 },
            xaxis: {
                title: { text: xLabel, font: { size: 12, color: fgColor } },
                gridcolor: gridColor,
                tickfont: { color: fgColor }
            },
            yaxis: {
                title: { text: 'k-effective', font: { size: 12, color: fgColor } },
                gridcolor: gridColor,
                tickfont: { color: fgColor }
            }
        };

        return <PlotlyComponent data={traces} layout={layout} config={{ displayModeBar: false, responsive: true }} />;
    }

    private getCssColor(variable: string, fallback: string): string {
        if (typeof window === 'undefined') return fallback;
        const computed = getComputedStyle(document.body).getPropertyValue(variable.replace('var(', '').replace(')', '')).trim();
        return computed || fallback;
    }

    private async openAddDepletionDialog(): Promise<void> {
        const props: OpenFileDialogProps = {
            title: 'Select Depletion Results Files',
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: true,
            filters: {
                'Depletion Results': ['h5'],
                'HDF5 Files': ['h5', 'hdf5'],
                'All Files': ['*']
            }
        };

        const uris = await this.fileDialogService.showOpenDialog(props);
        const uriArray = Array.isArray(uris) ? uris : (uris ? [uris] : []);
        
        if (uriArray.length === 0) {
            return;
        }

        // Set loading state and switch to burnup tab immediately (if no statepoints)
        this.isLoading = true;
        if (this.statepoints.length === 0 && this.depletionResults.size === 0) {
            this.activeTab = 'burnup';
        }
        this.update();
        
        for (const uri of uriArray) {
            const filePath = uri.path.toString();
            
            if (this.depletionResults.has(filePath)) {
                this.messageService.warn(`Depletion file already loaded: ${filePath}`);
                continue;
            }

            try {
                const result = await this.backendService.readDepletionResults({ filePath });
                if (result.success) {
                    this.depletionResults.set(filePath, result);
                    this.messageService.info(`Loaded depletion results: ${result.fileName}`);
                } else {
                    this.messageService.error(`Failed to load depletion results: ${result.error}`);
                }
            } catch (error) {
                this.messageService.error(`Error loading depletion file: ${error}`);
            }
        }
        
        this.isLoading = false;
        this.update();
    }

    // ============================================================================
    // Actions
    // ============================================================================

    private async openAddDialog(): Promise<void> {
        const props: OpenFileDialogProps = {
            title: 'Select Statepoint Files to Compare',
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: true,
            filters: {
                'Statepoint Files': ['h5'],
                'HDF5 Files': ['h5', 'hdf5'],
                'All Files': ['*']
            }
        };

        const uris = await this.fileDialogService.showOpenDialog(props);
        // Handle both single URI and array of URIs
        const uriArray = Array.isArray(uris) ? uris : (uris ? [uris] : []);
        if (uriArray.length > 0) {
            
            for (const uri of uriArray) {
                const filePath = uri.path.toString();
                const fileName = filePath.split('/').pop() || filePath;
                
                // Check if already loaded
                if (this.statepoints.some(s => s.filePath === filePath)) {
                    this.messageService.warn(`${fileName} is already loaded`);
                    continue;
                }

                const newStatepoint: StatepointInfoExtended = {
                    localId: `sp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    filePath,
                    fileName,
                    fileSizeMB: 0,
                    success: false,
                    loaded: false,
                    loading: false
                };

                this.statepoints.push(newStatepoint);
                this.loadStatepointData(newStatepoint);
            }
            
            this.update();
        }
    }

    private async loadStatepointData(statepoint: StatepointInfoExtended): Promise<void> {
        try {
            statepoint.loading = true;
            this.update();
            
            // Call the backend to read the actual statepoint file
            const result = await this.backendService.readStatepoint({ filePath: statepoint.filePath });
            
            // Copy all result data to our statepoint
            Object.assign(statepoint, result);
            statepoint.loading = false;
            statepoint.loaded = result.success;
            
            if (!result.success && result.error) {
                statepoint.error = result.error;
            }
            
            this.update();
            
            // If we have multiple loaded statepoints, fetch statistical comparison
            const loadedCount = this.statepoints.filter(s => s.loaded).length;
            if (loadedCount >= 2) {
                this.fetchStatisticalTests();
            }
        } catch (error) {
            statepoint.loading = false;
            statepoint.loaded = false;
            statepoint.error = error instanceof Error ? error.message : 'Failed to load statepoint';
            this.update();
        }
    }

    private async fetchStatisticalTests(): Promise<void> {
        try {
            const loadedPaths = this.statepoints
                .filter(s => s.loaded && !s.error)
                .map(s => s.filePath);
            
            if (loadedPaths.length < 2) return;
            
            const result = await this.backendService.compareStatepoints({ filePaths: loadedPaths });
            
            if (result.statisticalTests) {
                this.statisticalTests = result.statisticalTests;
                this.update();
            }
        } catch (error) {
            console.error('Failed to fetch statistical tests:', error);
        }
    }

    private removeStatepoint(localId: string): void {
        this.statepoints = this.statepoints.filter(s => s.localId !== localId);
        this.update();
    }

    private clearAll(): void {
        this.statepoints = [];
        this.depletionResults.clear();
        this.selectedTallyId = undefined;
        this.selectedDepletionFile = undefined;
        this.statisticalTests = undefined;
        this.convergenceAnalysis?.clear();
        this.update();
    }

    private async exportResults(): Promise<void> {
        // Generate CSV export
        const lines: string[] = [];
        lines.push('Simulation Comparison Report');
        lines.push(`Generated: ${new Date().toISOString()}`);
        lines.push('');
        
        // k-effective comparison
        const keffStatepoints = this.statepoints.filter(s => s.loaded && s.kEff);
        if (keffStatepoints.length > 0) {
            lines.push('k-effective Comparison');
            lines.push('File,k-eff,Std Dev');
            keffStatepoints.forEach(sp => {
                lines.push(`${sp.fileName},${sp.kEff!.value},${sp.kEff!.stdDev}`);
            });
            lines.push('');
        }
        
        // Tally comparison
        this.statepoints.forEach(sp => {
            if (sp.tallies && sp.tallies.length > 0) {
                lines.push(`Tallies - ${sp.fileName}`);
                lines.push('Tally ID,Name,Score,Mean,Std Dev');
                sp.tallies.forEach(t => {
                    lines.push(`${t.id},${t.name || ''},${t.scores[0]},${t.mean[0]},${t.stdDev[0]}`);
                });
                lines.push('');
            }
        });
        
        // Depletion results
        if (this.depletionResults.size > 0) {
            lines.push('Depletion Results Summary');
            lines.push('File,Final Burnup (MWd/kg),Materials,Time Steps');
            this.depletionResults.forEach((data, path) => {
                lines.push(`${data.fileName},${data.finalBurnup || 'N/A'},${data.numberOfMaterials},${data.timeSteps?.length || 'N/A'}`);
            });
            lines.push('');
            
            // Detailed nuclide data for each depletion file
            this.depletionResults.forEach((data, path) => {
                if (data.materials && Object.keys(data.materials).length > 0) {
                    lines.push(`Depletion Nuclides - ${data.fileName}`);
                    lines.push('Material,Nuclide,Initial,Final,Min,Max');
                    Object.entries(data.materials).forEach(([matId, matData]) => {
                        Object.entries(matData.nuclides).forEach(([nuc, nucData]) => {
                            lines.push(`${matData.name || matId},${nuc},${nucData.initial},${nucData.final},${nucData.min},${nucData.max}`);
                        });
                    });
                    lines.push('');
                }
            });
        }
        
        const csv = lines.join('\n');
        
        // Show save dialog
        const props: SaveFileDialogProps = {
            title: 'Save Comparison Report',
            saveLabel: 'Save',
            filters: {
                'CSV Files': ['csv'],
                'All Files': ['*']
            },
            inputValue: `openmc-comparison-report-${new Date().toISOString().split('T')[0]}.csv`
        };
        
        try {
            const uri = await this.fileDialogService.showSaveDialog(props);
            if (uri) {
                const contentBuffer = BinaryBuffer.fromString(csv);
                await this.fileService.writeFile(uri, contentBuffer);
                this.messageService.info(`Comparison report saved to: ${uri.path.base}`);
            }
        } catch (error) {
            this.messageService.error(`Failed to save report: ${error}`);
        }
    }
}
