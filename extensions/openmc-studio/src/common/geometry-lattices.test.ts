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
 * Tests for the canonical lattice ordering helpers. The hex sequences are the
 * exact flat universe order OpenMC 0.15.3/0.16.0 writes for the same rings,
 * so generation and import cannot drift from the reader.
 */

import { describe, it, expect } from 'vitest';

import {
    flattenHexLatticeUniverses,
    flattenRectLatticeUniverses,
    hexLatticeRingSizes,
    hexLatticeUniverseCount,
    hexLatticeUniverseRows,
    normalizeGeometryForLoad,
    normalizeLatticeForLoad,
    reshapeHexLatticeUniverses,
    reshapeRectLatticeUniverses,
    resizeHexLatticeUniverses,
    resizeRectLatticeUniverses
} from './geometry-lattices';
import { OpenMCGeometry, OpenMCHexLattice, OpenMCLattice, OpenMCRectLattice } from './openmc-state-schema';

/** Build a rectangular lattice from `[z][y][x]` universes. */
function rectLattice(universes: number[][][], dimensions: [number, number] | [number, number, number]): OpenMCRectLattice & { id: number } {
    return {
        id: 10,
        type: 'rect',
        lowerLeft: dimensions.length === 3 ? [0, 0, 0] : [0, 0],
        pitch: dimensions.length === 3 ? [1, 1, 1] : [1, 1],
        dimensions,
        universes
    };
}

/** Build a hexagonal lattice with sequential universe IDs in ring/theta order. */
function hexLattice(rings: number, orientation: 'x' | 'y' = 'y', nAxial?: number): OpenMCHexLattice & { id: number } {
    const sizes = hexLatticeRingSizes(rings);
    let next = 1;
    const slice = sizes.map((size) => Array.from({ length: size }, () => next++));
    return {
        id: 20,
        type: 'hex',
        rings,
        orientation,
        nAxial,
        center: nAxial && nAxial > 1 ? [0, 0, 0] : [0, 0],
        pitch: nAxial && nAxial > 1 ? [1, 1] : [1],
        universes: Array.from({ length: nAxial && nAxial > 1 ? nAxial : 1 }, () => slice.map((ring) => [...ring]))
    };
}

describe('hexagonal lattice ordering', () => {
    it('uses ring sizes with a single center universe', () => {
        expect(hexLatticeRingSizes(1)).toEqual([1]);
        expect(hexLatticeRingSizes(3)).toEqual([12, 6, 1]);
        expect(hexLatticeUniverseCount(3)).toBe(19);
    });

    it('matches the OpenMC flat order for 2 rings in y orientation', () => {
        const flat = flattenHexLatticeUniverses(hexLattice(2, 'y'));
        expect(flat).toEqual([1, 6, 2, 7, 5, 3, 4]);
    });

    it('matches the OpenMC flat order for 2 rings in x orientation', () => {
        const flat = flattenHexLatticeUniverses(hexLattice(2, 'x'));
        expect(flat).toEqual([5, 6, 4, 7, 1, 3, 2]);
    });

    it('matches the OpenMC flat order for 3 rings in both orientations', () => {
        expect(flattenHexLatticeUniverses(hexLattice(3, 'y'))).toEqual([1, 12, 2, 11, 13, 3, 18, 14, 10, 19, 4, 17, 15, 9, 16, 5, 8, 6, 7]);
        expect(flattenHexLatticeUniverses(hexLattice(3, 'x'))).toEqual([9, 10, 11, 8, 17, 18, 12, 7, 16, 19, 13, 1, 6, 15, 14, 2, 5, 4, 3]);
    });

    it('keeps one visual row per ring segment', () => {
        const rows = hexLatticeUniverseRows(2, 'y');
        expect(rows.map((row) => row.length)).toEqual([1, 2, 1, 2, 1]);
        expect(rows.flat()).toHaveLength(7);
    });

    it('round-trips a 3D hex lattice through flatten and reshape', () => {
        const lattice = hexLattice(2, 'x', 3);
        const flat = flattenHexLatticeUniverses(lattice);
        expect(flat).toHaveLength(21);
        expect(reshapeHexLatticeUniverses(flat, 2, 'x', 3)).toEqual(lattice.universes);
    });

    it('round-trips a 2D hex lattice through flatten and reshape', () => {
        const lattice = hexLattice(3, 'y');
        const flat = flattenHexLatticeUniverses(lattice);
        expect(reshapeHexLatticeUniverses(flat, 3, 'y', 1)).toEqual(lattice.universes);
    });
});

describe('rectangular lattice ordering', () => {
    it('flattens z, then top-to-bottom rows, x fastest', () => {
        const universes = [
            [
                [1, 2],
                [3, 4]
            ]
        ];
        expect(flattenRectLatticeUniverses(rectLattice(universes, [2, 2]))).toEqual([
            [1, 2],
            [3, 4]
        ]);
    });

    it('flattens every z slice in order', () => {
        const universes = [
            [
                [1, 2],
                [3, 4]
            ],
            [
                [5, 6],
                [7, 8]
            ]
        ];
        expect(flattenRectLatticeUniverses(rectLattice(universes, [2, 2, 2]))).toEqual([
            [1, 2],
            [3, 4],
            [5, 6],
            [7, 8]
        ]);
    });

    it('round-trips a 3D rect lattice through flatten and reshape', () => {
        const universes = [
            [
                [1, 2, 3],
                [4, 5, 6]
            ],
            [
                [7, 8, 9],
                [10, 11, 12]
            ],
            [
                [13, 14, 15],
                [16, 17, 18]
            ]
        ];
        const lattice = rectLattice(universes, [3, 2, 3]);
        const flat = flattenRectLatticeUniverses(lattice).flat();
        expect(reshapeRectLatticeUniverses(flat, [3, 2, 3])).toEqual(universes);
    });

    it('resizes without losing existing entries', () => {
        const universes = [
            [
                [1, 2],
                [3, 4]
            ]
        ];
        expect(resizeRectLatticeUniverses(universes, [3, 2])).toEqual([
            [
                [1, 2, 0],
                [3, 4, 0]
            ]
        ]);
        expect(resizeRectLatticeUniverses(universes, [2, 2, 2])).toEqual([
            [
                [1, 2],
                [3, 4]
            ],
            [
                [0, 0],
                [0, 0]
            ]
        ]);
    });
});

describe('hexagonal lattice resizing', () => {
    it('grows and shrinks ring arrays while preserving positions', () => {
        const original = hexLattice(2).universes;
        const grown = resizeHexLatticeUniverses(original, 3, 1);
        expect(grown[0].map((ring) => ring.length)).toEqual([12, 6, 1]);
        expect(grown[0][0][0]).toBe(original[0][0][0]);
        expect(grown[0][2][0]).toBe(0);

        const shrunk = resizeHexLatticeUniverses(grown, 2, 1);
        expect(shrunk[0].map((ring) => ring.length)).toEqual([6, 1]);
        expect(shrunk[0][0][0]).toBe(original[0][0][0]);
    });

    it('adds and removes axial slices', () => {
        const original = hexLattice(2).universes;
        const threeLevels = resizeHexLatticeUniverses(original, 2, 3);
        expect(threeLevels).toHaveLength(3);
        expect(threeLevels[0]).toEqual(original[0]);
        expect(threeLevels[2][0]).toEqual([0, 0, 0, 0, 0, 0]);
        expect(threeLevels[2][1]).toEqual([0]);
        expect(resizeHexLatticeUniverses(threeLevels, 2, 1)).toEqual(original);
    });
});

describe('lattice migration normalization', () => {
    it('converts x-hex/y-hex types into orientation', () => {
        const xHex = {
            id: 1,
            type: 'x-hex',
            center: [0, 0],
            pitch: [1],
            rings: 2,
            universes: [[[1, 1, 1, 1, 1, 1], [1]]]
        } as unknown as OpenMCLattice;
        const yHex = {
            id: 2,
            type: 'y-hex',
            center: [0, 0],
            pitch: [1],
            rings: 2,
            universes: [[[1, 1, 1, 1, 1, 1], [1]]]
        } as unknown as OpenMCLattice;
        expect(normalizeLatticeForLoad(xHex)).toMatchObject({ type: 'hex', orientation: 'x' });
        expect(normalizeLatticeForLoad(yHex)).toMatchObject({ type: 'hex', orientation: 'y' });
    });

    it('maps the legacy axial object onto pitch and nAxial', () => {
        const legacy = {
            id: 3,
            type: 'hex',
            center: [0, 0, 0],
            pitch: [1],
            rings: 2,
            axial: { pitch: 5, offset: 2, nStacks: 4 },
            universes: [[[1, 1, 1, 1, 1, 1], [1]]]
        } as unknown as OpenMCLattice;
        const normalized = normalizeLatticeForLoad(legacy) as OpenMCHexLattice;
        expect(normalized.pitch).toEqual([1, 5]);
        expect(normalized.nAxial).toBe(4);
        expect((normalized as unknown as { axial?: unknown }).axial).toBeUndefined();
    });

    it('transposes legacy bottom-up rect arrays into [z][y][x]', () => {
        const legacy = {
            id: 4,
            type: 'rect',
            lowerLeft: [0, 0, 0],
            pitch: [1, 1, 1],
            dimensions: [2, 2, 1],
            universes: [
                [
                    [1, 0],
                    [2, 0]
                ],
                [
                    [3, 0],
                    [4, 0]
                ]
            ]
        } as unknown as OpenMCLattice;
        const normalized = normalizeLatticeForLoad(legacy);
        expect(normalized.type).toBe('rect');
        if (normalized.type === 'rect') {
            expect(normalized.universes).toEqual([
                [
                    [3, 4],
                    [1, 2]
                ]
            ]);
        }
    });

    it('strips isRoot and defaults rootUniverseId', () => {
        const geometry = {
            surfaces: [],
            cells: [],
            universes: [{ id: 0, name: 'root', cellIds: [], isRoot: true }],
            lattices: [],
            rootUniverseId: 0
        } as unknown as OpenMCGeometry;
        const normalized = normalizeGeometryForLoad(geometry);
        expect(normalized.universes[0]).toEqual({ id: 0, name: 'root', cellIds: [] });
        expect(normalized.rootUniverseId).toBe(0);
    });
});
