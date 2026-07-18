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

/**
 * OpenMC State Manager
 *
 * Manages the current OpenMC simulation state and provides methods for
 * state manipulation, validation, and change notifications. All mutating
 * operations fire {@link StateChangeEvent}s through the public event streams
 * so that UI components can react to data changes.
 *
 * The manager supports CRUD operations for geometry (surfaces, cells,
 * universes, lattices), materials, tallies, meshes, settings, depletion,
 * variance reduction, and optimization parameter sweeps.
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
    OpenMCUniverse,
    OpenMCLattice,
    OpenMCParameterSweep,
    OpenMCOptimizationRun,
    OptimizationResult,
    OPENMC_STATE_SCHEMA_VERSION
} from '../common/openmc-state-schema';

import { StateChangeEvent, ValidationResult, OpenMCStudioBackendService } from '../common/openmc-studio-protocol';

/**
 * Create a default empty {@link OpenMCState} with sensible initial values.
 *
 * @returns A deep-copyable default state containing a root universe,
 *          eigenvalue run settings, and a default box source.
 */
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
            universes: [
                {
                    id: 0,
                    name: 'root',
                    cellIds: [],
                    isRoot: true
                }
            ],
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
            sources: [
                {
                    spatial: {
                        type: 'box',
                        lowerLeft: [-5, -5, -5],
                        upperRight: [5, 5, 5]
                    },
                    energy: {
                        type: 'discrete',
                        energies: [1e6]
                    }
                }
            ],
            sourceRejectionFraction: 0.0 // Allow sources to be placed anywhere
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

    /** Internal mutable state — access through {@link getState} to receive a copy. */
    private _state: OpenMCState = createDefaultState();
    /** Dirty flag tracking unsaved modifications. */
    private _isDirty = false;
    /** Absolute file path of the currently loaded project, if any. */
    private _projectPath?: string;

    // State change emitters
    /** Fires whenever a granular state change occurs (add/update/delete). */
    private readonly _onStateChange = new Emitter<StateChangeEvent>();
    /** Public event stream for state change notifications. */
    readonly onStateChange: Event<StateChangeEvent> = this._onStateChange.event;

    /** Fires when the entire state is replaced (e.g. after load/reset). */
    private readonly _onStateReload = new Emitter<OpenMCState>();
    /** Public event stream for full state reload notifications. */
    readonly onStateReload: Event<OpenMCState> = this._onStateReload.event;

    /** Fires when the dirty flag transitions between `true` and `false`. */
    private readonly _onDirtyChange = new Emitter<boolean>();
    /** Public event stream for dirty-state notifications. */
    readonly onDirtyChange: Event<boolean> = this._onDirtyChange.event;

    // ============================================================================
    // State Accessors
    // ============================================================================

    /**
     * Get the current state.
     *
     * @returns A deep copy of the current {@link OpenMCState}.
     */
    getState(): OpenMCState {
        // Return a copy to prevent direct mutation
        return JSON.parse(JSON.stringify(this._state));
    }

    /**
     * Replace the entire state.
     *
     * @param state - The new state to adopt.
     * @param markDirty - Whether to mark the state as dirty after replacement. Defaults to `true`.
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
     *
     * @returns `true` if the state has been modified since the last save.
     */
    get isDirty(): boolean {
        return this._isDirty;
    }

    /**
     * Path to the current project file (if saved).
     *
     * @returns The absolute file path, or `undefined` for unsaved projects.
     */
    get projectPath(): string | undefined {
        return this._projectPath;
    }

    // ============================================================================
    // State Modifications
    // ============================================================================

    /**
     * Update project metadata fields.
     *
     * @param updates - Partial metadata object containing the fields to update.
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
     * Add a material to the simulation.
     *
     * @param material - The {@link OpenMCMaterial} to add.
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
     * Update an existing material.
     *
     * @param id - The ID of the material to update.
     * @param updates - Partial material object with the new values.
     */
    updateMaterial(id: number, updates: Partial<OpenMCMaterial>): void {
        const index = this._state.materials.findIndex((m) => m.id === id);
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
     * Remove a material by ID.
     *
     * @param id - The ID of the material to remove.
     */
    removeMaterial(id: number): void {
        const index = this._state.materials.findIndex((m) => m.id === id);
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
     * Add a surface to the geometry.
     *
     * @param surface - The {@link OpenMCSurface} to add.
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
     * Update an existing surface.
     *
     * @param id - The ID of the surface to update.
     * @param updates - Partial surface object with the new values.
     */
    updateSurface(id: number, updates: Partial<OpenMCSurface>): void {
        const index = this._state.geometry.surfaces.findIndex((s) => s.id === id);
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
     * Remove a surface by ID.
     *
     * @param id - The ID of the surface to remove.
     */
    removeSurface(id: number): void {
        const index = this._state.geometry.surfaces.findIndex((s) => s.id === id);
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
     * Add a cell to the geometry.
     *
     * @param cell - The {@link OpenMCCell} to add.
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
     * Update an existing cell.
     *
     * @param id - The ID of the cell to update.
     * @param updates - Partial cell object with the new values.
     */
    updateCell(id: number, updates: Partial<OpenMCCell>): void {
        const index = this._state.geometry.cells.findIndex((c) => c.id === id);
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
     * Remove a cell by ID.
     *
     * @param id - The ID of the cell to remove.
     */
    removeCell(id: number): void {
        const index = this._state.geometry.cells.findIndex((c) => c.id === id);
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
     * Update simulation settings.
     *
     * @param updates - Partial settings object with the new values.
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
     * Add a tally to the simulation.
     *
     * @param tally - The {@link OpenMCTally} to add.
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
     * Update an existing tally.
     *
     * @param id - The ID of the tally to update.
     * @param updates - Partial tally object with the new values.
     */
    updateTally(id: number, updates: Partial<OpenMCTally>): void {
        const index = this._state.tallies.findIndex((t) => t.id === id);
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
     * Remove a tally by ID.
     *
     * @param id - The ID of the tally to remove.
     */
    removeTally(id: number): void {
        const index = this._state.tallies.findIndex((t) => t.id === id);
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
     * Add a mesh to the simulation.
     *
     * @param mesh - The {@link OpenMCMesh} to add.
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
     * Update an existing mesh.
     *
     * @param id - The ID of the mesh to update.
     * @param updates - Partial mesh object with the new values.
     */
    updateMesh(id: number, updates: Partial<OpenMCMesh>): void {
        const index = this._state.meshes.findIndex((m) => m.id === id);
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
     * Remove a mesh by ID.
     *
     * @param id - The ID of the mesh to remove.
     */
    removeMesh(id: number): void {
        const index = this._state.meshes.findIndex((m) => m.id === id);
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

    /**
     * Update depletion settings.
     *
     * @param updates - Partial depletion object with the new values.
     */
    updateDepletion(updates: Partial<import('../common/openmc-state-schema').OpenMCDepletion>): void {
        this._state.depletion = { ...(this._state.depletion || { timeSteps: [] }), ...updates } as any;
        this.markDirty();

        this._onStateChange.fire({
            path: 'depletion',
            type: 'update',
            value: this._state.depletion
        });
    }

    /**
     * Update variance reduction settings.
     *
     * @param updates - Partial variance-reduction object with the new values.
     */
    updateVarianceReduction(updates: Partial<import('../common/openmc-state-schema').OpenMCVarianceReduction>): void {
        this._state.varianceReduction = { ...(this._state.varianceReduction || {}), ...updates } as any;
        this.markDirty();

        this._onStateChange.fire({
            path: 'variance-reduction',
            type: 'update',
            value: this._state.varianceReduction
        });
    }

    /**
     * Toggle decay-only status for a depletion step.
     *
     * If the step index is already marked decay-only, it is removed;
     * otherwise it is added and the list is kept sorted.
     *
     * @param stepIndex - The zero-based index of the depletion step to toggle.
     */
    toggleDecayOnlyStep(stepIndex: number): void {
        if (!this._state.depletion) {
            return;
        }

        const decayOnlySteps = [...(this._state.depletion.decayOnlySteps || [])];
        const index = decayOnlySteps.indexOf(stepIndex);

        if (index >= 0) {
            decayOnlySteps.splice(index, 1);
        } else {
            decayOnlySteps.push(stepIndex);
            decayOnlySteps.sort((a, b) => a - b);
        }

        this._state.depletion.decayOnlySteps = decayOnlySteps;
        this.markDirty();

        this._onStateChange.fire({
            path: 'depletion.decayOnlySteps',
            type: 'update',
            value: decayOnlySteps
        });
    }

    // ============================================================================
    // Universe CRUD Operations
    // ============================================================================

    /**
     * Add a universe to the geometry.
     *
     * @param universe - The {@link OpenMCUniverse} to add.
     */
    addUniverse(universe: OpenMCUniverse): void {
        this._state.geometry.universes.push(universe);
        this.markDirty();

        this._onStateChange.fire({
            path: `geometry.universes.${universe.id}`,
            type: 'add',
            value: universe
        });
    }

    /**
     * Update an existing universe.
     *
     * @param id - The ID of the universe to update.
     * @param updates - Partial universe object with the new values.
     */
    updateUniverse(id: number, updates: Partial<OpenMCUniverse>): void {
        const index = this._state.geometry.universes.findIndex((u) => u.id === id);
        if (index >= 0) {
            const oldValue = this._state.geometry.universes[index];
            this._state.geometry.universes[index] = { ...oldValue, ...updates };
            this.markDirty();

            this._onStateChange.fire({
                path: `geometry.universes.${id}`,
                type: 'update',
                value: this._state.geometry.universes[index],
                oldValue
            });
        }
    }

    /**
     * Remove a universe by ID.
     *
     * @param id - The ID of the universe to remove.
     * @throws Error if attempting to remove the root universe (id: 0).
     */
    removeUniverse(id: number): void {
        // Don't allow removing root universe (id: 0)
        if (id === 0) {
            throw new Error('Cannot remove root universe');
        }

        const index = this._state.geometry.universes.findIndex((u) => u.id === id);
        if (index >= 0) {
            const oldValue = this._state.geometry.universes[index];
            this._state.geometry.universes.splice(index, 1);
            this.markDirty();

            this._onStateChange.fire({
                path: `geometry.universes.${id}`,
                type: 'delete',
                oldValue
            });
        }
    }

    /**
     * Assign a cell to a universe, removing it from any other universe first.
     *
     * @param cellId - The ID of the cell to assign.
     * @param universeId - The target universe ID.
     * @throws Error if the target universe does not exist.
     */
    assignCellToUniverse(cellId: number, universeId: number): void {
        const universe = this._state.geometry.universes.find((u) => u.id === universeId);
        if (!universe) {
            throw new Error(`Universe ${universeId} not found`);
        }

        // Remove cell from all other universes first
        this._state.geometry.universes.forEach((u) => {
            const idx = u.cellIds.indexOf(cellId);
            if (idx >= 0) {
                u.cellIds.splice(idx, 1);
            }
        });

        // Add to target universe if not already there
        if (!universe.cellIds.includes(cellId)) {
            universe.cellIds.push(cellId);
        }

        this.markDirty();
        this._onStateChange.fire({
            path: `geometry.universes.${universeId}.cellIds`,
            type: 'update',
            value: universe.cellIds
        });
    }

    /**
     * Remove a cell from a specific universe.
     *
     * @param cellId - The ID of the cell to remove.
     * @param universeId - The universe ID to remove the cell from.
     */
    removeCellFromUniverse(cellId: number, universeId: number): void {
        const universe = this._state.geometry.universes.find((u) => u.id === universeId);
        if (universe) {
            const idx = universe.cellIds.indexOf(cellId);
            if (idx >= 0) {
                universe.cellIds.splice(idx, 1);
                this.markDirty();
                this._onStateChange.fire({
                    path: `geometry.universes.${universeId}.cellIds`,
                    type: 'update',
                    value: universe.cellIds
                });
            }
        }
    }

    // ============================================================================
    // Lattice CRUD Operations
    // ============================================================================

    /**
     * Add a lattice to the geometry.
     *
     * @param lattice - The {@link OpenMCLattice} to add.
     */
    addLattice(lattice: OpenMCLattice): void {
        this._state.geometry.lattices.push(lattice);
        this.markDirty();

        this._onStateChange.fire({
            path: `geometry.lattices.${lattice.id}`,
            type: 'add',
            value: lattice
        });
    }

    /**
     * Update an existing lattice.
     *
     * @param id - The ID of the lattice to update.
     * @param updates - Partial lattice object with the new values.
     */
    updateLattice(id: number, updates: Partial<OpenMCLattice>): void {
        const index = this._state.geometry.lattices.findIndex((l) => l.id === id);
        if (index >= 0) {
            const oldValue = this._state.geometry.lattices[index];
            this._state.geometry.lattices[index] = { ...oldValue, ...updates } as OpenMCLattice;
            this.markDirty();

            this._onStateChange.fire({
                path: `geometry.lattices.${id}`,
                type: 'update',
                value: this._state.geometry.lattices[index],
                oldValue
            });
        }
    }

    /**
     * Remove a lattice by ID.
     *
     * @param id - The ID of the lattice to remove.
     */
    removeLattice(id: number): void {
        const index = this._state.geometry.lattices.findIndex((l) => l.id === id);
        if (index >= 0) {
            const oldValue = this._state.geometry.lattices[index];
            this._state.geometry.lattices.splice(index, 1);
            this.markDirty();

            this._onStateChange.fire({
                path: `geometry.lattices.${id}`,
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
     *
     * If already dirty, this is a no-op.
     */
    markDirty(): void {
        if (!this._isDirty) {
            this._isDirty = true;
            this._onDirtyChange.fire(true);
        }
    }

    /**
     * Mark the state as clean (all changes saved).
     *
     * If already clean, this is a no-op.
     */
    markClean(): void {
        if (this._isDirty) {
            this._isDirty = false;
            this._onDirtyChange.fire(false);
        }
    }

    /**
     * Set the project file path.
     *
     * @param path - Absolute file path of the saved project.
     */
    setProjectPath(path: string): void {
        this._projectPath = path;
    }

    /**
     * Clear the project path, indicating a new unsaved project.
     */
    clearProjectPath(): void {
        this._projectPath = undefined;
    }

    /**
     * Validate the current state via the backend service.
     *
     * @returns A promise resolving to the {@link ValidationResult}.
     */
    async validate(): Promise<ValidationResult> {
        return this.backendService.validateState({
            state: this._state,
            level: 'standard'
        });
    }

    /**
     * Reset to the default empty state, clearing dirty flags and project path.
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
     *
     * @returns The smallest unused positive integer ID for materials.
     */
    getNextMaterialId(): number {
        const ids = this._state.materials.map((m) => m.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    /**
     * Get the next available surface ID.
     *
     * @returns The smallest unused positive integer ID for surfaces.
     */
    getNextSurfaceId(): number {
        const ids = this._state.geometry.surfaces.map((s) => s.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    /**
     * Get the next available cell ID.
     *
     * @returns The smallest unused positive integer ID for cells.
     */
    getNextCellId(): number {
        const ids = this._state.geometry.cells.map((c) => c.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    /**
     * Get the next available universe ID.
     *
     * @returns The smallest unused positive integer ID for universes.
     */
    getNextUniverseId(): number {
        const ids = this._state.geometry.universes.map((u) => u.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    /**
     * Get the next available lattice ID.
     *
     * @returns The smallest unused positive integer ID for lattices.
     */
    getNextLatticeId(): number {
        const ids = this._state.geometry.lattices.map((l) => l.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    /**
     * Get the next available tally ID.
     *
     * @returns The smallest unused positive integer ID for tallies.
     */
    getNextTallyId(): number {
        const ids = this._state.tallies.map((t) => t.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    /**
     * Get the next available mesh ID.
     *
     * @returns The smallest unused positive integer ID for meshes.
     */
    getNextMeshId(): number {
        const ids = this._state.meshes.map((m) => m.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    // ============================================================================
    // Optimization - Parameter Sweeps
    // ============================================================================

    /**
     * Ensure the optimization sub-state exists on `_state`.
     *
     * This is a private helper lazily initializes the optimization container
     * so that legacy projects without optimization data do not break.
     */
    private ensureOptimizationState(): void {
        if (!this._state.optimization) {
            this._state.optimization = {
                parameterSweeps: [],
                optimizationRuns: []
            };
        }
    }

    /**
     * Get all parameter sweeps.
     *
     * @returns A shallow copy of the current parameter sweep array.
     */
    getParameterSweeps(): OpenMCParameterSweep[] {
        this.ensureOptimizationState();
        return [...(this._state.optimization!.parameterSweeps || [])];
    }

    /**
     * Add a parameter sweep.
     *
     * @param sweep - The {@link OpenMCParameterSweep} to add.
     */
    addParameterSweep(sweep: OpenMCParameterSweep): void {
        this.ensureOptimizationState();
        this._state.optimization!.parameterSweeps.push(sweep);
        this.markDirty();

        this._onStateChange.fire({
            path: `optimization.parameterSweeps.${sweep.id}`,
            type: 'add',
            value: sweep
        });
    }

    /**
     * Update an existing parameter sweep.
     *
     * @param id - The ID of the parameter sweep to update.
     * @param updates - Partial sweep object with the new values.
     */
    updateParameterSweep(id: number, updates: Partial<OpenMCParameterSweep>): void {
        this.ensureOptimizationState();
        const sweeps = this._state.optimization!.parameterSweeps;
        const index = sweeps.findIndex((s) => s.id === id);
        if (index >= 0) {
            const oldValue = sweeps[index];
            sweeps[index] = { ...oldValue, ...updates };
            this.markDirty();

            this._onStateChange.fire({
                path: `optimization.parameterSweeps.${id}`,
                type: 'update',
                value: sweeps[index],
                oldValue
            });
        }
    }

    /**
     * Remove a parameter sweep by ID.
     *
     * @param id - The ID of the parameter sweep to remove.
     */
    removeParameterSweep(id: number): void {
        this.ensureOptimizationState();
        const sweeps = this._state.optimization!.parameterSweeps;
        const index = sweeps.findIndex((s) => s.id === id);
        if (index >= 0) {
            const oldValue = sweeps[index];
            sweeps.splice(index, 1);
            this.markDirty();

            this._onStateChange.fire({
                path: `optimization.parameterSweeps.${id}`,
                type: 'delete',
                oldValue
            });
        }
    }

    /**
     * Compute the numeric sweep values for a parameter sweep based on its range type.
     *
     * Supports `linear` and `logarithmic` distributions. Returns a single-element
     * array if `numPoints` is less than 2.
     *
     * @param sweep - The parameter sweep definition.
     * @returns An array of computed values. Empty if logarithmic range has non-positive bounds.
     */
    computeSweepValues(sweep: OpenMCParameterSweep): number[] {
        const { rangeType, startValue, endValue, numPoints } = sweep;
        const values: number[] = [];

        if (numPoints < 2) {
            return [startValue];
        }

        if (rangeType === 'linear') {
            const step = (endValue - startValue) / (numPoints - 1);
            for (let i = 0; i < numPoints; i++) {
                values.push(startValue + step * i);
            }
        } else {
            // logarithmic
            if (startValue <= 0 || endValue <= 0) {
                console.warn('Logarithmic range requires positive values');
                return [];
            }
            const logStart = Math.log10(startValue);
            const logEnd = Math.log10(endValue);
            const step = (logEnd - logStart) / (numPoints - 1);
            for (let i = 0; i < numPoints; i++) {
                values.push(Math.pow(10, logStart + step * i));
            }
        }

        return values;
    }

    /**
     * Get the next available parameter sweep ID.
     *
     * @returns The smallest unused positive integer ID for parameter sweeps.
     */
    getNextParameterSweepId(): number {
        this.ensureOptimizationState();
        const ids = this._state.optimization!.parameterSweeps.map((s) => s.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    /**
     * Validate parameter sweeps for conflicts before running optimization.
     *
     * Checks cross-sweep constraints such as `batches > inactive` for all
     * combinations and warns about single-point sweeps.
     *
     * @param sweeps - The array of sweeps to validate.
     * @returns Validation result with `valid`, `errors`, and `warnings` arrays.
     */
    validateSweepsForRun(sweeps: OpenMCParameterSweep[]): { valid: boolean; errors: string[]; warnings: string[] } {
        const errors: string[] = [];
        const warnings: string[] = [];

        // Check for batches vs inactive conflicts
        const batchesSweep = sweeps.find((s) => s.enabled && s.parameterPath === 'settings.batches');
        const inactiveSweep = sweeps.find((s) => s.enabled && s.parameterPath === 'settings.inactive');

        // Get base settings values (only relevant for eigenvalue mode)
        const runSettings = this._state.settings?.run;
        const baseBatches = (runSettings as any)?.batches ?? 100;
        const baseInactive = (runSettings as any)?.inactive ?? 10;

        if (batchesSweep && inactiveSweep) {
            // Both are swept - check all combinations
            const batchesValues = this.computeSweepValues(batchesSweep);
            const inactiveValues = this.computeSweepValues(inactiveSweep);

            // Check if any combination would result in 0 active batches
            const minBatches = Math.min(...batchesValues);
            const maxInactive = Math.max(...inactiveValues);

            if (minBatches <= maxInactive) {
                errors.push(
                    `Invalid sweep combination: 'batches' minimum (${minBatches}) must be greater than 'inactive' maximum (${maxInactive}). ` +
                        `Adjust sweeps so that batches > inactive for all combinations.`
                );
            } else if (minBatches <= maxInactive + 5) {
                warnings.push(
                    `Warning: Low active batch count. Minimum batches (${minBatches}) is close to maximum inactive (${maxInactive}). ` +
                        `Consider increasing batches or decreasing inactive for better statistics.`
                );
            }
        } else if (batchesSweep && !inactiveSweep) {
            // Only batches is swept - check against base inactive
            const batchesValues = this.computeSweepValues(batchesSweep);
            const minBatches = Math.min(...batchesValues);

            if (minBatches <= baseInactive) {
                errors.push(
                    `Invalid sweep: 'batches' minimum (${minBatches}) must be greater than base 'inactive' (${baseInactive}). ` +
                        `Either increase batches start value, or decrease base inactive in Settings.`
                );
            } else if (minBatches <= baseInactive + 5) {
                warnings.push(
                    `Warning: Low active batch count. Minimum batches (${minBatches}) is close to base inactive (${baseInactive}). ` +
                        `Consider increasing batches or decreasing base inactive for better statistics.`
                );
            }
        } else if (!batchesSweep && inactiveSweep) {
            // Only inactive is swept - check against base batches
            const inactiveValues = this.computeSweepValues(inactiveSweep);
            const maxInactive = Math.max(...inactiveValues);

            if (maxInactive >= baseBatches) {
                errors.push(
                    `Invalid sweep: 'inactive' maximum (${maxInactive}) must be less than base 'batches' (${baseBatches}). ` +
                        `Either decrease inactive end value, or increase base batches in Settings.`
                );
            } else if (maxInactive >= baseBatches - 5) {
                warnings.push(
                    `Warning: Low active batch count. Maximum inactive (${maxInactive}) is close to base batches (${baseBatches}). ` +
                        `Consider decreasing inactive or increasing base batches for better statistics.`
                );
            }
        }

        // Check for single-point sweeps (pointless but not an error)
        sweeps
            .filter((s) => s.enabled)
            .forEach((sweep) => {
                const values = this.computeSweepValues(sweep);
                if (values.length < 2) {
                    warnings.push(`Sweep "${sweep.name}" has only 1 point. Consider increasing numPoints for a meaningful sweep.`);
                }
            });

        return {
            valid: errors.length === 0,
            errors,
            warnings
        };
    }

    // ============================================================================
    // Optimization - Runs
    // ============================================================================

    /**
     * Get all optimization runs.
     *
     * @returns A shallow copy of the current optimization run array.
     */
    getOptimizationRuns(): OpenMCOptimizationRun[] {
        this.ensureOptimizationState();
        return [...(this._state.optimization!.optimizationRuns || [])];
    }

    /**
     * Get a specific optimization run by ID.
     *
     * @param runId - The unique identifier of the optimization run.
     * @returns The matching {@link OpenMCOptimizationRun}, or `undefined` if not found.
     */
    getOptimizationRun(runId: string): OpenMCOptimizationRun | undefined {
        this.ensureOptimizationState();
        return this._state.optimization!.optimizationRuns.find((r) => r.id === runId);
    }

    /**
     * Add an optimization run.
     *
     * @param run - The {@link OpenMCOptimizationRun} to add.
     */
    addOptimizationRun(run: OpenMCOptimizationRun): void {
        this.ensureOptimizationState();
        this._state.optimization!.optimizationRuns.push(run);
        this.markDirty();

        this._onStateChange.fire({
            path: `optimization.optimizationRuns.${run.id}`,
            type: 'add',
            value: run
        });
    }

    /**
     * Update an existing optimization run.
     *
     * @param runId - The ID of the optimization run to update.
     * @param updates - Partial run object with the new values.
     */
    updateOptimizationRun(runId: string, updates: Partial<OpenMCOptimizationRun>): void {
        this.ensureOptimizationState();
        const runs = this._state.optimization!.optimizationRuns;
        const index = runs.findIndex((r) => r.id === runId);
        if (index >= 0) {
            const oldValue = runs[index];
            runs[index] = { ...oldValue, ...updates };
            this.markDirty();

            this._onStateChange.fire({
                path: `optimization.optimizationRuns.${runId}`,
                type: 'update',
                value: runs[index],
                oldValue
            });
        }
    }

    /**
     * Remove an optimization run by ID.
     *
     * @param runId - The ID of the optimization run to remove.
     */
    removeOptimizationRun(runId: string): void {
        this.ensureOptimizationState();
        const runs = this._state.optimization!.optimizationRuns;
        const index = runs.findIndex((r) => r.id === runId);
        if (index >= 0) {
            const oldValue = runs[index];
            runs.splice(index, 1);
            this.markDirty();

            this._onStateChange.fire({
                path: `optimization.optimizationRuns.${runId}`,
                type: 'delete',
                oldValue
            });
        }
    }

    /**
     * Append a result to an existing optimization run and update its current iteration.
     *
     * @param runId - The ID of the target optimization run.
     * @param result - The {@link OptimizationResult} to append.
     */
    addOptimizationResult(runId: string, result: OptimizationResult): void {
        this.ensureOptimizationState();
        const run = this._state.optimization!.optimizationRuns.find((r) => r.id === runId);
        if (run) {
            run.results.push(result);
            run.currentIteration = result.iteration;
            this.markDirty();

            this._onStateChange.fire({
                path: `optimization.optimizationRuns.${runId}.results`,
                type: 'update',
                value: run.results
            });
        }
    }

    /**
     * Set the active optimization run.
     *
     * @param runId - The ID of the run to mark as active, or `undefined` to clear.
     */
    setActiveOptimizationRun(runId?: string): void {
        this.ensureOptimizationState();
        this._state.optimization!.activeRunId = runId;
        this.markDirty();

        this._onStateChange.fire({
            path: 'optimization.activeRunId',
            type: 'update',
            value: runId
        });
    }

    /**
     * Get the currently active optimization run.
     *
     * @returns The active {@link OpenMCOptimizationRun}, or `undefined` if none is set.
     */
    getActiveOptimizationRun(): OpenMCOptimizationRun | undefined {
        this.ensureOptimizationState();
        const activeId = this._state.optimization!.activeRunId;
        return activeId ? this.getOptimizationRun(activeId) : undefined;
    }
}
