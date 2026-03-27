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
import { FileDialogService, OpenFileDialogProps } from '@theia/filesystem/lib/browser';
import { WidgetManager, ApplicationShell } from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';
import { OpenMCStateManager } from '../openmc-state-manager';
import { OpenMCXMLGenerationService } from '../xml-generator/xml-generation-service';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components/tooltip';
import {
    OpenMCState,
    OpenMCSurface,
    OpenMCSurfaceType,
    OpenMCSurfaceCoefficients,
    OpenMCCell,
    OpenMCRegionNode,
    OpenMCBoundaryCondition,
    OpenMCFillType,
    OpenMCUniverse
} from '../../common/openmc-state-schema';

// Import from nuke-visualizer for 3D preview
import { OpenMCService } from 'nuke-visualizer/lib/browser/openmc/openmc-service';
import { OpenMCGeometry3DWidget } from 'nuke-visualizer/lib/browser/openmc/openmc-geometry-3d-widget';

export type CSGBuilderTab = 'surfaces' | 'cells' | 'universes';

interface SurfaceTemplate {
    type: OpenMCSurfaceType;
    name: string;
    icon: string;
    description: string;
    defaultCoeffs: Partial<OpenMCSurfaceCoefficients[OpenMCSurfaceType]>;
}

const SURFACE_TEMPLATES: SurfaceTemplate[] = [
    {
        type: 'sphere',
        name: 'Sphere',
        icon: 'circle',
        description: 'Spherical surface defined by center and radius',
        defaultCoeffs: { x0: 0, y0: 0, z0: 0, r: 1 }
    },
    {
        type: 'x-plane',
        name: 'X-Plane',
        icon: 'ellipsis vertical',
        description: 'Plane perpendicular to x-axis at x0',
        defaultCoeffs: { x0: 0 }
    },
    {
        type: 'y-plane',
        name: 'Y-Plane',
        icon: 'ellipsis',
        description: 'Plane perpendicular to y-axis at y0',
        defaultCoeffs: { y0: 0 }
    },
    {
        type: 'z-plane',
        name: 'Z-Plane',
        icon: 'dash',
        description: 'Plane perpendicular to z-axis at z0',
        defaultCoeffs: { z0: 0 }
    },
    {
        type: 'x-cylinder',
        name: 'X-Cylinder',
        icon: 'circle-filled',
        description: 'Cylinder parallel to x-axis',
        defaultCoeffs: { y0: 0, z0: 0, r: 1 }
    },
    {
        type: 'y-cylinder',
        name: 'Y-Cylinder',
        icon: 'circle-filled',
        description: 'Cylinder parallel to y-axis',
        defaultCoeffs: { x0: 0, z0: 0, r: 1 }
    },
    {
        type: 'z-cylinder',
        name: 'Z-Cylinder',
        icon: 'circle-filled',
        description: 'Cylinder parallel to z-axis',
        defaultCoeffs: { x0: 0, y0: 0, r: 1 }
    },
    {
        type: 'x-cone',
        name: 'X-Cone',
        icon: 'triangle-up',
        description: 'Cone parallel to x-axis',
        defaultCoeffs: { x0: 0, y0: 0, z0: 0, r2: 1 }
    },
    {
        type: 'y-cone',
        name: 'Y-Cone',
        icon: 'triangle-right',
        description: 'Cone parallel to y-axis',
        defaultCoeffs: { x0: 0, y0: 0, z0: 0, r2: 1 }
    },
    {
        type: 'z-cone',
        name: 'Z-Cone',
        icon: 'triangle-down',
        description: 'Cone parallel to z-axis',
        defaultCoeffs: { x0: 0, y0: 0, z0: 0, r2: 1 }
    },
    {
        type: 'plane',
        name: 'General Plane',
        icon: 'blank',
        description: 'General plane: ax + by + cz = d',
        defaultCoeffs: { a: 1, b: 0, c: 0, d: 0 }
    }
];

const BOUNDARY_CONDITIONS: { value: OpenMCBoundaryCondition; label: string }[] = [
    { value: 'transmission', label: 'Transmission (default)' },
    { value: 'vacuum', label: 'Vacuum' },
    { value: 'reflective', label: 'Reflective' },
    { value: 'periodic', label: 'Periodic' },
    { value: 'white', label: 'White' }
];

@injectable()
export class CSGBuilderWidget extends ReactWidget {
    static readonly ID = 'openmc-csg-builder';
    static readonly LABEL = 'CSG Geometry Builder';

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    @inject(OpenMCStateManager)
    protected readonly stateManager!: OpenMCStateManager;

    @inject(FileDialogService)
    protected readonly fileDialogService!: FileDialogService;

    @inject(OpenMCXMLGenerationService)
    protected readonly xmlService!: OpenMCXMLGenerationService;

    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    @inject(OpenMCService)
    protected readonly openmcService!: OpenMCService;

    private activeTab: CSGBuilderTab = 'surfaces';
    
    // 3D Preview widget reference
    private previewWidget: OpenMCGeometry3DWidget | null = null;
    
    // Surface form state
    private editingSurface?: OpenMCSurface;
    private creatingSurfaceType?: OpenMCSurfaceType;
    private surfaceFormType: OpenMCSurfaceType = 'sphere';
    private surfaceFormCoeffs: Partial<OpenMCSurfaceCoefficients[OpenMCSurfaceType]> = {};
    private surfaceFormBoundary: OpenMCBoundaryCondition = 'vacuum';
    private surfaceFormName = '';
    private showSurfaceEditor = false;
    
    // Save location - if set, auto-saves happen here
    private saveOutputPath?: string;
    private autoSaveDebounceTimer?: number;

    // Cell form state
    private editingCell?: OpenMCCell;
    private cellFormName = '';
    private cellFormFillType: OpenMCFillType = 'void';
    private cellFormFillId = 0;
    private cellFormRegionString = '';
    private cellFormTemperature?: number;
    
    // Visual region builder state
    private regionBuilderTokens: { type: 'surface' | 'operator'; value: string; id?: number; side?: 'positive' | 'negative' | 'complement' }[] = [];



    @postConstruct()
    protected init(): void {
        this.id = CSGBuilderWidget.ID;
        this.title.label = CSGBuilderWidget.LABEL;
        this.title.caption = CSGBuilderWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-graph';

        // Listen to state changes (both change events and reload events)
        this.stateManager.onStateChange(() => {
            this.update();
            this.autoSaveToCurrentPath();
        });
        this.stateManager.onStateReload(() => this.update());

        this.update();
    }

    protected render(): React.ReactNode {
        const state = this.stateManager.getState();

        return (
            <div className='csg-builder'>
                {this.renderHeader()}
                {this.renderTabs()}
                <div className='csg-builder-content'>
                    {this.activeTab === 'surfaces' && this.renderSurfacesTab(state)}
                    {this.activeTab === 'cells' && this.renderCellsTab(state)}
                    {this.activeTab === 'universes' && this.renderUniversesTab(state)}
                </div>
            </div>
        );
    }

    private renderHeader(): React.ReactNode {
        return (
            <div className='csg-builder-header'>
                <div className='header-info'>
                    <h2>
                        <i className='codicon codicon-graph'></i>
                        CSG Geometry Builder
                    </h2>
                    <p className='header-description'>
                        Constructive Solid Geometry editor for OpenMC
                    </p>
                </div>
                <div className='header-actions'>
                    <Tooltip content='Preview geometry in 3D viewer' position='bottom'>
                        <button
                            className='theia-button secondary'
                            onClick={() => this.previewGeometry()}
                            disabled={this.stateManager.getState().geometry.cells.length === 0}
                        >
                            <i className='codicon codicon-globe'></i>
                            Preview 3D
                        </button>
                    </Tooltip>
                    <Tooltip content='Import geometry from XML files' position='bottom'>
                        <button
                            className='theia-button secondary'
                            onClick={() => this.importGeometryFromXML()}
                        >
                            <i className='codicon codicon-folder-opened'></i>
                            Import XML
                        </button>
                    </Tooltip>
                    {this.renderSaveButtons()}
                </div>
                <div className='header-stats'>
                    <div className='stat-item'>
                        <span className='stat-value'>{this.stateManager.getState().geometry.surfaces.length}</span>
                        <span className='stat-label'>Surfaces</span>
                    </div>
                    <div className='stat-item'>
                        <span className='stat-value'>{this.stateManager.getState().geometry.cells.length}</span>
                        <span className='stat-label'>Cells</span>
                    </div>
                    <div className='stat-item'>
                        <span className='stat-value'>{this.stateManager.getState().geometry.universes.length}</span>
                        <span className='stat-label'>Universes</span>
                    </div>
                </div>
            </div>
        );
    }

    private renderTabs(): React.ReactNode {
        const tabs: { id: CSGBuilderTab; label: string; icon: string }[] = [
            { id: 'surfaces', label: 'Surfaces', icon: 'codicon-circle' },
            { id: 'cells', label: 'Cells', icon: 'codicon-package' },
            { id: 'universes', label: 'Universes', icon: 'codicon-layers' }
        ];

        return (
            <div className='csg-builder-tabs'>
                {tabs.map(tab => (
                    <button
                        key={tab.id}
                        className={`tab-button ${this.activeTab === tab.id ? 'active' : ''}`}
                        onClick={() => {
                            this.activeTab = tab.id;
                            this.cancelForm();
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
    // Surfaces Tab
    // ============================================================================

    private renderSurfacesTab(state: OpenMCState): React.ReactNode {
        return (
            <div className='surfaces-tab'>
                {/* Surface Editor Panel - Shows when editing/creating */}
                {this.showSurfaceEditor && this.renderSurfaceEditorPanel()}

                {/* Two Column Layout: Gallery + Surface List */}
                <div className='surfaces-layout'>
                    {/* Left Column: Surface Gallery */}
                    <div className='surface-gallery-section'>
                        <div className='section-header'>
                            <h3><i className='codicon codicon-add'></i> Create Surface</h3>
                            <span className='section-subtitle'>Select a surface type</span>
                        </div>
                        <div className='surface-gallery'>
                            {SURFACE_TEMPLATES.map(template => (
                                <Tooltip key={template.type} content={template.description} position='right'>
                                    <button
                                        className={`surface-card ${this.creatingSurfaceType === template.type ? 'creating' : ''}`}
                                        onClick={() => this.startCreateSurface(template)}
                                    >
                                        <div className='surface-icon'>
                                            <i className={`codicon codicon-${template.icon}`}></i>
                                        </div>
                                        <div className='surface-info'>
                                            <span className='surface-name'>{template.name}</span>
                                            <span className='surface-desc'>{template.description}</span>
                                        </div>
                                    </button>
                                </Tooltip>
                            ))}
                        </div>
                    </div>

                    {/* Right Column: Defined Surfaces */}
                    <div className='surface-list-section'>
                        <div className='section-header'>
                            <h3><i className='codicon codicon-list-unordered'></i> Defined Surfaces ({state.geometry.surfaces.length})</h3>
                        </div>
                        <div className='surfaces-list'>
                            {state.geometry.surfaces.length === 0 ? (
                                <div className='empty-state'>
                                    <i className='codicon codicon-circle'></i>
                                    <p>No surfaces defined yet.</p>
                                    <p className='empty-hint'>Select a surface type from the gallery to create one.</p>
                                </div>
                            ) : (
                                state.geometry.surfaces.map(surface => (
                                    <div key={surface.id} className={`surface-list-item ${this.editingSurface?.id === surface.id ? 'editing' : ''}`}>
                                        <div className='surface-item-main'>
                                            <div className='surface-item-info'>
                                                <span className='surface-item-id'>#{surface.id}</span>
                                                <span className='surface-item-name'>{surface.name || `${surface.type}`}</span>
                                                <span className={`surface-bc ${surface.boundary || 'transmission'}`}>
                                                    {surface.boundary || 'transmission'}
                                                </span>
                                            </div>
                                            <div className='surface-item-actions'>
                                                <button
                                                    className='theia-button secondary small'
                                                    onClick={() => this.startEditSurface(surface)}
                                                    title='Edit Surface'
                                                >
                                                    <i className='codicon codicon-edit'></i>
                                                </button>
                                                <button
                                                    className='theia-button secondary small danger'
                                                    onClick={() => this.deleteSurface(surface.id)}
                                                    title='Delete Surface'
                                                >
                                                    <i className='codicon codicon-trash'></i>
                                                </button>
                                            </div>
                                        </div>
                                        <div className='surface-item-coeffs'>
                                            {this.renderSurfaceCoeffsPreview(surface)}
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    private renderSurfaceCoeffsPreview(surface: OpenMCSurface): React.ReactNode {
        const coeffs = surface.coefficients;
        const items: string[] = [];

        switch (surface.type) {
            case 'sphere':
                items.push(`center=(${(coeffs as any).x0}, ${(coeffs as any).y0}, ${(coeffs as any).z0})`, `r=${(coeffs as any).r}`);
                break;
            case 'x-plane':
                items.push(`x0=${(coeffs as any).x0}`);
                break;
            case 'y-plane':
                items.push(`y0=${(coeffs as any).y0}`);
                break;
            case 'z-plane':
                items.push(`z0=${(coeffs as any).z0}`);
                break;
            case 'x-cylinder':
                items.push(`center=(${(coeffs as any).y0}, ${(coeffs as any).z0})`, `r=${(coeffs as any).r}`);
                break;
            case 'y-cylinder':
                items.push(`center=(${(coeffs as any).x0}, ${(coeffs as any).z0})`, `r=${(coeffs as any).r}`);
                break;
            case 'z-cylinder':
                items.push(`center=(${(coeffs as any).x0}, ${(coeffs as any).y0})`, `r=${(coeffs as any).r}`);
                break;
            case 'plane':
                items.push(`a=${(coeffs as any).a}`, `b=${(coeffs as any).b}`, `c=${(coeffs as any).c}`, `d=${(coeffs as any).d}`);
                break;
            default:
                Object.entries(coeffs).forEach(([k, v]) => items.push(`${k}=${v}`));
        }

        return items.map((item, i) => (
            <span key={i} className='coeff-tag'>{item}</span>
        ));
    }

    private renderSurfaceEditorPanel(): React.ReactNode {
        const template = SURFACE_TEMPLATES.find(t => t.type === this.surfaceFormType);
        if (!template) return null;

        const isEditing = !!this.editingSurface?.id;

        return (
            <div className='surface-editor-panel'>
                <div className='panel-header'>
                    <h4>
                        <i className={`codicon codicon-${isEditing ? 'edit' : 'add'}`}></i>
                        {isEditing ? `Edit Surface #${this.editingSurface!.id}` : `Create New ${template.name}`}
                    </h4>
                    <button className='panel-close' onClick={() => this.cancelForm()} title='Close'>
                        <i className='codicon codicon-close'></i>
                    </button>
                </div>
                <div className='panel-content'>
                    <div className='form-row'>
                        <div className='form-group'>
                            <label>Surface Type</label>
                            <select
                                value={this.surfaceFormType}
                                onChange={e => this.changeSurfaceType(e.target.value as OpenMCSurfaceType)}
                                disabled={isEditing}
                            >
                                {SURFACE_TEMPLATES.map(t => (
                                    <option key={t.type} value={t.type}>{t.name}</option>
                                ))}
                            </select>
                            {isEditing && <span className='form-hint'>Type cannot be changed when editing</span>}
                        </div>
                        <div className='form-group'>
                            <label>Name (optional)</label>
                            <input
                                type='text'
                                value={this.surfaceFormName}
                                onChange={e => {
                                    this.surfaceFormName = e.target.value;
                                    this.update();
                                }}
                                placeholder='e.g., Fuel Outer Radius'
                            />
                        </div>
                        <div className='form-group'>
                            <label>Boundary Condition</label>
                            <select
                                value={this.surfaceFormBoundary}
                                onChange={e => {
                                    this.surfaceFormBoundary = e.target.value as OpenMCBoundaryCondition;
                                    this.update();
                                }}
                            >
                                {BOUNDARY_CONDITIONS.map(bc => (
                                    <option key={bc.value} value={bc.value}>{bc.label}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    <div className='form-section-title'>
                        <i className='codicon codicon-symbol-numeric'></i> Coefficients
                    </div>
                    <div className='coefficients-grid'>
                        {Object.entries(template.defaultCoeffs).map(([key, defaultValue]) => (
                            <div key={key} className='form-group'>
                                <label>{key}</label>
                                <input
                                    type='number'
                                    step={typeof defaultValue === 'number' && Math.abs(defaultValue as number) < 10 ? '0.1' : '1'}
                                    value={(this.surfaceFormCoeffs as any)[key] ?? defaultValue}
                                    onChange={e => {
                                        const val = parseFloat(e.target.value);
                                        this.surfaceFormCoeffs = { ...this.surfaceFormCoeffs, [key]: isNaN(val) ? 0 : val };
                                        this.update();
                                    }}
                                />
                            </div>
                        ))}
                    </div>

                    <div className='panel-actions'>
                        <button className='theia-button primary' onClick={() => this.saveSurface()}>
                            <i className='codicon codicon-save'></i>
                            {isEditing ? 'Save Changes' : 'Create Surface'}
                        </button>
                        <button className='theia-button secondary' onClick={() => this.cancelForm()}>
                            Cancel
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // ============================================================================
    // Cells Tab
    // ============================================================================

    private renderCellsTab(state: OpenMCState): React.ReactNode {
        return (
            <div className='cells-tab'>
                <div className='tab-toolbar'>
                    <h3>Cells</h3>
                    <button
                        className='theia-button primary'
                        onClick={() => this.startCreateCell()}
                    >
                        <i className='codicon codicon-add'></i> Add Cell
                    </button>
                </div>

                {this.editingCell && this.renderCellForm(state)}

                <div className='cells-list'>
                    {state.geometry.cells.length === 0 ? (
                        <div className='empty-state'>
                            <i className='codicon codicon-package'></i>
                            <p>No cells defined yet. Click "Add Cell" to create one.</p>
                            <p className='empty-hint'>Each cell needs a region (surfaces) and a fill (material/universe/void).</p>
                        </div>
                    ) : (
                        state.geometry.cells.map(cell => (
                            <div key={cell.id} className={`cell-card fill-${cell.fillType}`}>
                                <div className='cell-header'>
                                    <div className='cell-info'>
                                        <span className='cell-id'>#{cell.id}</span>
                                        <span className='cell-name'>{cell.name || `Cell ${cell.id}`}</span>
                                        <span className={`cell-fill-badge ${cell.fillType}`} title='Click Edit to change fill type'>
                                            <i className={`codicon codicon-${this.getFillIcon(cell.fillType)}`}></i>
                                            {cell.fillType}
                                        </span>
                                    </div>
                                    <div className='cell-actions'>
                                        <Tooltip content='Edit Cell' position='top'>
                                            <button
                                                className='theia-button secondary small'
                                                onClick={() => this.startEditCell(cell)}
                                            >
                                                <i className='codicon codicon-edit'></i>
                                            </button>
                                        </Tooltip>
                                        <Tooltip content='Delete Cell' position='top'>
                                            <button
                                                className='theia-button secondary small danger'
                                                onClick={() => this.deleteCell(cell.id)}
                                            >
                                                <i className='codicon codicon-trash'></i>
                                            </button>
                                        </Tooltip>
                                    </div>
                                </div>
                                <div className='cell-details'>
                                    {cell.regionString && (
                                        <div className='cell-region'>
                                            <label>Region:</label>
                                            <code>{cell.regionString}</code>
                                        </div>
                                    )}
                                    <div className='cell-fill'>
                                        <label>Fill:</label>
                                        <span className={`fill-value ${cell.fillType}`}>
                                            {this.getFillDescription(cell, state)}
                                        </span>
                                    </div>
                                    {cell.temperature && (
                                        <div className='cell-temp'>
                                            <label>Temperature:</label>
                                            <span>{cell.temperature} K</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        );
    }

    private renderCellForm(state: OpenMCState): React.ReactNode {
        return (
            <div className='cell-form-container'>
                <h4>{this.editingCell?.id ? `Edit Cell #${this.editingCell.id}` : 'New Cell'}</h4>
                <div className='cell-form'>
                    <div className='form-row'>
                        <div className='form-group'>
                            <label>Name (optional)</label>
                            <input
                                type='text'
                                value={this.cellFormName}
                                onChange={e => {
                                    this.cellFormName = e.target.value;
                                    this.update();
                                }}
                                placeholder='e.g., Fuel Pin'
                            />
                        </div>
                    </div>

                    {/* Fill Type Selection - Made more prominent */}
                    <div className='form-section fill-type-section'>
                        <label className='section-label'>What fills this cell?</label>
                        <div className='fill-type-options'>
                            <Tooltip content='Empty space (no material)' position='top'>
                                <button
                                    className={`fill-type-btn ${this.cellFormFillType === 'void' ? 'active' : ''}`}
                                    onClick={() => { this.cellFormFillType = 'void'; this.update(); }}
                                >
                                    <i className='codicon codicon-circle-outline'></i>
                                    <span>Void</span>
                                    <small>Empty space</small>
                                </button>
                            </Tooltip>
                            <Tooltip content='Fill with a material' position='top'>
                                <button
                                    className={`fill-type-btn ${this.cellFormFillType === 'material' ? 'active' : ''}`}
                                    onClick={() => { this.cellFormFillType = 'material'; this.update(); }}
                                >
                                    <i className='codicon codicon-symbol-color'></i>
                                    <span>Material</span>
                                    <small>e.g., Water, Fuel</small>
                                </button>
                            </Tooltip>
                            <Tooltip content='Fill with another universe (nesting)' position='top'>
                                <button
                                    className={`fill-type-btn ${this.cellFormFillType === 'universe' ? 'active' : ''}`}
                                    onClick={() => { this.cellFormFillType = 'universe'; this.update(); }}
                                >
                                    <i className='codicon codicon-layers'></i>
                                    <span>Universe</span>
                                    <small>Nested geometry</small>
                                </button>
                            </Tooltip>
                        </div>
                    </div>

                    {this.cellFormFillType === 'material' && (
                        <div className='form-group'>
                            <label>Material</label>
                            <div className='select-with-browse'>
                                <select
                                    value={this.cellFormFillId}
                                    onChange={e => {
                                        this.cellFormFillId = parseInt(e.target.value);
                                        this.update();
                                    }}
                                >
                                    <option value={0}>Select Material...</option>
                                    {state.materials.map(m => (
                                        <option key={m.id} value={m.id}>#{m.id}: {m.name}</option>
                                    ))}
                                </select>
                                <Tooltip content='Import materials from XML' position='top'>
                                    <button
                                        className='theia-button secondary small browse-btn'
                                        onClick={() => this.importMaterialsFromXML()}
                                    >
                                        <i className='codicon codicon-folder-opened'></i>
                                    </button>
                                </Tooltip>
                            </div>
                            {state.materials.length === 0 && (
                                <span className='form-hint warning'>
                                    No materials defined. Click the browse button to import from materials.xml or create in Simulation Dashboard.
                                </span>
                            )}
                        </div>
                    )}

                    {this.cellFormFillType === 'universe' && (
                        <div className='form-group'>
                            <label>Universe</label>
                            <div className='select-with-browse'>
                                <select
                                    value={this.cellFormFillId}
                                    onChange={e => {
                                        this.cellFormFillId = parseInt(e.target.value);
                                        this.update();
                                    }}
                                >
                                    <option value={0}>Select Universe...</option>
                                    {state.geometry.universes.filter(u => u.id !== 0).map(u => (
                                        <option key={u.id} value={u.id}>#{u.id}: {u.name || `Universe ${u.id}`}</option>
                                    ))}
                                </select>
                                <Tooltip content='Go to Universes tab' position='top'>
                                    <button
                                        className='theia-button secondary small browse-btn'
                                        onClick={() => {
                                            this.activeTab = 'universes';
                                            this.update();
                                        }}
                                    >
                                        <i className='codicon codicon-add'></i>
                                    </button>
                                </Tooltip>
                            </div>
                            {state.geometry.universes.filter(u => u.id !== 0).length === 0 && (
                                <span className='form-hint warning'>No universes defined. Click the + button to go to Universes tab and create one.</span>
                            )}
                        </div>
                    )}

                    {this.renderVisualRegionBuilder(state)}

                    <div className='form-group'>
                        <label>Temperature (K, optional)</label>
                        <input
                            type='number'
                            value={this.cellFormTemperature || ''}
                            onChange={e => {
                                const val = parseFloat(e.target.value);
                                this.cellFormTemperature = isNaN(val) ? undefined : val;
                                this.update();
                            }}
                            placeholder='e.g., 600'
                        />
                    </div>

                    <div className='form-actions'>
                        <button className='theia-button primary' onClick={() => this.saveCell()}>
                            {this.editingCell?.id ? 'Update Cell' : 'Create Cell'}
                        </button>
                        <button className='theia-button secondary' onClick={() => this.cancelForm()}>
                            Cancel
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // ============================================================================
    // Visual Region Builder
    // ============================================================================

    private renderVisualRegionBuilder(state: OpenMCState): React.ReactNode {
        return (
            <div className='form-group region-builder'>
                <label>Region Definition</label>
                
                {/* Instructions */}
                <div className='region-instructions'>
                    <div className='instruction-step'>
                        <span className='step-num'>1</span>
                        <span>Click surfaces below to add them to the region</span>
                    </div>
                    <div className='instruction-step'>
                        <span className='step-num'>2</span>
                        <span>Use operators for unions (|) and intersections (space)</span>
                    </div>
                    <div className='instruction-step'>
                        <span className='step-num'>3</span>
                        <span>Use parentheses to group operations: (-1 2) | 3</span>
                    </div>
                </div>

                {/* Current Region Display */}
                <div className='region-preview'>
                    <label>Current Region:</label>
                    <div className='region-tokens'>
                        {this.regionBuilderTokens.length === 0 ? (
                            <span className='empty-region'>Click surfaces below to build region...</span>
                        ) : (
                            this.regionBuilderTokens.map((token, idx) => (
                                <span key={idx} className={`region-token ${token.type} ${token.side || ''}`}>
                                    {token.type === 'surface' && token.side === 'positive' && '+'}
                                    {token.type === 'surface' && token.side === 'negative' && '-'}
                                    {token.type === 'surface' && `Surface ${token.id}`}
                                    {token.value === '(' && '('}
                                    {token.value === ')' && ')'}
                                    {token.value === 'union' && 'OR'}
                                    {token.value === 'complement' && 'NOT'}
                                </span>
                            ))
                        )}
                    </div>
                </div>

                {/* Region Text Input */}
                <div className='region-text-input'>
                    <input
                        type='text'
                        value={this.cellFormRegionString}
                        onChange={e => {
                            this.cellFormRegionString = e.target.value;
                            this.regionBuilderTokens = this.parseRegionToTokens(e.target.value);
                            this.update();
                        }}
                        placeholder='-1 2 -3  (surfaces combined with AND)   or   (-1 2) | 3  (union of intersections)'
                    />
                </div>

                {/* Operator Buttons */}
                <div className='operator-buttons'>
                    <Tooltip content='Union (OR) - Cell is in either region' position='top'>
                        <button className='theia-button secondary small' onClick={() => this.addOperatorToRegion('union')}>
                            <i className='codicon codicon-split-horizontal'></i> OR (|)
                        </button>
                    </Tooltip>
                    <Tooltip content='Open Parenthesis - Group operations' position='top'>
                        <button className='theia-button secondary small' onClick={() => this.addOperatorToRegion('open_paren')}>
                            (
                        </button>
                    </Tooltip>
                    <Tooltip content='Close Parenthesis - End group' position='top'>
                        <button className='theia-button secondary small' onClick={() => this.addOperatorToRegion('close_paren')}>
                            )
                        </button>
                    </Tooltip>
                    <Tooltip content='Remove Last' position='top'>
                        <button className='theia-button secondary small' onClick={() => this.removeLastToken()}>
                            <i className='codicon codicon-arrow-left'></i> Undo
                        </button>
                    </Tooltip>
                    <Tooltip content='Clear All' position='top'>
                        <button className='theia-button secondary small danger' onClick={() => this.clearRegion()}>
                            <i className='codicon codicon-trash'></i> Clear
                        </button>
                    </Tooltip>
                </div>

                {/* Surface Selector */}
                <div className='surface-selector'>
                    <label>Available Surfaces - Click to add:</label>
                    {state.geometry.surfaces.length === 0 ? (
                        <div className='no-surfaces-message'>
                            <i className='codicon codicon-info'></i>
                            No surfaces defined. Go to the Surfaces tab to create surfaces first.
                        </div>
                    ) : (
                        <div className='surface-buttons'>
                            {state.geometry.surfaces.map(surface => (
                                <div key={surface.id} className='surface-button-group'>
                                    <Tooltip content={`Surface #${surface.id}: ${surface.name || surface.type}`} position='top'>
                                        <span className='surface-label'>#{surface.id}</span>
                                    </Tooltip>
                                    <Tooltip content={`Negative side of surface #${surface.id}`} position='top'>
                                        <button 
                                            className='theia-button secondary small surface-side-btn negative'
                                            onClick={() => this.addSurfaceToRegion(surface.id, 'negative')}
                                        >
                                            -{surface.id}
                                        </button>
                                    </Tooltip>
                                    <Tooltip content={`Positive side of surface #${surface.id}`} position='top'>
                                        <button 
                                            className='theia-button secondary small surface-side-btn positive'
                                            onClick={() => this.addSurfaceToRegion(surface.id, 'positive')}
                                        >
                                            +{surface.id}
                                        </button>
                                    </Tooltip>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Examples */}
                <div className='region-examples'>
                    <label>Common Patterns:</label>
                    <div className='example-list'>
                        <div className='example'>
                            <code>-1 -2 -3 -4 -5 -6</code>
                            <span>Rectangular box (intersection of 6 planes)</span>
                        </div>
                        <div className='example'>
                            <code>-1 | -2</code>
                            <span>Union of two half-spaces</span>
                        </div>
                        <div className='example'>
                            <code>(-1 2) | (-3 4)</code>
                            <span>Two separate regions combined</span>
                        </div>
                        <div className='example'>
                            <code>-1 ~2</code>
                            <span>Inside surface 1 but outside surface 2</span>
                        </div>
                        <div className='example' style={{ color: '#ff6b6b' }}>
                            <code>-1 +1</code>
                            <span>❌ Invalid: Same surface with both signs!</span>
                        </div>
                    </div>
                    <div className='help-section' style={{ marginTop: '15px', borderTop: '1px solid #555', paddingTop: '10px' }}>
                        <h5>⚠️ Common Mistake</h5>
                        <p>A cell region like <code>-1 +1 -2 +2</code> is <strong>invalid</strong> because:</p>
                        <ul>
                            <li><code>-1</code> means inside surface 1</li>
                            <li><code>+1</code> means outside surface 1</li>
                            <li>These contradict each other!</li>
                        </ul>
                        <p><strong>Fix:</strong> Use only <code>-1 -2</code> for inside sphere AND outside cone.</p>
                    </div>
                </div>
            </div>
        );
    }

    // ============================================================================
    // Universes Tab
    // ============================================================================

    private renderUniversesTab(state: OpenMCState): React.ReactNode {
        // Get unassigned cells (not in any universe)
        const assignedCellIds = new Set<number>();
        state.geometry.universes.forEach(u => u.cellIds.forEach(id => assignedCellIds.add(id)));
        const unassignedCells = state.geometry.cells.filter(c => !assignedCellIds.has(c.id));

        return (
            <div className='universes-tab'>
                <div className='tab-toolbar'>
                    <h3>Universes</h3>
                    <Tooltip content='Create a new universe'>
                        <button
                            className='theia-button primary'
                            onClick={() => this.createUniverse()}
                        >
                            <i className='codicon codicon-add'></i> Add Universe
                        </button>
                    </Tooltip>
                </div>

                <div className='universes-info'>
                    <div className='info-box'>
                        <i className='codicon codicon-info'></i>
                        <span>
                            Universes allow you to group cells and reuse them in multiple places.
                            The root universe (ID: 0) contains top-level cells. Use the dropdowns below to assign cells to universes.
                        </span>
                    </div>
                </div>

                {/* Unassigned Cells Section */}
                {unassignedCells.length > 0 && (
                    <div className='unassigned-cells-section'>
                        <h4>Unassigned Cells ({unassignedCells.length})</h4>
                        <div className='cell-tags'>
                            {unassignedCells.map(cell => (
                                <span key={cell.id} className='cell-tag unassigned'>
                                    #{cell.id} {cell.name || ''}
                                    <select
                                        className='universe-select'
                                        value=''
                                        onChange={e => {
                                            if (e.target.value) {
                                                this.assignCellToUniverse(cell.id, parseInt(e.target.value));
                                            }
                                        }}
                                    >
                                        <option value=''>Assign to...</option>
                                        {state.geometry.universes.map(u => (
                                            <option key={u.id} value={u.id}>
                                                Universe #{u.id} {u.name || ''}
                                            </option>
                                        ))}
                                    </select>
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                <div className='universes-list'>
                    {state.geometry.universes.map(universe => (
                        <div 
                            key={universe.id} 
                            className={`universe-card ${universe.isRoot ? 'root' : ''}`}
                        >
                            <div className='universe-header'>
                                <div className='universe-info'>
                                    <span className='universe-id'>#{universe.id}</span>
                                    <span className='universe-name'>{universe.name || `Universe ${universe.id}`}</span>
                                    {universe.isRoot && <span className='root-badge'>ROOT</span>}
                                </div>
                                {!universe.isRoot && (
                                    <div className='universe-actions'>
                                        <Tooltip content='Delete Universe' position='top'>
                                            <button
                                                className='theia-button secondary small danger'
                                                onClick={() => this.deleteUniverse(universe.id)}
                                            >
                                                <i className='codicon codicon-trash'></i>
                                            </button>
                                        </Tooltip>
                                    </div>
                                )}
                            </div>
                            <div className='universe-cells'>
                                <label>Cells in this universe:</label>
                                <div className='cell-tags'>
                                    {universe.cellIds.length === 0 ? (
                                        <span className='no-cells'>No cells assigned</span>
                                    ) : (
                                        universe.cellIds.map(cellId => {
                                            const cell = state.geometry.cells.find(c => c.id === cellId);
                                            return (
                                                <span key={cellId} className='cell-tag assigned'>
                                                    #{cellId} {cell?.name || ''}
                                                    <Tooltip content='Remove from universe'>
                                                        <button
                                                            className='remove-cell-btn'
                                                            onClick={() => this.removeCellFromUniverse(cellId, universe.id)}
                                                        >
                                                            <i className='codicon codicon-close'></i>
                                                        </button>
                                                    </Tooltip>
                                                </span>
                                            );
                                        })
                                    )}
                                </div>
                                
                                {/* Add cells to this universe */}
                                {unassignedCells.length > 0 && (
                                    <div className='add-cells-to-universe'>
                                        <select
                                            value=''
                                            onChange={e => {
                                                if (e.target.value) {
                                                    this.assignCellToUniverse(parseInt(e.target.value), universe.id);
                                                }
                                            }}
                                        >
                                            <option value=''>+ Add cell to this universe...</option>
                                            {unassignedCells.map(cell => (
                                                <option key={cell.id} value={cell.id}>
                                                    #{cell.id}: {cell.name || `Cell ${cell.id}`}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>

                <div className='lattices-section'>
                    <div className='tab-toolbar'>
                        <h3>Lattices</h3>
                        <span className='coming-soon-badge'>Coming in Phase 3</span>
                    </div>
                    <div className='empty-state small'>
                        <p>Lattice creation will be available in the next phase.</p>
                    </div>
                </div>
            </div>
        );
    }

    private getFillDescription(cell: OpenMCCell, state: OpenMCState): string {
        switch (cell.fillType) {
            case 'void':
                return 'Void (empty)';
            case 'material': {
                const mat = state.materials.find(m => m.id === cell.fillId);
                return mat ? `#${mat.id}: ${mat.name}` : `Material #${cell.fillId}`;
            }
            case 'universe': {
                const univ = state.geometry.universes.find(u => u.id === cell.fillId);
                return univ ? `#${univ.id}: ${univ.name || `Universe ${univ.id}`}` : `Universe #${cell.fillId}`;
            }
            case 'lattice':
                return `Lattice #${cell.fillId}`;
            default:
                return 'Unknown';
        }
    }

    private getFillIcon(fillType: OpenMCFillType): string {
        switch (fillType) {
            case 'void': return 'circle-outline';
            case 'material': return 'symbol-color';
            case 'universe': return 'layers';
            case 'lattice': return 'grid';
            default: return 'question';
        }
    }

    // ============================================================================
    // Surface Actions
    // ============================================================================

    private startCreateSurface(template: SurfaceTemplate): void {
        this.editingSurface = { 
            id: 0, 
            type: template.type, 
            coefficients: { ...template.defaultCoeffs } as any,
            boundary: 'vacuum'
        };
        this.creatingSurfaceType = template.type;
        this.surfaceFormType = template.type;
        this.surfaceFormCoeffs = { ...template.defaultCoeffs };
        this.surfaceFormBoundary = 'vacuum';
        this.surfaceFormName = '';
        this.showSurfaceEditor = true;
        this.update();
    }

    private startEditSurface(surface: OpenMCSurface): void {
        this.editingSurface = { ...surface };
        this.surfaceFormType = surface.type;
        this.surfaceFormCoeffs = { ...surface.coefficients };
        this.surfaceFormBoundary = surface.boundary || 'vacuum';
        this.surfaceFormName = surface.name || '';
        this.showSurfaceEditor = true;
        this.update();
    }

    private changeSurfaceType(type: OpenMCSurfaceType): void {
        const template = SURFACE_TEMPLATES.find(t => t.type === type);
        if (!template) return;
        
        this.surfaceFormType = type;
        this.surfaceFormCoeffs = { ...template.defaultCoeffs };
        this.editingSurface = {
            ...this.editingSurface!,
            type: type,
            coefficients: { ...template.defaultCoeffs } as any
        };
        this.update();
    }

    private async saveSurface(): Promise<void> {
        if (!this.editingSurface) return;

        const surface: OpenMCSurface = {
            id: this.editingSurface.id || this.stateManager.getNextSurfaceId(),
            type: this.surfaceFormType,
            coefficients: { ...this.surfaceFormCoeffs } as any,
            boundary: this.surfaceFormBoundary,
            name: this.surfaceFormName || undefined
        };

        if (this.editingSurface.id) {
            this.stateManager.updateSurface(this.editingSurface.id, surface);
            this.messageService.info(`Updated surface #${surface.id}`);
        } else {
            this.stateManager.addSurface(surface);
            this.messageService.info(`Created surface #${surface.id}`);
        }

        this.cancelForm();
    }

    private deleteSurface(id: number): void {
        // Check if surface is used in any cell regions
        const state = this.stateManager.getState();
        const usedInCells = state.geometry.cells.filter(cell => 
            cell.regionString && cell.regionString.includes(id.toString())
        );
        
        if (usedInCells.length > 0) {
            this.messageService.warn(`Surface #${id} is used in cells: ${usedInCells.map(c => `#${c.id}`).join(', ')}. Remove from cells first.`);
            return;
        }

        this.stateManager.removeSurface(id);
        this.messageService.info(`Deleted surface #${id}`);
    }

    // ============================================================================
    // Cell Actions
    // ============================================================================

    private startCreateCell(): void {
        this.editingCell = { id: 0, fillType: 'void' };
        this.cellFormName = '';
        this.cellFormFillType = 'void';
        this.cellFormFillId = 0;
        this.cellFormRegionString = '';
        this.cellFormTemperature = undefined;
        this.regionBuilderTokens = [];
        this.update();
    }

    private startEditCell(cell: OpenMCCell): void {
        this.editingCell = { ...cell };
        this.cellFormName = cell.name || '';
        this.cellFormFillType = cell.fillType;
        this.cellFormFillId = cell.fillId || 0;
        this.cellFormRegionString = cell.regionString || '';
        this.cellFormTemperature = cell.temperature;
        // Parse existing region into tokens
        this.regionBuilderTokens = this.parseRegionToTokens(cell.regionString || '');
        this.update();
    }

    private parseRegionToTokens(regionString: string): { type: 'surface' | 'operator'; value: string; id?: number; side?: 'positive' | 'negative' | 'complement' }[] {
        if (!regionString) return [];
        
        const tokens: { type: 'surface' | 'operator'; value: string; id?: number; side?: 'positive' | 'negative' | 'complement' }[] = [];
        // Split by spaces but keep parentheses and operators
        const parts = regionString.match(/\(|\)|\||~|~?\d+/g) || [];
        
        for (const part of parts) {
            if (part === '(' || part === ')') {
                tokens.push({ type: 'operator', value: part });
            } else if (part === '|') {
                tokens.push({ type: 'operator', value: 'union' });
            } else if (part === '~') {
                tokens.push({ type: 'operator', value: 'complement' });
            } else if (part.startsWith('~')) {
                tokens.push({ type: 'surface', value: part, id: parseInt(part.substring(1)), side: 'complement' });
            } else if (part.startsWith('+')) {
                tokens.push({ type: 'surface', value: part, id: parseInt(part.substring(1)), side: 'positive' });
            } else if (part.startsWith('-')) {
                tokens.push({ type: 'surface', value: part, id: parseInt(part.substring(1)), side: 'negative' });
            } else {
                const id = parseInt(part);
                tokens.push({ type: 'surface', value: `-${part}`, id: Math.abs(id), side: 'negative' });
            }
        }
        return tokens;
    }

    private addSurfaceToRegion(surfaceId: number, side: 'positive' | 'negative'): void {
        const prefix = side === 'positive' ? '+' : '-';
        this.regionBuilderTokens.push({ type: 'surface', value: `${prefix}${surfaceId}`, id: surfaceId, side });
        this.updateRegionStringFromTokens();
        this.update();
    }

    private addOperatorToRegion(operator: 'intersection' | 'union' | 'complement' | 'open_paren' | 'close_paren'): void {
        const opMap: { [key: string]: string } = {
            'intersection': 'intersection',
            'union': 'union',
            'complement': 'complement',
            'open_paren': '(',
            'close_paren': ')'
        };
        this.regionBuilderTokens.push({ type: 'operator', value: opMap[operator] });
        this.updateRegionStringFromTokens();
        this.update();
    }

    private removeLastToken(): void {
        this.regionBuilderTokens.pop();
        this.updateRegionStringFromTokens();
        this.update();
    }

    private clearRegion(): void {
        this.regionBuilderTokens = [];
        this.updateRegionStringFromTokens();
        this.update();
    }

    private updateRegionStringFromTokens(): void {
        const parts = this.regionBuilderTokens.map(token => {
            if (token.type === 'surface') {
                return token.value;
            } else {
                // operator
                if (token.value === 'union') return '|';
                if (token.value === 'complement') return '~';
                if (token.value === 'intersection') return '';
                return token.value;
            }
        });
        
        // Join with spaces, but handle parentheses nicely
        let result = '';
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (part === '(' || part === ')') {
                result += part;
            } else if (part === '|') {
                result += ' | ';
            } else if (part === '~') {
                result += '~';
            } else if (part) {
                if (result && !result.endsWith('(') && !result.endsWith('~')) {
                    result += ' ';
                }
                result += part;
            }
        }
        this.cellFormRegionString = result.trim();
        
        // Check for contradictory surface usage
        this.checkRegionContradictions();
    }
    
    private checkRegionContradictions(): void {
        const surfaceSides = new Map<number, Set<string>>();
        
        for (const token of this.regionBuilderTokens) {
            if (token.type === 'surface' && token.id !== undefined) {
                if (!surfaceSides.has(token.id)) {
                    surfaceSides.set(token.id, new Set());
                }
                surfaceSides.get(token.id)!.add(token.side || 'positive');
            }
        }
        
        for (const [id, sides] of surfaceSides) {
            if (sides.has('positive') && sides.has('negative')) {
                // Show warning but allow it
                console.warn(`[CSG Builder] Warning: Surface ${id} used on both sides (+${id} and -${id}). This creates an empty/impossible region.`);
            }
        }
    }

    private saveCell(): void {
        if (!this.editingCell) return;

        // Validate region expression if provided
        if (this.cellFormRegionString) {
            const valid = this.validateRegionString(this.cellFormRegionString);
            if (!valid) {
                this.messageService.error('Invalid region expression. Use surface IDs with + or - prefixes.');
                return;
            }
            
            // Check for contradictory terms
            if (this.hasContradictoryRegion(this.cellFormRegionString)) {
                this.messageService.error(
                    'Region has contradictory terms (same surface with both + and -). ' +
                    'A cell cannot be both inside and outside the same surface. ' +
                    'Remove one of the conflicting terms.'
                );
                return;
            }
        }

        const cell: OpenMCCell = {
            id: this.editingCell.id || this.stateManager.getNextCellId(),
            name: this.cellFormName || undefined,
            fillType: this.cellFormFillType,
            fillId: this.cellFormFillType !== 'void' ? this.cellFormFillId : undefined,
            regionString: this.cellFormRegionString || undefined,
            temperature: this.cellFormTemperature
        };

        // Parse region string to tree (simplified - just store string for now)
        if (cell.regionString) {
            cell.region = this.parseRegionString(cell.regionString);
        }

        if (this.editingCell.id) {
            this.stateManager.updateCell(this.editingCell.id, cell);
            this.messageService.info(`Updated cell #${cell.id}`);
        } else {
            this.stateManager.addCell(cell);
            // Add cell to root universe by default
            const state = this.stateManager.getState();
            const rootUniverse = state.geometry.universes.find(u => u.id === 0);
            if (rootUniverse) {
                rootUniverse.cellIds.push(cell.id);
            }
            this.messageService.info(`Created cell #${cell.id}`);
        }

        this.cancelForm();
    }

    private deleteCell(id: number): void {
        this.stateManager.removeCell(id);
        // Remove from universes
        const state = this.stateManager.getState();
        state.geometry.universes.forEach(universe => {
            const idx = universe.cellIds.indexOf(id);
            if (idx >= 0) {
                universe.cellIds.splice(idx, 1);
            }
        });
        this.messageService.info(`Deleted cell #${id}`);
    }

    private validateRegionString(region: string): boolean {
        // Basic validation: check for surface IDs with +/-
        // Remove parentheses and operators
        const cleaned = region.replace(/[()|~\s]/g, ' ').trim();
        if (!cleaned) return true; // Empty region is valid (fills all space)
        
        const tokens = cleaned.split(/\s+/).filter(t => t);
        for (const token of tokens) {
            // Each token should be +/- followed by a number
            if (!token.match(/^[+-]?\d+$/)) {
                return false;
            }
        }
        return true;
    }
    
    private hasContradictoryRegion(region: string): boolean {
        // Check if same surface appears with both + and -
        const surfaceSides = new Map<number, Set<string>>();
        
        // Extract surface references: +/- followed by number
        const matches = region.match(/[+-]?\d+/g) || [];
        
        for (const match of matches) {
            const sign = match.startsWith('-') ? '-' : '+';
            const id = parseInt(match.replace(/[+-]/, ''));
            
            if (!surfaceSides.has(id)) {
                surfaceSides.set(id, new Set());
            }
            surfaceSides.get(id)!.add(sign);
        }
        
        // Check if any surface has both + and -
        for (const [_id, sides] of surfaceSides) {
            if (sides.has('+') && sides.has('-')) {
                return true;
            }
        }
        
        return false;
    }

    private parseRegionString(region: string): OpenMCRegionNode {
        // Simplified parser - for now just return a placeholder
        // Full parser would be implemented in Phase 3
        return { type: 'operator', operator: 'intersection', children: [] };
    }

    // ============================================================================
    // Material Import
    // ============================================================================

    private async importMaterialsFromXML(): Promise<void> {
        const uri = await this.fileDialogService.showOpenDialog({
            title: 'Select materials.xml File',
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'XML Files': ['xml'],
                'All Files': ['*']
            }
        });
        
        if (!uri) {
            return;
        }

        try {
            // Get the directory containing the materials.xml
            const directory = uri.parent.path.toString();
            
            // Use the backend service to import the XML
            const result = await this.xmlService.importXML({
                directory,
                options: {
                    mergeStrategy: 'replace',
                    validate: true
                }
            });
            
            if (result.success && result.state) {
                // Merge only materials from the imported state
                const currentState = this.stateManager.getState();
                const importedMaterials = result.state.materials || [];
                
                if (importedMaterials.length === 0) {
                    this.messageService.warn('No materials found in the selected file');
                    return;
                }
                
                // Add imported materials (replace if same ID exists)
                for (const material of importedMaterials) {
                    const existingIdx = currentState.materials.findIndex(m => m.id === material.id);
                    if (existingIdx >= 0) {
                        currentState.materials[existingIdx] = material;
                    } else {
                        currentState.materials.push(material);
                    }
                }
                
                this.stateManager.setState(currentState);
                this.messageService.info(`Imported ${importedMaterials.length} materials from XML`);
            } else {
                this.messageService.warn(`Could not import materials: ${result.errors?.join(', ') || 'Unknown error'}`);
            }
        } catch (error) {
            this.messageService.error(`Error importing materials: ${error}`);
        }
    }

    private async importGeometryFromXML(): Promise<void> {
        const props: OpenFileDialogProps = {
            title: 'Select Directory with XML Files',
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false
        };

        const uri = await this.fileDialogService.showOpenDialog(props);
        if (!uri) {
            return;
        }

        try {
            const result = await this.xmlService.importXML({
                directory: uri.path.toString(),
                options: {
                    mergeStrategy: 'replace',
                    validate: true
                }
            });

            if (result.success && result.state) {
                this.stateManager.setState(result.state);
                const cellCount = result.state.geometry?.cells?.length || 0;
                const surfCount = result.state.geometry?.surfaces?.length || 0;
                const matCount = result.state.materials?.length || 0;
                
                // Set save location to the import directory for auto-save
                this.saveOutputPath = uri.path.toString();
                this.update();
                
                this.messageService.info(
                    `Imported: ${cellCount} cells, ${surfCount} surfaces, ${matCount} materials from ${this.saveOutputPath}`
                );
                
                if (result.warnings && result.warnings.length > 0) {
                    console.warn('[CSG Builder] Import warnings:', result.warnings);
                }
            } else {
                this.messageService.error(`Import failed: ${result.errors?.join(', ')}`);
            }
        } catch (error) {
            this.messageService.error(`Error importing XML: ${error}`);
        }
    }

    // ============================================================================
    // Universe Actions
    // ============================================================================

    private createUniverse(): void {
        const id = this.stateManager.getNextUniverseId();
        const universe: OpenMCUniverse = {
            id,
            name: `Universe ${id}`,
            cellIds: []
        };
        
        // Add to state manually since stateManager doesn't have a direct method
        const state = this.stateManager.getState();
        state.geometry.universes.push(universe);
        this.stateManager.setState(state);
        this.messageService.info(`Created universe #${id}`);
    }

    private deleteUniverse(id: number): void {
        const state = this.stateManager.getState();
        const idx = state.geometry.universes.findIndex(u => u.id === id);
        if (idx >= 0) {
            // Check if universe is used in any cells
            const usedInCells = state.geometry.cells.filter(cell => 
                cell.fillType === 'universe' && cell.fillId === id
            );
            
            if (usedInCells.length > 0) {
                this.messageService.warn(`Universe #${id} is used in cells: ${usedInCells.map(c => `#${c.id}`).join(', ')}. Remove from cells first.`);
                return;
            }

            state.geometry.universes.splice(idx, 1);
            this.stateManager.setState(state);
            this.messageService.info(`Deleted universe #${id}`);
        }
    }

    private assignCellToUniverse(cellId: number, universeId: number): void {
        const state = this.stateManager.getState();
        
        // Remove cell from all universes first
        state.geometry.universes.forEach(u => {
            const idx = u.cellIds.indexOf(cellId);
            if (idx >= 0) {
                u.cellIds.splice(idx, 1);
            }
        });
        
        // Add to target universe
        const universe = state.geometry.universes.find(u => u.id === universeId);
        if (universe) {
            universe.cellIds.push(cellId);
            this.stateManager.setState(state);
            this.messageService.info(`Assigned cell #${cellId} to universe #${universeId}`);
        }
    }

    private removeCellFromUniverse(cellId: number, universeId: number): void {
        const state = this.stateManager.getState();
        const universe = state.geometry.universes.find(u => u.id === universeId);
        if (universe) {
            const idx = universe.cellIds.indexOf(cellId);
            if (idx >= 0) {
                universe.cellIds.splice(idx, 1);
                this.stateManager.setState(state);
                this.messageService.info(`Removed cell #${cellId} from universe #${universeId}`);
            }
        }
    }

    // ============================================================================
    // Save / Save As
    // ============================================================================

    private renderSaveButtons(): React.ReactNode {
        if (this.saveOutputPath) {
            // Have a save location - show Save and Save As
            return (
                <>
                    <Tooltip content={`Save to ${this.saveOutputPath}`} position='bottom'>
                        <button
                            className='theia-button primary'
                            onClick={() => this.saveXML()}
                        >
                            <i className='codicon codicon-save'></i>
                            Save
                        </button>
                    </Tooltip>
                    <Tooltip content='Save to different location' position='bottom'>
                        <button
                            className='theia-button secondary'
                            onClick={() => this.saveXMLAs()}
                        >
                            <i className='codicon codicon-save-as'></i>
                            Save As...
                        </button>
                    </Tooltip>
                </>
            );
        } else {
            // No save location yet - show Save As only
            return (
                <Tooltip content='Save geometry.xml to a folder' position='bottom'>
                    <button
                        className='theia-button primary'
                        onClick={() => this.saveXMLAs()}
                    >
                        <i className='codicon codicon-save'></i>
                        Save As...
                    </button>
                </Tooltip>
            );
        }
    }

    private async saveXML(): Promise<void> {
        if (!this.saveOutputPath) {
            return this.saveXMLAs();
        }
        await this.performSave(this.saveOutputPath, true);
    }

    private async saveXMLAs(): Promise<void> {
        const uri = await this.fileDialogService.showOpenDialog({
            title: 'Select Output Directory for geometry.xml',
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false
        });
        
        if (!uri) {
            return;
        }

        const selectedUri = Array.isArray(uri) ? uri[0] : uri;
        const outputPath = selectedUri.path.toString();
        
        const success = await this.performSave(outputPath, true);
        if (success) {
            this.saveOutputPath = outputPath;
            this.update();
        }
    }

    private autoSaveToCurrentPath(): void {
        if (!this.saveOutputPath) {
            return;
        }

        // Clear existing timer
        if (this.autoSaveDebounceTimer) {
            window.clearTimeout(this.autoSaveDebounceTimer);
        }

        // Debounce for 1 second
        this.autoSaveDebounceTimer = window.setTimeout(() => {
            this.performSave(this.saveOutputPath!, false);
        }, 1000);
    }

    private async performSave(outputPath: string, showMessages: boolean): Promise<boolean> {
        const state = this.stateManager.getState();
        if (state.geometry.cells.length === 0) {
            if (showMessages) {
                this.messageService.warn('No cells defined. Create at least one cell before saving.');
            }
            return false;
        }

        try {
            const result = await this.xmlService.generateXML({
                state,
                outputDirectory: outputPath,
                files: {
                    geometry: true,
                    materials: state.materials.length > 0,
                    settings: false,
                    tallies: false,
                    plots: false
                }
            });

            if (result.success) {
                if (showMessages) {
                    const geomFile = result.generatedFiles.find(f => f.includes('geometry.xml'));
                    this.messageService.info(`Saved: ${geomFile ? geomFile.split('/').pop() : 'geometry.xml'}`);
                } else {
                    console.log('[CSG Builder] Auto-saved to', outputPath);
                }
                return true;
            } else {
                if (showMessages) {
                    this.messageService.error(`Failed to save: ${result.error}`);
                }
                return false;
            }
        } catch (error) {
            if (showMessages) {
                this.messageService.error(`Error saving: ${error}`);
            }
            return false;
        }
    }

    // ============================================================================
    // 3D Preview
    // ============================================================================

    private async previewGeometry(): Promise<void> {
        const state = this.stateManager.getState();
        
        if (state.geometry.cells.length === 0) {
            this.messageService.warn('No cells defined. Create at least one cell before previewing.');
            return;
        }

        // Need a save location to preview
        let previewDir = this.saveOutputPath;
        if (!previewDir) {
            this.messageService.warn('Please save the geometry first (click Save As)');
            await this.saveXMLAs();
            previewDir = this.saveOutputPath;
            if (!previewDir) {
                return; // User cancelled
            }
        }

        try {
            // Save current geometry
            await this.performSave(previewDir, false);

            const geomFile = `${previewDir}/geometry.xml`;
            const uri = new URI(geomFile);

            // Open or create the 3D widget
            let widget = this.previewWidget;
            if (!widget || widget.isDisposed) {
                widget = await this.widgetManager.getOrCreateWidget<OpenMCGeometry3DWidget>(
                    OpenMCGeometry3DWidget.ID,
                    { id: `${OpenMCGeometry3DWidget.ID}:preview` } as any
                );
                this.previewWidget = widget;
            }

            // Show widget
            if (!widget.isAttached) {
                await this.shell.addWidget(widget, { area: 'main' });
            }
            await this.shell.activateWidget(widget.id);

            // Set geometry and start visualization
            widget.setGeometry(uri);
            widget.setLoading(true);

            // Start visualization server
            const vizResult = await this.openmcService.visualizeGeometry(uri);

            if (vizResult.success && vizResult.url && vizResult.port) {
                widget.setServerInfo(vizResult.url, vizResult.port);
                this.messageService.info('3D preview loaded');
            } else {
                widget.setError(vizResult.error || 'Failed to start visualization');
                this.messageService.error(`Preview failed: ${vizResult.error}`);
            }

        } catch (error) {
            this.messageService.error(`Preview error: ${error}`);
        }
    }

    // ============================================================================
    // Form Utilities
    // ============================================================================

    private cancelForm(): void {
        this.editingSurface = undefined;
        this.creatingSurfaceType = undefined;
        this.editingCell = undefined;
        this.surfaceFormType = 'sphere';
        this.surfaceFormCoeffs = {};
        this.surfaceFormBoundary = 'vacuum';
        this.surfaceFormName = '';
        this.showSurfaceEditor = false;
        this.cellFormName = '';
        this.cellFormFillType = 'void';
        this.cellFormFillId = 0;
        this.cellFormRegionString = '';
        this.cellFormTemperature = undefined;
        this.regionBuilderTokens = [];

        this.update();
    }
}
