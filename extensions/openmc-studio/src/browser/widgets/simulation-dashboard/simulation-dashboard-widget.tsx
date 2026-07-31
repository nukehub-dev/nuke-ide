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
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { MessageService } from '@theia/core/lib/common/message-service';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { WidgetManager, ApplicationShell } from '@theia/core/lib/browser';
import { FileDialogService, SaveFileDialogProps, OpenFileDialogProps } from '@theia/filesystem/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileStat } from '@theia/filesystem/lib/common/files';
import { OpenerService } from '@theia/core/lib/browser/opener-service';
import URI from '@theia/core/lib/common/uri';

import { OpenMCStateManager } from '../../openmc-state-manager';
import { OpenMCStudioService } from '../../openmc-studio-service';
import { OpenMCHealthService } from '../../services/openmc-health-service';
import { OpenMCXMLGenerationService } from '../../xml-generator/xml-generation-service';
import { OpenMCSimulationRunner } from './simulation-runner';
import { NukeCoreService, NukeCoreStatusBarVisibility, NukeCoreStatusBarVisibilityService } from 'nuke-core/lib/common';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { OpenMCState, OpenMCSettings, OpenMCRunSettings } from '../../../common/openmc-state-schema';
import { SimulationProgress, SimulationStatusEvent, ValidationIssue } from '../../../common/openmc-studio-protocol';
import { isParticleRestartFile, needsTrackFlagForRun } from '../../../common/particle-restart';
import { resolveCmfdRunConfig } from '../../../common/cmfd';
import { STUDIO_CORE_PACKAGES } from '../../../common/packages';
import { CSGBuilderWidget } from '../csg-builder/csg-builder-widget';
import { OptimizationWidget } from '../optimization/optimization-widget';
import { DashboardTabContribution, DashboardTabRegistry } from './tabs/tab-registry';

/**
 * Active tab identifier for the Simulation Dashboard.
 */
export type DashboardTab = 'settings' | 'materials' | 'tallies' | 'depletion' | 'variance-reduction' | 'simulation';

/**
 * Central dashboard for configuring and running OpenMC simulations.
 *
 * Manages simulation settings, materials, tallies, depletion configuration,
 * variance reduction settings, and simulation execution with live output.
 *
 * @see {@link CSGBuilderWidget} for geometry editing
 * @see {@link OptimizationWidget} for parameter sweep studies
 * @see {@link SimulationComparisonWidget} for result comparison
 */
@injectable()
export class SimulationDashboardWidget extends ReactWidget {
    /** Unique widget identifier. */
    static readonly ID = 'openmc-simulation-dashboard';
    /** Display label for the widget title. */
    static readonly LABEL = 'OpenMC Simulation Dashboard';

    @inject(MessageService)
    public readonly messageService!: MessageService;

    @inject(OpenMCStateManager)
    public readonly stateManager!: OpenMCStateManager;

    @inject(OpenMCStudioService)
    public readonly studioService!: OpenMCStudioService;

    @inject(OpenMCHealthService)
    protected readonly healthService!: OpenMCHealthService;

    @inject(OpenMCXMLGenerationService)
    protected readonly xmlService!: OpenMCXMLGenerationService;

    @inject(OpenMCSimulationRunner)
    protected readonly simulationRunner!: OpenMCSimulationRunner;

    @inject(FileDialogService)
    public readonly fileDialogService!: FileDialogService;

    @inject(FileService)
    protected readonly fileService!: FileService;

    @inject(OpenerService)
    protected readonly openerService!: OpenerService;

    @inject(WidgetManager)
    public readonly widgetManager!: WidgetManager;

    @inject(ApplicationShell)
    public readonly shell!: ApplicationShell;

    @inject(PreferenceService)
    protected readonly preferences!: PreferenceService;

    @inject(NukeCoreService)
    public readonly nukeCoreService!: NukeCoreService;

    @inject(CommandRegistry)
    protected readonly commands!: CommandRegistry;

    @inject(NukeCoreStatusBarVisibility)
    protected readonly statusBarVisibility!: NukeCoreStatusBarVisibilityService;

    @inject(DashboardTabRegistry)
    protected readonly tabRegistry!: DashboardTabRegistry;

    private activeTab: string = 'settings';
    private visibilityHandle?: { dispose: () => void };
    public isRunning = false;
    public simulationProgress?: SimulationProgress;
    public validationIssues: ValidationIssue[] = [];
    public consoleOutput: { type: 'info' | 'error' | 'warn'; message: string; timestamp: Date }[] = [];
    public consoleMaximized = false;
    public consoleContentRef = React.createRef<HTMLDivElement>();
    public consolePanelRef = React.createRef<HTMLDivElement>();
    /** tracks.h5 produced by the last completed run (surfaced as 'Open Tracks') */
    public producedTracksUri?: URI;
    /** Whether the current/last run is expected to write a tracks file */
    private expectTracksFile = false;

    // File-based log support
    private currentProcessId?: string;
    private logPollInterval?: number;
    public loadedLogContent = '';
    public filteredLogContent = '';
    public logFilter = '';

    // Track last working directory for simulations
    private lastSimulationDirectory?: string;

    /**
     * Initialize widget id, title, event listeners for simulation progress,
     * state changes, and console output.
     */
    @postConstruct()
    protected init(): void {
        this.id = SimulationDashboardWidget.ID;
        this.title.label = SimulationDashboardWidget.LABEL;
        this.title.caption = SimulationDashboardWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-dashboard';

        // Listen to state changes
        this.stateManager.onStateChange(() => this.update());
        this.stateManager.onStateReload(() => this.update());
        this.stateManager.onDirtyChange(() => this.updateTitle());

        // Listen to simulation progress
        this.simulationRunner.onProgress((progress) => {
            this.simulationProgress = progress;
            this.update();
        });

        this.simulationRunner.onStatusChange((event) => {
            const wasRunning = this.isRunning;
            this.isRunning = event.status === 'running' || event.status === 'starting';

            // Track processId for file-based logs
            if (event.processId) {
                this.currentProcessId = event.processId;
            }

            // Log state change for debugging
            console.log(
                `[Simulation] Status: ${event.status}, isRunning: ${this.isRunning} (was: ${wasRunning}), processId: ${this.currentProcessId}`
            );

            // Log status changes to console
            if (event.status === 'completed') {
                this.logToConsole('Simulation completed successfully');
                this.stopLogPolling();
                this.detectProducedTracks();
            } else if (event.status === 'failed') {
                const errorMsg = event.result?.error || `Exit code: ${event.result?.exitCode}`;
                this.logToConsole(`Simulation failed: ${errorMsg}`, 'error');
                this.stopLogPolling();
            } else if (event.status === 'cancelled') {
                this.logToConsole('Simulation cancelled');
                this.stopLogPolling();
            } else if (event.status === 'running') {
                // Start polling for logs when simulation is running
                this.startLogPolling();
            }

            if (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled') {
                this.simulationProgress = undefined;
                // Force a reset of running state for terminal states
                this.isRunning = false;
            }

            // Force immediate re-render
            this.update();
        });

        // Listen to real-time simulation output from window event
        window.addEventListener('openmc-output', ((evt: CustomEvent) => {
            const { type, data } = evt.detail;
            // Split by lines and log each non-empty line
            const lines = data.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                // Skip logo/art lines (lines with only %, #, or common logo patterns)
                if (/^[\s%#|]+$/.test(trimmed)) continue;
                if (trimmed.match(/^%+$|^#+$/)) continue;
                if (trimmed.includes('%%%%%%%%') || trimmed.includes('############')) continue;
                this.logToConsole(line, type === 'stderr' ? 'error' : 'info');
            }
        }) as EventListener);

        // Listen to simulation status events from backend
        window.addEventListener('openmc-simulation-status', ((evt: CustomEvent) => {
            const event = evt.detail as SimulationStatusEvent;
            console.log('[Simulation] Status event:', event.status, 'processId:', event.processId);

            // Update running state based on status
            if (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled') {
                this.isRunning = false;
                this.simulationProgress = undefined;
                if (event.result) {
                    this.simulationRunner.onSimulationFinished(event.result);
                }

                // Log final status to console
                if (event.status === 'completed') {
                    this.logToConsole('Simulation completed successfully');
                    if (event.result?.timing) {
                        this.logToConsole(`Duration: ${event.result.timing.duration.toFixed(1)}s`);
                    }
                } else if (event.status === 'failed') {
                    this.logToConsole(`Simulation failed: ${event.result?.error || 'Unknown error'}`, 'error');
                } else if (event.status === 'cancelled') {
                    this.logToConsole('Simulation cancelled by user', 'warn');
                }
            } else if (event.status === 'running' || event.status === 'starting') {
                this.isRunning = true;
            }

            this.update();
        }) as EventListener);

        this.updateTitle();
        this.update();

        // Set up periodic state sync to prevent UI from getting stuck
        setInterval(() => {
            // If we think we're running but the runner doesn't, sync the state
            if (this.isRunning && !this.simulationRunner['_isRunning']) {
                console.log('[Simulation] State sync: resetting isRunning flag');
                this.isRunning = false;
                this.simulationProgress = undefined;
                this.update();
            }
        }, 2000); // Check every 2 seconds
    }

    /**
     * Called when the widget is activated (becomes visible/focused).
     * Sync the running state with the simulation runner.
     */
    protected onActivateRequest(msg: any): void {
        super.onActivateRequest(msg);
        // Sync state with runner when widget becomes active
        const runnerState = (this.simulationRunner as any)['_isRunning'];
        if (this.isRunning !== runnerState) {
            console.log(`[Simulation] Sync on activate: widget=${this.isRunning}, runner=${runnerState}`);
            this.isRunning = runnerState;
            this.update();
        }
    }

    /**
     * Dispose the widget and clean up resources.
     */
    dispose(): void {
        this.stopLogPolling();
        this.visibilityHandle?.dispose();
        super.dispose();
    }

    /**
     * Called when the widget becomes visible.
     * Requests the nuke-core status bar to be visible.
     */
    protected onAfterShow(msg: any): void {
        super.onAfterShow(msg);
        this.visibilityHandle = this.statusBarVisibility.requestVisibility('openmc-studio');
    }

    /**
     * Called when the widget is hidden.
     * Releases the status bar visibility request.
     */
    protected onBeforeHide(msg: any): void {
        this.visibilityHandle?.dispose();
        this.visibilityHandle = undefined;
        super.onBeforeHide(msg);
    }

    /**
     * Update the widget title with dirty indicator and project name.
     */
    private updateTitle(): void {
        const state = this.stateManager.getState();
        const dirtyIndicator = this.stateManager.isDirty ? '● ' : '';
        this.title.label = `${dirtyIndicator}${state.metadata.name}`;
    }

    /**
     * Programmatically switch to a specific dashboard tab.
     * @param tabId - Tab id to activate.
     */
    public setActiveTab(tabId: string): void {
        this.activeTab = tabId;
        this.update();
    }

    /**
     * Render the dashboard main layout.
     * @returns The React element tree for the widget.
     */
    protected render(): React.ReactNode {
        const state = this.stateManager.getState();
        const tabs = this.tabRegistry.getTabs(state);
        const activeTab = tabs.find((tab) => tab.id === this.activeTab) ?? tabs[0];

        return (
            <div className="simulation-dashboard">
                {this.renderHeader(state)}
                {this.renderTabs(tabs)}
                <div className="dashboard-content">{activeTab?.render(this, state)}</div>
            </div>
        );
    }

    private editingProjectName = false;
    private newProjectName = '';
    private newProjectDescription = '';

    /**
     * Render the dashboard header with project info and action buttons.
     * @param state - Current OpenMC simulation state.
     * @returns Header React node.
     */
    private renderHeader(state: OpenMCState): React.ReactNode {
        return (
            <div className="dashboard-header">
                <div className="project-info">
                    {this.editingProjectName ? (
                        <div className="project-name-edit">
                            <input
                                type="text"
                                className="project-name-input"
                                value={this.newProjectName}
                                onChange={(e) => {
                                    this.newProjectName = e.target.value;
                                    this.update();
                                }}
                                placeholder="Project name"
                                autoFocus
                            />
                            <input
                                type="text"
                                className="project-desc-input"
                                value={this.newProjectDescription}
                                onChange={(e) => {
                                    this.newProjectDescription = e.target.value;
                                    this.update();
                                }}
                                placeholder="Description (optional)"
                            />
                            <Tooltip content="Save" position="top">
                                <button className="theia-button primary small" onClick={() => this.saveProjectName()}>
                                    <i className="codicon codicon-check"></i>
                                </button>
                            </Tooltip>
                            <Tooltip content="Cancel" position="top">
                                <button
                                    className="theia-button secondary small"
                                    onClick={() => {
                                        this.editingProjectName = false;
                                        this.update();
                                    }}
                                >
                                    <i className="codicon codicon-close"></i>
                                </button>
                            </Tooltip>
                        </div>
                    ) : (
                        <Tooltip content="Click to rename" position="bottom">
                            <h2 onClick={() => this.startEditProjectName()}>
                                <i className="codicon codicon-symbol-method"></i>
                                {state.metadata.name}
                                <i className="codicon codicon-edit edit-icon"></i>
                            </h2>
                        </Tooltip>
                    )}
                    {state.metadata.description && !this.editingProjectName && (
                        <p className="project-description">{state.metadata.description}</p>
                    )}
                </div>
                <div className="project-actions">
                    <Tooltip content="New Project" position="bottom">
                        <button className="theia-button secondary" onClick={() => this.newProject()}>
                            <i className="codicon codicon-new-file"></i>
                        </button>
                    </Tooltip>
                    <Tooltip content="Open Project" position="bottom">
                        <button className="theia-button secondary" onClick={() => this.openProject()}>
                            <i className="codicon codicon-folder-opened"></i>
                        </button>
                    </Tooltip>
                    <Tooltip content="Save Project" position="bottom">
                        <button className="theia-button secondary" onClick={() => this.saveProject()}>
                            <i className="codicon codicon-save"></i>
                        </button>
                    </Tooltip>
                    <Tooltip content="Generate XML Files" position="bottom">
                        <button className="theia-button secondary" onClick={() => this.generateXML()}>
                            <i className="codicon codicon-file-code"></i>
                        </button>
                    </Tooltip>
                </div>
            </div>
        );
    }

    /**
     * Render the tab selector for all dashboard sections.
     * @param tabs - Registered dashboard tabs to display.
     * @returns Tabs React node.
     */
    private renderTabs(tabs: DashboardTabContribution[]): React.ReactNode {
        return (
            <div className="dashboard-tabs">
                {tabs.map((tab) => (
                    <button
                        key={tab.id}
                        className={`tab-button ${this.activeTab === tab.id ? 'active' : ''}`}
                        onClick={() => {
                            this.activeTab = tab.id;
                            this.update();
                        }}
                    >
                        <i className={`codicon codicon-${tab.icon}`}></i>
                        {tab.label}
                    </button>
                ))}
            </div>
        );
    }

    // ============================================================================
    // Helper Methods
    // ============================================================================

    /**
     * Append a message to the simulation console output.
     * @param message - Message text to log.
     * @param type - Log severity level.
     */
    public logToConsole(message: string, type: 'info' | 'error' | 'warn' = 'info'): void {
        this.consoleOutput.push({
            type,
            message,
            timestamp: new Date()
        });
        // Keep only last 500 lines
        if (this.consoleOutput.length > 500) {
            this.consoleOutput = this.consoleOutput.slice(-500);
        }
        this.update();
        // Auto-scroll to bottom
        setTimeout(() => {
            const content = this.consoleContentRef.current;
            if (content) {
                content.scrollTop = content.scrollHeight;
            }
        }, 0);
    }

    // ============================================================================
    // File-based Log Polling (similar to optimization widget)
    // ============================================================================

    /**
     * Start polling the simulation runner for log file updates.
     */
    private startLogPolling(): void {
        if (this.logPollInterval) {
            window.clearInterval(this.logPollInterval);
        }

        // Poll for log updates every 2 seconds
        this.logPollInterval = window.setInterval(async () => {
            if (!this.currentProcessId) return;

            try {
                const result = await this.simulationRunner.getSimulationLog(this.currentProcessId);
                if (result.success && result.logContent) {
                    // Only update if content changed
                    if (result.logContent !== this.loadedLogContent) {
                        this.loadedLogContent = result.logContent;
                        this.applyLogFilter();
                        this.update();

                        // Auto-scroll to bottom
                        setTimeout(() => {
                            const content = this.consoleContentRef.current;
                            if (content) {
                                content.scrollTop = content.scrollHeight;
                            }
                        }, 0);
                    }
                }
            } catch (error) {
                // Silently fail on polling errors
            }
        }, 2000);
    }

    /**
     * Stop log polling and perform a final log load.
     */
    private stopLogPolling(): void {
        if (this.logPollInterval) {
            window.clearInterval(this.logPollInterval);
            this.logPollInterval = undefined;
        }
        // Final log load
        if (this.currentProcessId) {
            this.loadFinalLog();
        }
    }

    /**
     * Perform one final log load after polling stops.
     */
    private async loadFinalLog(): Promise<void> {
        if (!this.currentProcessId) return;

        try {
            const result = await this.simulationRunner.getSimulationLog(this.currentProcessId);
            if (result.success && result.logContent) {
                this.loadedLogContent = result.logContent;
                this.applyLogFilter();
                this.update();
            }
        } catch (error) {
            console.error('[SimulationDashboard] Error loading final log:', error);
        }
    }

    /**
     * Apply the current filter string to loaded log content.
     */
    private applyLogFilter(): void {
        if (!this.logFilter) {
            this.filteredLogContent = '';
            return;
        }

        const filterLower = this.logFilter.toLowerCase();
        const lines = this.loadedLogContent.split('\n');
        const filtered = lines.filter((line) => line.toLowerCase().includes(filterLower)).join('\n');
        this.filteredLogContent = filtered;
    }

    /**
     * Update the log filter and re-apply filtering.
     * @param filter - Search filter string.
     */
    public filterLogContent(filter: string): void {
        this.logFilter = filter;
        this.applyLogFilter();
        this.update();
    }

    // ============================================================================
    // Action Handlers
    // ============================================================================

    /**
     * Open the CSG Builder widget.
     * @see {@link CSGBuilderWidget}
     */
    public async openCSGBuilder(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget(CSGBuilderWidget.ID);
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);
    }

    /**
     * Open the DAGMC Editor for the loaded DAGMC file.
     * @see {@link DAGMCEditorWidget}
     */
    public async openDagmcEditor(): Promise<void> {
        const state = this.stateManager.getState();
        if (state.settings?.dagmcFile) {
            await this.commands.executeCommand('openmc.openDAGMCEditor', state.settings.dagmcFile);
        } else {
            this.messageService.warn('No DAGMC file loaded');
        }
    }

    /**
     * Open the Optimization Study widget.
     * @see {@link OptimizationWidget}
     */
    public async openOptimizationStudy(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget(OptimizationWidget.ID);
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);
    }

    /**
     * Create a new blank OpenMC project.
     */
    private async newProject(): Promise<void> {
        if (this.stateManager.isDirty) {
            // TODO: Show confirmation dialog
        }
        this.stateManager.reset();
        this.messageService.info('Created new OpenMC project');
    }

    /**
     * Enter project name editing mode.
     */
    private startEditProjectName(): void {
        this.editingProjectName = true;
        this.newProjectName = this.stateManager.getState().metadata.name;
        this.newProjectDescription = this.stateManager.getState().metadata.description || '';
        this.update();
    }

    /**
     * Save the edited project name and description to state.
     */
    private saveProjectName(): void {
        if (!this.newProjectName.trim()) {
            this.messageService.error('Project name cannot be empty');
            return;
        }

        this.stateManager.updateMetadata({
            name: this.newProjectName.trim(),
            description: this.newProjectDescription.trim() || undefined
        });

        this.editingProjectName = false;
        this.updateTitle();
        this.messageService.info('Project renamed');
    }

    /**
     * Open an existing OpenMC project file.
     */
    private async openProject(): Promise<void> {
        const props: OpenFileDialogProps = {
            title: 'Open OpenMC Project',
            canSelectFiles: true,
            canSelectFolders: false,
            filters: {
                'OpenMC Project': ['nuke-openmc', 'json'],
                'All Files': ['*']
            }
        };

        const uri = await this.fileDialogService.showOpenDialog(props);
        if (uri) {
            try {
                const result = await this.studioService.getBackendService().loadProject(uri.path.toString());
                if (result.success && result.project) {
                    this.stateManager.setState(result.project.state);
                    this.stateManager.setProjectPath(uri.path.toString());
                    this.stateManager.markClean();
                    this.messageService.info(`Opened project: ${result.project.state.metadata.name}`);
                } else {
                    this.messageService.error(`Failed to open project: ${result.error}`);
                }
            } catch (error) {
                this.messageService.error(`Error opening project: ${error}`);
            }
        }
    }

    /**
     * Save the current project to its existing path, or prompt for one.
     */
    private async saveProject(): Promise<void> {
        if (this.stateManager.projectPath) {
            await this.doSave(this.stateManager.projectPath);
        } else {
            await this.saveProjectAs();
        }
    }

    /**
     * Prompt for a save location and save the project.
     */
    private async saveProjectAs(): Promise<void> {
        const props: SaveFileDialogProps = {
            title: 'Save OpenMC Project',
            inputValue: `${this.stateManager.getState().metadata.name}.nuke-openmc`
        };

        const uri = await this.fileDialogService.showSaveDialog(props);
        if (uri) {
            await this.doSave(uri.path.toString());
        }
    }

    /**
     * Perform the project save operation via the backend.
     * @param path - File path to save to.
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
     * Generate OpenMC XML input files in a selected directory.
     */
    private async generateXML(): Promise<void> {
        // Use last simulation directory as default (strip 'logs' if present)
        let defaultFolder: FileStat | undefined;
        if (this.lastSimulationDirectory) {
            const dir = this.lastSimulationDirectory.replace(/[\\/]logs$/, '');
            defaultFolder = FileStat.dir(new URI(dir));
        }

        const props: OpenFileDialogProps = {
            title: 'Select Output Directory for XML Files',
            canSelectFiles: false,
            canSelectFolders: true
        };

        const uri = await this.fileDialogService.showOpenDialog(props, defaultFolder);
        if (!uri) {
            return;
        }

        // Save the selected directory for next time
        this.lastSimulationDirectory = uri.path.toString();

        this.logToConsole(`Generating XML files in ${uri.path.toString()}...`);

        const state = this.stateManager.getState();
        const hasCSG = state.geometry.cells.length > 0;
        const hasDagmc = !!state.settings.dagmcFile;

        try {
            const result = await this.xmlService.generateXML({
                state,
                outputDirectory: uri.path.toString(),
                files: {
                    materials: true,
                    settings: true,
                    geometry: hasCSG || hasDagmc, // Generate for DAGMC too (needs dagmc_universe reference)
                    tallies: state.tallies.length > 0,
                    plots: false
                }
            });

            if (result.success) {
                this.messageService.info(`Generated XML files: ${result.generatedFiles.map((f) => f.split('/').pop()).join(', ')}`);
                this.logToConsole(`Generated: ${result.generatedFiles.map((f) => f.split('/').pop()).join(', ')}`);
            } else {
                this.messageService.error(`Failed to generate XML: ${result.error}`);
                this.logToConsole(`XML generation failed: ${result.error}`, 'error');
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Error generating XML: ${msg}`);
            this.logToConsole(`XML generation error: ${msg}`, 'error');
        }
    }

    /**
     * Import OpenMC XML files from a directory into the current project.
     */
    async importXML(): Promise<void> {
        // Use last simulation directory as default (strip 'logs' if present)
        let defaultFolder: FileStat | undefined;
        if (this.lastSimulationDirectory) {
            const dir = this.lastSimulationDirectory.replace(/[\\/]logs$/, '');
            defaultFolder = FileStat.dir(new URI(dir));
        }

        const props: OpenFileDialogProps = {
            title: 'Select Directory with XML Files',
            canSelectFiles: false,
            canSelectFolders: true
        };

        const uri = await this.fileDialogService.showOpenDialog(props, defaultFolder);
        if (!uri) {
            return;
        }

        // Save the selected directory for next time
        this.lastSimulationDirectory = uri.path.toString();

        this.logToConsole(`Importing XML from ${uri.path.toString()}...`);

        try {
            const result = await this.studioService.getBackendService().importXML({
                directory: uri.path.toString(),
                options: {
                    mergeStrategy: 'replace',
                    validate: true
                }
            });

            if (result.success && result.state) {
                this.stateManager.setState(result.state);
                const matCount = result.state.materials?.length || 0;
                const cellCount = result.state.geometry?.cells?.length || 0;
                const surfCount = result.state.geometry?.surfaces?.length || 0;
                this.messageService.info(`Imported XML files with ${result.warnings?.length || 0} warnings`);
                this.logToConsole(`Imported ${matCount} materials, ${cellCount} cells, ${surfCount} surfaces`);

                // Debug: log first surface
                if (result.state.geometry?.surfaces?.length > 0) {
                    const firstSurf = result.state.geometry.surfaces[0];
                    console.log('[ImportXML] First surface:', firstSurf);
                }

                if (result.warnings && result.warnings.length > 0) {
                    console.warn('[OpenMC Studio] Import warnings:', result.warnings);
                    result.warnings.forEach((w) => this.logToConsole(`Warning: ${w}`, 'warn'));
                }
            } else {
                this.messageService.error(`Failed to import XML: ${result.errors.join(', ')}`);
                this.logToConsole(`Import failed: ${result.errors.join(', ')}`, 'error');
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Error importing XML: ${msg}`);
            this.logToConsole(`Import error: ${msg}`, 'error');
        }
    }

    /**
     * Validate the model, generate XML, and start the OpenMC simulation.
     */
    public async runSimulation(): Promise<void> {
        // First validate
        const validation = await this.validateModel();
        if (!validation.valid) {
            const errors = validation.issues.filter((i) => i.severity === 'error').length;
            this.messageService.error(`Cannot run simulation: ${errors} validation errors. Check the Simulation tab for details.`);
            this.logToConsole(`Validation failed: ${errors} errors`, 'error');
            return;
        }

        // Check OpenMC availability (with fallback discovery across all envs)
        const openmcCheck = await this.nukeCoreService.detectPythonWithRequirements({
            requiredPackages: STUDIO_CORE_PACKAGES,
            searchWorkspaceVenvs: true
        });
        if (!openmcCheck.success || !openmcCheck.command) {
            this.messageService.error(openmcCheck.error || 'OpenMC is not available');
            this.logToConsole(openmcCheck.error || 'OpenMC is not available', 'error');
            return;
        }
        if (openmcCheck.warning) {
            this.messageService.warn(openmcCheck.warning);
            this.logToConsole(`Warning: ${openmcCheck.warning}`, 'warn');
        }

        // Select working directory
        // Use last simulation directory as default, but ensure we don't default to the 'logs' subfolder
        let defaultFolder: FileStat | undefined;
        if (this.lastSimulationDirectory) {
            // Make sure we're not pointing to a 'logs' folder
            if (!this.lastSimulationDirectory.endsWith('/logs') && !this.lastSimulationDirectory.endsWith('\\logs')) {
                defaultFolder = FileStat.dir(new URI(this.lastSimulationDirectory));
            } else {
                // Strip the 'logs' part and go to parent
                defaultFolder = FileStat.dir(new URI(this.lastSimulationDirectory.replace(/[\\/]logs$/, '')));
            }
        }

        const props: OpenFileDialogProps = {
            title: 'Select Working Directory for Simulation',
            canSelectFiles: false,
            canSelectFolders: true
        };

        const uri = await this.fileDialogService.showOpenDialog(props, defaultFolder);
        if (!uri) {
            return;
        }

        // Save the selected directory for next time
        this.lastSimulationDirectory = uri.path.toString();

        this.logToConsole(`Starting simulation in ${uri.path.toString()}...`);

        const simState = this.stateManager.getState();
        const simHasCSG = simState.geometry.cells.length > 0;
        const simHasDagmc = !!simState.settings.dagmcFile;

        try {
            // Generate XML first
            this.logToConsole('Generating XML files...');
            const xmlResult = await this.xmlService.generateXML({
                state: simState,
                outputDirectory: uri.path.toString(),
                files: {
                    materials: true,
                    settings: true,
                    geometry: simHasCSG || simHasDagmc, // Generate for DAGMC too (needs dagmc_universe reference)
                    tallies: simState.tallies.length > 0,
                    plots: false
                }
            });

            if (!xmlResult.success) {
                this.messageService.error(`Failed to generate XML: ${xmlResult.error}`);
                this.logToConsole(`XML generation failed: ${xmlResult.error}`, 'error');
                return;
            }

            this.logToConsole(`Generated XML files: ${xmlResult.generatedFiles?.join(', ')}`);

            // Check and log cross-sections path
            const xsPath = this.nukeCoreService.getCrossSectionsPath();
            if (xsPath) {
                this.logToConsole(`Using cross-sections: ${xsPath}`);
            } else {
                this.logToConsole('Warning: No cross-sections path configured. Set nuke.openmcCrossSections in preferences.', 'warn');
            }

            // Run simulation
            this.logToConsole('Starting OpenMC simulation...');
            // Auto-expand and focus the Simulation Output console
            this.consoleMaximized = true;
            this.update();
            // Scroll to Simulation Output panel after UI update
            setTimeout(() => {
                const panel = this.consolePanelRef.current;
                if (panel) {
                    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }, 100);
            // Set running state immediately for UI responsiveness
            this.isRunning = true;
            this.update();

            // Particle restart runs capture the restarted particle's track via
            // the CLI -t flag (particle-restart mode ignores the settings.xml
            // track elements — OpenMC src/particle_restart.cpp).
            const restartFile = simState.settings.restartFile;
            const captureEnabled = simState.settings.maxTracks !== undefined || (simState.settings.tracks?.length ?? 0) > 0;
            const args: string[] = [];
            if (needsTrackFlagForRun(restartFile, captureEnabled)) {
                args.push('-t');
            }
            this.expectTracksFile = captureEnabled && (args.length > 0 || !isParticleRestartFile(restartFile));
            this.producedTracksUri = undefined;

            // Note: runSimulation returns immediately, completion handled by events
            this.simulationRunner.runSimulation({
                workingDirectory: uri.path.toString(),
                restartFile,
                args: args.length > 0 ? args : undefined,
                // CMFD is C-API-only: when enabled the backend routes to the
                // run_cmfd.py driver instead of the openmc binary. meshRef is
                // resolved to inline bounds here (the backend has no state).
                cmfd: resolveCmfdRunConfig(simState)
            });
            if (simState.settings.cmfd?.enabled) {
                this.logToConsole('CMFD acceleration enabled — running via openmc.cmfd C API');
            }
            this.logToConsole('Simulation started (running in background)');
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Error running simulation: ${msg}`);
            this.logToConsole(`Error: ${msg}`, 'error');
            // Reset running state on error
            this.isRunning = false;
            this.update();
        }
    }

    /**
     * Stop the currently running simulation.
     */
    public async stopSimulation(): Promise<void> {
        this.logToConsole('Stopping simulation...');
        const success = await this.simulationRunner.stopSimulation();

        if (success) {
            this.messageService.info('Simulation stopped');
            this.logToConsole('Simulation stopped by user');
        } else {
            this.messageService.warn('Failed to stop simulation');
            this.logToConsole('Failed to stop simulation', 'warn');
        }

        // Force reset of running state regardless of success
        this.isRunning = false;
        this.simulationProgress = undefined;
        this.update();
    }

    /**
     * After a completed run, check the working directory for a track file
     * (`tracks.h5`, or `tracks_p0.h5` for MPI runs) and surface it as an
     * 'Open Tracks' action in the simulation tab.
     */
    protected async detectProducedTracks(): Promise<void> {
        if (!this.expectTracksFile || !this.lastSimulationDirectory) {
            return;
        }
        for (const name of ['tracks.h5', 'tracks_p0.h5']) {
            const uri = new URI(`${this.lastSimulationDirectory}/${name}`);
            if (await this.fileService.exists(uri)) {
                this.producedTracksUri = uri;
                this.logToConsole(`Track file written: ${name} — use 'Open Tracks' to view it`);
                this.update();
                return;
            }
        }
    }

    /**
     * Open a file through the standard opener service; registered output
     * viewers (e.g. nuke-visualizer's tracks / particle restart viewers)
     * claim their file kinds via the open-handler chain.
     * @param uri - File to open.
     */
    public async openFile(uri: URI): Promise<void> {
        try {
            const opener = await this.openerService.getOpener(uri);
            await opener.open(uri);
        } catch (error) {
            this.messageService.error(`Failed to open ${uri.path.base}: ${error instanceof Error ? error.message : error}`);
        }
    }

    /**
     * Preview a particle restart file in the registered particle restart viewer.
     * @param path - Absolute path to the restart file.
     */
    public async previewRestartFile(path: string): Promise<void> {
        return this.openFile(new URI(path));
    }

    /**
     * Whether a simulation is currently running.
     */
    public get isSimulationRunning(): boolean {
        return this.isRunning;
    }

    /**
     * Validate the current simulation model and display issues.
     * @returns Validation result with issues list.
     */
    public async validateModel(): Promise<{ valid: boolean; issues: ValidationIssue[] }> {
        this.logToConsole('Validating model...');
        const result = await this.stateManager.validate();
        this.validationIssues = result.issues;
        this.activeTab = 'simulation';

        const errorCount = result.issues.filter((i) => i.severity === 'error').length;
        const warnCount = result.issues.filter((i) => i.severity === 'warning').length;

        if (result.valid) {
            this.logToConsole('Validation passed');
        } else {
            this.logToConsole(`Validation failed: ${errorCount} errors, ${warnCount} warnings`, 'error');
        }

        result.issues.forEach((issue) => {
            if (issue.severity === 'error') {
                this.logToConsole(`[${issue.category}] ${issue.message}`, 'error');
            } else if (issue.severity === 'warning') {
                this.logToConsole(`[${issue.category}] ${issue.message}`, 'warn');
            }
        });

        this.update();
        return result;
    }

    // ============================================================================
    // Settings Updaters
    // ============================================================================

    /**
     * Update the simulation run mode and initialize default settings.
     * @param mode - New run mode (eigenvalue, fixed source, or volume).
     */
    public updateRunMode(mode: OpenMCRunSettings['mode']): void {
        const current = this.stateManager.getState().settings.run;
        let newRunSettings: OpenMCRunSettings;

        if (mode === 'eigenvalue') {
            newRunSettings = {
                mode: 'eigenvalue',
                particles: (current as any).particles || 1000,
                inactive: 10,
                batches: (current as any).batches || 100
            };
        } else if (mode === 'fixed source') {
            newRunSettings = {
                mode: 'fixed source',
                particles: (current as any).particles || 1000,
                batches: (current as any).batches || 10
            };
        } else {
            newRunSettings = {
                mode: 'volume',
                samples: 1000000
            };
        }

        this.updateSetting('run', newRunSettings);
    }

    /**
     * Update a single setting key in the current state.
     * @param key - Setting key to update.
     * @param value - New value for the setting.
     */
    public updateSetting<K extends keyof OpenMCSettings>(key: K, value: OpenMCSettings[K]): void {
        this.stateManager.updateSettings({
            ...this.stateManager.getState().settings,
            [key]: value
        });
    }
}
