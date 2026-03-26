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
import { WidgetManager, ApplicationShell } from '@theia/core/lib/browser';
import { FileDialogService, SaveFileDialogProps, OpenFileDialogProps } from '@theia/filesystem/lib/browser';

import { OpenMCStateManager } from '../openmc-state-manager';
import { OpenMCStudioService } from '../openmc-studio-service';
import { OpenMCXMLGenerationService } from '../xml-generator/xml-generation-service';
import { OpenMCSimulationRunner } from './simulation-runner';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components/tooltip';
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
import { SimulationProgress, ValidationIssue } from '../../common/openmc-studio-protocol';

// Tab types for the dashboard
export type DashboardTab = 'settings' | 'materials' | 'simulation';

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

    private activeTab: DashboardTab = 'settings';
    private isRunning = false;
    private simulationProgress?: SimulationProgress;
    private validationIssues: ValidationIssue[] = [];
    private showNewMaterialForm = false;
    private editingMaterial?: OpenMCMaterial;

    // Form state for new material
    private newMaterialName = '';
    private newMaterialDensity = 1.0;
    private newMaterialDensityUnit: OpenMCMaterial['densityUnit'] = 'g/cm3';
    private newMaterialNuclides: { name: string; fraction: number; fractionType: 'ao' | 'wo' }[] = [];

    @postConstruct()
    protected init(): void {
        this.id = SimulationDashboardWidget.ID;
        this.title.label = SimulationDashboardWidget.LABEL;
        this.title.caption = SimulationDashboardWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-dashboard';

        // Listen to state changes
        this.stateManager.onStateChange(() => this.update());
        this.stateManager.onDirtyChange(() => this.updateTitle());

        // Listen to simulation progress
        this.simulationRunner.onProgress(progress => {
            this.simulationProgress = progress;
            this.update();
        });

        this.simulationRunner.onStatusChange(event => {
            this.isRunning = event.status === 'running' || event.status === 'starting';
            if (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled') {
                this.simulationProgress = undefined;
            }
            this.update();
        });

        this.updateTitle();
        this.update();
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
                    {this.activeTab === 'simulation' && this.renderSimulationTab(state)}
                </div>
            </div>
        );
    }

    private renderHeader(state: OpenMCState): React.ReactNode {
        return (
            <div className='dashboard-header'>
                <div className='project-info'>
                    <h2>
                        <i className='codicon codicon-symbol-method'></i>
                        {state.metadata.name}
                    </h2>
                    {state.metadata.description && (
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
                </div>
            </div>
        );
    }

    private renderSourceEditor(source: OpenMCSource, index: number): React.ReactNode {
        return (
            <div className='source-editor'>
                <div className='form-group'>
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

                {source.spatial.type === 'point' && (
                    <div className='form-row'>
                        <div className='form-group'>
                            <label>X</label>
                            <input
                                type='number'
                                step='0.1'
                                value={(source.spatial as any).origin?.[0] || 0}
                                onChange={e => this.updateSourceOrigin(index, 0, parseFloat(e.target.value))}
                            />
                        </div>
                        <div className='form-group'>
                            <label>Y</label>
                            <input
                                type='number'
                                step='0.1'
                                value={(source.spatial as any).origin?.[1] || 0}
                                onChange={e => this.updateSourceOrigin(index, 1, parseFloat(e.target.value))}
                            />
                        </div>
                        <div className='form-group'>
                            <label>Z</label>
                            <input
                                type='number'
                                step='0.1'
                                value={(source.spatial as any).origin?.[2] || 0}
                                onChange={e => this.updateSourceOrigin(index, 2, parseFloat(e.target.value))}
                            />
                        </div>
                    </div>
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
        return (
            <div className='materials-tab'>
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
                    {state.materials.length === 0 ? (
                        <div className='empty-state'>
                            <i className='codicon codicon-info'></i>
                            <p>No materials defined. Add materials to use in your geometry.</p>
                        </div>
                    ) : (
                        state.materials.map(material => (
                            <div key={material.id} className='material-card'>
                                <div className='material-card-header'>
                                    <div className='material-info'>
                                        <span className='material-id'>#{material.id}</span>
                                        <span className='material-name'>{material.name}</span>
                                    </div>
                                    <div className='material-actions'>
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
                                                className='theia-button secondary small'
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
                    <button
                        className='theia-button secondary small'
                        onClick={() => {
                            this.newMaterialNuclides.push({ name: '', fraction: 1.0, fractionType: 'ao' });
                            this.update();
                        }}
                    >
                        <i className='codicon codicon-add'></i> Add Nuclide
                    </button>
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
    // Simulation Tab
    // ============================================================================

    private renderSimulationTab(state: OpenMCState): React.ReactNode {
        return (
            <div className='simulation-tab'>
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
                    <button
                        className='theia-button primary large'
                        onClick={() => this.runSimulation()}
                        disabled={this.isRunning}
                    >
                        <i className='codicon codicon-play'></i>
                        {this.isRunning ? 'Running...' : 'Run Simulation'}
                    </button>
                    <button
                        className='theia-button secondary large'
                        onClick={() => this.stopSimulation()}
                        disabled={!this.isRunning}
                    >
                        <i className='codicon codicon-stop'></i>
                        Stop
                    </button>
                    <button
                        className='theia-button secondary large'
                        onClick={() => this.validateModel()}
                        disabled={this.isRunning}
                    >
                        <i className='codicon codicon-check'></i>
                        Validate
                    </button>
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
                    <h4>Run Summary</h4>
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

    private resetNewMaterialForm(): void {
        this.newMaterialName = '';
        this.newMaterialDensity = 1.0;
        this.newMaterialDensityUnit = 'g/cm3';
        this.newMaterialNuclides = [];
    }

    // ============================================================================
    // Action Handlers
    // ============================================================================

    private async newProject(): Promise<void> {
        if (this.stateManager.isDirty) {
            // TODO: Show confirmation dialog
        }
        this.stateManager.reset();
        this.messageService.info('Created new OpenMC project');
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

        try {
            const result = await this.xmlService.generateXML({
                state: this.stateManager.getState(),
                outputDirectory: uri.path.toString(),
                files: {
                    materials: true,
                    settings: true,
                    geometry: this.stateManager.getState().geometry.cells.length > 0,
                    tallies: this.stateManager.getState().tallies.length > 0,
                    plots: false
                }
            });

            if (result.success) {
                this.messageService.info(`Generated XML files: ${result.generatedFiles.map(f => f.split('/').pop()).join(', ')}`);
            } else {
                this.messageService.error(`Failed to generate XML: ${result.error}`);
            }
        } catch (error) {
            this.messageService.error(`Error generating XML: ${error}`);
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
                this.messageService.info(`Imported XML files with ${result.warnings?.length || 0} warnings`);
                
                if (result.warnings && result.warnings.length > 0) {
                    console.warn('[OpenMC Studio] Import warnings:', result.warnings);
                }
            } else {
                this.messageService.error(`Failed to import XML: ${result.errors.join(', ')}`);
            }
        } catch (error) {
            this.messageService.error(`Error importing XML: ${error}`);
        }
    }

    private async runSimulation(): Promise<void> {
        // First validate
        const validation = await this.validateModel();
        if (!validation.valid) {
            const errors = validation.issues.filter(i => i.severity === 'error').length;
            this.messageService.error(`Cannot run simulation: ${errors} validation errors. Check the Simulation tab for details.`);
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

        try {
            // Generate XML first
            const xmlResult = await this.xmlService.generateXML({
                state: this.stateManager.getState(),
                outputDirectory: uri.path.toString(),
                files: {
                    materials: true,
                    settings: true,
                    geometry: this.stateManager.getState().geometry.cells.length > 0,
                    tallies: this.stateManager.getState().tallies.length > 0,
                    plots: false
                }
            });

            if (!xmlResult.success) {
                this.messageService.error(`Failed to generate XML: ${xmlResult.error}`);
                return;
            }

            // Run simulation
            await this.simulationRunner.runSimulation({
                workingDirectory: uri.path.toString()
            });

            this.messageService.info('Simulation started');
        } catch (error) {
            this.messageService.error(`Error running simulation: ${error}`);
        }
    }

    private async stopSimulation(): Promise<void> {
        await this.simulationRunner.stopSimulation();
        this.messageService.info('Simulation stopped');
    }

    private async validateModel(): Promise<{ valid: boolean; issues: ValidationIssue[] }> {
        const result = await this.stateManager.validate();
        this.validationIssues = result.issues;
        this.activeTab = 'simulation';
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

    // ============================================================================
    // Material Handlers
    // ============================================================================

    private editMaterial(material: OpenMCMaterial): void {
        this.editingMaterial = material;
        this.newMaterialName = material.name;
        this.newMaterialDensity = material.density;
        this.newMaterialDensityUnit = material.densityUnit;
        this.newMaterialNuclides = [...material.nuclides.map(n => ({ ...n }))];
        this.showNewMaterialForm = true;
        this.update();
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
            thermalScattering: this.editingMaterial?.thermalScattering || []
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
