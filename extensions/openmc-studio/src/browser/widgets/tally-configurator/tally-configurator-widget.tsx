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

import * as React from 'react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';
import { FileDialogService, OpenFileDialogProps } from '@theia/filesystem/lib/browser';
import { OpenMCStateManager } from '../../openmc-state-manager';
import { OpenMCStudioService } from '../../openmc-studio-service';
import { NukeCoreService, NukeCoreStatusBarVisibility, NukeCoreStatusBarVisibilityService } from 'nuke-core/lib/common';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { OpenMCTally, OpenMCMesh } from '../../../common/openmc-state-schema';
import { OpenMCCompat } from '../../../common/openmc-studio-protocol';
import { DAGMC_PACKAGES } from '../../../common/packages';
import { inferUnstructuredMeshLibrary } from '../../../common/mesh-utils';
import { MeshPanel } from './components/mesh-panel';
import { MeshEditor, MeshFileInfo } from './components/mesh-editor';
import { TallyList } from './components/tally-list';
import { TallyEditor } from './components/tally-editor';
import { DerivedTallyPanel } from './components/derived-tally-panel';

/**
 * Internal state for the tally configurator widget.
 */
interface TallyConfiguratorState {
    /** ID of the currently selected tally */
    selectedTallyId?: number;
    /** ID of the currently selected mesh */
    selectedMeshId?: number;
    /** Active tab: simulation tallies, meshes, or analysis-only derived tallies */
    activeTab: 'tallies' | 'meshes' | 'derived';
    /** Tally currently being edited (if any) */
    editingTally?: OpenMCTally;
    /** Mesh currently being edited (if any) */
    editingMesh?: OpenMCMesh;
}

/**
 * Widget for configuring OpenMC tallies and meshes.
 *
 * Provides a two-tab interface for defining simulation outputs (tallies)
 * and spatial grids (meshes) used in radiation transport simulations.
 *
 * @see {@link TallyList}
 * @see {@link TallyEditor}
 * @see {@link MeshPanel}
 * @see {@link MeshEditor}
 */
@injectable()
export class TallyConfiguratorWidget extends ReactWidget {
    static readonly ID = 'openmc-tally-configurator';
    static readonly LABEL = 'OpenMC Tally Configurator';

    @inject(OpenMCStateManager)
    protected readonly stateManager: OpenMCStateManager;

    @inject(OpenMCStudioService)
    protected readonly studioService: OpenMCStudioService;

    @inject(NukeCoreStatusBarVisibility)
    protected readonly statusBarVisibility!: NukeCoreStatusBarVisibilityService;

    @inject(NukeCoreService)
    protected readonly nukeCore: NukeCoreService;

    @inject(FileDialogService)
    protected readonly fileDialogService: FileDialogService;

    protected state: TallyConfiguratorState = {
        activeTab: 'tallies'
    };

    private visibilityHandle?: { dispose: () => void };

    /** Filesystem status cache for unstructured mesh files (keyed by mesh ID). */
    private readonly meshFileInfo = new Map<number, MeshFileInfo>();
    /** Inputs used for the cached status, to detect filename changes. */
    private readonly meshFileKeys = new Map<number, string>();
    /** Pending debounced file checks, keyed by mesh ID. */
    private readonly meshFileTimers = new Map<number, ReturnType<typeof setTimeout>>();
    /** Probed capabilities for 0.16-only filters and mesh-filter rotation. */
    private compat?: OpenMCCompat;
    /** Avoid re-requesting the compatibility probe on every render. */
    private compatRequested = false;
    /** MOAB package availability in the configured Python environment. */
    private moabAvailable?: boolean;
    /** Whether the MOAB package check is running. */
    private moabChecking = false;
    /** Avoid re-running the MOAB check on every render. */
    private moabRequested = false;

    /**
     * Initialize widget id, title, and subscribe to state changes.
     */
    @postConstruct()
    protected init(): void {
        this.id = TallyConfiguratorWidget.ID;
        this.title.label = TallyConfiguratorWidget.LABEL;
        this.title.caption = TallyConfiguratorWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-openmc-tally';

        this.toDispose.push(this.stateManager.onStateChange(() => this.update()));
        this.toDispose.push({
            dispose: () => {
                for (const timer of this.meshFileTimers.values()) {
                    clearTimeout(timer);
                }
                this.meshFileTimers.clear();
            }
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
     * Render the main widget content.
     * @returns The React node tree.
     */
    protected render(): React.ReactNode {
        return (
            <div className="tally-configurator tally-configurator-container">
                {this.renderHeader()}
                {this.renderTabs()}
                <div className="tally-configurator-content">
                    {this.state.activeTab === 'tallies' && this.renderTalliesTab()}
                    {this.state.activeTab === 'meshes' && this.renderMeshesTab()}
                    {this.state.activeTab === 'derived' && this.renderDerivedTab()}
                </div>
            </div>
        );
    }

    /**
     * Render the widget header with summary statistics.
     * @returns Header React node.
     */
    private renderHeader(): React.ReactNode {
        const state = this.stateManager.getState();
        const tallies = state.tallies || [];
        const meshes = state.meshes || [];
        const derivedTallies = state.derivedTallies || [];
        const totalFilters = tallies.reduce((sum, tally) => sum + tally.filters.length, 0);

        return (
            <div className="tally-configurator-header">
                <div className="header-info">
                    <h2>
                        <i className="codicon codicon-openmc-tally"></i>
                        Tally & Mesh Configurator
                    </h2>
                    <p className="header-description">
                        Define simulation outputs (tallies) and spatial grids (meshes) for collecting radiation transport data
                    </p>
                </div>
                <div className="header-stats">
                    <div className="stat-item">
                        <span className="stat-value">{tallies.length}</span>
                        <span className="stat-label">Tallies</span>
                    </div>
                    <div className="stat-item">
                        <span className="stat-value">{meshes.length}</span>
                        <span className="stat-label">Meshes</span>
                    </div>
                    <div className="stat-item">
                        <span className="stat-value">{totalFilters}</span>
                        <span className="stat-label">Filters</span>
                    </div>
                    <div className="stat-item">
                        <span className="stat-value">{derivedTallies.length}</span>
                        <span className="stat-label">Derived</span>
                    </div>
                </div>
            </div>
        );
    }

    /**
     * Render the tab selector for tallies / meshes.
     * @returns Tabs React node.
     */
    private renderTabs(): React.ReactNode {
        const tabs = [
            { id: 'tallies', label: 'Tallies', icon: 'codicon-openmc-tally' },
            { id: 'meshes', label: 'Meshes', icon: 'codicon-openmc-grid' },
            { id: 'derived', label: 'Derived Tallies', icon: 'codicon-openmc-derived' }
        ];

        return (
            <div className="tally-configurator-tabs">
                {tabs.map((tab) => (
                    <Tooltip key={tab.id} content={tab.label} position="bottom">
                        <button
                            className={`tab-button ${this.state.activeTab === tab.id ? 'active' : ''}`}
                            aria-label={tab.label}
                            onClick={() => this.setState({ activeTab: tab.id as 'tallies' | 'meshes' | 'derived' })}
                        >
                            <i className={`codicon ${tab.icon}`}></i>
                            <span className="tab-label">{tab.label}</span>
                        </button>
                    </Tooltip>
                ))}
            </div>
        );
    }

    /**
     * Render the tallies tab content.
     * @returns Tallies tab React node.
     */
    protected renderTalliesTab(): React.ReactNode {
        const state = this.stateManager.getState();
        const tallies = state.tallies || [];
        const meshes = state.meshes || [];
        const selectedTally = tallies.find((t) => t.id === this.state.selectedTallyId);
        const needsCompat = tallies.some((tally) =>
            tally.filters.some((filter) =>
                ['mesh', 'meshsurface', 'meshborn', 'meshmaterial', 'reaction', 'particleproduction'].includes(filter.type)
            )
        );
        if (needsCompat && !this.compatRequested) {
            this.ensureCompat();
        }

        return (
            <div className="tallies-tab-container">
                <div className="left-panel">
                    <TallyList
                        tallies={tallies}
                        selectedTallyId={this.state.selectedTallyId}
                        onSelectTally={(id) => this.setState({ selectedTallyId: id })}
                        onAddTally={() => this.addNewTally()}
                        onDeleteTally={(id) => this.stateManager.removeTally(id)}
                    />
                    <div className="quick-add-panel">
                        <h4>Templates</h4>
                        <div className="template-buttons">
                            <button onClick={() => this.addTemplateTally('meshFlux')} disabled={meshes.length === 0}>
                                Mesh Flux
                            </button>
                            <button onClick={() => this.addTemplateTally('cellFission')}>Cell Fission</button>
                            <button onClick={() => this.addTemplateTally('surfaceCurrent')}>Surface Current</button>
                            <button onClick={() => this.addTemplateTally('activation')}>Activation</button>
                            <button onClick={() => this.addTemplateTally('heating')}>Heating</button>
                        </div>
                    </div>
                </div>
                <div className="tally-editor-panel">
                    {selectedTally ? (
                        <TallyEditor
                            tally={selectedTally}
                            meshes={meshes}
                            materials={state.materials}
                            cells={state.geometry.cells}
                            triggerBatchInterval={this.stateManager.getState().settings.triggers?.batchInterval}
                            multiGroup={state.settings.energyMode === 'multigroup'}
                            meshRotationSupported={this.compat?.meshFilterRotation}
                            reactionFilterSupported={this.compat?.reactionFilter}
                            particleProductionFilterSupported={this.compat?.particleProductionFilter}
                            compat={this.compat}
                            onUpdate={(updates) => this.stateManager.updateTally(selectedTally.id, updates)}
                        />
                    ) : (
                        <div className="placeholder-message">Select a tally to edit or add a new one.</div>
                    )}
                </div>
            </div>
        );
    }

    /**
     * Render the meshes tab content.
     * @returns Meshes tab React node.
     */
    protected renderMeshesTab(): React.ReactNode {
        const meshes = this.stateManager.getState().meshes || [];
        const selectedMesh = meshes.find((m) => m.id === this.state.selectedMeshId);
        const dagmcInfo = this.stateManager.getState().settings.dagmcInfo;

        if (selectedMesh?.type === 'unstructured') {
            this.ensureMeshFileInfo(selectedMesh);
        }

        return (
            <div className="meshes-tab-container">
                <div className="left-panel">
                    <MeshPanel
                        meshes={meshes}
                        selectedMeshId={this.state.selectedMeshId}
                        onSelectMesh={(id) => this.setState({ selectedMeshId: id })}
                        onAddMesh={() => this.addNewMesh()}
                        onDeleteMesh={(id) => this.stateManager.removeMesh(id)}
                    />
                </div>
                <div className="mesh-editor-panel">
                    {selectedMesh ? (
                        <MeshEditor
                            mesh={selectedMesh}
                            dagmcBoundingBox={dagmcInfo?.boundingBox}
                            fileInfo={this.meshFileInfo.get(selectedMesh.id)}
                            onBrowseFile={selectedMesh.type === 'unstructured' ? () => this.browseMeshFile(selectedMesh) : undefined}
                            onCheckFile={selectedMesh.type === 'unstructured' ? () => this.recheckMeshFile(selectedMesh) : undefined}
                            moabAvailable={this.moabAvailable}
                            moabChecking={this.moabChecking}
                            onCheckDependency={() => this.checkMoabDependency()}
                            onUpdate={(updates) => this.stateManager.updateMesh(selectedMesh.id, updates)}
                        />
                    ) : (
                        <div className="placeholder-message">Select a mesh to edit or add a new one.</div>
                    )}
                </div>
            </div>
        );
    }

    /**
     * Render the analysis-only derived tallies tab.
     * @returns Derived tallies React node.
     */
    protected renderDerivedTab(): React.ReactNode {
        const state = this.stateManager.getState();
        return (
            <DerivedTallyPanel
                derivedTallies={state.derivedTallies ?? []}
                tallies={state.tallies}
                meshes={state.meshes}
                onAdd={(derivedTally) => this.stateManager.addDerivedTally(derivedTally)}
                onUpdate={(id, updates) => this.stateManager.updateDerivedTally(id, updates)}
                onDelete={(id) => this.stateManager.removeDerivedTally(id)}
            />
        );
    }

    /**
     * Fetch the probed capabilities lazily, only when a filter that depends on
     * them is on screen. Probing runs Python environment detection on the
     * backend, so doing it at widget startup would stall unrelated file checks.
     */
    private ensureCompat(): void {
        this.compatRequested = true;
        void this.studioService.getOpenMCCompat().then((compat) => {
            this.compat = compat;
            this.update();
        });
    }

    /**
     * Open the file picker for an unstructured mesh, store the path, and infer
     * the library from the extension.
     *
     * @param mesh - Unstructured mesh being edited.
     */
    protected async browseMeshFile(mesh: OpenMCMesh): Promise<void> {
        const props: OpenFileDialogProps = {
            title: 'Select Unstructured Mesh File',
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'Unstructured Meshes': ['h5m', 'h5', 'vtk', 'e', 'exo', 'ex2'],
                'MOAB (HDF5 / VTK)': ['h5m', 'h5', 'vtk'],
                'Exodus (libMesh)': ['e', 'exo', 'ex2'],
                'All Files': ['*']
            }
        };
        const uri = await this.fileDialogService.showOpenDialog(props);
        if (!uri) {
            return;
        }
        const filename = uri.path.toString();
        const inferred = inferUnstructuredMeshLibrary(filename);
        this.invalidateMeshFileInfo(mesh.id);
        this.stateManager.updateMesh(mesh.id, inferred ? { filename, library: inferred } : { filename });
        if (mesh.type === 'unstructured') {
            this.ensureMeshFileInfo({ ...mesh, filename, library: inferred ?? mesh.library });
        }
    }

    /**
     * Re-check the configured mesh file after the user changed it on disk.
     *
     * @param mesh - Unstructured mesh being edited.
     */
    protected recheckMeshFile(mesh: OpenMCMesh): void {
        this.invalidateMeshFileInfo(mesh.id);
        if (mesh.type === 'unstructured') {
            this.ensureMeshFileInfo(mesh);
        }
    }

    /**
     * Drop the cached filesystem status for a mesh.
     *
     * @param meshId - Mesh ID.
     */
    private invalidateMeshFileInfo(meshId: number): void {
        this.meshFileInfo.delete(meshId);
        this.meshFileKeys.delete(meshId);
        const timer = this.meshFileTimers.get(meshId);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.meshFileTimers.delete(meshId);
        }
    }

    /**
     * Start a filesystem check for an unstructured mesh when the filename
     * changed, then re-render with the result.
     *
     * @param mesh - Unstructured mesh.
     */
    private ensureMeshFileInfo(mesh: OpenMCMesh): void {
        if (mesh.type !== 'unstructured') {
            return;
        }
        const key = `${mesh.id}:${mesh.filename}:${this.stateManager.projectPath ?? ''}`;
        if (this.meshFileKeys.get(mesh.id) === key) {
            return;
        }
        this.meshFileKeys.set(mesh.id, key);
        this.meshFileInfo.set(mesh.id, { status: 'checking' });
        const pending = this.meshFileTimers.get(mesh.id);
        if (pending !== undefined) {
            clearTimeout(pending);
        }
        // Debounce so typing a path does not queue a backend stat per keystroke.
        this.meshFileTimers.set(
            mesh.id,
            setTimeout(() => {
                this.meshFileTimers.delete(mesh.id);
                void this.checkMeshFile(mesh.id, mesh.filename, key);
            }, 400)
        );
    }

    /**
     * Resolve and stat an unstructured mesh file.
     *
     * @param meshId - Mesh ID.
     * @param filename - Configured filename.
     * @param key - Cache key captured before the async check.
     */
    private async checkMeshFile(meshId: number, filename: string, key: string): Promise<void> {
        let info: MeshFileInfo;
        if (!filename.trim()) {
            info = { status: 'unknown' };
        } else {
            const absolute = this.isAbsoluteFilePath(filename);
            const projectPath = this.stateManager.projectPath;
            if (!absolute && !projectPath) {
                info = { status: 'relative', checkedPath: filename };
            } else {
                const resolved = absolute ? filename : new URI(projectPath!).parent.resolve(filename).path.toString();
                // Stat on the backend: Theia's browser FileService can stall for
                // paths outside the workspace, and the editor must never sit on
                // "Checking file…" forever.
                const result = await this.withMeshCheckTimeout(this.studioService.getBackendService().checkFileExists(resolved), 60000);
                if (result === undefined) {
                    info = { status: 'unknown', checkedPath: resolved, error: 'the file check did not respond' };
                } else if (result.exists) {
                    info = { status: 'exists', size: result.size, checkedPath: resolved };
                } else {
                    info = { status: 'missing', checkedPath: resolved, error: result.error };
                }
            }
        }
        // Only apply when the mesh/filename/project has not changed meanwhile.
        if (this.meshFileKeys.get(meshId) === key) {
            this.meshFileInfo.set(meshId, info);
            this.update();
        }
    }

    /**
     * Bound a filesystem check so a stalled provider cannot hang the editor.
     *
     * @param promise - Filesystem operation.
     * @param timeoutMs - Maximum wait in milliseconds.
     * @returns The operation result, or `undefined` on timeout.
     */
    private async withMeshCheckTimeout<T>(promise: Promise<T>, timeoutMs = 5000): Promise<T | undefined> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), timeoutMs);
        });
        try {
            return await Promise.race([promise, timeout]);
        } finally {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
        }
    }

    /**
     * Test whether a path is absolute (POSIX, Windows drive, or UNC).
     *
     * @param filename - Path to inspect.
     */
    private isAbsoluteFilePath(filename: string): boolean {
        return filename.startsWith('/') || filename.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(filename);
    }

    /**
     * Check the MOAB Python package on demand; drives the unstructured
     * dependency hint without blocking the initial mesh-file check.
     */
    private checkMoabDependency(): void {
        if (this.moabRequested) {
            return;
        }
        this.moabRequested = true;
        this.moabChecking = true;
        this.update();
        const moabPackage = DAGMC_PACKAGES.find((pkg) => pkg.name === 'moab');
        if (!moabPackage) {
            this.moabChecking = false;
            this.update();
            return;
        }
        void this.nukeCore
            .healthCheck([moabPackage])
            .then((result) => {
                const check = result.checks.find((item) => item.name === `Package: ${moabPackage.name}`);
                this.moabAvailable = check ? check.passed : undefined;
                this.moabChecking = false;
                this.update();
            })
            .catch(() => {
                this.moabAvailable = undefined;
                this.moabChecking = false;
                this.update();
            });
    }

    /**
     * Merge partial state updates and trigger a re-render.
     * @param newState - Partial state to merge.
     */
    protected setState(newState: Partial<TallyConfiguratorState>): void {
        this.state = { ...this.state, ...newState };
        this.update();
    }

    /**
     * Create a new tally with default values and select it.
     */
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

    /**
     * Create a new regular mesh with default bounds and select it.
     */
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

    /**
     * Add a pre-configured tally from a named template.
     * @param template - The template type to instantiate.
     */
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
