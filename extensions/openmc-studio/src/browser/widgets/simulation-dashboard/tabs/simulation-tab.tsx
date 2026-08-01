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

import * as React from '@theia/core/shared/react';
import { injectable } from '@theia/core/shared/inversify';
import { OpenFileDialogProps } from '@theia/filesystem/lib/browser';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { OpenMCState, OpenMCEigenvalueSettings, OpenMCFixedSourceSettings } from '../../../../common/openmc-state-schema';
import { computeSetupChecklist, computeReadiness, ChecklistStatus } from '../../../../common/run-readiness';
import { resolveDepletionSolver } from '../../../../common/depletion-solvers';
import { deriveTrackCaptureSettings, isParticleRestartFile, parseParticleRestartFileName } from '../../../../common/particle-restart';
import type { SimulationDashboardWidget } from '../simulation-dashboard-widget';
import { DashboardTabContribution } from './tab-registry';

/**
 * Simulation tab of the simulation dashboard: setup checklist, run controls and console output.
 */
@injectable()
export class SimulationTabContribution implements DashboardTabContribution {
    readonly id = 'simulation';
    readonly label = 'Simulation';
    readonly icon = 'play';
    readonly order = 6;

    /** Setup checklist collapse override (undefined = auto: collapsed when ready). */
    private checklistCollapsed?: boolean;

    /**
     * Render the Simulation tab with setup checklist, controls, and console output.
     * @param host - Simulation dashboard widget host.
     * @param state - Current OpenMC simulation state.
     * @returns Simulation tab React node.
     */
    render(host: SimulationDashboardWidget, state: OpenMCState): React.ReactNode {
        const checklist = computeSetupChecklist(state);
        const readiness = computeReadiness(state);
        const configuredCount = checklist.filter((item) => item.status === 'done' || item.status === 'partial').length;
        // Default: expanded when something required is missing, collapsed when ready
        const checklistCollapsed = this.checklistCollapsed ?? readiness.ready;

        const statusIcon = (status: ChecklistStatus): string =>
            status === 'done' ? 'check' : status === 'partial' ? 'warning' : status === 'missing' ? 'circle-outline' : 'circle-outline';

        return (
            <div className="simulation-tab">
                {/* Setup Checklist (collapsible) */}
                <div className="quick-actions-panel">
                    <div
                        className="category-header"
                        onClick={() => {
                            this.checklistCollapsed = !checklistCollapsed;
                            host.update();
                        }}
                    >
                        <i className={`codicon codicon-chevron-${checklistCollapsed ? 'right' : 'down'}`}></i>
                        <span>Setup Checklist</span>
                        <span className="count-badge">
                            {configuredCount} / {checklist.length} configured
                        </span>
                    </div>
                    {!checklistCollapsed && (
                        <div className="checklist-chips">
                            {checklist.map((item) => (
                                <span key={item.id} className={`checklist-chip ${item.status}`}>
                                    <i className={`codicon codicon-${statusIcon(item.status)}`}></i>
                                    {item.label}
                                    <em>{item.detail}</em>
                                    {item.id === 'geometry' &&
                                        (state.geometry.cells.length === 0 && !state.settings.dagmcFile ? (
                                            <Tooltip content="Create geometry using CSG Builder">
                                                <button className="theia-button primary small" onClick={() => host.openCSGBuilder()}>
                                                    <i className="codicon codicon-graph"></i> Open CSG Builder
                                                </button>
                                            </Tooltip>
                                        ) : (
                                            <Tooltip content="Edit geometry in CSG Builder">
                                                <button className="theia-button secondary small" onClick={() => host.openCSGBuilder()}>
                                                    <i className="codicon codicon-edit"></i> Edit
                                                </button>
                                            </Tooltip>
                                        ))}
                                </span>
                            ))}
                        </div>
                    )}

                    {/* Slim readiness indicator */}
                    {host.isRunning ? (
                        <div className="status-running">
                            <i className="codicon codicon-sync codicon-spin"></i>
                            <span>Simulation running...</span>
                        </div>
                    ) : readiness.ready ? (
                        <span className="readiness-pill ready">
                            <i className="codicon codicon-check"></i> Ready to run
                        </span>
                    ) : (
                        <span className="readiness-pill not-ready">
                            <i className="codicon codicon-warning"></i> Not ready — missing: {readiness.missing.join(', ')}
                        </span>
                    )}
                </div>

                {host.simulationProgress && (
                    <div className="progress-section">
                        <div className="progress-bar-container">
                            <div
                                className="progress-bar"
                                style={{
                                    width: `${(host.simulationProgress.batch / host.simulationProgress.totalBatches) * 100}%`
                                }}
                            ></div>
                        </div>
                        <div className="progress-info">
                            <span>
                                Batch {host.simulationProgress.batch} / {host.simulationProgress.totalBatches}
                            </span>
                            {host.simulationProgress.kEff !== undefined && (
                                <span>
                                    k-eff: {host.simulationProgress.kEff.toFixed(5)} ± {host.simulationProgress.kEffStd?.toFixed(5)}
                                </span>
                            )}
                            <span>Elapsed: {this.formatTime(host.simulationProgress.elapsedTime)}</span>
                        </div>
                    </div>
                )}

                {isParticleRestartFile(state.settings.restartFile) && this.renderParticleRestartSection(host, state)}

                {host.producedTracksUri && (
                    <div className="restart-option">
                        <Tooltip content="Open the track file written by the last run in the tracks viewer">
                            <button className="theia-button secondary" onClick={() => host.openFile(host.producedTracksUri!)}>
                                <i className="codicon codicon-git-branch"></i>
                                Open Tracks
                            </button>
                        </Tooltip>
                    </div>
                )}

                {this.renderKineticsSection(host, state)}

                <div className="simulation-actions">
                    <Tooltip content={host.isRunning ? 'Simulation is running' : 'Start the simulation'}>
                        <button className="theia-button primary large" onClick={() => host.runSimulation()} disabled={host.isRunning}>
                            <i className="codicon codicon-play"></i>
                            {host.isRunning ? 'Running...' : 'Run Simulation'}
                        </button>
                    </Tooltip>
                    <Tooltip content="Stop the simulation">
                        <button className="theia-button secondary large" onClick={() => host.stopSimulation()} disabled={!host.isRunning}>
                            <i className="codicon codicon-stop"></i>
                            Stop
                        </button>
                    </Tooltip>
                    <Tooltip content="Validate model before running">
                        <button className="theia-button secondary large" onClick={() => host.validateModel()} disabled={host.isRunning}>
                            <i className="codicon codicon-check-all"></i>
                            Validate
                        </button>
                    </Tooltip>
                    <div className="toolbar-separator"></div>
                    <Tooltip content="Run parameter sweeps and batch optimization studies">
                        <button className="theia-button secondary large" onClick={() => host.openOptimizationStudy()}>
                            <i className="codicon codicon-symbol-variable"></i>
                            Optimization
                        </button>
                    </Tooltip>
                    <Tooltip content="Restart the simulation from a previous statepoint file (openmc -r)">
                        <button
                            className="theia-button secondary large"
                            onClick={() => this.browseRestartFile(host)}
                            disabled={host.isRunning}
                        >
                            <i className="codicon codicon-history"></i>
                            Restart…
                        </button>
                    </Tooltip>
                </div>

                {state.settings.restartFile && (
                    <span className="restart-file restart-chip">
                        <i className="codicon codicon-history"></i>
                        {state.settings.restartFile.split('/').pop()}
                        <Tooltip content="Clear restart file">
                            <button
                                className="theia-button secondary small"
                                onClick={() => host.stateManager.updateSettings({ restartFile: undefined })}
                                disabled={host.isRunning}
                            >
                                <i className="codicon codicon-close"></i>
                            </button>
                        </Tooltip>
                    </span>
                )}

                {host.validationIssues.length > 0 && (
                    <div className="validation-results">
                        <h4>Validation Results</h4>
                        {host.validationIssues.map((issue, index) => (
                            <div key={index} className={`validation-issue ${issue.severity}`}>
                                <i
                                    className={`codicon codicon-${issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'info'}`}
                                ></i>
                                <span className="issue-category">[{issue.category}]</span>
                                <span className="issue-message">{issue.message}</span>
                            </div>
                        ))}
                    </div>
                )}

                <div className="simulation-info">
                    <div className="info-header">
                        <h4>Run Summary</h4>
                    </div>
                    <div className="info-grid">
                        <div className="info-item">
                            <label>Mode:</label>
                            <span>{state.settings.run.mode}</span>
                        </div>
                        {state.settings.run.mode !== 'volume' && (
                            <>
                                <div className="info-item">
                                    <label>Particles:</label>
                                    <span>
                                        {(
                                            state.settings.run as OpenMCEigenvalueSettings | OpenMCFixedSourceSettings
                                        ).particles.toLocaleString()}
                                    </span>
                                </div>
                                <div className="info-item">
                                    <label>Batches:</label>
                                    <span>{(state.settings.run as OpenMCEigenvalueSettings | OpenMCFixedSourceSettings).batches}</span>
                                </div>
                            </>
                        )}
                        {state.settings.run.mode === 'eigenvalue' && (
                            <div className="info-item">
                                <label>Inactive:</label>
                                <span>{(state.settings.run as OpenMCEigenvalueSettings).inactive}</span>
                            </div>
                        )}
                        <div className="info-item">
                            <label>Materials:</label>
                            <span>{state.materials.length}</span>
                        </div>
                        <div className="info-item">
                            <label>Cells:</label>
                            <span>{state.geometry.cells.length}</span>
                        </div>
                        <div className="info-item">
                            <label>Tallies:</label>
                            <span>{state.tallies?.length || 0}</span>
                        </div>
                        <div className="info-item">
                            <label>Meshes:</label>
                            <span>{state.meshes?.length || 0}</span>
                        </div>
                    </div>
                </div>

                {/* Depletion Summary */}
                {state.depletion?.enabled && (
                    <div className="simulation-info">
                        <div className="info-header">
                            <h4>Depletion Summary</h4>
                        </div>
                        <div className="info-grid">
                            <div className="info-item">
                                <label>Steps:</label>
                                <span>{state.depletion.timeSteps.length}</span>
                            </div>
                            <div className="info-item">
                                <label>Power:</label>
                                <span>
                                    {state.depletion.power || state.depletion.powerDensity || 0}{' '}
                                    {state.depletion.powerDensity ? 'W/g' : 'Watts'}
                                </span>
                            </div>
                            <div className="info-item">
                                <label>Chain File:</label>
                                <Tooltip content={state.depletion.chainFile || 'Not set'} position="top">
                                    <span className="file-path-summary">{state.depletion.chainFile?.split('/').pop() || 'Not set'}</span>
                                </Tooltip>
                            </div>
                            <div className="info-item">
                                <label>Solver:</label>
                                <span style={{ textTransform: 'uppercase' }}>{resolveDepletionSolver(state.depletion.solver)}</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Variance Reduction Summary */}
                {state.varianceReduction &&
                    (state.varianceReduction.survivalBiasing ||
                        state.varianceReduction.weightWindows ||
                        state.varianceReduction.sourceBiasing ||
                        state.varianceReduction.weightWindowGenerator) && (
                        <div className="simulation-info">
                            <div className="info-header">
                                <h4>
                                    <i className="codicon codicon-dashboard"></i> Variance Reduction
                                </h4>
                            </div>
                            <div className="info-grid">
                                {state.varianceReduction.survivalBiasing && (
                                    <div className="info-item">
                                        <label>Survival Biasing:</label>
                                        <span>Enabled</span>
                                    </div>
                                )}
                                {state.varianceReduction.weightWindows && (
                                    <div className="info-item">
                                        <label>Weight Windows:</label>
                                        <span>Mesh {state.varianceReduction.weightWindows.meshId}</span>
                                    </div>
                                )}
                                {state.varianceReduction.sourceBiasing && (
                                    <div className="info-item">
                                        <label>Source Biasing:</label>
                                        <span>Enabled</span>
                                    </div>
                                )}
                                {state.varianceReduction.weightWindowGenerator && (
                                    <div className="info-item">
                                        <label>WW Generator:</label>
                                        <span>{state.varianceReduction.weightWindowGenerator.iterations} iterations</span>
                                    </div>
                                )}
                                {state.varianceReduction.cutoff?.weight !== undefined && (
                                    <div className="info-item">
                                        <label>Weight Cutoff:</label>
                                        <span>{state.varianceReduction.cutoff.weight}</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                {/* Geometry Summary - CSG */}
                {state.geometry.cells.length > 0 && !state.settings.dagmcFile && (
                    <div className="simulation-info">
                        <div className="info-header">
                            <h4>CSG Geometry Summary</h4>
                            <Tooltip content="Open CSG Builder to edit geometry">
                                <button className="theia-button secondary small" onClick={() => host.openCSGBuilder()}>
                                    <i className="codicon codicon-edit"></i> Edit in CSG Builder
                                </button>
                            </Tooltip>
                        </div>
                        <div className="info-grid">
                            <div className="info-item">
                                <label>Surfaces:</label>
                                <span>{state.geometry.surfaces.length}</span>
                            </div>
                            <div className="info-item">
                                <label>Cells:</label>
                                <span>{state.geometry.cells.length}</span>
                            </div>
                            <div className="info-item">
                                <label>Universes:</label>
                                <span>{state.geometry.universes.length}</span>
                            </div>
                            <div className="info-item">
                                <label>Root Universe:</label>
                                <span>{state.geometry.rootUniverseId}</span>
                            </div>
                        </div>
                        {state.geometry.surfaces.length > 0 && (
                            <div className="info-footer">
                                <i className="codicon codicon-info"></i>
                                <span>Surface types: {Array.from(new Set(state.geometry.surfaces.map((s) => s.type))).join(', ')}</span>
                            </div>
                        )}
                    </div>
                )}

                {/* Geometry Summary - DAGMC */}
                {state.settings.dagmcFile && (
                    <div className="simulation-info dagmc-geometry">
                        <div className="info-header">
                            <h4>
                                <i className="codicon codicon-file-code"></i> DAGMC Geometry
                            </h4>
                            <Tooltip content="Open CSG Builder to view DAGMC details">
                                <button className="theia-button secondary small" onClick={() => host.openCSGBuilder()}>
                                    <i className="codicon codicon-eye"></i> View Details
                                </button>
                            </Tooltip>
                        </div>
                        <div className="info-grid">
                            <div className="info-item">
                                <label>File:</label>
                                <Tooltip content={state.settings.dagmcFile} position="bottom">
                                    <span className="dagmc-filename">{state.settings.dagmcFile.split('/').pop()}</span>
                                </Tooltip>
                            </div>
                            <div className="info-item">
                                <label>Type:</label>
                                <span>Faceted Mesh (DAGMC)</span>
                            </div>
                        </div>
                        <div className="info-footer dagmc-note">
                            <i className="codicon codicon-info"></i>
                            <span>DAGMC geometry is used directly. No CSG surfaces/cells needed.</span>
                        </div>
                    </div>
                )}

                {/* Console Output - File-based logs with filter */}
                <div ref={host.consolePanelRef} className={`console-panel ${host.consoleMaximized ? 'maximized' : ''}`}>
                    <div className="console-header">
                        <h4>
                            <i className="codicon codicon-terminal"></i> Simulation Output
                        </h4>
                        <div className="console-actions">
                            <input
                                type="text"
                                className="console-filter"
                                placeholder="Filter logs..."
                                value={host.logFilter}
                                onChange={(e) => host.filterLogContent(e.target.value)}
                            />
                            <Tooltip content={host.consoleMaximized ? 'Restore' : 'Maximize'}>
                                <button className="theia-button secondary small" onClick={() => this.toggleConsoleMaximize(host)}>
                                    <i className={`codicon codicon-${host.consoleMaximized ? 'collapse-all' : 'expand-all'}`}></i>
                                </button>
                            </Tooltip>
                            <Tooltip content="Clear console">
                                <button className="theia-button secondary small" onClick={() => this.clearConsole(host)}>
                                    <i className="codicon codicon-clear-all"></i>
                                </button>
                            </Tooltip>
                        </div>
                    </div>
                    <div className="console-content" ref={host.consoleContentRef}>
                        {host.loadedLogContent || host.consoleOutput.length > 0 ? (
                            <pre className="console-log">
                                {host.filteredLogContent || host.loadedLogContent || host.consoleOutput.map((l) => l.message).join('\n')}
                            </pre>
                        ) : (
                            <div className="console-empty">No output yet. Run a simulation to see logs here.</div>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    /**
     * Format elapsed seconds as mm:ss.
     * @param seconds - Time in seconds.
     * @returns Formatted time string.
     */
    private formatTime(seconds: number): string {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    /**
     * Clear all console output and loaded log content.
     * @param host - Simulation dashboard widget host.
     */
    private clearConsole(host: SimulationDashboardWidget): void {
        host.consoleOutput = [];
        host.loadedLogContent = '';
        host.filteredLogContent = '';
        host.logFilter = '';
        host.update();
    }

    /**
     * Toggle the console panel between normal and maximized state.
     * @param host - Simulation dashboard widget host.
     */
    private toggleConsoleMaximize(host: SimulationDashboardWidget): void {
        host.consoleMaximized = !host.consoleMaximized;
        host.update();
    }

    /**
     * Render the particle-restart section: shown when the chosen restart file
     * is a particle restart (`particle_restart.h5` / `particle_<batch>_<id>.h5`).
     * Offers one-click track capture for the restarted particle and a preview
     * via the registered output viewer.
     * @param host - Simulation dashboard widget host.
     * @param state - Current OpenMC simulation state.
     * @returns Particle restart section React node.
     */
    private renderParticleRestartSection(host: SimulationDashboardWidget, state: OpenMCState): React.ReactNode {
        const restartFile = state.settings.restartFile!;
        const baseName = restartFile.split(/[\\/]/).pop() ?? '';
        const info = parseParticleRestartFileName(baseName);
        const captureEnabled = state.settings.maxTracks !== undefined || (state.settings.tracks?.length ?? 0) > 0;

        return (
            <div className="restart-option particle-restart-info">
                <div className="form-hint">
                    <i className="codicon codicon-info"></i>
                    Particle restart — re-runs a single lost particle
                    {info.batch !== undefined && ` (batch ${info.batch}, particle ${info.particleId})`}. Track capture uses the `-t` flag
                    automatically for this run.
                </div>
                <Tooltip
                    content={
                        captureEnabled
                            ? 'Track capture is enabled for the restarted particle'
                            : 'Enable track capture for the restarted particle (maxTracks: 1)'
                    }
                >
                    <button
                        className="theia-button secondary"
                        onClick={() => this.captureTrackForRestart(host, restartFile)}
                        disabled={host.isRunning || captureEnabled}
                    >
                        <i className="codicon codicon-record"></i>
                        {captureEnabled ? 'Track Capture Enabled' : 'Capture Track for Restarted Particle'}
                    </button>
                </Tooltip>
                <Tooltip content="Preview the restart file in the particle restart viewer">
                    <button
                        className="theia-button secondary"
                        onClick={() => host.previewRestartFile(restartFile)}
                        disabled={host.isRunning}
                    >
                        <i className="codicon codicon-debug-restart"></i>
                        Preview Restart File
                    </button>
                </Tooltip>
            </div>
        );
    }

    /**
     * Enable track capture for the restarted particle: explicit [batch, 1, id]
     * triple when the filename carries ids, maxTracks: 1 always. The `-t` flag
     * is added at run time (particle-restart mode ignores the XML elements).
     * @param host - Simulation dashboard widget host.
     * @param restartFile - Path to the particle restart file.
     */
    private captureTrackForRestart(host: SimulationDashboardWidget, restartFile: string): void {
        const baseName = restartFile.split(/[\\/]/).pop() ?? '';
        const settings = deriveTrackCaptureSettings(parseParticleRestartFileName(baseName));
        host.stateManager.updateSettings(settings);
    }

    /**
     * Open a file dialog to select a statepoint file to restart the simulation from.
     * @param host - Simulation dashboard widget host.
     */
    private async browseRestartFile(host: SimulationDashboardWidget): Promise<void> {
        const props: OpenFileDialogProps = {
            title: 'Select Statepoint File to Restart From',
            canSelectFiles: true,
            canSelectFolders: false,
            filters: {
                'OpenMC Statepoint': ['h5'],
                'All Files': ['*']
            }
        };
        const uri = await host.fileDialogService.showOpenDialog(props);
        if (uri) {
            host.stateManager.updateSettings({ restartFile: uri.path.toString() });
        }
    }

    /**
     * Render the Kinetics (IFP) section: enable toggle, generation count,
     * precursor groups, and parameter selection. The IFP tallies are
     * auto-generated on export and shown with an 'auto' badge in the Tallies tab.
     * @param host - Simulation dashboard widget host.
     * @param state - Current OpenMC simulation state.
     * @returns Kinetics section React node.
     */
    private renderKineticsSection(host: SimulationDashboardWidget, state: OpenMCState): React.ReactNode {
        const kinetics = state.settings.kinetics;
        const isEigenvalue = state.settings.run.mode === 'eigenvalue';
        const isMultiGroup = state.settings.energyMode === 'multigroup';

        const updateKinetics = (updates: Partial<NonNullable<OpenMCState['settings']['kinetics']>>): void => {
            const merged = { ...(kinetics ?? {}), ...updates };
            const hasContent = Object.values(merged).some((v) => v !== undefined);
            host.stateManager.updateSettings({ kinetics: hasContent ? merged : undefined });
        };

        return (
            <div className="settings-section kinetics-section">
                <h3>
                    <i className="codicon codicon-pulse"></i> Kinetics (IFP)
                </h3>
                <div className="form-group checkbox">
                    <label>
                        <input
                            type="checkbox"
                            checked={kinetics?.enabled ?? false}
                            disabled={host.isRunning || (isMultiGroup && !kinetics?.enabled)}
                            onChange={(e) =>
                                updateKinetics(
                                    e.target.checked
                                        ? { enabled: true, ifpNGenerations: kinetics?.ifpNGenerations ?? 4 }
                                        : { enabled: false }
                                )
                            }
                        />
                        Enable kinetics parameters (Iterated Fission Probability)
                    </label>
                    {!isEigenvalue && <span className="form-hint">IFP kinetics requires eigenvalue (criticality) run mode.</span>}
                    {isMultiGroup && (
                        <span className="form-hint">
                            IFP kinetics requires continuous-energy mode (random ray does not support IFP scores).
                        </span>
                    )}
                </div>

                {kinetics?.enabled && (
                    <>
                        <div className="form-row">
                            <div className="form-group">
                                <label>IFP Generations</label>
                                <input
                                    type="number"
                                    min={1}
                                    value={kinetics.ifpNGenerations ?? 4}
                                    onChange={(e) => updateKinetics({ ifpNGenerations: parseInt(e.target.value) || 1 })}
                                />
                                <span className="form-hint">Must not exceed inactive batches</span>
                            </div>
                            <div className="form-group">
                                <label>Precursor Groups (β_eff)</label>
                                <select
                                    value={kinetics.numPrecursorGroups ?? 0}
                                    onChange={(e) => {
                                        const groups = parseInt(e.target.value);
                                        updateKinetics({ numPrecursorGroups: groups > 1 ? groups : undefined });
                                    }}
                                >
                                    <option value={0}>Total only</option>
                                    {[2, 3, 4, 5, 6, 7, 8].map((n) => (
                                        <option key={n} value={n}>
                                            {n} groups
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>
                        <div className="form-row">
                            <div className="form-group checkbox">
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={kinetics.computeBetaEff ?? true}
                                        onChange={(e) => updateKinetics({ computeBetaEff: e.target.checked })}
                                    />
                                    Compute β_eff
                                </label>
                            </div>
                            <div className="form-group checkbox">
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={kinetics.computeGenerationTime ?? true}
                                        onChange={(e) => updateKinetics({ computeGenerationTime: e.target.checked })}
                                    />
                                    Compute Λ_eff (generation time)
                                </label>
                            </div>
                        </div>
                        <span className="form-hint">
                            IFP tallies are auto-generated on export and appear with an 'auto' badge in the Tallies tab. Read results via
                            StatePoint.get_kinetics_parameters().
                        </span>
                    </>
                )}
            </div>
        );
    }
}
