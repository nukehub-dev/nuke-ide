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

import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { MessageService } from '@theia/core/lib/common/message-service';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { WidgetManager, ApplicationShell } from '@theia/core/lib/browser';
import { FileDialogService, SaveFileDialogProps, OpenFileDialogProps } from '@theia/filesystem/lib/browser';

import { OpenMCStateManager } from '../openmc-state-manager';
import { OpenMCStudioService } from '../openmc-studio-service';
import { OpenMCXMLGenerationService } from '../xml-generator/xml-generation-service';
import { OpenMCSimulationRunner } from './simulation-runner';
import { NukeCoreService } from 'nuke-core/lib/common';
import { Tooltip, ColorPicker } from 'nuke-essentials/lib/theme/browser/components';
import {
    OpenMCState,
    OpenMCMaterial,
    OpenMCSettings,
    OpenMCRunSettings,
    OpenMCEigenvalueSettings,
    OpenMCFixedSourceSettings,
    OpenMCSource,
    OpenMCSourceSpatial,
    OpenMCSourceEnergy
} from '../../common/openmc-state-schema';
import { SimulationProgress, SimulationStatusEvent, ValidationIssue } from '../../common/openmc-studio-protocol';
import { CSGBuilderWidget } from '../csg-builder/csg-builder-widget';
import { TallyConfiguratorWidget } from '../tally-configurator/tally-configurator-widget';
import { DAGMCEditorContribution } from '../dagmc-editor/dagmc-editor-contribution';

// Tab types for the dashboard
export type DashboardTab = 'settings' | 'materials' | 'tallies' | 'simulation';

@injectable()
export class SimulationDashboardWidget extends ReactWidget {
    static readonly ID = 'openmc-simulation-dashboard';
    static readonly LABEL = 'OpenMC Simulation Dashboard';

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    @inject(OpenMCStateManager)
    protected readonly stateManager!: OpenMCStateManager;

    @inject(OpenMCStudioService)
    protected readonly studioService!: OpenMCStudioService;

    @inject(OpenMCXMLGenerationService)
    protected readonly xmlService!: OpenMCXMLGenerationService;

    @inject(OpenMCSimulationRunner)
    protected readonly simulationRunner!: OpenMCSimulationRunner;

    @inject(FileDialogService)
    protected readonly fileDialogService!: FileDialogService;

    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    @inject(PreferenceService)
    protected readonly preferences!: PreferenceService;

    @inject(NukeCoreService)
    protected readonly nukeCoreService!: NukeCoreService;

    @inject(DAGMCEditorContribution)
    protected readonly dagmcEditorContribution!: DAGMCEditorContribution;

    private activeTab: DashboardTab = 'settings';
    private isRunning = false;
    private simulationProgress?: SimulationProgress;
    private validationIssues: ValidationIssue[] = [];
    private showNewMaterialForm = false;
    private editingMaterial?: OpenMCMaterial;
    private consoleOutput: { type: 'info' | 'error' | 'warn'; message: string; timestamp: Date }[] = [];
    private consoleMaximized = false;
    private consoleContentRef = React.createRef<HTMLDivElement>();
    private consolePanelRef = React.createRef<HTMLDivElement>();

    // Form state for new material
    private newMaterialName = '';
    private newMaterialDensity = 1.0;
    private newMaterialDensityUnit: OpenMCMaterial['densityUnit'] = 'g/cm3';
    private newMaterialNuclides: { name: string; fraction: number; fractionType: 'ao' | 'wo' }[] = [];
    private newMaterialIsDepletable = false;
    private newMaterialVolume?: number;
    private newMaterialTemperature?: number;
    private newMaterialThermalScattering: { name: string; fraction: number }[] = [];
    private newMaterialColor = '#4A90D9';

    // Material templates
    private readonly MATERIAL_TEMPLATES: { name: string; description: string; setup: () => void }[] = [
        {
            name: 'UO2 Fuel (4% enriched)',
            description: 'Uranium dioxide fuel with 4% U-235 enrichment',
            setup: () => {
                this.newMaterialName = 'UO2 Fuel';
                this.newMaterialDensity = 10.0;
                this.newMaterialDensityUnit = 'g/cm3';
                this.newMaterialNuclides = [
                    { name: 'U235', fraction: 0.04, fractionType: 'wo' },
                    { name: 'U238', fraction: 0.96, fractionType: 'wo' },
                    { name: 'O16', fraction: 2.0, fractionType: 'wo' }
                ];
                this.newMaterialIsDepletable = true;
                this.newMaterialColor = '#FF6B35';
            }
        },
        {
            name: 'Light Water (H2O)',
            description: 'Light water moderator with thermal scattering',
            setup: () => {
                this.newMaterialName = 'Water';
                this.newMaterialDensity = 1.0;
                this.newMaterialDensityUnit = 'g/cm3';
                this.newMaterialNuclides = [
                    { name: 'H1', fraction: 2.0, fractionType: 'ao' },
                    { name: 'O16', fraction: 1.0, fractionType: 'ao' }
                ];
                this.newMaterialThermalScattering = [{ name: 'c_H_in_H2O', fraction: 1.0 }];
                this.newMaterialColor = '#4ECDC4';
            }
        },
        {
            name: 'Heavy Water (D2O)',
            description: 'Heavy water moderator',
            setup: () => {
                this.newMaterialName = 'Heavy Water';
                this.newMaterialDensity = 1.1;
                this.newMaterialDensityUnit = 'g/cm3';
                this.newMaterialNuclides = [
                    { name: 'H2', fraction: 2.0, fractionType: 'ao' },
                    { name: 'O16', fraction: 1.0, fractionType: 'ao' }
                ];
                this.newMaterialThermalScattering = [{ name: 'c_D_in_D2O', fraction: 1.0 }];
                this.newMaterialColor = '#95E1D3';
            }
        },
        {
            name: 'Graphite',
            description: 'Graphite moderator/reflector',
            setup: () => {
                this.newMaterialName = 'Graphite';
                this.newMaterialDensity = 1.7;
                this.newMaterialDensityUnit = 'g/cm3';
                this.newMaterialNuclides = [
                    { name: 'C0', fraction: 1.0, fractionType: 'ao' }
                ];
                this.newMaterialThermalScattering = [{ name: 'c_Graphite', fraction: 1.0 }];
                this.newMaterialColor = '#2C3E50';
            }
        },
        {
            name: 'Stainless Steel 304',
            description: 'Common structural material',
            setup: () => {
                this.newMaterialName = 'SS304';
                this.newMaterialDensity = 8.0;
                this.newMaterialDensityUnit = 'g/cm3';
                this.newMaterialNuclides = [
                    { name: 'Fe56', fraction: 0.70, fractionType: 'wo' },
                    { name: 'Cr52', fraction: 0.20, fractionType: 'wo' },
                    { name: 'Ni58', fraction: 0.10, fractionType: 'wo' }
                ];
                this.newMaterialColor = '#95A5A6';
            }
        },
        {
            name: 'Boron Carbide (B4C)',
            description: 'Control rod material',
            setup: () => {
                this.newMaterialName = 'B4C';
                this.newMaterialDensity = 2.5;
                this.newMaterialDensityUnit = 'g/cm3';
                this.newMaterialNuclides = [
                    { name: 'B10', fraction: 4.0, fractionType: 'ao' },
                    { name: 'C0', fraction: 1.0, fractionType: 'ao' }
                ];
                this.newMaterialColor = '#8E44AD';
            }
        },
        {
            name: 'Air/Vacuum',
            description: 'Void material',
            setup: () => {
                this.newMaterialName = 'Air';
                this.newMaterialDensity = 0.001;
                this.newMaterialDensityUnit = 'g/cm3';
                this.newMaterialNuclides = [
                    { name: 'N14', fraction: 0.8, fractionType: 'ao' },
                    { name: 'O16', fraction: 0.2, fractionType: 'ao' }
                ];
                this.newMaterialColor = '#ECF0F1';
            }
        },
        {
            name: 'Helium (Coolant)',
            description: 'Helium gas coolant',
            setup: () => {
                this.newMaterialName = 'Helium';
                this.newMaterialDensity = 0.00018;
                this.newMaterialDensityUnit = 'g/cm3';
                this.newMaterialNuclides = [
                    { name: 'He4', fraction: 1.0, fractionType: 'ao' }
                ];
                this.newMaterialColor = '#F39C12';
            }
        }
    ];

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
        this.simulationRunner.onProgress(progress => {
            this.simulationProgress = progress;
            this.update();
        });

        this.simulationRunner.onStatusChange(event => {
            const wasRunning = this.isRunning;
            this.isRunning = event.status === 'running' || event.status === 'starting';
            
            // Log state change for debugging
            console.log(`[Simulation] Status: ${event.status}, isRunning: ${this.isRunning} (was: ${wasRunning})`);
            
            // Log status changes to console
            if (event.status === 'completed') {
                this.logToConsole('Simulation completed successfully');
            } else if (event.status === 'failed') {
                const errorMsg = event.result?.error || `Exit code: ${event.result?.exitCode}`;
                this.logToConsole(`Simulation failed: ${errorMsg}`, 'error');
                // Also log stderr if available
                if (event.result?.stderr) {
                    const stderrLines = event.result.stderr.split('\n').filter(l => l.trim());
                    if (stderrLines.length > 0) {
                        this.logToConsole('Stderr output:', 'error');
                        stderrLines.slice(0, 10).forEach(line => {
                            this.logToConsole(`  ${line}`, 'error');
                        });
                    }
                }
            } else if (event.status === 'cancelled') {
                this.logToConsole('Simulation cancelled');
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

    private updateTitle(): void {
        const state = this.stateManager.getState();
        const dirtyIndicator = this.stateManager.isDirty ? '● ' : '';
        this.title.label = `${dirtyIndicator}${state.metadata.name}`;
    }

    protected render(): React.ReactNode {
        const state = this.stateManager.getState();

        return (
            <div className='simulation-dashboard'>
                {this.renderHeader(state)}
                {this.renderTabs()}
                <div className='dashboard-content'>
                    {this.activeTab === 'settings' && this.renderSettingsTab(state)}
                    {this.activeTab === 'materials' && this.renderMaterialsTab(state)}
                    {this.activeTab === 'tallies' && this.renderTalliesTab(state)}
                    {this.activeTab === 'simulation' && this.renderSimulationTab(state)}
                </div>
            </div>
        );
    }

    private editingProjectName = false;
    private newProjectName = '';
    private newProjectDescription = '';

    private renderHeader(state: OpenMCState): React.ReactNode {
        return (
            <div className='dashboard-header'>
                <div className='project-info'>
                    {this.editingProjectName ? (
                        <div className='project-name-edit'>
                            <input
                                type='text'
                                className='project-name-input'
                                value={this.newProjectName}
                                onChange={e => {
                                    this.newProjectName = e.target.value;
                                    this.update();
                                }}
                                placeholder='Project name'
                                autoFocus
                            />
                            <input
                                type='text'
                                className='project-desc-input'
                                value={this.newProjectDescription}
                                onChange={e => {
                                    this.newProjectDescription = e.target.value;
                                    this.update();
                                }}
                                placeholder='Description (optional)'
                            />
                            <Tooltip content='Save' position='top'>
                                <button
                                    className='theia-button primary small'
                                    onClick={() => this.saveProjectName()}
                                >
                                    <i className='codicon codicon-check'></i>
                                </button>
                            </Tooltip>
                            <Tooltip content='Cancel' position='top'>
                                <button
                                    className='theia-button secondary small'
                                    onClick={() => {
                                        this.editingProjectName = false;
                                        this.update();
                                    }}
                                >
                                    <i className='codicon codicon-close'></i>
                                </button>
                            </Tooltip>
                        </div>
                    ) : (
                        <Tooltip content='Click to rename' position='bottom'>
                            <h2 onClick={() => this.startEditProjectName()}>
                                <i className='codicon codicon-symbol-method'></i>
                                {state.metadata.name}
                                <i className='codicon codicon-edit edit-icon'></i>
                            </h2>
                        </Tooltip>
                    )}
                    {state.metadata.description && !this.editingProjectName && (
                        <p className='project-description'>{state.metadata.description}</p>
                    )}
                </div>
                <div className='project-actions'>
                    <Tooltip content='New Project' position='bottom'>
                        <button
                            className='theia-button secondary'
                            onClick={() => this.newProject()}
                        >
                            <i className='codicon codicon-new-file'></i>
                        </button>
                    </Tooltip>
                    <Tooltip content='Open Project' position='bottom'>
                        <button
                            className='theia-button secondary'
                            onClick={() => this.openProject()}
                        >
                            <i className='codicon codicon-folder-opened'></i>
                        </button>
                    </Tooltip>
                    <Tooltip content='Save Project' position='bottom'>
                        <button
                            className='theia-button secondary'
                            onClick={() => this.saveProject()}
                        >
                            <i className='codicon codicon-save'></i>
                        </button>
                    </Tooltip>
                    <Tooltip content='Generate XML Files' position='bottom'>
                        <button
                            className='theia-button secondary'
                            onClick={() => this.generateXML()}
                        >
                            <i className='codicon codicon-file-code'></i>
                        </button>
                    </Tooltip>
                </div>
            </div>
        );
    }

    private renderTabs(): React.ReactNode {
        const tabs: { id: DashboardTab; label: string; icon: string }[] = [
            { id: 'settings', label: 'Settings', icon: 'codicon-settings' },
            { id: 'materials', label: 'Materials', icon: 'codicon-symbol-color' },
            { id: 'tallies', label: 'Tallies', icon: 'codicon-graph-line' },
            { id: 'simulation', label: 'Simulation', icon: 'codicon-play' }
        ];

        return (
            <div className='dashboard-tabs'>
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

    // ============================================================================
    // Settings Tab
    // ============================================================================

    private renderSettingsTab(state: OpenMCState): React.ReactNode {
        const { settings } = state;
        const runSettings = settings.run;

        return (
            <div className='settings-tab'>
                {/* DAGMC Mode Indicator */}
                {settings.dagmcFile && (
                    <div className='dagmc-mode-banner'>
                        <div className='dagmc-icon'><i className='codicon codicon-file-code'></i></div>
                        <div className='dagmc-info'>
                            <strong>DAGMC Geometry Active</strong>
                            <span>{settings.dagmcFile.split('/').pop()}</span>
                        </div>
                        <div className='dagmc-actions'>
                            <Tooltip content='Edit DAGMC geometry' position='bottom'>
                                <button
                                    className='dagmc-edit-btn'
                                    onClick={() => this.openDagmcEditor()}
                                >
                                    <i className='codicon codicon-edit'></i>
                                    Edit
                                </button>
                            </Tooltip>
                            <span className='dagmc-badge'>DAGMC Mode</span>
                        </div>
                    </div>
                )}
                
                {/* Quick Start Guide */}
                <div className='quick-start-guide'>
                    <h4><i className='codicon codicon-book'></i> Quick Start Guide</h4>
                    <div className='guide-cards'>
                        <div className='guide-card'>
                            <div className='guide-icon'><i className='codicon codicon-flame'></i></div>
                            <h5>Eigenvalue Mode</h5>
                            <p>For criticality calculations (k-effective). Use for reactors, critical assemblies.</p>
                            <code>Particles: 1000-10000<br/>Batches: 100-500</code>
                        </div>
                        <div className='guide-card'>
                            <div className='guide-icon'><i className='codicon codicon-target'></i></div>
                            <h5>Fixed Source</h5>
                            <p>For shielding, dose calculations. Neutrons from defined source only.</p>
                            <code>Particles: 10000+<br/>No inactive batches</code>
                        </div>
                        <div className='guide-card'>
                            <div className='guide-icon'><i className='codicon codicon-rocket'></i></div>
                            <h5>Getting Started</h5>
                            <p>Start with fewer particles for testing, increase for production runs.</p>
                            <code>Test: 100 particles<br/>Production: 10000+</code>
                        </div>
                    </div>
                </div>

                <div className='settings-section'>
                    <h3>
                        <i className='codicon codicon-run'></i>
                        Run Configuration
                    </h3>

                    <div className='form-group'>
                        <label>Run Mode</label>
                        <select
                            value={runSettings.mode}
                            onChange={e => this.updateRunMode(e.target.value as OpenMCRunSettings['mode'])}
                        >
                            <option value='eigenvalue'>Eigenvalue (Criticality)</option>
                            <option value='fixed source'>Fixed Source</option>
                            <option value='volume'>Volume Calculation</option>
                        </select>
                    </div>

                    {runSettings.mode === 'eigenvalue' && (
                        <>
                            <div className='form-row'>
                                <div className='form-group'>
                                    <label>Particles per Generation</label>
                                    <input
                                        type='number'
                                        min={1}
                                        value={runSettings.particles}
                                        onChange={e => this.updateSetting('run', {
                                            ...runSettings,
                                            particles: parseInt(e.target.value) || 1000
                                        })}
                                    />
                                </div>
                                <div className='form-group'>
                                    <label>Inactive Batches</label>
                                    <input
                                        type='number'
                                        min={0}
                                        value={runSettings.inactive}
                                        onChange={e => this.updateSetting('run', {
                                            ...runSettings,
                                            inactive: parseInt(e.target.value) || 0
                                        })}
                                    />
                                </div>
                                <div className='form-group'>
                                    <label>Active Batches</label>
                                    <input
                                        type='number'
                                        min={1}
                                        value={runSettings.batches}
                                        onChange={e => this.updateSetting('run', {
                                            ...runSettings,
                                            batches: parseInt(e.target.value) || 10
                                        })}
                                    />
                                </div>
                            </div>
                        </>
                    )}

                    {runSettings.mode === 'fixed source' && (
                        <div className='form-row'>
                            <div className='form-group'>
                                <label>Particles per Batch</label>
                                <input
                                    type='number'
                                    min={1}
                                    value={runSettings.particles}
                                    onChange={e => this.updateSetting('run', {
                                        ...runSettings,
                                        particles: parseInt(e.target.value) || 1000
                                    })}
                                />
                            </div>
                            <div className='form-group'>
                                <label>Batches</label>
                                <input
                                    type='number'
                                    min={1}
                                    value={runSettings.batches}
                                    onChange={e => this.updateSetting('run', {
                                        ...runSettings,
                                        batches: parseInt(e.target.value) || 10
                                    })}
                                />
                            </div>
                        </div>
                    )}
                </div>

                <div className='settings-section'>
                    <h3>
                        <i className='codicon codicon-source-control'></i>
                        Source Definition
                            <button
                                className='theia-button secondary small'
                                onClick={() => this.addSource()}
                            >
                                <i className='codicon codicon-add'></i> Add Source
                            </button>
                    </h3>

                    {settings.sources.length === 0 ? (
                        <div className='empty-state'>
                            <i className='codicon codicon-info'></i>
                            <p>No sources defined. {runSettings.mode === 'eigenvalue' && 'A default point source at origin will be used.'}</p>
                        </div>
                    ) : (
                        settings.sources.map((source, index) => (
                            <div key={index} className='source-card'>
                                <div className='source-header'>
                                    <span>Source {index + 1}</span>
                                    <Tooltip content='Remove Source' position='top'>
                                        <button
                                            className='theia-button secondary small'
                                            onClick={() => this.removeSource(index)}
                                        >
                                            <i className='codicon codicon-trash'></i>
                                        </button>
                                    </Tooltip>
                                </div>
                                {this.renderSourceEditor(source, index)}
                            </div>
                        ))
                    )}
                </div>

                <div className='settings-section'>
                    <h3>
                        <i className='codicon codicon-gear'></i>
                        Advanced Settings
                    </h3>

                    <div className='form-row'>
                        <div className='form-group'>
                            <label>Random Seed</label>
                            <input
                                type='number'
                                value={settings.seed || ''}
                                placeholder='Random'
                                onChange={e => this.updateSetting('seed', e.target.value ? parseInt(e.target.value) : undefined)}
                            />
                        </div>
                        <div className='form-group'>
                            <label>Threads</label>
                            <input
                                type='number'
                                min={1}
                                value={settings.threads || ''}
                                placeholder='Auto'
                                onChange={e => this.updateSetting('threads', e.target.value ? parseInt(e.target.value) : undefined)}
                            />
                        </div>
                    </div>

                    <div className='form-group checkbox'>
                        <label>
                            <input
                                type='checkbox'
                                checked={settings.photonTransport || false}
                                onChange={e => this.updateSetting('photonTransport', e.target.checked)}
                            />
                            Enable Photon Transport
                        </label>
                    </div>

                    <div className='form-group checkbox'>
                        <label>
                            <input
                                type='checkbox'
                                checked={settings.outputSummary !== false}
                                onChange={e => this.updateSetting('outputSummary', e.target.checked)}
                            />
                            Generate Summary File
                        </label>
                    </div>

                    <div className='form-row'>
                        <div className='form-group'>
                            <label>Source Rejection Fraction (0-1)</label>
                            <input
                                type='number'
                                min={0}
                                max={1}
                                step={0.01}
                                value={settings.sourceRejectionFraction ?? 0.0}
                                placeholder='0.0'
                                onChange={e => this.updateSetting('sourceRejectionFraction', e.target.value ? parseFloat(e.target.value) : undefined)}
                            />
                            <span className='form-hint'>
                                Lower values allow more source sites. Set to 0.0 to disable rejection.
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    private renderSourceEditor(source: OpenMCSource, index: number): React.ReactNode {
        const spatial = source.spatial as any;
        const snapActions: Record<string, { label: string; icon: string; action: () => void }[]> = {
            point: [
                { label: 'Geometry Center', icon: 'target', action: () => this.snapSourceToGeometryCenter(index) },
                { label: 'Sphere Center', icon: 'circle-outline', action: () => this.setSourceToSphereCenter(index) },
                { label: 'Cylinder Axis', icon: 'dash', action: () => this.setSourceToCylinderAxis(index) }
            ],
            box: [
                { label: 'Tight Fit', icon: 'target', action: () => this.snapSourceToGeometryBounds(index, 0) },
                { label: 'With Padding', icon: 'expand-all', action: () => this.snapSourceToGeometryBounds(index, 0.1) }
            ],
            sphere: [
                { label: 'Match Surface', icon: 'circle-outline', action: () => this.snapSourceToMatchSphere(index) },
                { label: 'Enclose All', icon: 'expand-all', action: () => this.snapSourceToEncloseGeometry(index) }
            ]
        };
        
        return (
            <div className='source-editor'>
                {/* Source Header */}
                <div className='source-header'>
                    <div className='source-type-select'>
                        <label>Spatial Distribution</label>
                        <select
                            value={source.spatial.type}
                            onChange={e => this.updateSourceSpatial(index, e.target.value as OpenMCSourceSpatial['type'])}
                        >
                            <option value='point'>Point</option>
                            <option value='box'>Box</option>
                            <option value='sphere'>Sphere</option>
                            <option value='cylinder'>Cylinder</option>
                        </select>
                    </div>
                    <button
                        className='theia-button secondary snap-main-btn'
                        onClick={() => this.snapSourceToGeometry(index)}
                    >
                        <i className='codicon codicon-target'></i>
                        <span>Snap to Geometry</span>
                    </button>
                </div>

                {/* Quick Snap Actions */}
                {snapActions[source.spatial.type] && (
                    <div className='source-quick-snaps'>
                        <span className='quick-snaps-label'>Quick Position:</span>
                        <div className='quick-snaps-buttons'>
                            {snapActions[source.spatial.type].map((btn, btnIdx) => (
                                <button
                                    key={btnIdx}
                                    className='theia-button secondary small'
                                    onClick={btn.action}
                                >
                                    <i className={`codicon codicon-${btn.icon}`}></i>
                                    {btn.label}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {source.spatial.type === 'point' && (
                    <div className='form-row'>
                        <div className='form-group'>
                            <label>X</label>
                            <input
                                type='number'
                                step='0.1'
                                value={spatial.origin?.[0] || 0}
                                onChange={e => this.updateSourceOrigin(index, 0, parseFloat(e.target.value))}
                            />
                        </div>
                        <div className='form-group'>
                            <label>Y</label>
                            <input
                                type='number'
                                step='0.1'
                                value={spatial.origin?.[1] || 0}
                                onChange={e => this.updateSourceOrigin(index, 1, parseFloat(e.target.value))}
                            />
                        </div>
                        <div className='form-group'>
                            <label>Z</label>
                            <input
                                type='number'
                                step='0.1'
                                value={spatial.origin?.[2] || 0}
                                onChange={e => this.updateSourceOrigin(index, 2, parseFloat(e.target.value))}
                            />
                        </div>
                    </div>
                )}

                {source.spatial.type === 'box' && (
                    <>
                        <div className='form-row'>
                            <div className='form-group'>
                                <label>Min X</label>
                                <input
                                    type='number'
                                    step='0.1'
                                    value={spatial.lowerLeft?.[0] ?? -5}
                                    onChange={e => this.updateSourceBoxBound(index, 'lowerLeft', 0, parseFloat(e.target.value))}
                                />
                            </div>
                            <div className='form-group'>
                                <label>Min Y</label>
                                <input
                                    type='number'
                                    step='0.1'
                                    value={spatial.lowerLeft?.[1] ?? -5}
                                    onChange={e => this.updateSourceBoxBound(index, 'lowerLeft', 1, parseFloat(e.target.value))}
                                />
                            </div>
                            <div className='form-group'>
                                <label>Min Z</label>
                                <input
                                    type='number'
                                    step='0.1'
                                    value={spatial.lowerLeft?.[2] ?? -5}
                                    onChange={e => this.updateSourceBoxBound(index, 'lowerLeft', 2, parseFloat(e.target.value))}
                                />
                            </div>
                        </div>
                        <div className='form-row'>
                            <div className='form-group'>
                                <label>Max X</label>
                                <input
                                    type='number'
                                    step='0.1'
                                    value={spatial.upperRight?.[0] ?? 5}
                                    onChange={e => this.updateSourceBoxBound(index, 'upperRight', 0, parseFloat(e.target.value))}
                                />
                            </div>
                            <div className='form-group'>
                                <label>Max Y</label>
                                <input
                                    type='number'
                                    step='0.1'
                                    value={spatial.upperRight?.[1] ?? 5}
                                    onChange={e => this.updateSourceBoxBound(index, 'upperRight', 1, parseFloat(e.target.value))}
                                />
                            </div>
                            <div className='form-group'>
                                <label>Max Z</label>
                                <input
                                    type='number'
                                    step='0.1'
                                    value={spatial.upperRight?.[2] ?? 5}
                                    onChange={e => this.updateSourceBoxBound(index, 'upperRight', 2, parseFloat(e.target.value))}
                                />
                            </div>
                        </div>
                    </>
                )}

                {source.spatial.type === 'sphere' && (
                    <>
                        <div className='form-row'>
                            <div className='form-group'>
                                <label>Center X</label>
                                <input
                                    type='number'
                                    step='0.1'
                                    value={spatial.center?.[0] || 0}
                                    onChange={e => this.updateSourceSphereCenter(index, 0, parseFloat(e.target.value))}
                                />
                            </div>
                            <div className='form-group'>
                                <label>Center Y</label>
                                <input
                                    type='number'
                                    step='0.1'
                                    value={spatial.center?.[1] || 0}
                                    onChange={e => this.updateSourceSphereCenter(index, 1, parseFloat(e.target.value))}
                                />
                            </div>
                            <div className='form-group'>
                                <label>Center Z</label>
                                <input
                                    type='number'
                                    step='0.1'
                                    value={spatial.center?.[2] || 0}
                                    onChange={e => this.updateSourceSphereCenter(index, 2, parseFloat(e.target.value))}
                                />
                            </div>
                            <div className='form-group'>
                                <label>Radius</label>
                                <input
                                    type='number'
                                    step='0.1'
                                    min={0}
                                    value={spatial.radius || 1}
                                    onChange={e => this.updateSourceSphereRadius(index, parseFloat(e.target.value))}
                                />
                            </div>
                        </div>
                    </>
                )}

                <div className='form-group'>
                    <label>Energy Distribution</label>
                    <select
                        value={source.energy.type}
                        onChange={e => this.updateSourceEnergy(index, e.target.value as OpenMCSourceEnergy['type'])}
                    >
                        <option value='discrete'>Discrete</option>
                        <option value='uniform'>Uniform</option>
                        <option value='maxwell'>Maxwell</option>
                        <option value='watt'>Watt</option>
                    </select>
                </div>

                {source.energy.type === 'discrete' && (
                    <div className='form-row'>
                        <div className='form-group'>
                            <label>Energy (eV)</label>
                            <input
                                type='number'
                                step='0.1'
                                value={(source.energy as any).energies?.[0] || 1.0}
                                onChange={e => this.updateSourceDiscreteEnergy(index, parseFloat(e.target.value))}
                            />
                        </div>
                    </div>
                )}

                {source.energy.type === 'uniform' && (
                    <div className='form-row'>
                        <div className='form-group'>
                            <label>Min Energy (eV)</label>
                            <input
                                type='number'
                                step='0.1'
                                value={(source.energy as any).min || 0}
                                onChange={e => this.updateSourceUniformEnergy(index, 'min', parseFloat(e.target.value))}
                            />
                        </div>
                        <div className='form-group'>
                            <label>Max Energy (eV)</label>
                            <input
                                type='number'
                                step='0.1'
                                value={(source.energy as any).max || 10}
                                onChange={e => this.updateSourceUniformEnergy(index, 'max', parseFloat(e.target.value))}
                            />
                        </div>
                    </div>
                )}

                <div className='form-row'>
                    <div className='form-group'>
                        <label>Particle Type</label>
                        <select
                            value={source.particle || 'neutron'}
                            onChange={e => this.updateSourceParticle(index, e.target.value as 'neutron' | 'photon')}
                        >
                            <option value='neutron'>Neutron</option>
                            <option value='photon'>Photon</option>
                        </select>
                    </div>
                    <div className='form-group'>
                        <label>Strength</label>
                        <input
                            type='number'
                            min={0}
                            value={source.strength || 1}
                            onChange={e => this.updateSourceStrength(index, parseFloat(e.target.value))}
                        />
                    </div>
                </div>
            </div>
        );
    }

    // ============================================================================
    // Materials Tab
    // ============================================================================

    private renderMaterialsTab(state: OpenMCState): React.ReactNode {
        // Get DAGMC materials from fileInfo if available
        const dagmcMaterials = state.settings.dagmcFile ? 
            (this.getDAGMCMaterialsFromState(state) || {}) : {};
        const hasDagmcMaterials = Object.keys(dagmcMaterials).length > 0;
        
        return (
            <div className='materials-tab'>
                {/* DAGMC Materials Section */}
                {hasDagmcMaterials && (
                    <div className='dagmc-materials-panel'>
                        <div className='dagmc-panel-header'>
                            <h4><i className='codicon codicon-file-code'></i> DAGMC Materials</h4>
                            <span className='dagmc-badge'>From {state.settings.dagmcFile?.split('/').pop()}</span>
                        </div>
                        <p className='dagmc-panel-description'>
                            These materials are defined in the DAGMC geometry file. 
                            You should create matching materials below for OpenMC to use.
                        </p>
                        <div className='dagmc-materials-grid'>
                            {Object.entries(dagmcMaterials).map(([name, data]) => (
                                <div key={name} className='dagmc-material-card'>
                                    <div className='dagmc-mat-name'>{name}</div>
                                    <div className='dagmc-mat-stats'>
                                        {data.volumeCount} volume{(data.volumeCount || 0) !== 1 ? 's' : ''}, {' '}
                                        {(data.totalTriangles || 0).toLocaleString()} triangles
                                    </div>
                                    {/* Check if matching material exists */}
                                    {state.materials.some(m => m.name.toLowerCase() === name.toLowerCase()) ? (
                                        <span className='dagmc-mat-status matched'>
                                            <i className='codicon codicon-check'></i> Matched
                                        </span>
                                    ) : (
                                        <span className='dagmc-mat-status missing'>
                                            <i className='codicon codicon-warning'></i> No match
                                        </span>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Instructions */}
                {!hasDagmcMaterials && (
                    <div className='instructions-panel'>
                        <h4><i className='codicon codicon-lightbulb'></i> How to Create Materials</h4>
                        <div className='instruction-steps'>
                            <div className='step'>
                                <span className='step-number'>1</span>
                                <span>Enter a name and density for your material</span>
                            </div>
                            <div className='step'>
                                <span className='step-number'>2</span>
                                <span>Add nuclides (e.g., U235, O16) with fractions</span>
                            </div>
                            <div className='step'>
                                <span className='step-number'>3</span>
                                <span>For depletion: Check "Depletable" and enter volume</span>
                            </div>
                            <div className='step'>
                                <span className='step-number'>4</span>
                                <span>For moderators: Add S(α,β) thermal scattering data</span>
                            </div>
                        </div>
                    </div>
                )}

                <div className='materials-toolbar'>
                    <button
                        className='theia-button primary'
                        onClick={() => {
                            this.showNewMaterialForm = true;
                            this.editingMaterial = undefined;
                            this.resetNewMaterialForm();
                            this.update();
                        }}
                    >
                        <i className='codicon codicon-add'></i> Add Material
                    </button>
                </div>

                {this.showNewMaterialForm && (
                    <div className='material-form-container'>
                        <h4>{this.editingMaterial ? 'Edit Material' : 'New Material'}</h4>
                        {this.renderMaterialForm()}
                    </div>
                )}

                <div className='materials-list'>
                    {state.materials.length === 0 && !hasDagmcMaterials ? (
                        <div className='empty-state'>
                            <i className='codicon codicon-info'></i>
                            <p>No materials defined. Click "Add Material" to create your first material.</p>
                        </div>
                    ) : state.materials.length === 0 && hasDagmcMaterials ? (
                        <div className='empty-state dagmc-info'>
                            <i className='codicon codicon-file-code'></i>
                            <p>No OpenMC materials defined yet.</p>
                            <p className='empty-hint'>DAGMC geometry has {Object.keys(dagmcMaterials).length} material(s). Create matching materials above.</p>
                        </div>
                    ) : (
                        state.materials.map(material => (
                            <div key={material.id} className='material-card' style={{ borderLeft: `4px solid ${material.color || '#4A90D9'}` }}>
                                <div className='material-card-header'>
                                    <div className='material-info'>
                                        <span className='material-id'>#{material.id}</span>
                                        <span className='material-name'>{material.name}</span>
                                        {material.isDepletable && (
                                            <Tooltip content='Depletable material' position='top'>
                                                <span className='depletable-badge'>
                                                    <i className='codicon codicon-history'></i>
                                                </span>
                                            </Tooltip>
                                        )}
                                        {material.thermalScattering && material.thermalScattering.length > 0 && (
                                            <Tooltip content='Has thermal scattering' position='top'>
                                                <span className='thermal-badge'>
                                                    <i className='codicon codicon-flame'></i>
                                                </span>
                                            </Tooltip>
                                        )}
                                    </div>
                                    <div className='material-actions'>
                                        <Tooltip content='Duplicate Material' position='top'>
                                            <button
                                                className='theia-button secondary small'
                                                onClick={() => this.duplicateMaterial(material)}
                                            >
                                                <i className='codicon codicon-copy'></i>
                                            </button>
                                        </Tooltip>
                                        <Tooltip content='Edit Material' position='top'>
                                            <button
                                                className='theia-button secondary small'
                                                onClick={() => this.editMaterial(material)}
                                            >
                                                <i className='codicon codicon-edit'></i>
                                            </button>
                                        </Tooltip>
                                        <Tooltip content='Delete Material' position='top'>
                                            <button
                                                className='theia-button secondary small danger'
                                                onClick={() => this.deleteMaterial(material.id)}
                                            >
                                                <i className='codicon codicon-trash'></i>
                                            </button>
                                        </Tooltip>
                                    </div>
                                </div>
                                <div className='material-card-body'>
                                    <div className='material-property'>
                                        <label>Density:</label>
                                        <span>{material.density.toFixed(4)} {material.densityUnit}</span>
                                    </div>
                                    <div className='material-property'>
                                        <label>Nuclides:</label>
                                        <span>{material.nuclides.length}</span>
                                    </div>
                                    {material.temperature && (
                                        <div className='material-property'>
                                            <label>Temperature:</label>
                                            <span>{material.temperature} K</span>
                                        </div>
                                    )}
                                </div>
                                <div className='material-nuclides-preview'>
                                    {material.nuclides.slice(0, 5).map(n => (
                                        <span key={n.name} className='nuclide-tag'>
                                            {n.name}: {n.fraction.toExponential(2)} {n.fractionType}
                                        </span>
                                    ))}
                                    {material.nuclides.length > 5 && (
                                        <span className='nuclide-tag more'>+{material.nuclides.length - 5} more</span>
                                    )}
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        );
    }

    private renderMaterialForm(): React.ReactNode {
        return (
            <div className='material-form'>
                {/* Template Selector */}
                {!this.editingMaterial && (
                    <div className='form-group template-selector'>
                        <label><i className='codicon codicon-symbol-snippet'></i> Start from Template (Optional)</label>
                        <select
                            value=''
                            onChange={e => {
                                const template = this.MATERIAL_TEMPLATES.find(t => t.name === e.target.value);
                                if (template) {
                                    template.setup();
                                    this.update();
                                }
                                e.target.value = '';
                            }}
                        >
                            <option value=''>Select a template...</option>
                            {this.MATERIAL_TEMPLATES.map(template => (
                                <option key={template.name} value={template.name}>
                                    {template.name} - {template.description}
                                </option>
                            ))}
                        </select>
                    </div>
                )}

                <div className='form-row'>
                    <div className='form-group'>
                        <label>Name</label>
                        <input
                            type='text'
                            value={this.newMaterialName}
                            onChange={e => {
                                this.newMaterialName = e.target.value;
                                this.update();
                            }}
                            placeholder='e.g., UO2 Fuel'
                        />
                    </div>
                    <div className='form-group color-picker-group'>
                        <label>Color <span className='color-value'>{this.newMaterialColor}</span></label>
                        <ColorPicker
                            value={this.newMaterialColor}
                            onChange={(color) => {
                                this.newMaterialColor = color;
                                this.update();
                            }}
                        />
                    </div>
                </div>

                <div className='form-row'>
                    <div className='form-group'>
                        <label>Density Unit</label>
                        <select
                            value={this.newMaterialDensityUnit}
                            onChange={e => {
                                this.newMaterialDensityUnit = e.target.value as OpenMCMaterial['densityUnit'];
                                this.update();
                            }}
                        >
                            <option value='g/cm3'>g/cm³</option>
                            <option value='kg/m3'>kg/m³</option>
                            <option value='atom/b-cm'>atom/b-cm</option>
                            <option value='sum'>Sum</option>
                        </select>
                    </div>
                </div>

                {this.newMaterialDensityUnit !== 'sum' && (
                    <div className='form-group'>
                        <label>Density</label>
                        <input
                            type='number'
                            step='0.01'
                            value={this.newMaterialDensity}
                            onChange={e => {
                                this.newMaterialDensity = parseFloat(e.target.value) || 0;
                                this.update();
                            }}
                        />
                    </div>
                )}

                {/* Depletable Material Options */}
                <div className='form-section-title'>Depletion Options</div>
                <div className='depletion-section'>
                    <div className='depletion-toggle'>
                        <label className='toggle-label'>
                            <input
                                type='checkbox'
                                checked={this.newMaterialIsDepletable}
                                onChange={e => {
                                    this.newMaterialIsDepletable = e.target.checked;
                                    this.update();
                                }}
                            />
                            <span className='toggle-text'>Depletable Material</span>
                        </label>
                        <span className='depletion-description'>
                            Enable for burnup/depletion calculations
                        </span>
                    </div>
                    {this.newMaterialIsDepletable && (
                        <div className='depletion-fields'>
                            <div className='form-group'>
                                <label>Volume (cm³) <span className='required'>*</span></label>
                                <input
                                    type='number'
                                    step='0.1'
                                    value={this.newMaterialVolume || ''}
                                    onChange={e => {
                                        this.newMaterialVolume = e.target.value ? parseFloat(e.target.value) : undefined;
                                        this.update();
                                    }}
                                    placeholder='Required for depletion'
                                />
                                <span className='form-hint'>Material volume for burnup calculations</span>
                            </div>
                        </div>
                    )}
                </div>

                <div className='form-row'>
                    <div className='form-group'>
                        <label>Temperature (K, optional)</label>
                        <input
                            type='number'
                            step='1'
                            value={this.newMaterialTemperature || ''}
                            onChange={e => {
                                this.newMaterialTemperature = e.target.value ? parseFloat(e.target.value) : undefined;
                                this.update();
                            }}
                            placeholder='e.g., 600'
                        />
                        <span className='form-hint'>For Doppler broadening</span>
                    </div>
                </div>

                {/* Thermal Scattering */}
                <div className='nuclides-section thermal-section'>
                    <h5>
                        <i className='codicon codicon-flame'></i>
                        Thermal Scattering (S(α,β))
                        <span className='optional-badge'>Optional</span>
                    </h5>
                    <span className='section-hint'>Add thermal scattering data for moderators like water, graphite</span>
                    {this.newMaterialThermalScattering.map((sab, index) => (
                        <div key={index} className='nuclide-row'>
                            <input
                                type='text'
                                placeholder='e.g., c_Graphite or h_H2O'
                                value={sab.name}
                                onChange={e => {
                                    this.newMaterialThermalScattering[index].name = e.target.value;
                                    this.update();
                                }}
                            />
                            <input
                                type='number'
                                step='0.1'
                                placeholder='Fraction'
                                value={sab.fraction}
                                onChange={e => {
                                    this.newMaterialThermalScattering[index].fraction = parseFloat(e.target.value) || 1.0;
                                    this.update();
                                }}
                            />
                            <Tooltip content='Remove' position='top'>
                                <button
                                    className='theia-button secondary small'
                                    onClick={() => {
                                        this.newMaterialThermalScattering.splice(index, 1);
                                        this.update();
                                    }}
                                >
                                    <i className='codicon codicon-trash'></i>
                                </button>
                            </Tooltip>
                        </div>
                    ))}
                    <Tooltip content='Add thermal scattering data' position='right'>
                        <button
                            className='theia-button secondary small'
                            onClick={() => {
                                this.newMaterialThermalScattering.push({ name: '', fraction: 1.0 });
                                this.update();
                            }}
                        >
                            <i className='codicon codicon-add'></i> Add S(α,β)
                        </button>
                    </Tooltip>
                </div>

                <div className='nuclides-section'>
                    <h5>Nuclides</h5>
                    {this.newMaterialNuclides.map((nuclide, index) => (
                        <div key={index} className='nuclide-row'>
                            <input
                                type='text'
                                placeholder='e.g., U235'
                                value={nuclide.name}
                                onChange={e => {
                                    this.newMaterialNuclides[index].name = e.target.value;
                                    this.update();
                                }}
                            />
                            <input
                                type='number'
                                step='0.0001'
                                placeholder='Fraction'
                                value={nuclide.fraction}
                                onChange={e => {
                                    this.newMaterialNuclides[index].fraction = parseFloat(e.target.value) || 0;
                                    this.update();
                                }}
                            />
                            <select
                                value={nuclide.fractionType}
                                onChange={e => {
                                    this.newMaterialNuclides[index].fractionType = e.target.value as 'ao' | 'wo';
                                    this.update();
                                }}
                            >
                                <option value='ao'>ao (atom)</option>
                                <option value='wo'>wo (weight)</option>
                            </select>
                            <Tooltip content='Remove Nuclide' position='top'>
                                <button
                                    className='theia-button secondary small'
                                    onClick={() => {
                                        this.newMaterialNuclides.splice(index, 1);
                                        this.update();
                                    }}
                                >
                                    <i className='codicon codicon-trash'></i>
                                </button>
                            </Tooltip>
                        </div>
                    ))}
                    <Tooltip content='Add Nuclide' position='right'>
                        <button
                            className='theia-button secondary small'
                            onClick={() => {
                                this.newMaterialNuclides.push({ name: '', fraction: 1.0, fractionType: 'ao' });
                                this.update();
                            }}
                        >
                            <i className='codicon codicon-add'></i> Add Nuclide
                        </button>
                    </Tooltip>
                </div>

                <div className='form-actions'>
                    <button
                        className='theia-button primary'
                        onClick={() => this.saveMaterial()}
                    >
                        {this.editingMaterial ? 'Update Material' : 'Create Material'}
                    </button>
                    <button
                        className='theia-button secondary'
                        onClick={() => {
                            this.showNewMaterialForm = false;
                            this.editingMaterial = undefined;
                            this.update();
                        }}
                    >
                        Cancel
                    </button>
                </div>
            </div>
        );
    }

    // ============================================================================
    // Tallies Tab
    // ============================================================================

    private renderTalliesTab(state: OpenMCState): React.ReactNode {
        const tallies = state.tallies || [];
        const meshes = state.meshes || [];

        return (
            <div className='tallies-tab'>
                <div className='instructions-panel'>
                    <h4><i className='codicon codicon-graph-line'></i> Tally Configuration</h4>
                    <p>Tallies allow you to record physical quantities during the simulation (flux, reaction rates, etc.).</p>
                    <button 
                        className='theia-button primary'
                        onClick={() => this.openTallyConfigurator()}
                    >
                        <i className='codicon codicon-edit'></i> Open Tally Configurator
                    </button>
                </div>

                <div className='summary-cards'>
                    <div className='summary-card'>
                        <div className='summary-value'>{tallies.length}</div>
                        <div className='summary-label'>Tallies Defined</div>
                    </div>
                    <div className='summary-card'>
                        <div className='summary-value'>{meshes.length}</div>
                        <div className='summary-label'>Meshes Defined</div>
                    </div>
                </div>

                {tallies.length > 0 && (
                    <div className='tallies-list-preview'>
                        <h4>Active Tallies</h4>
                        {tallies.map(tally => (
                            <div key={tally.id} className='tally-preview-card'>
                                <div className='tally-preview-header'>
                                    <strong>{tally.name || `Tally ${tally.id}`}</strong>
                                    <span className='tally-id'>#{tally.id}</span>
                                </div>
                                <div className='tally-preview-details'>
                                    <span>Scores: {tally.scores.join(', ')}</span>
                                    <span>Filters: {tally.filters.length}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    }

    private async openTallyConfigurator(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget(TallyConfiguratorWidget.ID);
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);
    }

    // ============================================================================
    // Simulation Tab
    // ============================================================================

    private renderSimulationTab(state: OpenMCState): React.ReactNode {
        return (
            <div className='simulation-tab'>
                {/* Quick Actions */}
                <div className='quick-actions-panel'>
                    <h4><i className='codicon codicon-rocket'></i> Setup Checklist</h4>
                    <div className='checklist-grid'>
                        {/* Materials Check - only counts OpenMC materials */}
                        {(() => {
                            const openMCMaterialCount = state.materials.length;
                            const dagmcMaterials = state.settings.dagmcInfo?.materials;
                            const dagmcMaterialCount = dagmcMaterials ? Object.keys(dagmcMaterials).length : 0;
                            const hasDagmcFile = !!state.settings.dagmcFile;
                            
                            // For DAGMC mode: materials are 'done' only when user has created OpenMC materials
                            // that match the DAGMC material names
                            let isMaterialsDone: boolean;
                            let statusText: string;
                            let statusClass: string;
                            
                            if (hasDagmcFile) {
                                if (dagmcMaterialCount === 0) {
                                    // No materials in DAGMC file - user needs to check their geometry export
                                    isMaterialsDone = openMCMaterialCount > 0;
                                    statusText = openMCMaterialCount > 0 
                                        ? `${openMCMaterialCount} defined` 
                                        : '0 defined (no DAGMC mats found)';
                                    statusClass = openMCMaterialCount > 0 ? 'done' : '';
                                } else if (openMCMaterialCount === 0) {
                                    // DAGMC has materials but user hasn't created OpenMC materials yet
                                    isMaterialsDone = false;
                                    statusText = `0 / ${dagmcMaterialCount} DAGMC materials configured`;
                                    statusClass = '';
                                } else {
                                    // Check if all DAGMC materials have matching OpenMC materials
                                    const openMCMaterialNames = new Set(state.materials.map(m => m.name.toLowerCase()));
                                    const missingDagmcMats = Object.keys(dagmcMaterials!).filter(
                                        dm => !openMCMaterialNames.has(dm.toLowerCase())
                                    );
                                    const definedCount = dagmcMaterialCount - missingDagmcMats.length;
                                    
                                    isMaterialsDone = missingDagmcMats.length === 0;
                                    statusText = `${definedCount} / ${dagmcMaterialCount} DAGMC materials defined`;
                                    statusClass = isMaterialsDone ? 'done' : 'partial';
                                }
                            } else {
                                // CSG mode
                                isMaterialsDone = openMCMaterialCount > 0;
                                statusText = openMCMaterialCount > 0 
                                    ? `${openMCMaterialCount} defined` 
                                    : 'Not configured';
                                statusClass = isMaterialsDone ? 'done' : '';
                            }
                            
                            return (
                                <div className={`checklist-item ${statusClass}`}>
                                    <div className='checklist-icon'>
                                        <i className={`codicon codicon-${isMaterialsDone ? 'check' : 'circle-outline'}`}></i>
                                    </div>
                                    <div className='checklist-content'>
                                        <span className='checklist-title'>Materials</span>
                                        <span className='checklist-status'>{statusText}</span>
                                    </div>
                                </div>
                            );
                        })()}
                        
                        {/* Geometry Check - includes both CSG and DAGMC geometry */}
                        {(() => {
                            const hasCSG = state.geometry.cells.length > 0;
                            const hasDagmc = !!state.settings.dagmcFile;
                            const dagmcVolumeCount = state.settings.dagmcInfo?.volumeCount || 0;
                            const isGeometryDone = hasCSG || hasDagmc;
                            
                            return (
                                <div className={`checklist-item ${isGeometryDone ? 'done' : ''}`}>
                                    <div className='checklist-icon'>
                                        <i className={`codicon codicon-${isGeometryDone ? 'check' : 'circle-outline'}`}></i>
                                    </div>
                                    <div className='checklist-content'>
                                        <span className='checklist-title'>Geometry</span>
                                        <span className='checklist-status'>
                                            {hasCSG 
                                                ? `${state.geometry.cells.length} cells, ${state.geometry.surfaces.length} surfaces`
                                                : hasDagmc 
                                                    ? `${dagmcVolumeCount} DAGMC volumes`
                                                    : 'Not configured'}
                                        </span>
                                    </div>
                                    {!hasDagmc && (
                                        state.geometry.cells.length === 0 ? (
                                            <Tooltip content='Create geometry using CSG Builder'>
                                                <button
                                                    className='theia-button primary small open-csg-btn'
                                                    onClick={() => this.openCSGBuilder()}
                                                >
                                                    <i className='codicon codicon-graph'></i> Open CSG Builder
                                                </button>
                                            </Tooltip>
                                        ) : (
                                            <Tooltip content='Edit geometry in CSG Builder'>
                                                <button
                                                    className='theia-button secondary small open-csg-btn'
                                                    onClick={() => this.openCSGBuilder()}
                                                >
                                                    <i className='codicon codicon-edit'></i> Edit
                                                </button>
                                            </Tooltip>
                                        )
                                    )}
                                    {hasDagmc && (
                                        <Tooltip content='View DAGMC geometry in CSG Builder'>
                                            <button
                                                className='theia-button secondary small open-csg-btn'
                                                onClick={() => this.openCSGBuilder()}
                                            >
                                                <i className='codicon codicon-file-code'></i> View
                                            </button>
                                        </Tooltip>
                                    )}
                                </div>
                            );
                        })()}
                        
                        <div className={`checklist-item ${state.settings.sources.length > 0 ? 'done' : ''}`}>
                            <div className='checklist-icon'>
                                <i className={`codicon codicon-${state.settings.sources.length > 0 ? 'check' : 'circle-outline'}`}></i>
                            </div>
                            <div className='checklist-content'>
                                <span className='checklist-title'>Source</span>
                                <span className='checklist-status'>
                                    {state.settings.sources.length > 0 ? `${state.settings.sources.length} defined` : 'Not configured'}
                                </span>
                            </div>
                        </div>
                        
                        {/* Tallies Check */}
                        {(() => {
                            const tallies = state.tallies || [];
                            const hasTallies = tallies.length > 0;
                            
                            return (
                                <div className={`checklist-item ${hasTallies ? 'done' : ''}`}>
                                    <div className='checklist-icon'>
                                        <i className={`codicon codicon-${hasTallies ? 'check' : 'circle-outline'}`}></i>
                                    </div>
                                    <div className='checklist-content'>
                                        <span className='checklist-title'>Tallies</span>
                                        <span className='checklist-status'>
                                            {hasTallies ? `${tallies.length} defined` : 'Optional - none configured'}
                                        </span>
                                    </div>
                                </div>
                            );
                        })()}
                    </div>
                </div>

                <div className='simulation-status'>
                    {this.isRunning ? (
                        <div className='status-running'>
                            <i className='codicon codicon-sync codicon-spin'></i>
                            <span>Simulation running...</span>
                        </div>
                    ) : (
                        <div className='status-ready'>
                            <i className='codicon codicon-check'></i>
                            <span>Ready to run</span>
                        </div>
                    )}
                </div>

                {this.simulationProgress && (
                    <div className='progress-section'>
                        <div className='progress-bar-container'>
                            <div
                                className='progress-bar'
                                style={{
                                    width: `${(this.simulationProgress.batch / this.simulationProgress.totalBatches) * 100}%`
                                }}
                            ></div>
                        </div>
                        <div className='progress-info'>
                            <span>Batch {this.simulationProgress.batch} / {this.simulationProgress.totalBatches}</span>
                            {this.simulationProgress.kEff !== undefined && (
                                <span>k-eff: {this.simulationProgress.kEff.toFixed(5)} ± {this.simulationProgress.kEffStd?.toFixed(5)}</span>
                            )}
                            <span>Elapsed: {this.formatTime(this.simulationProgress.elapsedTime)}</span>
                        </div>
                    </div>
                )}

                <div className='simulation-actions'>
                    <Tooltip content={this.isRunning ? 'Simulation is running' : 'Start the simulation'}>
                        <button
                            className='theia-button primary large'
                            onClick={() => this.runSimulation()}
                            disabled={this.isRunning}
                        >
                            <i className='codicon codicon-play'></i>
                            {this.isRunning ? 'Running...' : 'Run Simulation'}
                        </button>
                    </Tooltip>
                    <Tooltip content='Stop the simulation'>
                        <button
                            className='theia-button secondary large'
                            onClick={() => this.stopSimulation()}
                            disabled={!this.isRunning}
                        >
                            <i className='codicon codicon-stop'></i>
                            Stop
                        </button>
                    </Tooltip>
                    <Tooltip content='Validate model before running'>
                        <button
                            className='theia-button secondary large'
                            onClick={() => this.validateModel()}
                            disabled={this.isRunning}
                        >
                            <i className='codicon codicon-check-all'></i>
                            Validate
                        </button>
                    </Tooltip>
                </div>

                {this.validationIssues.length > 0 && (
                    <div className='validation-results'>
                        <h4>Validation Results</h4>
                        {this.validationIssues.map((issue, index) => (
                            <div key={index} className={`validation-issue ${issue.severity}`}>
                                <i className={`codicon codicon-${issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'info'}`}></i>
                                <span className='issue-category'>[{issue.category}]</span>
                                <span className='issue-message'>{issue.message}</span>
                            </div>
                        ))}
                    </div>
                )}

                <div className='simulation-info'>
                    <div className='info-header'>
                        <h4>Run Summary</h4>
                    </div>
                    <div className='info-grid'>
                        <div className='info-item'>
                            <label>Mode:</label>
                            <span>{state.settings.run.mode}</span>
                        </div>
                        {state.settings.run.mode !== 'volume' && (
                            <>
                                <div className='info-item'>
                                    <label>Particles:</label>
                                    <span>{(state.settings.run as OpenMCEigenvalueSettings | OpenMCFixedSourceSettings).particles.toLocaleString()}</span>
                                </div>
                                <div className='info-item'>
                                    <label>Batches:</label>
                                    <span>{(state.settings.run as OpenMCEigenvalueSettings | OpenMCFixedSourceSettings).batches}</span>
                                </div>
                            </>
                        )}
                        {state.settings.run.mode === 'eigenvalue' && (
                            <div className='info-item'>
                                <label>Inactive:</label>
                                <span>{(state.settings.run as OpenMCEigenvalueSettings).inactive}</span>
                            </div>
                        )}
                        <div className='info-item'>
                            <label>Materials:</label>
                            <span>{state.materials.length}</span>
                        </div>
                        <div className='info-item'>
                            <label>Cells:</label>
                            <span>{state.geometry.cells.length}</span>
                        </div>
                        <div className='info-item'>
                            <label>Tallies:</label>
                            <span>{state.tallies?.length || 0}</span>
                        </div>
                        <div className='info-item'>
                            <label>Meshes:</label>
                            <span>{state.meshes?.length || 0}</span>
                        </div>
                    </div>
                </div>

                {/* Geometry Summary - CSG */}
                {state.geometry.cells.length > 0 && !state.settings.dagmcFile && (
                    <div className='simulation-info'>
                        <div className='info-header'>
                            <h4>CSG Geometry Summary</h4>
                            <Tooltip content='Open CSG Builder to edit geometry'>
                                <button
                                    className='theia-button secondary small'
                                    onClick={() => this.openCSGBuilder()}
                                >
                                    <i className='codicon codicon-edit'></i> Edit in CSG Builder
                                </button>
                            </Tooltip>
                        </div>
                        <div className='info-grid'>
                            <div className='info-item'>
                                <label>Surfaces:</label>
                                <span>{state.geometry.surfaces.length}</span>
                            </div>
                            <div className='info-item'>
                                <label>Cells:</label>
                                <span>{state.geometry.cells.length}</span>
                            </div>
                            <div className='info-item'>
                                <label>Universes:</label>
                                <span>{state.geometry.universes.length}</span>
                            </div>
                            <div className='info-item'>
                                <label>Root Universe:</label>
                                <span>{state.geometry.rootUniverseId}</span>
                            </div>
                        </div>
                        {state.geometry.surfaces.length > 0 && (
                            <div className='info-footer'>
                                <i className='codicon codicon-info'></i>
                                <span>Surface types: {Array.from(new Set(state.geometry.surfaces.map(s => s.type))).join(', ')}</span>
                            </div>
                        )}
                    </div>
                )}

                {/* Geometry Summary - DAGMC */}
                {state.settings.dagmcFile && (
                    <div className='simulation-info dagmc-geometry'>
                        <div className='info-header'>
                            <h4><i className='codicon codicon-file-code'></i> DAGMC Geometry</h4>
                            <Tooltip content='Open CSG Builder to view DAGMC details'>
                                <button
                                    className='theia-button secondary small'
                                    onClick={() => this.openCSGBuilder()}
                                >
                                    <i className='codicon codicon-eye'></i> View Details
                                </button>
                            </Tooltip>
                        </div>
                        <div className='info-grid'>
                            <div className='info-item'>
                                <label>File:</label>
                                <Tooltip content={state.settings.dagmcFile} position='bottom'>
                                    <span className='dagmc-filename'>
                                        {state.settings.dagmcFile.split('/').pop()}
                                    </span>
                                </Tooltip>
                            </div>
                            <div className='info-item'>
                                <label>Type:</label>
                                <span>Faceted Mesh (DAGMC)</span>
                            </div>
                        </div>
                        <div className='info-footer dagmc-note'>
                            <i className='codicon codicon-info'></i>
                            <span>DAGMC geometry is used directly. No CSG surfaces/cells needed.</span>
                        </div>
                    </div>
                )}

                {/* Console Output */}
                <div ref={this.consolePanelRef} className={`console-panel ${this.consoleMaximized ? 'maximized' : ''}`}>
                    <div className='console-header'>
                        <h4><i className='codicon codicon-terminal'></i> Simulation Output</h4>
                        <div className='console-actions'>
                            <Tooltip content={this.consoleMaximized ? 'Restore' : 'Maximize'}>
                                <button
                                    className='theia-button secondary small'
                                    onClick={() => this.toggleConsoleMaximize()}
                                >
                                    <i className={`codicon codicon-${this.consoleMaximized ? 'collapse-all' : 'expand-all'}`}></i>
                                </button>
                            </Tooltip>
                            <Tooltip content='Clear console'>
                                <button
                                    className='theia-button secondary small'
                                    onClick={() => this.clearConsole()}
                                >
                                    <i className='codicon codicon-clear-all'></i>
                                </button>
                            </Tooltip>
                        </div>
                    </div>
                    <div className='console-content' ref={this.consoleContentRef}>
                        {this.consoleOutput.length === 0 ? (
                            <div className='console-empty'>No output yet. Run a simulation to see logs here.</div>
                        ) : (
                            this.consoleOutput.map((line, index) => (
                                <div key={index} className={`console-line ${line.type}`}>
                                    <span className='console-timestamp'>
                                        {line.timestamp.toLocaleTimeString()}
                                    </span>
                                    <span className='console-message'>{line.message}</span>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>
        );
    }

    // ============================================================================
    // Helper Methods
    // ============================================================================

    private formatTime(seconds: number): string {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    private logToConsole(message: string, type: 'info' | 'error' | 'warn' = 'info'): void {
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

    private clearConsole(): void {
        this.consoleOutput = [];
        this.update();
    }

    private toggleConsoleMaximize(): void {
        this.consoleMaximized = !this.consoleMaximized;
        this.update();
    }

    private resetNewMaterialForm(): void {
        this.newMaterialName = '';
        this.newMaterialDensity = 1.0;
        this.newMaterialDensityUnit = 'g/cm3';
        this.newMaterialNuclides = [];
        this.newMaterialIsDepletable = false;
        this.newMaterialVolume = undefined;
        this.newMaterialTemperature = undefined;
        this.newMaterialThermalScattering = [];
        this.newMaterialColor = '#4A90D9';
    }

    // ============================================================================
    // Action Handlers
    // ============================================================================

    private async openCSGBuilder(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget(CSGBuilderWidget.ID);
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);
    }

    private async openDagmcEditor(): Promise<void> {
        const state = this.stateManager.getState();
        if (state.settings.dagmcFile) {
            await this.dagmcEditorContribution.openDAGMCEditor(state.settings.dagmcFile);
        }
    }

    private async newProject(): Promise<void> {
        if (this.stateManager.isDirty) {
            // TODO: Show confirmation dialog
        }
        this.stateManager.reset();
        this.messageService.info('Created new OpenMC project');
    }

    private startEditProjectName(): void {
        this.editingProjectName = true;
        this.newProjectName = this.stateManager.getState().metadata.name;
        this.newProjectDescription = this.stateManager.getState().metadata.description || '';
        this.update();
    }

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

    private async saveProject(): Promise<void> {
        if (this.stateManager.projectPath) {
            await this.doSave(this.stateManager.projectPath);
        } else {
            await this.saveProjectAs();
        }
    }

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

    private async generateXML(): Promise<void> {
        const props: OpenFileDialogProps = {
            title: 'Select Output Directory for XML Files',
            canSelectFiles: false,
            canSelectFolders: true
        };

        const uri = await this.fileDialogService.showOpenDialog(props);
        if (!uri) {
            return;
        }

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
                    geometry: hasCSG || hasDagmc,  // Generate for DAGMC too (needs dagmc_universe reference)
                    tallies: state.tallies.length > 0,
                    plots: false
                }
            });

            if (result.success) {
                this.messageService.info(`Generated XML files: ${result.generatedFiles.map(f => f.split('/').pop()).join(', ')}`);
                this.logToConsole(`Generated: ${result.generatedFiles.map(f => f.split('/').pop()).join(', ')}`);
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

    async importXML(): Promise<void> {
        const props: OpenFileDialogProps = {
            title: 'Select Directory with XML Files',
            canSelectFiles: false,
            canSelectFolders: true
        };

        const uri = await this.fileDialogService.showOpenDialog(props);
        if (!uri) {
            return;
        }

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
                    result.warnings.forEach(w => this.logToConsole(`Warning: ${w}`, 'warn'));
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

    private async runSimulation(): Promise<void> {
        // First validate
        const validation = await this.validateModel();
        if (!validation.valid) {
            const errors = validation.issues.filter(i => i.severity === 'error').length;
            this.messageService.error(`Cannot run simulation: ${errors} validation errors. Check the Simulation tab for details.`);
            this.logToConsole(`Validation failed: ${errors} errors`, 'error');
            return;
        }

        // Check OpenMC availability first
        const openmcCheck = await this.studioService.checkOpenMCAvailability();
        if (!openmcCheck.available) {
            this.messageService.error(openmcCheck.error || 'OpenMC is not available');
            this.logToConsole(openmcCheck.error || 'OpenMC is not available', 'error');
            return;
        }

        // Select working directory
        const props: OpenFileDialogProps = {
            title: 'Select Working Directory for Simulation',
            canSelectFiles: false,
            canSelectFolders: true
        };

        const uri = await this.fileDialogService.showOpenDialog(props);
        if (!uri) {
            return;
        }

        this.logToConsole(`Starting simulation in ${uri.path.toString()}...`);
        this.logToConsole(`Using OpenMC: ${openmcCheck.version || 'unknown version'}`);

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
                    geometry: simHasCSG || simHasDagmc,  // Generate for DAGMC too (needs dagmc_universe reference)
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
            // Note: runSimulation returns immediately, completion handled by events
            this.simulationRunner.runSimulation({
                workingDirectory: uri.path.toString()
            });
            this.logToConsole('Simulation started (running in background)');
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Error running simulation: ${msg}`);
            this.logToConsole(`Error: ${msg}`, 'error');
        }
    }

    private async stopSimulation(): Promise<void> {
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

    private async validateModel(): Promise<{ valid: boolean; issues: ValidationIssue[] }> {
        this.logToConsole('Validating model...');
        const result = await this.stateManager.validate();
        this.validationIssues = result.issues;
        this.activeTab = 'simulation';
        
        const errorCount = result.issues.filter(i => i.severity === 'error').length;
        const warnCount = result.issues.filter(i => i.severity === 'warning').length;
        
        if (result.valid) {
            this.logToConsole('Validation passed');
        } else {
            this.logToConsole(`Validation failed: ${errorCount} errors, ${warnCount} warnings`, 'error');
        }
        
        result.issues.forEach(issue => {
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

    private updateRunMode(mode: OpenMCRunSettings['mode']): void {
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

    private updateSetting<K extends keyof OpenMCSettings>(key: K, value: OpenMCSettings[K]): void {
        this.stateManager.updateSettings({
            ...this.stateManager.getState().settings,
            [key]: value
        });
    }

    private addSource(): void {
        const newSource: OpenMCSource = {
            spatial: { type: 'point', origin: [0, 0, 0] },
            energy: { type: 'discrete', energies: [1e6] },
            strength: 1,
            particle: 'neutron'
        };
        const settings = this.stateManager.getState().settings;
        this.stateManager.updateSettings({
            ...settings,
            sources: [...settings.sources, newSource]
        });
    }

    private removeSource(index: number): void {
        const settings = this.stateManager.getState().settings;
        const newSources = [...settings.sources];
        newSources.splice(index, 1);
        this.stateManager.updateSettings({
            ...settings,
            sources: newSources
        });
    }

    private updateSourceSpatial(index: number, type: OpenMCSourceSpatial['type']): void {
        const settings = this.stateManager.getState().settings;
        const newSources = [...settings.sources];
        let spatial: OpenMCSourceSpatial;

        switch (type) {
            case 'point':
                spatial = { type: 'point', origin: [0, 0, 0] };
                break;
            case 'box':
                spatial = { type: 'box', lowerLeft: [-1, -1, -1], upperRight: [1, 1, 1] };
                break;
            case 'sphere':
                spatial = { type: 'sphere', center: [0, 0, 0], radius: 1 };
                break;
            case 'cylinder':
                spatial = { type: 'cylinder', center: [0, 0, 0], radius: 1, height: 2, axis: 'z' };
                break;
            default:
                spatial = { type: 'point', origin: [0, 0, 0] };
        }

        newSources[index] = { ...newSources[index], spatial };
        this.stateManager.updateSettings({ ...settings, sources: newSources });
    }

    private updateSourceOrigin(index: number, coord: number, value: number): void {
        const settings = this.stateManager.getState().settings;
        const newSources = [...settings.sources];
        const origin = [...((newSources[index].spatial as any).origin || [0, 0, 0])];
        origin[coord] = value;
        (newSources[index].spatial as any).origin = origin;
        this.stateManager.updateSettings({ ...settings, sources: newSources });
    }

    private updateSourceEnergy(index: number, type: OpenMCSourceEnergy['type']): void {
        const settings = this.stateManager.getState().settings;
        const newSources = [...settings.sources];
        let energy: OpenMCSourceEnergy;

        switch (type) {
            case 'discrete':
                energy = { type: 'discrete', energies: [1e6] };
                break;
            case 'uniform':
                energy = { type: 'uniform', min: 0, max: 10e6 };
                break;
            case 'maxwell':
                energy = { type: 'maxwell', temperature: 300 };
                break;
            case 'watt':
                energy = { type: 'watt', a: 0.965, b: 2.29 };
                break;
            default:
                energy = { type: 'discrete', energies: [1e6] };
        }

        newSources[index] = { ...newSources[index], energy };
        this.stateManager.updateSettings({ ...settings, sources: newSources });
    }

    private updateSourceDiscreteEnergy(index: number, value: number): void {
        const settings = this.stateManager.getState().settings;
        const newSources = [...settings.sources];
        (newSources[index].energy as any).energies = [value];
        this.stateManager.updateSettings({ ...settings, sources: newSources });
    }

    private updateSourceUniformEnergy(index: number, key: 'min' | 'max', value: number): void {
        const settings = this.stateManager.getState().settings;
        const newSources = [...settings.sources];
        (newSources[index].energy as any)[key] = value;
        this.stateManager.updateSettings({ ...settings, sources: newSources });
    }

    private updateSourceParticle(index: number, particle: 'neutron' | 'photon'): void {
        const settings = this.stateManager.getState().settings;
        const newSources = [...settings.sources];
        newSources[index] = { ...newSources[index], particle };
        this.stateManager.updateSettings({ ...settings, sources: newSources });
    }

    private updateSourceStrength(index: number, strength: number): void {
        const settings = this.stateManager.getState().settings;
        const newSources = [...settings.sources];
        newSources[index] = { ...newSources[index], strength };
        this.stateManager.updateSettings({ ...settings, sources: newSources });
    }

    private updateSourceBoxBound(index: number, bound: 'lowerLeft' | 'upperRight', coord: number, value: number): void {
        const settings = this.stateManager.getState().settings;
        const newSources = [...settings.sources];
        const bounds = [...((newSources[index].spatial as any)[bound] || [-5, -5, -5])];
        bounds[coord] = value;
        (newSources[index].spatial as any)[bound] = bounds;
        this.stateManager.updateSettings({ ...settings, sources: newSources });
    }

    private updateSourceSphereCenter(index: number, coord: number, value: number): void {
        const settings = this.stateManager.getState().settings;
        const newSources = [...settings.sources];
        const center = [...((newSources[index].spatial as any).center || [0, 0, 0])];
        center[coord] = value;
        (newSources[index].spatial as any).center = center;
        this.stateManager.updateSettings({ ...settings, sources: newSources });
    }

    private updateSourceSphereRadius(index: number, value: number): void {
        const settings = this.stateManager.getState().settings;
        const newSources = [...settings.sources];
        (newSources[index].spatial as any).radius = Math.max(0, value);
        this.stateManager.updateSettings({ ...settings, sources: newSources });
    }

    /**
     * Set point source to the center of the first sphere in geometry
     */
    private setSourceToSphereCenter(index: number): void {
        const state = this.stateManager.getState();
        const settings = state.settings;
        // Deep clone sources to avoid mutating original state
        const newSources = settings.sources.map((s, i) => 
            i === index 
                ? { ...s, spatial: { ...s.spatial } }
                : { ...s }
        );
        const source = newSources[index];
        
        // Find first sphere
        const sphere = state.geometry.surfaces.find(s => s.type === 'sphere');
        if (!sphere) {
            this.messageService.warn('No sphere found. Opening CSG Builder...');
            this.openCSGBuilder();
            return;
        }
        
        const c = sphere.coefficients as any;
        const x0 = c.x0 !== undefined ? c.x0 : (Array.isArray(c) ? c[0] : 0);
        const y0 = c.y0 !== undefined ? c.y0 : (Array.isArray(c) ? c[1] : 0);
        const z0 = c.z0 !== undefined ? c.z0 : (Array.isArray(c) ? c[2] : 0);
        
        if (x0 === undefined || y0 === undefined || z0 === undefined) {
            this.messageService.error('Could not read sphere center coordinates');
            return;
        }
        
        (source.spatial as any).origin = [x0, y0, z0];
        this.stateManager.updateSettings({ ...settings, sources: newSources });
        this.messageService.info(`Source ${index + 1} set to sphere center: (${x0}, ${y0}, ${z0})`);
        this.logToConsole(`Source ${index + 1} positioned at sphere center (${x0}, ${y0}, ${z0})`);
    }

    /**
     * Snap source to geometry bounds - analyzes geometry surfaces to find bounding box
     */
    private snapSourceToGeometry(index: number): void {
        const state = this.stateManager.getState();
        const settings = state.settings;
        // Deep clone sources to avoid mutating original state
        const newSources = settings.sources.map((s, i) => 
            i === index 
                ? { ...s, spatial: { ...s.spatial } }
                : { ...s }
        );
        const source = newSources[index];
        
        // Debug: log geometry info
        console.log('[SnapToGeometry] Geometry info:', {
            surfaces: state.geometry.surfaces.length,
            cells: state.geometry.cells.length,
            surfaceTypes: state.geometry.surfaces.map(s => s.type),
            firstSurface: state.geometry.surfaces[0] ? {
                id: state.geometry.surfaces[0].id,
                type: state.geometry.surfaces[0].type,
                coeffs: state.geometry.surfaces[0].coefficients
            } : null
        });
        
        // Calculate bounds from surfaces
        const bounds = this.calculateGeometryBounds(state);
        
        if (!bounds) {
            this.messageService.warn('No geometry defined. Open CSG Builder to create geometry?');
            this.logToConsole('No geometry found. Open CSG Builder to create geometry.', 'error');
            // Open CSG builder automatically
            this.openCSGBuilder();
            return;
        }
        
        // Update source based on its type
        const spatial = source.spatial as any;
        
        console.log(`[SnapToGeometry] Source type: ${spatial.type}, current bounds:`, {
            lowerLeft: spatial.lowerLeft,
            upperRight: spatial.upperRight,
            origin: spatial.origin,
            center: spatial.center,
            radius: spatial.radius
        });
        
        if (spatial.type === 'point') {
            // Set point to center of geometry
            spatial.origin = [
                (bounds.min[0] + bounds.max[0]) / 2,
                (bounds.min[1] + bounds.max[1]) / 2,
                (bounds.min[2] + bounds.max[2]) / 2
            ];
            this.messageService.info(`Source ${index + 1} set to geometry center: (${spatial.origin.map((v: number) => v.toFixed(2)).join(', ')})`);
        } else if (spatial.type === 'box') {
            // Set box to geometry bounds with 10% padding
            const padding = 0.1;
            const size = [
                bounds.max[0] - bounds.min[0],
                bounds.max[1] - bounds.min[1],
                bounds.max[2] - bounds.min[2]
            ];
            spatial.lowerLeft = [
                bounds.min[0] - size[0] * padding,
                bounds.min[1] - size[1] * padding,
                bounds.min[2] - size[2] * padding
            ];
            spatial.upperRight = [
                bounds.max[0] + size[0] * padding,
                bounds.max[1] + size[1] * padding,
                bounds.max[2] + size[2] * padding
            ];
            this.messageService.info(`Source ${index + 1} box set to geometry bounds with padding`);
            
            // Warn if geometry has complex regions
            if (state.geometry.cells.some(c => c.regionString && (c.regionString.includes('-') || c.regionString.includes('|')))) {
                this.logToConsole('Note: Geometry has complex regions. Box source may include areas outside cells.', 'warn');
                this.logToConsole('Tip: If simulation fails with "Too few source sites", try using a Point source at the geometry center instead.', 'warn');
            }
        } else if (spatial.type === 'sphere') {
            // Set sphere to enclose geometry
            const center = [
                (bounds.min[0] + bounds.max[0]) / 2,
                (bounds.min[1] + bounds.max[1]) / 2,
                (bounds.min[2] + bounds.max[2]) / 2
            ];
            const radius = Math.sqrt(
                Math.pow(bounds.max[0] - center[0], 2) +
                Math.pow(bounds.max[1] - center[1], 2) +
                Math.pow(bounds.max[2] - center[2], 2)
            ) * 1.2; // 20% padding
            spatial.center = center;
            spatial.radius = radius;
            this.messageService.info(`Source ${index + 1} sphere set to enclose geometry (radius: ${radius.toFixed(2)})`);
        }
        
        this.stateManager.updateSettings({ ...settings, sources: newSources });
        this.logToConsole(`Source ${index + 1} snapped to geometry bounds`);
        this.logToConsole(`  New bounds: lowerLeft=[${spatial.lowerLeft?.join(', ')}], upperRight=[${spatial.upperRight?.join(', ')}]`);
        
        // Force immediate update
        this.update();
    }

    /**
     * Snap point source to geometry center
     */
    private snapSourceToGeometryCenter(index: number): void {
        const state = this.stateManager.getState();
        const bounds = this.calculateGeometryBounds(state);
        
        if (!bounds) {
            this.messageService.warn('No geometry defined. Opening CSG Builder...');
            this.openCSGBuilder();
            return;
        }
        
        const settings = state.settings;
        // Deep clone sources to avoid mutating original state
        const newSources = settings.sources.map((s, i) => 
            i === index 
                ? { ...s, spatial: { ...s.spatial } }
                : { ...s }
        );
        const source = newSources[index];
        
        (source.spatial as any).origin = [
            (bounds.min[0] + bounds.max[0]) / 2,
            (bounds.min[1] + bounds.max[1]) / 2,
            (bounds.min[2] + bounds.max[2]) / 2
        ];
        
        this.stateManager.updateSettings({ ...settings, sources: newSources });
        this.messageService.info(`Source ${index + 1} set to geometry center`);
        this.logToConsole(`Source ${index + 1} positioned at geometry center (${(source.spatial as any).origin.join(', ')})`);
    }

    /**
     * Snap box source to geometry bounds with custom padding
     */
    private snapSourceToGeometryBounds(index: number, padding: number): void {
        const state = this.stateManager.getState();
        const bounds = this.calculateGeometryBounds(state);
        
        if (!bounds) {
            this.messageService.warn('No geometry defined. Opening CSG Builder...');
            this.openCSGBuilder();
            return;
        }
        
        const settings = state.settings;
        // Deep clone sources to avoid mutating original state
        const newSources = settings.sources.map((s, i) => 
            i === index 
                ? { ...s, spatial: { ...s.spatial } }
                : { ...s }
        );
        const source = newSources[index];
        
        const size = [
            bounds.max[0] - bounds.min[0],
            bounds.max[1] - bounds.min[1],
            bounds.max[2] - bounds.min[2]
        ];
        
        (source.spatial as any).lowerLeft = [
            bounds.min[0] - size[0] * padding,
            bounds.min[1] - size[1] * padding,
            bounds.min[2] - size[2] * padding
        ];
        (source.spatial as any).upperRight = [
            bounds.max[0] + size[0] * padding,
            bounds.max[1] + size[1] * padding,
            bounds.max[2] + size[2] * padding
        ];
        
        this.stateManager.updateSettings({ ...settings, sources: newSources });
        const paddingText = padding > 0 ? `with ${(padding * 100).toFixed(0)}% padding` : 'tight fit';
        this.messageService.info(`Source ${index + 1} box set to ${paddingText}`);
        this.logToConsole(`Source ${index + 1} box set to geometry bounds (${paddingText})`);
    }

    /**
     * Snap sphere source to match first geometry sphere
     */
    private snapSourceToMatchSphere(index: number): void {
        const state = this.stateManager.getState();
        const sphere = state.geometry.surfaces.find(s => s.type === 'sphere');
        
        if (!sphere) {
            this.messageService.warn('No sphere found. Opening CSG Builder...');
            this.openCSGBuilder();
            return;
        }
        
        const settings = state.settings;
        // Deep clone sources to avoid mutating original state
        const newSources = settings.sources.map((s, i) => 
            i === index 
                ? { ...s, spatial: { ...s.spatial } }
                : { ...s }
        );
        const source = newSources[index];
        
        const c = sphere.coefficients as any;
        const x0 = c.x0 !== undefined ? c.x0 : (Array.isArray(c) ? c[0] : 0);
        const y0 = c.y0 !== undefined ? c.y0 : (Array.isArray(c) ? c[1] : 0);
        const z0 = c.z0 !== undefined ? c.z0 : (Array.isArray(c) ? c[2] : 0);
        const r = c.r !== undefined ? c.r : (Array.isArray(c) ? c[3] : 1);
        
        (source.spatial as any).center = [x0, y0, z0];
        (source.spatial as any).radius = r;
        
        this.stateManager.updateSettings({ ...settings, sources: newSources });
        this.messageService.info(`Source ${index + 1} matched to sphere surface`);
        this.logToConsole(`Source ${index + 1} matched to sphere at (${x0}, ${y0}, ${z0}), radius ${r}`);
    }

    /**
     * Snap sphere source to enclose all geometry
     */
    private snapSourceToEncloseGeometry(index: number): void {
        const state = this.stateManager.getState();
        const bounds = this.calculateGeometryBounds(state);
        
        if (!bounds) {
            this.messageService.warn('No geometry defined. Opening CSG Builder...');
            this.openCSGBuilder();
            return;
        }
        
        const settings = state.settings;
        // Deep clone sources to avoid mutating original state
        const newSources = settings.sources.map((s, i) => 
            i === index 
                ? { ...s, spatial: { ...s.spatial } }
                : { ...s }
        );
        const source = newSources[index];
        
        const center = [
            (bounds.min[0] + bounds.max[0]) / 2,
            (bounds.min[1] + bounds.max[1]) / 2,
            (bounds.min[2] + bounds.max[2]) / 2
        ];
        const radius = Math.sqrt(
            Math.pow(bounds.max[0] - center[0], 2) +
            Math.pow(bounds.max[1] - center[1], 2) +
            Math.pow(bounds.max[2] - center[2], 2)
        ) * 1.2; // 20% padding
        
        (source.spatial as any).center = center;
        (source.spatial as any).radius = radius;
        
        this.stateManager.updateSettings({ ...settings, sources: newSources });
        this.messageService.info(`Source ${index + 1} sphere encloses all geometry`);
        this.logToConsole(`Source ${index + 1} sphere set to enclose geometry (radius: ${radius.toFixed(2)})`);
    }

    /**
     * Set point source to first cylinder axis
     */
    private setSourceToCylinderAxis(index: number): void {
        const state = this.stateManager.getState();
        const settings = state.settings;
        // Deep clone sources to avoid mutating original state
        const newSources = settings.sources.map((s, i) => 
            i === index 
                ? { ...s, spatial: { ...s.spatial } }
                : { ...s }
        );
        const source = newSources[index];
        
        // Find first cylinder
        const cylinder = state.geometry.surfaces.find(s => 
            s.type === 'z-cylinder' || s.type === 'y-cylinder' || s.type === 'x-cylinder'
        );
        
        if (!cylinder) {
            this.messageService.warn('No cylinder found. Opening CSG Builder...');
            this.openCSGBuilder();
            return;
        }
        
        const c = cylinder.coefficients as any;
        const getValue = (key: string, idx: number) => c[key] !== undefined ? c[key] : (Array.isArray(c) ? c[idx] : 0);
        
        let x0 = 0, y0 = 0, z0 = 0;
        
        if (cylinder.type === 'z-cylinder') {
            x0 = getValue('x0', 0);
            y0 = getValue('y0', 1);
            z0 = 0;
        } else if (cylinder.type === 'y-cylinder') {
            x0 = getValue('x0', 0);
            y0 = 0;
            z0 = getValue('z0', 2);
        } else if (cylinder.type === 'x-cylinder') {
            x0 = 0;
            y0 = getValue('y0', 1);
            z0 = getValue('z0', 2);
        }
        
        (source.spatial as any).origin = [x0, y0, z0];
        this.stateManager.updateSettings({ ...settings, sources: newSources });
        this.messageService.info(`Source ${index + 1} set to ${cylinder.type} axis: (${x0}, ${y0}, ${z0})`);
        this.logToConsole(`Source ${index + 1} positioned at ${cylinder.type} axis (${x0}, ${y0}, ${z0})`);
    }
    
    /**
     * Calculate bounding box from geometry surfaces
     */
    private calculateGeometryBounds(state: OpenMCState): { min: number[]; max: number[] } | null {
        // First check for DAGMC geometry bounds
        if (state.settings.dagmcInfo?.boundingBox) {
            console.log('[SnapToGeometry] Using DAGMC bounds:', state.settings.dagmcInfo.boundingBox);
            return {
                min: state.settings.dagmcInfo.boundingBox.min,
                max: state.settings.dagmcInfo.boundingBox.max
            };
        }
        
        if (state.geometry.surfaces.length === 0) {
            console.log('[SnapToGeometry] No surfaces found');
            return null;
        }
        
        console.log(`[SnapToGeometry] Calculating bounds from ${state.geometry.surfaces.length} surfaces`);
        
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let validSurfaceCount = 0;
        
        for (const surface of state.geometry.surfaces) {
            const c = surface.coefficients as any;
            if (!c) {
                console.log(`[SnapToGeometry] Surface ${surface.id}: no coefficients`);
                continue;
            }
            
            // Handle both object format (new) and array format (old)
            const getValue = (key: string, index: number): number | undefined => {
                if (c[key] !== undefined) return c[key];
                if (Array.isArray(c) && c.length > index) return c[index];
                return undefined;
            };
            
            switch (surface.type) {
                case 'sphere': {
                    // Sphere: x0, y0, z0, r
                    const x0 = getValue('x0', 0), y0 = getValue('y0', 1), z0 = getValue('z0', 2), r = getValue('r', 3);
                    if (x0 !== undefined && y0 !== undefined && z0 !== undefined && r !== undefined) {
                        minX = Math.min(minX, x0 - r);
                        minY = Math.min(minY, y0 - r);
                        minZ = Math.min(minZ, z0 - r);
                        maxX = Math.max(maxX, x0 + r);
                        maxY = Math.max(maxY, y0 + r);
                        maxZ = Math.max(maxZ, z0 + r);
                        validSurfaceCount++;
                    }
                    break;
                }
                    
                case 'x-plane': {
                    // x - x0 = 0
                    const x0 = getValue('x0', 0);
                    if (x0 !== undefined) {
                        minX = Math.min(minX, x0);
                        maxX = Math.max(maxX, x0);
                        validSurfaceCount++;
                    }
                    break;
                }
                    
                case 'y-plane': {
                    // y - y0 = 0
                    const y0 = getValue('y0', 0);
                    if (y0 !== undefined) {
                        minY = Math.min(minY, y0);
                        maxY = Math.max(maxY, y0);
                        validSurfaceCount++;
                    }
                    break;
                }
                    
                case 'z-plane': {
                    // z - z0 = 0
                    const z0 = getValue('z0', 0);
                    if (z0 !== undefined) {
                        minZ = Math.min(minZ, z0);
                        maxZ = Math.max(maxZ, z0);
                        validSurfaceCount++;
                    }
                    break;
                }
                    
                case 'x-cylinder': {
                    // (y-y0)^2 + (z-z0)^2 = r^2
                    const y0 = getValue('y0', 0), z0 = getValue('z0', 1), r = getValue('r', 2);
                    if (y0 !== undefined && z0 !== undefined && r !== undefined) {
                        minY = Math.min(minY, y0 - r);
                        minZ = Math.min(minZ, z0 - r);
                        maxY = Math.max(maxY, y0 + r);
                        maxZ = Math.max(maxZ, z0 + r);
                        validSurfaceCount++;
                    }
                    break;
                }
                    
                case 'y-cylinder': {
                    // (x-x0)^2 + (z-z0)^2 = r^2
                    const x0 = getValue('x0', 0), z0 = getValue('z0', 1), r = getValue('r', 2);
                    if (x0 !== undefined && z0 !== undefined && r !== undefined) {
                        minX = Math.min(minX, x0 - r);
                        minZ = Math.min(minZ, z0 - r);
                        maxX = Math.max(maxX, x0 + r);
                        maxZ = Math.max(maxZ, z0 + r);
                        validSurfaceCount++;
                    }
                    break;
                }
                    
                case 'z-cylinder': {
                    // (x-x0)^2 + (y-y0)^2 = r^2
                    const x0 = getValue('x0', 0), y0 = getValue('y0', 1), r = getValue('r', 2);
                    if (x0 !== undefined && y0 !== undefined && r !== undefined) {
                        minX = Math.min(minX, x0 - r);
                        minY = Math.min(minY, y0 - r);
                        maxX = Math.max(maxX, x0 + r);
                        maxY = Math.max(maxY, y0 + r);
                        validSurfaceCount++;
                    }
                    break;
                }
                
                case 'x-cone':
                case 'y-cone':
                case 'z-cone': {
                    // Cone: x0, y0, z0, r2 (squared radius)
                    const x0 = getValue('x0', 0), y0 = getValue('y0', 1), z0 = getValue('z0', 2), r2 = getValue('r2', 3);
                    if (x0 !== undefined && y0 !== undefined && z0 !== undefined && r2 !== undefined) {
                        const r = Math.sqrt(Math.abs(r2));
                        minX = Math.min(minX, x0 - r);
                        minY = Math.min(minY, y0 - r);
                        minZ = Math.min(minZ, z0 - r);
                        maxX = Math.max(maxX, x0 + r);
                        maxY = Math.max(maxY, y0 + r);
                        maxZ = Math.max(maxZ, z0 + r);
                        validSurfaceCount++;
                    }
                    break;
                }
                    
                default:
                    console.log(`[SnapToGeometry] Unknown surface type: ${surface.type}`);
            }
        }
        
        console.log(`[SnapToGeometry] Valid surfaces: ${validSurfaceCount}, Bounds: X[${minX}, ${maxX}], Y[${minY}, ${maxY}], Z[${minZ}, ${maxZ}]`);
        
        // If no valid bounds found, return null
        if (minX === Infinity || minY === Infinity || minZ === Infinity) {
            console.log('[SnapToGeometry] No valid bounds could be calculated');
            return null;
        }
        
        // Add some default padding if bounds are zero in any dimension
        if (maxX - minX < 0.001) { maxX += 1; minX -= 1; }
        if (maxY - minY < 0.001) { maxY += 1; minY -= 1; }
        if (maxZ - minZ < 0.001) { maxZ += 1; minZ -= 1; }
        
        return {
            min: [minX, minY, minZ],
            max: [maxX, maxY, maxZ]
        };
    }

    // ============================================================================
    // Material Handlers
    // ============================================================================

    private editMaterial(material: OpenMCMaterial): void {
        this.editingMaterial = material;
        this.newMaterialName = material.name;
        this.newMaterialDensity = material.density;
        this.newMaterialDensityUnit = material.densityUnit;
        this.newMaterialNuclides = [...material.nuclides.map(n => ({ ...n }))];
        this.newMaterialIsDepletable = material.isDepletable || false;
        this.newMaterialVolume = material.volume;
        this.newMaterialTemperature = material.temperature;
        this.newMaterialThermalScattering = material.thermalScattering?.map(s => ({ ...s })) || [];
        this.newMaterialColor = material.color || '#4A90D9';
        this.showNewMaterialForm = true;
        this.update();
    }

    private getDAGMCMaterialsFromState(state: OpenMCState): Record<string, { volumeCount: number; totalTriangles: number }> | undefined {
        // Get DAGMC info from settings (set by CSGBuilder when importing DAGMC file)
        const dagmcInfo = state.settings.dagmcInfo;
        if (dagmcInfo?.materials) {
            return dagmcInfo.materials;
        }
        return undefined;
    }

    private duplicateMaterial(material: OpenMCMaterial): void {
        this.editingMaterial = undefined;
        this.newMaterialName = `${material.name} (Copy)`;
        this.newMaterialDensity = material.density;
        this.newMaterialDensityUnit = material.densityUnit;
        this.newMaterialNuclides = [...material.nuclides.map(n => ({ ...n }))];
        this.newMaterialIsDepletable = material.isDepletable || false;
        this.newMaterialVolume = material.volume;
        this.newMaterialTemperature = material.temperature;
        this.newMaterialThermalScattering = material.thermalScattering?.map(s => ({ ...s })) || [];
        this.newMaterialColor = material.color || '#4A90D9';
        this.showNewMaterialForm = true;
        this.update();
        this.messageService.info('Edit the duplicated material and click Create');
    }

    private deleteMaterial(id: number): void {
        this.stateManager.removeMaterial(id);
        this.messageService.info('Material deleted');
    }

    private saveMaterial(): void {
        if (!this.newMaterialName.trim()) {
            this.messageService.error('Material name is required');
            return;
        }

        if (this.newMaterialNuclides.length === 0) {
            this.messageService.error('At least one nuclide is required');
            return;
        }

        // Filter out empty nuclides
        const validNuclides = this.newMaterialNuclides.filter(n => n.name.trim() !== '');
        if (validNuclides.length === 0) {
            this.messageService.error('At least one valid nuclide is required');
            return;
        }

        // Validate depletable material has volume
        if (this.newMaterialIsDepletable && !this.newMaterialVolume) {
            this.messageService.error('Depletable materials require a volume');
            return;
        }

        const material: OpenMCMaterial = {
            id: this.editingMaterial?.id || this.stateManager.getNextMaterialId(),
            name: this.newMaterialName.trim(),
            density: this.newMaterialDensity,
            densityUnit: this.newMaterialDensityUnit,
            nuclides: validNuclides.map(n => ({
                name: n.name.trim(),
                fraction: n.fraction,
                fractionType: n.fractionType
            })),
            thermalScattering: this.newMaterialThermalScattering
                .filter(sab => sab.name.trim() !== '')
                .map(sab => ({
                    name: sab.name.trim(),
                    fraction: sab.fraction
                })),
            isDepletable: this.newMaterialIsDepletable,
            volume: this.newMaterialVolume,
            temperature: this.newMaterialTemperature,
            color: this.newMaterialColor
        };

        if (this.editingMaterial) {
            this.stateManager.updateMaterial(this.editingMaterial.id, material);
            this.messageService.info('Material updated');
        } else {
            this.stateManager.addMaterial(material);
            this.messageService.info('Material created');
        }

        this.showNewMaterialForm = false;
        this.editingMaterial = undefined;
        this.resetNewMaterialForm();
    }
}
