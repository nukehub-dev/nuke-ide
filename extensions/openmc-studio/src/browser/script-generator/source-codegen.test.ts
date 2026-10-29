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

/** Python exporter tests for the shared source distribution codegen + model script wiring. */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@theia/filesystem/lib/browser', () => ({ FileDialogService: class {}, SaveFileDialogProps: {} }));
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class {} }));
vi.mock('@theia/workspace/lib/browser/workspace-service', () => ({ WorkspaceService: class {} }));

import { generateAngleCode, generateSpatialCode, generateTimeCode, generateUnivariateCode } from './source-codegen';
import { OpenMCPythonExporter } from './python-exporter';
import { OpenMCState } from '../../common/openmc-state-schema';
import { DEFAULT_OPENMC_COMPAT } from '../../common/openmc-studio-protocol';

describe('Python source codegen', () => {
    it('declares named variables for nested mixture children', () => {
        const generated = generateUnivariateCode(
            {
                type: 'mixture',
                probability: [0.4, 0.6],
                distributions: [
                    { type: 'powerlaw', a: 1e5, b: 2e7, n: -1 },
                    {
                        type: 'mixture',
                        probability: [0.5, 0.5],
                        distributions: [
                            { type: 'uniform', min: 1e6, max: 2e6 },
                            { type: 'tabular', energies: [1e6, 2e6], probabilities: [1, 1], interpolation: 'histogram' }
                        ]
                    }
                ]
            },
            'source_0_energy'
        );
        expect(generated.expression).toBe('source_0_energy');
        expect(generated.lines).toContain('source_0_energy_0 = openmc.stats.PowerLaw(100000, 20000000, -1)');
        expect(generated.lines).toContain('source_0_energy_1_0 = openmc.stats.Uniform(1000000, 2000000)');
        expect(generated.lines).toContain(
            "source_0_energy_1_1 = openmc.stats.Tabular([1000000, 2000000], [1, 1], interpolation='histogram')"
        );
        expect(generated.lines).toContain(
            'source_0_energy_1 = openmc.stats.Mixture([0.5, 0.5], [source_0_energy_1_0, source_0_energy_1_1])'
        );
        expect(generated.lines).toContain('source_0_energy = openmc.stats.Mixture([0.4, 0.6], [source_0_energy_0, source_0_energy_1])');
    });

    it('emits every energy type with the OpenMC Python API names', () => {
        expect(generateUnivariateCode({ type: 'discrete', energies: [1, 2], probabilities: [0.25, 0.75] }, 'e').lines[0]).toBe(
            'e = openmc.stats.Discrete([1, 2], [0.25, 0.75])'
        );
        expect(generateUnivariateCode({ type: 'uniform', min: 0, max: 1 }, 'e').lines[0]).toBe('e = openmc.stats.Uniform(0, 1)');
        expect(generateUnivariateCode({ type: 'maxwell', temperature: 1.5 }, 'e').lines[0]).toBe('e = openmc.stats.Maxwell(1.5)');
        expect(generateUnivariateCode({ type: 'watt', a: 1, b: 2 }, 'e').lines[0]).toBe('e = openmc.stats.Watt(1, 2)');
        expect(generateUnivariateCode({ type: 'normal', mean: 1, stdDev: 2 }, 'e').lines[0]).toBe('e = openmc.stats.Normal(1, 2)');
        expect(generateUnivariateCode({ type: 'muir', e0: 14e6, m_rat: 5, kt: 20000 }, 'e').lines[0]).toBe(
            'e = openmc.stats.muir(14000000, 5, 20000)'
        );
        expect(generateUnivariateCode({ type: 'powerlaw', a: 1, b: 2, n: 3 }, 'e').lines[0]).toBe('e = openmc.stats.PowerLaw(1, 2, 3)');
        expect(
            generateUnivariateCode({ type: 'decay-spectrum', nuclides: [{ name: 'Cs137', density: 1e-8 }], volume: 1000 }, 'e').lines[0]
        ).toBe('e = openmc.stats.DecaySpectrum({"Cs137": 1e-8}, 1000)');
    });

    it('emits spatial independent distributions', () => {
        expect(
            generateSpatialCode(
                {
                    type: 'cartesian',
                    x: { type: 'uniform', min: -1, max: 1 },
                    y: { type: 'discrete', energies: [0], probabilities: [1] },
                    z: { type: 'uniform', min: -1, max: 1 }
                },
                'space'
            ).lines.join('\n')
        ).toContain('space = openmc.stats.CartesianIndependent(x=space_x, y=space_y, z=space_z)');
        expect(
            generateSpatialCode(
                {
                    type: 'cylindrical',
                    r: { type: 'uniform', min: 0, max: 1 },
                    phi: { type: 'uniform', min: 0, max: 2 * Math.PI },
                    z: { type: 'uniform', min: -1, max: 1 },
                    origin: [1, 2, 3],
                    rDir: [0, 1, 0],
                    zDir: [0, 0, 1]
                },
                'space'
            ).lines.join('\n')
        ).toContain('origin=[1, 2, 3], r_dir=[0.0, 1.0, 0.0]');
        expect(
            generateSpatialCode(
                {
                    type: 'spherical',
                    r: { type: 'uniform', min: 0, max: 1 },
                    cosTheta: { type: 'uniform', min: -1, max: 1 },
                    phi: { type: 'uniform', min: 0, max: 1 },
                    origin: [4, 5, 6]
                },
                'space'
            ).lines.join('\n')
        ).toContain('origin=[4, 5, 6]');
        expect(
            generateSpatialCode(
                {
                    type: 'pointcloud',
                    positions: [
                        [0, 0, 0],
                        [1, 2, 3]
                    ],
                    strengths: [1, 2]
                },
                'space'
            ).lines[0]
        ).toBe('space = openmc.stats.PointCloud([[0, 0, 0], [1, 2, 3]], strengths=[1, 2])');
        expect(generateSpatialCode({ type: 'mesh', meshId: 7, strengths: [1, 2], volumeNormalized: false }, 'space').lines[0]).toBe(
            'space = openmc.stats.MeshSpatial(mesh_7, strengths=[1, 2], volume_normalized=False)'
        );
    });

    it('emits angle and time distributions', () => {
        expect(generateAngleCode({ type: 'isotropic' }, 'angle').lines[0]).toBe('angle = openmc.stats.Isotropic()');
        expect(generateAngleCode({ type: 'monodirectional', referenceUvW: [0, 1, 0] }, 'angle').lines[0]).toBe(
            'angle = openmc.stats.Monodirectional([0.0, 1.0, 0.0])'
        );
        const muPhi = generateAngleCode(
            {
                type: 'mu-phi',
                mu: { type: 'uniform', min: -1, max: 1 },
                phi: { type: 'uniform', min: 0, max: 1 },
                referenceUvW: [0, 0, 1],
                referenceVwu: [1, 0, 0]
            },
            'angle'
        );
        expect(muPhi.lines.join('\n')).toContain(
            'angle = openmc.stats.PolarAzimuthal(mu=angle_mu, phi=angle_phi, reference_uvw=[0.0, 0.0, 1.0], reference_vwu=[1.0, 0.0, 0.0])'
        );
        expect(generateTimeCode({ type: 'delta', time: 0.001 }, 'time').lines[0]).toBe('time = openmc.stats.delta_function(0.001)');
        expect(generateTimeCode({ type: 'tabular', energies: [0, 1], probabilities: [1, 1] }, 'time').lines[0]).toContain(
            'openmc.stats.Tabular([0, 1], [1, 1]'
        );
    });
});

describe('Python exporter source wiring', () => {
    /** Minimal state accepted by the model-script generator. */
    function buildState(): OpenMCState {
        const now = new Date().toISOString();
        return {
            metadata: { version: '1.1.0', name: 'Source Export', created: now, modified: now },
            geometry: {
                surfaces: [{ id: 1, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 10 }, boundary: 'vacuum' }],
                cells: [{ id: 1, fillType: 'material', fillId: 1, regionString: '-1' }],
                universes: [{ id: 0, name: 'root', cellIds: [1] }],
                lattices: [],
                rootUniverseId: 0
            },
            materials: [
                {
                    id: 1,
                    name: 'Water',
                    density: 1.0,
                    densityUnit: 'g/cm3',
                    nuclides: [{ name: 'H1', fraction: 2, fractionType: 'ao' }],
                    thermalScattering: []
                }
            ],
            settings: {
                run: { mode: 'fixed source', particles: 100, batches: 2 },
                sources: [
                    {
                        spatial: {
                            type: 'cartesian',
                            x: { type: 'uniform', min: -1, max: 1 },
                            y: { type: 'uniform', min: -1, max: 1 },
                            z: { type: 'uniform', min: -1, max: 1 }
                        },
                        energy: { type: 'tabular', energies: [1e-5, 14e6], probabilities: [1, 1] },
                        angle: { type: 'mu-phi', mu: { type: 'uniform', min: -1, max: 1 }, phi: { type: 'uniform', min: 0, max: 1 } },
                        time: { type: 'uniform', min: 0, max: 1e-3 },
                        particle: 'neutron',
                        strength: 2
                    }
                ]
            },
            tallies: [],
            meshes: [],
            plots: []
        } as OpenMCState;
    }

    it('assigns named space/angle/energy/time variables to the source', () => {
        const exporter = new OpenMCPythonExporter();
        const script = (exporter as unknown as { generateModelScript(s: OpenMCState, o: object): string }).generateModelScript(
            buildState(),
            { mode: 'single', includeComments: false, includeShebang: false }
        );
        expect(script).toContain('source_0_space = openmc.stats.CartesianIndependent(');
        expect(script).toContain('source_0.space = source_0_space');
        expect(script).toContain('source_0_angle = openmc.stats.PolarAzimuthal(');
        expect(script).toContain('source_0.angle = source_0_angle');
        expect(script).toContain("source_0_energy = openmc.stats.Tabular([0.00001, 14000000], [1, 1], interpolation='linear-linear')");
        expect(script).toContain('source_0.energy = source_0_energy');
        expect(script).toContain('source_0_time = openmc.stats.Uniform(0, 0.001)');
        expect(script).toContain('source_0.time = source_0_time');
        expect(script).toContain('source_0.strength = 2');
        expect(script).toContain('settings.source = [source_0]');
    });
});

describe('Python exporter bias and weight-window wiring', () => {
    /** State with biased distributions, UFS, and multiple weight-window sets. */
    function buildVrState(): OpenMCState {
        const now = new Date().toISOString();
        return {
            metadata: { version: '1.1.0', name: 'VR Export', created: now, modified: now },
            geometry: {
                surfaces: [{ id: 1, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 10 }, boundary: 'vacuum' }],
                cells: [{ id: 1, fillType: 'material', fillId: 1, regionString: '-1' }],
                universes: [{ id: 0, name: 'root', cellIds: [1] }],
                lattices: [],
                rootUniverseId: 0
            },
            materials: [
                {
                    id: 1,
                    name: 'Water',
                    density: 1.0,
                    densityUnit: 'g/cm3',
                    nuclides: [{ name: 'H1', fraction: 2, fractionType: 'ao' }],
                    thermalScattering: []
                }
            ],
            settings: {
                run: { mode: 'eigenvalue', particles: 100, inactive: 5, batches: 10 },
                sources: [
                    {
                        spatial: {
                            type: 'pointcloud',
                            positions: [
                                [0, 0, 0],
                                [1, 1, 1]
                            ],
                            strengths: [1, 1],
                            bias: { probabilities: [0.9, 0.1] }
                        },
                        energy: { type: 'uniform', min: 0, max: 20e6, bias: { distribution: { type: 'uniform', min: 1e5, max: 2e6 } } },
                        angle: {
                            type: 'isotropic',
                            bias: {
                                distribution: {
                                    type: 'mu-phi',
                                    mu: { type: 'uniform', min: -1, max: 1 },
                                    phi: { type: 'uniform', min: 0, max: 2 * Math.PI }
                                }
                            }
                        },
                        particle: 'neutron'
                    }
                ]
            },
            tallies: [],
            meshes: [
                { type: 'regular', id: 5, lowerLeft: [-1, -1, -1], upperRight: [1, 1, 1], dimension: [2, 2, 2] },
                { type: 'regular', id: 6, lowerLeft: [-1, -1, -1], upperRight: [1, 1, 1], dimension: [1, 1, 1] }
            ],
            varianceReduction: {
                weightWindows: [
                    { id: 1, meshId: 5, lowerBound: 0.5, energyBounds: [0, 2e7], particleType: 'neutron' },
                    { id: 2, meshId: 6, lowerBound: 0.25, upperBound: 0.5, energyBounds: [0, 2e7], particleType: 'photon' }
                ],
                weightWindowsFile: '/tmp/weight_windows.h5',
                weightWindowsOn: true,
                weightWindowCheckpoints: { collision: true, surface: true },
                ufs: { enabled: true, meshId: 5 }
            },
            plots: []
        } as OpenMCState;
    }

    it('passes bias to univariate, spatial, and angle constructors', () => {
        expect(
            generateUnivariateCode(
                { type: 'uniform', min: 0, max: 1, bias: { distribution: { type: 'uniform', min: 0, max: 1 } } },
                'energy'
            ).lines
        ).toEqual(['energy_bias = openmc.stats.Uniform(0, 1)', 'energy = openmc.stats.Uniform(0, 1, bias=energy_bias)']);
        expect(
            generateUnivariateCode(
                { type: 'discrete', energies: [1, 2], probabilities: [0.5, 0.5], bias: { probabilities: [0.1, 0.9] } },
                'energy'
            ).lines
        ).toEqual(['energy_bias = [0.1, 0.9]', 'energy = openmc.stats.Discrete([1, 2], [0.5, 0.5], bias=energy_bias)']);
        expect(
            generateSpatialCode(
                {
                    type: 'pointcloud',
                    positions: [
                        [0, 0, 0],
                        [1, 1, 1]
                    ],
                    strengths: [1, 1],
                    bias: { probabilities: [0.9, 0.1] }
                },
                'space'
            ).lines[0]
        ).toBe('space = openmc.stats.PointCloud([[0, 0, 0], [1, 1, 1]], strengths=[1, 1], bias=[0.9, 0.1])');
        expect(
            generateAngleCode(
                {
                    type: 'isotropic',
                    bias: {
                        distribution: {
                            type: 'mu-phi',
                            mu: { type: 'uniform', min: -1, max: 1 },
                            phi: { type: 'uniform', min: 0, max: 2 * Math.PI }
                        }
                    }
                },
                'angle'
            ).lines.join('\n')
        ).toContain('angle = openmc.stats.Isotropic(bias=angle_bias)');
    });

    it('emits every weight-window set, the file, enable flag, checkpoints, and UFS', () => {
        const exporter = new OpenMCPythonExporter();
        const script = (exporter as unknown as { generateModelScript(s: OpenMCState, o: object): string }).generateModelScript(
            buildVrState(),
            { mode: 'single', includeComments: false, includeShebang: false }
        );
        expect(script).toContain(
            'ww_1 = openmc.WeightWindows(mesh=mesh_5, lower_ww_bounds=[0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], upper_ww_bounds=[1, 1, 1, 1, 1, 1, 1, 1], energy_bounds=[0, 20000000], particle_type="neutron", survival_ratio=3, max_split=10, weight_cutoff=1e-38, id=1)'
        );
        expect(script).toContain('settings.weight_windows = [ww_1, ww_2]');
        expect(script).toContain('settings.weight_windows_file = "/tmp/weight_windows.h5"');
        expect(script).toContain('settings.weight_windows_on = True');
        expect(script).toContain("settings.weight_window_checkpoints = {'collision': True, 'surface': True}");
        expect(script).toContain('settings.ufs_mesh = mesh_5');
        expect(script).toContain('openmc.stats.PointCloud(');
        expect(script).toContain('bias=[0.9, 0.1]');
        expect(script).toContain('openmc.stats.Isotropic(bias=source_0_angle_bias)');
        expect(script).toContain('openmc.stats.Uniform(0, 20000000, bias=source_0_energy_bias)');
    });
});

describe('Python exporter capability gating', () => {
    it('omits source bias when the probed environment predates it', () => {
        const state = {
            metadata: { version: '1.1.0', name: 'Bias gate', created: '', modified: '' },
            geometry: { surfaces: [], cells: [], universes: [], lattices: [], rootUniverseId: 0 },
            materials: [],
            settings: {
                run: { mode: 'fixed source', particles: 100, batches: 2 },
                sources: [
                    {
                        spatial: { type: 'point', origin: [0, 0, 0] },
                        energy: {
                            type: 'uniform',
                            min: 0,
                            max: 20e6,
                            bias: { distribution: { type: 'uniform', min: 1e6, max: 2e6 } }
                        }
                    }
                ]
            },
            tallies: [],
            meshes: [],
            plots: []
        } as OpenMCState;
        const exporter = new OpenMCPythonExporter();
        const script = (exporter as unknown as { generateModelScript(s: OpenMCState, o: object): string }).generateModelScript(state, {
            mode: 'single',
            includeComments: false,
            includeShebang: false,
            compat: { ...DEFAULT_OPENMC_COMPAT, sourceBias: false }
        });
        expect(script).not.toContain('source_0_energy_bias');
        expect(script).not.toContain('bias=');
        expect(script).toContain('Source bias requires OpenMC >= 0.16.0');
        expect(script).toContain('source_0.energy = source_0_energy');
    });
});
