/*******************************************************************************
 * Copyright (C) 2024 NukeHub and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
 *******************************************************************************/

import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { MessageService } from '@theia/core/lib/common/message-service';
import { FileDialogService, SaveFileDialogProps } from '@theia/filesystem/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { OpenMCStateManager } from '../openmc-state-manager';
import { OpenMCStudioService } from '../openmc-studio-service';
import { OpenMCParameterSweep, OpenMCOptimizationRun } from '../../common/openmc-state-schema';
import { OpenMCStudioBackendService } from '../../common/openmc-studio-protocol';
import { NukeCoreService } from 'nuke-core/lib/common';
import { PlotlyComponent } from 'nuke-visualizer/lib/browser/plotly/plotly-component';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components/tooltip';

@injectable()
export class OptimizationWidget extends ReactWidget {
    static readonly ID = 'openmc-optimization-widget';
    static readonly LABEL = 'Optimization Study';

    @inject(OpenMCStateManager)
    protected readonly stateManager: OpenMCStateManager;

    @inject(OpenMCStudioBackendService)
    protected readonly backendService: OpenMCStudioBackendService;

    @inject(OpenMCStudioService)
    protected readonly studioService: OpenMCStudioService;

    @inject(NukeCoreService)
    protected readonly nukeCoreService: NukeCoreService;

    @inject(FileDialogService)
    protected readonly fileDialogService: FileDialogService;

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    private activeTab: 'sweeps' | 'runner' | 'results' | 'analysis' = 'sweeps';
    private selectedSweepId?: number;
    private selectedRunId?: string;
    private editingSweepId?: number;
    private editingSweepData?: OpenMCParameterSweep;
    private analysisRunId?: string;
    private iterationLogsIndex: { iteration: number; hasLog: boolean; timestamp: string }[] = [];
    private selectedIteration?: number;
    private loadedLogContent = '';
    private filteredLogContent = '';
    private expandedIterations = new Set<number>();
    private showLogMaximized = false;
    private logPanelHeight = 350;
    private logViewerRef = React.createRef<HTMLPreElement>();

    @postConstruct()
    protected init(): void {
        this.id = OptimizationWidget.ID;
        this.title.label = OptimizationWidget.LABEL;
        this.title.caption = OptimizationWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-symbol-variable';
        
        window.addEventListener('openmc-optimization-progress', ((evt: CustomEvent) => {
            const event = evt.detail;
            console.log('[OptimizationWidget] Progress update:', event);
            this.stateManager.updateOptimizationRun(event.runId, {
                currentIteration: event.currentIteration,
                status: event.status
            });
            
            // Load iteration logs when iteration progresses
            if (event.currentIteration > 0 && event.status === 'running') {
                this.loadIterationLogsIndex(event.runId);
            }
            
            // Refresh the currently loaded log if running
            if (this.selectedIteration && this.expandedIterations.has(this.selectedIteration)) {
                this.loadIterationLog(event.runId, this.selectedIteration);
            }
            
            this.update();
        }) as EventListener);

        // Listen to live output for auto-refresh
        window.addEventListener('openmc-output', ((evt: CustomEvent) => {
            const activeRun = this.stateManager.getActiveOptimizationRun();
            if (activeRun && this.selectedIteration && this.expandedIterations.has(this.selectedIteration)) {
                // Refresh log whenever there's new output
                this.loadIterationLog(activeRun.id, this.selectedIteration);
            }
        }) as EventListener);

        window.addEventListener('openmc-optimization-iteration', ((evt: CustomEvent) => {
            const { runId, result } = evt.detail;
            console.log('[OptimizationWidget] Iteration complete:', runId, result);
            const run = this.stateManager.getOptimizationRun(runId);
            if (run) {
                // Check if this iteration already exists to avoid duplicates
                const existingIndex = run.results.findIndex(r => r.iteration === result.iteration);
                if (existingIndex === -1) {
                    const updatedResults = [...run.results, result];
                    this.stateManager.updateOptimizationRun(runId, {
                        results: updatedResults,
                        currentIteration: result.iteration
                    });
                }
                this.update();
            }
        }) as EventListener);

        // Listen to live log output from backend
        window.addEventListener('openmc-output', ((evt: CustomEvent) => {
            const { type, data } = evt.detail;
            const activeRun = this.stateManager.getActiveOptimizationRun();
            if (activeRun) {
                const lines = data.split('\n');
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    // Skip logo/art lines
                    if (/^[\s%#|]+$/.test(trimmed)) continue;
                    if (trimmed.match(/^%+$|^#+$/)) continue;
                    if (trimmed.includes('############')) continue;
                    // Add to log messages
                    const logLevel = (type === 'stderr' ? 'warning' : 'info') as 'info' | 'warning' | 'error';
                    const logMessages = [...activeRun.logMessages, {
                        timestamp: new Date().toISOString(),
                        level: logLevel,
                        message: line
                    }];
                    this.stateManager.updateOptimizationRun(activeRun.id, {
                        logMessages
                    });
                }
                this.update();
            }
        }) as EventListener);

        this.update();
    }

    dispose(): void {
        const activeRun = this.stateManager.getActiveOptimizationRun();
        if (activeRun?.status === 'running') {
            this.stopBatchRun();
        }
        if (this.progressInterval) {
            window.clearInterval(this.progressInterval);
            this.progressInterval = undefined;
        }
        super.dispose();
    }

    protected render(): React.ReactNode {        
        try {
            return (
                <div className='optimization-widget'>
                    {this.renderHeader()}
                    {this.renderTabs()}
                    <div className='optimization-widget-content'>
                        {this.activeTab === 'sweeps' && this.renderSweepsTab()}
                        {this.activeTab === 'runner' && this.renderRunnerTab()}
                        {this.activeTab === 'results' && this.renderResultsTab()}
                        {this.activeTab === 'analysis' && this.renderAnalysisTab()}
                    </div>
                </div>
            );
        } catch (error) {
            console.error('[OptimizationWidget] Error in render:', error);
            return (
                <div className='optimization-widget error'>
                    <div className='empty-state'>
                        <i className='codicon codicon-error'></i>
                        <p>Failed to render widget.</p>
                        <p className='empty-hint'>{String(error)}</p>
                    </div>
                </div>
            );
        }
    }

    protected renderHeader(): React.ReactNode {
        const projectPath = this.stateManager.projectPath;

        return (
            <div className='optimization-header'>
                <div className='optimization-info'>
                    <h2>
                        <i className='codicon codicon-symbol-variable'></i>
                        Optimization Study
                    </h2>
                    <p className='optimization-description'>
                        Define parameter sweeps and run automated optimization studies
                        {projectPath && (
                            <span className='project-path' title={projectPath}>
                                {' '}• {projectPath.split('/').pop()}
                            </span>
                        )}
                    </p>
                </div>
            </div>
        );
    }

    protected renderQuickStartGuide(): React.ReactNode {
        return (
            <div className='quick-start-guide'>
                <h4><i className='codicon codicon-book'></i> Getting Started with Optimization</h4>
                <div className='guide-cards'>
                    <div className='guide-card'>
                        <div className='guide-icon'><i className='codicon codicon-list-selection'></i></div>
                        <h5>1. Define Sweeps</h5>
                        <p>Create parameter sweeps to vary inputs like enrichment, density, or geometry dimensions.</p>
                        <code>Example: U-235 enrichment from 3% to 5%</code>
                    </div>
                    <div className='guide-card'>
                        <div className='guide-icon'><i className='codicon codicon-play'></i></div>
                        <h5>2. Run Batch</h5>
                        <p>Execute multiple simulations automatically with different parameter combinations.</p>
                        <code>Each iteration = one simulation</code>
                    </div>
                    <div className='guide-card'>
                        <div className='guide-icon'><i className='codicon codicon-graph-line'></i></div>
                        <h5>3. Analyze Results</h5>
                        <p>View k-effective trends, statistics, and export data for further analysis.</p>
                        <code>Plot k-eff vs parameter</code>
                    </div>
                </div>
            </div>
        );
    }

    protected renderTabs(): React.ReactNode {
        const tabs = [
            { id: 'sweeps', label: 'Parameter Sweeps', icon: 'codicon-list-selection' },
            { id: 'runner', label: 'Batch Runner', icon: 'codicon-play' },
            { id: 'results', label: 'Results', icon: 'codicon-list-flat' },
            { id: 'analysis', label: 'Analysis', icon: 'codicon-graph-line' }
        ] as const;

        return (
            <div className='optimization-tabs'>
                {tabs.map(tab => (
                    <button
                        key={tab.id}
                        className={`tab-button ${this.activeTab === tab.id ? 'active' : ''}`}
                        onClick={() => {
                            this.activeTab = tab.id;
                            this.update();
                        }}
                    >
                        <i className={`codicon ${tab.icon}`}></i>
                        {tab.label}
                    </button>
                ))}
            </div>
        );
    }

    protected renderSweepsTab(): React.ReactNode {
        try {
            const sweeps = this.stateManager.getParameterSweeps();

            return (
                <div className='sweeps-tab'>
                    {this.renderQuickStartGuide()}
                    <div className='sweeps-toolbar'>
                        <Tooltip content='Create a new parameter sweep' position='bottom'>
                            <button
                                className='theia-button primary'
                                onClick={() => this.addNewSweep()}
                            >
                                <i className='codicon codicon-add'></i>
                                Add Sweep
                            </button>
                        </Tooltip>
                    </div>

                    {sweeps.length === 0 ? (
                        <div className='empty-state'>
                            <i className='codicon codicon-symbol-variable'></i>
                            <p>No parameter sweeps defined yet.</p>
                            <p className='empty-hint'>Add a sweep to vary parameters across multiple simulations.</p>
                            <div className='empty-tips'>
                                <p><strong>💡 Tip:</strong> Start with material properties like enrichment or density.</p>
                                <p><strong>💡 Tip:</strong> You can sweep geometry dimensions for sensitivity studies.</p>
                            </div>
                        </div>
                    ) : (
                        <div className='sweeps-list'>
                            {sweeps.map(sweep => this.renderSweepCard(sweep))}
                        </div>
                    )}
                </div>
            );
        } catch (error) {
            console.error('[OptimizationWidget] Error in renderSweepsTab:', error);
            return (
                <div className='sweeps-tab error'>
                    <div className='error-message'>
                        Error loading sweeps: {String(error)}
                    </div>
                </div>
            );
        }
    }

    protected renderSweepCard(sweep: OpenMCParameterSweep): React.ReactNode {
        const values = this.stateManager.computeSweepValues(sweep);
        const isSelected = this.selectedSweepId === sweep.id;
        const isEditing = this.editingSweepId === sweep.id;

        if (isEditing) {
            return this.renderSweepEditor(sweep);
        }

        return (
            <div
                key={sweep.id}
                className={`sweep-card ${isSelected ? 'selected' : ''} ${!sweep.enabled ? 'disabled' : ''}`}
            >
                <div className='sweep-card-header'>
                    <div className='sweep-info'>
                        <input
                            type='checkbox'
                            checked={sweep.enabled}
                            onChange={() => this.toggleSweepEnabled(sweep.id)}
                            title={sweep.enabled ? 'Disable this sweep' : 'Enable this sweep'}
                        />
                        <span className='sweep-name'>{sweep.name}</span>
                        <span className='sweep-variable'>{sweep.variable}</span>
                        {sweep.parameterPath && <span className='sweep-path'>{sweep.parameterPath}</span>}
                    </div>
                    <div className='sweep-actions'>
                        <Tooltip content='Edit sweep parameters' position='top'>
                            <button
                                className='theia-button small'
                                onClick={() => this.editSweep(sweep.id)}
                            >
                                <i className='codicon codicon-edit'></i>
                            </button>
                        </Tooltip>
                        <Tooltip content='Duplicate this sweep' position='top'>
                            <button
                                className='theia-button small'
                                onClick={() => this.duplicateSweep(sweep.id)}
                            >
                                <i className='codicon codicon-copy'></i>
                            </button>
                        </Tooltip>
                        <Tooltip content='Delete sweep' position='top'>
                            <button
                                className='theia-button small danger'
                                onClick={() => this.deleteSweep(sweep.id)}
                            >
                                <i className='codicon codicon-trash'></i>
                            </button>
                        </Tooltip>
                    </div>
                </div>

                <div className='sweep-details'>
                    <div className='sweep-range'>
                        <label>Range:</label>
                        <span className={`range-type ${sweep.rangeType}`}>{sweep.rangeType}</span>
                        <span className='range-values'>
                            {sweep.startValue.toFixed(4)} → {sweep.endValue.toFixed(4)}
                        </span>
                        <span className='range-points'>({sweep.numPoints} points)</span>
                    </div>

                    <div className='sweep-preview'>
                        <label>Preview:</label>
                        <div className='values-preview'>
                            {values.slice(0, 8).map((v, i) => (
                                <span key={i} className='value-tag'>{v.toFixed(4)}</span>
                            ))}
                            {values.length > 8 && <span className='more-tag'>+{values.length - 8} more</span>}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    protected renderSweepEditor(sweep: OpenMCParameterSweep): React.ReactNode {
        // Initialize editing data if not set or for different sweep
        if (!this.editingSweepData || this.editingSweepData.id !== sweep.id) {
            this.editingSweepData = { ...sweep };
        }

        const handleSave = () => {
            if (this.editingSweepData) {
                this.stateManager.updateParameterSweep(sweep.id, this.editingSweepData);
                this.autoSave();
            }
            this.editingSweepId = undefined;
            this.editingSweepData = undefined;
            this.update();
        };

        const handleCancel = () => {
            this.editingSweepId = undefined;
            this.editingSweepData = undefined;
            this.update();
        };

        const updateField = <K extends keyof OpenMCParameterSweep>(field: K, value: OpenMCParameterSweep[K]) => {
            if (this.editingSweepData) {
                this.editingSweepData = { ...this.editingSweepData, [field]: value };
                this.update(); // Re-render to show updated values
            }
        };

        const data = this.editingSweepData;

        return (
            <div key={sweep.id} className='sweep-card editing'>
                <div className='sweep-editor'>
                    <div className='editor-row'>
                        <label>Name:</label>
                        <input
                            type='text'
                            value={data.name}
                            onChange={(e) => updateField('name', e.target.value)}
                            className='theia-input'
                        />
                    </div>
                    <div className='editor-row'>
                        <label>Variable:</label>
                        <input
                            type='text'
                            value={data.variable}
                            onChange={(e) => updateField('variable', e.target.value)}
                            className='theia-input'
                            placeholder='e.g., enrichment, temperature'
                        />
                    </div>
                    <div className='editor-row'>
                        <label>Parameter Type:</label>
                        <select
                            value={data.parameterType}
                            onChange={(e) => {
                                const newType = e.target.value as OpenMCParameterSweep['parameterType'];
                                updateField('parameterType', newType);
                                if (newType !== 'material') {
                                    updateField('parameterPath', '');
                                }
                            }}
                            className='theia-select'
                        >
                            <option value='material'>Material</option>
                            <option value='geometry'>Geometry</option>
                            <option value='settings'>Settings</option>
                            <option value='tally'>Tally</option>
                        </select>
                    </div>
                    {data.parameterType === 'material' && (
                        <div className='editor-row'>
                            <label>Parameter Path:</label>
                            <select
                                value={data.parameterPath}
                                onChange={(e) => {
                                    updateField('parameterPath', e.target.value);
                                    if (e.target.value) {
                                        const parts = e.target.value.split('.');
                                        if (parts.length >= 2) {
                                            updateField('variable', parts[1]);
                                        }
                                    }
                                }}
                                className='theia-select'
                            >
                                <option value=''>-- Select parameter --</option>
                                {(() => {
                                    const state = this.stateManager.getState();
                                    const options: JSX.Element[] = [];
                                    state.materials.forEach(mat => {
                                        options.push(
                                            <optgroup key={`mat-${mat.id}`} label={`Material: ${mat.name}`}>
                                                <option key={`${mat.name}.density`} value={`${mat.name}.density`}>
                                                    {mat.name}.density
                                                </option>
                                                <option key={`${mat.name}.temperature`} value={`${mat.name}.temperature`}>
                                                    {mat.name}.temperature
                                                </option>
                                                {mat.nuclides.map(nuc => (
                                                    <option key={`${mat.name}.${nuc.name}`} value={`${mat.name}.${nuc.name}`}>
                                                        {mat.name}.{nuc.name}
                                                    </option>
                                                ))}
                                            </optgroup>
                                        );
                                    });
                                    return options;
                                })()}
                            </select>
                        </div>
                    )}
                    {data.parameterType === 'geometry' && (
                        <div className='editor-row'>
                            <label>Parameter Path:</label>
                            <select
                                value={data.parameterPath}
                                onChange={(e) => {
                                    updateField('parameterPath', e.target.value);
                                    if (e.target.value) {
                                        const parts = e.target.value.split('.');
                                        if (parts.length >= 2) {
                                            updateField('variable', parts[1]);
                                        }
                                    }
                                }}
                                className='theia-select'
                            >
                                <option value=''>-- Select parameter --</option>
                                {(() => {
                                    const state = this.stateManager.getState();
                                    const options: JSX.Element[] = [];
                                    if (state.geometry && state.geometry.cells) {
                                        state.geometry.cells.forEach(cell => {
                                            options.push(
                                                <optgroup key={`cell-${cell.id}`} label={`Cell: ${cell.name}`}>
                                                    <option key={`${cell.name}.temperature`} value={`${cell.name}.temperature`}>
                                                        {cell.name}.temperature
                                                    </option>
                                                </optgroup>
                                            );
                                        });
                                    }
                                    return options;
                                })()}
                            </select>
                        </div>
                    )}
                    {data.parameterType === 'settings' && (
                        <div className='editor-row'>
                            <label>Parameter Path:</label>
                            <select
                                value={data.parameterPath}
                                onChange={(e) => {
                                    updateField('parameterPath', e.target.value);
                                    if (e.target.value) {
                                        const parts = e.target.value.split('.');
                                        if (parts.length >= 2) {
                                            updateField('variable', parts[1]);
                                        }
                                    }
                                }}
                                className='theia-select'
                            >
                                <option value=''>-- Select parameter --</option>
                                <optgroup label="Settings">
                                    <option value='settings.particles'>particles</option>
                                    <option value='settings.inactive'>inactive</option>
                                    <option value='settings.batches'>batches</option>
                                    <option value='settings.seed'>seed</option>
                                </optgroup>
                            </select>
                        </div>
                    )}
                    <div className='editor-row'>
                        <label>Range Type:</label>
                        <select
                            value={data.rangeType}
                            onChange={(e) => updateField('rangeType', e.target.value as 'linear' | 'logarithmic')}
                            className='theia-select'
                        >
                            <option value='linear'>Linear</option>
                            <option value='logarithmic'>Logarithmic</option>
                        </select>
                    </div>
                    <div className='editor-row'>
                        <label>Start Value:</label>
                        <input
                            type='number'
                            step='any'
                            value={data.startValue}
                            onChange={(e) => updateField('startValue', parseFloat(e.target.value) || 0)}
                            className='theia-input'
                        />
                    </div>
                    <div className='editor-row'>
                        <label>End Value:</label>
                        <input
                            type='number'
                            step='any'
                            value={data.endValue}
                            onChange={(e) => updateField('endValue', parseFloat(e.target.value) || 0)}
                            className='theia-input'
                        />
                    </div>
                    <div className='editor-row'>
                        <label>Num Points:</label>
                        <input
                            type='number'
                            min={2}
                            max={1000}
                            value={data.numPoints}
                            onChange={(e) => updateField('numPoints', parseInt(e.target.value) || 2)}
                            className='theia-input'
                        />
                    </div>
                    <div className='editor-row'>
                        <label>Unit:</label>
                        <input
                            type='text'
                            value={data.unit || ''}
                            onChange={(e) => updateField('unit', e.target.value)}
                            className='theia-input'
                            placeholder='e.g., cm, %, K'
                        />
                    </div>
                    <div className='editor-actions'>
                        <button className='theia-button primary' onClick={handleSave}>
                            <i className='codicon codicon-check'></i>
                            Save
                        </button>
                        <button className='theia-button secondary' onClick={handleCancel}>
                            <i className='codicon codicon-close'></i>
                            Cancel
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    protected renderRunnerTab(): React.ReactNode {
        const sweeps = this.stateManager.getParameterSweeps().filter(s => s.enabled);
        const activeRun = this.stateManager.getActiveOptimizationRun();

        let totalIterations = 1;
        sweeps.forEach(s => {
            const values = this.stateManager.computeSweepValues(s);
            totalIterations *= values.length;
        });

        return (
            <div className='runner-tab'>
                <div className='runner-guide'>
                    <h4><i className='codicon codicon-info'></i> How Batch Running Works</h4>
                    <div className='guide-steps'>
                        <div className='guide-step'>
                            <span className='step-num'>1</span>
                            <span>Each sweep variable creates multiple simulation cases</span>
                        </div>
                        <div className='guide-step'>
                            <span className='step-num'>2</span>
                            <span>Total iterations = product of all sweep point counts</span>
                        </div>
                        <div className='guide-step'>
                            <span className='step-num'>3</span>
                            <span>Results are automatically collected after each run</span>
                        </div>
                    </div>
                </div>
                <div className='runner-config'>
                    <div className='runner-header'>
                        <h3><i className='codicon codicon-play'></i> Batch Run</h3>
                        <div className='runner-info'>
                            <span className='info-item'>
                                <i className='codicon codicon-list-selection'></i>
                                {sweeps.length} {sweeps.length === 1 ? 'sweep' : 'sweeps'}
                            </span>
                            <span className='info-item'>
                                <i className='codicon codicon-numbers'></i>
                                {totalIterations.toLocaleString()} {totalIterations === 1 ? 'iteration' : 'iterations'}
                            </span>
                        </div>
                    </div>
                    
                    {sweeps.length === 0 && (
                        <div className='runner-warning'>
                            <i className='codicon codicon-warning'></i>
                            Enable at least one sweep in the Parameter Sweeps tab to start a batch run.
                        </div>
                    )}

                    <div className='runner-actions'>
                        {activeRun?.status === 'running' ? (
                            <Tooltip content='Stop the current batch run' position='top'>
                                <button
                                    className='theia-button danger large'
                                    onClick={() => this.stopBatchRun()}
                                >
                                    <i className='codicon codicon-stop'></i>
                                    Running... Click to Stop
                                </button>
                            </Tooltip>
                        ) : (
                            <Tooltip content={sweeps.length === 0 ? 'Enable at least one sweep first' : 'Start the batch optimization run'} position='top'>
                                <button
                                    className='theia-button primary large'
                                    disabled={sweeps.length === 0}
                                    onClick={() => this.startBatchRun()}
                                >
                                    <i className='codicon codicon-play'></i>
                                    Start Batch Run
                                </button>
                            </Tooltip>
                        )}
                    </div>
                </div>

                {activeRun && this.renderRunProgress(activeRun)}
            </div>
        );
    }

    protected renderRunProgress(run: OpenMCOptimizationRun): React.ReactNode {
        const progress = run.totalIterations > 0
            ? (run.currentIteration / run.totalIterations) * 100
            : 0;

        return (
            <div className='run-progress'>
                <h4>Current Run: {run.name}</h4>
                
                <div className='progress-bar-container'>
                    <div className='progress-bar' style={{ width: `${progress}%` }}></div>
                </div>
                
                <div className='progress-info'>
                    <span>Progress: {run.currentIteration} / {run.totalIterations}</span>
                    <span>{progress.toFixed(1)}%</span>
                </div>

                <div className='progress-status'>
                    <span className={`status-badge ${run.status}`}>{run.status}</span>
                    {run.startTime && (
                        <span className='time-info'>
                            Started: {new Date(run.startTime).toLocaleTimeString()}
                        </span>
                    )}
                </div>

                <div className='run-log'>
                    <div className='log-layout' style={{ height: this.showLogMaximized ? '60vh' : `${this.logPanelHeight}px` }}>
                        <div className='log-sidebar'>
                            <div className='sidebar-header'>
                                <h5>Iterations ({this.iterationLogsIndex.length})</h5>
                            </div>
                            <div className='sidebar-list'>
                                {this.iterationLogsIndex.length === 0 ? (
                                    <div className='sidebar-empty'>No iterations</div>
                                ) : (
                                    this.iterationLogsIndex.map(iter => (
                                        <button 
                                            key={iter.iteration}
                                            className={`sidebar-item ${this.selectedIteration === iter.iteration ? 'selected' : ''}`}
                                            onClick={() => this.toggleIteration(run.id, iter.iteration, iter.hasLog)}
                                        >
                                            <span className='item-num'>#{iter.iteration}</span>
                                            <span className={`item-status ${iter.hasLog ? 'done' : 'running'}`}>
                                                {iter.hasLog ? '✓' : '○'}
                                            </span>
                                        </button>
                                    ))
                                )}
                            </div>
                        </div>
                        <div className='log-main'>
                            {this.selectedIteration ? (
                                <div className='log-viewer'>
                                    <div className='viewer-header'>
                                        <span>Iteration {this.selectedIteration}</span>
                                        <div className='viewer-controls'>
                                            <input 
                                                type='text' 
                                                placeholder='Filter output...'
                                                onInput={(e: any) => {
                                                    this.filterLogContent(this.selectedIteration!, e.target.value);
                                                }}
                                            />
                                            <Tooltip content={this.showLogMaximized ? 'Minimize log view' : 'Maximize log view'} position='top'>
                                                <button 
                                                    className='theia-button secondary'
                                                    onClick={() => {
                                                        this.showLogMaximized = !this.showLogMaximized;
                                                        this.update();
                                                        // Focus and scroll to log when toggled
                                                        setTimeout(() => {
                                                            const el = document.querySelector('.viewer-content');
                                                            if (el) el.scrollTop = el.scrollHeight;
                                                        }, 100);
                                                    }}
                                                >
                                                    {this.showLogMaximized ? '−' : '+'}
                                                </button>
                                            </Tooltip>
                                            <Tooltip content='Close log viewer' position='top'>
                                                <button 
                                                    className='theia-button secondary'
                                                    onClick={() => {
                                                        this.selectedIteration = undefined;
                                                        this.loadedLogContent = '';
                                                        this.update();
                                                    }}
                                                >
                                                    ✕
                                                </button>
                                            </Tooltip>
                                        </div>
                                    </div>
                                    <pre 
                                        className='viewer-content' 
                                        ref={this.logViewerRef}
                                        onScroll={(e) => {
                                            const el = e.target as HTMLPreElement;
                                            this.autoScroll = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
                                        }}
                                    >
                                        {this.filteredLogContent || this.loadedLogContent || 'Loading...'}
                                    </pre>
                                </div>
                            ) : (
                                <div className='log-placeholder'>
                                    Select an iteration to view its output
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    private async loadIterationLogsIndex(runId: string): Promise<void> {
        try {
            console.log('[OptimizationWidget] Loading iteration logs index for:', runId);
            const result = await this.backendService.getIterationLogsIndex(runId);
            console.log('[OptimizationWidget] Iteration logs result:', result.outputDirectory, result.iterations);
            if (result.iterations.length !== this.iterationLogsIndex.length) {
                this.iterationLogsIndex = result.iterations;
                this.update();
            }
        } catch (error) {
            console.error('[OptimizationWidget] Error loading iteration logs index:', error);
        }
    }

    private async toggleIteration(runId: string, iteration: number, hasLog: boolean): Promise<void> {
        if (!hasLog) return;
        
        if (this.expandedIterations.has(iteration)) {
            // Collapse - just close the expanded view
            this.expandedIterations.delete(iteration);
            if (this.selectedIteration === iteration) {
                this.selectedIteration = undefined;
                this.loadedLogContent = '';
                this.filteredLogContent = '';
            }
            this.update();
        } else {
            // Expand - load the log
            this.expandedIterations.add(iteration);
            this.selectedIteration = iteration;
            this.loadedLogContent = 'Loading...';
            this.filteredLogContent = '';
            this.update();

            try {
                const result = await this.backendService.getIterationLog(runId, iteration);
                if (result.success && result.logContent) {
                    this.loadedLogContent = result.logContent;
                } else {
                    this.loadedLogContent = result.error || 'No log content available';
                }
            } catch (error) {
                this.loadedLogContent = `Error loading log: ${error}`;
            }

            this.update();
        }
    }

    private autoScroll = true;

    private async loadIterationLog(runId: string, iteration: number): Promise<void> {
        if (!this.expandedIterations.has(iteration)) return;
        
        try {
            const result = await this.backendService.getIterationLog(runId, iteration);
            if (result.success && result.logContent) {
                this.loadedLogContent = result.logContent;
                this.update();
                
                // Auto-scroll only if user is near bottom or new content
                setTimeout(() => {
                    if (this.logViewerRef.current) {
                        const el = this.logViewerRef.current;
                        const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
                        if (this.autoScroll || isNearBottom) {
                            el.scrollTop = el.scrollHeight;
                        }
                    }
                }, 50);
            }
        } catch (error) {
            // Silently fail on refresh errors
        }
    }

    private filterLogContent(iteration: number, filter: string): void {
        if (!filter) {
            this.filteredLogContent = '';
            this.update();
            return;
        }

        if (this.selectedIteration === iteration && this.loadedLogContent) {
            const filterLower = filter.toLowerCase();
            const lines = this.loadedLogContent.split('\n');
            const filtered = lines.filter(line => 
                line.toLowerCase().includes(filterLower)
            ).join('\n');
            this.filteredLogContent = filtered;
            this.update();
        }
    }

    protected renderResultsTab(): React.ReactNode {
        const runs = this.stateManager.getOptimizationRuns();
        const selectedRun = this.selectedRunId
            ? runs.find(r => r.id === this.selectedRunId)
            : runs[0];

        return (
            <div className='results-tab'>
                {runs.length === 0 ? (
                    <div className='results-empty'>
                        <i className='codicon codicon-test-queued'></i>
                        <h3>No Optimization Runs</h3>
                        <p>Start a batch run from the Runner tab to see results here.</p>
                    </div>
                ) : (
                    <>
                        <div className='results-sidebar'>
                            <div className='results-sidebar-header'>
                                <h4>Run History</h4>
                                <Tooltip content='Delete all optimization runs' position='top'>
                                    <button
                                        className='theia-button secondary small'
                                        onClick={async () => {
                                            const confirmDialog = new ConfirmDialog({
                                                title: 'Delete All Runs',
                                                msg: 'Are you sure you want to delete all optimization runs?',
                                                ok: 'Delete All',
                                                cancel: 'Cancel'
                                            });
                                            const confirmed = await confirmDialog.open();
                                            if (confirmed) {
                                                runs.forEach(r => this.stateManager.removeOptimizationRun(r.id));
                                                this.selectedRunId = undefined;
                                                this.autoSave();
                                                this.update();
                                            }
                                        }}
                                    >
                                        <i className='codicon codicon-trash'></i>
                                    </button>
                                </Tooltip>
                            </div>
                            <div className='runs-list'>
                                {runs.map(run => (
                                    <div
                                        key={run.id}
                                        className={`run-item ${run.id === this.selectedRunId ? 'selected' : ''}`}
                                        onClick={() => {
                                            this.selectedRunId = run.id;
                                            this.update();
                                        }}
                                    >
                                        <div className='run-item-header'>
                                            <span className='run-name'>{run.name}</span>
                                            <span className={`run-status ${run.status}`}>{run.status}</span>
                                        </div>
                                        <div className='run-item-meta'>
                                            <span><i className='codicon codicon-numbers'></i> {run.totalIterations} iterations</span>
                                            {run.results.length > 0 && (
                                                <span><i className='codicon codicon-check'></i> {run.results.filter(r => r.success).length} succeeded</span>
                                            )}
                                        </div>
                                        <Tooltip content={`Delete ${run.name}`} position='right'>
                                            <button
                                                className='run-item-delete'
                                                onClick={async (e) => {
                                                    e.stopPropagation();
                                                    const confirmDialog = new ConfirmDialog({
                                                        title: 'Delete Run',
                                                        msg: `Delete "${run.name}"?`,
                                                        ok: 'Delete',
                                                        cancel: 'Cancel'
                                                    });
                                                    const confirmed = await confirmDialog.open();
                                                    if (confirmed) {
                                                        this.stateManager.removeOptimizationRun(run.id);
                                                        if (this.selectedRunId === run.id) {
                                                            this.selectedRunId = undefined;
                                                        }
                                                        this.autoSave();
                                                        this.update();
                                                    }
                                                }}
                                            >
                                                <i className='codicon codicon-trash'></i>
                                            </button>
                                        </Tooltip>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className='results-content'>
                            {selectedRun ? (
                                this.renderResultsTable(selectedRun)
                            ) : (
                                <div className='empty-state'>
                                    <i className='codicon codicon-list'></i>
                                    <p>Select a run to view results.</p>
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>
        );
    }

    protected renderResultsTable(run: OpenMCOptimizationRun): React.ReactNode {
        if (run.results.length === 0) {
            return (
                <div className='empty-state'>
                    <i className='codicon codicon-list'></i>
                    <p>No results for this run yet.</p>
                </div>
            );
        }

        const sweepVars = run.sweepConfig.map(s => s.parameterPath || s.variable);

        return (
            <div className='results-table-container'>
                <div className='results-toolbar'>
                    <h4>Results: {run.name}</h4>
                    <Tooltip content='Export results as CSV file' position='top'>
                        <button
                            className='theia-button secondary small'
                            onClick={() => this.exportRunResults(run.id)}
                        >
                            <i className='codicon codicon-file-export'></i>
                            Export CSV
                        </button>
                    </Tooltip>
                </div>

                <table className='results-table'>
                    <thead>
                        <tr>
                            <th>#</th>
                            {sweepVars.map(v => <th key={v}>{v}</th>)}
                            <th className='numeric-header'>k-eff</th>
                            <th className='numeric-header'>σ (std)</th>
                            <th className='numeric-header'>Time</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        {run.results.map((result, idx) => (
                            <tr key={idx} className={result.success ? '' : 'failed'}>
                                <td>{result.iteration}</td>
                                {sweepVars.map(v => (
                                    <td key={v}>
                                        {result.parameterValues[v]?.toFixed(4) || '-'}
                                    </td>
                                ))}
                                <td className='numeric'>
                                    {result.keff?.toFixed(4) || '-'}
                                </td>
                                <td className='numeric'>
                                    {result.keffStd?.toFixed(4) || '-'}
                                </td>
                                <td className='numeric'>
                                    {result.executionTime.toFixed(1)}s
                                </td>
                                <td className='status-cell'>
                                    {result.success ? (
                                        <span className='status-success'><i className='codicon codicon-check'></i></span>
                                    ) : (
                                        <span className='status-failed'><i className='codicon codicon-error'></i></span>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        );
    }

    protected renderAnalysisTab(): React.ReactNode {
        const runs = this.stateManager.getOptimizationRuns().filter(r => r.results.length > 0);

        if (runs.length === 0) {
            return (
                <div className='empty-state'>
                    <i className='codicon codicon-graph'></i>
                    <p>No completed runs to analyze.</p>
                    <p className='empty-hint'>Complete an optimization run to see analysis plots.</p>
                </div>
            );
        }

        const selectedRun = this.analysisRunId 
            ? runs.find(r => r.id === this.analysisRunId) 
            : runs[0];
        
        if (!selectedRun) {
            return <div className='empty-state'><p>No run selected</p></div>;
        }

        const results = selectedRun.results.filter(r => r.success && r.keff !== undefined);
        
        if (results.length === 0) {
            return (
                <div className='empty-state'>
                    <i className='codicon codicon-graph'></i>
                    <p>No valid results to display.</p>
                    <p className='empty-hint'>Run optimization with valid k-eff values.</p>
                </div>
            );
        }

        const sweepVar = selectedRun.sweepConfig[0]?.parameterPath || selectedRun.sweepConfig[0]?.variable || 'Parameter';
        
        const xValues = results.map(r => r.parameterValues[sweepVar] ?? r.iteration);
        const yValues = results.map(r => r.keff!);
        const yErrors = results.map(r => r.keffStd ?? 0);

        const bgColor = this.getCssColor('--theia-editor-background', '#1e1e1e');
        const fgColor = this.getCssColor('--theia-foreground', '#cccccc');
        const gridColor = this.getCssColor('--theia-panel-border', '#333333');

        const trace = {
            x: xValues,
            y: yValues,
            type: 'scatter' as const,
            mode: 'lines+markers' as const,
            name: 'k-eff',
            marker: { color: '#0066cc', size: 8 },
            line: { color: '#0066cc', width: 2 }
        };

        const errorTrace = {
            x: xValues,
            y: yValues,
            type: 'scatter' as const,
            mode: 'markers' as const,
            name: 'Uncertainty',
            marker: { 
                color: 'transparent',
                size: 10,
                line: { color: '#ff6600', width: 2 }
            },
            error_y: {
                type: 'data' as const,
                array: yErrors,
                visible: true
            }
        };

        const layout: any = {
            title: { text: `k-eff vs ${sweepVar}`, font: { size: 14, color: fgColor } },
            xaxis: { 
                title: { text: sweepVar, font: { size: 12, color: fgColor } },
                gridcolor: gridColor,
                tickfont: { color: fgColor },
                linecolor: gridColor
            },
            yaxis: { 
                title: { text: 'k-effective', font: { size: 12, color: fgColor } },
                gridcolor: gridColor,
                tickfont: { color: fgColor },
                linecolor: gridColor
            },
            paper_bgcolor: bgColor,
            plot_bgcolor: bgColor,
            margin: { l: 60, r: 30, t: 50, b: 60 },
            width: 500,
            height: 350,
            font: { color: fgColor, size: 11 },
            legend: { font: { color: fgColor }, bgcolor: 'rgba(0,0,0,0)' }
        };

        const config = { displayModeBar: false, responsive: true };

        const allKeff = results.map(r => r.keff!);
        const meanKeff = allKeff.reduce((a, b) => a + b, 0) / allKeff.length;
        const minKeff = Math.min(...allKeff);
        const maxKeff = Math.max(...allKeff);

        return (
            <div className='analysis-tab'>
                <div className='analysis-guide'>
                    <h4><i className='codicon codicon-lightbulb'></i> Understanding the Analysis</h4>
                    <div className='guide-steps'>
                        <div className='guide-step'>
                            <span className='step-num'><i className='codicon codicon-graph-line'></i></span>
                            <span><strong>Trend Plot:</strong> Shows how k-effective changes with your sweep parameter</span>
                        </div>
                        <div className='guide-step'>
                            <span className='step-num'><i className='codicon codicon-error'></i></span>
                            <span><strong>Error Bars:</strong> Represent statistical uncertainty (σ) in each simulation</span>
                        </div>
                        <div className='guide-step'>
                            <span className='step-num'><i className='codicon codicon-dashboard'></i></span>
                            <span><strong>Statistics:</strong> Hover over each stat box to understand what it means</span>
                        </div>
                    </div>
                </div>
                <div className='analysis-header'>
                    <h3>Results Analysis</h3>
                    <Tooltip content='Select a run to analyze' position='bottom'>
                        <select 
                            className='run-selector'
                            value={this.analysisRunId || selectedRun.id}
                            onChange={(e) => {
                                this.analysisRunId = e.target.value;
                                this.update();
                            }}
                        >
                            {runs.map(run => (
                                <option key={run.id} value={run.id}>{run.name}</option>
                            ))}
                        </select>
                    </Tooltip>
                </div>

                <div className='analysis-content'>
                    <div className='analysis-chart-section'>
                        <h4>k-eff Trend Plot</h4>
                        <div className='chart-wrapper'>
                            <PlotlyComponent data={[trace, errorTrace]} layout={layout} config={config} />
                        </div>
                    </div>

                    <div className='analysis-stats'>
                        <h4>Statistics</h4>
                        <div className='stats-grid'>
                            <Tooltip content='Average k-effective across all iterations' position='top'>
                                <div className='stat-box'>
                                    <span className='stat-label'>Mean k-eff</span>
                                    <span className='stat-value'>{meanKeff.toFixed(6)}</span>
                                </div>
                            </Tooltip>
                            <Tooltip content='Minimum k-effective value observed' position='top'>
                                <div className='stat-box'>
                                    <span className='stat-label'>Min k-eff</span>
                                    <span className='stat-value'>{minKeff.toFixed(6)}</span>
                                </div>
                            </Tooltip>
                            <Tooltip content='Maximum k-effective value observed' position='top'>
                                <div className='stat-box'>
                                    <span className='stat-label'>Max k-eff</span>
                                    <span className='stat-value'>{maxKeff.toFixed(6)}</span>
                                </div>
                            </Tooltip>
                            <Tooltip content='Difference between max and min k-eff' position='top'>
                                <div className='stat-box'>
                                    <span className='stat-label'>Range</span>
                                    <span className='stat-value'>{(maxKeff - minKeff).toFixed(6)}</span>
                                </div>
                            </Tooltip>
                            <Tooltip content='Standard deviation of k-effective values' position='top'>
                                <div className='stat-box'>
                                    <span className='stat-label'>Std Dev</span>
                                    <span className='stat-value'>
                                        {Math.sqrt(allKeff.reduce((sum, v) => sum + Math.pow(v - meanKeff, 2), 0) / allKeff.length).toFixed(6)}
                                    </span>
                                </div>
                            </Tooltip>
                            <Tooltip content='Number of successful simulation points' position='top'>
                                <div className='stat-box'>
                                    <span className='stat-label'>N Points</span>
                                    <span className='stat-value'>{results.length}</span>
                                </div>
                            </Tooltip>
                        </div>
                    </div>

                    <div className='analysis-table-section'>
                        <h4>Results Table</h4>
                        <table className='analysis-results-table'>
                            <thead>
                                <tr>
                                    <th>{sweepVar}</th>
                                    <th>k-eff</th>
                                    <th>σ</th>
                                    <th>Time (s)</th>
                                </tr>
                            </thead>
                            <tbody>
                                {results.map((r, idx) => (
                                    <tr key={idx}>
                                        <td>{xValues[idx]?.toFixed(6)}</td>
                                        <td>{r.keff?.toFixed(6)}</td>
                                        <td>{r.keffStd?.toFixed(6)}</td>
                                        <td>{r.executionTime.toFixed(1)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        );
    }

    // ============================================================================
    // Actions
    // ============================================================================

    private addNewSweep(): void {
        const id = this.stateManager.getNextParameterSweepId();
        const newSweep: OpenMCParameterSweep = {
            id,
            name: `Sweep ${id}`,
            enabled: true,
            variable: 'enrichment',
            parameterType: 'material',
            parameterPath: '',
            rangeType: 'linear',
            startValue: 0.02,
            endValue: 0.05,
            numPoints: 10,
            unit: ''
        };
        this.stateManager.addParameterSweep(newSweep);
        this.autoSave();
        this.update();
    }

    private toggleSweepEnabled(id: number): void {
        const sweeps = this.stateManager.getParameterSweeps();
        const sweep = sweeps.find(s => s.id === id);
        if (sweep) {
            this.stateManager.updateParameterSweep(id, { enabled: !sweep.enabled });
            this.autoSave();
        }
        this.update();
    }

    private getCssColor(variable: string, fallback: string): string {
        if (typeof window === 'undefined') return fallback;
        const computed = getComputedStyle(document.body).getPropertyValue(variable.replace('var(', '').replace(')', '')).trim();
        return computed || fallback;
    }

    private editSweep(id: number): void {
        this.editingSweepId = id;
        this.update();
    }

    private duplicateSweep(id: number): void {
        const sweeps = this.stateManager.getParameterSweeps();
        const sweep = sweeps.find(s => s.id === id);
        if (sweep) {
            const newId = this.stateManager.getNextParameterSweepId();
            const duplicate: OpenMCParameterSweep = {
                ...sweep,
                id: newId,
                name: `${sweep.name} (Copy)`
            };
            this.stateManager.addParameterSweep(duplicate);
            this.autoSave();
            this.update();
        }
    }

    private deleteSweep(id: number): void {
        this.stateManager.removeParameterSweep(id);
        if (this.selectedSweepId === id) {
            this.selectedSweepId = undefined;
        }
        this.autoSave();
        this.update();
    }

    private async startBatchRun(): Promise<void> {
        const sweeps = this.stateManager.getParameterSweeps().filter(s => s.enabled);
        if (sweeps.length === 0) {
            this.messageService.warn('No sweeps enabled. Enable at least one sweep to run.');
            return;
        }

        // Check if project is saved - if not, offer to save first
        let projectPath = this.stateManager.projectPath;
        if (!projectPath) {
            const saved = await this.saveProjectWithPrompt();
            if (!saved) {
                this.messageService.warn('Project must be saved before starting optimization.');
                return;
            }
            projectPath = this.stateManager.projectPath;
            if (!projectPath) {
                this.messageService.error('Failed to get project path after save.');
                return;
            }
        }

        try {
            // Calculate total iterations
            let totalIterations = 1;
            sweeps.forEach(s => {
                const values = this.stateManager.computeSweepValues(s);
                totalIterations *= values.length;
            });

            const runId = `run-${Date.now()}`;
            const newRun: OpenMCOptimizationRun = {
                id: runId,
                name: `Run ${new Date().toLocaleString()}`,
                status: 'running',
                sweepConfig: sweeps,
                currentIteration: 0,
                totalIterations,
                results: [],
                statepointFiles: [],
                logMessages: [{
                    timestamp: new Date().toISOString(),
                    level: 'info',
                    message: `Starting batch run with ${totalIterations} iterations (single process)`
                }]
            };

            this.stateManager.addOptimizationRun(newRun);
            this.stateManager.setActiveOptimizationRun(newRun.id);
            this.autoSave();

            // Calculate output directory - use absolute path 
            let projectDir: string;
            if (projectPath && projectPath.includes('/')) {
                projectDir = projectPath.substring(0, projectPath.lastIndexOf('/'));
            } else if (projectPath && projectPath.includes('\\')) {
                projectDir = projectPath.substring(0, projectPath.lastIndexOf('\\'));
            } else {
                // Use workspace as fallback
                projectDir = '.';
            }
            const outputDir = projectDir.length > 0 ? `${projectDir}/optimization/${runId}` : `optimization/${runId}`;
            
            // Get cross-sections and chain file paths from nuke-core
            const xsPath = this.nukeCoreService.getCrossSectionsPath();
            const chainPath = this.nukeCoreService.getChainFilePath();
            
            const result = await this.backendService.startOptimization({
                runId,
                runName: newRun.name,
                baseState: this.stateManager.getState(),
                sweeps,
                outputDirectory: outputDir,
                crossSectionsPath: xsPath,
                chainFilePath: chainPath
            });

            if (result.success) {
                this.messageService.info(`Optimization started: ${totalIterations} iterations`);
                // Start polling for progress
                this.startProgressPolling(runId);
            } else {
                this.messageService.error(`Failed to start optimization: ${result.error}`);
                this.stateManager.updateOptimizationRun(runId, {
                    status: 'failed',
                    endTime: new Date().toISOString()
                });
            }

            this.activeTab = 'runner';
        } catch (error) {
            console.error('[OptimizationWidget] Error starting batch run:', error);
            this.messageService.error(`Error starting optimization: ${String(error)}`);
        }
    }

    private progressInterval?: number;

    private startProgressPolling(runId: string): void {
        // Clear any existing interval
        if (this.progressInterval) {
            window.clearInterval(this.progressInterval);
        }

        console.log('[OptimizationWidget] Starting progress polling for:', runId);
        
        // Load iteration logs index when starting
        this.loadIterationLogsIndex(runId);

        // Poll for progress every 1 second (more frequent)
        this.progressInterval = window.setInterval(async () => {
            try {
                console.log('[OptimizationWidget] Polling iteration logs...');
                const status = await this.backendService.getOptimizationStatus(runId);
                
                this.stateManager.updateOptimizationRun(runId, {
                    currentIteration: status.currentIteration,
                    status: status.status
                });

                console.log('[OptimizationWidget] Polling status:', status.status, 'iter:', status.currentIteration);
                
                // Refresh iteration logs index to detect new iterations
                if (status.running && status.currentIteration > 0) {
                    console.log('[OptimizationWidget] Loading iteration logs...');
                    await this.loadIterationLogsIndex(runId);
                }

                // Stop polling if run is complete
                if (!status.running || status.status === 'completed' || status.status === 'failed' || status.status === 'cancelled') {
                    if (this.progressInterval) {
                        window.clearInterval(this.progressInterval);
                        this.progressInterval = undefined;
                    }
                    
                    if (status.status === 'completed') {
                        this.messageService.info('Optimization run completed!');
                    } else if (status.status === 'failed') {
                        this.messageService.error('Optimization run failed.');
                    }
                }

                this.update();
            } catch (error) {
                console.error('[OptimizationWidget] Error polling progress:', error);
            }
        }, 1000);
    }

    private async stopBatchRun(): Promise<void> {
        const activeRun = this.stateManager.getActiveOptimizationRun();
        if (activeRun) {
            try {
                // Call backend to stop the optimization
                await this.backendService.stopOptimization({ runId: activeRun.id });
            } catch (error) {
                console.error('[OptimizationWidget] Error stopping optimization:', error);
            }

            // Update local state after stop request
            this.stateManager.updateOptimizationRun(activeRun.id, {
                status: 'cancelled',
                endTime: new Date().toISOString()
            });
            this.stateManager.setActiveOptimizationRun(undefined);

            // Stop polling
            if (this.progressInterval) {
                window.clearInterval(this.progressInterval);
                this.progressInterval = undefined;
            }

            this.update();
        }
    }

    // ============================================================================
    // Project Save Methods (matching simulation-dashboard pattern)
    // ============================================================================

    /**
     * Prompt user to save project if not saved. Returns true if saved or already has path.
     */
    private async saveProjectWithPrompt(): Promise<boolean> {
        if (this.stateManager.projectPath) {
            // Already saved, just save current state
            await this.doSave(this.stateManager.projectPath);
            return true;
        }

        // Not saved - prompt user
        const props: SaveFileDialogProps = {
            title: 'Save OpenMC Project',
            inputValue: `${this.stateManager.getState().metadata.name}.nuke-openmc`
        };

        const uri = await this.fileDialogService.showSaveDialog(props);
        if (uri) {
            await this.doSave(uri.path.toString());
            return true;
        }

        return false;
    }

    /**
     * Save project to the given path
     */
    private async doSave(path: string): Promise<void> {
        try {
            const result = await this.studioService.getBackendService().saveProject({
                projectPath: path,
                state: this.stateManager.getState()
            });
            if (result.success) {
                this.stateManager.setProjectPath(path);
                this.stateManager.markClean();
                this.messageService.info('Project saved successfully');
            } else {
                this.messageService.error(`Failed to save: ${result.error}`);
            }
        } catch (error) {
            this.messageService.error(`Error saving project: ${error}`);
        }
    }

    /**
     * Auto-save project if path exists
     */
    private async autoSave(): Promise<void> {
        if (this.stateManager.projectPath) {
            try {
                await this.studioService.getBackendService().saveProject({
                    projectPath: this.stateManager.projectPath,
                    state: this.stateManager.getState()
                });
                this.stateManager.markClean();
            } catch (error) {
                console.error('[OptimizationWidget] Auto-save failed:', error);
            }
        }
    }

    private async exportRunResults(runId: string): Promise<void> {
        const run = this.stateManager.getOptimizationRun(runId);
        if (!run || run.results.length === 0) {
            this.messageService.warn('No results to export');
            return;
        }

        const props: SaveFileDialogProps = {
            title: 'Export Results as CSV',
            inputValue: `${run.name.replace(/[^a-z0-9]/gi, '_')}_results.csv`
        };

        const uri = await this.fileDialogService.showSaveDialog(props);
        if (!uri) return;

        const sweepVars = run.sweepConfig.map(s => s.parameterPath || s.variable);
        
        const header = ['Iteration', ...sweepVars, 'k-eff', 'sigma', 'Time (s)', 'Status'].join(',');
        const rows = run.results.map(r => {
            const values = sweepVars.map(v => r.parameterValues[v] ?? '');
            const status = r.success ? 'success' : 'failed';
            return [
                r.iteration,
                ...values,
                r.keff?.toFixed(6) ?? '',
                r.keffStd?.toFixed(6) ?? '',
                r.executionTime?.toFixed(2) ?? '',
                status
            ].join(',');
        });
        
        const csvContent = [header, ...rows].join('\n');

        try {
            const contentBuffer = BinaryBuffer.fromString(csvContent);
            await this.fileService.writeFile(uri, contentBuffer);
            this.messageService.info(`Results exported to: ${uri.path.base}`);
        } catch (error) {
            this.messageService.error(`Error exporting results: ${error}`);
        }
    }
}
