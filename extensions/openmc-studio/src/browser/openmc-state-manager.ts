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
 * OpenMC State Manager
 * 
 * Manages the current OpenMC simulation state and provides methods for
 * state manipulation, validation, and change notifications.
 * 
 * @module openmc-studio/browser
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';

import {
    OpenMCState,
    OpenMCProjectMetadata,
    OpenMCMaterial,
    OpenMCSurface,
    OpenMCCell,
    OpenMCTally,
    OpenMCMesh,
    OpenMCSettings,
    OPENMC_STATE_SCHEMA_VERSION
} from '../common/openmc-state-schema';

import {
    StateChangeEvent,
    ValidationResult,
    OpenMCStudioBackendService
} from '../common/openmc-studio-protocol';

/** Default empty state */
export function createDefaultState(): OpenMCState {
    const now = new Date().toISOString();
    
    return {
        metadata: {
            version: OPENMC_STATE_SCHEMA_VERSION,
            name: 'Untitled Project',
            description: '',
            created: now,
            modified: now
        },
        geometry: {
            surfaces: [],
            cells: [],
            universes: [{
                id: 0,
                name: 'root',
                cellIds: [],
                isRoot: true
            }],
            lattices: [],
            rootUniverseId: 0
        },
        materials: [],
        settings: {
            run: {
                mode: 'eigenvalue',
                particles: 1000,
                inactive: 10,
                batches: 100
            },
            sources: [{
                spatial: {
                    type: 'box',
                    lowerLeft: [-5, -5, -5],
                    upperRight: [5, 5, 5]
                },
                energy: {
                    type: 'discrete',
                    energies: [1e6]
                }
            }],
            sourceRejectionFraction: 0.0  // Allow sources to be placed anywhere
        },
        tallies: [],
        meshes: []
    };
}

@injectable()
export class OpenMCStateManager {
    
    @inject(MessageService)
    protected readonly messageService: MessageService;
    
    @inject(OpenMCStudioBackendService)
    protected readonly backendService: OpenMCStudioBackendService;

    private _state: OpenMCState = createDefaultState();
    private _isDirty = false;
    private _projectPath?: string;

    // State change emitters
    private readonly _onStateChange = new Emitter<StateChangeEvent>();
    readonly onStateChange: Event<StateChangeEvent> = this._onStateChange.event;

    private readonly _onStateReload = new Emitter<OpenMCState>();
    readonly onStateReload: Event<OpenMCState> = this._onStateReload.event;

    private readonly _onDirtyChange = new Emitter<boolean>();
    readonly onDirtyChange: Event<boolean> = this._onDirtyChange.event;

    // ============================================================================
    // State Accessors
    // ============================================================================

    /**
     * Get the current state.
     */
    getState(): OpenMCState {
        // Return a copy to prevent direct mutation
        return JSON.parse(JSON.stringify(this._state));
    }

    /**
     * Replace the entire state.
     */
    setState(state: OpenMCState, markDirty = true): void {
        this._state = JSON.parse(JSON.stringify(state));
        this._state.metadata.modified = new Date().toISOString();
        
        if (markDirty) {
            this.markDirty();
        }
        
        this._onStateReload.fire(this.getState());
    }

    /**
     * Whether the state has unsaved changes.
     */
    get isDirty(): boolean {
        return this._isDirty;
    }

    /**
     * Path to the current project file (if saved).
     */
    get projectPath(): string | undefined {
        return this._projectPath;
    }

    // ============================================================================
    // State Modifications
    // ============================================================================

    /**
     * Update metadata.
     */
    updateMetadata(updates: Partial<OpenMCProjectMetadata>): void {
        this._state.metadata = { ...this._state.metadata, ...updates };
        this._state.metadata.modified = new Date().toISOString();
        this.markDirty();
        
        this._onStateChange.fire({
            path: 'metadata',
            type: 'update',
            value: this._state.metadata
        });
    }

    /**
     * Add a material.
     */
    addMaterial(material: OpenMCMaterial): void {
        this._state.materials.push(material);
        this.markDirty();
        
        this._onStateChange.fire({
            path: `materials.${material.id}`,
            type: 'add',
            value: material
        });
    }

    /**
     * Update a material.
     */
    updateMaterial(id: number, updates: Partial<OpenMCMaterial>): void {
        const index = this._state.materials.findIndex(m => m.id === id);
        if (index >= 0) {
            const oldValue = this._state.materials[index];
            this._state.materials[index] = { ...oldValue, ...updates };
            this.markDirty();
            
            this._onStateChange.fire({
                path: `materials.${id}`,
                type: 'update',
                value: this._state.materials[index],
                oldValue
            });
        }
    }

    /**
     * Remove a material.
     */
    removeMaterial(id: number): void {
        const index = this._state.materials.findIndex(m => m.id === id);
        if (index >= 0) {
            const oldValue = this._state.materials[index];
            this._state.materials.splice(index, 1);
            this.markDirty();
            
            this._onStateChange.fire({
                path: `materials.${id}`,
                type: 'delete',
                oldValue
            });
        }
    }

    /**
     * Add a surface.
     */
    addSurface(surface: OpenMCSurface): void {
        this._state.geometry.surfaces.push(surface);
        this.markDirty();
        
        this._onStateChange.fire({
            path: `geometry.surfaces.${surface.id}`,
            type: 'add',
            value: surface
        });
    }

    /**
     * Update a surface.
     */
    updateSurface(id: number, updates: Partial<OpenMCSurface>): void {
        const index = this._state.geometry.surfaces.findIndex(s => s.id === id);
        if (index >= 0) {
            const oldValue = this._state.geometry.surfaces[index];
            this._state.geometry.surfaces[index] = { ...oldValue, ...updates };
            this.markDirty();
            
            this._onStateChange.fire({
                path: `geometry.surfaces.${id}`,
                type: 'update',
                value: this._state.geometry.surfaces[index],
                oldValue
            });
        }
    }

    /**
     * Remove a surface.
     */
    removeSurface(id: number): void {
        const index = this._state.geometry.surfaces.findIndex(s => s.id === id);
        if (index >= 0) {
            const oldValue = this._state.geometry.surfaces[index];
            this._state.geometry.surfaces.splice(index, 1);
            this.markDirty();
            
            this._onStateChange.fire({
                path: `geometry.surfaces.${id}`,
                type: 'delete',
                oldValue
            });
        }
    }

    /**
     * Add a cell.
     */
    addCell(cell: OpenMCCell): void {
        this._state.geometry.cells.push(cell);
        this.markDirty();
        
        this._onStateChange.fire({
            path: `geometry.cells.${cell.id}`,
            type: 'add',
            value: cell
        });
    }

    /**
     * Update a cell.
     */
    updateCell(id: number, updates: Partial<OpenMCCell>): void {
        const index = this._state.geometry.cells.findIndex(c => c.id === id);
        if (index >= 0) {
            const oldValue = this._state.geometry.cells[index];
            this._state.geometry.cells[index] = { ...oldValue, ...updates };
            this.markDirty();
            
            this._onStateChange.fire({
                path: `geometry.cells.${id}`,
                type: 'update',
                value: this._state.geometry.cells[index],
                oldValue
            });
        }
    }

    /**
     * Remove a cell.
     */
    removeCell(id: number): void {
        const index = this._state.geometry.cells.findIndex(c => c.id === id);
        if (index >= 0) {
            const oldValue = this._state.geometry.cells[index];
            this._state.geometry.cells.splice(index, 1);
            this.markDirty();
            
            this._onStateChange.fire({
                path: `geometry.cells.${id}`,
                type: 'delete',
                oldValue
            });
        }
    }

    /**
     * Update settings.
     */
    updateSettings(updates: Partial<OpenMCSettings>): void {
        this._state.settings = { ...this._state.settings, ...updates };
        this.markDirty();
        
        this._onStateChange.fire({
            path: 'settings',
            type: 'update',
            value: this._state.settings
        });
    }

    /**
     * Add a tally.
     */
    addTally(tally: OpenMCTally): void {
        this._state.tallies.push(tally);
        this.markDirty();
        
        this._onStateChange.fire({
            path: `tallies.${tally.id}`,
            type: 'add',
            value: tally
        });
    }

    /**
     * Update a tally.
     */
    updateTally(id: number, updates: Partial<OpenMCTally>): void {
        const index = this._state.tallies.findIndex(t => t.id === id);
        if (index >= 0) {
            const oldValue = this._state.tallies[index];
            this._state.tallies[index] = { ...oldValue, ...updates };
            this.markDirty();
            
            this._onStateChange.fire({
                path: `tallies.${id}`,
                type: 'update',
                value: this._state.tallies[index],
                oldValue
            });
        }
    }

    /**
     * Remove a tally.
     */
    removeTally(id: number): void {
        const index = this._state.tallies.findIndex(t => t.id === id);
        if (index >= 0) {
            const oldValue = this._state.tallies[index];
            this._state.tallies.splice(index, 1);
            this.markDirty();
            
            this._onStateChange.fire({
                path: `tallies.${id}`,
                type: 'delete',
                oldValue
            });
        }
    }

    /**
     * Add a mesh.
     */
    addMesh(mesh: OpenMCMesh): void {
        this._state.meshes.push(mesh);
        this.markDirty();
        
        this._onStateChange.fire({
            path: `meshes.${mesh.id}`,
            type: 'add',
            value: mesh
        });
    }

    /**
     * Update a mesh.
     */
    updateMesh(id: number, updates: Partial<OpenMCMesh>): void {
        const index = this._state.meshes.findIndex(m => m.id === id);
        if (index >= 0) {
            const oldValue = this._state.meshes[index];
            this._state.meshes[index] = { ...oldValue, ...updates } as OpenMCMesh;
            this.markDirty();
            
            this._onStateChange.fire({
                path: `meshes.${id}`,
                type: 'update',
                value: this._state.meshes[index],
                oldValue
            });
        }
    }

    /**
     * Remove a mesh.
     */
    removeMesh(id: number): void {
        const index = this._state.meshes.findIndex(m => m.id === id);
        if (index >= 0) {
            const oldValue = this._state.meshes[index];
            this._state.meshes.splice(index, 1);
            this.markDirty();
            
            this._onStateChange.fire({
                path: `meshes.${id}`,
                type: 'delete',
                oldValue
            });
        }
    }

    // ============================================================================
    // Utility Methods
    // ============================================================================

    /**
     * Mark the state as dirty (has unsaved changes).
     */
    markDirty(): void {
        if (!this._isDirty) {
            this._isDirty = true;
            this._onDirtyChange.fire(true);
        }
    }

    /**
     * Mark the state as clean (all changes saved).
     */
    markClean(): void {
        if (this._isDirty) {
            this._isDirty = false;
            this._onDirtyChange.fire(false);
        }
    }

    /**
     * Set the project path.
     */
    setProjectPath(path: string): void {
        this._projectPath = path;
    }

    /**
     * Clear the project path (new unsaved project).
     */
    clearProjectPath(): void {
        this._projectPath = undefined;
    }

    /**
     * Validate the current state.
     */
    async validate(): Promise<ValidationResult> {
        return this.backendService.validateState({
            state: this._state,
            level: 'standard'
        });
    }

    /**
     * Reset to default empty state.
     */
    reset(): void {
        this._state = createDefaultState();
        this._isDirty = false;
        this._projectPath = undefined;
        this._onStateReload.fire(this.getState());
        this._onDirtyChange.fire(false);
    }

    // ============================================================================
    // ID Generation Helpers
    // ============================================================================

    /**
     * Get the next available material ID.
     */
    getNextMaterialId(): number {
        const ids = this._state.materials.map(m => m.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    /**
     * Get the next available surface ID.
     */
    getNextSurfaceId(): number {
        const ids = this._state.geometry.surfaces.map(s => s.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    /**
     * Get the next available cell ID.
     */
    getNextCellId(): number {
        const ids = this._state.geometry.cells.map(c => c.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    /**
     * Get the next available universe ID.
     */
    getNextUniverseId(): number {
        const ids = this._state.geometry.universes.map(u => u.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    /**
     * Get the next available lattice ID.
     */
    getNextLatticeId(): number {
        const ids = this._state.geometry.lattices.map(l => l.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    /**
     * Get the next available tally ID.
     */
    getNextTallyId(): number {
        const ids = this._state.tallies.map(t => t.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    /**
     * Get the next available mesh ID.
     */
    getNextMeshId(): number {
        const ids = this._state.meshes.map(m => m.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }
}
