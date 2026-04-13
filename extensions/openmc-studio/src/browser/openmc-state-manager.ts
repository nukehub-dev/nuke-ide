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
    OpenMCUniverse,
    OpenMCLattice,
    OpenMCParameterSweep,
    OpenMCOptimizationRun,
    OptimizationResult,
    OptimizationLogMessage,
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

    /**
     * Update depletion settings.
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
     * Add a universe.
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
     * Update a universe.
     */
    updateUniverse(id: number, updates: Partial<OpenMCUniverse>): void {
        const index = this._state.geometry.universes.findIndex(u => u.id === id);
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
     * Remove a universe.
     */
    removeUniverse(id: number): void {
        // Don't allow removing root universe (id: 0)
        if (id === 0) {
            throw new Error('Cannot remove root universe');
        }
        
        const index = this._state.geometry.universes.findIndex(u => u.id === id);
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
     * Assign a cell to a universe.
     */
    assignCellToUniverse(cellId: number, universeId: number): void {
        const universe = this._state.geometry.universes.find(u => u.id === universeId);
        if (!universe) {
            throw new Error(`Universe ${universeId} not found`);
        }

        // Remove cell from all other universes first
        this._state.geometry.universes.forEach(u => {
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
     * Remove a cell from a universe.
     */
    removeCellFromUniverse(cellId: number, universeId: number): void {
        const universe = this._state.geometry.universes.find(u => u.id === universeId);
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
     * Add a lattice.
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
     * Update a lattice.
     */
    updateLattice(id: number, updates: Partial<OpenMCLattice>): void {
        const index = this._state.geometry.lattices.findIndex(l => l.id === id);
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
     * Remove a lattice.
     */
    removeLattice(id: number): void {
        const index = this._state.geometry.lattices.findIndex(l => l.id === id);
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

    // ============================================================================
    // Optimization - Parameter Sweeps
    // ============================================================================

    /**
     * Ensure optimization state exists.
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
     */
    getParameterSweeps(): OpenMCParameterSweep[] {
        this.ensureOptimizationState();
        return [...(this._state.optimization!.parameterSweeps || [])];
    }

    /**
     * Add a parameter sweep.
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
     * Update a parameter sweep.
     */
    updateParameterSweep(id: number, updates: Partial<OpenMCParameterSweep>): void {
        this.ensureOptimizationState();
        const sweeps = this._state.optimization!.parameterSweeps;
        const index = sweeps.findIndex(s => s.id === id);
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
     * Remove a parameter sweep.
     */
    removeParameterSweep(id: number): void {
        this.ensureOptimizationState();
        const sweeps = this._state.optimization!.parameterSweeps;
        const index = sweeps.findIndex(s => s.id === id);
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
     * Compute sweep values based on range type.
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
        } else { // logarithmic
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
     */
    getNextParameterSweepId(): number {
        this.ensureOptimizationState();
        const ids = this._state.optimization!.parameterSweeps.map(s => s.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    /**
     * Validate parameter sweeps for conflicts before running optimization.
     * Returns validation result with errors if sweeps are incompatible.
     */
    validateSweepsForRun(sweeps: OpenMCParameterSweep[]): { valid: boolean; errors: string[]; warnings: string[] } {
        const errors: string[] = [];
        const warnings: string[] = [];

        // Check for batches vs inactive conflicts
        const batchesSweep = sweeps.find(s => s.enabled && s.parameterPath === 'settings.batches');
        const inactiveSweep = sweeps.find(s => s.enabled && s.parameterPath === 'settings.inactive');

        if (batchesSweep && inactiveSweep) {
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
        }

        // Check for single-point sweeps (pointless but not an error)
        sweeps.filter(s => s.enabled).forEach(sweep => {
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
     */
    getOptimizationRuns(): OpenMCOptimizationRun[] {
        this.ensureOptimizationState();
        return [...(this._state.optimization!.optimizationRuns || [])];
    }

    /**
     * Get a specific optimization run.
     */
    getOptimizationRun(runId: string): OpenMCOptimizationRun | undefined {
        this.ensureOptimizationState();
        return this._state.optimization!.optimizationRuns.find(r => r.id === runId);
    }

    /**
     * Add an optimization run.
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
     * Update an optimization run.
     */
    updateOptimizationRun(runId: string, updates: Partial<OpenMCOptimizationRun>): void {
        this.ensureOptimizationState();
        const runs = this._state.optimization!.optimizationRuns;
        const index = runs.findIndex(r => r.id === runId);
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
     * Remove an optimization run.
     */
    removeOptimizationRun(runId: string): void {
        this.ensureOptimizationState();
        const runs = this._state.optimization!.optimizationRuns;
        const index = runs.findIndex(r => r.id === runId);
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
     * Add a result to an optimization run.
     */
    addOptimizationResult(runId: string, result: OptimizationResult): void {
        this.ensureOptimizationState();
        const run = this._state.optimization!.optimizationRuns.find(r => r.id === runId);
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
     * Add a log message to an optimization run.
     */
    addOptimizationLogMessage(runId: string, message: OptimizationLogMessage): void {
        this.ensureOptimizationState();
        const run = this._state.optimization!.optimizationRuns.find(r => r.id === runId);
        if (run) {
            run.logMessages.push(message);
            this.markDirty();

            this._onStateChange.fire({
                path: `optimization.optimizationRuns.${runId}.logMessages`,
                type: 'update',
                value: run.logMessages
            });
        }
    }

    /**
     * Set the active optimization run.
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
     * Get the active optimization run.
     */
    getActiveOptimizationRun(): OpenMCOptimizationRun | undefined {
        this.ensureOptimizationState();
        const activeId = this._state.optimization!.activeRunId;
        return activeId ? this.getOptimizationRun(activeId) : undefined;
    }
}
