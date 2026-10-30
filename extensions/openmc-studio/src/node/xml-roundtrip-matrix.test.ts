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
 * Semantic XML round-trip matrix.
 *
 * Each case builds a state exercising one feature area, generates the XML set,
 * imports it back, and asserts semantic equality for the fields that feature
 * owns. This is intentionally one parameterized matrix rather than a pile of
 * ad-hoc per-field tests; existing focused tests still cover error paths.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { XMLGenerationService } from './xml-generation-service';
import { OpenMCStudioBackendServiceImpl } from './openmc-studio-backend-service';
import { DEFAULT_OPENMC_COMPAT } from '../common/openmc-studio-protocol';
import { OPENMC_STATE_SCHEMA_VERSION, OpenMCState } from '../common/openmc-state-schema';
import { NEUTRON_PARTICLE, PHOTON_PARTICLE } from '../common/particle-types';

const FULL_COMPAT = {
    ...DEFAULT_OPENMC_COMPAT,
    raySourceFormat: 'wrapper' as const,
    adjointSource: true,
    tokamakSource: true,
    decaySpectrum: true,
    s2SampleMethod: true,
    depletionSubsteps: true,
    depletionKeffSearch: true,
    depletionExternalSourceRate: true,
    depletionContinuation: true,
    sharedSecondaryBank: true,
    surfaceGrazing: true,
    meshFilterRotation: true,
    sourceBias: true,
    reactionFilter: true,
    particleProductionFilter: true
};

/** Base state for feature cases: a sphere cell in vacuum with two materials. */
function baseState(): OpenMCState {
    const now = new Date().toISOString();
    return {
        metadata: {
            version: OPENMC_STATE_SCHEMA_VERSION,
            name: 'Round-trip matrix',
            created: now,
            modified: now
        },
        geometry: {
            surfaces: [{ id: 1, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 10 }, boundary: 'vacuum' }],
            cells: [
                { id: 1, name: 'Fuel', fillType: 'material', fillId: 1, regionString: '-1' },
                { id: 2, name: 'Moderator', fillType: 'material', fillId: 2, regionString: '+1' }
            ],
            universes: [{ id: 0, name: 'root', cellIds: [1, 2] }],
            lattices: [],
            rootUniverseId: 0
        },
        materials: [
            {
                id: 1,
                name: 'Fuel',
                density: 10.4,
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
            run: { mode: 'eigenvalue', particles: 100, inactive: 2, batches: 5 },
            sources: []
        },
        tallies: [],
        meshes: []
    };
}

/** One round-trip case: state plus feature-specific equality assertions. */
interface MatrixCase {
    name: string;
    state: OpenMCState;
    includePlots?: boolean;
    verify(imported: OpenMCState): void;
}

let tempRoot: string;

/** Generate XML from a case state and import it back. */
async function roundTrip(state: OpenMCState, includePlots = false): Promise<OpenMCState> {
    const directory = fs.mkdtempSync(path.join(tempRoot, 'case-'));
    const generation = new XMLGenerationService();
    const generated = await generation.generateXML({
        state,
        outputDirectory: directory,
        randomRayCompat: FULL_COMPAT,
        files: { materials: true, geometry: true, settings: true, tallies: true, plots: includePlots }
    });
    expect(generated.success, generated.error).toBe(true);

    const backend = new OpenMCStudioBackendServiceImpl();
    const imported = await backend.importXML({
        directory,
        options: { mergeStrategy: 'replace', validate: true }
    });
    expect(imported.success, imported.errors.join('; ')).toBe(true);
    expect(imported.state).toBeDefined();
    return imported.state!;
}

/** Rectangular lattice with periodic pairs, albedo, and cell transforms. */
function rectangularGeometryCase(): OpenMCState {
    const state = baseState();
    state.geometry = {
        surfaces: [
            { id: 1, type: 'z-cylinder', coefficients: { x0: 0, y0: 0, r: 0.4 } },
            { id: 2, type: 'x-plane', coefficients: { x0: -0.5 }, boundary: 'periodic', periodicSurfaceId: 3, albedo: 0.8 },
            { id: 3, type: 'x-plane', coefficients: { x0: 0.5 }, boundary: 'periodic', periodicSurfaceId: 2, albedo: 0.8 },
            { id: 4, type: 'y-plane', coefficients: { y0: -0.5 }, boundary: 'periodic', periodicSurfaceId: 5, albedo: 0.9 },
            { id: 5, type: 'y-plane', coefficients: { y0: 0.5 }, boundary: 'periodic', periodicSurfaceId: 4, albedo: 0.9 },
            { id: 6, type: 'z-plane', coefficients: { z0: -5 }, boundary: 'vacuum' },
            { id: 7, type: 'z-plane', coefficients: { z0: 5 }, boundary: 'vacuum' }
        ],
        cells: [
            {
                id: 1,
                name: 'Fuel',
                fillType: 'material',
                fillId: 1,
                regionString: '-1 +4 -5 +6 -7',
                density: 10.4,
                volume: 12.5
            },
            { id: 2, name: 'Moderator', fillType: 'material', fillId: 2, regionString: '+1 +2 -3 +4 -5 +6 -7' },
            {
                id: 3,
                name: 'Assembly',
                fillType: 'lattice',
                fillId: 10,
                regionString: '+2 -3 +4 -5 +6 -7',
                rotation: [0, 0, 30],
                translation: [0.25, -0.5, 0.75]
            }
        ],
        universes: [
            { id: 0, name: 'root', cellIds: [3] },
            { id: 1, name: 'pin', cellIds: [1, 2] }
        ],
        lattices: [
            {
                id: 10,
                type: 'rect',
                name: '2x2 assembly',
                lowerLeft: [-0.5, -0.5, -5],
                pitch: [1, 1, 10],
                dimensions: [2, 2, 1],
                universes: [
                    [
                        [1, 1],
                        [1, 1]
                    ]
                ]
            }
        ],
        rootUniverseId: 0
    };
    return state;
}

/** Hexagonal lattice case with orientation and axial stacks. */
function hexagonalGeometryCase(): OpenMCState {
    const state = baseState();
    state.geometry = {
        surfaces: [
            { id: 1, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 1 } },
            { id: 2, type: 'z-cylinder', coefficients: { x0: 0, y0: 0, r: 10 } },
            { id: 3, type: 'z-plane', coefficients: { z0: -5 }, boundary: 'vacuum' },
            { id: 4, type: 'z-plane', coefficients: { z0: 5 }, boundary: 'vacuum' }
        ],
        cells: [
            { id: 1, name: 'Fuel', fillType: 'material', fillId: 1, regionString: '-1' },
            { id: 2, name: 'Hex assembly', fillType: 'lattice', fillId: 20, regionString: '-2 +3 -4' },
            { id: 3, name: 'Outer', fillType: 'void' }
        ],
        universes: [
            { id: 0, name: 'root', cellIds: [2] },
            { id: 1, name: 'pin', cellIds: [1] },
            { id: 5, name: 'outer', cellIds: [3] }
        ],
        lattices: [
            {
                id: 20,
                type: 'hex',
                name: '2-ring hex',
                center: [0, 0, 0],
                pitch: [2, 4],
                rings: 2,
                orientation: 'x',
                nAxial: 2,
                universes: [
                    [[1, 1, 1, 1, 1, 1], [5]],
                    [[5, 5, 5, 5, 5, 5], [1]]
                ],
                outer: 5
            }
        ],
        rootUniverseId: 0
    };
    return state;
}

/** All five mesh types and mesh-filter transforms. */
function meshCase(): OpenMCState {
    const state = baseState();
    state.meshes = [
        { type: 'regular', id: 1, name: 'Regular', lowerLeft: [-5, -5, -5], upperRight: [5, 5, 5], dimension: [5, 5, 5] },
        { type: 'rectilinear', id: 2, name: 'Rectilinear', xGrid: [-5, 0, 5], yGrid: [-5, 0, 5], zGrid: [-5, 5] },
        {
            type: 'cylindrical',
            id: 3,
            name: 'Cylindrical',
            origin: [0, 0, 0],
            axis: [0, 0, 1],
            rGrid: [0, 2, 4],
            phiGrid: [0, Math.PI, 2 * Math.PI],
            zGrid: [-5, 5]
        },
        {
            type: 'spherical',
            id: 4,
            name: 'Spherical',
            origin: [0, 0, 0],
            rGrid: [0, 2, 4],
            thetaGrid: [0, Math.PI / 2, Math.PI],
            phiGrid: [0, Math.PI, 2 * Math.PI]
        },
        {
            type: 'unstructured',
            id: 5,
            name: 'Unstructured',
            filename: '/tmp/mesh.h5m',
            library: 'moab',
            lengthMultiplier: 2,
            options: 'MAX_DEPTH=20;'
        }
    ];
    state.tallies = [
        {
            id: 1,
            name: 'Mesh filters',
            scores: ['flux'],
            nuclides: ['total'],
            filters: [
                { type: 'mesh', bins: [1], meshId: 1, meshTranslation: [1, 2, 3], meshRotation: [10, 20, 30] },
                { type: 'meshsurface', bins: [2], meshId: 2, meshTranslation: [0, 1, 0], meshRotation: [0, 45, 0] },
                { type: 'meshborn', bins: [3], meshId: 3, meshRotation: [5, 0, 0] },
                { type: 'meshmaterial', bins: [0, 1], pairs: [{ first: 0, second: 1 }], meshId: 4, meshTranslation: [0, 0, 2] }
            ]
        }
    ];
    return state;
}

/** The ten newer tally filters, including structured pairs. */
function filterCase(): OpenMCState {
    const state = baseState();
    state.meshes = [{ type: 'regular', id: 1, name: 'Regular', lowerLeft: [-5, -5, -5], upperRight: [5, 5, 5], dimension: [5, 5, 5] }];
    state.tallies = [
        {
            id: 1,
            name: 'Every newer filter',
            scores: ['flux', 'fission'],
            nuclides: ['total'],
            filters: [
                { type: 'materialfrom', bins: [1, 2] },
                {
                    type: 'cellinstance',
                    bins: [1, 0, 2, 1],
                    pairs: [
                        { first: 1, second: 0 },
                        { first: 2, second: 1 }
                    ]
                },
                { type: 'parentnuclide', bins: [], nuclideBins: ['U235', 'Pu239'] },
                { type: 'meshborn', bins: [1], meshId: 1 },
                {
                    type: 'meshmaterial',
                    bins: [0, 1, 1, 2],
                    pairs: [
                        { first: 0, second: 1 },
                        { first: 1, second: 2 }
                    ],
                    meshId: 1
                },
                { type: 'collision', bins: [0, 5, 10] },
                { type: 'reaction', bins: [], reactionBins: ['(n,gamma)', '(n,fission)'] },
                {
                    type: 'particleproduction',
                    bins: [],
                    particleTypes: [PHOTON_PARTICLE],
                    productionEnergyBins: [1e5, 1e7]
                },
                { type: 'musurface', bins: [-1, 0, 1] },
                { type: 'weight', bins: [0.5, 1, 2] }
            ]
        }
    ];
    return state;
}

/** Source spatial/energy/angle/time distributions and bias. */
function sourceCase(): OpenMCState {
    const state = baseState();
    state.settings.run = { mode: 'fixed source', particles: 1000, batches: 10 };
    state.settings.sources = [
        {
            spatial: {
                type: 'cartesian',
                x: { type: 'uniform', min: -1, max: 1 },
                y: { type: 'discrete', energies: [0], probabilities: [1] },
                z: { type: 'tabular', energies: [-1, 1], probabilities: [1, 1], interpolation: 'linear-linear' }
            },
            energy: {
                type: 'discrete',
                energies: [1e6, 2e6],
                probabilities: [0.25, 0.75],
                bias: { probabilities: [0.1, 0.9] }
            },
            angle: {
                type: 'mu-phi',
                mu: { type: 'uniform', min: -1, max: 1 },
                phi: { type: 'uniform', min: 0, max: 2 * Math.PI },
                referenceUvW: [0, 0, 1],
                referenceVwu: [1, 0, 0]
            },
            time: { type: 'tabular', energies: [0, 1e-3], probabilities: [1, 1], interpolation: 'linear-linear' },
            particle: NEUTRON_PARTICLE,
            strength: 2,
            constraints: {
                domainType: 'cell',
                domainIds: [1],
                energyBounds: [1e4, 2e7],
                timeBounds: [0, 1e-3],
                fissionable: false,
                rejectionStrategy: 'resample'
            }
        }
    ];
    return state;
}

/** Variance-reduction fields: UFS, WW list/file/checkpoints, generator. */
function varianceReductionCase(): OpenMCState {
    const state = baseState();
    state.settings.sources = [
        {
            spatial: { type: 'box', lowerLeft: [-5, -5, -5], upperRight: [5, 5, 5] },
            energy: { type: 'discrete', energies: [2e6] },
            particle: NEUTRON_PARTICLE,
            strength: 1
        }
    ];
    state.meshes = [
        { type: 'regular', id: 1, name: 'WW mesh', lowerLeft: [-10, -10, -10], upperRight: [10, 10, 10], dimension: [4, 4, 4] }
    ];
    state.varianceReduction = {
        ufs: { enabled: true, meshId: 1 },
        weightWindows: [
            {
                id: 1,
                meshId: 1,
                particleType: NEUTRON_PARTICLE,
                energyBounds: [0, 1e5, 2e7],
                lowerBound: [0.25, 0.5, 0.75],
                upperBound: [0.5, 1, 1.5],
                survivalWeight: 2.5,
                maxSplit: 8,
                weightCutoff: 1e-30
            },
            {
                id: 2,
                meshId: 1,
                particleType: PHOTON_PARTICLE,
                lowerBound: 0.4,
                upperBound: 0.8
            }
        ],
        weightWindowsFile: '/tmp/weight_windows.h5',
        weightWindowsOn: true,
        weightWindowCheckpoints: { collision: true, surface: false },
        weightWindowGenerator: {
            meshId: 1,
            energyBounds: [0, 1e5, 2e7],
            method: 'fw_cadis',
            maxRealizations: 10,
            updateInterval: 5,
            onTheFly: true,
            targetTallyIds: [1],
            particleType: NEUTRON_PARTICLE
        }
    };
    return state;
}

/** Depletion advanced fields serialized through the custom block. */
function depletionCase(): OpenMCState {
    const state = baseState();
    state.materials[0].isDepletable = true;
    state.materials[0].volume = 125;
    state.depletion = {
        enabled: true,
        chainFile: '/tmp/chain_casl.xml',
        operator: 'coupled',
        power: 1000,
        timeSteps: [0, 86400, 172800],
        solver: 'cecm',
        substeps: 3,
        normalizationMode: 'fission-q',
        reduceOutput: true,
        reactivityControl: {
            enabled: true,
            parameter: 'cell-translation',
            cellId: 1,
            axis: 'x',
            x0: 0.1,
            x1: 0.5,
            bracket: [-1, 1],
            targetKeff: 1.0,
            kTol: 1e-4,
            sigmaFinal: 3e-4,
            maxIterations: 25,
            onFailure: 'warn'
        },
        externalSourceRates: [
            {
                material: 1,
                composition: [
                    { name: 'U235', weightPercent: 3 },
                    { name: 'U238', weightPercent: 97 }
                ],
                rate: 1.5,
                units: 'g/d',
                timesteps: [1, 2]
            }
        ],
        continueFromResults: '/tmp/depletion_results.h5',
        continueTimesteps: true
    };
    return state;
}

/** Runtime, convergence, physics, limits, and diagnostics settings. */
function runtimeCase(): OpenMCState {
    const state = baseState();
    state.settings = {
        run: { mode: 'eigenvalue', particles: 5000, inactive: 20, batches: 100 },
        sources: [
            {
                spatial: { type: 'point', origin: [0, 0, 0] },
                energy: { type: 'discrete', energies: [2e6] },
                particle: NEUTRON_PARTICLE,
                strength: 1
            }
        ],
        seed: 42,
        threads: 4,
        mpi: { enabled: true, processes: 2, hosts: ['node1', 'node2'] },
        verbosity: 6,
        cutoff: { energyNeutron: 1e-5, energyPhoton: 1e3, time: 1e-3, timePhoton: 1e-2, weight: 1e-12, weightAvg: 1e-10 },
        photonTransport: true,
        electronTreatment: 'ttb',
        atomicRelaxation: false,
        output: { summary: false, tallies: false, path: 'out' },
        temperature: { default: 600, method: 'interpolation', tolerance: 50, multipole: true },
        trace: [1, 2, 3],
        keffTrigger: { type: 'rel_err', threshold: 1e-4 },
        confidenceIntervals: true,
        freeGasThreshold: 400,
        sharedSecondaryBank: true,
        surfaceGrazingCutoff: 0.1,
        surfaceGrazingRatio: 0.5,
        maxParticleEvents: 100000,
        maxParticlesInFlight: 200000,
        maxSecondaries: 5000,
        maxHistorySplits: 100,
        maxWriteLostParticles: 10,
        noReduce: true,
        stride: 7,
        plotSeed: 99,
        propertiesFile: '/tmp/properties.h5',
        materialCellOffsets: false,
        resonanceScattering: { enable: true, method: 'dbrc', energyMin: 1, energyMax: 1e4 },
        probabilityTables: false,
        eventBased: true,
        maxLostParticles: 50,
        relLostParticleRate: 1e-3,
        createFissionNeutrons: true,
        createDelayedNeutrons: false,
        delayedPhotonScaling: true,
        useDecayPhotons: true,
        logGridBins: 2048,
        tabularLegendre: { enable: true, numPoints: 16 },
        survivalBiasing: false,
        generationsPerBatch: 2,
        maxOrder: 5,
        writeInitialSource: true,
        uniformSourceSampling: true,
        triggers: { maxBatches: 500, batchInterval: 10 }
    };
    return state;
}

/** Plot appearance controls (slice mask/overlap and background). */
function plotCase(): OpenMCState {
    const state = baseState();
    state.plots = [
        {
            id: 1,
            type: 'slice',
            name: 'Midplane',
            basis: 'xy',
            origin: [0, 0, 0],
            width: 20,
            height: 20,
            pixels: [400, 400],
            colorBy: 'material',
            background: [10, 20, 30],
            mask: { components: [1], background: [200, 210, 220] },
            showOverlaps: true,
            overlapColor: [255, 0, 0]
        },
        {
            id: 2,
            type: 'voxel',
            basis: 'xy',
            origin: [0, 0, 0],
            lowerLeft: [-5, -5, -5],
            upperRight: [5, 5, 5],
            voxels: [10, 10, 10],
            colorBy: 'cell'
        }
    ];
    return state;
}

/** Materials with depletability, volume, temperature, isotropic, and macroscopic data. */
function materialCase(): OpenMCState {
    const state = baseState();
    state.materials[0].isDepletable = true;
    state.materials[0].volume = 250;
    state.materials[0].temperature = 900;
    state.materials[0].isotropic = ['H1'];
    state.materials.push({
        id: 3,
        name: 'Macroscopic water',
        density: 1,
        densityUnit: 'macro',
        nuclides: [],
        thermalScattering: [],
        macroscopic: { name: 'Water' }
    });
    state.geometry.cells.push({ id: 3, name: 'Macro', fillType: 'material', fillId: 3, regionString: '-1 +1' });
    state.geometry.universes[0].cellIds.push(3);
    return state;
}

/** Nuclide-wise multi-group mode inferred from decomposed materials. */
function nuclideWiseCase(): OpenMCState {
    const state = baseState();
    state.settings.energyMode = 'multigroup';
    state.settings.nuclideWiseMgxs = true;
    state.settings.mgxsLibrary = '/tmp/mgxs.h5';
    state.materials = [
        {
            id: 1,
            name: 'Steel',
            density: 8,
            densityUnit: 'g/cm3',
            nuclides: [{ name: 'Fe56', fraction: 1, fractionType: 'ao' }],
            thermalScattering: []
        },
        {
            id: 2,
            name: 'Water',
            density: 1,
            densityUnit: 'g/cm3',
            nuclides: [{ name: 'H1', fraction: 1, fractionType: 'ao' }],
            thermalScattering: []
        }
    ];
    return state;
}

const CASES: MatrixCase[] = [
    {
        name: 'rectangular lattice, periodic pairs, albedo, cell transforms',
        state: rectangularGeometryCase(),
        verify(imported) {
            const lattice = imported.geometry.lattices.find((entry) => entry.id === 10);
            expect(lattice?.type).toBe('rect');
            expect(lattice?.type === 'rect' && lattice.dimensions).toEqual([2, 2, 1]);
            expect(lattice?.type === 'rect' && lattice.pitch).toEqual([1, 1, 10]);
            expect(lattice?.type === 'rect' && lattice.universes[0][0]).toEqual([1, 1]);
            const cell = imported.geometry.cells.find((entry) => entry.id === 1);
            expect(cell?.density).toBeCloseTo(10.4, 6);
            expect(cell?.volume).toBeCloseTo(12.5, 6);
            const root = imported.geometry.cells.find((entry) => entry.id === 3);
            expect(root?.rotation).toEqual([0, 0, 30]);
            expect(root?.translation).toEqual([0.25, -0.5, 0.75]);
            const periodic = imported.geometry.surfaces.find((entry) => entry.id === 2);
            expect(periodic?.boundary).toBe('periodic');
            expect(periodic?.periodicSurfaceId).toBe(3);
            expect(periodic?.albedo).toBeCloseTo(0.8, 6);
        }
    },
    {
        name: 'hexagonal lattice orientation and axial stacks',
        state: hexagonalGeometryCase(),
        verify(imported) {
            const lattice = imported.geometry.lattices.find((entry) => entry.id === 20);
            expect(lattice?.type).toBe('hex');
            if (lattice?.type !== 'hex') {
                return;
            }
            expect(lattice.rings).toBe(2);
            expect(lattice.orientation).toBe('x');
            expect(lattice.nAxial).toBe(2);
            expect(lattice.pitch).toEqual([2, 4]);
            expect(lattice.universes[0][0]).toEqual([1, 1, 1, 1, 1, 1]);
            expect(lattice.universes[1][1]).toEqual([1]);
            expect(lattice.outer).toBe(5);
        }
    },
    {
        name: 'five mesh types and mesh-filter transforms',
        state: meshCase(),
        verify(imported) {
            expect(imported.meshes.map((mesh) => mesh.type).sort()).toEqual([
                'cylindrical',
                'rectilinear',
                'regular',
                'spherical',
                'unstructured'
            ]);
            const regular = imported.meshes.find((mesh) => mesh.id === 1);
            expect(regular?.type).toBe('regular');
            const rectilinear = imported.meshes.find((mesh) => mesh.id === 2);
            expect(rectilinear?.type === 'rectilinear' && rectilinear.xGrid).toEqual([-5, 0, 5]);
            const unstructured = imported.meshes.find((mesh) => mesh.id === 5);
            expect(unstructured?.type).toBe('unstructured');
            expect(unstructured?.type === 'unstructured' && unstructured.library).toBe('moab');
            expect(unstructured?.type === 'unstructured' && unstructured.lengthMultiplier).toBe(2);
            expect(unstructured?.type === 'unstructured' && unstructured.options).toBe('MAX_DEPTH=20;');

            const filters = imported.tallies[0].filters;
            const mesh = filters.find((filter) => filter.type === 'mesh');
            expect(mesh?.meshTranslation).toEqual([1, 2, 3]);
            expect(mesh?.meshRotation).toEqual([10, 20, 30]);
            const surface = filters.find((filter) => filter.type === 'meshsurface');
            expect(surface?.meshRotation).toEqual([0, 45, 0]);
            const born = filters.find((filter) => filter.type === 'meshborn');
            expect(born?.meshRotation).toEqual([5, 0, 0]);
            const material = filters.find((filter) => filter.type === 'meshmaterial');
            expect(material?.meshTranslation).toEqual([0, 0, 2]);
            expect(material?.pairs).toEqual([{ first: 0, second: 1 }]);
        }
    },
    {
        name: 'ten newer tally filters and structured pairs',
        state: filterCase(),
        verify(imported) {
            const filters = imported.tallies[0].filters;
            expect(filters.find((filter) => filter.type === 'materialfrom')?.bins).toEqual([1, 2]);
            expect(filters.find((filter) => filter.type === 'cellinstance')?.pairs).toEqual([
                { first: 1, second: 0 },
                { first: 2, second: 1 }
            ]);
            expect(filters.find((filter) => filter.type === 'parentnuclide')?.nuclideBins).toEqual(['U235', 'Pu239']);
            expect(filters.find((filter) => filter.type === 'meshborn')?.meshId).toBe(1);
            expect(filters.find((filter) => filter.type === 'meshmaterial')?.pairs).toEqual([
                { first: 0, second: 1 },
                { first: 1, second: 2 }
            ]);
            expect(filters.find((filter) => filter.type === 'collision')?.bins).toEqual([0, 5, 10]);
            expect(filters.find((filter) => filter.type === 'reaction')?.reactionBins).toEqual(['(n,gamma)', '(n,fission)']);
            const production = filters.find((filter) => filter.type === 'particleproduction');
            expect(production?.particleTypes).toEqual([PHOTON_PARTICLE]);
            expect(production?.productionEnergyBins).toEqual([1e5, 1e7]);
            expect(filters.find((filter) => filter.type === 'musurface')?.bins).toEqual([-1, 0, 1]);
            expect(filters.find((filter) => filter.type === 'weight')?.bins).toEqual([0.5, 1, 2]);
        }
    },
    {
        name: 'source spatial, energy, angle, time, constraints, and bias',
        state: sourceCase(),
        verify(imported) {
            const source = imported.settings.sources[0] as any;
            expect(source.spatial.type).toBe('cartesian');
            expect(source.spatial.x).toEqual({ type: 'uniform', min: -1, max: 1 });
            expect(source.spatial.y).toEqual({ type: 'discrete', energies: [0], probabilities: [1] });
            expect(source.spatial.z.type).toBe('tabular');
            expect(source.energy.type).toBe('discrete');
            expect(source.energy.probabilities).toEqual([0.25, 0.75]);
            expect(source.energy.bias).toEqual({ probabilities: [0.1, 0.9] });
            expect(source.angle.type).toBe('mu-phi');
            expect(source.angle.referenceUvW).toEqual([0, 0, 1]);
            expect(source.angle.referenceVwu).toEqual([1, 0, 0]);
            expect(source.time.type).toBe('tabular');
            expect(source.time.energies).toEqual([0, 1e-3]);
            expect(source.particle).toEqual(NEUTRON_PARTICLE);
            expect(source.strength).toBe(2);
            expect(source.constraints).toEqual({
                domainType: 'cell',
                domainIds: [1],
                energyBounds: [1e4, 2e7],
                timeBounds: [0, 1e-3],
                fissionable: false,
                rejectionStrategy: 'resample'
            });
        }
    },
    {
        name: 'UFS, weight-window list/file/checkpoints, and generator',
        state: varianceReductionCase(),
        verify(imported) {
            const vr = imported.varianceReduction;
            expect(vr?.ufs).toEqual({ enabled: true, meshId: 1 });
            expect(vr?.weightWindows).toHaveLength(2);
            expect(vr?.weightWindows?.[0].meshId).toBe(1);
            expect(vr?.weightWindows?.[0].lowerBound).toEqual([0.25, 0.5, 0.75]);
            expect(vr?.weightWindows?.[0].upperBound).toEqual([0.5, 1, 1.5]);
            expect(vr?.weightWindows?.[0].survivalWeight).toBe(2.5);
            expect(vr?.weightWindows?.[0].maxSplit).toBe(8);
            expect(vr?.weightWindows?.[0].weightCutoff).toBeCloseTo(1e-30, 40);
            expect(vr?.weightWindows?.[1].particleType).toEqual(PHOTON_PARTICLE);
            expect(vr?.weightWindowsFile).toBe('/tmp/weight_windows.h5');
            expect(vr?.weightWindowsOn).toBe(true);
            expect(vr?.weightWindowCheckpoints).toEqual({ collision: true, surface: false });
            expect(vr?.weightWindowGenerator?.meshId).toBe(1);
            expect(vr?.weightWindowGenerator?.energyBounds).toEqual([0, 1e5, 2e7]);
            expect(vr?.weightWindowGenerator?.maxRealizations).toBe(10);
            expect(vr?.weightWindowGenerator?.updateInterval).toBe(5);
            expect(vr?.weightWindowGenerator?.onTheFly).toBe(true);
            expect(vr?.weightWindowGenerator?.method).toBe('fw_cadis');
            expect(vr?.weightWindowGenerator?.targetTallyIds).toEqual([1]);
        }
    },
    {
        name: 'depletion substeps, reactivity control, feeds, and continuation',
        state: depletionCase(),
        verify(imported) {
            const depletion = imported.depletion;
            expect(depletion?.enabled).toBe(true);
            expect(depletion?.chainFile).toBe('/tmp/chain_casl.xml');
            expect(depletion?.operator).toBe('coupled');
            expect(depletion?.power).toBe(1000);
            expect(depletion?.timeSteps).toEqual([0, 86400, 172800]);
            expect(depletion?.solver).toBe('cecm');
            expect(depletion?.substeps).toBe(3);
            expect(depletion?.normalizationMode).toBe('fission-q');
            expect(depletion?.reactivityControl).toMatchObject({
                enabled: true,
                parameter: 'cell-translation',
                cellId: 1,
                axis: 'x',
                x0: 0.1,
                x1: 0.5,
                bracket: [-1, 1],
                targetKeff: 1,
                kTol: 1e-4,
                sigmaFinal: 3e-4,
                maxIterations: 25,
                onFailure: 'warn'
            });
            expect(depletion?.externalSourceRates).toHaveLength(1);
            expect(depletion?.externalSourceRates?.[0]).toMatchObject({
                material: 1,
                rate: 1.5,
                units: 'g/d',
                timesteps: [1, 2]
            });
            expect(depletion?.externalSourceRates?.[0].composition).toEqual([
                { name: 'U235', weightPercent: 3 },
                { name: 'U238', weightPercent: 97 }
            ]);
            expect(depletion?.continueFromResults).toBe('/tmp/depletion_results.h5');
            expect(depletion?.continueTimesteps).toBe(true);
            const material = imported.materials.find((entry) => entry.id === 1);
            expect(material?.isDepletable).toBe(true);
            expect(material?.volume).toBe(125);
        }
    },
    {
        name: 'nuclide-wise multi-group mode inferred from materials',
        state: nuclideWiseCase(),
        verify(imported) {
            expect(imported.settings.energyMode).toBe('multigroup');
            expect(imported.settings.nuclideWiseMgxs).toBe(true);
            expect(imported.settings.mgxsLibrary).toBe('/tmp/mgxs.h5');
            expect(imported.materials.every((material) => !material.macroscopic)).toBe(true);
        }
    },
    {
        name: 'runtime, convergence, physics, limit, and diagnostic settings',
        state: runtimeCase(),
        verify(imported) {
            const settings = imported.settings;
            expect(settings.seed).toBe(42);
            expect(settings.verbosity).toBe(6);
            expect(settings.cutoff).toEqual({
                energyNeutron: 1e-5,
                energyPhoton: 1e3,
                time: 1e-3,
                timePhoton: 1e-2,
                weight: 1e-12,
                weightAvg: 1e-10
            });
            expect(settings.photonTransport).toBe(true);
            expect(settings.electronTreatment).toBe('ttb');
            expect(settings.atomicRelaxation).toBe(false);
            expect(settings.output).toEqual({ summary: false, tallies: false, path: 'out' });
            expect(settings.temperature).toEqual({ default: 600, method: 'interpolation', tolerance: 50, multipole: true });
            expect(settings.trace).toEqual([1, 2, 3]);
            expect(settings.keffTrigger).toEqual({ type: 'rel_err', threshold: 1e-4 });
            expect(settings.confidenceIntervals).toBe(true);
            expect(settings.freeGasThreshold).toBe(400);
            expect(settings.sharedSecondaryBank).toBe(true);
            expect(settings.surfaceGrazingCutoff).toBe(0.1);
            expect(settings.surfaceGrazingRatio).toBe(0.5);
            expect(settings.maxParticleEvents).toBe(100000);
            expect(settings.maxParticlesInFlight).toBe(200000);
            expect(settings.maxSecondaries).toBe(5000);
            expect(settings.maxHistorySplits).toBe(100);
            expect(settings.maxWriteLostParticles).toBe(10);
            expect(settings.noReduce).toBe(true);
            expect(settings.stride).toBe(7);
            expect(settings.plotSeed).toBe(99);
            expect(settings.propertiesFile).toBe('/tmp/properties.h5');
            expect(settings.materialCellOffsets).toBe(false);
            expect(settings.resonanceScattering).toEqual({ enable: true, method: 'dbrc', energyMin: 1, energyMax: 1e4 });
            expect(settings.probabilityTables).toBe(false);
            expect(settings.eventBased).toBe(true);
            expect(settings.maxLostParticles).toBe(50);
            expect(settings.relLostParticleRate).toBe(1e-3);
            expect(settings.createFissionNeutrons).toBe(true);
            expect(settings.createDelayedNeutrons).toBe(false);
            expect(settings.delayedPhotonScaling).toBe(true);
            expect(settings.useDecayPhotons).toBe(true);
            expect(settings.logGridBins).toBe(2048);
            expect(settings.tabularLegendre).toEqual({ enable: true, numPoints: 16 });
            expect(settings.survivalBiasing).toBe(false);
            expect(settings.generationsPerBatch).toBe(2);
            expect(settings.maxOrder).toBe(5);
            expect(settings.writeInitialSource).toBe(true);
            expect(settings.uniformSourceSampling).toBe(true);
            expect(settings.triggers).toEqual({ maxBatches: 500, batchInterval: 10 });
        }
    },
    {
        name: 'plot background, mask, overlap, and voxel fallback',
        state: plotCase(),
        includePlots: true,
        verify(imported) {
            const slice = imported.plots?.find((plot) => plot.id === 1);
            expect(slice?.background).toEqual([10, 20, 30]);
            expect(slice?.mask?.components).toEqual([1]);
            expect(slice?.mask?.background).toEqual([200, 210, 220]);
            expect(slice?.showOverlaps).toBe(true);
            expect(slice?.overlapColor).toEqual([255, 0, 0]);
            const voxel = imported.plots?.find((plot) => plot.id === 2);
            expect(voxel?.type).toBe('voxel');
            expect(voxel?.voxels).toEqual([10, 10, 10]);
        }
    },
    {
        name: 'materials depletability, volume, temperature, isotropic, macroscopic',
        state: materialCase(),
        verify(imported) {
            const fuel = imported.materials.find((material) => material.id === 1);
            expect(fuel?.isDepletable).toBe(true);
            expect(fuel?.volume).toBe(250);
            expect(fuel?.temperature).toBe(900);
            expect(fuel?.isotropic).toEqual(['H1']);
            const macro = imported.materials.find((material) => material.id === 3);
            expect(macro?.macroscopic).toEqual({ name: 'Water' });
            expect(macro?.densityUnit).toBe('macro');
        }
    }
];

describe('XML round-trip matrix', () => {
    beforeAll(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-matrix-'));
    });

    afterAll(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it.each(CASES)('$name', async (testCase) => {
        const imported = await roundTrip(testCase.state, testCase.includePlots);
        testCase.verify(imported);
    });

    it('keeps derived tallies project-only and out of generated XML', async () => {
        const state = baseState();
        state.derivedTallies = [
            {
                id: 1,
                name: 'Capture-to-fission',
                unit: 'ratio',
                expression: {
                    kind: 'binary',
                    op: '/',
                    left: { kind: 'tally', tallyId: 1, score: 'flux' },
                    right: { kind: 'tally', tallyId: 1, score: 'fission' }
                }
            }
        ];
        const directory = fs.mkdtempSync(path.join(tempRoot, 'derived-'));
        const generation = new XMLGenerationService();
        const generated = await generation.generateXML({
            state,
            outputDirectory: directory,
            randomRayCompat: FULL_COMPAT,
            files: { materials: true, geometry: true, settings: true, tallies: true, plots: false }
        });
        expect(generated.success, generated.error).toBe(true);
        const talliesPath = path.join(directory, 'tallies.xml');
        if (fs.existsSync(talliesPath)) {
            expect(fs.readFileSync(talliesPath, 'utf-8')).not.toContain('Capture-to-fission');
        }

        const backend = new OpenMCStudioBackendServiceImpl();
        const imported = await backend.importXML({ directory });
        expect(imported.success, imported.errors.join('; ')).toBe(true);
        expect(imported.state?.derivedTallies).toBeUndefined();
    });
});
