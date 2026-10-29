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
import * as path from 'path';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { MessageService } from '@theia/core/lib/common/message-service';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { FileDialogService, OpenFileDialogProps } from '@theia/filesystem/lib/browser';
import URI from '@theia/core/lib/common/uri';
import { OpenMCStateManager } from '../../openmc-state-manager';
import { NukeCoreStatusBarVisibility, NukeCoreStatusBarVisibilityService } from 'nuke-core/lib/common';
import { OpenMCXMLGenerationService } from '../../xml-generator/xml-generation-service';
import { NukeSelect } from 'nuke-essentials/lib/theme/browser/components';
import { Tooltip, useTooltip } from 'nuke-essentials/lib/theme/browser/components/tooltip';
import { LoadingAnimations, FancyLoadingSpinner } from 'nuke-essentials/lib/theme/browser/components/loading-spinner';
import { OpenMCStudioBackendService, CADImportResult, ValidationIssue } from '../../../common/openmc-studio-protocol';
import {
    OpenMCState,
    OpenMCSurface,
    OpenMCSurfaceType,
    OpenMCSurfaceCoefficients,
    OpenMCCell,
    OpenMCRegionNode,
    OpenMCBoundaryCondition,
    OpenMCFillType,
    OpenMCUniverse,
    OpenMCLattice,
    OpenMCHexLattice,
    OpenMCHexOrientation,
    OpenMCRectLattice,
    DAGMCInfo
} from '../../../common/openmc-state-schema';
import { resizeHexLatticeUniverses, resizeRectLatticeUniverses } from '../../../common/geometry-lattices';
import { isAlbedoBoundary, validateGeometryModel } from '../../../common/geometry-validation';
import {
    clearLatticeUniverses,
    emptyLatticeUniverses,
    fillAllLatticeUniverses,
    fillLatticeRing,
    fillLatticeRow,
    fillTargetError,
    geometryIssueAnchor,
    geometryIssueTab,
    latticeReferencedUniverses,
    latticeRingSizes,
    latticeSummary,
    parseAlbedoInput,
    parseDensityOverride,
    parseOptionalVectorInput,
    periodicPartnerCandidates,
    setLatticePosition,
    summarizeGeometryIssues
} from '../../../common/geometry-editor';
import { CSGValidationBanner } from './csg-validation-banner';
import { CSGFillTargetPicker } from './csg-fill-picker';
import { HexLatticeRings, LatticeBrush, RectLatticeGrid } from './csg-lattice-editor';

// 3D preview reuses the nuke-visualizer native geometry viewer through
// OpenMCService.openGeometryViewer (no visualization infrastructure here).
import { OpenMCService } from 'nuke-visualizer/lib/browser/plugins/openmc/openmc-service';

/**
 * Active tab identifier for the CSG Builder widget.
 */
export type CSGBuilderTab = 'surfaces' | 'cells' | 'universes' | 'lattices';

/**
 * Template definition for a creatable surface type.
 */
interface SurfaceTemplate {
    /** OpenMC surface type identifier. */
    type: OpenMCSurfaceType;
    /** Human-readable display name. */
    name: string;
    /** Codicon icon class name. */
    icon: string;
    /** Tooltip description shown on hover. */
    description: string;
    /** Default coefficient values for the surface type. */
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
        type: 'cylinder',
        name: 'General Cylinder',
        icon: 'circle-filled',
        description: 'Cylinder with arbitrary axis direction',
        defaultCoeffs: { x0: 0, y0: 0, z0: 0, r: 1, vx: 0, vy: 0, vz: 1 }
    },
    {
        type: 'x-torus',
        name: 'X-Torus',
        icon: 'circle-outline',
        description: 'Torus parallel to x-axis',
        defaultCoeffs: { x0: 0, y0: 0, z0: 0, a: 5, b: 1, c: 0 }
    },
    {
        type: 'y-torus',
        name: 'Y-Torus',
        icon: 'circle-outline',
        description: 'Torus parallel to y-axis',
        defaultCoeffs: { x0: 0, y0: 0, z0: 0, a: 5, b: 1, c: 0 }
    },
    {
        type: 'z-torus',
        name: 'Z-Torus',
        icon: 'circle-outline',
        description: 'Torus parallel to z-axis',
        defaultCoeffs: { x0: 0, y0: 0, z0: 0, a: 5, b: 1, c: 0 }
    },
    {
        type: 'quadric',
        name: 'Quadric',
        icon: 'symbol-misc',
        description: 'General quadric surface (10 coefficients)',
        defaultCoeffs: { a: 1, b: 1, c: 1, d: 0, e: 0, f: 0, g: 0, h: 0, j: 0, k: -1 }
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

/**
 * Widget for constructing and editing OpenMC Constructive Solid Geometry (CSG).
 *
 * Provides a visual interface for creating surfaces, defining cells with region
 * expressions, managing universes and lattices, and importing CAD/DAGMC files.
 *
 * @see {@link SimulationDashboardWidget} for simulation settings and material management
 */
@injectable()
export class CSGBuilderWidget extends ReactWidget {
    /** Unique widget identifier. */
    static readonly ID = 'openmc-csg-builder';
    /** Display label for the widget title. */
    static readonly LABEL = 'CSG Geometry Builder';

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    @inject(OpenMCStateManager)
    protected readonly stateManager!: OpenMCStateManager;

    @inject(FileDialogService)
    protected readonly fileDialogService!: FileDialogService;

    @inject(OpenMCXMLGenerationService)
    protected readonly xmlService!: OpenMCXMLGenerationService;

    @inject(OpenMCService)
    protected readonly openmcService!: OpenMCService;

    @inject(CommandRegistry)
    protected readonly commands!: CommandRegistry;

    @inject(OpenMCStudioBackendService)
    protected readonly backendService!: OpenMCStudioBackendService;

    @inject(PreferenceService)
    protected readonly preferences!: PreferenceService;

    @inject(NukeCoreStatusBarVisibility)
    protected readonly statusBarVisibility!: NukeCoreStatusBarVisibilityService;

    private activeTab: CSGBuilderTab = 'surfaces';
    private visibilityHandle?: { dispose: () => void };

    // Surface form state
    private editingSurface?: OpenMCSurface;
    private creatingSurfaceType?: OpenMCSurfaceType;
    private surfaceFormType: OpenMCSurfaceType = 'sphere';
    private surfaceFormCoeffs: Partial<OpenMCSurfaceCoefficients[OpenMCSurfaceType]> = {};
    private surfaceFormBoundary: OpenMCBoundaryCondition = 'vacuum';
    private surfaceFormName = '';
    private surfaceFormAlbedo = '';
    private surfaceFormPeriodicId = '';
    private showSurfaceEditor = false;

    // Save location - if set, auto-saves happen here
    private saveOutputPath?: string;
    private autoSaveDebounceTimer?: number;

    // CAD import loading state
    private isImportingCAD = false;

    // Cell form state
    private editingCell?: OpenMCCell;
    private cellFormName = '';
    private cellFormFillType: OpenMCFillType = 'void';
    private cellFormFillId = 0;
    private cellFormRegionString = '';
    private cellFormTemperature?: number;
    private cellFormRotation: [string, string, string] = ['', '', ''];
    private cellFormTranslation: [string, string, string] = ['', '', ''];
    private cellFormDensity = '';

    // Lattice editor state
    private latticeDraft?: OpenMCLattice;
    private latticeBrush: LatticeBrush = 'paint';
    private latticeBrushUniverse = 1;
    private latticeLayer = 0;

    // Visual region builder state
    private regionBuilderTokens: {
        type: 'surface' | 'operator';
        value: string;
        id?: number;
        side?: 'positive' | 'negative' | 'complement';
    }[] = [];

    /**
     * Initialize widget id, title, and state change listeners.
     */
    @postConstruct()
    protected init(): void {
        this.id = CSGBuilderWidget.ID;
        this.title.label = CSGBuilderWidget.LABEL;
        this.title.caption = CSGBuilderWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-openmc-geometry';

        // Listen to state changes (both change events and reload events)
        this.stateManager.onStateChange(() => {
            this.update();
            this.autoSaveToCurrentPath();
        });
        this.stateManager.onStateReload(() => {
            this.latticeDraft = undefined;
            this.latticeLayer = 0;
            this.cancelForm();
        });

        this.update();
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
     * Render the CSG builder main layout.
     * @returns The React element tree for the widget.
     */
    protected render(): React.ReactNode {
        const state = this.stateManager.getState();
        const isDagmcMode = !!state.settings.dagmcFile;

        return (
            <div className={`csg-builder ${isDagmcMode ? 'dagmc' : ''}`}>
                <LoadingAnimations />
                {this.renderHeader(isDagmcMode)}
                {this.renderTabs()}
                {!isDagmcMode && this.renderValidationBanner(state)}
                <div className="csg-builder-content">
                    {this.activeTab === 'surfaces' && this.renderSurfacesTab(state)}
                    {this.activeTab === 'cells' && this.renderCellsTab(state)}
                    {this.activeTab === 'universes' && this.renderUniversesTab(state)}
                    {this.activeTab === 'lattices' && this.renderLatticesTab(state)}
                </div>
                {this.isImportingCAD && (
                    <div className="csg-builder-importing-overlay">
                        <FancyLoadingSpinner message="Importing CAD file..." subMessage="This may take a moment for large models" />
                    </div>
                )}
            </div>
        );
    }

    /**
     * Render the widget header with stats and action buttons.
     * @param isDagmcMode - Whether DAGMC geometry mode is active.
     * @returns Header React node.
     */
    private renderHeader(isDagmcMode: boolean): React.ReactNode {
        return (
            <div className="csg-builder-header">
                <div className="header-info">
                    <h2>
                        <i className="codicon codicon-openmc-geometry"></i>
                        CSG Geometry Builder
                    </h2>
                    <p className="header-description">Constructive Solid Geometry editor for OpenMC</p>
                </div>
                <div className="header-actions">
                    {isDagmcMode ? (
                        <Tooltip content="Edit DAGMC geometry" position="bottom">
                            <button className="theia-button secondary dagmc-editor-btn" onClick={() => this.openDagmcEditor()}>
                                <i className="codicon codicon-openmc-mesh"></i>
                                DAGMC Editor
                            </button>
                        </Tooltip>
                    ) : (
                        <Tooltip content="Preview geometry in 3D viewer" position="bottom">
                            <button
                                className="theia-button secondary"
                                onClick={() => this.previewGeometry()}
                                disabled={this.stateManager.getState().geometry.cells.length === 0}
                            >
                                <i className="codicon codicon-globe"></i>
                                Preview 3D
                            </button>
                        </Tooltip>
                    )}
                    <Tooltip content="Import geometry from XML files" position="bottom">
                        <button className="theia-button secondary" onClick={() => this.importGeometryFromXML()}>
                            <i className="codicon codicon-folder-opened"></i>
                            Import XML
                        </button>
                    </Tooltip>
                    <Tooltip content="Import CAD file (STEP/IGES/DAGMC)" position="bottom">
                        <button className="theia-button secondary" onClick={() => this.importCADFile()}>
                            <i className="codicon codicon-openmc-mesh"></i>
                            Import CAD
                        </button>
                    </Tooltip>
                    {this.renderSaveButtons()}
                </div>
                <div className="header-stats">
                    <div className="stat-item">
                        <span className="stat-value">{this.stateManager.getState().geometry.surfaces.length}</span>
                        <span className="stat-label">Surfaces</span>
                    </div>
                    <div className="stat-item">
                        <span className="stat-value">{this.stateManager.getState().geometry.cells.length}</span>
                        <span className="stat-label">Cells</span>
                    </div>
                    <div className="stat-item">
                        <span className="stat-value">{this.stateManager.getState().geometry.universes.length}</span>
                        <span className="stat-label">Universes</span>
                    </div>
                    <div className="stat-item">
                        <span className="stat-value">{this.stateManager.getState().geometry.lattices.length}</span>
                        <span className="stat-label">Lattices</span>
                    </div>
                </div>
            </div>
        );
    }

    /**
     * Render the tab selector for Surfaces, Cells, Universes, and Lattices.
     * @returns Tabs React node.
     */
    private renderTabs(): React.ReactNode {
        const state = this.stateManager.getState();
        const isDagmcMode = !!state.settings.dagmcFile;

        const tabs: { id: CSGBuilderTab; label: string; icon: string }[] = [
            { id: 'surfaces', label: 'Surfaces', icon: 'codicon-openmc-surface' },
            { id: 'cells', label: 'Cells', icon: 'codicon-openmc-cell' },
            { id: 'universes', label: 'Universes', icon: 'codicon-openmc-universe' },
            { id: 'lattices', label: 'Lattices', icon: 'codicon-openmc-lattice' }
        ];

        return (
            <div className="csg-builder-tabs">
                {tabs.map((tab) => (
                    <Tooltip key={tab.id} content={tab.label} position="bottom">
                        <button
                            className={`tab-button ${this.activeTab === tab.id ? 'active' : ''} ${isDagmcMode ? 'dagmc-mode' : ''}`}
                            aria-label={tab.label}
                            onClick={() => {
                                this.activeTab = tab.id;
                                this.cancelForm();
                                this.update();
                            }}
                        >
                            <i className={`codicon ${tab.icon}`}></i>
                            <span className="tab-label">{tab.label}</span>
                        </button>
                    </Tooltip>
                ))}
            </div>
        );
    }

    // ============================================================================
    // Validation Banner
    // ============================================================================

    /**
     * Render the geometry validation banner. The issue list is the same
     * `validateGeometryModel` result used by run readiness, so the two can
     * never disagree.
     * @param state - Current simulation state.
     * @returns Banner React node, or null when the model is clean.
     */
    private renderValidationBanner(state: OpenMCState): React.ReactNode {
        const summary = summarizeGeometryIssues(validateGeometryModel(state.geometry));
        if (summary.errors === 0 && summary.warnings === 0) {
            return null;
        }
        return <CSGValidationBanner summary={summary} onIssueClick={(issue) => this.focusGeometryIssue(issue)} />;
    }

    /**
     * Switch to the tab that owns a validation issue, open the affected editor
     * when possible, and scroll/focus its anchor.
     * @param issue - Issue selected in the validation banner.
     */
    private focusGeometryIssue(issue: ValidationIssue): void {
        const tab = geometryIssueTab(issue) as CSGBuilderTab;
        this.activeTab = tab;
        const idMatch = issue.path?.match(/\.(\d+)$/) ?? issue.message.match(/#(\d+)/);
        const id = idMatch ? Number(idMatch[1]) : undefined;
        const state = this.stateManager.getState();

        if (id !== undefined) {
            if (tab === 'cells') {
                const cell = state.geometry.cells.find((candidate) => candidate.id === id);
                if (cell) {
                    this.startEditCell(cell);
                    this.focusGeometryAnchor('csg-cell-editor');
                    return;
                }
            } else if (tab === 'surfaces') {
                const surface = state.geometry.surfaces.find((candidate) => candidate.id === id);
                if (surface) {
                    this.startEditSurface(surface);
                    this.focusGeometryAnchor('csg-surface-editor');
                    return;
                }
            } else if (tab === 'lattices') {
                const lattice = state.geometry.lattices.find((candidate) => candidate.id === id);
                if (lattice) {
                    this.latticeLayer = 0;
                    this.startEditLattice(lattice);
                    this.focusGeometryAnchor('csg-lattice-editor');
                    return;
                }
            }
        }

        this.update();
        this.focusGeometryAnchor(geometryIssueAnchor(issue));
    }

    /**
     * Scroll an issue anchor into view and focus it after React paints.
     * @param anchor - Element id, if the issue has one.
     */
    private focusGeometryAnchor(anchor: string | undefined): void {
        if (!anchor) {
            return;
        }
        window.requestAnimationFrame(() => {
            const element = document.getElementById(anchor);
            if (element) {
                element.scrollIntoView({ block: 'center' });
                element.focus({ preventScroll: true });
            }
        });
    }

    // ============================================================================
    // Surfaces Tab
    // ============================================================================

    /**
     * Render the Surfaces tab with gallery and surface list.
     * @param state - Current OpenMC simulation state.
     * @returns Surfaces tab React node.
     */
    private renderSurfacesTab(state: OpenMCState): React.ReactNode {
        const dagmcFile = state.settings.dagmcFile;

        // If DAGMC file is loaded, show DAGMC info instead of CSG surface editor
        if (dagmcFile) {
            return this.renderDAGMCSurfacesTab(state, dagmcFile);
        }

        return (
            <div className="surfaces-tab">
                {/* Surface Editor Panel - Shows when editing/creating */}
                {this.showSurfaceEditor && this.renderSurfaceEditorPanel()}

                {/* Two Column Layout: Gallery + Surface List */}
                <div className="surfaces-layout">
                    {/* Left Column: Surface Gallery */}
                    <div className="surface-gallery-section">
                        <div className="section-header">
                            <h3>
                                <i className="codicon codicon-add"></i> Create Surface
                            </h3>
                            <span className="section-subtitle">Select a surface type</span>
                        </div>
                        <div className="surface-gallery">
                            {SURFACE_TEMPLATES.map((template) => (
                                <Tooltip key={template.type} content={template.description} position="right" stretch>
                                    <button
                                        className={`surface-card ${this.creatingSurfaceType === template.type ? 'creating' : ''}`}
                                        onClick={() => this.startCreateSurface(template)}
                                    >
                                        <div className="surface-icon">
                                            <i className={`codicon codicon-${template.icon}`}></i>
                                        </div>
                                        <div className="surface-info">
                                            <span className="surface-name">{template.name}</span>
                                            <span className="surface-desc">{template.description}</span>
                                        </div>
                                    </button>
                                </Tooltip>
                            ))}
                        </div>
                    </div>

                    {/* Right Column: Defined Surfaces */}
                    <div className="surface-list-section">
                        <div className="section-header">
                            <h3>
                                <i className="codicon codicon-list-unordered"></i> Defined Surfaces ({state.geometry.surfaces.length})
                            </h3>
                        </div>
                        <div className="surfaces-list">
                            {state.geometry.surfaces.length === 0 ? (
                                <div className="empty-state">
                                    <i className="codicon codicon-openmc-surface"></i>
                                    <p>No surfaces defined yet.</p>
                                    <p className="empty-hint">Select a surface type from the gallery to create one.</p>
                                </div>
                            ) : (
                                state.geometry.surfaces.map((surface) => {
                                    const paired = surface.periodicSurfaceId !== undefined;
                                    return (
                                        <div
                                            key={surface.id}
                                            id={`csg-focus-surfaces-${surface.id}`}
                                            tabIndex={0}
                                            className={`surface-list-item ${this.editingSurface?.id === surface.id ? 'editing' : ''}`}
                                        >
                                            <div className="surface-item-main">
                                                <div className="surface-item-info">
                                                    <span className="surface-item-id">#{surface.id}</span>
                                                    <span className="surface-item-name">{surface.name || `${surface.type}`}</span>
                                                    <span className={`surface-bc ${surface.boundary || 'transmission'}`}>
                                                        {surface.boundary || 'transmission'}
                                                    </span>
                                                    {surface.boundary === 'periodic' && (
                                                        <span className={`surface-periodic-badge ${paired ? 'paired' : 'unpaired'}`}>
                                                            <i className="codicon codicon-openmc-periodic" aria-hidden="true"></i>
                                                            {paired ? `paired with #${surface.periodicSurfaceId}` : 'unpaired'}
                                                        </span>
                                                    )}
                                                    {surface.albedo !== undefined && (
                                                        <span className="surface-albedo-badge">albedo {surface.albedo}</span>
                                                    )}
                                                </div>
                                                <div className="surface-item-actions">
                                                    <Tooltip content="Edit Surface" position="bottom">
                                                        <button
                                                            className="theia-button secondary small"
                                                            aria-label={`Edit surface #${surface.id}`}
                                                            onClick={() => this.startEditSurface(surface)}
                                                        >
                                                            <i className="codicon codicon-edit"></i>
                                                        </button>
                                                    </Tooltip>

                                                    <Tooltip content="Delete Surface" position="bottom">
                                                        <button
                                                            className="theia-button secondary small danger"
                                                            aria-label={`Delete surface #${surface.id}`}
                                                            onClick={() => this.deleteSurface(surface.id)}
                                                        >
                                                            <i className="codicon codicon-trash"></i>
                                                        </button>
                                                    </Tooltip>
                                                </div>
                                            </div>
                                            <div className="surface-item-coeffs">{this.renderSurfaceCoeffsPreview(surface)}</div>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    /**
     * Render DAGMC-specific surface information when a DAGMC file is loaded.
     * @param state - Current OpenMC simulation state.
     * @param dagmcFile - Path to the loaded DAGMC file.
     * @returns DAGMC surfaces tab React node.
     */
    private renderDAGMCSurfacesTab(state: OpenMCState, dagmcFile: string): React.ReactNode {
        const info = state.settings.dagmcInfo;
        const fileName = info?.fileName || dagmcFile.split('/').pop() || dagmcFile;

        return (
            <div className="surfaces-tab dagmc-mode">
                <div className="dagmc-info-panel">
                    <div className="dagmc-header">
                        <div className="dagmc-icon">
                            <i className="codicon codicon-openmc-mesh"></i>
                        </div>
                        <div className="dagmc-title">
                            <h3>DAGMC Faceted Geometry</h3>
                            <span className="dagmc-filename">
                                {fileName} {info?.fileSizeMB && `(${info.fileSizeMB.toFixed(2)} MB)`}
                            </span>
                        </div>
                        <Tooltip content="Clear DAGMC file and switch to CSG mode" position="left">
                            <button className="theia-button secondary" onClick={() => this.clearDagmcFile()}>
                                <i className="codicon codicon-close"></i>
                                Clear
                            </button>
                        </Tooltip>
                    </div>

                    <div className="dagmc-description">
                        <p>
                            This simulation uses <strong>DAGMC (Direct Accelerated Geometry Monte Carlo)</strong> faceted mesh geometry.
                        </p>
                        <p className="dagmc-note">
                            DAGMC files contain triangulated surfaces that are used directly by OpenMC. CSG surface editing is disabled
                            while DAGMC mode is active.
                        </p>
                    </div>

                    {/* DAGMC Stats Grid */}
                    {info && (
                        <div className="dagmc-stats-grid">
                            <div className="dagmc-stat-box primary">
                                <span className="stat-value">{info.volumeCount}</span>
                                <span className="stat-label">Volumes</span>
                            </div>
                            <div className="dagmc-stat-box primary">
                                <span className="stat-value">{info.surfaceCount}</span>
                                <span className="stat-label">Surfaces</span>
                            </div>
                            <div className="dagmc-stat-box primary">
                                <span className="stat-value">{info.vertices?.toLocaleString()}</span>
                                <span className="stat-label">Triangles</span>
                            </div>
                            <div className="dagmc-stat-box secondary">
                                <span className="stat-value">{info.totalSurfaceArea?.toFixed(0)}</span>
                                <span className="stat-label">Surface Area (cm²)</span>
                            </div>
                        </div>
                    )}

                    {/* Materials Section */}
                    {info && info.materials && Object.keys(info.materials).length > 0 && (
                        <div className="dagmc-materials-section">
                            <h4>
                                <i className="codicon codicon-symbol-color"></i> Materials ({Object.keys(info.materials).length})
                            </h4>
                            <div className="dagmc-materials-list">
                                {Object.entries(info.materials).map(([name, data]) => (
                                    <div key={name} className="dagmc-material-item">
                                        <span className="material-name">{name}</span>
                                        <span className="material-stats">
                                            {data.volumeCount} vol{(data.volumeCount ?? 0) > 1 ? 's' : ''},{' '}
                                            {(data.totalTriangles ?? 0).toLocaleString()} tri
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Volumes Section */}
                    {info && info.volumes && info.volumes.length > 0 && (
                        <div className="dagmc-volumes-section">
                            <h4>
                                <i className="codicon codicon-openmc-mesh"></i> Volumes ({info.volumes.length})
                            </h4>
                            <div className="dagmc-volumes-list">
                                {info.volumes.map((vol) => (
                                    <div key={vol.id} className="dagmc-volume-item">
                                        <span className="volume-id">Vol {vol.id}</span>
                                        <span className="volume-material">{vol.material}</span>
                                        <span className="volume-triangles">{vol.numTriangles?.toLocaleString()} tri</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {state.geometry.surfaces.length > 0 && (
                    <div className="csg-surfaces-note">
                        <i className="codicon codicon-info"></i>
                        <span>
                            Note: You have {state.geometry.surfaces.length} CSG surfaces defined, but they will be ignored when using DAGMC
                            geometry.
                        </span>
                    </div>
                )}
            </div>
        );
    }

    /**
     * Remove the loaded DAGMC file and switch back to CSG mode.
     */
    private clearDagmcFile(): void {
        const state = this.stateManager.getState();
        delete state.settings.dagmcFile;
        delete state.settings.dagmcInfo;
        this.stateManager.setState(state);
        this.messageService.info('DAGMC file cleared. Switched to CSG mode.');
        this.update();
    }

    /**
     * Render coefficient preview tags for a surface.
     * @param surface - The surface to preview.
     * @returns Coefficient tag elements.
     */
    private renderSurfaceCoeffsPreview(surface: OpenMCSurface): React.ReactNode {
        const coeffs = surface.coefficients as unknown as Record<string, number>;
        const items: string[] = [];

        switch (surface.type) {
            case 'sphere':
                items.push(`center=(${coeffs.x0}, ${coeffs.y0}, ${coeffs.z0})`, `r=${coeffs.r}`);
                break;
            case 'x-plane':
                items.push(`x0=${coeffs.x0}`);
                break;
            case 'y-plane':
                items.push(`y0=${coeffs.y0}`);
                break;
            case 'z-plane':
                items.push(`z0=${coeffs.z0}`);
                break;
            case 'x-cylinder':
                items.push(`center=(${coeffs.y0}, ${coeffs.z0})`, `r=${coeffs.r}`);
                break;
            case 'y-cylinder':
                items.push(`center=(${coeffs.x0}, ${coeffs.z0})`, `r=${coeffs.r}`);
                break;
            case 'z-cylinder':
                items.push(`center=(${coeffs.x0}, ${coeffs.y0})`, `r=${coeffs.r}`);
                break;
            case 'plane':
                items.push(`a=${coeffs.a}`, `b=${coeffs.b}`, `c=${coeffs.c}`, `d=${coeffs.d}`);
                break;
            default:
                Object.entries(coeffs).forEach(([k, v]) => items.push(`${k}=${v}`));
        }

        return items.map((item, i) => (
            <span key={i} className="coeff-tag">
                {item}
            </span>
        ));
    }

    /**
     * Render the surface creation/editing form panel.
     * @returns Surface editor React node.
     */
    private renderSurfaceEditorPanel(): React.ReactNode {
        const template = SURFACE_TEMPLATES.find((t) => t.type === this.surfaceFormType);
        if (!template) return null;

        const isEditing = !!this.editingSurface?.id;
        const state = this.stateManager.getState();
        const albedoCapable = isAlbedoBoundary(this.surfaceFormBoundary);
        const albedo = parseAlbedoInput(this.surfaceFormAlbedo);
        const periodicCandidates = periodicPartnerCandidates(state.geometry.surfaces, this.editingSurface?.id);
        const partner = this.editingSurface?.periodicSurfaceId;
        const coefficients = this.surfaceFormCoeffs as Record<string, number | undefined>;

        return (
            <div className="surface-editor-panel" id="csg-surface-editor">
                <div className="panel-header">
                    <h4>
                        <i className={`codicon codicon-${isEditing ? 'edit' : 'add'}`}></i>
                        {isEditing ? `Edit Surface #${this.editingSurface!.id}` : `Create New ${template.name}`}
                    </h4>
                    <Tooltip content="Close" position="bottom">
                        <button className="panel-close" onClick={() => this.cancelForm()}>
                            <i className="codicon codicon-close"></i>
                        </button>
                    </Tooltip>
                </div>
                <div className="panel-content">
                    <div className="form-row">
                        <div className="form-group">
                            <label>Surface Type</label>
                            <NukeSelect
                                value={this.surfaceFormType}
                                options={[...SURFACE_TEMPLATES.map((t) => ({ value: t.type, label: t.name }))]}
                                onChange={(value: string) => this.changeSurfaceType(value as OpenMCSurfaceType)}
                                disabled={isEditing}
                                ariaLabel="Surface type"
                            />
                            {isEditing && <span className="form-hint">Type cannot be changed when editing</span>}
                        </div>
                        <div className="form-group">
                            <label>Name (optional)</label>
                            <input
                                type="text"
                                value={this.surfaceFormName}
                                aria-label="Surface name"
                                onChange={(e) => {
                                    this.surfaceFormName = e.target.value;
                                    this.update();
                                }}
                                placeholder="e.g., Fuel Outer Radius"
                            />
                        </div>
                        <div className="form-group">
                            <label>Boundary Condition</label>
                            <NukeSelect
                                value={this.surfaceFormBoundary}
                                options={[...BOUNDARY_CONDITIONS.map((bc) => ({ value: bc.value, label: bc.label }))]}
                                onChange={(value: string) => {
                                    this.surfaceFormBoundary = value as OpenMCBoundaryCondition;
                                    if (this.surfaceFormBoundary !== 'periodic') {
                                        this.surfaceFormPeriodicId = '';
                                    }
                                    if (isAlbedoBoundary(this.surfaceFormBoundary)) {
                                        if (this.surfaceFormAlbedo.trim().length === 0) {
                                            this.surfaceFormAlbedo = '1';
                                        }
                                    } else {
                                        this.surfaceFormAlbedo = '';
                                    }
                                    this.update();
                                }}
                                ariaLabel="Boundary condition"
                            />
                        </div>
                    </div>

                    {(albedoCapable || this.surfaceFormBoundary === 'periodic') && (
                        <div className="form-row">
                            {albedoCapable && (
                                <div className="form-group">
                                    <label>Boundary Albedo</label>
                                    <input
                                        type="number"
                                        step="0.01"
                                        min="0"
                                        max="1"
                                        value={this.surfaceFormAlbedo}
                                        onChange={(e) => {
                                            this.surfaceFormAlbedo = e.target.value;
                                            this.update();
                                        }}
                                        placeholder="1 (OpenMC default)"
                                        aria-invalid={!!albedo.error}
                                    />
                                    <span className="form-hint">
                                        Importance multiplier after a boundary interaction; 1 keeps particles unchanged.
                                    </span>
                                    {albedo.error && <span className="csg-field-error">{albedo.error}</span>}
                                    {albedo.warning && <span className="csg-field-warning">{albedo.warning}</span>}
                                </div>
                            )}
                            {this.surfaceFormBoundary === 'periodic' && (
                                <div className="form-group">
                                    <label>Periodic Partner</label>
                                    <NukeSelect
                                        value={this.surfaceFormPeriodicId}
                                        options={[
                                            { value: '', label: 'No partner selected' },
                                            ...periodicCandidates.map((surface) => ({
                                                value: String(surface.id),
                                                label: `#${surface.id}: ${surface.name || surface.type} (periodic)`
                                            }))
                                        ]}
                                        onChange={(value: string) => {
                                            this.surfaceFormPeriodicId = value;
                                            this.update();
                                        }}
                                        ariaLabel="Periodic partner surface"
                                    />
                                    <span className="form-hint">
                                        Only other periodic planes are listed. Set the opposite plane to Periodic first; saving links both
                                        sides reciprocally.
                                    </span>
                                    {periodicCandidates.length === 0 && (
                                        <span className="form-hint warning">
                                            No other periodic planes exist yet. Create the opposite plane with a Periodic boundary, then
                                            pair them.
                                        </span>
                                    )}
                                    {!this.surfaceFormPeriodicId && (
                                        <span className="csg-field-warning">
                                            No partner selected. An unpaired periodic surface blocks the run.
                                        </span>
                                    )}
                                    {partner !== undefined && (
                                        <span className="surface-periodic-badge paired">
                                            <i className="codicon codicon-openmc-periodic" aria-hidden="true"></i>
                                            paired with #{partner}
                                        </span>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    <div className="form-section-title">
                        <i className="codicon codicon-symbol-numeric"></i> Coefficients
                    </div>
                    <div className="coefficients-grid">
                        {Object.entries(template.defaultCoeffs).map(([key, defaultValue]) => (
                            <div key={key} className="form-group">
                                <label>{key}</label>
                                <input
                                    type="number"
                                    step={typeof defaultValue === 'number' && Math.abs(defaultValue as number) < 10 ? '0.1' : '1'}
                                    value={coefficients[key] ?? defaultValue}
                                    aria-label={`${template.name} coefficient ${key}`}
                                    onChange={(e) => {
                                        const val = parseFloat(e.target.value);
                                        this.surfaceFormCoeffs = { ...this.surfaceFormCoeffs, [key]: isNaN(val) ? 0 : val };
                                        this.update();
                                    }}
                                />
                            </div>
                        ))}
                    </div>

                    <div className="panel-actions">
                        <button className="theia-button primary" onClick={() => this.saveSurface()}>
                            <i className="codicon codicon-save"></i>
                            {isEditing ? 'Save Changes' : 'Create Surface'}
                        </button>
                        <button className="theia-button secondary" onClick={() => this.cancelForm()}>
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

    /**
     * Render the Cells tab with list and creation form.
     * @param state - Current OpenMC simulation state.
     * @returns Cells tab React node.
     */
    private renderCellsTab(state: OpenMCState): React.ReactNode {
        const dagmcFile = state.settings.dagmcFile;

        // If DAGMC mode, show DAGMC volumes
        if (dagmcFile) {
            return this.renderDAGMCCellsTab(state);
        }

        return (
            <div className="cells-tab">
                <div className="tab-toolbar">
                    <h3>Cells</h3>
                    <button className="theia-button primary" onClick={() => this.startCreateCell()}>
                        <i className="codicon codicon-add"></i> Add Cell
                    </button>
                </div>

                {this.editingCell && this.renderCellForm(state)}

                <div className="cells-list">
                    {state.geometry.cells.length === 0 ? (
                        <div className="empty-state">
                            <i className="codicon codicon-openmc-cell"></i>
                            <p>No cells defined yet. Click "Add Cell" to create one.</p>
                        </div>
                    ) : (
                        state.geometry.cells.map((cell) => (
                            <div key={cell.id} id={`csg-focus-cells-${cell.id}`} tabIndex={0} className={`cell-card fill-${cell.fillType}`}>
                                <div className="cell-header">
                                    <div className="cell-info">
                                        <span className="cell-id">#{cell.id}</span>
                                        <span className="cell-name">{cell.name || `Cell ${cell.id}`}</span>

                                        <Tooltip content="Click Edit to change fill type" position="bottom">
                                            <span className={`cell-fill-badge ${cell.fillType}`}>
                                                <i className={`codicon codicon-${this.getFillIcon(cell.fillType)}`}></i>
                                                {cell.fillType}
                                            </span>
                                        </Tooltip>
                                        {cell.rotation !== undefined && (
                                            <span className="cell-transform-badge">
                                                <i className="codicon codicon-openmc-transform" aria-hidden="true"></i>
                                                rot {cell.rotation.map((value) => `${value}°`).join(' ')}
                                            </span>
                                        )}
                                        {cell.translation !== undefined && (
                                            <span className="cell-transform-badge">
                                                <i className="codicon codicon-openmc-transform" aria-hidden="true"></i>
                                                move {cell.translation.map((value) => `${value}`).join(' ')} cm
                                            </span>
                                        )}
                                    </div>
                                    <div className="cell-actions">
                                        <Tooltip content="Edit Cell" position="top">
                                            <button
                                                className="theia-button secondary small"
                                                aria-label={`Edit cell #${cell.id}`}
                                                onClick={() => this.startEditCell(cell)}
                                            >
                                                <i className="codicon codicon-edit"></i>
                                            </button>
                                        </Tooltip>
                                        <Tooltip content="Delete Cell" position="top">
                                            <button
                                                className="theia-button secondary small danger"
                                                aria-label={`Delete cell #${cell.id}`}
                                                onClick={() => this.deleteCell(cell.id)}
                                            >
                                                <i className="codicon codicon-trash"></i>
                                            </button>
                                        </Tooltip>
                                    </div>
                                </div>
                                <div className="cell-details">
                                    {cell.regionString && (
                                        <div className="cell-region">
                                            <label>Region:</label>
                                            <code>{cell.regionString}</code>
                                        </div>
                                    )}
                                    <div className="cell-fill">
                                        <label>Fill:</label>
                                        <span className={`fill-value ${cell.fillType}`}>{this.getFillDescription(cell, state)}</span>
                                    </div>
                                    {cell.temperature && (
                                        <div className="cell-temp">
                                            <label>Temperature:</label>
                                            <span>{cell.temperature} K</span>
                                        </div>
                                    )}
                                    {cell.density !== undefined && (
                                        <div className="cell-temp">
                                            <label>Density:</label>
                                            <span>{cell.density}</span>
                                        </div>
                                    )}
                                    {cell.rotation && (
                                        <div className="cell-temp">
                                            <label>Rotation:</label>
                                            <span>{cell.rotation.join(', ')}°</span>
                                        </div>
                                    )}
                                    {cell.translation && (
                                        <div className="cell-temp">
                                            <label>Translation:</label>
                                            <span>{cell.translation.join(', ')} cm</span>
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

    /**
     * Render DAGMC volume list in place of CSG cells.
     * @param state - Current OpenMC simulation state.
     * @returns DAGMC cells tab React node.
     */
    private renderDAGMCCellsTab(state: OpenMCState): React.ReactNode {
        const info = state.settings.dagmcInfo;

        // If no detailed info available, show a simplified view
        if (!info) {
            const dagmcFile = state.settings.dagmcFile;
            return (
                <div className="cells-tab dagmc-mode">
                    <div className="tab-toolbar">
                        <h3>
                            <i className="codicon codicon-openmc-mesh"></i> DAGMC Volumes
                        </h3>
                        <span className="dagmc-badge">DAGMC Mode</span>
                    </div>
                    <div className="dagmc-volumes-intro">
                        <p>
                            <i className="codicon codicon-info"></i> DAGMC mode is active. Volumes are defined in the faceted geometry file.
                        </p>
                    </div>
                    <div className="empty-state">
                        <i className="codicon codicon-openmc-mesh"></i>
                        <p>DAGMC file loaded: {dagmcFile?.split('/').pop() || dagmcFile}</p>
                        <p className="empty-hint">Open this file directly in CSG Builder to see detailed volume information.</p>
                    </div>
                </div>
            );
        }

        return (
            <div className="cells-tab dagmc-mode">
                <div className="tab-toolbar">
                    <h3>
                        <i className="codicon codicon-openmc-mesh"></i> DAGMC Volumes
                    </h3>
                    <span className="dagmc-badge">DAGMC Mode</span>
                </div>

                <div className="dagmc-volumes-intro">
                    <p>
                        These volumes are defined in the DAGMC geometry file. Each volume is automatically a cell with its assigned
                        material.
                    </p>
                </div>

                <div className="cells-list dagmc-volumes-list">
                    {info.volumes.length === 0 ? (
                        <div className="empty-state">
                            <i className="codicon codicon-openmc-mesh"></i>
                            <p>No volumes found in DAGMC file.</p>
                        </div>
                    ) : (
                        info.volumes.map((volume) => (
                            <div key={volume.id} className="cell-card dagmc-volume">
                                <div className="cell-header">
                                    <div className="cell-info">
                                        <span className="cell-id">Vol #{volume.id}</span>
                                        <span className="cell-name">Volume {volume.id}</span>
                                        <span className="cell-fill-badge material">
                                            <i className="codicon codicon-symbol-color"></i>
                                            {volume.material || 'No material'}
                                        </span>
                                    </div>
                                    <div className="cell-actions">
                                        <Tooltip content={`${volume.numTriangles.toLocaleString()} triangles`} position="top">
                                            <span className="triangle-count">
                                                <i className="codicon codicon-triangle-up"></i>
                                                {volume.numTriangles.toLocaleString()}
                                            </span>
                                        </Tooltip>
                                    </div>
                                </div>
                                <div className="cell-details">
                                    <div className="cell-fill">
                                        <label>Material:</label>
                                        <span className="fill-value material">{volume.material || 'Not assigned'}</span>
                                    </div>
                                    <div className="cell-bounds">
                                        <label>Bounds:</label>
                                        <code className="bounds-code">
                                            [{volume.boundingBox.min.map((v) => v.toFixed(1)).join(', ')}] to [
                                            {volume.boundingBox.max.map((v) => v.toFixed(1)).join(', ')}]
                                        </code>
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>

                <div className="dagmc-volumes-summary">
                    <div className="summary-stats">
                        <span>
                            <strong>{info.volumes.length}</strong> volumes
                        </span>
                        <span>
                            <strong>{info.vertices.toLocaleString()}</strong> triangles
                        </span>
                        <span>
                            <strong>{Object.keys(info.materials).length}</strong> materials
                        </span>
                    </div>
                </div>
            </div>
        );
    }

    /**
     * Render the cell creation/editing form.
     * @param state - Current OpenMC simulation state.
     * @returns Cell form React node.
     */
    private renderCellForm(state: OpenMCState): React.ReactNode {
        const rotationInput = parseOptionalVectorInput(this.cellFormRotation, 'Rotation');
        const translationInput = parseOptionalVectorInput(this.cellFormTranslation, 'Translation');
        const densityInput = parseDensityOverride(this.cellFormDensity);
        const fillError = fillTargetError(this.cellFormFillType, this.cellFormFillId);
        const hasTransform =
            this.cellFormRotation.some((value) => value.trim().length > 0) ||
            this.cellFormTranslation.some((value) => value.trim().length > 0);
        const transformApplies = this.cellFormFillType === 'universe' || this.cellFormFillType === 'lattice';

        return (
            <div className="cell-form-container" id="csg-cell-editor">
                <div className="cell-form-heading">
                    <h4>{this.editingCell?.id ? `Edit Cell #${this.editingCell.id}` : 'New Cell'}</h4>
                    <span className="cell-form-subtitle">Identity, region, and placement. All values map to generated geometry.xml.</span>
                </div>
                <div className="cell-form">
                    <section className="csg-form-section">
                        <h5 className="csg-form-section-title">
                            <i className="codicon codicon-openmc-cell" aria-hidden="true"></i>
                            Identity
                        </h5>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Name (optional)</label>
                                <input
                                    type="text"
                                    value={this.cellFormName}
                                    aria-label="Cell name"
                                    onChange={(e) => {
                                        this.cellFormName = e.target.value;
                                        this.update();
                                    }}
                                    placeholder="e.g., Fuel Pin"
                                />
                            </div>
                        </div>

                        <div className="form-group">
                            <label>Fill target</label>
                            <span className="form-hint">
                                Void leaves the cell empty. Materials, universes, and lattices are searchable below; selecting a target sets
                                the fill type.
                            </span>
                            <CSGFillTargetPicker
                                state={state}
                                fillType={this.cellFormFillType}
                                fillId={this.cellFormFillId}
                                onSelect={(kind, id) => {
                                    this.cellFormFillType = kind;
                                    this.cellFormFillId = id;
                                    this.update();
                                }}
                                onSelectVoid={() => {
                                    this.cellFormFillType = 'void';
                                    this.cellFormFillId = 0;
                                    this.update();
                                }}
                            />
                            {fillError && <span className="csg-field-error">{fillError}</span>}
                            <div className="csg-fill-import">
                                <Tooltip content="Import materials from a materials.xml file" position="top">
                                    <button
                                        type="button"
                                        className="theia-button secondary small"
                                        onClick={() => this.importMaterialsFromXML()}
                                    >
                                        <i className="codicon codicon-folder-opened" aria-hidden="true"></i>
                                        Import materials
                                    </button>
                                </Tooltip>
                            </div>
                        </div>
                    </section>

                    <section className="csg-form-section">
                        <h5 className="csg-form-section-title">
                            <i className="codicon codicon-openmc-surface" aria-hidden="true"></i>
                            Region
                        </h5>
                        {this.renderVisualRegionBuilder(state)}
                    </section>

                    <section className="csg-form-section">
                        <h5 className="csg-form-section-title">
                            <i className="codicon codicon-openmc-transform" aria-hidden="true"></i>
                            Placement
                        </h5>
                        <div className="form-row">
                            <div className="form-group">
                                <Tooltip content="Intrinsic Tait-Bryan angles applied as Rz(psi) · Ry(theta) · Rx(phi), in degrees.">
                                    <label>Rotation φ (°)</label>
                                </Tooltip>
                                <input
                                    type="number"
                                    value={this.cellFormRotation[0]}
                                    onChange={(e) => this.setCellFormVector('rotation', 0, e.target.value)}
                                    placeholder="0"
                                    aria-label="Rotation φ in degrees"
                                    aria-invalid={!!rotationInput.error}
                                />
                            </div>
                            <div className="form-group">
                                <label>Rotation θ (°)</label>
                                <input
                                    type="number"
                                    value={this.cellFormRotation[1]}
                                    onChange={(e) => this.setCellFormVector('rotation', 1, e.target.value)}
                                    placeholder="0"
                                    aria-label="Rotation θ in degrees"
                                />
                            </div>
                            <div className="form-group">
                                <label>Rotation ψ (°)</label>
                                <input
                                    type="number"
                                    value={this.cellFormRotation[2]}
                                    onChange={(e) => this.setCellFormVector('rotation', 2, e.target.value)}
                                    placeholder="0"
                                    aria-label="Rotation ψ in degrees"
                                />
                            </div>
                        </div>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Translation x (cm)</label>
                                <input
                                    type="number"
                                    value={this.cellFormTranslation[0]}
                                    onChange={(e) => this.setCellFormVector('translation', 0, e.target.value)}
                                    placeholder="0"
                                    aria-label="Translation x in cm"
                                    aria-invalid={!!translationInput.error}
                                />
                            </div>
                            <div className="form-group">
                                <label>Translation y (cm)</label>
                                <input
                                    type="number"
                                    value={this.cellFormTranslation[1]}
                                    onChange={(e) => this.setCellFormVector('translation', 1, e.target.value)}
                                    placeholder="0"
                                    aria-label="Translation y in cm"
                                />
                            </div>
                            <div className="form-group">
                                <label>Translation z (cm)</label>
                                <input
                                    type="number"
                                    value={this.cellFormTranslation[2]}
                                    onChange={(e) => this.setCellFormVector('translation', 2, e.target.value)}
                                    placeholder="0"
                                    aria-label="Translation z in cm"
                                />
                            </div>
                        </div>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Density Override (optional)</label>
                                <input
                                    type="number"
                                    step="any"
                                    min="0"
                                    value={this.cellFormDensity}
                                    onChange={(e) => {
                                        this.cellFormDensity = e.target.value;
                                        this.update();
                                    }}
                                    placeholder="Material density"
                                    aria-label="Density override"
                                    aria-invalid={!!densityInput.error}
                                />
                                <span className="form-hint">
                                    Positive value in the filled material unit. Leave blank to use the material density.
                                </span>
                                {densityInput.error && <span className="csg-field-error">{densityInput.error}</span>}
                            </div>
                            <div className="form-group csg-transform-action">
                                <Tooltip content="Clear rotation and translation only. Region and fill stay unchanged.">
                                    <button
                                        type="button"
                                        className="theia-button secondary"
                                        onClick={() => this.clearCellTransform()}
                                        disabled={!hasTransform}
                                    >
                                        <i className="codicon codicon-clear-all" aria-hidden="true"></i>
                                        Clear transform
                                    </button>
                                </Tooltip>
                            </div>
                        </div>
                        {rotationInput.error && <span className="csg-field-error">{rotationInput.error}</span>}
                        {translationInput.error && <span className="csg-field-error">{translationInput.error}</span>}
                        {hasTransform && !transformApplies && (
                            <span className="csg-field-warning">
                                Rotation and translation only affect universe and lattice fills; OpenMC ignores them on a material or void
                                cell.
                            </span>
                        )}
                    </section>

                    <details className="csg-advanced">
                        <summary>
                            <i className="codicon codicon-settings-gear" aria-hidden="true"></i>
                            Advanced
                        </summary>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Temperature (K, optional)</label>
                                <input
                                    type="number"
                                    value={this.cellFormTemperature || ''}
                                    onChange={(e) => {
                                        const val = parseFloat(e.target.value);
                                        this.cellFormTemperature = isNaN(val) ? undefined : val;
                                        this.update();
                                    }}
                                    placeholder="e.g., 600"
                                    aria-label="Cell temperature in kelvin"
                                />
                            </div>
                        </div>
                    </details>

                    <div className="form-actions">
                        <button className="theia-button primary" onClick={() => this.saveCell()}>
                            {this.editingCell?.id ? 'Update Cell' : 'Create Cell'}
                        </button>
                        <button className="theia-button secondary" onClick={() => this.cancelForm()}>
                            Cancel
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    /** Reset only the placement fields (rotation/translation), keeping region and fill. */
    private clearCellTransform(): void {
        this.cellFormRotation = ['', '', ''];
        this.cellFormTranslation = ['', '', ''];
        this.update();
    }

    // ============================================================================
    // Visual Region Builder
    // ============================================================================

    /**
     * Render the interactive visual region builder for cell definitions.
     * @param state - Current OpenMC simulation state.
     * @returns Region builder React node.
     */
    private renderVisualRegionBuilder(state: OpenMCState): React.ReactNode {
        return (
            <div className="form-group region-builder">
                <label>Region Definition</label>

                {/* Instructions */}
                <div className="region-instructions">
                    <div className="instruction-step">
                        <span className="step-num">1</span>
                        <span>Click surfaces below to add them to the region</span>
                    </div>
                    <div className="instruction-step">
                        <span className="step-num">2</span>
                        <span>Use operators for unions (|) and intersections (space)</span>
                    </div>
                    <div className="instruction-step">
                        <span className="step-num">3</span>
                        <span>Use parentheses to group operations: (-1 2) | 3</span>
                    </div>
                </div>

                {/* Current Region Display */}
                <div className="region-preview">
                    <label>Current Region:</label>
                    <div className="region-tokens">
                        {this.regionBuilderTokens.length === 0 ? (
                            <span className="empty-region">Click surfaces below to build region...</span>
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
                <div className="region-text-input">
                    <input
                        type="text"
                        value={this.cellFormRegionString}
                        aria-label="Region expression"
                        onChange={(e) => {
                            this.cellFormRegionString = e.target.value;
                            this.regionBuilderTokens = this.parseRegionToTokens(e.target.value);
                            this.update();
                        }}
                        placeholder="-1 2 -3  (surfaces combined with AND)   or   (-1 2) | 3  (union of intersections)"
                    />
                </div>

                {/* Operator Buttons */}
                <div className="operator-buttons">
                    <Tooltip content="Union (OR) - Cell is in either region" position="top">
                        <button className="theia-button secondary small" onClick={() => this.addOperatorToRegion('union')}>
                            <i className="codicon codicon-split-horizontal"></i> OR (|)
                        </button>
                    </Tooltip>
                    <Tooltip content="Open Parenthesis - Group operations" position="top">
                        <button className="theia-button secondary small" onClick={() => this.addOperatorToRegion('open_paren')}>
                            (
                        </button>
                    </Tooltip>
                    <Tooltip content="Close Parenthesis - End group" position="top">
                        <button className="theia-button secondary small" onClick={() => this.addOperatorToRegion('close_paren')}>
                            )
                        </button>
                    </Tooltip>
                    <Tooltip content="Remove Last" position="top">
                        <button className="theia-button secondary small" onClick={() => this.removeLastToken()}>
                            <i className="codicon codicon-arrow-left"></i> Undo
                        </button>
                    </Tooltip>
                    <Tooltip content="Clear All" position="top">
                        <button className="theia-button secondary small danger" onClick={() => this.clearRegion()}>
                            <i className="codicon codicon-trash"></i> Clear
                        </button>
                    </Tooltip>
                </div>

                {/* Surface Selector */}
                <div className="surface-selector">
                    <label>Available Surfaces - Click to add:</label>
                    {state.geometry.surfaces.length === 0 ? (
                        <div className="no-surfaces-message">
                            <i className="codicon codicon-info"></i>
                            No surfaces defined. Go to the Surfaces tab to create surfaces first.
                        </div>
                    ) : (
                        <div className="surface-buttons">
                            {state.geometry.surfaces.map((surface) => (
                                <div key={surface.id} className="surface-button-group">
                                    <Tooltip content={`Surface #${surface.id}: ${surface.name || surface.type}`} position="top">
                                        <span className="surface-label">#{surface.id}</span>
                                    </Tooltip>
                                    <Tooltip content={`Negative side of surface #${surface.id}`} position="top">
                                        <button
                                            className="theia-button secondary small surface-side-btn negative"
                                            onClick={() => this.addSurfaceToRegion(surface.id, 'negative')}
                                        >
                                            -{surface.id}
                                        </button>
                                    </Tooltip>
                                    <Tooltip content={`Positive side of surface #${surface.id}`} position="top">
                                        <button
                                            className="theia-button secondary small surface-side-btn positive"
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
                <div className="region-examples">
                    <label>Common Patterns:</label>
                    <div className="example-list">
                        <div className="example">
                            <code>-1 -2 -3 -4 -5 -6</code>
                            <span>Rectangular box (intersection of 6 planes)</span>
                        </div>
                        <div className="example">
                            <code>-1 | -2</code>
                            <span>Union of two half-spaces</span>
                        </div>
                        <div className="example">
                            <code>(-1 2) | (-3 4)</code>
                            <span>Two separate regions combined</span>
                        </div>
                        <div className="example">
                            <code>-1 ~2</code>
                            <span>Inside surface 1 but outside surface 2</span>
                        </div>
                        <div className="example" style={{ color: '#ff6b6b' }}>
                            <code>-1 +1</code>
                            <span>❌ Invalid: Same surface with both signs!</span>
                        </div>
                    </div>
                    <div className="help-section" style={{ marginTop: '15px', borderTop: '1px solid #555', paddingTop: '10px' }}>
                        <h5>⚠️ Common Mistake</h5>
                        <p>
                            A cell region like <code>-1 +1 -2 +2</code> is <strong>invalid</strong> because:
                        </p>
                        <ul>
                            <li>
                                <code>-1</code> means inside surface 1
                            </li>
                            <li>
                                <code>+1</code> means outside surface 1
                            </li>
                            <li>These contradict each other!</li>
                        </ul>
                        <p>
                            <strong>Fix:</strong> Use only <code>-1 -2</code> for inside sphere AND outside cone.
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    // ============================================================================
    // Universes Tab
    // ============================================================================

    /**
     * Render the Universes tab with universe and lattice management.
     * @param state - Current OpenMC simulation state.
     * @returns Universes tab React node.
     */
    private renderUniversesTab(state: OpenMCState): React.ReactNode {
        // Check DAGMC mode
        const dagmcFile = state.settings.dagmcFile;
        if (dagmcFile) {
            return this.renderDAGMCUniversesTab(state);
        }

        // Get unassigned cells (not in any universe)
        const assignedCellIds = new Set<number>();
        state.geometry.universes.forEach((u) => u.cellIds.forEach((id) => assignedCellIds.add(id)));
        const unassignedCells = state.geometry.cells.filter((c) => !assignedCellIds.has(c.id));

        return (
            <div className="universes-tab">
                <div className="tab-toolbar">
                    <h3>Universes</h3>
                    <Tooltip content="Create a new universe">
                        <button className="theia-button primary" onClick={() => this.createUniverse()}>
                            <i className="codicon codicon-add"></i> Add Universe
                        </button>
                    </Tooltip>
                </div>

                <div className="universes-info">
                    <div className="info-box">
                        <i className="codicon codicon-info"></i>
                        <span>
                            Universes allow you to group cells and reuse them in multiple places. Universe 0 is always the OpenMC XML root
                            and holds top-level cells. Universe and lattice IDs share the fill namespace, so they must not collide. Use the
                            dropdowns below to assign cells.
                        </span>
                    </div>
                </div>

                {/* Unassigned Cells Section */}
                {unassignedCells.length > 0 && (
                    <div className="unassigned-cells-section">
                        <h4>Unassigned Cells ({unassignedCells.length})</h4>
                        <div className="cell-tags">
                            {unassignedCells.map((cell) => (
                                <span key={cell.id} className="cell-tag unassigned">
                                    #{cell.id} {cell.name || ''}
                                    <NukeSelect
                                        value=""
                                        options={[
                                            { value: '', label: 'Assign to...' },
                                            ...state.geometry.universes.map((u) => ({
                                                value: String(u.id),
                                                label: `Universe #${u.id} ${u.name || ''}`
                                            }))
                                        ]}
                                        onChange={(value: string) => {
                                            if (value) {
                                                this.assignCellToUniverse(cell.id, parseInt(value));
                                            }
                                        }}
                                        className="universe-select"
                                        ariaLabel="Assign cell to universe"
                                    />
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                <div className="universes-list">
                    {state.geometry.universes.map((universe) => (
                        <div
                            key={universe.id}
                            id={`csg-focus-universes-${universe.id}`}
                            tabIndex={0}
                            className={`universe-card ${universe.id === 0 ? 'root' : ''}`}
                        >
                            <div className="universe-header">
                                <div className="universe-info">
                                    <span className="universe-id">#{universe.id}</span>
                                    <span className="universe-name">{universe.name || `Universe ${universe.id}`}</span>
                                    {universe.id === 0 && <span className="root-badge">ROOT</span>}
                                </div>
                                {universe.id !== 0 && (
                                    <div className="universe-actions">
                                        <Tooltip content="Delete Universe" position="top">
                                            <button
                                                className="theia-button secondary small danger"
                                                aria-label={`Delete universe #${universe.id}`}
                                                onClick={() => this.deleteUniverse(universe.id)}
                                            >
                                                <i className="codicon codicon-trash"></i>
                                            </button>
                                        </Tooltip>
                                    </div>
                                )}
                            </div>
                            <div className="universe-cells">
                                <label>Cells in this universe:</label>
                                <div className="cell-tags">
                                    {universe.cellIds.length === 0 ? (
                                        <span className="no-cells">No cells assigned</span>
                                    ) : (
                                        universe.cellIds.map((cellId) => {
                                            const cell = state.geometry.cells.find((c) => c.id === cellId);
                                            return (
                                                <span key={cellId} className="cell-tag assigned">
                                                    #{cellId} {cell?.name || ''}
                                                    <Tooltip content="Remove from universe">
                                                        <button
                                                            className="remove-cell-btn"
                                                            onClick={() => this.removeCellFromUniverse(cellId, universe.id)}
                                                        >
                                                            <i className="codicon codicon-close"></i>
                                                        </button>
                                                    </Tooltip>
                                                </span>
                                            );
                                        })
                                    )}
                                </div>

                                {/* Add cells to this universe */}
                                {unassignedCells.length > 0 && (
                                    <div className="add-cells-to-universe">
                                        <NukeSelect
                                            value=""
                                            options={[
                                                { value: '', label: '+ Add cell to this universe...' },
                                                ...unassignedCells.map((cell) => ({
                                                    value: String(cell.id),
                                                    label: `#${cell.id}: ${cell.name || `Cell ${cell.id}`}`
                                                }))
                                            ]}
                                            onChange={(value: string) => {
                                                if (value) {
                                                    this.assignCellToUniverse(parseInt(value), universe.id);
                                                }
                                            }}
                                            ariaLabel="Add cell to universe"
                                        />
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    /**
     * Render DAGMC mode info for Universes tab.
     * DAGMC uses an implicit universe structure - volumes are in universe 0 by default.
     */
    private renderDAGMCUniversesTab(state: OpenMCState): React.ReactNode {
        const info = state.settings.dagmcInfo;
        const volumeCount = info?.volumeCount || 0;

        return (
            <div className="universes-tab dagmc-mode">
                <div className="tab-toolbar">
                    <h3>Universes</h3>
                    <span className="dagmc-badge">DAGMC Mode</span>
                </div>

                <div className="dagmc-volumes-intro">
                    <p>
                        <i className="codicon codicon-info"></i> DAGMC geometry uses an implicit universe structure. All volumes are
                        automatically placed in the root universe (ID: 0). Universe editing is not applicable for DAGMC models.
                    </p>
                </div>

                <div className="dagmc-info-panel">
                    <div className="dagmc-header">
                        <div className="dagmc-icon">
                            <i className="codicon codicon-globe"></i>
                        </div>
                        <div className="dagmc-title">
                            <h3>Root Universe</h3>
                            <span className="dagmc-filename">ID: 0 (implicit)</span>
                        </div>
                    </div>

                    <div className="dagmc-description">
                        <p>
                            In DAGMC mode, all {volumeCount} volume(s) from the faceted geometry file are automatically included in the root
                            universe. This is handled internally by OpenMC's DAGMC interface.
                        </p>
                    </div>

                    <div className="dagmc-stats-grid">
                        <div className="dagmc-stat-box primary">
                            <span className="stat-value">1</span>
                            <span className="stat-label">Universe</span>
                        </div>
                        <div className="dagmc-stat-box primary">
                            <span className="stat-value">{volumeCount}</span>
                            <span className="stat-label">Volumes</span>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    /**
     * Get a human-readable description of a cell's fill.
     * @param cell - The cell to describe.
     * @param state - Current OpenMC simulation state.
     * @returns Human-readable fill description.
     */
    private getFillDescription(cell: OpenMCCell, state: OpenMCState): string {
        switch (cell.fillType) {
            case 'void':
                return 'Void (empty)';
            case 'material': {
                const mat = state.materials.find((m) => m.id === cell.fillId);
                return mat ? `#${mat.id}: ${mat.name}` : `Material #${cell.fillId}`;
            }
            case 'universe': {
                const univ = state.geometry.universes.find((u) => u.id === cell.fillId);
                return univ ? `#${univ.id}: ${univ.name || `Universe ${univ.id}`}` : `Universe #${cell.fillId}`;
            }
            case 'lattice':
                return `Lattice #${cell.fillId}`;
            default:
                return 'Unknown';
        }
    }

    /**
     * Get the Codicon icon name for a fill type.
     * @param fillType - The fill type to map.
     * @returns Codicon icon class name.
     */
    private getFillIcon(fillType: OpenMCFillType): string {
        switch (fillType) {
            case 'void':
                return 'circle-outline';
            case 'material':
                return 'openmc-material';
            case 'universe':
                return 'openmc-universe';
            case 'lattice':
                return 'openmc-lattice';
            default:
                return 'question';
        }
    }

    // ============================================================================
    // Lattices Tab
    // ============================================================================

    /**
     * Render the Lattices tab with the create actions, inline editor, and
     * lattice cards. Lattices are separated from universes because the grid
     * and ring editors need the full tab width.
     * @param state - Current simulation state.
     * @returns Lattices tab React node.
     */
    private renderLatticesTab(state: OpenMCState): React.ReactNode {
        if (state.settings.dagmcFile) {
            return (
                <div className="lattices-tab dagmc-mode">
                    <div className="tab-toolbar">
                        <h3>
                            <i className="codicon codicon-openmc-lattice"></i> Lattices
                        </h3>
                        <span className="dagmc-badge">DAGMC Mode</span>
                    </div>
                    <div className="info-box">
                        <i className="codicon codicon-info"></i>
                        <span>DAGMC geometry is defined by the faceted `.h5m` file, so CSG lattice editing is disabled in this mode.</span>
                    </div>
                </div>
            );
        }

        return (
            <div className="lattices-tab">
                <div className="tab-toolbar">
                    <h3>
                        <i className="codicon codicon-openmc-lattice"></i> Lattices
                    </h3>
                    <div className="tab-toolbar-actions">
                        <Tooltip content="Create a rectangular grid of universes" position="bottom">
                            <button className="theia-button primary" onClick={() => this.startCreateLattice('rect')}>
                                <i className="codicon codicon-add"></i> Create rectangular lattice
                            </button>
                        </Tooltip>
                        <Tooltip content="Create a hexagonal ring lattice" position="bottom">
                            <button className="theia-button secondary" onClick={() => this.startCreateLattice('hex')}>
                                <i className="codicon codicon-add"></i> Create hex lattice
                            </button>
                        </Tooltip>
                        <Tooltip content="Regenerate geometry.xml and open the native 3D preview" position="bottom">
                            <button
                                className="theia-button secondary"
                                onClick={() => this.previewGeometry()}
                                disabled={state.geometry.cells.length === 0}
                            >
                                <i className="codicon codicon-globe"></i> Preview 3D
                            </button>
                        </Tooltip>
                    </div>
                </div>

                {this.latticeDraft && this.renderLatticeEditor(state)}

                <div className="lattices-list">
                    {state.geometry.lattices.length === 0 ? (
                        <div className="empty-state">
                            <i className="codicon codicon-openmc-lattice"></i>
                            <p>No lattices yet. Lattices repeat a universe across a grid — the usual way to build a fuel assembly.</p>
                            <button className="theia-button primary" onClick={() => this.startCreateLattice('rect')}>
                                <i className="codicon codicon-add"></i> Create rectangular lattice
                            </button>
                        </div>
                    ) : (
                        state.geometry.lattices.map((lattice) => this.renderLatticeCard(lattice))
                    )}
                </div>
            </div>
        );
    }

    // ============================================================================
    // Lattice Actions
    // ============================================================================

    /**
     * Start creating a lattice of the given type with default parameters.
     * @param type - Lattice type to create.
     */
    private startCreateLattice(type: 'rect' | 'hex'): void {
        const id = this.stateManager.getNextLatticeId();
        const state = this.stateManager.getState();
        const defaultUniverse = state.geometry.universes.find((universe) => universe.id !== 0)?.id ?? 0;
        const fillUniverses = (universes: number[][][]): number[][][] =>
            universes.map((slice) => slice.map((row) => row.map(() => defaultUniverse)));
        this.latticeBrush = 'paint';
        this.latticeBrushUniverse = defaultUniverse;
        this.latticeLayer = 0;
        if (type === 'rect') {
            this.latticeDraft = {
                id,
                type: 'rect',
                name: `Lattice ${id}`,
                lowerLeft: [0, 0],
                pitch: [1, 1],
                dimensions: [3, 3],
                universes: fillUniverses(resizeRectLatticeUniverses([], [3, 3]))
            };
        } else {
            this.latticeDraft = {
                id,
                type: 'hex',
                name: `Hex Lattice ${id}`,
                center: [0, 0],
                pitch: [1],
                rings: 2,
                orientation: 'y',
                universes: fillUniverses(resizeHexLatticeUniverses([], 2, 1))
            };
        }
        this.update();
    }

    /**
     * Open the inline lattice editor for an existing lattice.
     * @param lattice - Lattice to edit.
     */
    private startEditLattice(lattice: OpenMCLattice): void {
        this.latticeDraft = JSON.parse(JSON.stringify(lattice)) as OpenMCLattice;
        this.latticeBrush = 'paint';
        this.latticeLayer = 0;
        const state = this.stateManager.getState();
        this.latticeBrushUniverse = state.geometry.universes.find((universe) => universe.id !== 0)?.id ?? 0;
        this.update();
    }

    /** Close the lattice editor without saving. */
    private cancelLatticeEditor(): void {
        this.latticeDraft = undefined;
        this.update();
    }

    /**
     * Save the lattice editor draft, creating or updating the lattice.
     */
    private saveLatticeEditor(): void {
        const draft = this.latticeDraft;
        if (!draft) {
            return;
        }

        if (draft.type === 'rect') {
            const validDimensions =
                draft.dimensions.length >= 2 && draft.dimensions.length <= 3 && draft.dimensions.every((value) => value >= 1);
            if (!validDimensions) {
                this.messageService.error('Lattice dimensions must be positive integers.');
                return;
            }
            if (draft.pitch.length !== draft.dimensions.length || draft.pitch.some((value) => !(value > 0))) {
                this.messageService.error('Lattice pitch must be positive and match the number of dimensions.');
                return;
            }
            if (draft.lowerLeft.length !== draft.dimensions.length || draft.lowerLeft.some((value) => !Number.isFinite(value))) {
                this.messageService.error('Lattice lower-left must have one finite coordinate per dimension.');
                return;
            }
        } else {
            if (!Number.isInteger(draft.rings) || draft.rings < 1) {
                this.messageService.error('Hexagonal lattice rings must be a positive integer.');
                return;
            }
            const is3d = draft.nAxial !== undefined && draft.nAxial > 1;
            if (draft.center.length !== (is3d ? 3 : 2)) {
                this.messageService.error(is3d ? 'A 3D hex lattice needs a 3-value center.' : 'A 2D hex lattice needs a 2-value center.');
                return;
            }
            if (draft.pitch.length !== (is3d ? 2 : 1) || draft.pitch.some((value) => !(value > 0))) {
                this.messageService.error(is3d ? 'A 3D hex lattice needs radial and axial pitches.' : 'Set a positive radial pitch.');
                return;
            }
        }

        const exists = this.stateManager.getState().geometry.lattices.some((lattice) => lattice.id === draft.id);
        if (exists) {
            this.stateManager.updateLattice(draft.id, draft);
            this.messageService.info(`Updated lattice #${draft.id}`);
        } else {
            this.stateManager.addLattice(draft);
            this.messageService.info(`Created lattice #${draft.id}`);
        }
        this.cancelLatticeEditor();
    }

    /**
     * Patch the current lattice draft and re-render.
     * @param updates - Partial lattice fields.
     */
    private updateLatticeDraft(updates: Partial<OpenMCLattice>): void {
        if (!this.latticeDraft) {
            return;
        }
        this.latticeDraft = { ...this.latticeDraft, ...updates } as OpenMCLattice;
        this.update();
    }

    /**
     * Resize a rectangular lattice draft, keeping pitch/lower-left in step.
     * @param dimensions - Target dimensions.
     */
    private resizeRectLatticeDraft(dimensions: [number, number] | [number, number, number]): void {
        const draft = this.latticeDraft;
        if (!draft || draft.type !== 'rect') {
            return;
        }
        const resizeTuple = (values: number[], fill: number, length: number): number[] => {
            const next = values.slice(0, length);
            while (next.length < length) {
                next.push(fill);
            }
            return next;
        };
        this.latticeDraft = {
            ...draft,
            dimensions,
            pitch: resizeTuple(draft.pitch, 1, dimensions.length) as [number, number] | [number, number, number],
            lowerLeft: resizeTuple(draft.lowerLeft, 0, dimensions.length) as [number, number] | [number, number, number],
            universes: resizeRectLatticeUniverses(draft.universes, dimensions)
        };
        this.update();
    }

    /**
     * Resize a hexagonal lattice draft, keeping center/pitch in step.
     * @param rings - Target ring count.
     * @param nAxial - Target axial count (undefined/1 for 2D).
     */
    private resizeHexLatticeDraft(rings: number, nAxial: number | undefined): void {
        const draft = this.latticeDraft;
        if (!draft || draft.type !== 'hex') {
            return;
        }
        const is3d = nAxial !== undefined && nAxial > 1;
        const center = is3d
            ? [draft.center[0] ?? 0, draft.center[1] ?? 0, draft.center[2] ?? 0]
            : [draft.center[0] ?? 0, draft.center[1] ?? 0];
        const pitch = is3d ? [draft.pitch[0] ?? 1, draft.pitch[1] ?? 1] : [draft.pitch[0] ?? 1];
        this.latticeDraft = {
            ...draft,
            rings,
            nAxial: is3d ? nAxial : undefined,
            center: center as [number, number] | [number, number, number],
            pitch: pitch as [number] | [number, number],
            universes: resizeHexLatticeUniverses(draft.universes, rings, is3d ? (nAxial as number) : 1)
        };
        this.update();
    }

    /**
     * Render the inline lattice editor for the current draft.
     * @param state - Current simulation state (supplies universe choices).
     * @returns Lattice editor React node.
     */
    private renderLatticeEditor(state: OpenMCState): React.ReactNode {
        const draft = this.latticeDraft;
        if (!draft) {
            return null;
        }

        const numberInput = (
            label: string,
            value: number | undefined,
            onChange: (value: number) => void,
            options: { step?: string; min?: string; placeholder?: string } = {}
        ): React.ReactNode => (
            <div className="form-group" key={label}>
                <label>{label}</label>
                <input
                    type="number"
                    step={options.step ?? 'any'}
                    min={options.min ?? '0'}
                    value={value ?? ''}
                    placeholder={options.placeholder}
                    aria-label={label}
                    onChange={(e) => onChange(Number(e.target.value))}
                />
            </div>
        );

        const universeOptions = state.geometry.universes
            .filter((universe) => universe.id !== 0)
            .map((universe) => ({
                value: String(universe.id),
                label: `#${universe.id} ${universe.name || `Universe ${universe.id}`}`
            }));
        const universeLabel = (id: number): string =>
            state.geometry.universes.find((universe) => universe.id === id)?.name || `Universe ${id}`;
        const outerOptions = [{ value: '0', label: 'None (outside is not filled)' }, ...universeOptions];
        const layers = draft.type === 'rect' ? (draft.dimensions.length === 3 ? draft.dimensions[2] : 1) : (draft.nAxial ?? 1);
        const layer = Math.min(Math.max(this.latticeLayer, 0), Math.max(layers - 1, 0));
        const emptyUniverses = emptyLatticeUniverses(draft, state.geometry.universes);
        const noUniverses = universeOptions.length === 0;

        return (
            <div className="lattice-card lattice-editor" id="csg-lattice-editor" tabIndex={0}>
                <div className="lattice-header">
                    <div className="lattice-info">
                        <i className="codicon codicon-openmc-lattice" aria-hidden="true"></i>
                        <span className="lattice-id">#{draft.id}</span>
                        <span className="lattice-name">{draft.name || `Lattice ${draft.id}`}</span>
                        <span className={`lattice-type-badge ${draft.type}`}>{draft.type === 'rect' ? 'Rectangular' : 'Hexagonal'}</span>
                    </div>
                    <div className="lattice-actions">
                        <Tooltip content="Close the editor without saving" position="bottom">
                            <button className="theia-button secondary small" onClick={() => this.cancelLatticeEditor()}>
                                <i className="codicon codicon-close"></i>
                            </button>
                        </Tooltip>
                    </div>
                </div>
                <div className="lattice-summary">{latticeSummary(draft)}</div>

                <section className="csg-form-section">
                    <h5 className="csg-form-section-title">
                        <i className="codicon codicon-openmc-lattice" aria-hidden="true"></i>
                        Definition
                    </h5>
                    <div className="form-row">
                        <div className="form-group">
                            <label>Name</label>
                            <input
                                type="text"
                                value={draft.name ?? ''}
                                aria-label="Lattice name"
                                onChange={(e) => this.updateLatticeDraft({ name: e.target.value })}
                            />
                        </div>
                        <div className="form-group">
                            <label>Outer Universe</label>
                            <NukeSelect
                                value={draft.outer !== undefined ? String(draft.outer) : '0'}
                                options={outerOptions}
                                onChange={(value: string) => {
                                    const outer = parseInt(value);
                                    this.updateLatticeDraft({ outer: outer > 0 ? outer : undefined });
                                }}
                                ariaLabel="Outer universe"
                            />
                            <span className="form-hint">Fills every position outside the lattice. Leave empty for no outer fill.</span>
                        </div>
                    </div>

                    {draft.type === 'rect'
                        ? this.renderRectLatticeEditorFields(draft, numberInput)
                        : this.renderHexLatticeEditorFields(draft, numberInput)}
                </section>

                <section className="csg-form-section">
                    <h5 className="csg-form-section-title">
                        <i className="codicon codicon-openmc-grid" aria-hidden="true"></i>
                        Universe assignment
                    </h5>
                    <div className="lattice-brush-toolbar">
                        <div className="lattice-brush-tools" role="group" aria-label="Universe brush">
                            <Tooltip content="Assign the selected universe to one position" position="top">
                                <button
                                    type="button"
                                    className={`theia-button secondary small ${this.latticeBrush === 'paint' ? 'active' : ''}`}
                                    aria-pressed={this.latticeBrush === 'paint'}
                                    onClick={() => this.setLatticeBrush('paint')}
                                >
                                    <i className="codicon codicon-edit" aria-hidden="true"></i> Paint
                                </button>
                            </Tooltip>
                            <Tooltip
                                content={draft.type === 'rect' ? 'Click a cell to fill its row' : 'Click a cell to fill its ring'}
                                position="top"
                            >
                                <button
                                    type="button"
                                    className={`theia-button secondary small ${this.latticeBrush === 'row' ? 'active' : ''}`}
                                    aria-pressed={this.latticeBrush === 'row'}
                                    onClick={() => this.setLatticeBrush('row')}
                                >
                                    <i className="codicon codicon-arrow-right" aria-hidden="true"></i>
                                    {draft.type === 'rect' ? 'Fill row' : 'Fill ring'}
                                </button>
                            </Tooltip>
                            <Tooltip content="Click a cell to clear it (unassigned)" position="top">
                                <button
                                    type="button"
                                    className={`theia-button secondary small ${this.latticeBrush === 'clear' ? 'active' : ''}`}
                                    aria-pressed={this.latticeBrush === 'clear'}
                                    onClick={() => this.setLatticeBrush('clear')}
                                >
                                    <i className="codicon codicon-trash" aria-hidden="true"></i> Clear
                                </button>
                            </Tooltip>
                        </div>
                        <div className="lattice-brush-universe">
                            <label>Brush universe</label>
                            <NukeSelect
                                value={String(this.latticeBrushUniverse)}
                                options={noUniverses ? [{ value: '0', label: 'No nested universes yet' }] : universeOptions}
                                onChange={(value: string) => {
                                    this.latticeBrushUniverse = parseInt(value);
                                    this.update();
                                }}
                                ariaLabel="Universe brush value"
                                disabled={noUniverses}
                            />
                        </div>
                        <div className="lattice-bulk-actions">
                            <Tooltip content="Assign the brush universe to every position" position="top">
                                <button
                                    type="button"
                                    className="theia-button secondary small"
                                    onClick={() => this.fillAllLatticeDraft()}
                                    disabled={noUniverses}
                                >
                                    <i className="codicon codicon-clear-all" aria-hidden="true"></i> Fill all
                                </button>
                            </Tooltip>
                            <Tooltip content="Clear every position to unassigned" position="top">
                                <button
                                    type="button"
                                    className="theia-button secondary small danger"
                                    onClick={() => this.clearLatticeDraft()}
                                >
                                    <i className="codicon codicon-trash" aria-hidden="true"></i> Clear all
                                </button>
                            </Tooltip>
                        </div>
                    </div>

                    {noUniverses && (
                        <div className="csg-fill-empty">
                            <i className="codicon codicon-info" aria-hidden="true"></i>
                            <span>
                                No nested universes yet. Create one in the Universes tab and add cells to it before filling the lattice;
                                universe 0 is the root and cannot be used as a fill.
                            </span>
                        </div>
                    )}

                    {(layers > 1 || draft.type === 'hex') && (
                        <div className="lattice-layer-select">
                            <label>Axial layer</label>
                            <NukeSelect
                                value={String(layer)}
                                options={Array.from({ length: layers }).map((_, index) => ({
                                    value: String(index),
                                    label: `Layer ${index}${layers === 1 ? ' (2D)' : ''}`
                                }))}
                                onChange={(value: string) => {
                                    this.latticeLayer = parseInt(value);
                                    this.update();
                                }}
                                ariaLabel="Lattice axial layer"
                            />
                        </div>
                    )}

                    {draft.type === 'rect' ? (
                        <RectLatticeGrid
                            dimensions={draft.dimensions}
                            universes={draft.universes}
                            layer={layer}
                            universeLabel={universeLabel}
                            onCell={(z, y, x) => this.applyLatticeBrush({ kind: 'rect', z, y, x })}
                            onFillRow={(z, y) => this.fillLatticeRowDraft(z, y)}
                        />
                    ) : (
                        <HexLatticeRings
                            rings={draft.rings}
                            layerUniverses={draft.universes[layer]}
                            universeLabel={universeLabel}
                            onCell={(ring, theta) => this.applyLatticeBrush({ kind: 'hex', z: layer, ring, theta })}
                            onFillRing={(ring) => this.fillLatticeRingDraft(ring)}
                        />
                    )}

                    {emptyUniverses.length > 0 && (
                        <div className="lattice-warning-list" role="status">
                            <i className="codicon codicon-warning" aria-hidden="true"></i>
                            <span>
                                Referenced universes with no cells: {emptyUniverses.map((id) => `#${id}`).join(', ')}. OpenMC omits empty
                                universes; add cells to each before running.
                            </span>
                        </div>
                    )}
                </section>

                <div className="form-actions">
                    <button className="theia-button primary" onClick={() => this.saveLatticeEditor()}>
                        <i className="codicon codicon-save"></i> Save Lattice
                    </button>
                    <button className="theia-button secondary" onClick={() => this.previewGeometry()}>
                        <i className="codicon codicon-globe"></i> Preview 3D
                    </button>
                    <button className="theia-button secondary" onClick={() => this.cancelLatticeEditor()}>
                        Cancel
                    </button>
                </div>
            </div>
        );
    }

    /** Render the rectangular-specific editor fields. */
    private renderRectLatticeEditorFields(
        draft: OpenMCRectLattice & { id: number },
        numberInput: (
            label: string,
            value: number | undefined,
            onChange: (value: number) => void,
            options?: { step?: string; min?: string; placeholder?: string }
        ) => React.ReactNode
    ): React.ReactNode {
        const nx = draft.dimensions[0];
        const ny = draft.dimensions[1];
        const nz = draft.dimensions.length === 3 ? draft.dimensions[2] : 1;

        return (
            <>
                <div className="form-row">
                    {numberInput(
                        'Cells X',
                        nx,
                        (value) =>
                            this.resizeRectLatticeDraft([Math.max(1, Math.trunc(value || 1)), ny, ...(nz > 1 ? [nz] : [])] as
                                [number, number] | [number, number, number]),
                        { min: '1' }
                    )}
                    {numberInput(
                        'Cells Y',
                        ny,
                        (value) =>
                            this.resizeRectLatticeDraft([nx, Math.max(1, Math.trunc(value || 1)), ...(nz > 1 ? [nz] : [])] as
                                [number, number] | [number, number, number]),
                        { min: '1' }
                    )}
                    {numberInput(
                        'Z Layers (1 = 2D)',
                        nz,
                        (value) => {
                            const layers = Math.max(1, Math.trunc(value || 1));
                            this.resizeRectLatticeDraft(layers > 1 ? [nx, ny, layers] : [nx, ny]);
                        },
                        { min: '1' }
                    )}
                </div>
                <div className="form-row">
                    {numberInput('Pitch X (cm)', draft.pitch[0], (value) => {
                        const pitch = [...draft.pitch];
                        pitch[0] = value;
                        this.updateLatticeDraft({ pitch: pitch as [number, number] | [number, number, number] });
                    })}
                    {numberInput('Pitch Y (cm)', draft.pitch[1], (value) => {
                        const pitch = [...draft.pitch];
                        pitch[1] = value;
                        this.updateLatticeDraft({ pitch: pitch as [number, number] | [number, number, number] });
                    })}
                    {nz > 1 &&
                        numberInput('Pitch Z (cm)', draft.pitch[2], (value) => {
                            const pitch = [...draft.pitch];
                            pitch[2] = value;
                            this.updateLatticeDraft({ pitch: pitch as [number, number, number] });
                        })}
                </div>
                <div className="form-row">
                    {numberInput(
                        'Lower Left X (cm)',
                        draft.lowerLeft[0],
                        (value) => {
                            const lowerLeft = [...draft.lowerLeft];
                            lowerLeft[0] = value;
                            this.updateLatticeDraft({ lowerLeft: lowerLeft as [number, number] | [number, number, number] });
                        },
                        { min: '' }
                    )}
                    {numberInput(
                        'Lower Left Y (cm)',
                        draft.lowerLeft[1],
                        (value) => {
                            const lowerLeft = [...draft.lowerLeft];
                            lowerLeft[1] = value;
                            this.updateLatticeDraft({ lowerLeft: lowerLeft as [number, number] | [number, number, number] });
                        },
                        { min: '' }
                    )}
                    {nz > 1 &&
                        numberInput(
                            'Lower Left Z (cm)',
                            draft.lowerLeft[2],
                            (value) => {
                                const lowerLeft = [...draft.lowerLeft];
                                lowerLeft[2] = value;
                                this.updateLatticeDraft({ lowerLeft: lowerLeft as [number, number, number] });
                            },
                            { min: '' }
                        )}
                </div>
            </>
        );
    }

    /** Render the hexagonal-specific editor fields. */
    private renderHexLatticeEditorFields(
        draft: OpenMCHexLattice & { id: number },
        numberInput: (
            label: string,
            value: number | undefined,
            onChange: (value: number) => void,
            options?: { step?: string; min?: string; placeholder?: string }
        ) => React.ReactNode
    ): React.ReactNode {
        const is3d = draft.nAxial !== undefined && draft.nAxial > 1;

        return (
            <>
                <div className="form-row">
                    {numberInput(
                        'Rings (center counts)',
                        draft.rings,
                        (value) => this.resizeHexLatticeDraft(Math.max(1, Math.trunc(value || 1)), draft.nAxial),
                        { min: '1' }
                    )}
                    <div className="form-group">
                        <label>Orientation</label>
                        <NukeSelect
                            value={draft.orientation ?? 'y'}
                            options={[
                                { value: 'y', label: 'Y (flat top)' },
                                { value: 'x', label: 'X (flat side)' }
                            ]}
                            onChange={(value: string) => this.updateLatticeDraft({ orientation: value as OpenMCHexOrientation })}
                            ariaLabel="Hexagon orientation"
                        />
                        <span className="form-hint">Y has a flat top; X has a flat side.</span>
                    </div>
                    {numberInput(
                        'Axial Levels (1 = 2D)',
                        draft.nAxial ?? 1,
                        (value) => {
                            const levels = Math.max(1, Math.trunc(value || 1));
                            this.resizeHexLatticeDraft(draft.rings, levels > 1 ? levels : undefined);
                        },
                        { min: '1' }
                    )}
                </div>
                <div className="form-row">
                    {numberInput(
                        'Center X (cm)',
                        draft.center[0],
                        (value) => {
                            const center = [...draft.center];
                            center[0] = value;
                            this.updateLatticeDraft({ center: center as [number, number] | [number, number, number] });
                        },
                        { min: '' }
                    )}
                    {numberInput(
                        'Center Y (cm)',
                        draft.center[1],
                        (value) => {
                            const center = [...draft.center];
                            center[1] = value;
                            this.updateLatticeDraft({ center: center as [number, number] | [number, number, number] });
                        },
                        { min: '' }
                    )}
                    {is3d &&
                        numberInput(
                            'Center Z (cm)',
                            draft.center[2],
                            (value) => {
                                const center = [...draft.center];
                                center[2] = value;
                                this.updateLatticeDraft({ center: center as [number, number, number] });
                            },
                            { min: '' }
                        )}
                    {numberInput('Radial Pitch (cm)', draft.pitch[0], (value) => {
                        const pitch = [...draft.pitch];
                        pitch[0] = value;
                        this.updateLatticeDraft({ pitch: pitch as [number] | [number, number] });
                    })}
                    {is3d &&
                        numberInput('Axial Pitch (cm)', draft.pitch[1], (value) => {
                            const pitch = [...draft.pitch];
                            pitch[1] = value;
                            this.updateLatticeDraft({ pitch: pitch as [number, number] });
                        })}
                </div>
            </>
        );
    }

    /** Select the active lattice brush. */
    private setLatticeBrush(brush: LatticeBrush): void {
        this.latticeBrush = brush;
        this.update();
    }

    /** Apply the active brush at one cell position. */
    private applyLatticeBrush(
        position: { kind: 'rect'; z: number; y: number; x: number } | { kind: 'hex'; z: number; ring: number; theta: number }
    ): void {
        const draft = this.latticeDraft;
        if (!draft) {
            return;
        }
        if (this.latticeBrush === 'clear') {
            this.updateLatticeDraft({ universes: setLatticePosition(draft.universes, position, 0) });
        } else if (this.latticeBrush === 'row' && position.kind === 'rect') {
            this.fillLatticeRowDraft(position.z, position.y);
        } else if (this.latticeBrush === 'row' && position.kind === 'hex') {
            this.fillLatticeRingDraft(position.ring);
        } else {
            this.updateLatticeDraft({ universes: setLatticePosition(draft.universes, position, this.latticeBrushUniverse) });
        }
    }

    /** Fill one rectangular row with the brush universe. */
    private fillLatticeRowDraft(z: number, y: number): void {
        const draft = this.latticeDraft;
        if (!draft) {
            return;
        }
        this.updateLatticeDraft({ universes: fillLatticeRow(draft.universes, z, y, this.latticeBrushUniverse) });
    }

    /** Fill one hexagonal ring with the brush universe. */
    private fillLatticeRingDraft(ring: number): void {
        const draft = this.latticeDraft;
        if (!draft || draft.type !== 'hex') {
            return;
        }
        const layer = Math.min(Math.max(this.latticeLayer, 0), Math.max((draft.nAxial ?? 1) - 1, 0));
        this.updateLatticeDraft({ universes: fillLatticeRing(draft.universes, layer, ring, this.latticeBrushUniverse) });
    }

    /** Fill every lattice position with the brush universe. */
    private fillAllLatticeDraft(): void {
        const draft = this.latticeDraft;
        if (!draft) {
            return;
        }
        this.updateLatticeDraft({ universes: fillAllLatticeUniverses(draft.universes, this.latticeBrushUniverse) });
    }

    /** Clear every lattice position to unassigned. */
    private clearLatticeDraft(): void {
        const draft = this.latticeDraft;
        if (!draft) {
            return;
        }
        this.updateLatticeDraft({ universes: clearLatticeUniverses(draft.universes) });
    }

    /**
     * Delete a lattice by id if it is not referenced by any cell.
     * @param id - Lattice id to delete.
     */
    private deleteLattice(id: number): void {
        // Check if lattice is used in any cells
        const state = this.stateManager.getState();
        const usedInCells = state.geometry.cells.filter((cell) => cell.fillType === 'lattice' && cell.fillId === id);

        if (usedInCells.length > 0) {
            this.messageService.warn(
                `Lattice #${id} is used in cells: ${usedInCells.map((c) => `#${c.id}`).join(', ')}. Remove from cells first.`
            );
            return;
        }

        if (!window.confirm(`Delete lattice #${id}? This cannot be undone.`)) {
            return;
        }

        if (this.latticeDraft?.id === id) {
            this.latticeDraft = undefined;
        }
        this.stateManager.removeLattice(id);
        this.messageService.info(`Deleted lattice #${id}`);
    }

    /**
     * Render a lattice card with properties and grid preview.
     * @param lattice - The lattice to render.
     * @returns Lattice card React node.
     */
    private renderLatticeCard(lattice: OpenMCLattice): React.ReactNode {
        const state = this.stateManager.getState();
        const emptyUniverses = emptyLatticeUniverses(lattice, state.geometry.universes);
        const universeIds = new Set(state.geometry.universes.map((universe) => universe.id));
        const missingUniverses = latticeReferencedUniverses(lattice).filter((id) => !universeIds.has(id));

        return (
            <div key={lattice.id} id={`csg-focus-lattices-${lattice.id}`} tabIndex={0} className="lattice-card">
                <div className="lattice-header">
                    <div className="lattice-info">
                        <i className="codicon codicon-openmc-lattice" aria-hidden="true"></i>
                        <span className="lattice-id">#{lattice.id}</span>
                        <span className="lattice-name">{lattice.name || `Lattice ${lattice.id}`}</span>
                        <span className={`lattice-type-badge ${lattice.type}`}>
                            {lattice.type === 'rect' ? 'Rectangular' : 'Hexagonal'}
                        </span>
                    </div>
                    <div className="lattice-actions">
                        <Tooltip content="Edit lattice definition and universe assignment" position="top">
                            <button
                                className="theia-button secondary small"
                                aria-label={`Edit lattice #${lattice.id}`}
                                onClick={() => this.startEditLattice(lattice)}
                            >
                                <i className="codicon codicon-edit"></i>
                            </button>
                        </Tooltip>
                        <Tooltip content="Regenerate geometry.xml and open the 3D preview" position="top">
                            <button
                                className="theia-button secondary small"
                                aria-label={`Preview lattice #${lattice.id} in 3D`}
                                onClick={() => this.previewGeometry()}
                            >
                                <i className="codicon codicon-globe"></i>
                            </button>
                        </Tooltip>
                        <Tooltip content="Delete lattice" position="top">
                            <button
                                className="theia-button secondary small danger"
                                aria-label={`Delete lattice #${lattice.id}`}
                                onClick={() => this.deleteLattice(lattice.id)}
                            >
                                <i className="codicon codicon-trash"></i>
                            </button>
                        </Tooltip>
                    </div>
                </div>

                <div className="lattice-summary">{latticeSummary(lattice)}</div>

                {emptyUniverses.length > 0 && (
                    <div className="lattice-warning-list" role="status">
                        <i className="codicon codicon-warning" aria-hidden="true"></i>
                        <span>Referenced universes with no cells: {emptyUniverses.map((id) => `#${id}`).join(', ')}</span>
                    </div>
                )}
                {missingUniverses.length > 0 && (
                    <div className="lattice-warning-list" role="status">
                        <i className="codicon codicon-error" aria-hidden="true"></i>
                        <span>Referenced universes that do not exist: {missingUniverses.map((id) => `#${id}`).join(', ')}</span>
                    </div>
                )}

                <div className="lattice-preview">{this.renderUniverseGridPreview(lattice)}</div>
            </div>
        );
    }

    /**
     * Render a compact, read-only preview of a lattice's universe map.
     * @param lattice - The lattice to preview.
     * @returns Grid/ring preview React node.
     */
    private renderUniverseGridPreview(lattice: OpenMCLattice): React.ReactNode {
        const universes = lattice.universes;
        if (!universes || universes.length === 0) {
            return <span className="empty-preview">No universes defined</span>;
        }

        if (lattice.type === 'rect') {
            const nx = lattice.dimensions[0];
            const ny = lattice.dimensions[1];
            const nz = lattice.dimensions.length === 3 ? lattice.dimensions[2] : 1;

            return (
                <div className="rect-grid-preview-stack">
                    {Array.from({ length: nz }).map((_, z) => (
                        <div key={z}>
                            {nz > 1 && <span className="lattice-slice-label">Z layer {z}</span>}
                            <div
                                className="rect-grid-preview"
                                style={{
                                    display: 'grid',
                                    gridTemplateColumns: `repeat(${nx}, 28px)`,
                                    gap: '3px'
                                }}
                            >
                                {Array.from({ length: ny }).map((__, y) =>
                                    Array.from({ length: nx }).map((___, x) => (
                                        <LatticeGridCell key={`${z}-${y}-${x}`} univId={universes[z]?.[y]?.[x] ?? 0} col={x} row={y} />
                                    ))
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            );
        }

        const ringSizes = latticeRingSizes(lattice.rings);
        return (
            <div className="lattice-ring-preview">
                {ringSizes.map((size, ring) => {
                    const values = universes[0]?.[ring] ?? [];
                    const unique = Array.from(new Set(values));
                    return (
                        <span key={ring} className="lattice-ring-chip">
                            <span className="lattice-ring-chip-label">{ring === lattice.rings - 1 ? 'Center' : `Ring ${ring}`}</span>
                            <span className="lattice-ring-chip-value">
                                {size} pos{unique.length > 0 ? ` · #${unique.join(', #')}` : ''}
                            </span>
                        </span>
                    );
                })}
            </div>
        );
    }

    // ============================================================================
    // Surface Actions
    // ============================================================================

    /**
     * Start creating a new surface from a template.
     * @param template - Surface template to use.
     */
    private startCreateSurface(template: SurfaceTemplate): void {
        this.editingSurface = {
            id: 0,
            type: template.type,
            coefficients: { ...template.defaultCoeffs } as OpenMCSurface['coefficients'],
            boundary: 'vacuum'
        };
        this.creatingSurfaceType = template.type;
        this.surfaceFormType = template.type;
        this.surfaceFormCoeffs = { ...template.defaultCoeffs };
        this.surfaceFormBoundary = 'vacuum';
        this.surfaceFormName = '';
        this.surfaceFormAlbedo = '';
        this.surfaceFormPeriodicId = '';
        this.showSurfaceEditor = true;
        this.update();
    }

    /**
     * Start editing an existing surface.
     * @param surface - Surface to edit.
     */
    private startEditSurface(surface: OpenMCSurface): void {
        this.editingSurface = { ...surface };
        this.surfaceFormType = surface.type;
        this.surfaceFormCoeffs = { ...surface.coefficients };
        this.surfaceFormBoundary = surface.boundary || 'vacuum';
        this.surfaceFormName = surface.name || '';
        this.surfaceFormAlbedo = surface.albedo !== undefined ? String(surface.albedo) : isAlbedoBoundary(surface.boundary) ? '1' : '';
        this.surfaceFormPeriodicId = surface.periodicSurfaceId !== undefined ? String(surface.periodicSurfaceId) : '';
        this.showSurfaceEditor = true;
        this.update();
    }

    /**
     * Change the surface type being created/edited.
     * @param type - New surface type.
     */
    private changeSurfaceType(type: OpenMCSurfaceType): void {
        const template = SURFACE_TEMPLATES.find((t) => t.type === type);
        if (!template) return;

        this.surfaceFormType = type;
        this.surfaceFormCoeffs = { ...template.defaultCoeffs };
        this.editingSurface = {
            ...this.editingSurface!,
            type: type,
            coefficients: { ...template.defaultCoeffs } as OpenMCSurface['coefficients']
        };
        this.update();
    }

    /**
     * Save the current surface (create new or update existing).
     *
     * A periodic surface may be saved without a partner so the validation
     * banner can point at it; saving with a partner links both sides through
     * {@link OpenMCStateManager.setSurfacePeriodicPair}.
     */
    private async saveSurface(): Promise<void> {
        if (!this.editingSurface) return;

        const albedoInput = parseAlbedoInput(this.surfaceFormAlbedo);
        if (albedoInput.error) {
            this.messageService.error(albedoInput.error);
            return;
        }
        const albedo = isAlbedoBoundary(this.surfaceFormBoundary) && albedoInput.value !== 1 ? albedoInput.value : undefined;
        const periodicSurfaceId =
            this.surfaceFormBoundary === 'periodic' && this.surfaceFormPeriodicId ? Number(this.surfaceFormPeriodicId) : undefined;
        if (periodicSurfaceId !== undefined && periodicSurfaceId === this.editingSurface.id) {
            this.messageService.error('A periodic surface cannot pair with itself. Select the opposite plane.');
            return;
        }

        const surface: OpenMCSurface = {
            id: this.editingSurface.id || this.stateManager.getNextSurfaceId(),
            type: this.surfaceFormType,
            coefficients: { ...this.surfaceFormCoeffs } as OpenMCSurface['coefficients'],
            boundary: this.surfaceFormBoundary,
            name: this.surfaceFormName || undefined,
            albedo,
            periodicSurfaceId: this.editingSurface.periodicSurfaceId
        };
        const previouslyPaired = this.editingSurface.periodicSurfaceId !== undefined;

        if (this.editingSurface.id) {
            this.stateManager.updateSurface(this.editingSurface.id, surface);
            this.messageService.info(`Updated surface #${surface.id}`);
        } else {
            this.stateManager.addSurface(surface);
            this.messageService.info(`Created surface #${surface.id}`);
        }

        if (this.surfaceFormBoundary === 'periodic' && periodicSurfaceId !== undefined) {
            this.stateManager.setSurfacePeriodicPair(surface.id, periodicSurfaceId);
        } else if (previouslyPaired || this.surfaceFormBoundary !== 'periodic') {
            this.stateManager.setSurfacePeriodicPair(surface.id, undefined);
        }
        if (this.surfaceFormBoundary === 'periodic' && periodicSurfaceId === undefined) {
            this.messageService.warn('Surface saved unpaired. Select a periodic partner before running.');
        }

        this.cancelForm();
    }

    /**
     * Delete a surface if it is not used in any cell region.
     * @param id - Surface id to delete.
     */
    private deleteSurface(id: number): void {
        // Check if surface is used in any cell regions
        const state = this.stateManager.getState();
        const usedInCells = state.geometry.cells.filter((cell) => cell.regionString && cell.regionString.includes(id.toString()));

        if (usedInCells.length > 0) {
            this.messageService.warn(
                `Surface #${id} is used in cells: ${usedInCells.map((c) => `#${c.id}`).join(', ')}. Remove from cells first.`
            );
            return;
        }

        if (state.geometry.surfaces.find((surface) => surface.id === id)?.periodicSurfaceId !== undefined) {
            this.stateManager.setSurfacePeriodicPair(id, undefined);
        }
        this.stateManager.removeSurface(id);
        this.messageService.info(`Deleted surface #${id}`);
    }

    // ============================================================================
    // Cell Actions
    // ============================================================================

    /**
     * Start creating a new cell with default values.
     */
    private startCreateCell(): void {
        this.editingCell = { id: 0, fillType: 'void' };
        this.cellFormName = '';
        this.cellFormFillType = 'void';
        this.cellFormFillId = 0;
        this.cellFormRegionString = '';
        this.cellFormTemperature = undefined;
        this.cellFormRotation = ['', '', ''];
        this.cellFormTranslation = ['', '', ''];
        this.cellFormDensity = '';
        this.regionBuilderTokens = [];
        this.update();
    }

    /**
     * Start editing an existing cell.
     * @param cell - Cell to edit.
     */
    private startEditCell(cell: OpenMCCell): void {
        this.editingCell = { ...cell };
        this.cellFormName = cell.name || '';
        this.cellFormFillType = cell.fillType;
        this.cellFormFillId = cell.fillId || 0;
        this.cellFormRegionString = cell.regionString || '';
        this.cellFormTemperature = cell.temperature;
        this.cellFormRotation = cell.rotation ? (cell.rotation.map((value) => String(value)) as [string, string, string]) : ['', '', ''];
        this.cellFormTranslation = cell.translation
            ? (cell.translation.map((value) => String(value)) as [string, string, string])
            : ['', '', ''];
        this.cellFormDensity = cell.density !== undefined ? String(cell.density) : '';
        // Parse existing region into tokens
        this.regionBuilderTokens = this.parseRegionToTokens(cell.regionString || '');
        this.update();
    }

    /**
     * Update one component of the cell rotation/translation form fields.
     * @param field - Which vector to edit.
     * @param index - Vector component (0, 1, or 2).
     * @param value - Raw input value.
     */
    private setCellFormVector(field: 'rotation' | 'translation', index: 0 | 1 | 2, value: string): void {
        const current = field === 'rotation' ? this.cellFormRotation : this.cellFormTranslation;
        const next = [...current] as [string, string, string];
        next[index] = value;
        if (field === 'rotation') {
            this.cellFormRotation = next;
        } else {
            this.cellFormTranslation = next;
        }
        this.update();
    }

    /**
     * Parse a region string into visual builder tokens.
     * @param regionString - Raw region expression string.
     * @returns Array of parsed tokens.
     */
    private parseRegionToTokens(
        regionString: string
    ): { type: 'surface' | 'operator'; value: string; id?: number; side?: 'positive' | 'negative' | 'complement' }[] {
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

    /**
     * Add a surface reference to the region being built.
     * @param surfaceId - Id of the surface to add.
     * @param side - Side of the surface (positive or negative).
     */
    private addSurfaceToRegion(surfaceId: number, side: 'positive' | 'negative'): void {
        const prefix = side === 'positive' ? '+' : '-';
        this.regionBuilderTokens.push({ type: 'surface', value: `${prefix}${surfaceId}`, id: surfaceId, side });
        this.updateRegionStringFromTokens();
        this.update();
    }

    private addOperatorToRegion(operator: 'intersection' | 'union' | 'complement' | 'open_paren' | 'close_paren'): void {
        const opMap: { [key: string]: string } = {
            intersection: 'intersection',
            union: 'union',
            complement: 'complement',
            open_paren: '(',
            close_paren: ')'
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
        const parts = this.regionBuilderTokens.map((token) => {
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
                console.warn(
                    `[CSG Builder] Warning: Surface ${id} used on both sides (+${id} and -${id}). This creates an empty/impossible region.`
                );
            }
        }
    }

    /**
     * Save the current cell (create new or update existing).
     */
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

        const rotationInput = parseOptionalVectorInput(this.cellFormRotation, 'Rotation');
        if (rotationInput.error) {
            this.messageService.error(rotationInput.error);
            return;
        }
        const translationInput = parseOptionalVectorInput(this.cellFormTranslation, 'Translation');
        if (translationInput.error) {
            this.messageService.error(translationInput.error);
            return;
        }
        const densityInput = parseDensityOverride(this.cellFormDensity);
        if (densityInput.error) {
            this.messageService.error(densityInput.error);
            return;
        }
        const fillError = fillTargetError(this.cellFormFillType, this.cellFormFillId);
        if (fillError) {
            this.messageService.error(fillError);
            return;
        }

        const cell: OpenMCCell = {
            id: this.editingCell.id || this.stateManager.getNextCellId(),
            name: this.cellFormName || undefined,
            fillType: this.cellFormFillType,
            fillId: this.cellFormFillType !== 'void' ? this.cellFormFillId : undefined,
            regionString: this.cellFormRegionString || undefined,
            temperature: this.cellFormTemperature,
            density: densityInput.value
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
            this.stateManager.assignCellToUniverse(cell.id, 0);
            this.messageService.info(`Created cell #${cell.id}`);
        }
        this.stateManager.setCellTransform(cell.id, {
            rotation: rotationInput.value,
            translation: translationInput.value
        });

        this.cancelForm();
    }

    /**
     * Delete a cell and remove it from all universes.
     * @param id - Cell id to delete.
     */
    private deleteCell(id: number): void {
        this.stateManager.removeCell(id);
        // Remove from universes
        const state = this.stateManager.getState();
        state.geometry.universes.forEach((universe) => {
            const idx = universe.cellIds.indexOf(id);
            if (idx >= 0) {
                universe.cellIds.splice(idx, 1);
            }
        });
        this.messageService.info(`Deleted cell #${id}`);
    }

    /**
     * Validate a region expression string for basic syntax correctness.
     * @param region - Region expression to validate.
     * @returns True if the region string is valid.
     */
    private validateRegionString(region: string): boolean {
        // Basic validation: check for surface IDs with +/-
        // Remove parentheses and operators
        const cleaned = region.replace(/[()|~\s]/g, ' ').trim();
        if (!cleaned) return true; // Empty region is valid (fills all space)

        const tokens = cleaned.split(/\s+/).filter((t) => t);
        for (const token of tokens) {
            // Each token should be +/- followed by a number
            if (!token.match(/^[+-]?\d+$/)) {
                return false;
            }
        }
        return true;
    }

    /**
     * Check if a region expression uses the same surface with both positive and negative sides.
     * @param region - Region expression to check.
     * @returns True if a contradiction is found.
     */
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
        // Simplified parser - for now just return a placeholder.
        return { type: 'operator', operator: 'intersection', children: [] };
    }

    // ============================================================================
    // CAD Import
    // ============================================================================

    /**
     * Import a CAD file (STEP/IGES/BREP/STL) and convert to OpenMC geometry.
     */
    private async importCADFile(): Promise<void> {
        const support = await this.backendService.checkCADSupport();

        if (!support.available) {
            this.messageService.warn(
                'CAD import requires gmsh or OpenCASCADE. ' + 'Install with: conda install -c conda-forge python-gmsh (or pip install gmsh)'
            );
        }

        const uri = await this.fileDialogService.showOpenDialog({
            title: 'Select CAD/DAGMC File',
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'All Supported Files': ['step', 'stp', 'iges', 'igs', 'brep', 'stl', 'h5m'],
                'STEP Files': ['step', 'stp'],
                'IGES Files': ['iges', 'igs'],
                'BREP Files': ['brep'],
                'STL Files': ['stl'],
                'DAGMC Files': ['h5m']
            }
        });

        if (!uri) {
            return;
        }

        const filePath = uri.path.toString();

        // Read user preferences for faceting tolerance
        const tolerance = this.preferences.get('openmcStudio.defaultFacetingTolerance', 0.001);
        const autoAdjust = this.preferences.get('openmcStudio.autoAdjustFacetingTolerance', true);

        // For CAD → DAGMC conversion, place the generated .h5m inside the project
        // directory when a project is saved; otherwise fall back to next to the
        // source file.
        const outputBaseDir = this.stateManager.projectPath ? path.dirname(this.stateManager.projectPath) : path.dirname(filePath);
        const dagmcOutput = path.join(outputBaseDir, path.basename(filePath, path.extname(filePath)) + '.h5m');

        this.isImportingCAD = true;
        this.update();

        try {
            const result = await this.backendService.importCAD({
                filePath: filePath,
                dagmcOutput: dagmcOutput,
                addGraveyard: true,
                options: {
                    tolerance: tolerance,
                    units: 'cm',
                    scale: 1.0,
                    autoAdjustTolerance: autoAdjust
                }
            });

            if (result.success) {
                this.messageService.info('CAD import complete');
                await this.handleCADImportResult(result, filePath);
            } else {
                this.messageService.error(`CAD import failed: ${result.error}`);
            }
        } catch (error) {
            this.messageService.error(`Error importing CAD: ${error}`);
        } finally {
            this.isImportingCAD = false;
            this.update();
        }
    }

    /**
     * Process the result of a CAD import operation.
     * @param result - Import result from the backend.
     * @param filePath - Optional original file path.
     */
    private async handleCADImportResult(result: CADImportResult, filePath?: string): Promise<void> {
        if (!result.success) {
            return;
        }

        // Log warnings if any
        if (result.warnings && result.warnings.length > 0) {
            console.warn('[CSG Builder] CAD import warnings:', result.warnings);
            // Only show first 5 warnings as toast messages
            for (const warning of result.warnings.slice(0, 5)) {
                this.messageService.warn(warning);
            }
            if (result.warnings.length > 5) {
                this.messageService.warn(`... and ${result.warnings.length - 5} more warnings (see console)`);
            }
        }

        // Handle DAGMC files differently - they are used directly
        if (result.fileInfo?.dagmc && result.fileInfo) {
            // Always use dagmcInfo from the backend. If the importer did not
            // populate it, load the DAGMC file explicitly to retrieve it.
            let dagmcInfo: DAGMCInfo | undefined = result.dagmcInfo;
            if (!dagmcInfo && result.dagmcFile) {
                const loadResult = await this.backendService.dagmcLoad(result.dagmcFile);
                if (loadResult.success && loadResult.data) {
                    const data = loadResult.data;
                    const materials: Record<string, { volumeCount: number; totalTriangles: number }> = {};
                    for (const [name, info] of Object.entries(data.materials)) {
                        materials[name] = {
                            volumeCount: info.volumeCount,
                            totalTriangles: info.volumes.reduce(
                                (sum, v) => sum + (data.volumes.find((vol) => vol.id === v)?.numTriangles ?? 0),
                                0
                            )
                        };
                    }
                    dagmcInfo = {
                        filePath: data.filePath,
                        fileName: data.fileName,
                        volumeCount: data.volumeCount,
                        surfaceCount: data.surfaceCount,
                        vertices: data.vertices,
                        materials,
                        volumes: data.volumes.map((v) => ({
                            id: v.id,
                            material: v.material || 'void',
                            numTriangles: v.numTriangles,
                            boundingBox: {
                                min: v.boundingBox.min as [number, number, number],
                                max: v.boundingBox.max as [number, number, number]
                            }
                        })),
                        boundingBox: {
                            min: data.boundingBox.min as [number, number, number],
                            max: data.boundingBox.max as [number, number, number]
                        },
                        fileSizeMB: data.fileSizeMB
                    };
                }
            }

            if (!dagmcInfo) {
                this.messageService.warn('CAD import succeeded but DAGMC metadata is unavailable.');
                return;
            }

            const matCount = Object.keys(dagmcInfo.materials).length;
            this.messageService.info(
                `DAGMC file loaded: ${dagmcInfo.volumeCount} volumes, ` + `${dagmcInfo.surfaceCount} surfaces, ` + `${matCount} materials`
            );

            // Store DAGMC file path AND dagmcInfo in shared state for use in simulation.
            // When a STEP/IGES file was converted to DAGMC, use the generated .h5m
            // path rather than the original CAD path.
            const dagmcFilePath = result.dagmcFile || filePath;
            if (dagmcFilePath) {
                this.stateManager.updateSettings({ dagmcFile: dagmcFilePath, dagmcInfo });
                this.messageService.info('DAGMC geometry will be used for simulation. ' + 'Settings updated with DAGMC file path.');
            }

            this.update();
            return;
        }

        // Show summary for CSG conversion
        const summary = result.summary;
        if (summary) {
            if (summary.cellsCreated > 0 || summary.surfacesCreated > 0) {
                this.messageService.info(
                    `CAD import complete: ${summary.surfacesCreated} surfaces, ` + `${summary.cellsCreated} cells created`
                );
            } else {
                this.messageService.info('CAD file loaded. Geometry extraction may require manual configuration.');
            }
        }

        // Show file info
        if (result.fileInfo) {
            console.log('[CSG Builder] CAD file info:', result.fileInfo);
        }

        // Add imported surfaces and cells to the state
        if (result.surfaces && result.surfaces.length > 0) {
            this.addImportedGeometry(result.surfaces, result.cells || []);
        }

        // Update the widget
        this.update();
    }

    /**
     * Add imported surfaces and cells to the current state with remapped ids.
     * @param surfaces - Imported surface definitions.
     * @param cells - Imported cell definitions.
     */
    private addImportedGeometry(
        surfaces: { type: string; coefficients: number[]; name?: string }[],
        cells: { id: number; name?: string; region: string; material?: string; universe?: number }[]
    ): void {
        const state = this.stateManager.getState();

        // Find next available IDs
        const nextSurfaceId = this.getNextSurfaceId(state);
        const nextCellId = this.getNextCellId(state);

        // Create ID mapping from imported IDs to new IDs
        const surfaceIdMap = new Map<number, number>();

        // Add surfaces
        for (let i = 0; i < surfaces.length; i++) {
            const imported = surfaces[i];
            const newId = nextSurfaceId + i;
            surfaceIdMap.set(i + 1, newId); // Imported surfaces are 1-indexed

            // Convert surface type and coefficients
            const surfaceType = this.mapCADSurfaceType(imported.type);
            const coefficients = this.convertCoefficients(surfaceType, imported.coefficients);

            const newSurface: OpenMCSurface = {
                id: newId,
                type: surfaceType,
                coefficients: coefficients as OpenMCSurface['coefficients'],
                name: imported.name || `${surfaceType}_${newId}`,
                boundary: 'transmission'
            };

            state.geometry.surfaces.push(newSurface);
        }

        // Add cells with updated region references
        for (let i = 0; i < cells.length; i++) {
            const imported = cells[i];
            const newId = nextCellId + i;

            // Remap surface IDs in region expression
            const remappedRegion = this.remapRegionSurfaceIds(imported.region, surfaceIdMap);

            const newCell: OpenMCCell = {
                id: newId,
                name: imported.name || `Cell_${newId}`,
                regionString: remappedRegion,
                fillType: imported.material === 'void' ? 'void' : 'material',
                fillId: imported.material && imported.material !== 'void' ? parseInt(imported.material, 10) : undefined
            };

            state.geometry.cells.push(newCell);
        }

        // Update state
        this.stateManager.setState(state);

        // Switch to appropriate tab
        if (surfaces.length > 0) {
            this.activeTab = 'surfaces';
        }
    }

    private getNextSurfaceId(state: OpenMCState): number {
        const ids = state.geometry.surfaces.map((s) => s.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    private getNextCellId(state: OpenMCState): number {
        const ids = state.geometry.cells.map((c) => c.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    /**
     * Map an imported CAD surface type to an OpenMC surface type.
     * @param cadType - CAD surface type string.
     * @returns Corresponding OpenMC surface type.
     */
    private mapCADSurfaceType(cadType: string): OpenMCSurfaceType {
        const typeMap: Record<string, OpenMCSurfaceType> = {
            plane: 'plane',
            'x-plane': 'x-plane',
            'y-plane': 'y-plane',
            'z-plane': 'z-plane',
            sphere: 'sphere',
            'x-cylinder': 'x-cylinder',
            'y-cylinder': 'y-cylinder',
            'z-cylinder': 'z-cylinder',
            cylinder: 'cylinder',
            'x-cone': 'x-cone',
            'y-cone': 'y-cone',
            'z-cone': 'z-cone',
            'x-torus': 'x-torus',
            'y-torus': 'y-torus',
            'z-torus': 'z-torus',
            quadric: 'quadric'
        };
        return typeMap[cadType] || 'plane';
    }

    /**
     * Convert flat array coefficients to named object coefficients based on surface type.
     * @param type - OpenMC surface type.
     * @param coeffs - Flat coefficient array.
     * @returns Named coefficient record.
     */
    private convertCoefficients(type: OpenMCSurfaceType, coeffs: number[]): Record<string, number> {
        // Convert array coefficients to object format based on surface type
        switch (type) {
            case 'plane':
                // Plane: [a, b, c, d] where ax + by + cz = d
                return { a: coeffs[0], b: coeffs[1], c: coeffs[2], d: coeffs[3] };
            case 'x-plane':
                return { x0: coeffs[0] };
            case 'y-plane':
                return { y0: coeffs[0] };
            case 'z-plane':
                return { z0: coeffs[0] };
            case 'sphere':
                // Sphere: [x0, y0, z0, r]
                return { x0: coeffs[0], y0: coeffs[1], z0: coeffs[2], r: coeffs[3] };
            case 'x-cylinder':
                // x-cylinder: [x0, y0, z0, ... axis ignored, r]
                return { y0: coeffs[1], z0: coeffs[2], r: coeffs[6] };
            case 'y-cylinder':
                return { x0: coeffs[0], z0: coeffs[2], r: coeffs[6] };
            case 'z-cylinder':
                return { x0: coeffs[0], y0: coeffs[1], r: coeffs[6] };
            case 'cylinder':
                // General cylinder: [x0, y0, z0, vx, vy, vz, r]
                return { x0: coeffs[0], y0: coeffs[1], z0: coeffs[2], r: coeffs[6], vx: coeffs[3], vy: coeffs[4], vz: coeffs[5] };
            case 'x-cone':
            case 'y-cone':
            case 'z-cone':
                // Cone: [x0, y0, z0, r2]
                return { x0: coeffs[0], y0: coeffs[1], z0: coeffs[2], r2: coeffs[3] };
            case 'x-torus':
            case 'y-torus':
            case 'z-torus':
                // Torus: [x0, y0, z0, a, b, c]
                return { x0: coeffs[0], y0: coeffs[1], z0: coeffs[2], a: coeffs[3], b: coeffs[4], c: coeffs[5] };
            case 'quadric':
                // Quadric: [a, b, c, d, e, f, g, h, j, k]
                return {
                    a: coeffs[0],
                    b: coeffs[1],
                    c: coeffs[2],
                    d: coeffs[3],
                    e: coeffs[4],
                    f: coeffs[5],
                    g: coeffs[6],
                    h: coeffs[7],
                    j: coeffs[8],
                    k: coeffs[9]
                };
            default:
                // Fallback - return all coefficients indexed
                const obj: Record<string, number> = {};
                coeffs.forEach((v, i) => {
                    obj[`c${i}`] = v;
                });
                return obj;
        }
    }

    /**
     * Remap surface ids within a region expression using an id mapping.
     * @param region - Region expression string.
     * @param idMap - Mapping from old surface ids to new surface ids.
     * @returns Region expression with remapped ids.
     */
    private remapRegionSurfaceIds(region: string, idMap: Map<number, number>): string {
        // Replace surface IDs in region expression
        // Handles patterns like "-1", "+1", "-1 & +2", etc.
        return region.replace(/([+-]?)(\d+)/g, (match, sign, idStr) => {
            const oldId = parseInt(idStr, 10);
            const newId = idMap.get(oldId);
            if (newId !== undefined) {
                return `${sign}${newId}`;
            }
            return match; // Keep original if not found
        });
    }

    // ============================================================================
    // Material Import
    // ============================================================================

    /**
     * Import materials from a materials.xml file.
     */
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
                    const existingIdx = currentState.materials.findIndex((m) => m.id === material.id);
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

    /**
     * Import geometry, materials, and settings from XML files in a directory.
     */
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

    /**
     * Create a new universe with the next available id.
     */
    private createUniverse(): void {
        const id = this.stateManager.getNextUniverseId();
        const universe: OpenMCUniverse = {
            id,
            name: `Universe ${id}`,
            cellIds: []
        };

        this.stateManager.addUniverse(universe);
        this.messageService.info(`Created universe #${id}`);
    }

    /**
     * Delete a universe if it is not referenced by any cell.
     * @param id - Universe id to delete.
     */
    private deleteUniverse(id: number): void {
        // Check if universe is used in any cells or lattice positions.
        const state = this.stateManager.getState();
        const usedInCells = state.geometry.cells.filter((cell) => cell.fillType === 'universe' && cell.fillId === id);
        const usedInLattices = state.geometry.lattices.filter(
            (lattice) => lattice.outer === id || (Array.isArray(lattice.universes) && lattice.universes.flat(2).includes(id))
        );

        if (usedInCells.length > 0) {
            this.messageService.warn(
                `Universe #${id} is used in cells: ${usedInCells.map((c) => `#${c.id}`).join(', ')}. Remove from cells first.`
            );
            return;
        }
        if (usedInLattices.length > 0) {
            this.messageService.warn(
                `Universe #${id} is used in lattices: ${usedInLattices.map((l) => `#${l.id}`).join(', ')}. Remove it from the lattice first.`
            );
            return;
        }

        try {
            this.stateManager.removeUniverse(id);
            this.messageService.info(`Deleted universe #${id}`);
        } catch (error) {
            this.messageService.error(`Cannot delete universe: ${error}`);
        }
    }

    /**
     * Assign a cell to a universe.
     * @param cellId - Id of the cell to assign.
     * @param universeId - Id of the target universe.
     */
    private assignCellToUniverse(cellId: number, universeId: number): void {
        try {
            this.stateManager.assignCellToUniverse(cellId, universeId);
            this.messageService.info(`Assigned cell #${cellId} to universe #${universeId}`);
        } catch (error) {
            this.messageService.error(`Failed to assign cell: ${error}`);
        }
    }

    /**
     * Remove a cell from a universe.
     * @param cellId - Id of the cell to remove.
     * @param universeId - Id of the universe to remove from.
     */
    private removeCellFromUniverse(cellId: number, universeId: number): void {
        this.stateManager.removeCellFromUniverse(cellId, universeId);
        this.messageService.info(`Removed cell #${cellId} from universe #${universeId}`);
    }

    // ============================================================================
    // Save / Save As
    // ============================================================================

    /**
     * Render save action buttons based on current save location state.
     * @returns Save buttons React node.
     */
    private renderSaveButtons(): React.ReactNode {
        if (this.saveOutputPath) {
            // Have a save location - show Save and Save As
            return (
                <>
                    <Tooltip content={`Save to ${this.saveOutputPath}`} position="bottom">
                        <button className="theia-button primary" onClick={() => this.saveXML()}>
                            <i className="codicon codicon-save"></i>
                            Save
                        </button>
                    </Tooltip>
                    <Tooltip content="Save to different location" position="bottom">
                        <button className="theia-button secondary" onClick={() => this.saveXMLAs()}>
                            <i className="codicon codicon-save-as"></i>
                            Save As...
                        </button>
                    </Tooltip>
                </>
            );
        } else {
            // No save location yet - show Save As only
            return (
                <Tooltip content="Save geometry.xml to a folder" position="bottom">
                    <button className="theia-button primary" onClick={() => this.saveXMLAs()}>
                        <i className="codicon codicon-save"></i>
                        Save As...
                    </button>
                </Tooltip>
            );
        }
    }

    /**
     * Save geometry XML to the current output path.
     */
    private async saveXML(): Promise<void> {
        if (!this.saveOutputPath) {
            return this.saveXMLAs();
        }
        await this.performSave(this.saveOutputPath, true);
    }

    /**
     * Prompt user for an output directory and save geometry XML there.
     */
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

    /**
     * Debounced auto-save to the current output path when geometry changes.
     */
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

    /**
     * Perform the actual XML generation and save operation.
     * @param outputPath - Directory path to save XML files into.
     * @param showMessages - Whether to show toast messages on success/failure.
     * @returns True if save succeeded.
     */
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
                    const geomFile = result.generatedFiles.find((f) => f.includes('geometry.xml'));
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

    /**
     * Open a native 3D preview of the current CSG geometry.
     *
     * Saves the model to `geometry.xml`, then delegates to
     * `OpenMCService.openGeometryViewer` (headless `extractGeometryMesh` →
     * `GeometryNativeViewerWidget.setModelFile`) — the same native path the
     * geometry tree's View 3D uses.
     */
    private async previewGeometry(): Promise<void> {
        const state = this.stateManager.getState();

        if (state.geometry.cells.length === 0) {
            this.messageService.warn('No cells defined. Create at least one cell before previewing.');
            return;
        }

        // Need a save location to preview. An opened project saves beside its
        // project file instead of prompting on every preview.
        let previewDir = this.saveOutputPath;
        if (!previewDir && this.stateManager.projectPath) {
            previewDir = path.dirname(this.stateManager.projectPath);
            this.saveOutputPath = previewDir;
        }
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

            const widget = await this.openmcService.openGeometryViewer(uri);
            if (widget) {
                this.messageService.info('3D preview loaded');
            }
        } catch (error) {
            this.messageService.error(`Preview error: ${error}`);
        }
    }

    /**
     * Open the DAGMC Editor widget for the loaded DAGMC file.
     * @see {@link DAGMCEditorWidget}
     */
    private async openDagmcEditor(): Promise<void> {
        const state = this.stateManager.getState();
        if (state.settings?.dagmcFile) {
            await this.commands.executeCommand('openmc.openDAGMCEditor', state.settings.dagmcFile);
        } else {
            this.messageService.warn('No DAGMC file loaded');
        }
    }

    // ============================================================================
    // Form Utilities
    // ============================================================================

    /**
     * Reset all form editing state and close any open editors.
     */
    private cancelForm(): void {
        this.editingSurface = undefined;
        this.creatingSurfaceType = undefined;
        this.editingCell = undefined;
        this.surfaceFormType = 'sphere';
        this.surfaceFormCoeffs = {};
        this.surfaceFormBoundary = 'vacuum';
        this.surfaceFormName = '';
        this.surfaceFormAlbedo = '';
        this.surfaceFormPeriodicId = '';
        this.showSurfaceEditor = false;
        this.cellFormName = '';
        this.cellFormFillType = 'void';
        this.cellFormFillId = 0;
        this.cellFormRegionString = '';
        this.cellFormTemperature = undefined;
        this.cellFormRotation = ['', '', ''];
        this.cellFormTranslation = ['', '', ''];
        this.cellFormDensity = '';
        this.regionBuilderTokens = [];

        this.update();
    }
}

// ============================================================================
// Lattice Grid Cell Component (for performance with useTooltip)
// ============================================================================

/**
 * Props for the lattice grid cell component.
 */
interface LatticeGridCellProps {
    /** Universe id displayed in the cell. */
    univId: number;
    /** Column index in the lattice grid. */
    col: number;
    /** Row index in the lattice grid. */
    row: number;
}

const LatticeGridCell: React.FC<LatticeGridCellProps> = ({ univId, col, row }) => {
    const { onMouseEnter, onMouseLeave, tooltipElement } = useTooltip(`Position [${col}, ${row}]: Universe ${univId}`, 'top');

    return (
        <>
            <div className={`grid-cell ${univId === 0 ? 'empty' : 'filled'}`} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
                {univId !== 0 && <span>{univId}</span>}
            </div>
            {tooltipElement}
        </>
    );
};
