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
 * DAGMC Editor Widget
 * 
 * Visual editor for DAGMC faceted geometry files using pydagmc.
 * Features:
 * - View volumes with material assignments
 * - Reassign materials to volumes
 * - Group management (create/edit groups)
 * - Volume/surface properties inspection
 * 
 * @module openmc-studio/browser
 */

import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { MessageService } from '@theia/core/lib/common/message-service';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { FileDialogService, OpenFileDialogProps } from '@theia/filesystem/lib/browser';
import { OpenMCStateManager } from '../openmc-state-manager';
import { OpenMCStudioService } from '../openmc-studio-service';
import { NukeCoreService } from 'nuke-core/lib/common';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { DAGMCInfo, DAGMCVolume } from '../../common/openmc-state-schema';
import { OpenMCStudioBackendService } from '../../common/openmc-studio-protocol';

// Import from nuke-visualizer for 3D preview
import { VisualizerWidget } from 'nuke-visualizer/lib/browser/visualizer-widget';
import { WidgetManager, ApplicationShell } from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';

// Internal types for DAGMC editor
interface DAGMCVolumeExtended extends Omit<DAGMCVolume, 'material'> {
    material?: string;
    numTriangles: number;
    surfaceArea?: number;
    volume?: number;
}

interface DAGMCGroup {
    name: string;
    type: 'material' | 'boundary' | 'other';
    volumeCount: number;
    volumes: number[];
}

interface DAGMCModelData {
    filePath: string;
    fileName: string;
    volumeCount: number;
    surfaceCount: number;
    vertices: number;
    materials: Record<string, { volumeCount: number; volumes: number[] }>;
    volumes: DAGMCVolumeExtended[];
    groups: DAGMCGroup[];
    boundingBox: {
        min: [number, number, number];
        max: [number, number, number];
    };
}

type EditorTab = 'volumes' | 'materials' | 'groups' | 'properties';

@injectable()
export class DAGMCEditorWidget extends ReactWidget {
    static readonly ID = 'openmc-dagmc-editor';
    static readonly LABEL = 'DAGMC Editor';

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    @inject(OpenMCStateManager)
    protected readonly stateManager!: OpenMCStateManager;

    @inject(OpenMCStudioService)
    protected readonly studioService!: OpenMCStudioService;

    @inject(FileDialogService)
    protected readonly fileDialogService!: FileDialogService;

    @inject(NukeCoreService)
    protected readonly nukeCoreService!: NukeCoreService;

    @inject(OpenMCStudioBackendService)
    protected readonly backendService!: OpenMCStudioBackendService;

    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    private activeTab: EditorTab = 'volumes';
    private filterType: 'all' | 'assigned' | 'unassigned' | 'high-poly' = 'all';
    private modelData?: DAGMCModelData;
    private selectedVolumeId?: number;
    private isLoading = false;
    private error?: string;
    private searchQuery = '';

    // Editing state
    private editingMaterial: { volumeId: number; newMaterial: string } | null = null;
    private newGroupName = '';
    private showCreateGroup = false;

    @postConstruct()
    protected init(): void {
        this.id = DAGMCEditorWidget.ID;
        this.title.label = DAGMCEditorWidget.LABEL;
        this.title.caption = DAGMCEditorWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-file-code';

        // Listen to state changes
        this.stateManager.onStateChange(() => {
            this.checkForDagmcFile();
            this.update();
        });
        this.stateManager.onStateReload(() => {
            this.checkForDagmcFile();
            this.update();
        });

        this.checkForDagmcFile();
        this.update();
    }

    private checkForDagmcFile(): void {
        const state = this.stateManager.getState();
        if (state.settings.dagmcFile && state.settings.dagmcInfo) {
            // Convert dagmcInfo to modelData format
            const info = state.settings.dagmcInfo;
            this.modelData = {
                filePath: info.filePath,
                fileName: info.fileName,
                volumeCount: info.volumeCount,
                surfaceCount: info.surfaceCount,
                vertices: info.vertices,
                materials: this.buildMaterialsMap({ volumes: info.volumes }),
                volumes: info.volumes.map(v => ({
                    ...v,
                    numTriangles: v.numTriangles || 0
                })),
                groups: this.extractGroups(info),
                boundingBox: info.boundingBox
            };
        }
    }

    private buildMaterialsMap(info: { volumes: Array<{ id: number; material?: string; numTriangles?: number }> }): Record<string, { volumeCount: number; volumes: number[] }> {
        const map: Record<string, { volumeCount: number; volumes: number[] }> = {};
        
        // Build materials map from volumes (not from original materials list)
        // This ensures we capture all materials including newly assigned ones
        for (const vol of info.volumes) {
            if (vol.material) {
                if (!map[vol.material]) {
                    map[vol.material] = {
                        volumeCount: 0,
                        volumes: []
                    };
                }
                map[vol.material].volumes.push(vol.id);
                map[vol.material].volumeCount++;
            }
        }

        return map;
    }

    private extractGroups(info: DAGMCInfo): DAGMCGroup[] {
        const groups: DAGMCGroup[] = [];
        
        // Material groups
        for (const [name, data] of Object.entries(info.materials)) {
            groups.push({
                name: `mat:${name}`,
                type: 'material',
                volumeCount: data.volumeCount,
                volumes: info.volumes.filter(v => v.material === name).map(v => v.id)
            });
        }

        return groups;
    }

    protected render(): React.ReactNode {
        return (
            <div className='dagmc-editor'>
                {this.renderHeader()}
                {this.modelData && this.renderTabs()}
                {this.renderContent()}
            </div>
        );
    }

    private renderHeader(): React.ReactNode {
        const volumeCount = this.modelData?.volumeCount || 0;
        const surfaceCount = this.modelData?.surfaceCount || 0;
        const triangleCount = this.modelData?.vertices || 0;

        return (
            <div className='dagmc-editor-header'>
                <div className='header-info'>
                    <h2>
                        <i className='codicon codicon-file-code'></i>
                        DAGMC Editor
                    </h2>
                    <p className='header-description'>
                        {this.modelData 
                            ? `Editing: ${this.modelData.fileName}`
                            : 'Visual editor for DAGMC faceted geometry'
                        }
                    </p>
                </div>
                
                {this.modelData && (
                    <div className='header-stats'>
                        <div className='stat-item'>
                            <span className='stat-value'>{volumeCount}</span>
                            <span className='stat-label'>Volumes</span>
                        </div>
                        <div className='stat-item'>
                            <span className='stat-value'>{surfaceCount}</span>
                            <span className='stat-label'>Surfaces</span>
                        </div>
                        <div className='stat-item'>
                            <span className='stat-value'>{(triangleCount / 1000).toFixed(0)}k</span>
                            <span className='stat-label'>Triangles</span>
                        </div>
                    </div>
                )}

                <div className='header-actions'>
                    {this.modelData && (
                        <Tooltip content='View 3D geometry' position='bottom'>
                            <button
                                className='theia-button secondary'
                                onClick={() => this.preview3D()}
                            >
                                <i className='codicon codicon-globe'></i>
                                3D View
                            </button>
                        </Tooltip>
                    )}
                    <Tooltip content={this.modelData ? 'Open different DAGMC file' : 'Open DAGMC file'} position='bottom'>
                        <button
                            className='theia-button secondary'
                            onClick={() => this.openFile()}
                        >
                            <i className='codicon codicon-folder-opened'></i>
                            {this.modelData ? 'Open...' : 'Open File'}
                        </button>
                    </Tooltip>
                </div>
            </div>
        );
    }

    private renderTabs(): React.ReactNode {
        const tabs: { id: EditorTab; label: string; icon: string; count?: number }[] = [
            { id: 'volumes', label: 'Volumes', icon: 'package', count: this.modelData?.volumeCount },
            { id: 'materials', label: 'Materials', icon: 'symbol-color', count: Object.keys(this.modelData?.materials || {}).length },
            { id: 'groups', label: 'Groups', icon: 'folder', count: this.modelData?.groups.length },
            { id: 'properties', label: 'Properties', icon: 'info' }
        ];

        return (
            <div className='dagmc-editor-tabs'>
                {tabs.map(tab => (
                    <button
                        key={tab.id}
                        className={`tab-button ${this.activeTab === tab.id ? 'active' : ''}`}
                        onClick={() => { this.activeTab = tab.id; this.update(); }}
                    >
                        <i className={`codicon codicon-${tab.icon}`}></i>
                        {tab.label}
                        {tab.count !== undefined && tab.count > 0 && (
                            <span className='count-badge'>{tab.count}</span>
                        )}
                    </button>
                ))}
            </div>
        );
    }

    private renderContent(): React.ReactNode {
        if (this.isLoading) {
            return (
                <div className='dagmc-editor-content loading'>
                    <i className='codicon codicon-loading codicon-modifier-spin'></i>
                    <h3>Loading DAGMC file...</h3>
                </div>
            );
        }

        if (this.error) {
            return (
                <div className='dagmc-editor-content error'>
                    <i className='codicon codicon-error'></i>
                    <h3>Failed to Load File</h3>
                    <p className='hint'>{this.error}</p>
                    <button className='theia-button secondary' onClick={() => { this.error = undefined; this.update(); }}>
                        <i className='codicon codicon-close'></i> Dismiss
                    </button>
                </div>
            );
        }

        if (!this.modelData) {
            return (
                <div className='dagmc-editor-content empty'>
                    <i className='codicon codicon-file-code'></i>
                    <h3>No DAGMC File Loaded</h3>
                    <p className='hint'>
                        Open a DAGMC file to view and edit volumes, materials, and groups.
                        You can also load a DAGMC file from the Simulation Dashboard.
                    </p>
                    <button className='theia-button primary' onClick={() => this.openFile()}>
                        <i className='codicon codicon-folder-opened'></i> Open DAGMC File
                    </button>
                </div>
            );
        }

        return (
            <div className='dagmc-editor-content'>
                <div className='dagmc-tab-content'>
                    {this.activeTab === 'volumes' && this.renderVolumesTab()}
                    {this.activeTab === 'materials' && this.renderMaterialsTab()}
                    {this.activeTab === 'groups' && this.renderGroupsTab()}
                    {this.activeTab === 'properties' && this.renderPropertiesTab()}
                </div>
            </div>
        );
    }

    private renderVolumesTab(): React.ReactNode {
        if (!this.modelData) return null;

        // Apply search and filters
        const filteredVolumes = this.modelData.volumes.filter(v => {
            const matchesSearch = !this.searchQuery || 
                v.id.toString().includes(this.searchQuery) ||
                (v.material && v.material.toLowerCase().includes(this.searchQuery.toLowerCase()));
            
            if (!matchesSearch) return false;

            if (this.filterType === 'assigned') return !!v.material;
            if (this.filterType === 'unassigned') return !v.material;
            if (this.filterType === 'high-poly') return v.numTriangles > 5000;
            
            return true;
        });

        const selectedVolume = this.selectedVolumeId 
            ? this.modelData.volumes.find(v => v.id === this.selectedVolumeId)
            : undefined;

        // Calculate max triangles for relative bar
        const maxTriangles = Math.max(...this.modelData.volumes.map(v => v.numTriangles), 1);

        return (
            <div className='volumes-tab dagmc-tab-content'>
                <div className='dagmc-tab-header'>
                    <div className='tab-title-group'>
                        <h3><i className='codicon codicon-package'></i> Volumes</h3>
                        <div className='filter-pills'>
                            <button 
                                className={`pill ${this.filterType === 'all' ? 'active' : ''}`}
                                onClick={() => { this.filterType = 'all'; this.update(); }}
                            >
                                All
                            </button>
                            <button 
                                className={`pill ${this.filterType === 'assigned' ? 'active' : ''}`}
                                onClick={() => { this.filterType = 'assigned'; this.update(); }}
                            >
                                Assigned
                            </button>
                            <button 
                                className={`pill ${this.filterType === 'unassigned' ? 'active' : ''}`}
                                onClick={() => { this.filterType = 'unassigned'; this.update(); }}
                            >
                                Unassigned
                            </button>
                            <button 
                                className={`pill ${this.filterType === 'high-poly' ? 'active' : ''}`}
                                onClick={() => { this.filterType = 'high-poly'; this.update(); }}
                            >
                                High-Poly
                            </button>
                        </div>
                    </div>
                    <div className='header-actions'>
                        <div className='search-box'>
                            <i className='codicon codicon-search'></i>
                            <input 
                                type='text' 
                                placeholder='Search volumes or materials...' 
                                value={this.searchQuery}
                                onChange={(e) => { this.searchQuery = e.target.value; this.update(); }}
                            />
                        </div>
                        <span className='count-badge'>{filteredVolumes.length} / {this.modelData.volumes.length}</span>
                    </div>
                </div>
                <div className={`volumes-layout ${selectedVolume ? 'with-details' : ''}`}>
                    <div className='volumes-grid'>
                        {filteredVolumes.length === 0 ? (
                            <div className='empty-state-mini'>
                                <i className='codicon codicon-search-stop'></i>
                                <p>No volumes match your search/filter</p>
                                <button className='theia-button secondary small' onClick={() => { this.searchQuery = ''; this.filterType = 'all'; this.update(); }}>
                                    Reset Filters
                                </button>
                            </div>
                        ) : (
                            filteredVolumes.map(volume => this.renderVolumeCard(volume, maxTriangles))
                        )}
                    </div>
                    {selectedVolume && this.renderVolumeDetails(selectedVolume)}
                </div>
            </div>
        );
    }

    private renderVolumeCard(volume: DAGMCVolumeExtended, maxTriangles: number): React.ReactNode {
        const isSelected = this.selectedVolumeId === volume.id;
        const trianglePercent = (volume.numTriangles / maxTriangles) * 100;

        return (
            <div
                key={volume.id}
                className={`volume-card ${isSelected ? 'selected' : ''}`}
                onClick={() => { this.selectedVolumeId = volume.id; this.update(); }}
            >
                <div className='volume-card-main'>
                    <div className='volume-header'>
                        <div className='volume-icon'>
                            <i className='codicon codicon-package'></i>
                        </div>
                        <div className='volume-info'>
                            <div className='volume-id'>Volume #{volume.id}</div>
                            <div className='volume-triangles'>
                                <i className='codicon codicon-triangle-up'></i>
                                {volume.numTriangles.toLocaleString()} TRIS
                            </div>
                        </div>
                    </div>
                    
                    <div className='volume-material-chip'>
                        <i className='codicon codicon-symbol-color'></i>
                        <span className={`material-name ${volume.material ? '' : 'unassigned'}`}>
                            {volume.material || 'UNASSIGNED'}
                        </span>
                    </div>
                </div>

                <div className='volume-card-footer'>
                    <div className='quick-actions'>
                        <Tooltip content='Edit Material' position='top'>
                            <button 
                                className='action-btn'
                                onClick={(e) => {
                                    e.stopPropagation();
                                    this.selectedVolumeId = volume.id;
                                    this.editingMaterial = { volumeId: volume.id, newMaterial: volume.material || '' };
                                    this.update();
                                }}
                            >
                                <i className='codicon codicon-edit'></i>
                            </button>
                        </Tooltip>
                    </div>
                    <i className='codicon codicon-chevron-right selection-icon'></i>
                </div>

                {/* Triangle density bar */}
                <div className='triangle-bar-container'>
                    <div 
                        className='triangle-bar-fill' 
                        style={{ width: `${Math.max(trianglePercent, 2)}%` }} 
                    />
                </div>
            </div>
        );
    }

    private renderVolumeDetails(volume: DAGMCVolumeExtended): React.ReactNode {
        return (
            <div className='volume-details-panel'>
                <div className='details-header'>
                    <h4><i className='codicon codicon-package'></i> Volume #{volume.id}</h4>
                    <button 
                        className='close-btn'
                        onClick={() => { this.selectedVolumeId = undefined; this.update(); }}
                    >
                        <i className='codicon codicon-close'></i>
                    </button>
                </div>
                <div className='details-content'>
                    <div className='inspector-section'>
                        <div className='detail-row'>
                            <label>Assigned Material</label>
                            {this.editingMaterial?.volumeId === volume.id ? (
                                <div className='material-editor-inline'>
                                    <div className='editor-input-wrapper'>
                                        <i className='codicon codicon-symbol-color'></i>
                                        <input
                                            type='text'
                                            value={this.editingMaterial.newMaterial}
                                            placeholder='Enter material name...'
                                            autoFocus
                                            onChange={(e) => {
                                                if (this.editingMaterial) {
                                                    this.editingMaterial.newMaterial = e.target.value;
                                                    this.update();
                                                }
                                            }}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    this.assignMaterial(volume.id, this.editingMaterial!.newMaterial);
                                                } else if (e.key === 'Escape') {
                                                    this.editingMaterial = null;
                                                    this.update();
                                                }
                                            }}
                                        />
                                    </div>
                                    <div className='editor-actions'>
                                        <Tooltip content='Save (Enter)' position='top'>
                                            <button 
                                                className='action-btn confirm'
                                                onClick={() => this.assignMaterial(volume.id, this.editingMaterial!.newMaterial)}
                                            >
                                                <i className='codicon codicon-check'></i>
                                            </button>
                                        </Tooltip>
                                        <Tooltip content='Cancel (Esc)' position='top'>
                                            <button 
                                                className='action-btn cancel'
                                                onClick={() => { this.editingMaterial = null; this.update(); }}
                                            >
                                                <i className='codicon codicon-close'></i>
                                            </button>
                                        </Tooltip>
                                    </div>
                                </div>
                            ) : (
                                <div className={`detail-material ${volume.material ? 'assigned' : 'unassigned'}`}>
                                    <i className='codicon codicon-symbol-color'></i>
                                    <span className='material-text'>{volume.material || 'No material assigned'}</span>
                                    <Tooltip content='Edit Material' position='top'>
                                        <button 
                                            className='edit-btn'
                                            onClick={() => { 
                                                this.editingMaterial = { volumeId: volume.id, newMaterial: volume.material || '' };
                                                this.update();
                                            }}
                                        >
                                            <i className='codicon codicon-edit'></i>
                                        </button>
                                    </Tooltip>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className='inspector-section'>
                        <div className='inspector-title'>Geometry Stats</div>
                        <div className='stats-grid-mini'>
                            <div className='stat-mini-item'>
                                <span className='label'>Triangles</span>
                                <span className='value'>{volume.numTriangles.toLocaleString()}</span>
                            </div>
                            <div className='stat-mini-item'>
                                <span className='label'>Complexity</span>
                                <span className='value'>{volume.numTriangles > 5000 ? 'High' : volume.numTriangles > 1000 ? 'Medium' : 'Low'}</span>
                            </div>
                        </div>
                    </div>

                    <div className='inspector-section'>
                        <div className='inspector-title'>Spatial Extent (CM)</div>
                        <div className='detail-bbox'>
                            <div className='bbox-coord'>
                                <span className='label'>MIN</span>
                                <span className='value'>X: {volume.boundingBox.min[0].toFixed(2)}, Y: {volume.boundingBox.min[1].toFixed(2)}, Z: {volume.boundingBox.min[2].toFixed(2)}</span>
                            </div>
                            <div className='bbox-coord'>
                                <span className='label'>MAX</span>
                                <span className='value'>X: {volume.boundingBox.max[0].toFixed(2)}, Y: {volume.boundingBox.max[1].toFixed(2)}, Z: {volume.boundingBox.max[2].toFixed(2)}</span>
                            </div>
                        </div>
                    </div>

                    <div className='inspector-actions'>
                        <button className='theia-button primary full-width' onClick={() => this.preview3D(volume.id)}>
                            <i className='codicon codicon-globe'></i> View in 3D
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    private renderMaterialsTab(): React.ReactNode {
        if (!this.modelData) return null;

        const materials = Object.entries(this.modelData.materials);
        const totalTriangles = this.modelData.vertices || 1;

        return (
            <div className='materials-tab dagmc-tab-content'>
                <div className='dagmc-tab-header'>
                    <h3><i className='codicon codicon-symbol-color'></i> Materials</h3>
                    <div className='header-actions'>
                        <span className='count-badge'>{materials.length} Materials</span>
                    </div>
                </div>
                <div className='materials-grid'>
                    {materials.length === 0 ? (
                        <div className='empty-state-mini'>
                            <i className='codicon codicon-symbol-color'></i>
                            <h3>No Materials Defined</h3>
                            <p className='hint'>Assign materials to volumes to see them here.</p>
                        </div>
                    ) : (
                        materials.map(([name, data]) => {
                            // Calculate triangle coverage for this material
                            const matTriangles = data.volumes.reduce((sum, vid) => {
                                const vol = this.modelData?.volumes.find(v => v.id === vid);
                                return sum + (vol?.numTriangles || 0);
                            }, 0);
                            const coverage = (matTriangles / totalTriangles) * 100;

                            return (
                                <div key={name} className='material-card'>
                                    <div className='material-card-main'>
                                        <div className='material-header'>
                                            <div className='material-icon'>
                                                <i className='codicon codicon-symbol-color'></i>
                                            </div>
                                            <div className='material-info'>
                                                <div className='material-name'>{name}</div>
                                                <div className='material-meta'>
                                                    {data.volumeCount} VOLUMES • {coverage.toFixed(1)}% MESH
                                                </div>
                                            </div>
                                            <div className='material-count-big'>{data.volumeCount}</div>
                                        </div>
                                        
                                        <div className='coverage-indicator'>
                                            <div className='bar-track'>
                                                <div className='bar-fill' style={{ width: `${Math.max(coverage, 2)}%` }}></div>
                                            </div>
                                        </div>
                                    </div>
                                    
                                    <div className='material-card-footer'>
                                        <div className='material-volumes-preview'>
                                            {data.volumes.slice(0, 5).map(vid => (
                                                <span 
                                                    key={vid} 
                                                    className='volume-tag mini'
                                                    onClick={() => {
                                                        this.selectedVolumeId = vid;
                                                        this.activeTab = 'volumes';
                                                        this.update();
                                                    }}
                                                >
                                                    #{vid}
                                                </span>
                                            ))}
                                            {data.volumes.length > 5 && (
                                                <span className='more-label'>+{data.volumes.length - 5} more</span>
                                            )}
                                        </div>
                                        <div className='material-actions'>
                                            {data.volumes.length > 0 && (
                                                <Tooltip content={`View volume ${data.volumes[0]} in 3D`} position='top'>
                                                    <button className='action-btn' onClick={() => this.preview3D(data.volumes[0])}>
                                                        <i className='codicon codicon-globe'></i>
                                                    </button>
                                                </Tooltip>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
            </div>
        );
    }

    private renderGroupsTab(): React.ReactNode {
        if (!this.modelData) return null;

        return (
            <div className='groups-tab dagmc-tab-content'>
                <div className='dagmc-tab-header'>
                    <div className='tab-title-group'>
                        <h3><i className='codicon codicon-folder'></i> Groups</h3>
                        <button
                            className={`theia-button ${this.showCreateGroup ? 'secondary' : 'primary'} small`}
                            onClick={() => { this.showCreateGroup = !this.showCreateGroup; this.update(); }}
                        >
                            <i className={`codicon codicon-${this.showCreateGroup ? 'close' : 'add'}`}></i>
                            {this.showCreateGroup ? 'Cancel' : 'New Group'}
                        </button>
                    </div>
                    <div className='header-actions'>
                        <span className='count-badge'>{this.modelData.groups.length} Groups</span>
                    </div>
                </div>

                {this.showCreateGroup && (
                    <div className='create-group'>
                        <div className='form-content'>
                            <div className='input-group'>
                                <label>New Group Name</label>
                                <div className='input-wrapper'>
                                    <i className='codicon codicon-folder'></i>
                                    <input
                                        type='text'
                                        placeholder='e.g., mat:fuel or boundary:vacuum'
                                        value={this.newGroupName}
                                        autoFocus
                                        onChange={(e) => { this.newGroupName = e.target.value; this.update(); }}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && this.newGroupName.trim()) {
                                                this.createGroup();
                                            }
                                        }}
                                    />
                                </div>
                            </div>
                            <div className='form-info'>
                                <i className='codicon codicon-info'></i>
                                <span>Use <b>mat:</b> prefix for materials or <b>boundary:</b> for surfaces.</span>
                            </div>
                            <button
                                className='theia-button primary'
                                onClick={() => this.createGroup()}
                                disabled={!this.newGroupName.trim()}
                            >
                                Create Group
                            </button>
                        </div>
                    </div>
                )}

                <div className='groups-grid'>
                    {this.modelData.groups.length === 0 ? (
                        <div className='empty-state-mini'>
                            <i className='codicon codicon-folder'></i>
                            <p>No groups defined in this model</p>
                        </div>
                    ) : (
                        this.modelData.groups.map(group => (
                            <div key={group.name} className={`group-card ${group.type}`}>
                                <div className='group-card-main'>
                                    <div className='group-header'>
                                        <div className={`group-icon ${group.type}`}>
                                            <i className={`codicon codicon-${group.type === 'material' ? 'symbol-color' : 'folder'}`}></i>
                                        </div>
                                        <div className='group-info'>
                                            <div className='group-name'>{group.name}</div>
                                            <div className='group-type-label'>{group.type.toUpperCase()}</div>
                                        </div>
                                        <div className='group-count-badge'>{group.volumeCount}</div>
                                    </div>
                                    
                                    <div className='group-volumes-grid'>
                                        {group.volumes.slice(0, 12).map(vid => (
                                            <span 
                                                key={vid} 
                                                className='volume-tag mini'
                                                onClick={() => {
                                                    this.selectedVolumeId = vid;
                                                    this.activeTab = 'volumes';
                                                    this.update();
                                                }}
                                            >
                                                #{vid}
                                            </span>
                                        ))}
                                        {group.volumes.length > 12 && (
                                            <span className='more-label'>+{group.volumes.length - 12} more</span>
                                        )}
                                    </div>
                                </div>
                                
                                <div className='group-card-footer'>
                                    <div className='group-actions'>
                                        <Tooltip content='Delete Group' position='top'>
                                            <button 
                                                className='action-btn delete'
                                                onClick={() => this.deleteGroup(group.name)}
                                            >
                                                <i className='codicon codicon-trash'></i>
                                            </button>
                                        </Tooltip>
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        );
    }

    private renderPropertiesTab(): React.ReactNode {
        if (!this.modelData) return null;

        const { fileName, filePath, volumes, materials, volumeCount, surfaceCount, vertices } = this.modelData;
        
        // Calculate material distribution
        const volumesByMaterial = new Map<string, number>();
        volumes.forEach(v => {
            const mat = v.material || 'unassigned';
            volumesByMaterial.set(mat, (volumesByMaterial.get(mat) || 0) + 1);
        });
        
        return (
            <div className='properties-tab dagmc-tab-content'>
                <div className='dagmc-tab-header'>
                    <h3><i className='codicon codicon-info'></i> Model Overview</h3>
                </div>

                {/* Stats Cards */}
                <div className='properties-stats-grid'>
                    <div className='stat-card'>
                        <div className='stat-icon volumes'><i className='codicon codicon-package'></i></div>
                        <div className='stat-info'>
                            <div className='stat-value'>{volumeCount}</div>
                            <div className='stat-label'>Volumes</div>
                        </div>
                    </div>
                    <div className='stat-card'>
                        <div className='stat-icon surfaces'><i className='codicon codicon-layers'></i></div>
                        <div className='stat-info'>
                            <div className='stat-value'>{surfaceCount}</div>
                            <div className='stat-label'>Surfaces</div>
                        </div>
                    </div>
                    <div className='stat-card'>
                        <div className='stat-icon triangles'><i className='codicon codicon-triangle-up'></i></div>
                        <div className='stat-info'>
                            <div className='stat-value'>{this.formatNumberCompact(vertices)}</div>
                            <div className='stat-label'>Triangles</div>
                        </div>
                    </div>
                    <div className='stat-card'>
                        <div className='stat-icon materials'><i className='codicon codicon-symbol-color'></i></div>
                        <div className='stat-info'>
                            <div className='stat-value'>{Object.keys(materials).length}</div>
                            <div className='stat-label'>Materials</div>
                        </div>
                    </div>
                </div>

                <div className='properties-layout-two-col'>
                    {/* Left Column */}
                    <div className='properties-column'>
                        {/* File Info */}
                        <div className='properties-section'>
                            <div className='section-title'><i className='codicon codicon-file'></i> File Information</div>
                            <div className='file-info-grid'>
                                <div className='file-info-item'>
                                    <span className='label'>Filename</span>
                                    <span className='value'>{fileName}</span>
                                </div>
                                <div className='file-info-item full-width'>
                                    <span className='label'>Path</span>
                                    <span className='value path'>{filePath}</span>
                                </div>
                            </div>
                        </div>

                        {/* Material Distribution */}
                        {volumesByMaterial.size > 0 && (
                            <div className='properties-section'>
                                <div className='section-title'><i className='codicon codicon-chart-pie'></i> Material Distribution</div>
                                <div className='material-bars'>
                                    {Array.from(volumesByMaterial.entries())
                                        .sort((a, b) => b[1] - a[1])
                                        .map(([mat, count]) => {
                                            const percentage = (count / volumes.length) * 100;
                                            return (
                                                <div key={mat} className='material-bar-item'>
                                                    <div className='bar-header'>
                                                        <span className={`mat-name ${mat === 'unassigned' ? 'unassigned' : ''}`}>
                                                            {mat === 'unassigned' ? 'No Material' : mat}
                                                        </span>
                                                        <span className='mat-count'>{count} vol ({percentage.toFixed(1)}%)</span>
                                                    </div>
                                                    <div className='bar-track'>
                                                        <div 
                                                            className={`bar-fill ${mat === 'unassigned' ? 'unassigned' : ''}`}
                                                            style={{width: `${percentage}%`}}
                                                        />
                                                    </div>
                                                </div>
                                            );
                                        })}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Right Column - Volumes Table */}
                    <div className='properties-column'>
                        <div className='properties-section'>
                            <div className='section-title'>
                                <i className='codicon codicon-list-flat'></i> 
                                All Volumes
                                <span className='count-badge'>{volumes.length}</span>
                            </div>
                            <div className='volumes-table-wrapper'>
                                <table className='volumes-data-table'>
                                    <thead>
                                        <tr>
                                            <th>ID</th>
                                            <th>Material</th>
                                            <th className='numeric'>Triangles</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {volumes.map(vol => (
                                            <tr 
                                                key={vol.id}
                                                className={this.selectedVolumeId === vol.id ? 'selected' : ''}
                                                onClick={() => { this.selectedVolumeId = vol.id; this.activeTab = 'volumes'; this.update(); }}
                                            >
                                                <td><span className='vol-id'>#{vol.id}</span></td>
                                                <td>
                                                    {vol.material ? (
                                                        <span className='table-material'>{vol.material}</span>
                                                    ) : (
                                                        <span className='table-material unassigned'>—</span>
                                                    )}
                                                </td>
                                                <td className='numeric'>{vol.numTriangles.toLocaleString()}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    private formatNumberCompact(num: number): string {
        if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
        return num.toString();
    }

    // ============================================================================
    // Actions
    // ============================================================================

    private async openFile(): Promise<void> {
        const props: OpenFileDialogProps = {
            title: 'Open DAGMC File',
            canSelectFiles: true,
            canSelectFolders: false,
            filters: {
                'DAGMC Files': ['h5m', 'h5'],
                'All Files': ['*']
            }
        };

        const uri = await this.fileDialogService.showOpenDialog(props);
        if (uri) {
            this.loadDagmcFile(uri.path.toString());
        }
    }

    async loadFile(filePath: string): Promise<void> {
        await this.loadDagmcFile(filePath);
    }

    private async loadDagmcFile(filePath: string): Promise<void> {
        this.isLoading = true;
        this.error = undefined;
        this.update();

        try {
            const result = await this.backendService.dagmcLoad(filePath);
            
            if (result.success && result.data) {
                this.modelData = {
                    filePath: result.data.filePath,
                    fileName: result.data.fileName,
                    volumeCount: result.data.volumeCount,
                    surfaceCount: result.data.surfaceCount,
                    vertices: result.data.vertices,
                    materials: result.data.materials,
                    volumes: result.data.volumes.map(v => ({
                        id: v.id,
                        material: v.material,
                        numTriangles: v.numTriangles,
                        boundingBox: {
                            min: v.boundingBox.min as [number, number, number],
                            max: v.boundingBox.max as [number, number, number]
                        }
                    })),
                    groups: result.data.groups.map(g => ({
                        name: g.name,
                        type: g.type as 'material' | 'boundary' | 'other',
                        volumeCount: g.volumeCount,
                        volumes: g.volumes
                    })),
                    boundingBox: {
                        min: result.data.boundingBox.min as [number, number, number],
                        max: result.data.boundingBox.max as [number, number, number]
                    }
                };
                this.messageService.info(`Loaded ${result.data.volumeCount} volumes from ${result.data.fileName}`);
            } else {
                this.error = result.error || 'Failed to load DAGMC file';
            }
            
            this.isLoading = false;
            this.update();
        } catch (error) {
            this.isLoading = false;
            this.error = `Failed to load DAGMC file: ${error}`;
            this.update();
        }
    }

    private async assignMaterial(volumeId: number, materialName: string): Promise<void> {
        if (!this.modelData) return;

        const result = await this.backendService.dagmcAssignMaterial(
            this.modelData.filePath,
            volumeId,
            materialName.trim()
        );

        if (!result.success) {
            this.messageService.error(result.error || 'Failed to assign material');
            return;
        }

        const volume = this.modelData.volumes.find(v => v.id === volumeId);
        if (volume) {
            const trimmedName = materialName.trim();
            volume.material = trimmedName || undefined;
            
            // Rebuild materials map from all volumes
            this.modelData.materials = this.buildMaterialsMap({
                volumes: this.modelData.volumes
            });

            this.editingMaterial = null;
            this.update();
            
            if (trimmedName) {
                this.messageService.info(`Assigned material "${trimmedName}" to Volume ${volumeId}`);
            } else {
                this.messageService.info(`Removed material from Volume ${volumeId}`);
            }
        }
    }

    private async createGroup(): Promise<void> {
        if (!this.modelData || !this.newGroupName.trim()) return;

        const name = this.newGroupName.trim();
        
        if (this.modelData.groups.some(g => g.name === name)) {
            this.messageService.error(`Group "${name}" already exists`);
            return;
        }

        const result = await this.backendService.dagmcCreateGroup(
            this.modelData.filePath,
            name
        );

        if (!result.success) {
            this.messageService.error(result.error || 'Failed to create group');
            return;
        }

        const type = name.startsWith('mat:') ? 'material' : 
                     name.startsWith('boundary:') ? 'boundary' : 'other';
        
        this.modelData.groups.push({
            name,
            type,
            volumeCount: 0,
            volumes: []
        });

        this.newGroupName = '';
        this.showCreateGroup = false;
        this.update();
        
        this.messageService.info(`Created group "${name}"`);
    }

    private async deleteGroup(groupName: string): Promise<void> {
        if (!this.modelData) return;

        const confirmDialog = new ConfirmDialog({
            title: 'Delete Group',
            msg: `Delete group "${groupName}"?\n\nThis will not delete the volumes, only the group organization.`,
            ok: 'Delete',
            cancel: 'Cancel'
        });
        const confirmed = await confirmDialog.open();
        if (!confirmed) return;

        const result = await this.backendService.dagmcDeleteGroup(
            this.modelData.filePath,
            groupName
        );

        if (!result.success) {
            this.messageService.error(result.error || 'Failed to delete group');
            return;
        }

        // Remove from local state
        this.modelData.groups = this.modelData.groups.filter(g => g.name !== groupName);
        this.update();
        
        this.messageService.info(`Deleted group "${groupName}"`);
    }

    private async preview3D(highlightVolumeId?: number): Promise<void> {
        if (!this.modelData) return;

        try {
            const fileUri = new URI(this.modelData.filePath);

            // Open or create the Visualizer widget with optional volume highlighting
            // The widget factory will pass the volumeId to setUri
            const widget = await this.widgetManager.getOrCreateWidget<VisualizerWidget>(
                VisualizerWidget.ID,
                { uri: this.modelData.filePath, volumeId: highlightVolumeId }
            );

            // Show widget
            if (!widget.isAttached) {
                await this.shell.addWidget(widget, { area: 'main' });
            }
            await this.shell.activateWidget(widget.id);

            // Load the file (VisualizerWidget handles H5M conversion with volume extraction)
            await widget.loadFile(fileUri, highlightVolumeId);

        } catch (error) {
            this.messageService.error(`3D view error: ${error}`);
        }
    }
}
