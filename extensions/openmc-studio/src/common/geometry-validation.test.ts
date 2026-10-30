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
 * Tests for the structural geometry validation used by validateState and the
 * run-readiness checklist.
 */

import { describe, it, expect } from 'vitest';

import { validateGeometryModel } from './geometry-validation';
import { OpenMCGeometry, OpenMCLattice, OpenMCSurface } from './openmc-state-schema';

/** Build a geometry with a 2×2 rectangular lattice and a nested universe. */
function buildGeometry(): OpenMCGeometry {
    const lattice: OpenMCLattice = {
        id: 10,
        type: 'rect',
        name: 'Assembly',
        lowerLeft: [0, 0],
        pitch: [1, 1],
        dimensions: [2, 2],
        universes: [
            [
                [1, 1],
                [1, 2]
            ]
        ],
        outer: 3
    };
    return {
        surfaces: [],
        cells: [
            { id: 1, fillType: 'material', fillId: 1, regionString: '-1' },
            { id: 2, fillType: 'lattice', fillId: 10, regionString: '-1' },
            { id: 6, fillType: 'void' },
            { id: 7, fillType: 'void' }
        ],
        universes: [
            { id: 0, name: 'root', cellIds: [2] },
            { id: 1, name: 'pin', cellIds: [1] },
            { id: 2, name: 'reflector', cellIds: [7] },
            { id: 3, name: 'outside', cellIds: [6] }
        ],
        lattices: [lattice],
        rootUniverseId: 0
    };
}

/** Return only errors (warnings are separately asserted where needed). */
function errors(geometry: OpenMCGeometry): string[] {
    return validateGeometryModel(geometry)
        .filter((issue) => issue.severity === 'error')
        .map((issue) => issue.message);
}

describe('validateGeometryModel lattices', () => {
    it('accepts a valid 2×2 rectangular lattice with an outer universe', () => {
        expect(errors(buildGeometry())).toEqual([]);
    });

    it('errors when a cell fills a lattice that does not exist', () => {
        const geometry = buildGeometry();
        geometry.cells[1].fillId = 99;
        expect(errors(geometry).some((message) => message.includes('fills lattice #99 which does not exist'))).toBe(true);
    });

    it('errors when a lattice references a universe that does not exist', () => {
        const geometry = buildGeometry();
        const lattice = geometry.lattices[0] as OpenMCLattice & { type: 'rect' };
        lattice.universes[0][0][0] = 42;
        expect(errors(geometry).some((message) => message.includes('universe #42 does not exist'))).toBe(true);
    });

    it('errors when the lattice universe shape does not match dimensions', () => {
        const geometry = buildGeometry();
        const lattice = geometry.lattices[0] as OpenMCLattice & { type: 'rect' };
        lattice.universes = [
            [
                [1, 1, 2],
                [1, 2, 2]
            ]
        ];
        expect(errors(geometry).some((message) => message.includes('universe array shape does not match'))).toBe(true);
    });

    it('errors when the outer universe does not exist', () => {
        const geometry = buildGeometry();
        geometry.lattices[0].outer = 77;
        expect(errors(geometry).some((message) => message.includes('outer universe #77 does not exist'))).toBe(true);
    });

    it('errors when a lattice universe or outer universe has no cells', () => {
        const geometry = buildGeometry();
        geometry.universes.find((universe) => universe.id === 2)!.cellIds = [];
        geometry.universes.find((universe) => universe.id === 3)!.cellIds = [];
        const messages = errors(geometry);
        expect(messages.some((message) => message.includes('universe #2 has no cells'))).toBe(true);
        expect(messages.some((message) => message.includes('outer universe #3 has no cells'))).toBe(true);
    });

    it('errors when the root universe has no cells', () => {
        const geometry = buildGeometry();
        geometry.universes.find((universe) => universe.id === 0)!.cellIds = [];
        geometry.universes.find((universe) => universe.id === 1)!.cellIds = [1, 2];
        expect(errors(geometry).some((message) => message.includes('Root universe 0 has no cells'))).toBe(true);
    });

    it('errors when a lattice ID collides with a universe ID', () => {
        const geometry = buildGeometry();
        geometry.lattices[0].id = 2;
        geometry.cells[1].fillId = 2;
        expect(errors(geometry).some((message) => message.includes('share an ID with a universe'))).toBe(true);
    });

    it('errors when a cell belongs to more than one universe', () => {
        const geometry = buildGeometry();
        geometry.universes.find((universe) => universe.id === 3)!.cellIds.push(1);
        expect(errors(geometry).some((message) => message.includes('belongs to multiple universes'))).toBe(true);
    });

    it('errors when universe 0 is used as a fill', () => {
        const geometry = buildGeometry();
        geometry.cells[1].fillType = 'universe';
        geometry.cells[1].fillId = 0;
        expect(errors(geometry).some((message) => message.includes('fills universe 0'))).toBe(true);
    });

    it('errors when universe 0 is used as a lattice position or outer fill', () => {
        const geometry = buildGeometry();
        const lattice = geometry.lattices[0] as OpenMCLattice & { type: 'rect' };
        lattice.universes[0][0][0] = 0;
        lattice.outer = 0;
        const messages = errors(geometry);
        expect(messages.some((message) => message.includes('used as a lattice fill'))).toBe(true);
        expect(messages.some((message) => message.includes('outer universe is 0'))).toBe(true);
    });

    it('errors when the root universe is not 0', () => {
        const geometry = buildGeometry();
        geometry.rootUniverseId = 1;
        expect(errors(geometry).some((message) => message.includes('Root universe is set to #1'))).toBe(true);
    });

    it('errors when hex rings or n_axial are invalid', () => {
        const geometry = buildGeometry();
        geometry.lattices = [
            {
                id: 20,
                type: 'hex',
                rings: 0,
                center: [0, 0],
                pitch: [1],
                universes: [[[1]]]
            }
        ];
        expect(errors(geometry).some((message) => message.includes('n_rings must be a positive integer'))).toBe(true);

        geometry.lattices = [
            {
                id: 20,
                type: 'hex',
                rings: 2,
                nAxial: 0,
                center: [0, 0],
                pitch: [1],
                universes: [[[1, 1, 1, 1, 1, 1], [1]]]
            }
        ];
        expect(errors(geometry).some((message) => message.includes('n_axial must be a positive integer'))).toBe(true);
    });

    it('errors when a 3D hex lattice has 2D center/pitch', () => {
        const geometry = buildGeometry();
        geometry.lattices = [
            {
                id: 20,
                type: 'hex',
                rings: 2,
                nAxial: 2,
                center: [0, 0],
                pitch: [1],
                universes: [
                    [[1, 1, 1, 1, 1, 1], [1]],
                    [[1, 1, 1, 1, 1, 1], [1]]
                ]
            }
        ];
        expect(errors(geometry).some((message) => message.includes('center must contain 3 finite coordinates'))).toBe(true);
        expect(errors(geometry).some((message) => message.includes('pitch must contain 2 positive number'))).toBe(true);
    });

    it('accepts a valid 3D hex lattice', () => {
        const geometry = buildGeometry();
        geometry.cells[1] = { id: 2, fillType: 'lattice', fillId: 20, regionString: '-1' };
        geometry.lattices = [
            {
                id: 20,
                type: 'hex',
                rings: 2,
                nAxial: 2,
                center: [0, 0, 0],
                pitch: [1, 2],
                universes: [
                    [[1, 1, 1, 1, 1, 1], [2]],
                    [[1, 1, 1, 1, 1, 1], [2]]
                ]
            }
        ];
        expect(errors(geometry)).toEqual([]);
    });
});

describe('validateGeometryModel cells', () => {
    it('errors on a rotation that is not three finite angles', () => {
        const geometry = buildGeometry();
        geometry.cells[1].rotation = [0, 90] as unknown as [number, number, number];
        expect(errors(geometry).some((message) => message.includes('rotation must be three finite angles'))).toBe(true);

        geometry.cells[1].rotation = [0, Number.NaN, 90];
        expect(errors(geometry).some((message) => message.includes('rotation must be three finite angles'))).toBe(true);
    });

    it('errors on a translation that is not three finite values', () => {
        const geometry = buildGeometry();
        geometry.cells[1].translation = [0, 0, Number.POSITIVE_INFINITY];
        expect(errors(geometry).some((message) => message.includes('translation must be three finite values'))).toBe(true);
    });

    it('errors on a density override that is not positive', () => {
        const geometry = buildGeometry();
        geometry.cells[0].density = 0;
        expect(errors(geometry).some((message) => message.includes('density override must be a positive number'))).toBe(true);
    });

    it('warns when rotation is set on a material cell', () => {
        const geometry = buildGeometry();
        geometry.cells[0].rotation = [0, 0, 90];
        const issues = validateGeometryModel(geometry);
        expect(issues.some((issue) => issue.severity === 'warning' && issue.message.includes('rotation only affects'))).toBe(true);
    });
});

describe('validateGeometryModel periodic boundaries and albedo', () => {
    /** Build two reciprocal periodic planes. */
    function periodicPair(): OpenMCSurface[] {
        return [
            { id: 1, type: 'x-plane', coefficients: { x0: -1 }, boundary: 'periodic', periodicSurfaceId: 2 },
            { id: 2, type: 'x-plane', coefficients: { x0: 1 }, boundary: 'periodic', periodicSurfaceId: 1 }
        ];
    }

    it('accepts a reciprocal periodic pair with albedo', () => {
        const geometry = buildGeometry();
        geometry.surfaces = periodicPair();
        geometry.surfaces[0].albedo = 0.5;
        geometry.surfaces[1].albedo = 0.5;
        expect(errors(geometry)).toEqual([]);
    });

    it('errors when a periodic surface has no partner', () => {
        const geometry = buildGeometry();
        geometry.surfaces = [{ id: 1, type: 'x-plane', coefficients: { x0: -1 }, boundary: 'periodic' }];
        expect(errors(geometry).some((message) => message.includes('has no partner surface'))).toBe(true);
    });

    it('errors when the partner is not periodic', () => {
        const geometry = buildGeometry();
        const surfaces = periodicPair();
        surfaces[1].boundary = 'vacuum';
        geometry.surfaces = surfaces;
        expect(errors(geometry).some((message) => message.includes('is not periodic'))).toBe(true);
    });

    it('errors when only one side points at the other', () => {
        const geometry = buildGeometry();
        const surfaces = periodicPair();
        delete surfaces[1].periodicSurfaceId;
        geometry.surfaces = surfaces;
        expect(errors(geometry).some((message) => message.includes('does not point back'))).toBe(true);
    });

    it('errors when a periodic surface pairs with itself', () => {
        const geometry = buildGeometry();
        geometry.surfaces = [{ id: 1, type: 'x-plane', coefficients: { x0: -1 }, boundary: 'periodic', periodicSurfaceId: 1 }];
        expect(errors(geometry).some((message) => message.includes('cannot pair with itself'))).toBe(true);
    });

    it('errors when the periodic partner does not exist', () => {
        const geometry = buildGeometry();
        geometry.surfaces = [{ id: 1, type: 'x-plane', coefficients: { x0: -1 }, boundary: 'periodic', periodicSurfaceId: 9 }];
        expect(errors(geometry).some((message) => message.includes('partner #9 does not exist'))).toBe(true);
    });

    it('errors when a non-plane is periodic', () => {
        const geometry = buildGeometry();
        geometry.surfaces = [
            { id: 1, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 1 }, boundary: 'periodic', periodicSurfaceId: 2 },
            { id: 2, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 2 }, boundary: 'periodic', periodicSurfaceId: 1 }
        ];
        expect(errors(geometry).some((message) => message.includes('periodic boundaries must be planes'))).toBe(true);
    });

    it('errors when periodicSurfaceId is set on a non-periodic boundary', () => {
        const geometry = buildGeometry();
        geometry.surfaces = [{ id: 1, type: 'x-plane', coefficients: { x0: -1 }, boundary: 'vacuum', periodicSurfaceId: 2 }];
        expect(errors(geometry).some((message) => message.includes('boundary is not periodic'))).toBe(true);
    });

    it('warns on albedo for a non-albedo boundary and above 1', () => {
        const geometry = buildGeometry();
        geometry.surfaces = [{ id: 1, type: 'x-plane', coefficients: { x0: -1 }, boundary: 'vacuum', albedo: 0.5 }];
        expect(validateGeometryModel(geometry).some((issue) => issue.message.includes('albedo only applies'))).toBe(true);

        geometry.surfaces = [{ id: 1, type: 'x-plane', coefficients: { x0: -1 }, boundary: 'reflective', albedo: 1.5 }];
        expect(validateGeometryModel(geometry).some((issue) => issue.message.includes('greater than 1'))).toBe(true);
    });

    it('errors when two surfaces claim the same periodic partner', () => {
        const geometry = buildGeometry();
        geometry.surfaces = [
            { id: 1, type: 'x-plane', coefficients: { x0: -1 }, boundary: 'periodic', periodicSurfaceId: 3 },
            { id: 2, type: 'x-plane', coefficients: { x0: 0 }, boundary: 'periodic', periodicSurfaceId: 3 },
            { id: 3, type: 'x-plane', coefficients: { x0: 1 }, boundary: 'periodic', periodicSurfaceId: 1 }
        ];
        expect(errors(geometry).some((message) => message.includes('all name #3 as their periodic partner'))).toBe(true);
    });

    it('errors on a non-positive albedo', () => {
        const geometry = buildGeometry();
        geometry.surfaces = [{ id: 1, type: 'x-plane', coefficients: { x0: -1 }, boundary: 'reflective', albedo: 0 }];
        expect(errors(geometry).some((message) => message.includes('albedo must be a finite number greater than zero'))).toBe(true);
    });
});
