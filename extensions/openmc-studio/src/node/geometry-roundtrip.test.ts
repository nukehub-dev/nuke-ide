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
 * geometry.xml round-trip tests: state → XML → import → state → XML.
 *
 * The fixtures cover rectangular and hexagonal lattices, cell rotation /
 * translation / density, periodic surface pairs, and albedo. Each scenario
 * asserts the emitted OpenMC contract and byte-equivalent regeneration after
 * import.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { XMLGenerationService } from './xml-generation-service';
import { OpenMCStudioBackendServiceImpl } from './openmc-studio-backend-service';
import { OpenMCGeometry, OpenMCState } from '../common/openmc-state-schema';

/** Minimal metadata shared by the fixtures. */
function metadata(): OpenMCState['metadata'] {
    const now = new Date().toISOString();
    return { version: '1.1.0', name: 'Geometry Round Trip', created: now, modified: now };
}

/**
 * Build a 2×2×1 rectangular-lattice model with transforms, a density
 * override, reciprocal periodic planes, and albedo.
 */
function buildRectState(): OpenMCState {
    return {
        metadata: metadata(),
        geometry: {
            surfaces: [
                { id: 1, type: 'z-cylinder', coefficients: { x0: 0, y0: 0, r: 0.5 } },
                { id: 2, type: 'x-plane', coefficients: { x0: -1 }, boundary: 'periodic', periodicSurfaceId: 4, albedo: 0.9 },
                { id: 3, type: 'y-plane', coefficients: { y0: -1 }, boundary: 'periodic', periodicSurfaceId: 5, albedo: 0.9 },
                { id: 4, type: 'x-plane', coefficients: { x0: 1 }, boundary: 'periodic', periodicSurfaceId: 2, albedo: 0.9 },
                { id: 5, type: 'y-plane', coefficients: { y0: 1 }, boundary: 'periodic', periodicSurfaceId: 3, albedo: 0.9 }
            ],
            cells: [
                { id: 1, name: 'Fuel', fillType: 'material', fillId: 1, regionString: '-1', density: 10.4 },
                { id: 2, name: 'Gap', fillType: 'void', regionString: '1' },
                { id: 3, name: 'Moderator pin', fillType: 'material', fillId: 2 },
                {
                    id: 4,
                    name: 'Assembly',
                    fillType: 'lattice',
                    fillId: 10,
                    regionString: '2 -4 3 -5',
                    rotation: [0, 0, 30],
                    translation: [1, 2, 0]
                },
                { id: 5, name: 'Outside', fillType: 'void', regionString: '-2 | 4 | -3 | 5' },
                { id: 6, name: 'Outer fill', fillType: 'void' }
            ],
            universes: [
                { id: 0, name: 'root', cellIds: [4, 5] },
                { id: 1, name: 'fuel pin', cellIds: [1, 2] },
                { id: 2, name: 'moderator', cellIds: [3] },
                { id: 3, name: 'outer', cellIds: [6] }
            ],
            lattices: [
                {
                    id: 10,
                    type: 'rect',
                    name: 'Assembly',
                    lowerLeft: [-1, -1, 0],
                    pitch: [1, 1, 1],
                    dimensions: [2, 2, 1],
                    universes: [
                        [
                            [1, 2],
                            [2, 1]
                        ]
                    ],
                    outer: 3
                }
            ],
            rootUniverseId: 0
        },
        materials: [
            {
                id: 1,
                name: 'Fuel',
                density: 10,
                densityUnit: 'g/cm3',
                nuclides: [{ name: 'U235', fraction: 1, fractionType: 'ao' }],
                thermalScattering: []
            },
            {
                id: 2,
                name: 'Water',
                density: 1,
                densityUnit: 'g/cm3',
                nuclides: [{ name: 'H1', fraction: 2, fractionType: 'ao' }],
                thermalScattering: []
            }
        ],
        settings: { run: { mode: 'eigenvalue', particles: 100, inactive: 5, batches: 10 }, sources: [] },
        tallies: [],
        meshes: []
    };
}

/**
 * Build a hexagonal-lattice model.
 * @param orientation - Hexagon orientation.
 * @param nAxial - Number of axial levels (undefined for 2D).
 */
function buildHexState(orientation: 'x' | 'y' = 'y', nAxial?: number): OpenMCState {
    const is3d = nAxial !== undefined && nAxial > 1;
    const rings = [
        [[1, 1, 1, 1, 1, 1], [2]],
        [[2, 2, 2, 2, 2, 2], [1]]
    ];
    return {
        metadata: metadata(),
        geometry: {
            surfaces: [{ id: 1, type: 'z-cylinder', coefficients: { x0: 0, y0: 0, r: 0.5 } }],
            cells: [
                { id: 1, fillType: 'material', fillId: 1, regionString: '-1' },
                { id: 2, fillType: 'material', fillId: 2 },
                { id: 3, fillType: 'lattice', fillId: 20, regionString: '-1', rotation: [0, 0, 15], translation: [0, 0, 0] },
                { id: 4, fillType: 'void' }
            ],
            universes: [
                { id: 0, name: 'root', cellIds: [3] },
                { id: 1, name: 'fuel', cellIds: [1] },
                { id: 2, name: 'moderator', cellIds: [2] },
                { id: 3, name: 'outer', cellIds: [4] }
            ],
            lattices: [
                {
                    id: 20,
                    type: 'hex',
                    name: 'Hex Assembly',
                    rings: 2,
                    ...(orientation === 'x' ? { orientation: 'x' as const } : {}),
                    ...(nAxial !== undefined ? { nAxial } : {}),
                    center: is3d ? [0, 0, 0] : [0, 0],
                    pitch: is3d ? [1, 2] : [1],
                    universes: is3d ? [rings[0], rings[1]] : [rings[0]],
                    outer: 3
                }
            ],
            rootUniverseId: 0
        },
        materials: [
            {
                id: 1,
                name: 'Fuel',
                density: 10,
                densityUnit: 'g/cm3',
                nuclides: [{ name: 'U235', fraction: 1, fractionType: 'ao' }],
                thermalScattering: []
            },
            {
                id: 2,
                name: 'Water',
                density: 1,
                densityUnit: 'g/cm3',
                nuclides: [{ name: 'H1', fraction: 2, fractionType: 'ao' }],
                thermalScattering: []
            }
        ],
        settings: { run: { mode: 'eigenvalue', particles: 100, inactive: 5, batches: 10 }, sources: [] },
        tallies: [],
        meshes: []
    };
}

/** Generate geometry.xml into a directory. */
async function generateGeometry(state: OpenMCState, directory: string): Promise<string> {
    const service = new XMLGenerationService();
    const result = await service.generateXML({
        state,
        outputDirectory: directory,
        files: { materials: false, geometry: true, settings: false, tallies: false, plots: false }
    });
    expect(result.success).toBe(true);
    return fs.readFileSync(path.join(directory, 'geometry.xml'), 'utf-8');
}

/** Import a directory and return the geometry. */
async function importGeometry(directory: string): Promise<OpenMCGeometry> {
    const backend = new OpenMCStudioBackendServiceImpl();
    const imported = await backend.importXML({ directory });
    expect(imported.success).toBe(true);
    expect(imported.state).toBeDefined();
    return imported.state!.geometry;
}

describe('geometry.xml round-trip', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-geometry-roundtrip-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('emits a rectangular lattice with pitch, dimension, lower_left, universes, and outer', async () => {
        const xml = await generateGeometry(buildRectState(), tempDir);
        expect(xml).toContain('<lattice id="10" name="Assembly">');
        expect(xml).toContain('    <pitch>1 1 1</pitch>');
        expect(xml).toContain('    <outer>3</outer>');
        expect(xml).toContain('    <dimension>2 2 1</dimension>');
        expect(xml).toContain('    <lower_left>-1 -1 0</lower_left>');
        expect(xml).toContain('    <universes>');
        expect(xml).toContain('      1 2');
        expect(xml).toContain('      2 1');
        expect(xml).toContain('  </lattice>');
    });

    it('emits cell rotation/translation/density and periodic/albedo surface attributes', async () => {
        const xml = await generateGeometry(buildRectState(), tempDir);
        expect(xml).toContain('density="10.4"');
        expect(xml).toContain('rotation="0 0 30"');
        expect(xml).toContain('translation="1 2 0"');
        expect(xml).toContain('boundary="periodic"');
        expect(xml).toContain('periodic_surface_id="4"');
        expect(xml).toContain('periodic_surface_id="2"');
        expect(xml).toContain('albedo="0.9"');
        // Interior surfaces stay unset (transmission), never boundary="transmission".
        expect(xml).not.toContain('boundary="transmission"');
    });

    it('round-trips the rectangular lattice, transforms, periodic pairs, and albedo', async () => {
        const state = buildRectState();
        await generateGeometry(state, tempDir);
        const imported = await importGeometry(tempDir);

        expect(imported.rootUniverseId).toBe(0);
        expect(imported.lattices).toEqual(state.geometry.lattices);
        expect(imported.surfaces).toEqual(state.geometry.surfaces);
        expect([...imported.cells].sort((a, b) => a.id - b.id)).toEqual([...state.geometry.cells].sort((a, b) => a.id - b.id));

        const universeCellIds = new Map(imported.universes.map((universe) => [universe.id, [...universe.cellIds].sort((a, b) => a - b)]));
        expect(universeCellIds.get(0)).toEqual([4, 5]);
        expect(universeCellIds.get(1)).toEqual([1, 2]);
        expect(universeCellIds.get(2)).toEqual([3]);
        expect(universeCellIds.get(3)).toEqual([6]);

        // Lattice-referenced universes must exist even when they hold no cells.
        expect(imported.universes.map((universe) => universe.id).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);

        const regeneratedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-geometry-regenerated-'));
        try {
            const regenerated = await generateGeometry({ ...state, geometry: imported }, regeneratedDir);
            const original = fs.readFileSync(path.join(tempDir, 'geometry.xml'), 'utf-8');
            expect(regenerated).toBe(original);
        } finally {
            fs.rmSync(regeneratedDir, { recursive: true, force: true });
        }
    });

    it('round-trips a 3D rectangular lattice', async () => {
        const state = buildRectState();
        const lattice = state.geometry.lattices[0];
        if (lattice.type !== 'rect') throw new Error('expected rect lattice');
        lattice.dimensions = [2, 2, 2];
        lattice.lowerLeft = [0, 0, 0];
        lattice.pitch = [1, 1, 1];
        lattice.universes = [
            [
                [1, 2],
                [2, 1]
            ],
            [
                [2, 1],
                [1, 2]
            ]
        ];

        const xml = await generateGeometry(state, tempDir);
        expect(xml).toContain('<dimension>2 2 2</dimension>');
        expect(xml).toContain('      2 1');
        expect(xml).toContain('      1 2');

        const imported = await importGeometry(tempDir);
        expect(imported.lattices).toEqual(state.geometry.lattices);
    });

    it('round-trips a 2D hexagonal lattice in y orientation', async () => {
        const state = buildHexState('y');
        const xml = await generateGeometry(state, tempDir);
        expect(xml).toContain('<hex_lattice id="20" name="Hex Assembly" n_rings="2">');
        expect(xml).toContain('    <pitch>1</pitch>');
        expect(xml).toContain('    <center>0 0</center>');
        expect(xml).not.toContain('orientation="y"');
        expect(xml).not.toContain('n_axial=');
        // OpenMC's y-orientation order for two rings.
        expect(xml).toContain('      1');
        expect(xml).toContain('      1 1');
        expect(xml).toContain('      2');

        const imported = await importGeometry(tempDir);
        expect(imported.lattices).toEqual(state.geometry.lattices);
    });

    it('round-trips a 3D hexagonal lattice in x orientation', async () => {
        const state = buildHexState('x', 2);
        const xml = await generateGeometry(state, tempDir);
        expect(xml).toContain('<hex_lattice id="20" name="Hex Assembly" n_rings="2" orientation="x" n_axial="2">');
        expect(xml).toContain('    <pitch>1 2</pitch>');
        expect(xml).toContain('    <center>0 0 0</center>');

        const imported = await importGeometry(tempDir);
        expect(imported.lattices).toEqual(state.geometry.lattices);
    });

    it('exports with the same universes array as the imported OpenMC-native order', async () => {
        const xml = await generateGeometry(buildHexState('x'), tempDir);
        // Flat order for 2 rings in x orientation, as emitted by OpenMC.
        expect(xml).toContain('      1 1');
        expect(xml).toContain('      1 2 1');
        const imported = await importGeometry(tempDir);
        const lattice = imported.lattices[0];
        expect(lattice.type).toBe('hex');
        if (lattice.type === 'hex') {
            expect(lattice.universes).toEqual([[[1, 1, 1, 1, 1, 1], [2]]]);
        }
    });
});

describe('geometry.xml import', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-geometry-import-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('imports an OpenMC <hex_lattice> with explicit orientation and outer universe', async () => {
        const xml = `<?xml version="1.0"?>
<geometry>
  <cell id="1" fill="10" region="-1 2"/>
  <hex_lattice id="10" name="Docs Hex" n_rings="2" orientation="x" outer="3">
    <pitch>1</pitch>
    <outer>3</outer>
    <center>0 0</center>
    <universes>
      5 6 4 7 1 3 2
    </universes>
  </hex_lattice>
  <surface id="1" type="x-plane" coeffs="-1" boundary="periodic" periodic_surface_id="2" albedo="0.75"/>
  <surface id="2" type="x-plane" coeffs="1" boundary="periodic" periodic_surface_id="1" albedo="0.75"/>
</geometry>`;
        fs.writeFileSync(path.join(tempDir, 'geometry.xml'), xml);

        const imported = await importGeometry(tempDir);
        expect(imported.lattices).toHaveLength(1);
        const lattice = imported.lattices[0];
        expect(lattice.type).toBe('hex');
        if (lattice.type === 'hex') {
            expect(lattice.rings).toBe(2);
            expect(lattice.orientation).toBe('x');
            expect(lattice.outer).toBe(3);
            expect(lattice.universes).toEqual([[[1, 2, 3, 4, 5, 6], [7]]]);
        }
        expect(imported.cells[0].fillType).toBe('lattice');
        expect(imported.surfaces[0]).toMatchObject({ boundary: 'periodic', periodicSurfaceId: 2, albedo: 0.75 });
        expect(imported.universes.map((universe) => universe.id).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it('warns instead of dropping a 9-element rotation matrix', async () => {
        const xml = `<?xml version="1.0"?>
<geometry>
  <cell id="1" material="void" rotation="1 0 0 0 1 0 0 0 1"/>
</geometry>`;
        fs.writeFileSync(path.join(tempDir, 'geometry.xml'), xml);

        const backend = new OpenMCStudioBackendServiceImpl();
        const imported = await backend.importXML({ directory: tempDir });
        expect(imported.success).toBe(true);
        expect(imported.warnings?.some((warning) => warning.includes('9-element rotation matrix'))).toBe(true);
        expect(imported.state!.geometry.cells[0].rotation).toBeUndefined();
    });
});
