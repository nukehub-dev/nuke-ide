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
 * Tally-filter e2e against a real OpenMC install.
 *
 * Builds a 2×2 lattice assembly with a cell-instance tally, a mesh-material
 * tally, and a mesh-born tally, generates tallies.xml from the state, runs the
 * OpenMC binary, and inspects the statepoint filter bins. The 0.16-only
 * reaction/particle-production path is opt-in with
 * `NUKE_E2E_TALLY_FILTERS_016=1` so a 0.15.3 binary can run the main suite.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { XMLGenerationService } from '../xml-generation-service';
import { DEFAULT_OPENMC_COMPAT } from '../../common/openmc-studio-protocol';
import { OpenMCState } from '../../common/openmc-state-schema';
import { NEUTRON_PARTICLE } from '../../common/particle-types';

const PYTHON = process.env.NUKE_TEST_PYTHON;
const OPENMC_EXE = PYTHON ? path.join(path.dirname(PYTHON), 'openmc') : undefined;
const CROSS_SECTIONS = process.env.OPENMC_CROSS_SECTIONS;
const CAN_RUN = !!(PYTHON && OPENMC_EXE && fs.existsSync(OPENMC_EXE) && CROSS_SECTIONS && fs.existsSync(CROSS_SECTIONS));
const RUN_016_FILTERS = process.env.NUKE_E2E_TALLY_FILTERS_016 === '1';
const RUN_TIMEOUT = 180_000;

function metadata(): OpenMCState['metadata'] {
    const now = new Date().toISOString();
    return { version: '1.2.0', name: 'Tally Filters E2E', created: now, modified: now };
}

/** 2×2 lattice with a fuel cell that appears twice and a coolant cell. */
function buildLatticeState(): OpenMCState {
    return {
        metadata: metadata(),
        geometry: {
            surfaces: [
                { id: 1, type: 'z-cylinder', coefficients: { x0: 0, y0: 0, r: 0.4 } },
                { id: 2, type: 'x-plane', coefficients: { x0: -1 }, boundary: 'reflective' },
                { id: 3, type: 'y-plane', coefficients: { y0: -1 }, boundary: 'reflective' },
                { id: 4, type: 'x-plane', coefficients: { x0: 1 }, boundary: 'reflective' },
                { id: 5, type: 'y-plane', coefficients: { y0: 1 }, boundary: 'reflective' },
                { id: 6, type: 'z-plane', coefficients: { z0: -10 }, boundary: 'vacuum' },
                { id: 7, type: 'z-plane', coefficients: { z0: 10 }, boundary: 'vacuum' }
            ],
            cells: [
                { id: 1, name: 'Fuel', fillType: 'material', fillId: 1, regionString: '-1', density: 10.4 },
                { id: 2, name: 'Gap', fillType: 'void', regionString: '1' },
                { id: 3, name: 'Coolant', fillType: 'material', fillId: 2 },
                {
                    id: 4,
                    name: 'Assembly',
                    fillType: 'lattice',
                    fillId: 10,
                    regionString: '2 -4 3 -5 6 -7'
                },
                { id: 5, name: 'Outer', fillType: 'void' }
            ],
            universes: [
                { id: 0, name: 'root', cellIds: [4] },
                { id: 1, name: 'fuel pin', cellIds: [1, 2] },
                { id: 2, name: 'coolant', cellIds: [3] },
                { id: 3, name: 'outer', cellIds: [5] }
            ],
            lattices: [
                {
                    id: 10,
                    type: 'rect',
                    name: 'Assembly',
                    lowerLeft: [-1, -1, -10],
                    pitch: [1, 1, 20],
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
        settings: {
            run: { mode: 'eigenvalue', particles: 80, inactive: 3, batches: 8 },
            sources: []
        },
        tallies: [
            {
                id: 1,
                name: 'Cell instances',
                scores: ['flux'],
                nuclides: ['total'],
                filters: [
                    {
                        type: 'cellinstance',
                        bins: [1, 0, 1, 1],
                        pairs: [
                            { first: 1, second: 0 },
                            { first: 1, second: 1 }
                        ]
                    }
                ]
            },
            {
                id: 2,
                name: 'Mesh materials',
                scores: ['flux'],
                nuclides: ['total'],
                filters: [
                    {
                        type: 'meshmaterial',
                        bins: [0, 1, 1, 1, 2, 2, 3, 2],
                        pairs: [
                            { first: 0, second: 1 },
                            { first: 1, second: 1 },
                            { first: 2, second: 2 },
                            { first: 3, second: 2 }
                        ],
                        meshId: 1
                    }
                ]
            },
            {
                id: 3,
                name: 'Mesh birth',
                scores: ['flux'],
                nuclides: ['total'],
                filters: [{ type: 'meshborn', bins: [1], meshId: 1 }]
            }
        ],
        meshes: [{ type: 'regular', id: 1, lowerLeft: [-1, -1, -10], upperRight: [1, 1, 10], dimension: [2, 2, 1] }],
        plots: []
    };
}

interface StatepointTally {
    id: number;
    filters: string[];
    bins: unknown[];
    meanSum: number;
}

/** Read tally filter types and bins from the newest statepoint. */
function readStatepoint(dir: string): StatepointTally[] {
    const script = [
        'import glob, json, openmc',
        'sp_path = sorted(glob.glob("statepoint*.h5"))[-1]',
        'with openmc.StatePoint(sp_path) as sp:',
        '    out = []',
        '    for tally in sp.tallies.values():',
        '        out.append({',
        '            "id": tally.id,',
        '            "filters": [type(f).__name__ for f in tally.filters],',
        '            "bins": [f.bins.tolist() if hasattr(f.bins, "tolist") else f.bins for f in tally.filters],',
        '            "meanSum": float(tally.mean.sum()),',
        '        })',
        '    print(json.dumps(out, default=lambda value: value.item() if hasattr(value, "item") else str(value)))'
    ].join('\n');
    const proc = spawnSync(PYTHON!, ['-c', script], {
        cwd: dir,
        env: { ...process.env, OPENMC_CROSS_SECTIONS: CROSS_SECTIONS },
        timeout: 60_000,
        encoding: 'utf-8'
    });
    expect(proc.status, `statepoint read failed:\n${proc.stdout}\n${proc.stderr}`).toBe(0);
    return JSON.parse(proc.stdout.trim()) as StatepointTally[];
}

/** Generate XML, run the OpenMC binary, and return the run directory. */
async function generateAndRun(state: OpenMCState, dir: string, compat = DEFAULT_OPENMC_COMPAT): Promise<string> {
    const generator = new XMLGenerationService();
    const result = await generator.generateXML({
        state,
        outputDirectory: dir,
        files: { materials: true, geometry: true, settings: true, tallies: true, plots: false },
        randomRayCompat: compat
    });
    expect(result.success).toBe(true);
    expect((result.warnings ?? []).filter((warning) => /filter|mesh|tally/i.test(warning))).toEqual([]);

    const proc = spawnSync(OPENMC_EXE!, [], {
        cwd: dir,
        env: { ...process.env, OPENMC_CROSS_SECTIONS: CROSS_SECTIONS },
        timeout: RUN_TIMEOUT,
        encoding: 'utf-8'
    });
    expect(proc.status, `openmc failed:\n${proc.stdout}\n${proc.stderr}`).toBe(0);
    expect(proc.stdout).not.toMatch(/lost particle/i);
    return `${proc.stdout}\n${proc.stderr}`;
}

describe('tally filters e2e (real OpenMC)', () => {
    let tempDirs: string[] = [];

    beforeAll(() => {
        tempDirs = [];
    });

    afterAll(() => {
        for (const dir of tempDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it.skipIf(!CAN_RUN)(
        'cell-instance in a lattice and mesh-based filters run and reach the statepoint',
        async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-tally-filters-'));
            tempDirs.push(dir);
            await generateAndRun(buildLatticeState(), dir);

            const tallies = readStatepoint(dir);
            const cellInstance = tallies.find((tally) => tally.id === 1);
            const meshMaterial = tallies.find((tally) => tally.id === 2);
            const meshBorn = tallies.find((tally) => tally.id === 3);

            expect(cellInstance?.filters).toEqual(['CellInstanceFilter']);
            expect(cellInstance?.bins[0]).toEqual([
                [1, 0],
                [1, 1]
            ]);
            expect(cellInstance!.meanSum).toBeGreaterThan(0);

            expect(meshMaterial?.filters).toEqual(['MeshMaterialFilter']);
            expect(meshMaterial?.bins[0]).toEqual([
                [0, 1],
                [1, 1],
                [2, 2],
                [3, 2]
            ]);

            expect(meshBorn?.filters).toEqual(['MeshBornFilter']);
            // The statepoint stores one mesh-index bin per element, not the mesh ID.
            expect(meshBorn?.bins[0]).toHaveLength(4);
            expect(meshBorn?.bins[0]).toContainEqual([1, 1, 1]);
        },
        RUN_TIMEOUT * 2
    );

    it.skipIf(!CAN_RUN || !RUN_016_FILTERS)(
        'reaction and particle-production filters run on OpenMC 0.16',
        async () => {
            const state = buildLatticeState();
            state.settings.photonTransport = true;
            state.tallies = [
                {
                    id: 1,
                    name: 'Radiative capture',
                    scores: ['flux'],
                    nuclides: ['total'],
                    filters: [{ type: 'reaction', bins: [], reactionBins: ['(n,gamma)'] }]
                },
                {
                    id: 2,
                    name: 'Secondary neutrons',
                    scores: ['events'],
                    nuclides: ['total'],
                    filters: [
                        {
                            type: 'particleproduction',
                            bins: [],
                            particleTypes: [NEUTRON_PARTICLE],
                            productionEnergyBins: [0, 1e5, 2e7]
                        }
                    ]
                }
            ];

            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-tally-filters-016-'));
            tempDirs.push(dir);
            await generateAndRun(state, dir, {
                ...DEFAULT_OPENMC_COMPAT,
                reactionFilter: true,
                particleProductionFilter: true
            });

            const tallies = readStatepoint(dir);
            expect(tallies.find((tally) => tally.id === 1)?.filters).toEqual(['ReactionFilter']);
            expect(tallies.find((tally) => tally.id === 2)?.filters).toEqual(['ParticleProductionFilter']);
        },
        RUN_TIMEOUT * 2
    );
});
