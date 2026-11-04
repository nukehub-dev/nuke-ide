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
 * Tests the read-only OpenMC catalog summaries against a fake state manager:
 * no Theia boot, no backend call, and no state mutation.
 */

import { describe, expect, it, vi } from 'vitest';
import { Event } from '@theia/core/lib/common/event';

vi.mock('../openmc-state-manager', () => ({ OpenMCStateManager: class OpenMCStateManager {} }));

import type {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityRegistry,
    NukeCapabilityResult
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { validateCapability, validateCapabilityInput } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import type { DAGMCInfo, OpenMCState } from '../../common/openmc-state-schema';
import type { OpenMCStateManager } from '../openmc-state-manager';
import {
    OpenMCCatalogCapabilities,
    SUMMARIZE_GEOMETRY_CAPABILITY_ID,
    SUMMARIZE_MATERIALS_CAPABILITY_ID,
    SUMMARIZE_TALLIES_CAPABILITY_ID
} from './openmc-catalog-capabilities';

const WORKSPACE = '/workspace';
const NOW = '2026-01-01T00:00:00.000Z';
const DAGMC_FILE = '/workspace/model.h5m';
const CONTEXT: NukeCapabilityContext = { workspaceRoots: [WORKSPACE] };

interface MaterialsData {
    materials: Array<Record<string, unknown>>;
    total: number;
    truncated: boolean;
}

interface TalliesData {
    tallies: Array<Record<string, unknown>>;
    total: number;
    truncated: boolean;
}

interface GeometryData {
    counts: { surfaces: number; cells: number; universes: number; lattices: number; rootUniverse: number };
    surfaces: Array<Record<string, unknown>>;
    cells: Array<Record<string, unknown>>;
    universes: Array<Record<string, unknown>>;
    lattices: Array<Record<string, unknown>>;
    dagmc?: { file: string; volumeCount: number; volumes: Array<Record<string, unknown>> };
    issues: Array<Record<string, unknown>>;
    truncated: boolean;
}

function emptyState(): OpenMCState {
    return {
        metadata: { version: '1.1.0', name: 'Empty', created: NOW, modified: NOW },
        geometry: { surfaces: [], cells: [], universes: [], lattices: [], rootUniverseId: 0 },
        materials: [],
        settings: { run: { mode: 'eigenvalue', particles: 1000, inactive: 10, batches: 50 }, sources: [] },
        tallies: [],
        meshes: []
    };
}

function populatedState(): OpenMCState {
    return {
        metadata: { version: '1.1.0', name: 'Pincell', created: NOW, modified: NOW },
        geometry: {
            surfaces: [
                { id: 1, name: 'Core shell', type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 5 }, boundary: 'vacuum' },
                { id: 2, type: 'z-plane', coefficients: { z0: 10 }, boundary: 'reflective' }
            ],
            cells: [
                { id: 1, name: 'Fuel', fillType: 'material', fillId: 1, materialName: 'UO2', regionString: '-1' },
                {
                    id: 2,
                    name: 'Plenum',
                    fillType: 'void',
                    region: {
                        type: 'operator',
                        operator: 'intersection',
                        children: [
                            { type: 'surface', surfaceId: -2 },
                            { type: 'surface', surfaceId: 1 }
                        ]
                    }
                },
                { id: 3, fillType: 'universe', fillId: 6 },
                { id: 4, name: 'Pin void', fillType: 'void', regionString: '1' }
            ],
            universes: [
                { id: 0, name: 'root', cellIds: [1] },
                { id: 5, name: 'Assembly', cellIds: [2, 3] },
                { id: 6, name: 'Pin', cellIds: [4] }
            ],
            lattices: [
                {
                    id: 20,
                    name: 'Core lattice',
                    type: 'rect',
                    lowerLeft: [0, 0],
                    pitch: [1, 1],
                    dimensions: [1, 1],
                    universes: [[[5]]],
                    outer: 6
                }
            ],
            rootUniverseId: 0
        },
        materials: [
            {
                id: 1,
                name: 'UO2',
                density: 10.4,
                densityUnit: 'g/cm3',
                nuclides: [
                    { name: 'U235', fraction: 1, fractionType: 'ao' },
                    { name: 'O16', fraction: 2, fractionType: 'ao' }
                ],
                thermalScattering: [],
                isDepletable: true,
                volume: 523.6,
                temperature: 900,
                nukeCadMaterialId: 'material-uuid',
                nukeCadParentId: 'parent-uuid'
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
            run: { mode: 'eigenvalue', particles: 1000, inactive: 10, batches: 50 },
            sources: [],
            dagmcFile: undefined
        },
        tallies: [
            {
                id: 1,
                name: 'Fuel flux',
                scores: ['flux', 'fission'],
                estimator: 'tracklength',
                filters: [
                    { type: 'cell', bins: [1, 2] },
                    { type: 'energy', bins: [0.025, 1e6] }
                ],
                nuclides: ['U235'],
                multiplyDensity: false,
                higherMoments: true
            },
            { id: 2, scores: ['total'], nuclides: ['total'], filters: [] }
        ],
        meshes: []
    };
}

function dagmcInfo(volumeCount = 3): DAGMCInfo {
    return {
        filePath: DAGMC_FILE,
        fileName: 'model.h5m',
        volumeCount,
        surfaceCount: 9,
        vertices: 8,
        materials: {
            Water: { volumeCount: 1, totalTriangles: 12 },
            Fuel: { volumeCount: 1, totalTriangles: 24 },
            'mat:graveyard': { volumeCount: 1, totalTriangles: 0 }
        },
        volumes: [
            { id: 1, material: 'Water', numTriangles: 12, boundingBox: { min: [0, 0, 0], max: [1, 1, 1] } },
            { id: 2, material: 'Fuel', numTriangles: 24, boundingBox: { min: [0, 0, 0], max: [1, 1, 1] } },
            { id: 3, material: 'mat:graveyard', numTriangles: 0, boundingBox: { min: [-1, -1, -1], max: [2, 2, 2] } }
        ],
        boundingBox: { min: [-1, -1, -1], max: [2, 2, 2] }
    };
}

function dagmcState(): OpenMCState {
    const state = emptyState();
    state.materials = populatedState().materials;
    state.settings.dagmcFile = DAGMC_FILE;
    state.settings.dagmcInfo = dagmcInfo();
    return state;
}

function cappedState(): OpenMCState {
    const state = emptyState();
    state.geometry.surfaces = Array.from({ length: 101 }, (_, index) => ({
        id: index + 1,
        type: 'z-plane',
        coefficients: { z0: index }
    }));
    state.geometry.universes = [
        { id: 0, name: 'root', cellIds: Array.from({ length: 101 }, (_, index) => index + 1) },
        ...Array.from({ length: 100 }, (_, index) => ({ id: 1000 + index, cellIds: [] }))
    ];
    state.geometry.cells = Array.from({ length: 101 }, (_, index) => ({
        id: index + 1,
        fillType: 'void',
        regionString: `-${index + 1}`
    }));
    state.geometry.lattices = Array.from({ length: 51 }, (_, index) => ({
        id: 2000 + index,
        type: 'rect',
        lowerLeft: [0, 0],
        pitch: [1, 1],
        dimensions: [1, 1],
        universes: [[[1000]]]
    }));
    state.materials = Array.from({ length: 201 }, (_, index) => ({
        id: index + 1,
        name: `Material ${index + 1}`,
        density: 1,
        densityUnit: 'g/cm3',
        nuclides: [],
        thermalScattering: []
    }));
    state.tallies = Array.from({ length: 201 }, (_, index) => ({
        id: index + 1,
        scores: ['total'],
        nuclides: ['total'],
        filters: []
    }));
    const info = dagmcInfo(101);
    info.volumes = Array.from({ length: 101 }, (_, index) => ({
        id: index + 1,
        material: 'Water',
        numTriangles: index,
        boundingBox: { min: [0, 0, 0], max: [1, 1, 1] }
    }));
    state.settings.dagmcFile = DAGMC_FILE;
    state.settings.dagmcInfo = info;
    return state;
}

function invalidReferenceState(): OpenMCState {
    const state = emptyState();
    state.geometry.surfaces = [{ id: 1, type: 'x-plane', coefficients: { x0: 0 }, boundary: 'periodic', periodicSurfaceId: 2 }];
    state.geometry.cells = [{ id: 1, fillType: 'universe', fillId: 99, regionString: '-1' }];
    state.geometry.universes = [{ id: 0, name: 'root', cellIds: [1] }];
    return state;
}

function manyInvalidCellsState(): OpenMCState {
    const state = emptyState();
    state.geometry.cells = Array.from({ length: 25 }, (_, index) => ({
        id: index + 1,
        fillType: 'universe',
        fillId: 999
    }));
    state.geometry.universes = [{ id: 0, name: 'root', cellIds: Array.from({ length: 25 }, (_, index) => index + 1) }];
    return state;
}

class FakeStateManager {
    reads = 0;

    constructor(protected readonly state: OpenMCState) {}

    getState(): OpenMCState {
        this.reads += 1;
        return JSON.parse(JSON.stringify(this.state)) as OpenMCState;
    }
}

class FakeRegistry implements NukeCapabilityRegistry {
    readonly capabilities = new Map<string, NukeCapability>();
    readonly onDidChange = Event.None;
    readonly ready = Promise.resolve();

    register(capability: NukeCapability): void {
        this.capabilities.set(capability.id, capability);
    }

    get(id: string): NukeCapability | undefined {
        return this.capabilities.get(id);
    }

    getAll(): readonly NukeCapability[] {
        return [...this.capabilities.values()];
    }

    getEnabled(context: NukeCapabilityContext): readonly NukeCapability[] {
        return this.getAll().filter((capability) => !capability.when || capability.when(context));
    }
}

interface Harness {
    stateManager: FakeStateManager;
    registry: FakeRegistry;
    capabilities: OpenMCCatalogCapabilities;
    invoke(id: string, input: unknown): Promise<NukeCapabilityResult>;
}

function createHarness(state: OpenMCState): Harness {
    const stateManager = new FakeStateManager(state);
    const registry = new FakeRegistry();
    const capabilities = new OpenMCCatalogCapabilities(stateManager as unknown as OpenMCStateManager);
    capabilities.registerCapabilities(registry);
    return {
        stateManager,
        registry,
        capabilities,
        invoke: (id, input) => {
            const capability = registry.get(id);
            if (!capability) {
                throw new Error(`Missing capability ${id}`);
            }
            return capability.invoke(input, CONTEXT);
        }
    };
}

describe('OpenMC catalog capabilities', () => {
    it('returns zero counts and no rows for an empty project', async () => {
        const harness = createHarness(emptyState());

        expect(await harness.invoke(SUMMARIZE_MATERIALS_CAPABILITY_ID, {})).toEqual({
            ok: true,
            data: { materials: [], total: 0, truncated: false }
        });
        expect(await harness.invoke(SUMMARIZE_TALLIES_CAPABILITY_ID, {})).toEqual({
            ok: true,
            data: { tallies: [], total: 0, truncated: false }
        });

        const geometry = await harness.invoke(SUMMARIZE_GEOMETRY_CAPABILITY_ID, {});
        expect(geometry.ok).toBe(true);
        const data = geometry.data as GeometryData;
        expect(data.counts).toEqual({ surfaces: 0, cells: 0, universes: 0, lattices: 0, rootUniverse: 0 });
        expect(data.surfaces).toEqual([]);
        expect(data.cells).toEqual([]);
        expect(data.universes).toEqual([]);
        expect(data.lattices).toEqual([]);
        expect(data.truncated).toBe(false);
    });

    it('summarizes materials without returning the nuclide list', async () => {
        const harness = createHarness(populatedState());

        const result = await harness.invoke(SUMMARIZE_MATERIALS_CAPABILITY_ID, {});
        expect(result.ok).toBe(true);
        const data = result.data as MaterialsData;
        expect(data.total).toBe(2);
        expect(data.truncated).toBe(false);
        expect(data.materials).toEqual([
            {
                id: 1,
                name: 'UO2',
                density: 10.4,
                densityUnit: 'g/cm3',
                nuclideCount: 2,
                isDepletable: true,
                volume: 523.6,
                nukeCadMaterialId: 'material-uuid',
                nukeCadParentId: 'parent-uuid',
                temperature: 900
            },
            {
                id: 2,
                name: 'Water',
                density: 1,
                densityUnit: 'g/cm3',
                nuclideCount: 1,
                isDepletable: false
            }
        ]);
        expect(data.materials[0]).not.toHaveProperty('nuclides');
        expect(JSON.stringify(data)).not.toContain('fractionType');
        expect(JSON.stringify(data)).not.toContain('"nuclides"');
    });

    it('summarizes tallies with their ids, scores, and filter bins', async () => {
        const harness = createHarness(populatedState());

        const result = await harness.invoke(SUMMARIZE_TALLIES_CAPABILITY_ID, {});
        expect(result.ok).toBe(true);
        const data = result.data as TalliesData;
        expect(data.total).toBe(2);
        expect(data.truncated).toBe(false);
        expect(data.tallies).toEqual([
            {
                id: 1,
                name: 'Fuel flux',
                scores: ['flux', 'fission'],
                estimator: 'tracklength',
                filterCount: 2,
                filters: [
                    { type: 'cell', bins: [1, 2], binCount: 2 },
                    { type: 'energy', bins: [0.025, 1e6], binCount: 2 }
                ],
                nuclides: ['U235'],
                multiplyDensity: false,
                higherMoments: true
            },
            {
                id: 2,
                scores: ['total'],
                filterCount: 0,
                filters: [],
                nuclides: ['total']
            }
        ]);
    });

    it('samples long tally filter bin lists and marks the summary truncated', async () => {
        const state = emptyState();
        state.tallies = [
            {
                id: 1,
                scores: ['flux'],
                nuclides: ['total'],
                filters: [{ type: 'energy', bins: Array.from({ length: 25 }, (_, index) => index + 1) }]
            }
        ];
        const harness = createHarness(state);

        const result = await harness.invoke(SUMMARIZE_TALLIES_CAPABILITY_ID, {});
        const data = result.data as TalliesData;
        expect(data.total).toBe(1);
        expect(data.truncated).toBe(true);
        const filters = data.tallies[0].filters as Array<{ type: string; bins: number[]; binCount: number }>;
        expect(filters[0]).toEqual({
            type: 'energy',
            bins: Array.from({ length: 20 }, (_, index) => index + 1),
            binCount: 25
        });
    });

    it('summarizes surface, cell, universe, and lattice ids', async () => {
        const harness = createHarness(populatedState());

        const result = await harness.invoke(SUMMARIZE_GEOMETRY_CAPABILITY_ID, {});
        expect(result.ok).toBe(true);
        const data = result.data as GeometryData;
        expect(data.counts).toEqual({ surfaces: 2, cells: 4, universes: 3, lattices: 1, rootUniverse: 0 });
        expect(data.surfaces).toEqual([
            {
                id: 1,
                name: 'Core shell',
                type: 'sphere',
                summary: 'center=(0, 0, 0) r=5 boundary=vacuum'
            },
            { id: 2, type: 'z-plane', summary: 'z0=10 boundary=reflective' }
        ]);
        expect(data.cells).toEqual([
            { id: 1, name: 'Fuel', fillType: 'material', fillId: 1, materialName: 'UO2', regionSummary: '-1' },
            { id: 2, name: 'Plenum', fillType: 'void', regionSummary: '-2 +1' },
            { id: 3, fillType: 'universe', fillId: 6, regionSummary: 'unbounded' },
            { id: 4, name: 'Pin void', fillType: 'void', regionSummary: '1' }
        ]);
        expect(data.universes).toEqual([
            { id: 0, name: 'root', cellCount: 1 },
            { id: 5, name: 'Assembly', cellCount: 2 },
            { id: 6, name: 'Pin', cellCount: 1 }
        ]);
        expect(data.lattices).toEqual([{ id: 20, name: 'Core lattice', type: 'rect', universeCount: 1 }]);
        expect(data.issues).toEqual([]);
        expect(data.truncated).toBe(false);
        expect('dagmc' in data).toBe(false);
    });

    it('reports DAGMC volumes and omits them when includeDagmc is false', async () => {
        const harness = createHarness(dagmcState());

        const withDagmc = await harness.invoke(SUMMARIZE_GEOMETRY_CAPABILITY_ID, {});
        const included = withDagmc.data as GeometryData;
        expect(included.dagmc).toEqual({
            file: DAGMC_FILE,
            volumeCount: 3,
            volumes: [
                { id: 1, material: 'Water', numTriangles: 12 },
                { id: 2, material: 'Fuel', numTriangles: 24 },
                { id: 3, material: 'mat:graveyard', numTriangles: 0 }
            ]
        });

        const withoutDagmc = await harness.invoke(SUMMARIZE_GEOMETRY_CAPABILITY_ID, { includeDagmc: false });
        expect('dagmc' in (withoutDagmc.data as GeometryData)).toBe(false);
    });

    it('caps every geometry list and reports truncation', async () => {
        const harness = createHarness(cappedState());

        const result = await harness.invoke(SUMMARIZE_GEOMETRY_CAPABILITY_ID, {});
        const data = result.data as GeometryData;
        expect(data.counts).toEqual({ surfaces: 101, cells: 101, universes: 101, lattices: 51, rootUniverse: 0 });
        expect(data.surfaces).toHaveLength(100);
        expect(data.cells).toHaveLength(100);
        expect(data.universes).toHaveLength(100);
        expect(data.lattices).toHaveLength(50);
        expect(data.dagmc?.volumes).toHaveLength(100);
        expect(data.dagmc?.volumeCount).toBe(101);
        expect(data.truncated).toBe(true);
    });

    it('caps material and tally rows and reports truncation', async () => {
        const harness = createHarness(cappedState());

        const materials = (await harness.invoke(SUMMARIZE_MATERIALS_CAPABILITY_ID, {})).data as MaterialsData;
        expect(materials.total).toBe(201);
        expect(materials.materials).toHaveLength(200);
        expect(materials.truncated).toBe(true);

        const tallies = (await harness.invoke(SUMMARIZE_TALLIES_CAPABILITY_ID, {})).data as TalliesData;
        expect(tallies.total).toBe(201);
        expect(tallies.tallies).toHaveLength(200);
        expect(tallies.truncated).toBe(true);
    });

    it('reports invalid geometry references with their state paths', async () => {
        const harness = createHarness(invalidReferenceState());

        const result = await harness.invoke(SUMMARIZE_GEOMETRY_CAPABILITY_ID, {});
        const data = result.data as GeometryData;
        expect(data.issues).toContainEqual({
            severity: 'error',
            message: 'Cell #1 fills universe #99 which does not exist'
        });
        expect(data.issues).toContainEqual({
            severity: 'error',
            path: 'geometry.surfaces.1',
            message: 'Surface #1: periodic partner #2 does not exist'
        });
        expect(data.truncated).toBe(false);
    });

    it('caps geometry issues at 20 findings', async () => {
        const harness = createHarness(manyInvalidCellsState());

        const result = await harness.invoke(SUMMARIZE_GEOMETRY_CAPABILITY_ID, {});
        const data = result.data as GeometryData;
        expect(data.issues).toHaveLength(20);
        expect(data.truncated).toBe(true);
        expect(data.issues.every((issue) => issue.severity === 'error')).toBe(true);
    });

    it('reads only from the injected state manager and never mutates state', async () => {
        const state = populatedState();
        const snapshot = JSON.stringify(state);
        const harness = createHarness(state);

        expect('backendService' in harness.capabilities).toBe(false);
        await harness.invoke(SUMMARIZE_MATERIALS_CAPABILITY_ID, {});
        await harness.invoke(SUMMARIZE_TALLIES_CAPABILITY_ID, {});
        await harness.invoke(SUMMARIZE_GEOMETRY_CAPABILITY_ID, {});
        await harness.invoke(SUMMARIZE_GEOMETRY_CAPABILITY_ID, { includeDagmc: false });

        expect(harness.stateManager.reads).toBe(4);
        expect(JSON.stringify(state)).toBe(snapshot);
    });

    it('declares three read-only capabilities with precise ids, examples, and annotations', () => {
        const harness = createHarness(populatedState());

        expect([...harness.registry.capabilities.keys()].sort()).toEqual([
            SUMMARIZE_GEOMETRY_CAPABILITY_ID,
            SUMMARIZE_MATERIALS_CAPABILITY_ID,
            SUMMARIZE_TALLIES_CAPABILITY_ID
        ]);

        for (const capability of harness.registry.getAll()) {
            expect(validateCapability(capability)).toEqual([]);
            expect(capability.risk).toBe('read');
            expect(capability.requiresConfirmation).toBeUndefined();
            expect(capability.undoable).toBeUndefined();
            expect(capability.annotations).toEqual({
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            });
            expect(capability.when!(CONTEXT)).toBe(true);
            expect(capability.examples?.length).toBeGreaterThanOrEqual(1);
            expect(capability.description.toLowerCase()).toContain('read-only');
        }

        const geometry = harness.registry.get(SUMMARIZE_GEOMETRY_CAPABILITY_ID)!;
        expect(validateCapabilityInput(geometry, {})).toEqual([]);
        expect(validateCapabilityInput(geometry, { includeDagmc: false })).toEqual([]);
        expect(validateCapabilityInput(geometry, { includeDagmc: 'no' })).not.toEqual([]);
        expect(geometry.inputSchema.properties.includeDagmc).toMatchObject({ type: 'boolean', default: true });
    });
});
