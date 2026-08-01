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
 * Round-trip tests for the settings.xml generation/import contract:
 * state → settings.xml → importXML → state must preserve every field.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { XMLGenerationService } from './xml-generation-service';
import { OpenMCStudioBackendServiceImpl } from './openmc-studio-backend-service';
import { OpenMCRunnerService } from './openmc-runner-service';
import { OpenMCState, OpenMCSettings } from '../common/openmc-state-schema';
import { OPENMC_SCORES } from '../common/scores-catalog';
import { resolveDepletionSolver } from '../common/depletion-solvers';

/**
 * Build a state exercising every settings.xml field added in Phase 5 W1.
 * @returns The test state.
 */
function buildTestState(): OpenMCState {
    const now = new Date().toISOString();
    return {
        metadata: {
            version: '1.1.0',
            name: 'Round Trip Test',
            created: now,
            modified: now
        },
        geometry: {
            surfaces: [{ id: 1, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 10 }, boundary: 'vacuum' }],
            cells: [{ id: 1, fillType: 'material', fillId: 1, regionString: '-1' }],
            universes: [{ id: 0, name: 'root', cellIds: [1], isRoot: true }],
            lattices: [],
            rootUniverseId: 0
        },
        materials: [
            {
                id: 1,
                name: 'Water',
                density: 1.0,
                densityUnit: 'g/cm3',
                nuclides: [{ name: 'H1', fraction: 2.0, fractionType: 'ao' }],
                thermalScattering: []
            }
        ],
        settings: {
            run: { mode: 'eigenvalue', particles: 5000, inactive: 20, batches: 200 },
            seed: 42,
            sourceRejectionFraction: 0.05,
            photonTransport: true,
            electronTreatment: 'ttb',
            atomicRelaxation: false,
            sources: [
                {
                    spatial: { type: 'point', origin: [1, 2, 3] },
                    energy: { type: 'discrete', energies: [1e6, 2e6], probabilities: [0.5, 0.5] },
                    particle: 'neutron',
                    strength: 2.5,
                    constraints: {
                        domainType: 'cell',
                        domainIds: [1, 2],
                        fissionable: true,
                        energyBounds: [1e4, 2e7],
                        timeBounds: [0, 1e-3],
                        rejectionStrategy: 'kill'
                    }
                },
                {
                    spatial: { type: 'sphere', center: [0, 0, 0], radius: 5 },
                    energy: { type: 'uniform', min: 1e5, max: 2e7 },
                    particle: 'neutron',
                    strength: 1.0
                },
                {
                    type: 'file',
                    path: '/tmp/surface_source.h5',
                    strength: 0.5
                },
                {
                    type: 'compiled',
                    library: '/tmp/libsource.so',
                    parameters: 'radius=5',
                    strength: 3.0,
                    constraints: {
                        rejectionStrategy: 'resample'
                    }
                }
            ],
            output: { summary: false, tallies: false, path: '/tmp/openmc-out' },
            statepointBatches: [50, 100, 150],
            sourcePoint: { write: false, separate: true, batches: [75], overwrite: true, mcpl: true },
            surfaceSourceWrite: {
                surfaceIds: [1, 2],
                cell: 3,
                cellfrom: 4,
                cellto: 5,
                maxParticles: 500000,
                maxSourceFiles: 10,
                mcpl: true
            },
            surfaceSourceRead: { path: '/tmp/surface_source_read.h5' },
            tracks: [
                [1, 1, 1],
                [2, 1, 5]
            ],
            maxTracks: 500,
            collisionTrack: {
                maxCollisions: 2500,
                reactions: [102, 'total'],
                materialIds: [1],
                nuclides: ['U235', 'H1'],
                cellIds: [1, 2],
                universeIds: [0],
                depositedEnergyThreshold: 1e4,
                maxCollisionTrackFiles: 5,
                mcpl: false
            },
            entropyMesh: {
                id: 42,
                lowerLeft: [-10, -10, -10],
                upperRight: [10, 10, 10],
                shape: [4, 4, 4]
            }
        },
        tallies: [],
        meshes: []
    };
}

/**
 * Extend the base test state with meshes and tallies covering every filter
 * type in the catalog and every catalog score.
 * @returns The test state including meshes and tallies.
 */
function buildTalliesTestState(): OpenMCState {
    const state = buildTestState();
    state.meshes = [
        { type: 'regular', id: 1, lowerLeft: [-5, -5, -5], upperRight: [5, 5, 5], dimension: [5, 5, 5] },
        { type: 'cylindrical', id: 2, origin: [0, 0, 0], axis: [0, 0, 1], rGrid: [0, 1, 2], phiGrid: [0, 3.14159], zGrid: [-5, 5] },
        { type: 'spherical', id: 3, origin: [0, 0, 0], rGrid: [0, 5], thetaGrid: [0, 3.14159], phiGrid: [0, 6.28319] }
    ];
    state.tallies = [
        {
            id: 1,
            name: 'All Scores Tally',
            scores: OPENMC_SCORES.map((s) => s.name),
            nuclides: ['total'],
            estimator: 'tracklength',
            filters: [
                { type: 'cell', bins: [1, 2] },
                { type: 'material', bins: [1] },
                { type: 'universe', bins: [0] },
                { type: 'surface', bins: [1] },
                { type: 'cellborn', bins: [1, 2] },
                { type: 'cellfrom', bins: [2] },
                { type: 'distribcell', bins: [1] },
                { type: 'energy', bins: [0, 0.625, 2e7] },
                { type: 'energyout', bins: [0, 2e7] },
                { type: 'mu', bins: [-1, 1] },
                { type: 'polar', bins: [0, 3.14159] },
                { type: 'azimuthal', bins: [0, 6.28318530718] },
                { type: 'time', bins: [0, 0.1] },
                { type: 'particle', bins: [1, 2] },
                { type: 'delayedgroup', bins: [1, 2, 3] },
                { type: 'mesh', bins: [1], meshId: 1 },
                { type: 'meshsurface', bins: [2], meshId: 2 }
            ]
        },
        {
            id: 2,
            name: 'Expansion Tally',
            scores: ['flux', 'heating'],
            nuclides: ['U235'],
            multiplyDensity: false,
            filters: [
                { type: 'legendre', bins: [], order: 5 },
                { type: 'spatiallegendre', bins: [], order: 4, axis: 'z', min: -10, max: 10 },
                { type: 'sphericalharmonics', bins: [], order: 3, cosine: 'scatter' },
                { type: 'zernike', bins: [], order: 5, center: { x: 0, y: 0, r: 1 } },
                { type: 'zernikeradial', bins: [], order: 2, center: { x: 1, y: 2, r: 3 } },
                { type: 'energyfunction', bins: [], energyValues: [1e-5, 1, 2e7], responseValues: [0.5, 1, 2], interpolation: 'log-log' }
            ]
        }
    ];
    return state;
}

/**
 * Extend the base test state with plot configurations of all four types.
 * @returns The test state including plots.
 */
function buildPlotsTestState(): OpenMCState {
    const state = buildTestState();
    state.plots = [
        {
            id: 1,
            type: 'slice',
            name: 'Midplane',
            basis: 'xz',
            origin: [1, 2, 3],
            width: 20,
            height: 30,
            pixels: [400, 300],
            colorBy: 'material',
            meshlines: true
        },
        {
            id: 2,
            type: 'voxel',
            name: 'Voxel',
            basis: 'xy',
            origin: [0, 0, 0],
            lowerLeft: [-4, -6, -8],
            upperRight: [4, 6, 8],
            voxels: [10, 20, 30],
            colorBy: 'cell'
        },
        {
            id: 3,
            type: 'solid-raytrace',
            basis: 'xy',
            origin: [0, 0, 0],
            pixels: [800, 600],
            colorBy: 'material',
            cameraPosition: [10, 10, 10],
            lookAt: [1, 2, 3],
            horizontalFieldOfView: 50,
            orthographicWidth: 25,
            lightPosition: [5, 5, 5],
            diffuseFraction: 0.3,
            opaqueIds: [1, 2]
        },
        {
            id: 4,
            type: 'wireframe-raytrace',
            basis: 'xy',
            origin: [0, 0, 0],
            pixels: [800, 600],
            colorBy: 'cell',
            cameraPosition: [10, 0, 0],
            lookAt: [0, 0, 0],
            horizontalFieldOfView: 70,
            wireframeThickness: 2,
            wireframeColor: [255, 0, 0],
            wireframeIds: [1]
        }
    ];
    return state;
}

describe('settings.xml round-trip', () => {
    let tempDir: string;

    beforeAll(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-roundtrip-'));
    });

    afterAll(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('generates settings.xml with all new elements', async () => {
        const service = new XMLGenerationService();
        const result = await service.generateXML({
            state: buildTestState(),
            outputDirectory: tempDir,
            files: { materials: true, geometry: true, settings: true, tallies: false, plots: false }
        });

        expect(result.success).toBe(true);

        const xml = fs.readFileSync(path.join(tempDir, 'settings.xml'), 'utf-8');
        // Source types
        expect(xml).toContain('<source type="independent"');
        expect(xml).toContain('<source type="file" file="/tmp/surface_source.h5"');
        expect(xml).toContain('<source type="compiled" library="/tmp/libsource.so" parameters="radius=5"');
        // Constraints
        expect(xml).toContain('<constraints>');
        expect(xml).toContain('<domain_type>cell</domain_type>');
        expect(xml).toContain('<rejection_strategy>kill</rejection_strategy>');
        // Output / physics
        expect(xml).toContain('<electron_treatment>ttb</electron_treatment>');
        expect(xml).toContain('<atomic_relaxation>false</atomic_relaxation>');
        expect(xml).toContain('<output>');
        // Output control
        expect(xml).toContain('<state_point>');
        expect(xml).toContain('<source_point>');
        expect(xml).toContain('<surf_source_write>');
        expect(xml).toContain('<surf_source_read>');
        expect(xml).toContain('<track>1 1 1 2 1 5</track>');
        expect(xml).toContain('<max_tracks>500</max_tracks>');
        expect(xml).toContain('<collision_track>');
        expect(xml).toContain('<entropy_mesh>42</entropy_mesh>');
        expect(xml).toContain('<mesh id="42" type="regular">');
    });

    it('round-trips every new settings field through importXML', async () => {
        const state = buildTestState();
        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: tempDir,
            files: { materials: true, geometry: true, settings: true, tallies: false, plots: false }
        });

        const backend = new OpenMCStudioBackendServiceImpl();
        const imported = await backend.importXML({ directory: tempDir });

        expect(imported.success).toBe(true);
        expect(imported.state).toBeDefined();

        const settings = imported.state!.settings;
        const expected = state.settings;

        // Run configuration
        expect(settings.run).toEqual(expected.run);

        // Scalar settings
        expect(settings.seed).toBe(expected.seed);
        expect(settings.sourceRejectionFraction).toBe(expected.sourceRejectionFraction);
        expect(settings.photonTransport).toBe(expected.photonTransport);
        expect(settings.electronTreatment).toBe(expected.electronTreatment);
        expect(settings.atomicRelaxation).toBe(expected.atomicRelaxation);

        // Sources (independent with constraints, sphere, file, compiled)
        expect(settings.sources).toEqual(expected.sources);

        // Output control
        expect(settings.output).toEqual(expected.output);
        expect(settings.statepointBatches).toEqual(expected.statepointBatches);
        expect(settings.sourcePoint).toEqual(expected.sourcePoint);

        // Surface source writing/reading
        expect(settings.surfaceSourceWrite).toEqual(expected.surfaceSourceWrite);
        expect(settings.surfaceSourceRead).toEqual(expected.surfaceSourceRead);

        // Tracks and collision track
        expect(settings.tracks).toEqual(expected.tracks);
        expect(settings.maxTracks).toBe(expected.maxTracks);
        expect(settings.collisionTrack).toEqual(expected.collisionTrack);

        // Shannon entropy mesh
        expect(settings.entropyMesh).toEqual(expected.entropyMesh);
    });

    it('round-trips meshes and every filter type through tallies.xml', async () => {
        const state = buildTalliesTestState();
        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: tempDir,
            files: { materials: true, geometry: true, settings: true, tallies: true, plots: false }
        });

        const xml = fs.readFileSync(path.join(tempDir, 'tallies.xml'), 'utf-8');
        // Expansion and energy-function filters
        expect(xml).toContain('type="legendre"');
        expect(xml).toContain('<order>5</order>');
        expect(xml).toContain('type="spatiallegendre"');
        expect(xml).toContain('<axis>z</axis>');
        expect(xml).toContain('type="sphericalharmonics" cosine="scatter"');
        expect(xml).toContain('type="zernike"');
        expect(xml).toContain('type="zernikeradial"');
        expect(xml).toContain('type="energyfunction"');
        expect(xml).toContain('<interpolation>log-log</interpolation>');
        // Mesh-surface filter and particle names
        expect(xml).toContain('type="meshsurface"');
        expect(xml).toContain('<bins>neutron photon</bins>');
        // Real OpenMC nuclides form
        expect(xml).toContain('<nuclides>total</nuclides>');

        const backend = new OpenMCStudioBackendServiceImpl();
        const imported = await backend.importXML({ directory: tempDir });

        expect(imported.success).toBe(true);
        expect(imported.state!.meshes).toEqual(state.meshes);
        expect(imported.state!.tallies).toEqual(state.tallies);
    });

    it('round-trips a MeshSource with per-element sub-sources (mesh lives in settings.xml)', async () => {
        // Fresh directory: this suite shares tempDir and tallies.xml is only
        // written when tallies exist — avoid stale files from earlier tests
        const meshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-meshsource-'));
        const now = new Date().toISOString();
        const state: OpenMCState = {
            metadata: { version: '1.1.0', name: 'Mesh Source Test', created: now, modified: now },
            geometry: {
                surfaces: [{ id: 1, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 10 }, boundary: 'vacuum' }],
                cells: [{ id: 1, fillType: 'material', fillId: 1, regionString: '-1' }],
                universes: [{ id: 0, name: 'root', cellIds: [1], isRoot: true }],
                lattices: [],
                rootUniverseId: 0
            },
            materials: [
                {
                    id: 1,
                    name: 'Water',
                    density: 1.0,
                    densityUnit: 'g/cm3',
                    nuclides: [{ name: 'H1', fraction: 2.0, fractionType: 'ao' }],
                    thermalScattering: []
                }
            ],
            settings: {
                run: { mode: 'fixed source', particles: 1000, batches: 10 },
                sources: [
                    {
                        type: 'mesh',
                        meshId: 7,
                        constraints: { rejectionStrategy: 'kill' },
                        sources: [
                            {
                                spatial: { type: 'point', origin: [0, 0, 0] },
                                energy: { type: 'discrete', energies: [1e6], probabilities: [1] },
                                particle: 'neutron',
                                strength: 1.0
                            },
                            {
                                spatial: { type: 'point', origin: [0, 0, 0] },
                                energy: { type: 'uniform', min: 1e5, max: 2e7 },
                                particle: 'neutron',
                                strength: 1.5
                            },
                            {
                                spatial: { type: 'point', origin: [0, 0, 0] },
                                energy: { type: 'maxwell', temperature: 293.6 },
                                particle: 'photon',
                                strength: 2.0
                            },
                            {
                                spatial: { type: 'point', origin: [0, 0, 0] },
                                energy: { type: 'watt', a: 0.988e6, b: 2.249e-6 },
                                particle: 'neutron',
                                strength: 1.0
                            }
                        ]
                    }
                ]
            },
            tallies: [{ id: 1, name: 'mesh-flux', scores: ['flux'], nuclides: [], filters: [{ type: 'mesh', bins: [7], meshId: 7 }] }],
            meshes: [{ type: 'regular', id: 7, lowerLeft: [-2, -2, -1], upperRight: [2, 2, 1], dimension: [2, 2, 1] }]
        };

        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: meshDir,
            files: { materials: true, geometry: true, settings: true, tallies: true, plots: false }
        });

        const settingsXml = fs.readFileSync(path.join(meshDir, 'settings.xml'), 'utf-8');
        // Mesh source element with computed total strength (1.0 + 1.5 + 2.0 + 1.0)
        expect(settingsXml).toContain('<source type="mesh" mesh="7" strength="5.5">');
        expect(settingsXml).toContain('<rejection_strategy>kill</rejection_strategy>');
        // Referenced mesh is emitted into settings.xml (settings.py _create_source_subelement)
        expect(settingsXml).toContain('<mesh id="7" type="regular">');
        // ... and NOT repeated in tallies.xml (mesh_memo pattern), even though a tally references it
        const talliesXml = fs.readFileSync(path.join(meshDir, 'tallies.xml'), 'utf-8');
        expect(talliesXml).not.toContain('<mesh id="7"');

        const backend = new OpenMCStudioBackendServiceImpl();
        const imported = await backend.importXML({ directory: meshDir });

        expect(imported.success).toBe(true);
        // Mesh source and its sub-sources survive the round trip
        expect(imported.state!.settings.sources).toEqual(state.settings.sources);
        // Mesh is recovered from settings.xml even though tallies.xml lacks it
        expect(imported.state!.meshes).toEqual(state.meshes);

        fs.rmSync(meshDir, { recursive: true, force: true });
    });

    it('round-trips per-tally triggers and run-level trigger settings', async () => {
        const triggerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-triggers-'));
        const now = new Date().toISOString();
        const state: OpenMCState = {
            metadata: { version: '1.1.0', name: 'Trigger Test', created: now, modified: now },
            geometry: {
                surfaces: [{ id: 1, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 10 }, boundary: 'vacuum' }],
                cells: [{ id: 1, fillType: 'material', fillId: 1, regionString: '-1' }],
                universes: [{ id: 0, name: 'root', cellIds: [1], isRoot: true }],
                lattices: [],
                rootUniverseId: 0
            },
            materials: [
                {
                    id: 1,
                    name: 'Water',
                    density: 1.0,
                    densityUnit: 'g/cm3',
                    nuclides: [{ name: 'H1', fraction: 2.0, fractionType: 'ao' }],
                    thermalScattering: []
                }
            ],
            settings: {
                run: { mode: 'eigenvalue', particles: 1000, inactive: 10, batches: 100 },
                sources: [],
                triggers: { maxBatches: 500, batchInterval: 10 }
            },
            tallies: [
                {
                    id: 1,
                    name: 'triggered',
                    scores: ['flux', 'fission'],
                    nuclides: [],
                    filters: [],
                    triggers: [
                        { type: 'rel_err', threshold: 0.01, scores: ['flux'], ignoreZeros: true },
                        { type: 'std_dev', threshold: 100 }
                    ]
                }
            ],
            meshes: []
        };

        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: triggerDir,
            files: { materials: true, geometry: true, settings: true, tallies: true, plots: false }
        });

        // Per-tally triggers (trigger.py: scores is a space-separated attribute)
        const talliesXml = fs.readFileSync(path.join(triggerDir, 'tallies.xml'), 'utf-8');
        expect(talliesXml).toContain('<trigger type="rel_err" threshold="0.01" scores="flux" ignore_zeros="true"/>');
        expect(talliesXml).toContain('<trigger type="std_dev" threshold="100"/>');

        // Run-level trigger block (settings.py _create_trigger_subelement)
        const settingsXml = fs.readFileSync(path.join(triggerDir, 'settings.xml'), 'utf-8');
        expect(settingsXml).toContain('<trigger>');
        expect(settingsXml).toContain('<active>true</active>');
        expect(settingsXml).toContain('<max_batches>500</max_batches>');
        expect(settingsXml).toContain('<batch_interval>10</batch_interval>');

        const backend = new OpenMCStudioBackendServiceImpl();
        const imported = await backend.importXML({ directory: triggerDir });

        expect(imported.success).toBe(true);
        expect(imported.state!.settings.triggers).toEqual(state.settings.triggers);
        expect(imported.state!.tallies[0].triggers).toEqual(state.tallies[0].triggers);

        fs.rmSync(triggerDir, { recursive: true, force: true });
    });

    it('emits trigger activation automatically when a tally has triggers', async () => {
        const autoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-triggers-auto-'));
        const state = buildTalliesTestState();
        state.tallies[0] = {
            ...state.tallies[0],
            triggers: [{ type: 'variance', threshold: 1e-4 }]
        };

        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: autoDir,
            files: { materials: true, geometry: true, settings: true, tallies: true, plots: false }
        });

        // No run-level fields set: activation still emitted so the per-tally
        // trigger is actually evaluated; no max_batches/batch_interval elements
        const settingsXml = fs.readFileSync(path.join(autoDir, 'settings.xml'), 'utf-8');
        expect(settingsXml).toContain('<active>true</active>');
        expect(settingsXml).not.toContain('<max_batches>');

        const backend = new OpenMCStudioBackendServiceImpl();
        const imported = await backend.importXML({ directory: autoDir });
        expect(imported.state!.tallies[0].triggers).toEqual([{ type: 'variance', threshold: 1e-4 }]);

        fs.rmSync(autoDir, { recursive: true, force: true });
    });

    it('round-trips tally derivatives (top-level elements + ID references)', async () => {
        const derivDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-deriv-'));
        const state = buildTalliesTestState();
        state.tallies[0] = {
            ...state.tallies[0],
            derivative: { variable: 'density', materialId: 1 }
        };
        state.tallies[1] = {
            ...state.tallies[1],
            derivative: { variable: 'nuclide_density', materialId: 1, nuclide: 'U235' }
        };

        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: derivDir,
            files: { materials: true, geometry: true, settings: true, tallies: true, plots: false }
        });

        const xml = fs.readFileSync(path.join(derivDir, 'tallies.xml'), 'utf-8');
        // Top-level derivative elements (tally_derivative.py to_xml_element)
        expect(xml).toContain('<derivative id="1" variable="density" material="1"/>');
        expect(xml).toContain('<derivative id="2" variable="nuclide_density" material="1" nuclide="U235"/>');
        // Tally references (text sub-elements carrying the derivative ID)
        expect(xml).toContain('<derivative>1</derivative>');
        expect(xml).toContain('<derivative>2</derivative>');

        const backend = new OpenMCStudioBackendServiceImpl();
        const imported = await backend.importXML({ directory: derivDir });

        expect(imported.success).toBe(true);
        expect(imported.state!.tallies[0].derivative).toEqual({ id: 1, variable: 'density', materialId: 1 });
        expect(imported.state!.tallies[1].derivative).toEqual({ id: 2, variable: 'nuclide_density', materialId: 1, nuclide: 'U235' });

        fs.rmSync(derivDir, { recursive: true, force: true });
    });

    it('round-trips muir energy as a normal distribution (this version has no muir XML type)', async () => {
        const muirDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-muir-'));
        const state = buildTestState();
        state.settings.sources = [
            {
                spatial: { type: 'point', origin: [0, 0, 0] },
                energy: { type: 'muir', e0: 14.08e6, m_rat: 5.0, kt: 20000 },
                particle: 'neutron',
                strength: 1.0
            }
        ];

        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: muirDir,
            files: { materials: true, geometry: true, settings: true, tallies: false, plots: false }
        });

        // muir() returns a Normal in this OpenMC version: std = sqrt(2*e0*kt/m_rat)
        const expectedStd = Math.sqrt((2 * 14.08e6 * 20000) / 5.0);
        const settingsXml = fs.readFileSync(path.join(muirDir, 'settings.xml'), 'utf-8');
        expect(settingsXml).toContain('<energy type="normal">');
        expect(settingsXml).toContain(`<parameters>${14.08e6} ${expectedStd}</parameters>`);
        expect(settingsXml).not.toContain('type="muir"');

        const backend = new OpenMCStudioBackendServiceImpl();
        const imported = await backend.importXML({ directory: muirDir });
        expect(imported.success).toBe(true);
        const energy = (imported.state!.settings.sources[0] as { energy: unknown }).energy as {
            type: string;
            mean: number;
            stdDev: number;
        };
        expect(energy).toEqual({ type: 'normal', mean: 14.08e6, stdDev: expectedStd });

        fs.rmSync(muirDir, { recursive: true, force: true });
    });

    it('parses legacy muir XML into normal form (backward compat)', async () => {
        const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-muir-legacy-'));
        const state = buildTestState();
        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: legacyDir,
            files: { materials: true, geometry: true, settings: true, tallies: false, plots: false }
        });

        // Rewrite the source's energy element as a legacy muir element
        const settingsPath = path.join(legacyDir, 'settings.xml');
        let settingsXml = fs.readFileSync(settingsPath, 'utf-8');
        settingsXml = settingsXml.replace(
            /<energy type="discrete">[\s\S]*?<\/energy>/,
            '<energy type="muir">\n      <parameters>14080000 5.0 20000</parameters>\n    </energy>'
        );
        fs.writeFileSync(settingsPath, settingsXml);

        const backend = new OpenMCStudioBackendServiceImpl();
        const imported = await backend.importXML({ directory: legacyDir });
        expect(imported.success).toBe(true);
        const energy = (imported.state!.settings.sources[0] as { energy: unknown }).energy as {
            type: string;
            mean: number;
            stdDev: number;
        };
        expect(energy.type).toBe('normal');
        expect(energy.mean).toBe(14.08e6);
        expect(energy.stdDev).toBeCloseTo(Math.sqrt((2 * 14.08e6 * 20000) / 5.0), 3);

        fs.rmSync(legacyDir, { recursive: true, force: true });
    });

    it('round-trips a TokamakSource (geometry, profile, energy, constraints)', async () => {
        const tokamakDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-tokamak-'));
        const now = new Date().toISOString();
        const tokamakSource = {
            type: 'tokamak' as const,
            majorRadius: 600,
            minorRadius: 200,
            elongation: 1.7,
            triangularity: 0.33,
            shafranovShift: 30,
            verticalShift: 25,
            phiStart: 0,
            phiExtent: 2 * Math.PI,
            nAlpha: 101,
            strength: 2.0,
            constraints: { rejectionStrategy: 'kill' as const },
            profile: [
                { r: 0, s: 1 },
                { r: 0.5, s: 0.8 },
                { r: 1, s: 0 }
            ],
            energy: { type: 'uniform' as const, min: 13e6, max: 15e6 },
            time: { type: 'delta' as const, params: { time: 1e-6 } }
        };
        const state: OpenMCState = {
            metadata: { version: '1.1.0', name: 'Tokamak Source Test', created: now, modified: now },
            geometry: {
                surfaces: [{ id: 1, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 1000 }, boundary: 'vacuum' }],
                cells: [{ id: 1, fillType: 'material', fillId: 1, regionString: '-1' }],
                universes: [{ id: 0, name: 'root', cellIds: [1], isRoot: true }],
                lattices: [],
                rootUniverseId: 0
            },
            materials: [
                {
                    id: 1,
                    name: 'DT',
                    density: 1.0,
                    densityUnit: 'g/cm3',
                    nuclides: [{ name: 'H3', fraction: 1.0, fractionType: 'ao' }],
                    thermalScattering: []
                }
            ],
            settings: {
                run: { mode: 'fixed source', particles: 1000, batches: 10 },
                sources: [tokamakSource]
            },
            tallies: [],
            meshes: []
        };

        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: tokamakDir,
            files: { materials: true, geometry: true, settings: true, tallies: false, plots: false },
            // TokamakSource is gated on 0.15.4+ — mark the env as supporting it
            randomRayCompat: { raySourceFormat: 'direct', adjointSource: false, tokamakSource: true, s2SampleMethod: true }
        });

        const settingsXml = fs.readFileSync(path.join(tokamakDir, 'settings.xml'), 'utf-8');
        // Verified format (source.py TokamakSource.populate_xml_element)
        expect(settingsXml).toContain('<source type="tokamak" strength="2">');
        expect(settingsXml).toContain('<major_radius>600</major_radius>');
        expect(settingsXml).toContain('<minor_radius>200</minor_radius>');
        expect(settingsXml).toContain('<elongation>1.7</elongation>');
        expect(settingsXml).toContain('<triangularity>0.33</triangularity>');
        expect(settingsXml).toContain('<shafranov_shift>30</shafranov_shift>');
        expect(settingsXml).toContain('<vertical_shift>25</vertical_shift>');
        expect(settingsXml).toContain('<r_over_a>0 0.5 1</r_over_a>');
        expect(settingsXml).toContain('<emission_density>1 0.8 0</emission_density>');
        expect(settingsXml).toContain('<n_alpha>101</n_alpha>');
        expect(settingsXml).toContain('<rejection_strategy>kill</rejection_strategy>');
        expect(settingsXml).toContain('<time type="discrete">');
        expect(settingsXml).toContain('<parameters>0.000001 1</parameters>');

        const backend = new OpenMCStudioBackendServiceImpl();
        const imported = await backend.importXML({ directory: tokamakDir });

        expect(imported.success).toBe(true);
        expect(imported.state!.settings.sources).toEqual([tokamakSource]);

        fs.rmSync(tokamakDir, { recursive: true, force: true });
    });

    it('omits vertical_shift for tokamak sources when zero (matches OpenMC export)', async () => {
        const tokamakDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-tokamak-zero-'));
        const state = buildTestState();
        state.settings.sources = [
            {
                type: 'tokamak',
                majorRadius: 600,
                minorRadius: 200,
                elongation: 1.7,
                triangularity: 0.33,
                shafranovShift: 30,
                profile: [
                    { r: 0, s: 1 },
                    { r: 1, s: 0 }
                ],
                energy: { type: 'discrete', energies: [14.1e6], probabilities: [1] }
            }
        ];

        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: tokamakDir,
            files: { materials: true, geometry: true, settings: true, tallies: false, plots: false },
            randomRayCompat: { raySourceFormat: 'direct', adjointSource: false, tokamakSource: true, s2SampleMethod: true }
        });

        const settingsXml = fs.readFileSync(path.join(tokamakDir, 'settings.xml'), 'utf-8');
        expect(settingsXml).toContain('<source type="tokamak">');
        expect(settingsXml).not.toContain('<vertical_shift>');

        fs.rmSync(tokamakDir, { recursive: true, force: true });
    });

    it('drops tokamak sources with a warning on envs without TokamakSource (release 0.15.3)', async () => {
        const tokamakDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-tokamak-gated-'));
        const state = buildTestState();
        state.settings.sources = [
            {
                type: 'tokamak',
                majorRadius: 600,
                minorRadius: 200,
                elongation: 1.7,
                triangularity: 0.33,
                shafranovShift: 30,
                profile: [
                    { r: 0, s: 1 },
                    { r: 1, s: 0 }
                ],
                energy: { type: 'discrete', energies: [14.1e6], probabilities: [1] }
            }
        ];

        const generator = new XMLGenerationService();
        // No randomRayCompat — default is the release profile (no TokamakSource)
        const result = await generator.generateXML({
            state,
            outputDirectory: tokamakDir,
            files: { materials: true, geometry: true, settings: true, tallies: false, plots: false }
        });

        const settingsXml = fs.readFileSync(path.join(tokamakDir, 'settings.xml'), 'utf-8');
        expect(settingsXml).not.toContain('type="tokamak"');
        expect(result.warnings?.some((w) => w.includes('Tokamak source requires OpenMC >= 0.15.4'))).toBe(true);

        fs.rmSync(tokamakDir, { recursive: true, force: true });
    });

    it("falls back from sample_method 's2' to 'halton' with a warning on unsupported envs", async () => {
        const s2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-s2-gated-'));
        const state = buildTestState();
        state.settings.energyMode = 'multigroup';
        state.settings.mgxsLibrary = '/data/mgxs.h5';
        state.settings.randomRay = {
            distanceInactive: 50,
            distanceActive: 250,
            sampleMethod: 's2',
            raySource: { lowerLeft: [-1, -1, -1], upperRight: [1, 1, 1] }
        };

        const generator = new XMLGenerationService();
        const gated = await generator.generateXML({
            state,
            outputDirectory: s2Dir,
            files: { materials: false, geometry: false, settings: true, tallies: false, plots: false }
        });
        let settingsXml = fs.readFileSync(path.join(s2Dir, 'settings.xml'), 'utf-8');
        expect(settingsXml).toContain('<sample_method>halton</sample_method>');
        expect(settingsXml).not.toContain('<sample_method>s2</sample_method>');
        expect(gated.warnings?.some((w) => w.includes("'s2' is not supported"))).toBe(true);

        // Supported env emits s2 as configured
        const supported = await generator.generateXML({
            state,
            outputDirectory: s2Dir,
            files: { materials: false, geometry: false, settings: true, tallies: false, plots: false },
            randomRayCompat: { raySourceFormat: 'direct', adjointSource: false, tokamakSource: false, s2SampleMethod: true }
        });
        settingsXml = fs.readFileSync(path.join(s2Dir, 'settings.xml'), 'utf-8');
        expect(settingsXml).toContain('<sample_method>s2</sample_method>');
        expect(supported.warnings?.some((w) => w.includes("'s2'"))).toBeFalsy();

        fs.rmSync(s2Dir, { recursive: true, force: true });
    });

    it('emits the MGXS library reference into materials.xml (first child) and parses it back', async () => {
        const state = buildTestState();
        state.settings.energyMode = 'multigroup';
        state.settings.mgxsLibrary = '/data/mgxs.h5';

        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: tempDir,
            files: { materials: true, geometry: true, settings: true, tallies: false, plots: false }
        });

        const materialsXml = fs.readFileSync(path.join(tempDir, 'materials.xml'), 'utf-8');
        expect(materialsXml).toContain('<cross_sections>/data/mgxs.h5</cross_sections>');
        // First child of <materials> (openmc.Materials.cross_sections export format)
        expect(materialsXml.indexOf('<cross_sections>')).toBeLessThan(materialsXml.indexOf('<material '));
        // The deprecated settings.xml element is kept for older OpenMC versions
        const settingsXml = fs.readFileSync(path.join(tempDir, 'settings.xml'), 'utf-8');
        expect(settingsXml).toContain('<cross_sections>/data/mgxs.h5</cross_sections>');

        const backend = new OpenMCStudioBackendServiceImpl();
        const imported = await backend.importXML({ directory: tempDir });
        expect(imported.success).toBe(true);
        expect(imported.state!.settings.mgxsLibrary).toBe('/data/mgxs.h5');
    });

    it('resolves a legacy randomRay.mgxsLibraryPath directory to the mgxs.h5 inside it', async () => {
        const state = buildTestState();
        state.settings.energyMode = 'multigroup';
        state.settings.mgxsLibrary = undefined;
        state.settings.randomRay = { mgxsLibraryPath: '/data/MGXS' };

        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: tempDir,
            files: { materials: true, geometry: false, settings: true, tallies: false, plots: false }
        });

        const materialsXml = fs.readFileSync(path.join(tempDir, 'materials.xml'), 'utf-8');
        expect(materialsXml).toContain('<cross_sections>/data/MGXS/mgxs.h5</cross_sections>');
        const settingsXml = fs.readFileSync(path.join(tempDir, 'settings.xml'), 'utf-8');
        expect(settingsXml).toContain('<cross_sections>/data/MGXS/mgxs.h5</cross_sections>');
    });

    it('keeps an extension-less library FILE path as-is (fs-aware resolution)', async () => {
        // The legacy path in the wild is an HDF5 file without .h5 extension
        const fakeLib = path.join(tempDir, 'MGXS');
        fs.writeFileSync(fakeLib, 'not really hdf5');
        const state = buildTestState();
        state.settings.energyMode = 'multigroup';
        state.settings.mgxsLibrary = fakeLib;

        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: tempDir,
            files: { materials: true, geometry: false, settings: true, tallies: false, plots: false }
        });

        const materialsXml = fs.readFileSync(path.join(tempDir, 'materials.xml'), 'utf-8');
        expect(materialsXml).toContain(`<cross_sections>${fakeLib}</cross_sections>`);
        expect(materialsXml).not.toContain('MGXS/mgxs.h5');
    });

    it('resolves a relative MGXS library path against the output directory', async () => {
        const state = buildTestState();
        state.settings.energyMode = 'multigroup';
        state.settings.mgxsLibrary = 'mgxs.h5';

        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: tempDir,
            files: { materials: true, geometry: false, settings: false, tallies: false, plots: false }
        });

        const materialsXml = fs.readFileSync(path.join(tempDir, 'materials.xml'), 'utf-8');
        expect(materialsXml).toContain(`<cross_sections>${path.join(tempDir, 'mgxs.h5')}</cross_sections>`);
    });

    it('import: materials.xml cross_sections fills mgxsLibrary only when settings.xml lacks it', async () => {
        // No settings value → materials.xml reference wins
        fs.writeFileSync(
            path.join(tempDir, 'materials.xml'),
            `<?xml version="1.0"?>\n<materials>\n  <cross_sections>/data/from-materials.h5</cross_sections>\n</materials>\n`
        );
        fs.writeFileSync(
            path.join(tempDir, 'settings.xml'),
            `<?xml version="1.0"?>\n<settings>\n  <run_mode>eigenvalue</run_mode>\n  <particles>100</particles>\n  <batches>10</batches>\n  <inactive>5</inactive>\n</settings>\n`
        );
        const backend = new OpenMCStudioBackendServiceImpl();
        let imported = await backend.importXML({ directory: tempDir });
        expect(imported.success).toBe(true);
        expect(imported.state!.settings.mgxsLibrary).toBe('/data/from-materials.h5');

        // settings.xml value takes precedence over materials.xml
        fs.writeFileSync(
            path.join(tempDir, 'settings.xml'),
            `<?xml version="1.0"?>\n<settings>\n  <run_mode>eigenvalue</run_mode>\n  <particles>100</particles>\n  <batches>10</batches>\n  <inactive>5</inactive>\n  <energy_mode>multi-group</energy_mode>\n  <cross_sections>/data/from-settings.h5</cross_sections>\n</settings>\n`
        );
        imported = await backend.importXML({ directory: tempDir });
        expect(imported.success).toBe(true);
        expect(imported.state!.settings.mgxsLibrary).toBe('/data/from-settings.h5');
    });

    it('skips auto-generated IFP tallies with a warning in multi-group mode', async () => {
        const state = buildTestState();
        state.settings.energyMode = 'multigroup';
        state.settings.mgxsLibrary = '/data/mgxs.h5';
        state.settings.kinetics = { enabled: true, ifpNGenerations: 4 };

        const generator = new XMLGenerationService();
        const result = await generator.generateXML({
            state,
            outputDirectory: tempDir,
            files: { materials: false, geometry: false, settings: true, tallies: true, plots: false }
        });

        const talliesXml = fs.readFileSync(path.join(tempDir, 'tallies.xml'), 'utf-8');
        expect(talliesXml).not.toContain('ifp-');
        expect(result.warnings?.some((w) => w.includes('IFP kinetics is not supported in random ray mode'))).toBe(true);

        // Continuous-energy control: IFP tallies ARE emitted
        state.settings.energyMode = undefined;
        const ceResult = await generator.generateXML({
            state,
            outputDirectory: tempDir,
            files: { materials: false, geometry: false, settings: false, tallies: true, plots: false }
        });
        const ceTalliesXml = fs.readFileSync(path.join(tempDir, 'tallies.xml'), 'utf-8');
        expect(ceTalliesXml).toContain('ifp-denominator');
        expect(ceResult.warnings?.some((w) => w.includes('IFP kinetics'))).toBeFalsy();
    });

    it('emits a mesh shared by settings-level features and tallies exactly once (settings.xml wins)', async () => {
        const state = buildTestState();
        state.meshes = [{ type: 'regular', id: 5, lowerLeft: [-5, -5, -5], upperRight: [5, 5, 5], dimension: [2, 2, 2] }];
        state.varianceReduction = {
            weightWindows: { meshId: 5, lowerBound: 0.5, upperBound: 1, particleType: 'neutron', energyBounds: [0, 1e4, 2e7] }
        };
        state.tallies = [{ id: 1, name: 'mesh-flux', scores: ['flux'], nuclides: [], filters: [{ type: 'mesh', bins: [5], meshId: 5 }] }];

        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: tempDir,
            files: { materials: true, geometry: true, settings: true, tallies: true, plots: false }
        });

        const settingsXml = fs.readFileSync(path.join(tempDir, 'settings.xml'), 'utf-8');
        const talliesXml = fs.readFileSync(path.join(tempDir, 'tallies.xml'), 'utf-8');
        expect(settingsXml).toContain('<mesh id="5" type="regular">');
        // tallies.xml must not repeat the id ('Mesh with ID=5 appears in multiple files')
        expect(talliesXml).not.toContain('<mesh id="5"');
        // The tally still references the mesh via its filter
        expect(talliesXml).toContain('type="mesh"');
    });

    it('round-trips the advanced scalar settings sweep (P6F)', async () => {
        const advancedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-advanced-'));
        const state = buildTestState();
        state.settings.eventBased = true;
        state.settings.probabilityTables = false;
        state.settings.maxLostParticles = 500;
        state.settings.relLostParticleRate = 1e-4;
        state.settings.createFissionNeutrons = false;
        state.settings.createDelayedNeutrons = true;
        state.settings.delayedPhotonScaling = false;
        state.settings.useDecayPhotons = true;
        state.settings.logGridBins = 4000;
        state.settings.survivalBiasing = false;
        state.settings.generationsPerBatch = 5;
        state.settings.maxOrder = 10;
        state.settings.writeInitialSource = true;
        state.settings.uniformSourceSampling = true;
        state.settings.tabularLegendre = { enable: true, numPoints: 64 };

        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: advancedDir,
            files: { materials: true, geometry: true, settings: true, tallies: false, plots: false }
        });

        const settingsXml = fs.readFileSync(path.join(advancedDir, 'settings.xml'), 'utf-8');
        // Verified element names (settings.py _create_*_subelement)
        expect(settingsXml).toContain('<event_based>true</event_based>');
        expect(settingsXml).toContain('<ptables>false</ptables>');
        expect(settingsXml).toContain('<max_lost_particles>500</max_lost_particles>');
        expect(settingsXml).toContain('<rel_max_lost_particles>0.0001</rel_max_lost_particles>');
        expect(settingsXml).toContain('<create_fission_neutrons>false</create_fission_neutrons>');
        expect(settingsXml).toContain('<create_delayed_neutrons>true</create_delayed_neutrons>');
        expect(settingsXml).toContain('<delayed_photon_scaling>false</delayed_photon_scaling>');
        expect(settingsXml).toContain('<use_decay_photons>true</use_decay_photons>');
        expect(settingsXml).toContain('<log_grid_bins>4000</log_grid_bins>');
        expect(settingsXml).toContain('<survival_biasing>false</survival_biasing>');
        expect(settingsXml).toContain('<generations_per_batch>5</generations_per_batch>');
        expect(settingsXml).toContain('<max_order>10</max_order>');
        expect(settingsXml).toContain('<write_initial_source>true</write_initial_source>');
        expect(settingsXml).toContain('<uniform_source_sampling>true</uniform_source_sampling>');
        expect(settingsXml).toContain('<tabular_legendre>');
        expect(settingsXml).toContain('<enable>true</enable>');
        expect(settingsXml).toContain('<num_points>64</num_points>');

        const backend = new OpenMCStudioBackendServiceImpl();
        const imported = await backend.importXML({ directory: advancedDir });

        expect(imported.success).toBe(true);
        const imported2 = imported.state!.settings;
        expect(imported2.eventBased).toBe(true);
        expect(imported2.probabilityTables).toBe(false);
        expect(imported2.maxLostParticles).toBe(500);
        expect(imported2.relLostParticleRate).toBeCloseTo(1e-4);
        expect(imported2.createFissionNeutrons).toBe(false);
        expect(imported2.createDelayedNeutrons).toBe(true);
        expect(imported2.delayedPhotonScaling).toBe(false);
        expect(imported2.useDecayPhotons).toBe(true);
        expect(imported2.logGridBins).toBe(4000);
        expect(imported2.survivalBiasing).toBe(false);
        expect(imported2.generationsPerBatch).toBe(5);
        expect(imported2.maxOrder).toBe(10);
        expect(imported2.writeInitialSource).toBe(true);
        expect(imported2.uniformSourceSampling).toBe(true);
        expect(imported2.tabularLegendre).toEqual({ enable: true, numPoints: 64 });

        fs.rmSync(advancedDir, { recursive: true, force: true });
    });

    it('omits advanced scalar settings when unset (backward compatible output)', async () => {
        const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-advanced-off-'));
        const state = buildTestState();

        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: plainDir,
            files: { materials: true, geometry: true, settings: true, tallies: false, plots: false }
        });

        const settingsXml = fs.readFileSync(path.join(plainDir, 'settings.xml'), 'utf-8');
        for (const element of [
            'event_based',
            'ptables',
            'max_lost_particles',
            'rel_max_lost_particles',
            'create_fission_neutrons',
            'create_delayed_neutrons',
            'delayed_photon_scaling',
            'use_decay_photons',
            'log_grid_bins',
            'survival_biasing',
            'generations_per_batch',
            'max_order',
            'write_initial_source',
            'uniform_source_sampling',
            'tabular_legendre'
        ]) {
            expect(settingsXml).not.toContain(`<${element}>`);
        }

        fs.rmSync(plainDir, { recursive: true, force: true });
    });

    it('round-trips all plot types through plots.xml', async () => {
        const state = buildPlotsTestState();
        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: tempDir,
            files: { materials: true, geometry: true, settings: true, tallies: false, plots: true }
        });

        const xml = fs.readFileSync(path.join(tempDir, 'plots.xml'), 'utf-8');
        // Slice with real OpenMC 2-value width
        expect(xml).toContain('type="slice"');
        expect(xml).toContain('<width>20 30</width>');
        expect(xml).toContain('<meshlines meshtype="tally"/>');
        // Voxel with center origin + 3-value width
        expect(xml).toContain('type="voxel"');
        expect(xml).toContain('<origin>0 0 0</origin>');
        expect(xml).toContain('<width>8 12 16</width>');
        expect(xml).toContain('<pixels>10 20 30</pixels>');
        // Ray-trace plots
        expect(xml).toContain('type="solid_raytrace"');
        expect(xml).toContain('<camera_position>10 10 10</camera_position>');
        expect(xml).toContain('<horizontal_field_of_view>50</horizontal_field_of_view>');
        expect(xml).toContain('<orthographic_width>25</orthographic_width>');
        expect(xml).toContain('<light_position>5 5 5</light_position>');
        expect(xml).toContain('<diffuse_fraction>0.3</diffuse_fraction>');
        expect(xml).toContain('<opaque_ids>1 2</opaque_ids>');
        expect(xml).toContain('type="wireframe_raytrace"');
        expect(xml).toContain('<wireframe_thickness>2</wireframe_thickness>');
        expect(xml).toContain('<wireframe_color>255 0 0</wireframe_color>');
        expect(xml).toContain('<wireframe_ids>1</wireframe_ids>');

        const backend = new OpenMCStudioBackendServiceImpl();
        const imported = await backend.importXML({ directory: tempDir });

        expect(imported.success).toBe(true);
        expect(imported.state!.plots).toEqual(state.plots);
    });

    it('auto-appends IFP tallies and ifp_n_generation when kinetics are enabled', async () => {
        const state = buildTestState();
        state.settings.kinetics = { enabled: true, ifpNGenerations: 4, numPrecursorGroups: 6 };
        state.tallies = [];

        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: tempDir,
            files: { materials: true, geometry: true, settings: true, tallies: true, plots: false }
        });

        const settingsXml = fs.readFileSync(path.join(tempDir, 'settings.xml'), 'utf-8');
        expect(settingsXml).toContain('<ifp_n_generation>4</ifp_n_generation>');

        const talliesXml = fs.readFileSync(path.join(tempDir, 'tallies.xml'), 'utf-8');
        expect(talliesXml).toContain('<scores>ifp-time-numerator</scores>');
        expect(talliesXml).toContain('<scores>ifp-beta-numerator</scores>');
        expect(talliesXml).toContain('<scores>ifp-denominator</scores>');
        expect(talliesXml).toContain('type="delayedgroup"');
        expect(talliesXml).toContain('<bins>1 2 3 4 5 6</bins>');
    });

    it('does not duplicate IFP tallies the user already defined', async () => {
        const state = buildTestState();
        state.settings.kinetics = { enabled: true, ifpNGenerations: 2 };
        state.tallies = [{ id: 1, name: 'My IFP denom', scores: ['ifp-denominator'], nuclides: [], filters: [] }];

        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: tempDir,
            files: { materials: true, geometry: true, settings: true, tallies: true, plots: false }
        });

        const talliesXml = fs.readFileSync(path.join(tempDir, 'tallies.xml'), 'utf-8');
        expect((talliesXml.match(/ifp-denominator/g) || []).length).toBe(1);
        expect((talliesXml.match(/ifp-time-numerator/g) || []).length).toBe(1);
        expect((talliesXml.match(/ifp-beta-numerator/g) || []).length).toBe(1);
    });

    it('round-trips kinetics settings and IFP tallies through importXML', async () => {
        const state = buildTestState();
        state.settings.kinetics = { enabled: true, ifpNGenerations: 4, numPrecursorGroups: 6 };
        state.tallies = [];

        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: tempDir,
            files: { materials: true, geometry: true, settings: true, tallies: true, plots: false }
        });

        const backend = new OpenMCStudioBackendServiceImpl();
        const imported = await backend.importXML({ directory: tempDir });

        expect(imported.success).toBe(true);

        // Kinetics settings derived from settings.xml + IFP tallies
        expect(imported.state!.settings.kinetics).toEqual({
            enabled: true,
            ifpNGenerations: 4,
            numPrecursorGroups: 6,
            computeBetaEff: true,
            computeGenerationTime: true
        });

        // The three auto-generated IFP tallies came back as regular tallies
        const ifpScores = imported.state!.tallies.map((t) => t.scores[0]);
        expect(ifpScores).toContain('ifp-time-numerator');
        expect(ifpScores).toContain('ifp-beta-numerator');
        expect(ifpScores).toContain('ifp-denominator');

        const betaTally = imported.state!.tallies.find((t) => t.scores.includes('ifp-beta-numerator'));
        expect(betaTally?.filters).toEqual([{ type: 'delayedgroup', bins: [1, 2, 3, 4, 5, 6] }]);
    });

    it('round-trips advanced depletion config through the settings.xml depletion block', async () => {
        const state = buildTestState();
        state.depletion = {
            enabled: true,
            chainFile: '/chains/chain_endfb71.xml',
            timeSteps: [86400, 86400],
            power: 1e6,
            operator: 'independent',
            solver: 'cecm',
            normalizationMode: 'fission-q',
            diffBurnableMats: true,
            diffVolumeMethod: 'match cell',
            fluxFiles: ['/data/flux_1.npy', '/data/flux_2.npy'],
            microxsFiles: ['/data/micro_1.csv', '/data/micro_2.csv'],
            generateFromModel: true,
            transferRates: [
                { material: 1, element: 'U', rate: 1e-5, units: '1/s', destinationMaterial: 2 },
                { material: 2, element: 'Gd155', rate: -2e-6 }
            ],
            fissionQ: { U235: 2.02e8, Pu239: 2.1e8 }
        };

        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: tempDir,
            files: { materials: true, geometry: true, settings: true, tallies: false, plots: false }
        });

        const xml = fs.readFileSync(path.join(tempDir, 'settings.xml'), 'utf-8');
        expect(xml).toContain('<operator>independent</operator>');
        expect(xml).toContain('<solver>cecm</solver>');
        expect(xml).toContain('<normalization>fission-q</normalization>');
        expect(xml).toContain('<diff_burnable_mats>true</diff_burnable_mats>');
        expect(xml).toContain('<diff_volume_method>match cell</diff_volume_method>');
        expect(xml).toContain('<flux_files>/data/flux_1.npy,/data/flux_2.npy</flux_files>');
        expect(xml).toContain('<microxs_files>/data/micro_1.csv,/data/micro_2.csv</microxs_files>');
        expect(xml).toContain('<generate_microxs>true</generate_microxs>');

        // Parse the depletion block back through the runner's checkDepletionEnabled
        const runner = new OpenMCRunnerService();
        const depletionCheck = await (runner as any).checkDepletionEnabled(tempDir);

        expect(depletionCheck.enabled).toBe(true);
        expect(depletionCheck.settings.chainFile).toBe('/chains/chain_endfb71.xml');
        expect(depletionCheck.settings.timeSteps).toEqual([86400, 86400]);
        expect(depletionCheck.settings.operator).toBe('independent');
        expect(depletionCheck.settings.solver).toBe('cecm');
        expect(depletionCheck.settings.normalization).toBe('fission-q');
        expect(depletionCheck.settings.diffBurnableMats).toBe(true);
        expect(depletionCheck.settings.diffVolumeMethod).toBe('match cell');
        expect(depletionCheck.settings.fluxFiles).toEqual(['/data/flux_1.npy', '/data/flux_2.npy']);
        expect(depletionCheck.settings.microxsFiles).toEqual(['/data/micro_1.csv', '/data/micro_2.csv']);
        expect(depletionCheck.settings.generateFromModel).toBe(true);
        expect(depletionCheck.settings.transferRates).toEqual([
            { material: 1, element: 'U', rate: 1e-5, units: '1/s', destinationMaterial: 2 },
            { material: 2, element: 'Gd155', rate: -2e-6 }
        ]);
        expect(depletionCheck.settings.fissionQ).toEqual({ U235: 2.02e8, Pu239: 2.1e8 });
    });

    it('maps legacy depletion solver names to canonical integrator ids', async () => {
        // Emission: legacy stored value writes the canonical id
        const state = buildTestState();
        state.depletion = {
            enabled: true,
            chainFile: '/chains/chain_endfb71.xml',
            timeSteps: [86400],
            power: 1e6,
            solver: 'leapfrog' as any
        };
        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: tempDir,
            files: { materials: false, geometry: false, settings: true, tallies: false, plots: false }
        });
        const xml = fs.readFileSync(path.join(tempDir, 'settings.xml'), 'utf-8');
        expect(xml).toContain('<solver>leqi</solver>');
        expect(xml).not.toContain('leapfrog');

        // Import: the runner's depletion-block parse maps aliases too
        const runner = new OpenMCRunnerService();
        const depletionCheck = await (runner as any).checkDepletionEnabled(tempDir);
        expect(depletionCheck.settings.solver).toBe('leqi');
    });

    it('maps every legacy solver alias through resolveDepletionSolver', async () => {
        expect(resolveDepletionSolver('leapfrog')).toBe('leqi');
        expect(resolveDepletionSolver('predictor-corrector')).toBe('predictor');
        expect(resolveDepletionSolver('si-rk4')).toBe('si_celi');
        expect(resolveDepletionSolver('epc')).toBe('epc_rk4');
        expect(resolveDepletionSolver('cecmr')).toBe('cecm');
        expect(resolveDepletionSolver('epcr')).toBe('epc_rk4');
        expect(resolveDepletionSolver('si-cesc')).toBe('si_celi');
        // Canonical ids and unknown values
        expect(resolveDepletionSolver('si_leqi')).toBe('si_leqi');
        expect(resolveDepletionSolver(undefined)).toBe('cecm');
        expect(resolveDepletionSolver('bogus')).toBe('cecm');
    });

    it('round-trips macroscopic (multigroup) materials through materials.xml', async () => {
        const state = buildTestState();
        state.materials.push({
            id: 2,
            name: 'UO2 Macro',
            density: 10.0,
            densityUnit: 'g/cm3',
            nuclides: [],
            thermalScattering: [],
            macroscopic: { name: 'UO2' },
            temperature: 600
        });

        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: tempDir,
            files: { materials: true, geometry: true, settings: true, tallies: false, plots: false }
        });

        const xml = fs.readFileSync(path.join(tempDir, 'materials.xml'), 'utf-8');
        expect(xml).toContain('<macroscopic name="UO2"/>');

        // The macroscopic material must not carry nuclide elements
        const macroMatch = xml.match(/<material id="2"[\s\S]*?<\/material>/);
        expect(macroMatch).not.toBeNull();
        expect(macroMatch![0]).not.toContain('<nuclide');

        const backend = new OpenMCStudioBackendServiceImpl();
        const imported = await backend.importXML({ directory: tempDir });

        expect(imported.success).toBe(true);
        expect(imported.state!.materials).toEqual(state.materials);
    });

    it('round-trips random ray settings, energy mode, and fixed-source inactive', async () => {
        const state = buildTestState();
        state.settings.run = { mode: 'fixed source', particles: 10000, batches: 50, inactive: 10 };
        state.settings.energyMode = 'multigroup';
        state.settings.mgxsLibrary = '/data/mgxs.h5';
        state.settings.randomRay = {
            distanceInactive: 50,
            distanceActive: 250,
            sourceShape: 'linear',
            volumeEstimator: 'naive',
            volumeNormalizedFluxTallies: true,
            sampleMethod: 'halton',
            diagonalStabilizationRho: 0.5,
            adjoint: true,
            sourceRegionMeshId: 5,
            sourceRegionDomainType: 'cell',
            sourceRegionDomainIds: [1],
            raySource: { lowerLeft: [-10, -10, -10], upperRight: [10, 10, 10] },
            adjointSource: { lowerLeft: [-5, -5, -5], upperRight: [5, 5, 5] }
        };
        state.meshes = [{ type: 'regular', id: 5, lowerLeft: [-10, -10, -10], upperRight: [10, 10, 10], dimension: [5, 5, 5] }];

        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: tempDir,
            files: { materials: true, geometry: true, settings: true, tallies: false, plots: false },
            // Post-0.15.3 dev format: wrapped <ray_source> + <adjoint_source>
            randomRayCompat: { raySourceFormat: 'wrapper', adjointSource: true, tokamakSource: true, s2SampleMethod: true }
        });

        const xml = fs.readFileSync(path.join(tempDir, 'settings.xml'), 'utf-8');
        expect(xml).toContain('<energy_mode>multi-group</energy_mode>');
        expect(xml).toContain('<cross_sections>/data/mgxs.h5</cross_sections>');
        expect(xml).toContain('<inactive>10</inactive>');
        expect(xml).toContain('<random_ray>');
        expect(xml).toContain('<distance_inactive>50</distance_inactive>');
        expect(xml).toContain('<distance_active>250</distance_active>');
        expect(xml).toContain('<source_shape>linear</source_shape>');
        expect(xml).toContain('<volume_estimator>naive</volume_estimator>');
        expect(xml).toContain('<sample_method>halton</sample_method>');
        expect(xml).toContain('<diagonal_stabilization_rho>0.5</diagonal_stabilization_rho>');
        expect(xml).toContain('<adjoint>true</adjoint>');
        expect(xml).toContain('<ray_source>');
        expect(xml).toContain('<parameters>-10 -10 -10 10 10 10</parameters>');
        expect(xml).toContain('<adjoint_source>');
        expect(xml).toContain('<parameters>-5 -5 -5 5 5 5</parameters>');
        expect(xml).toContain('<source_region_meshes>');
        expect(xml).toContain('<domain id="1" type="cell"/>');

        const backend = new OpenMCStudioBackendServiceImpl();
        const imported = await backend.importXML({ directory: tempDir });

        expect(imported.success).toBe(true);
        expect(imported.state!.settings.energyMode).toBe('multigroup');
        expect(imported.state!.settings.mgxsLibrary).toBe('/data/mgxs.h5');
        expect(imported.state!.settings.run).toEqual(state.settings.run);
        expect(imported.state!.settings.randomRay).toEqual(state.settings.randomRay);
    });

    it('emits the release (direct) ray_source form by default and drops adjoint_source with a warning', async () => {
        const state = buildTestState();
        state.settings.energyMode = 'multigroup';
        state.settings.mgxsLibrary = '/data/mgxs.h5';
        state.settings.randomRay = {
            distanceInactive: 50,
            distanceActive: 250,
            raySource: { lowerLeft: [-10, -10, -10], upperRight: [10, 10, 10] },
            adjointSource: { lowerLeft: [-5, -5, -5], upperRight: [5, 5, 5] }
        };

        const generator = new XMLGenerationService();
        // No randomRayCompat — defaults to the release 0.15.3 format
        const result = await generator.generateXML({
            state,
            outputDirectory: tempDir,
            files: { materials: false, geometry: false, settings: true, tallies: false, plots: false }
        });

        const xml = fs.readFileSync(path.join(tempDir, 'settings.xml'), 'utf-8');
        expect(xml).toContain('<random_ray>');
        expect(xml).not.toContain('<ray_source>');
        expect(xml).toContain('    <source type="independent" strength="1" particle="neutron">');
        expect(xml).toContain('<parameters>-10 -10 -10 10 10 10</parameters>');
        // adjoint_source is post-0.15.3-only: dropped with a warning
        expect(xml).not.toContain('<adjoint_source>');
        expect(result.warnings?.some((w) => w.includes('adjoint source'))).toBe(true);

        // The direct form round-trips through import
        const backend = new OpenMCStudioBackendServiceImpl();
        const imported = await backend.importXML({ directory: tempDir });
        expect(imported.success).toBe(true);
        expect(imported.state!.settings.randomRay!.raySource).toEqual(state.settings.randomRay.raySource);
        expect(imported.state!.settings.randomRay!.adjointSource).toBeUndefined();
    });

    it('parses the direct (release) ray_source form from hand-written XML', async () => {
        const settingsXml = `<?xml version="1.0"?>
<settings>
  <run_mode>eigenvalue</run_mode>
  <particles>100</particles>
  <batches>10</batches>
  <inactive>5</inactive>
  <energy_mode>multi-group</energy_mode>
  <random_ray>
    <distance_inactive>50</distance_inactive>
    <distance_active>250</distance_active>
    <source type="independent" strength="1" particle="neutron">
      <space type="box">
        <parameters>-1 -1 -1 1 1 1</parameters>
      </space>
    </source>
  </random_ray>
</settings>`;
        fs.writeFileSync(path.join(tempDir, 'settings.xml'), settingsXml);

        const backend = new OpenMCStudioBackendServiceImpl();
        const imported = await backend.importXML({ directory: tempDir });
        expect(imported.success).toBe(true);
        expect(imported.state!.settings.randomRay!.raySource).toEqual({ lowerLeft: [-1, -1, -1], upperRight: [1, 1, 1] });
    });

    it('parses the wrapper (post-0.15.3) ray_source form from hand-written XML', async () => {
        const settingsXml = `<?xml version="1.0"?>
<settings>
  <run_mode>eigenvalue</run_mode>
  <particles>100</particles>
  <batches>10</batches>
  <inactive>5</inactive>
  <energy_mode>multi-group</energy_mode>
  <random_ray>
    <distance_inactive>50</distance_inactive>
    <distance_active>250</distance_active>
    <ray_source>
      <source type="independent" strength="1" particle="neutron">
        <space type="box">
          <parameters>-2 -2 -2 2 2 2</parameters>
        </space>
      </source>
    </ray_source>
    <adjoint_source>
      <source type="independent" strength="1" particle="neutron">
        <space type="box">
          <parameters>-3 -3 -3 3 3 3</parameters>
        </space>
      </source>
    </adjoint_source>
  </random_ray>
</settings>`;
        fs.writeFileSync(path.join(tempDir, 'settings.xml'), settingsXml);

        const backend = new OpenMCStudioBackendServiceImpl();
        const imported = await backend.importXML({ directory: tempDir });
        expect(imported.success).toBe(true);
        expect(imported.state!.settings.randomRay!.raySource).toEqual({ lowerLeft: [-2, -2, -2], upperRight: [2, 2, 2] });
        expect(imported.state!.settings.randomRay!.adjointSource).toEqual({ lowerLeft: [-3, -3, -3], upperRight: [3, 3, 3] });
    });

    it('round-trips the weight window generator in the real OpenMC format', async () => {
        const state = buildTestState();
        state.varianceReduction = {
            weightWindowGenerator: {
                meshId: 5,
                energyBounds: [0, 1e4, 2e7],
                particleType: 'neutron',
                method: 'fw_cadis',
                maxRealizations: 100,
                updateInterval: 2,
                onTheFly: true,
                targetTallyIds: [1, 2]
            }
        };
        state.meshes = [{ type: 'regular', id: 5, lowerLeft: [-5, -5, -5], upperRight: [5, 5, 5], dimension: [2, 2, 2] }];

        const generator = new XMLGenerationService();
        await generator.generateXML({
            state,
            outputDirectory: tempDir,
            files: { materials: true, geometry: true, settings: true, tallies: false, plots: false }
        });

        const xml = fs.readFileSync(path.join(tempDir, 'settings.xml'), 'utf-8');
        expect(xml).toContain('<weight_window_generators>');
        expect(xml).toContain('<weight_windows_generator>');
        expect(xml).toContain('<mesh>5</mesh>');
        expect(xml).toContain('<energy_bounds>0 10000 20000000</energy_bounds>');
        expect(xml).toContain('<max_realizations>100</max_realizations>');
        expect(xml).toContain('<update_interval>2</update_interval>');
        expect(xml).toContain('<on_the_fly>true</on_the_fly>');
        expect(xml).toContain('<method>fw_cadis</method>');
        expect(xml).toContain('<targets>1 2</targets>');
        // Referenced mesh is appended to the settings root (openmc python behavior);
        // without it the C++ mesh lookup crashes during settings reading
        expect(xml).toContain('<mesh id="5" type="regular">');

        const backend = new OpenMCStudioBackendServiceImpl();
        const imported = await backend.importXML({ directory: tempDir });

        expect(imported.success).toBe(true);
        expect(imported.state!.varianceReduction?.weightWindowGenerator).toEqual(state.varianceReduction.weightWindowGenerator);
    });

    it('omits new elements when fields are absent (backward compatible output)', async () => {
        const state = buildTestState();
        const minimalSettings: OpenMCSettings = {
            run: { mode: 'fixed source', particles: 1000, batches: 10 },
            sources: []
        };
        state.settings = minimalSettings;

        const service = new XMLGenerationService();
        const result = await service.generateXML({
            state,
            outputDirectory: tempDir,
            files: { materials: false, geometry: false, settings: true, tallies: false, plots: false }
        });

        expect(result.success).toBe(true);
        const xml = fs.readFileSync(path.join(tempDir, 'settings.xml'), 'utf-8');
        expect(xml).not.toContain('<output>');
        expect(xml).not.toContain('<state_point>');
        expect(xml).not.toContain('<source_point>');
        expect(xml).not.toContain('<surf_source_write>');
        expect(xml).not.toContain('<surf_source_read>');
        expect(xml).not.toContain('<track>');
        expect(xml).not.toContain('<max_tracks>');
        expect(xml).not.toContain('<collision_track>');
        expect(xml).not.toContain('<entropy_mesh>');
        expect(xml).not.toContain('<electron_treatment>');
        expect(xml).not.toContain('<atomic_relaxation>');
        expect(xml).not.toContain('<constraints>');
    });
});
