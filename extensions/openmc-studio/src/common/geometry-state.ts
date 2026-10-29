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
 * Pure geometry state transitions used by `OpenMCStateManager`.
 *
 * Keeping the mutations here lets the manager stay a thin event/dirty wrapper
 * and gives the editor transforms and periodic pairing direct unit coverage.
 *
 * @module openmc-studio/common
 */

import { OpenMCCell, OpenMCLattice, OpenMCSurface } from './openmc-state-schema';
import { LatticePosition, setLatticePosition } from './geometry-editor';

/** Rotation/translation replacement for a cell. */
export interface CellTransform {
    rotation?: [number, number, number];
    translation?: [number, number, number];
}

/** Error raised when a state transition targets a missing entity. */
export class GeometryStateError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GeometryStateError';
    }
}

/**
 * Apply or clear a cell's rotation/translation without touching fill or region.
 * @param cell - Cell to transform.
 * @param transform - New rotation/translation; omitted keys are cleared.
 * @returns Updated cell copy.
 */
export function applyCellTransform(cell: OpenMCCell, transform: CellTransform): OpenMCCell {
    return { ...cell, rotation: transform.rotation, translation: transform.translation };
}

/**
 * Pair a periodic surface with its opposite plane and maintain reciprocity.
 *
 * Both boundaries become `periodic`, a previous partner is unlinked, and an
 * undefined partner clears the pair on both sides.
 * @param surfaces - Current surface list.
 * @param surfaceId - Surface to pair.
 * @param partnerId - Opposite plane, or undefined to clear.
 * @returns Updated surface list.
 */
export function pairPeriodicSurfaces(surfaces: readonly OpenMCSurface[], surfaceId: number, partnerId?: number): OpenMCSurface[] {
    const surface = surfaces.find((candidate) => candidate.id === surfaceId);
    if (!surface) {
        throw new GeometryStateError(`Surface ${surfaceId} not found`);
    }
    if (partnerId === surfaceId) {
        throw new GeometryStateError('A periodic surface cannot pair with itself');
    }
    const partner = partnerId !== undefined ? surfaces.find((candidate) => candidate.id === partnerId) : undefined;
    if (partnerId !== undefined && !partner) {
        throw new GeometryStateError(`Surface ${partnerId} not found`);
    }

    const next = surfaces.map((candidate) => ({ ...candidate }));
    const nextSurface = next.find((candidate) => candidate.id === surfaceId)!;
    const oldPartner =
        nextSurface.periodicSurfaceId !== undefined ? next.find((candidate) => candidate.id === nextSurface.periodicSurfaceId) : undefined;
    if (oldPartner && oldPartner.id !== partnerId && oldPartner.periodicSurfaceId === surfaceId) {
        oldPartner.periodicSurfaceId = undefined;
    }

    if (!partner) {
        nextSurface.periodicSurfaceId = undefined;
        return next;
    }

    const nextPartner = next.find((candidate) => candidate.id === partner.id)!;
    const partnersOldPartner =
        nextPartner.periodicSurfaceId !== undefined ? next.find((candidate) => candidate.id === nextPartner.periodicSurfaceId) : undefined;
    if (partnersOldPartner && partnersOldPartner.id !== surfaceId && partnersOldPartner.periodicSurfaceId === partnerId) {
        partnersOldPartner.periodicSurfaceId = undefined;
    }

    nextSurface.boundary = 'periodic';
    nextPartner.boundary = 'periodic';
    nextSurface.periodicSurfaceId = partnerId;
    nextPartner.periodicSurfaceId = surfaceId;
    return next;
}

/**
 * Assign one universe slot in a lattice.
 * @param lattice - Lattice to update.
 * @param position - Rect or hex slot.
 * @param universeId - Universe ID to write.
 * @returns Updated lattice copy.
 */
export function applyLatticePosition(lattice: OpenMCLattice, position: LatticePosition, universeId: number): OpenMCLattice {
    return { ...lattice, universes: setLatticePosition(lattice.universes, position, universeId) } as OpenMCLattice;
}

/**
 * Insert a lattice or replace the entry with the same ID.
 * @param lattices - Current lattice list.
 * @param lattice - Lattice to create/update.
 * @returns Updated list.
 */
export function upsertLattice(lattices: readonly OpenMCLattice[], lattice: OpenMCLattice): OpenMCLattice[] {
    const index = lattices.findIndex((candidate) => candidate.id === lattice.id);
    if (index < 0) {
        return [...lattices, lattice];
    }
    const next = [...lattices];
    next[index] = lattice;
    return next;
}

/**
 * Remove a lattice by ID.
 * @param lattices - Current lattice list.
 * @param id - Lattice ID.
 * @returns Updated list.
 */
export function removeLatticeById(lattices: readonly OpenMCLattice[], id: number): OpenMCLattice[] {
    return lattices.filter((lattice) => lattice.id !== id);
}
