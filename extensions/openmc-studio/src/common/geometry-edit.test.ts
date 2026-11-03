// *****************************************************************************
// Copyright (C) 2026 NukeHub and others.
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
 * Tests the pure CSG geometry edit loop used by the AI preview capability.
 */

import { describe, expect, it } from 'vitest';
import { OpenMCGeometry } from './openmc-state-schema';
import { applyGeometryActions, GeometryAction, MAX_GEOMETRY_ACTIONS } from './geometry-edit';

function buildGeometry(): OpenMCGeometry {
    return {
        surfaces: [
            { id: 1, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 1 }, name: 'Core' },
            { id: 2, type: 'x-plane', coefficients: { x0: 0 } },
            { id: 3, type: 'y-plane', coefficients: { y0: 0 } }
        ],
        cells: [
            {
                id: 1,
                name: 'Fuel',
                region: {
                    type: 'operator',
                    operator: 'intersection',
                    children: [
                        { type: 'surface', surfaceId: 1 },
                        { type: 'surface', surfaceId: 2 }
                    ]
                },
                regionString: '-1 2',
                fillType: 'material',
                fillId: 1
            },
            { id: 2, regionString: '-2', fillType: 'universe', fillId: 1 },
            { id: 3, fillType: 'void' },
            { id: 4, region: { type: 'surface', surfaceId: 3 }, fillType: 'void' },
            { id: 5, regionString: '-2', fillType: 'lattice', fillId: 2 }
        ],
        universes: [
            { id: 0, name: 'root', cellIds: [1, 3, 4, 5] },
            { id: 1, name: 'Assembly', cellIds: [2] },
            { id: 2, name: 'Lattice filler', cellIds: [] }
        ],
        lattices: [
            {
                id: 1,
                type: 'rect',
                lowerLeft: [0, 0],
                pitch: [1, 1],
                dimensions: [1, 1],
                universes: [[[2]]]
            },
            {
                id: 2,
                type: 'rect',
                lowerLeft: [0, 0],
                pitch: [1, 1],
                dimensions: [1, 1],
                universes: [[[1]]]
            }
        ],
        rootUniverseId: 0
    };
}

function ids(geometry: OpenMCGeometry, kind: 'surfaces' | 'cells' | 'universes' | 'lattices'): number[] {
    return geometry[kind].map((entity) => entity.id);
}

describe('applyGeometryActions', () => {
    it('adds each geometry kind and assigns the next id when omitted', () => {
        const geometry = buildGeometry();
        const result = applyGeometryActions(geometry, [
            { action: 'add', kind: 'surface', value: { type: 'z-plane', coefficients: { z0: 5 } } },
            { action: 'add', kind: 'cell', value: { fillType: 'void' } },
            { action: 'add', kind: 'universe', value: { name: 'Shield', cellIds: [] } },
            {
                action: 'add',
                kind: 'lattice',
                value: {
                    type: 'rect',
                    lowerLeft: [0, 0],
                    pitch: [1, 1],
                    dimensions: [1, 1],
                    universes: [[[2]]]
                }
            }
        ]);

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(ids(result.geometry, 'surfaces')).toEqual([1, 2, 3, 4]);
        expect(ids(result.geometry, 'cells')).toEqual([1, 2, 3, 4, 5, 6]);
        expect(ids(result.geometry, 'universes')).toEqual([0, 1, 2, 3]);
        expect(ids(result.geometry, 'lattices')).toEqual([1, 2, 3]);
        expect(result.changes).toEqual([
            {
                path: 'geometry.surfaces.4',
                label: 'Add surface #4',
                kind: 'add',
                after: { id: 4, type: 'z-plane', coefficients: { z0: 5 } }
            },
            { path: 'geometry.cells.6', label: 'Add cell #6', kind: 'add', after: { id: 6, fillType: 'void' } },
            {
                path: 'geometry.universes.3',
                label: 'Add universe #3',
                kind: 'add',
                after: { id: 3, name: 'Shield', cellIds: [] }
            },
            {
                path: 'geometry.lattices.3',
                label: 'Add lattice #3',
                kind: 'add',
                after: {
                    id: 3,
                    type: 'rect',
                    lowerLeft: [0, 0],
                    pitch: [1, 1],
                    dimensions: [1, 1],
                    universes: [[[2]]]
                }
            }
        ]);
    });

    it('updates and removes each geometry kind', () => {
        const geometry = buildGeometry();
        const result = applyGeometryActions(geometry, [
            { action: 'update', kind: 'surface', id: 1, updates: { name: 'Core shell' } },
            { action: 'update', kind: 'cell', id: 3, updates: { name: 'Outside' } },
            { action: 'update', kind: 'universe', id: 1, updates: { name: 'Assembly A' } },
            { action: 'update', kind: 'lattice', id: 2, updates: { name: 'Pin lattice' } },
            { action: 'update', kind: 'universe', id: 0, updates: { cellIds: [1, 3, 5] } },
            { action: 'remove', kind: 'cell', id: 4 },
            { action: 'remove', kind: 'surface', id: 3 },
            { action: 'remove', kind: 'lattice', id: 1 },
            { action: 'remove', kind: 'universe', id: 2 }
        ]);

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(ids(result.geometry, 'surfaces')).toEqual([1, 2]);
        expect(ids(result.geometry, 'cells')).toEqual([1, 2, 3, 5]);
        expect(ids(result.geometry, 'universes')).toEqual([0, 1]);
        expect(ids(result.geometry, 'lattices')).toEqual([2]);
        expect(result.geometry.surfaces[0].name).toBe('Core shell');
        expect(result.geometry.cells[2].name).toBe('Outside');
        expect(result.geometry.universes[1].name).toBe('Assembly A');
        expect(result.geometry.lattices[0].name).toBe('Pin lattice');
        expect(result.changes.map((change) => change.kind)).toEqual([
            'update',
            'update',
            'update',
            'update',
            'update',
            'remove',
            'remove',
            'remove',
            'remove'
        ]);
        expect(result.changes[4]).toMatchObject({ path: 'geometry.universes.0', kind: 'update' });
    });

    it('returns before and after rows for updates and removals', () => {
        const geometry = buildGeometry();
        const result = applyGeometryActions(geometry, [
            { action: 'update', kind: 'cell', id: 3, updates: { name: 'Outside' } },
            { action: 'remove', kind: 'lattice', id: 1 }
        ]);

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.changes[0]).toEqual({
            path: 'geometry.cells.3',
            label: 'Update cell #3',
            kind: 'update',
            before: { id: 3, fillType: 'void' },
            after: { id: 3, fillType: 'void', name: 'Outside' }
        });
        expect(result.changes[1].kind).toBe('remove');
        expect(result.changes[1].path).toBe('geometry.lattices.1');
        expect(result.changes[1].label).toBe('Remove lattice #1');
        expect(result.changes[1].before).toEqual(geometry.lattices[0]);
        expect('after' in result.changes[1]).toBe(false);
    });

    it('rejects duplicate ids, missing targets, and id changes', () => {
        const geometry = buildGeometry();
        const cases: Array<{ actions: GeometryAction[]; message: string }> = [
            {
                actions: [{ action: 'add', kind: 'surface', value: { id: 1, type: 'z-plane', coefficients: { z0: 5 } } }],
                message: 'already exists'
            },
            { actions: [{ action: 'add', kind: 'cell', value: { id: 0, fillType: 'void' } }], message: 'positive integer' },
            { actions: [{ action: 'update', kind: 'surface', id: 99, updates: { name: 'Missing' } }], message: 'does not exist' },
            { actions: [{ action: 'remove', kind: 'cell', id: 99 }], message: 'does not exist' },
            { actions: [{ action: 'update', kind: 'surface', id: 1, updates: {} }], message: 'at least one field' },
            { actions: [{ action: 'update', kind: 'surface', id: 1, updates: { id: 9, name: 'Moved' } }], message: 'id cannot be changed' }
        ];

        for (const testCase of cases) {
            const result = applyGeometryActions(geometry, testCase.actions);
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.message).toContain(testCase.message);
            }
        }
    });

    it('rejects removing a surface referenced by a region string or region tree', () => {
        const geometry = buildGeometry();

        const byString = applyGeometryActions(geometry, [{ action: 'remove', kind: 'surface', id: 2 }]);
        expect(byString.ok).toBe(false);
        if (!byString.ok) {
            expect(byString.message).toContain('cell #1');
        }

        const byTree = applyGeometryActions(geometry, [{ action: 'remove', kind: 'surface', id: 3 }]);
        expect(byTree.ok).toBe(false);
        if (!byTree.ok) {
            expect(byTree.message).toContain('cell #4');
        }
    });

    it('rejects removing a cell referenced by a universe', () => {
        const result = applyGeometryActions(buildGeometry(), [{ action: 'remove', kind: 'cell', id: 2 }]);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.message).toContain('universe #1');
        }
    });

    it('rejects removing a universe filled by a cell, used by a lattice, or the root', () => {
        const geometry = buildGeometry();
        const filled = applyGeometryActions(geometry, [{ action: 'remove', kind: 'universe', id: 1 }]);
        expect(filled.ok).toBe(false);
        if (!filled.ok) {
            expect(filled.message).toContain('cell #2');
        }

        const lattice = applyGeometryActions(geometry, [{ action: 'remove', kind: 'universe', id: 2 }]);
        expect(lattice.ok).toBe(false);
        if (!lattice.ok) {
            expect(lattice.message).toContain('lattice #1');
        }

        const root = applyGeometryActions(geometry, [{ action: 'remove', kind: 'universe', id: 0 }]);
        expect(root.ok).toBe(false);
        if (!root.ok) {
            expect(root.message).toContain('root universe');
        }
    });

    it('rejects removing a lattice filled by a cell', () => {
        const result = applyGeometryActions(buildGeometry(), [{ action: 'remove', kind: 'lattice', id: 2 }]);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.message).toContain('cell #5');
        }
    });

    it('rejects a cell fill update that points at a missing target', () => {
        const geometry = buildGeometry();
        const missingUniverse = applyGeometryActions(geometry, [{ action: 'update', kind: 'cell', id: 2, updates: { fillId: 99 } }]);
        expect(missingUniverse.ok).toBe(false);
        if (!missingUniverse.ok) {
            expect(missingUniverse.message).toContain('universe #99');
        }

        const missingLattice = applyGeometryActions(geometry, [{ action: 'update', kind: 'cell', id: 5, updates: { fillId: 99 } }]);
        expect(missingLattice.ok).toBe(false);
        if (!missingLattice.ok) {
            expect(missingLattice.message).toContain('lattice #99');
        }
    });

    it('does not mutate the input model or share change rows with the result', () => {
        const geometry = buildGeometry();
        const snapshot = JSON.parse(JSON.stringify(geometry)) as OpenMCGeometry;

        const result = applyGeometryActions(geometry, [
            { action: 'update', kind: 'cell', id: 3, updates: { name: 'Outside' } },
            { action: 'add', kind: 'surface', value: { id: 4, type: 'z-plane', coefficients: { z0: 5 } } },
            { action: 'remove', kind: 'lattice', id: 1 }
        ]);

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(geometry).toEqual(snapshot);
        (result.geometry.cells[2] as { name?: string }).name = 'Mutated';
        expect(geometry.cells[2].name).toBeUndefined();
        (result.changes[0].after as { name?: string }).name = 'Mutated row';
        expect(result.geometry.cells[2].name).toBe('Mutated');
    });

    it('enforces the action bounds', () => {
        const geometry = buildGeometry();
        expect(applyGeometryActions(geometry, []).ok).toBe(false);

        const tooMany = Array.from({ length: MAX_GEOMETRY_ACTIONS + 1 }, (): GeometryAction => ({
            action: 'update',
            kind: 'cell',
            id: 3,
            updates: { name: 'Outside' }
        }));
        const result = applyGeometryActions(geometry, tooMany);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.message).toContain('between 1 and 48');
        }
    });

    it('rejects unknown kinds and actions', () => {
        const geometry = buildGeometry();
        const unknownKind = applyGeometryActions(geometry, [{ action: 'add', kind: 'mesh', value: {} } as unknown as GeometryAction]);
        expect(unknownKind.ok).toBe(false);
        if (!unknownKind.ok) {
            expect(unknownKind.message).toContain('kind of surface, cell, universe, or lattice');
        }

        const unknownAction = applyGeometryActions(geometry, [{ action: 'rename', kind: 'cell', id: 3 } as unknown as GeometryAction]);
        expect(unknownAction.ok).toBe(false);
        if (!unknownAction.ok) {
            expect(unknownAction.message).toContain('must be add, update, or remove');
        }
    });
});
