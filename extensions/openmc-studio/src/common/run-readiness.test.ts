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
 * Tests for the run-readiness predicates (src/common/run-readiness.ts).
 */

import { describe, it, expect } from 'vitest';

import { computeSetupChecklist, computeReadiness, computeMaterialsItem } from './run-readiness';
import { OpenMCState } from './openmc-state-schema';

/** Build a minimal state; only the fields the predicates read are populated. */
function buildState(overrides: Partial<OpenMCState> = {}): OpenMCState {
    const now = new Date().toISOString();
    const base: OpenMCState = {
        metadata: { version: '1.1.0', name: 'test', created: now, modified: now },
        geometry: { surfaces: [], cells: [], universes: [], lattices: [], rootUniverseId: 0 },
        materials: [],
        settings: {
            run: { mode: 'eigenvalue', particles: 1000, inactive: 10, batches: 100 },
            sources: []
        },
        tallies: [],
        meshes: []
    };
    return { ...base, ...overrides, settings: { ...base.settings, ...overrides.settings } };
}

const material = { id: 1, name: 'Water', density: 1, densityUnit: 'g/cm3' as const, nuclides: [], thermalScattering: [] };
const cell = { id: 1, fillType: 'material' as const, fillId: 1 };
const source = {
    spatial: { type: 'point' as const, origin: [0, 0, 0] as [number, number, number] },
    energy: { type: 'discrete' as const, energies: [1e6] }
};

describe('computeSetupChecklist', () => {
    it('marks required items missing on an empty CSG model', () => {
        const items = computeSetupChecklist(buildState());
        const byId = Object.fromEntries(items.map((i) => [i.id, i]));
        expect(byId['materials'].status).toBe('missing');
        expect(byId['geometry'].status).toBe('missing');
        expect(byId['source'].status).toBe('missing');
        expect(byId['tallies'].status).toBe('optional');
        expect(byId['depletion'].status).toBe('optional');
        expect(byId['variance-reduction'].status).toBe('optional');
        expect(items).toHaveLength(6);
    });

    it('marks a configured model done', () => {
        const items = computeSetupChecklist(
            buildState({
                materials: [material],
                geometry: { surfaces: [], cells: [cell], universes: [], lattices: [], rootUniverseId: 0 },
                settings: { run: { mode: 'eigenvalue', particles: 1, inactive: 1, batches: 1 }, sources: [source] }
            })
        );
        expect(items.every((i) => i.status === 'done' || i.status === 'optional')).toBe(true);
    });

    it('adds a kinetics item only when IFP is enabled', () => {
        const without = computeSetupChecklist(buildState());
        expect(without.find((i) => i.id === 'kinetics')).toBeUndefined();

        const ok = computeSetupChecklist(
            buildState({
                settings: {
                    run: { mode: 'eigenvalue', particles: 1, inactive: 10, batches: 100 },
                    sources: [],
                    kinetics: { enabled: true, ifpNGenerations: 4 }
                }
            })
        );
        expect(ok.find((i) => i.id === 'kinetics')?.status).toBe('done');

        const bad = computeSetupChecklist(
            buildState({
                settings: {
                    run: { mode: 'eigenvalue', particles: 1, inactive: 2, batches: 100 },
                    sources: [],
                    kinetics: { enabled: true, ifpNGenerations: 4 }
                }
            })
        );
        expect(bad.find((i) => i.id === 'kinetics')?.status).toBe('partial');
    });

    it('adds an MGXS item only in multi-group mode', () => {
        const ce = computeSetupChecklist(buildState());
        expect(ce.find((i) => i.id === 'mgxs-library')).toBeUndefined();

        const mg = computeSetupChecklist(
            buildState({
                settings: { run: { mode: 'eigenvalue', particles: 1, inactive: 1, batches: 1 }, sources: [], energyMode: 'multigroup' }
            })
        );
        expect(mg.find((i) => i.id === 'mgxs-library')?.status).toBe('missing');

        const mgSet = computeSetupChecklist(
            buildState({
                settings: {
                    run: { mode: 'eigenvalue', particles: 1, inactive: 1, batches: 1 },
                    sources: [],
                    energyMode: 'multigroup',
                    mgxsLibrary: '/data/mgxs.h5'
                }
            })
        );
        expect(mgSet.find((i) => i.id === 'mgxs-library')?.status).toBe('done');
    });
});

describe('computeMaterialsItem (DAGMC-aware)', () => {
    it('requires matching OpenMC materials for every DAGMC material', () => {
        const state = buildState({
            materials: [material],
            settings: {
                run: { mode: 'eigenvalue', particles: 1, inactive: 1, batches: 1 },
                sources: [],
                dagmcFile: '/data/geom.h5m',
                dagmcInfo: {
                    filePath: '/data/geom.h5m',
                    fileName: 'geom.h5m',
                    volumeCount: 2,
                    surfaceCount: 2,
                    vertices: 10,
                    materials: { Water: { volumeCount: 1, totalTriangles: 4 }, Fuel: { volumeCount: 1, totalTriangles: 4 } },
                    volumes: [],
                    boundingBox: { min: [0, 0, 0], max: [1, 1, 1] }
                }
            }
        });
        expect(computeMaterialsItem(state).status).toBe('partial');

        const full = buildState({
            materials: [material, { ...material, id: 2, name: 'Fuel' }],
            settings: { ...state.settings }
        });
        expect(computeMaterialsItem(full).status).toBe('done');
    });
});

describe('computeReadiness', () => {
    it('is not ready with missing required items listed', () => {
        const result = computeReadiness(buildState());
        expect(result.ready).toBe(false);
        expect(result.missing).toEqual(['Materials', 'Geometry', 'Source']);
    });

    it('is ready with materials, geometry, and source', () => {
        const result = computeReadiness(
            buildState({
                materials: [material],
                geometry: { surfaces: [], cells: [cell], universes: [], lattices: [], rootUniverseId: 0 },
                settings: { run: { mode: 'eigenvalue', particles: 1, inactive: 1, batches: 1 }, sources: [source] }
            })
        );
        expect(result.ready).toBe(true);
        expect(result.missing).toEqual([]);
    });

    it('counts DAGMC geometry as geometry', () => {
        const result = computeReadiness(
            buildState({
                materials: [material],
                settings: {
                    run: { mode: 'eigenvalue', particles: 1, inactive: 1, batches: 1 },
                    sources: [source],
                    dagmcFile: '/data/geom.h5m'
                }
            })
        );
        expect(result.ready).toBe(true);
    });

    it('requires the MGXS library in multi-group mode', () => {
        const result = computeReadiness(
            buildState({
                materials: [material],
                geometry: { surfaces: [], cells: [cell], universes: [], lattices: [], rootUniverseId: 0 },
                settings: {
                    run: { mode: 'eigenvalue', particles: 1, inactive: 1, batches: 1 },
                    sources: [source],
                    energyMode: 'multigroup'
                }
            })
        );
        expect(result.ready).toBe(false);
        expect(result.missing).toEqual(['MGXS Library']);
    });
});
