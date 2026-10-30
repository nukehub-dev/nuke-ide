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

/** State-transition coverage for lattice assignment, transforms, and periodic pairs. */

import { describe, expect, it } from 'vitest';

import { applyCellTransform, applyLatticePosition, pairPeriodicSurfaces, removeLatticeById, upsertLattice } from './geometry-state';
import { OpenMCCell, OpenMCLattice, OpenMCSurface } from './openmc-state-schema';

/** Rectangular lattice with a known 2×2×1 universe grid. */
function rectLattice(): OpenMCLattice {
    return {
        id: 10,
        type: 'rect',
        name: 'Assembly',
        dimensions: [2, 2],
        pitch: [1, 1],
        lowerLeft: [0, 0],
        universes: [
            [
                [1, 1],
                [1, 1]
            ]
        ]
    };
}

/** Two periodic planes. */
function periodicPlanes(): OpenMCSurface[] {
    return [
        { id: 1, type: 'x-plane', coefficients: { x0: -1 }, boundary: 'periodic' },
        { id: 2, type: 'x-plane', coefficients: { x0: 1 }, boundary: 'periodic' },
        { id: 3, type: 'y-plane', coefficients: { y0: 1 }, boundary: 'periodic' }
    ];
}

describe('applyLatticePosition', () => {
    it('assigns one rect position and preserves the source lattice', () => {
        const lattice = rectLattice();
        const next = applyLatticePosition(lattice, { kind: 'rect', z: 0, y: 1, x: 0 }, 4);
        expect(next.universes[0][1][0]).toBe(4);
        expect(lattice.universes[0][1][0]).toBe(1);
    });

    it('assigns one hex ring position', () => {
        const lattice: OpenMCLattice = {
            id: 11,
            type: 'hex',
            rings: 2,
            center: [0, 0],
            pitch: [1],
            universes: [[[1, 1, 1, 1, 1, 1], [2]]]
        };
        const next = applyLatticePosition(lattice, { kind: 'hex', z: 0, ring: 0, theta: 3 }, 7);
        expect(next.universes[0][0][3]).toBe(7);
        expect(lattice.universes[0][0][3]).toBe(1);
    });
});

describe('lattice CRUD', () => {
    it('creates, updates in place, and removes a lattice', () => {
        const first = rectLattice();
        const created = upsertLattice([], first);
        expect(created).toHaveLength(1);
        expect(created[0].name).toBe('Assembly');

        const renamed = { ...first, name: 'Core assembly' } as OpenMCLattice;
        const updated = upsertLattice(created, renamed);
        expect(updated).toHaveLength(1);
        expect(updated[0].name).toBe('Core assembly');
        expect(created[0].name).toBe('Assembly');

        expect(removeLatticeById(updated, first.id)).toEqual([]);
        expect(removeLatticeById(updated, 999)).toHaveLength(1);
    });
});

describe('applyCellTransform', () => {
    it('sets rotation/translation without touching fill or region', () => {
        const cell: OpenMCCell = { id: 1, fillType: 'universe', fillId: 2, regionString: '-1' };
        const next = applyCellTransform(cell, { rotation: [0, 90, 0], translation: [1, 2, 3] });
        expect(next.rotation).toEqual([0, 90, 0]);
        expect(next.translation).toEqual([1, 2, 3]);
        expect(next.fillType).toBe('universe');
        expect(next.regionString).toBe('-1');
        expect(cell.rotation).toBeUndefined();
    });

    it('clears both transforms when they are omitted', () => {
        const cell: OpenMCCell = {
            id: 1,
            fillType: 'lattice',
            fillId: 2,
            rotation: [0, 90, 0],
            translation: [1, 2, 3]
        };
        const next = applyCellTransform(cell, {});
        expect(next.rotation).toBeUndefined();
        expect(next.translation).toBeUndefined();
        expect(next.fillId).toBe(2);
    });
});

describe('pairPeriodicSurfaces', () => {
    it('pairs both planes reciprocally and promotes their boundaries', () => {
        const surfaces = periodicPlanes().map((surface) => ({ ...surface, boundary: 'vacuum' as const }));
        const next = pairPeriodicSurfaces(surfaces, 1, 2);
        expect(next[0].boundary).toBe('periodic');
        expect(next[0].periodicSurfaceId).toBe(2);
        expect(next[1].boundary).toBe('periodic');
        expect(next[1].periodicSurfaceId).toBe(1);
    });

    it('re-pairs without leaving a dangling old partner', () => {
        const paired = pairPeriodicSurfaces(periodicPlanes(), 1, 2);
        const repaired = pairPeriodicSurfaces(paired, 1, 3);
        expect(repaired.find((surface) => surface.id === 2)?.periodicSurfaceId).toBeUndefined();
        expect(repaired.find((surface) => surface.id === 3)?.periodicSurfaceId).toBe(1);
    });

    it('clears both sides when the partner is removed', () => {
        const paired = pairPeriodicSurfaces(periodicPlanes(), 1, 2);
        const cleared = pairPeriodicSurfaces(paired, 1, undefined);
        expect(cleared.find((surface) => surface.id === 1)?.periodicSurfaceId).toBeUndefined();
        expect(cleared.find((surface) => surface.id === 2)?.periodicSurfaceId).toBeUndefined();
    });

    it('rejects self-pairing and missing surfaces', () => {
        const surfaces = periodicPlanes();
        expect(() => pairPeriodicSurfaces(surfaces, 1, 1)).toThrow(/itself/);
        expect(() => pairPeriodicSurfaces(surfaces, 1, 9)).toThrow(/not found/);
        expect(() => pairPeriodicSurfaces(surfaces, 9, 1)).toThrow(/not found/);
    });
});
