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
import { ReactWidget } from '@theia/core/lib/browser';
import { OpenMCStateManager } from '../openmc-state-manager';
import { OpenMCTally, OpenMCMesh } from '../../common/openmc-state-schema';
import { MeshPanel } from './components/mesh-panel';
import { MeshEditor } from './components/mesh-editor';
import { TallyList } from './components/tally-list';
import { TallyEditor } from './components/tally-editor';

interface TallyConfiguratorState {
    selectedTallyId?: number;
    selectedMeshId?: number;
    activeTab: 'tallies' | 'meshes';
    editingTally?: OpenMCTally;
    editingMesh?: OpenMCMesh;
}

@injectable()
export class TallyConfiguratorWidget extends ReactWidget {
    static readonly ID = 'openmc-tally-configurator';
    static readonly LABEL = 'OpenMC Tally Configurator';

    @inject(OpenMCStateManager)
    protected readonly stateManager: OpenMCStateManager;

    protected state: TallyConfiguratorState = {
        activeTab: 'tallies'
    };

    @postConstruct()
    protected init(): void {
        this.id = TallyConfiguratorWidget.ID;
        this.title.label = TallyConfiguratorWidget.LABEL;
        this.title.caption = TallyConfiguratorWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-graph-line';
        
        this.toDispose.push(this.stateManager.onStateChange(() => this.update()));
        this.update();
    }

    protected render(): React.ReactNode {
        return (
            <div className='tally-configurator tally-configurator-container'>
                {this.renderHeader()}
                {this.renderTabs()}
                <div className='tally-configurator-content'>
                    {this.state.activeTab === 'tallies' ? this.renderTalliesTab() : this.renderMeshesTab()}
                </div>
            </div>
        );
    }

    private renderHeader(): React.ReactNode {
        const state = this.stateManager.getState();
        const tallies = state.tallies || [];
        const meshes = state.meshes || [];
        const totalFilters = tallies.reduce((sum, tally) => sum + tally.filters.length, 0);
        
        return (
            <div className='tally-configurator-header'>
                <div className='header-info'>
                    <h2>
                        <i className='codicon codicon-graph-line'></i>
                        Tally & Mesh Configurator
                    </h2>
                    <p className='header-description'>
                        Define simulation outputs (tallies) and spatial grids (meshes) for collecting radiation transport data
                    </p>
                </div>
                <div className='header-stats'>
                    <div className='stat-item'>
                        <span className='stat-value'>{tallies.length}</span>
                        <span className='stat-label'>Tallies</span>
                    </div>
                    <div className='stat-item'>
                        <span className='stat-value'>{meshes.length}</span>
                        <span className='stat-label'>Meshes</span>
                    </div>
                    <div className='stat-item'>
                        <span className='stat-value'>{totalFilters}</span>
                        <span className='stat-label'>Filters</span>
                    </div>
                </div>
            </div>
        );
    }

    private renderTabs(): React.ReactNode {
        const tabs = [
            { id: 'tallies', label: 'Tallies', icon: 'codicon-graph-line' },
            { id: 'meshes', label: 'Meshes', icon: 'codicon-table' }
        ];
        
        return (
            <div className='tally-configurator-tabs'>
                {tabs.map(tab => (
                    <button
                        key={tab.id}
                        className={`tab-button ${this.state.activeTab === tab.id ? 'active' : ''}`}
                        onClick={() => this.setState({ activeTab: tab.id as 'tallies' | 'meshes' })}
                    >
                        <i className={`codicon ${tab.icon}`}></i>
                        {tab.label}
                    </button>
                ))}
            </div>
        );
    }

    protected renderTalliesTab(): React.ReactNode {
        const state = this.stateManager.getState();
        const tallies = state.tallies || [];
        const meshes = state.meshes || [];
        const selectedTally = tallies.find(t => t.id === this.state.selectedTallyId);

        return (
            <div className='tallies-tab-container'>
                <div className='left-panel'>
                    <TallyList 
                        tallies={tallies}
                        selectedTallyId={this.state.selectedTallyId}
                        onSelectTally={(id) => this.setState({ selectedTallyId: id })}
                        onAddTally={() => this.addNewTally()}
                        onDeleteTally={(id) => this.stateManager.removeTally(id)}
                    />
                    <div className='quick-add-panel'>
                        <h4>Templates</h4>
                        <div className='template-buttons'>
                            <button onClick={() => this.addTemplateTally('meshFlux')} disabled={meshes.length === 0}>Mesh Flux</button>
                            <button onClick={() => this.addTemplateTally('cellFission')}>Cell Fission</button>
                            <button onClick={() => this.addTemplateTally('surfaceCurrent')}>Surface Current</button>
                            <button onClick={() => this.addTemplateTally('activation')}>Activation</button>
                            <button onClick={() => this.addTemplateTally('heating')}>Heating</button>
                        </div>
                    </div>
                </div>
                <div className='tally-editor-panel'>
                    {selectedTally ? (
                        <TallyEditor 
                            tally={selectedTally}
                            meshes={meshes}
                            onUpdate={(updates) => this.stateManager.updateTally(selectedTally.id, updates)}
                        />
                    ) : (
                        <div className='placeholder-message'>
                            Select a tally to edit or add a new one.
                        </div>
                    )}
                </div>
            </div>
        );
    }

    protected renderMeshesTab(): React.ReactNode {
        const meshes = this.stateManager.getState().meshes || [];
        const selectedMesh = meshes.find(m => m.id === this.state.selectedMeshId);
        const dagmcInfo = this.stateManager.getState().settings.dagmcInfo;

        return (
            <div className='meshes-tab-container'>
                <div className='left-panel'>
                    <MeshPanel 
                        meshes={meshes}
                        selectedMeshId={this.state.selectedMeshId}
                        onSelectMesh={(id) => this.setState({ selectedMeshId: id })}
                        onAddMesh={() => this.addNewMesh()}
                        onDeleteMesh={(id) => this.stateManager.removeMesh(id)}
                    />
                </div>
                <div className='mesh-editor-panel'>
                    {selectedMesh ? (
                        <MeshEditor 
                            mesh={selectedMesh}
                            dagmcBoundingBox={dagmcInfo?.boundingBox}
                            onUpdate={(updates) => this.stateManager.updateMesh(selectedMesh.id, updates)}
                        />
                    ) : (
                        <div className='placeholder-message'>
                            Select a mesh to edit or add a new one.
                        </div>
                    )}
                </div>
            </div>
        );
    }

    protected setState(newState: Partial<TallyConfiguratorState>): void {
        this.state = { ...this.state, ...newState };
        this.update();
    }

    protected addNewTally(): void {
        const nextId = this.stateManager.getNextTallyId();
        const newTally: OpenMCTally = {
            id: nextId,
            name: `Tally ${nextId}`,
            scores: [],
            nuclides: ['total'],
            filters: []
        };
        this.stateManager.addTally(newTally);
        this.setState({ selectedTallyId: nextId, editingTally: newTally });
    }

    protected addNewMesh(): void {
        const nextId = this.stateManager.getNextMeshId();
        const newMesh: OpenMCMesh = {
            id: nextId,
            name: `Mesh ${nextId}`,
            type: 'regular',
            dimension: [10, 10, 10],
            lowerLeft: [-10, -10, -10],
            upperRight: [10, 10, 10]
        };
        this.stateManager.addMesh(newMesh);
        this.setState({ selectedMeshId: nextId, editingMesh: newMesh });
    }

    protected addTemplateTally(template: 'meshFlux' | 'cellFission' | 'surfaceCurrent' | 'activation' | 'heating'): void {
        const nextId = this.stateManager.getNextTallyId();
        const meshes = this.stateManager.getState().meshes || [];
        let newTally: OpenMCTally;

        switch (template) {
            case 'meshFlux':
                newTally = {
                    id: nextId,
                    name: `Mesh Flux Tally`,
                    scores: ['flux'],
                    nuclides: ['total'],
                    filters: [{ type: 'mesh', meshId: meshes.length > 0 ? meshes[0].id : 0, bins: [meshes.length > 0 ? meshes[0].id : 0] }]
                };
                break;
            case 'cellFission':
                newTally = {
                    id: nextId,
                    name: `Cell Fission Rate`,
                    scores: ['fission'],
                    nuclides: ['total'],
                    filters: [{ type: 'cell', bins: [1] }]
                };
                break;
            case 'surfaceCurrent':
                newTally = {
                    id: nextId,
                    name: `Surface Current`,
                    scores: ['current'],
                    nuclides: ['total'],
                    filters: [{ type: 'surface', bins: [1] }]
                };
                break;
            case 'activation':
                newTally = {
                    id: nextId,
                    name: `Activation Tally`,
                    scores: ['activation'],
                    nuclides: ['total'],
                    filters: [{ type: 'energy', bins: [0, 2e7] }]
                };
                break;
            case 'heating':
                newTally = {
                    id: nextId,
                    name: `Heating Tally`,
                    scores: ['heating'],
                    nuclides: ['total'],
                    filters: []
                };
                break;
        }

        this.stateManager.addTally(newTally);
        this.setState({ selectedTallyId: nextId, editingTally: newTally });
    }
}
