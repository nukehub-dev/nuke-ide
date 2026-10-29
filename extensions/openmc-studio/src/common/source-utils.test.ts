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

/** Tests for the shared source distribution model: XML, import, summaries, validation, legacy normalization. */

import { describe, it, expect } from 'vitest';
import {
    defaultSpatialOfType,
    defaultTimeOfType,
    defaultUnivariateOfType,
    generateAngleXml,
    generateSpatialXml,
    generateTimeXml,
    generateUnivariateXml,
    normalizeLegacySource,
    parseAngleXml,
    parseSpatialXml,
    parseTimeXml,
    parseUnivariateXml,
    sourceUsesDecaySpectrum,
    summarizeSource,
    validateSourceDistributions
} from './source-utils';
import { OpenMCIndependentSource } from './openmc-state-schema';
import { DEFAULT_OPENMC_COMPAT } from './openmc-studio-protocol';
import { NEUTRON_PARTICLE } from './particle-types';

describe('source-utils XML', () => {
    it('writes OpenMC parameter ordering for every simple univariate', () => {
        expect(generateUnivariateXml({ type: 'discrete', energies: [1, 2], probabilities: [0.25, 0.75] }, 'energy', 0)).toBe(
            '<energy type="discrete">\n  <parameters>1 2 0.25 0.75</parameters>\n</energy>'
        );
        expect(generateUnivariateXml({ type: 'uniform', min: 0, max: 10 }, 'energy', 0)).toBe('<energy type="uniform" parameters="0 10"/>');
        expect(generateUnivariateXml({ type: 'maxwell', temperature: 1.2 }, 'energy', 0)).toBe('<energy type="maxwell" parameters="1.2"/>');
        expect(generateUnivariateXml({ type: 'watt', a: 1, b: 2 }, 'energy', 0)).toBe('<energy type="watt" parameters="1 2"/>');
        expect(generateUnivariateXml({ type: 'normal', mean: 1, stdDev: 2 }, 'energy', 0)).toBe('<energy type="normal" parameters="1 2"/>');
        expect(generateUnivariateXml({ type: 'powerlaw', a: 1, b: 2, n: 3 }, 'energy', 0)).toBe(
            '<energy type="powerlaw" parameters="1 2 3"/>'
        );
        expect(generateUnivariateXml({ type: 'tabular', energies: [1, 2], probabilities: [3, 4] }, 'energy', 0)).toBe(
            '<energy type="tabular" interpolation="linear-linear">\n  <parameters>1 2 3 4</parameters>\n</energy>'
        );
        expect(generateUnivariateXml({ type: 'muir', e0: 14.08e6, m_rat: 5, kt: 20000 }, 'energy', 0)).toContain(
            '<energy type="normal" parameters="14080000 '
        );
    });

    it('writes nested mixture pairs with independent dist elements', () => {
        const xml = generateUnivariateXml(
            {
                type: 'mixture',
                probability: [0.4, 0.6],
                distributions: [
                    { type: 'uniform', min: 0, max: 1 },
                    {
                        type: 'mixture',
                        probability: [0.5, 0.5],
                        distributions: [
                            { type: 'discrete', energies: [1], probabilities: [1] },
                            { type: 'powerlaw', a: 1, b: 2, n: 0 }
                        ]
                    }
                ]
            },
            'energy',
            0
        );
        expect(xml).toContain('<pair probability="0.4">');
        expect(xml).toContain('<dist type="mixture">');
        expect(xml).toContain('<pair probability="0.5">');
        expect(xml).toContain('<dist type="powerlaw" parameters="1 2 0"/>');
    });

    it('writes cloud, mesh, spherical, and cylindrical spatial elements', () => {
        expect(
            generateSpatialXml(
                {
                    type: 'pointcloud',
                    positions: [
                        [0, 0, 0],
                        [1, 2, 3]
                    ],
                    strengths: [1, 2]
                },
                0
            )
        ).toContain('<coords>0 0 0 1 2 3</coords>');
        expect(generateSpatialXml({ type: 'mesh', meshId: 4, strengths: [1, 2], volumeNormalized: false }, 0)).toContain(
            '<space type="mesh" mesh_id="4" volume_normalized="false">'
        );
        expect(
            generateSpatialXml(
                {
                    type: 'spherical',
                    r: { type: 'uniform', min: 0, max: 1 },
                    cosTheta: { type: 'uniform', min: -1, max: 1 },
                    phi: { type: 'uniform', min: 0, max: 2 * Math.PI },
                    origin: [1, 2, 3]
                },
                0
            )
        ).toContain('<cos_theta type="uniform" parameters="-1 1"/>');
        expect(
            generateSpatialXml(
                {
                    type: 'cylindrical',
                    r: { type: 'uniform', min: 0, max: 1 },
                    phi: { type: 'uniform', min: 0, max: 2 * Math.PI },
                    z: { type: 'uniform', min: -1, max: 1 },
                    origin: [0, 0, 0],
                    rDir: [0, 1, 0],
                    zDir: [0, 0, 1]
                },
                0
            )
        ).toContain('r_dir="0 1 0"');
    });

    it('rejects invalid distributions instead of writing malformed XML', () => {
        expect(generateUnivariateXml({ type: 'powerlaw', a: 2, b: 1, n: 0 }, 'energy')).toBe('');
        expect(generateUnivariateXml({ type: 'tabular', energies: [2, 1], probabilities: [1, 1] }, 'energy')).toBe('');
        expect(generateUnivariateXml({ type: 'tabular', energies: [1, 2], probabilities: [1] }, 'energy')).toBe('');
        expect(generateUnivariateXml({ type: 'mixture', probability: [1], distributions: [] }, 'energy')).toBe('');
        expect(generateAngleXml({ type: 'monodirectional', referenceUvW: [0, 0, 0] })).toBe('');
        expect(
            generateAngleXml({
                type: 'mu-phi',
                mu: { type: 'uniform', min: -1, max: 1 },
                phi: { type: 'uniform', min: 0, max: 1 },
                referenceUvW: [0, 0, 1],
                referenceVwu: [0, 0, 2]
            })
        ).toBe('');
    });

    it('imports native OpenMC XML shapes', () => {
        expect(parseUnivariateXml({ $: { type: 'discrete' }, parameters: '1000000 2000000 0.25 0.75' })).toEqual({
            type: 'discrete',
            energies: [1e6, 2e6],
            probabilities: [0.25, 0.75]
        });
        expect(
            parseUnivariateXml({
                $: { type: 'tabular', interpolation: 'log-log' },
                parameters: '1 2 3 4'
            })
        ).toEqual({
            type: 'tabular',
            energies: [1, 2],
            probabilities: [3, 4],
            interpolation: 'log-log'
        });
        expect(
            parseUnivariateXml({
                $: { type: 'decay_spectrum', volume: '10' },
                nuclides: 'Cs137 Co60',
                parameters: '1e-8 2e-9'
            })
        ).toEqual({
            type: 'decay-spectrum',
            nuclides: [
                { name: 'Cs137', density: 1e-8 },
                { name: 'Co60', density: 2e-9 }
            ],
            volume: 10
        });
        expect(generateTimeXml({ type: 'delta', time: 5 }, 0)).toContain('<parameters>5 1</parameters>');
        expect(parseTimeXml({ $: { type: 'discrete' }, parameters: '5 1' })).toEqual({ type: 'delta', time: 5 });
        expect(parseTimeXml({ $: { type: 'discrete' }, parameters: '0 1 0.5 0.5' })).toEqual({
            type: 'discrete',
            energies: [0, 1],
            probabilities: [0.5, 0.5]
        });
    });

    it('imports canonical convenience sphere/cylinder XML and keeps general distributions distinct', () => {
        const sphere = parseSpatialXml({
            $: { type: 'spherical', origin: '0 0 0' },
            r: { $: { type: 'uniform', parameters: '0 5' } },
            cos_theta: { $: { type: 'uniform', parameters: '-1 1' } },
            phi: { $: { type: 'uniform', parameters: `0 ${2 * Math.PI}` } }
        });
        expect(sphere).toEqual({ type: 'sphere', center: [0, 0, 0], radius: 5 });

        const cylindrical = parseSpatialXml({
            $: { type: 'cylindrical' },
            r: { $: { type: 'uniform', parameters: '0 2' } },
            phi: { $: { type: 'uniform', parameters: `0 ${2 * Math.PI}` } },
            z: { $: { type: 'uniform', parameters: '-5 5' } }
        });
        expect(cylindrical).toEqual({ type: 'cylinder', center: [0, 0, 0], radius: 2, height: 10, axis: 'z' });

        const general = parseSpatialXml({
            $: { type: 'spherical', origin: '1 2 3' },
            r: { $: { type: 'tabular' }, parameters: '0 5 1 1' },
            cos_theta: { $: { type: 'uniform', parameters: '-1 1' } },
            phi: { $: { type: 'uniform', parameters: `0 ${2 * Math.PI}` } }
        });
        expect(general?.type).toBe('spherical');
    });
});

describe('source validation', () => {
    /** Build a minimal independent source. */
    function source(overrides: Partial<OpenMCIndependentSource>): OpenMCIndependentSource {
        return {
            spatial: { type: 'point', origin: [0, 0, 0] },
            energy: { type: 'discrete', energies: [1e6] },
            ...overrides
        };
    }

    it('accepts presets and rejects unknown or version-gated source particles', () => {
        expect(validateSourceDistributions(source({ particle: NEUTRON_PARTICLE }))).toEqual([]);
        expect(validateSourceDistributions(source({ particle: { name: 'He4', pdg: 1000020040 } }))).toEqual([]);
        const gated = validateSourceDistributions(source({ particle: { name: 'He4', pdg: 1000020040 } }), [], {
            ...DEFAULT_OPENMC_COMPAT,
            generalizedParticles: false
        });
        expect(gated.some((issue) => issue.scope === 'particle' && issue.message.includes('requires OpenMC 0.16'))).toBe(true);
        const unknown = validateSourceDistributions(source({ particle: { name: 'muon' } }));
        expect(unknown.some((issue) => issue.scope === 'particle' && issue.message.includes('not a recognized OpenMC particle'))).toBe(
            true
        );
    });

    it('reports tabular ordering and column mismatch with fixes', () => {
        const issues = validateSourceDistributions(
            source({
                energy: {
                    type: 'tabular',
                    energies: [10, 5],
                    probabilities: [1, 1, 1]
                }
            })
        );
        expect(issues.some((issue) => issue.message.includes('strictly increase'))).toBe(true);
        expect(issues.some((issue) => issue.message.includes('3 probabilities') && issue.suggestion.includes('Paste'))).toBe(true);
    });

    it('rejects non-positive values on log-interpolated tables', () => {
        const zeroProbability = validateSourceDistributions(
            source({
                energy: {
                    type: 'tabular',
                    energies: [1, 2, 3],
                    probabilities: [0, 1, 1],
                    interpolation: 'log-log'
                }
            })
        );
        expect(zeroProbability.some((issue) => issue.message.includes('strictly positive probabilities'))).toBe(true);

        const zeroEnergy = validateSourceDistributions(
            source({
                energy: {
                    type: 'tabular',
                    energies: [0, 2, 3],
                    probabilities: [1, 1, 1],
                    interpolation: 'log-linear'
                }
            })
        );
        expect(zeroEnergy.some((issue) => issue.message.includes('strictly positive x values'))).toBe(true);
    });

    it('reports mixture probability sums and nested malformed children', () => {
        const issues = validateSourceDistributions(
            source({
                energy: {
                    type: 'mixture',
                    probability: [0.2, 0.2],
                    distributions: [
                        { type: 'powerlaw', a: 2, b: 1, n: 0 },
                        { type: 'uniform', min: 0, max: 1 }
                    ]
                }
            })
        );
        expect(issues.some((issue) => issue.message.includes('sum to 0.4'))).toBe(true);
        expect(issues.some((issue) => issue.message.includes('power law needs'))).toBe(true);
    });

    it('reports point-cloud vector/strength mismatches', () => {
        const issues = validateSourceDistributions(
            source({
                spatial: { type: 'pointcloud', positions: [[0, 0, 0]], strengths: [1, 2] }
            })
        );
        expect(issues.some((issue) => issue.message.includes('1 positions but 2 strengths'))).toBe(true);
    });

    it('reports zero/parallel angle reference vectors', () => {
        const zero = validateSourceDistributions(source({ angle: { type: 'monodirectional', referenceUvW: [0, 0, 0] } }));
        expect(zero.some((issue) => issue.message.includes('must be non-zero'))).toBe(true);

        const parallel = validateSourceDistributions(
            source({
                angle: {
                    type: 'mu-phi',
                    mu: { type: 'uniform', min: -1, max: 1 },
                    phi: { type: 'uniform', min: 0, max: 1 },
                    referenceUvW: [0, 0, 1],
                    referenceVwu: [0, 0, 2]
                }
            })
        );
        expect(parallel.some((issue) => issue.message.includes('must not be parallel'))).toBe(true);
    });

    it('reports negative/out-of-order time values', () => {
        const negative = validateSourceDistributions(source({ time: { type: 'delta', time: -1 } }));
        expect(negative.some((issue) => issue.scope === 'time' && issue.message.includes('non-negative'))).toBe(true);

        const unordered = validateSourceDistributions(source({ time: { type: 'discrete', energies: [1, 0], probabilities: [0.5, 0.5] } }));
        expect(unordered.some((issue) => issue.message.includes('not ordered'))).toBe(true);

        const tabular = validateSourceDistributions(source({ time: { type: 'tabular', energies: [-1, 0], probabilities: [1, 1] } }));
        expect(tabular.some((issue) => issue.message.includes('negative time'))).toBe(true);
    });

    it('reports decay-spectrum density/volume problems', () => {
        const issues = validateSourceDistributions(
            source({
                energy: {
                    type: 'decay-spectrum',
                    nuclides: [{ name: 'Cs137', density: 0 }],
                    volume: 0
                }
            })
        );
        expect(issues.some((issue) => issue.message.includes('density for Cs137 must be positive'))).toBe(true);
        expect(issues.some((issue) => issue.message.includes('volume must be positive'))).toBe(true);
    });

    it('reports mesh spatial strength counts against the mesh element count', () => {
        const issues = validateSourceDistributions(source({ spatial: { type: 'mesh', meshId: 3, strengths: [1, 2] } }), [
            {
                id: 3,
                type: 'regular',
                lowerLeft: [0, 0, 0],
                upperRight: [1, 1, 1],
                dimension: [2, 2, 2]
            }
        ]);
        expect(issues.some((issue) => issue.message.includes('2 strengths') && issue.message.includes('8 elements'))).toBe(true);
    });
});

describe('decay-spectrum detection', () => {
    it('finds decay spectra nested in mixtures and mesh sub-sources', () => {
        const nested = {
            spatial: { type: 'point' as const, origin: [0, 0, 0] as [number, number, number] },
            energy: {
                type: 'mixture' as const,
                probability: [1],
                distributions: [{ type: 'decay-spectrum' as const, nuclides: [{ name: 'Cs137', density: 1e-8 }], volume: 1 }]
            }
        };
        expect(sourceUsesDecaySpectrum(nested)).toBe(true);
        expect(
            sourceUsesDecaySpectrum({
                type: 'mesh',
                sources: [nested]
            })
        ).toBe(true);
        expect(sourceUsesDecaySpectrum({ ...nested, energy: { type: 'uniform', min: 0, max: 1 } })).toBe(false);
    });
});

describe('source summaries and legacy normalization', () => {
    it('summarizes a source compactly', () => {
        const text = summarizeSource({
            spatial: { type: 'box', lowerLeft: [-10, -10, -10], upperRight: [10, 10, 10] },
            energy: { type: 'tabular', energies: [1e-5, 14e6], probabilities: [1, 1] },
            angle: { type: 'isotropic' },
            time: { type: 'delta', time: 0 }
        });
        expect(text).toContain('Box [-10, 10]³');
        expect(text).toContain('Tabular 1e-5 eV–14 MeV');
        expect(text).toContain('Isotropic');
        expect(text).toContain('t = 0 s');
    });

    it('defaults every offered distribution type', () => {
        expect(defaultUnivariateOfType('tabular', 'time').type).toBe('tabular');
        expect(defaultSpatialOfType('pointcloud').type).toBe('pointcloud');
        expect(defaultTimeOfType('delta')).toEqual({ type: 'delta', time: 0 });
    });

    it('normalizes legacy time and angle params', () => {
        const normalized = normalizeLegacySource({
            type: 'independent',
            spatial: { type: 'point', origin: [0, 0, 0] },
            energy: { type: 'discrete', energies: [1e6] },
            angle: { type: 'polar-azimuthal', params: { mu: 1, phi: 0 } },
            time: { type: 'uniform', params: { min: 0, max: 1e-3 } }
        } as any);
        expect(normalized).toMatchObject({
            angle: {
                type: 'mu-phi',
                mu: { type: 'discrete', energies: [1], probabilities: [1] },
                phi: { type: 'discrete', energies: [0], probabilities: [1] }
            },
            time: { type: 'uniform', min: 0, max: 1e-3 }
        });
    });

    it('keeps current time/angle shapes unchanged', () => {
        const source: OpenMCIndependentSource = {
            spatial: { type: 'point', origin: [0, 0, 0] },
            energy: { type: 'discrete', energies: [1e6] },
            angle: { type: 'mu-phi', mu: { type: 'uniform', min: -1, max: 1 }, phi: { type: 'uniform', min: 0, max: 1 } },
            time: { type: 'tabular', energies: [0, 1], probabilities: [1, 1] }
        };
        expect(normalizeLegacySource(source)).toEqual(source);
    });
});

describe('source distribution bias', () => {
    it('writes a nested bias distribution for continuous energy distributions', () => {
        const xml = generateUnivariateXml(
            {
                type: 'uniform',
                min: 1e5,
                max: 2e7,
                bias: { distribution: { type: 'uniform', min: 1e5, max: 2e7 } }
            },
            'energy',
            0
        );
        expect(xml).toBe(
            '<energy type="uniform" parameters="100000 20000000">\n  <bias type="uniform" parameters="100000 20000000"/>\n</energy>'
        );
    });

    it('writes alternative probabilities for Discrete and Mixture bias', () => {
        expect(
            generateUnivariateXml(
                {
                    type: 'discrete',
                    energies: [1e6, 2e6],
                    probabilities: [0.5, 0.5],
                    bias: { probabilities: [0.1, 0.9] }
                },
                'energy',
                0
            )
        ).toContain('<bias>0.1 0.9</bias>');
        expect(
            generateUnivariateXml(
                {
                    type: 'mixture',
                    probability: [0.5, 0.5],
                    distributions: [
                        { type: 'uniform', min: 0, max: 1 },
                        { type: 'uniform', min: 1, max: 2 }
                    ],
                    bias: { probabilities: [0.8, 0.2] }
                },
                'energy',
                0
            )
        ).toContain('<bias>0.8 0.2</bias>');
    });

    it('writes an isotropic angle bias as a nested mu-phi element', () => {
        const xml = generateAngleXml({
            type: 'isotropic',
            bias: {
                distribution: {
                    type: 'mu-phi',
                    mu: { type: 'uniform', min: -1, max: 1 },
                    phi: { type: 'uniform', min: 0, max: 2 * Math.PI }
                }
            }
        });
        expect(xml).toContain('<angle type="isotropic">');
        expect(xml).toContain('<bias type="mu-phi">');
        expect(xml).toContain('<mu type="uniform" parameters="-1 1"/>');
    });

    it('writes point-cloud and mesh array bias', () => {
        expect(
            generateSpatialXml({
                type: 'pointcloud',
                positions: [
                    [0, 0, 0],
                    [1, 1, 1]
                ],
                strengths: [1, 2],
                bias: { probabilities: [0.9, 0.1] }
            })
        ).toContain('<bias>0.9 0.1</bias>');
        expect(
            generateSpatialXml({
                type: 'mesh',
                meshId: 5,
                strengths: [1, 2],
                bias: { probabilities: [0.25, 0.75] }
            })
        ).toContain('<bias>0.25 0.75</bias>');
    });

    it('imports nested and array bias shapes', () => {
        expect(
            parseUnivariateXml({
                $: { type: 'uniform', parameters: '1 10' },
                bias: { $: { type: 'uniform', parameters: '2 8' } }
            })
        ).toEqual({
            type: 'uniform',
            min: 1,
            max: 10,
            bias: { distribution: { type: 'uniform', min: 2, max: 8 } }
        });
        expect(
            parseUnivariateXml({
                $: { type: 'discrete' },
                parameters: '1 2 0.5 0.5',
                bias: '0.1 0.9'
            })
        ).toEqual({
            type: 'discrete',
            energies: [1, 2],
            probabilities: [0.5, 0.5],
            bias: { probabilities: [0.1, 0.9] }
        });
        expect(
            parseSpatialXml({
                $: { type: 'cloud' },
                coords: '0 0 0 1 1 1',
                strengths: '1 1',
                bias: '0.9 0.1'
            })
        ).toMatchObject({ bias: { probabilities: [0.9, 0.1] } });
        expect(
            parseAngleXml({
                $: { type: 'isotropic' },
                bias: {
                    $: { type: 'mu-phi' },
                    mu: { $: { type: 'uniform', parameters: '-1 1' } },
                    phi: { $: { type: 'uniform', parameters: '0 6.283185307179586' } }
                }
            })
        ).toMatchObject({ type: 'isotropic', bias: { distribution: { type: 'mu-phi' } } });
    });

    it('reports unsupported bias combinations with a fix', () => {
        const spatial = validateSourceDistributions({
            spatial: { type: 'point', origin: [0, 0, 0], bias: { probabilities: [1] } } as any,
            energy: { type: 'uniform', min: 0, max: 1 }
        });
        expect(spatial.some((issue) => issue.message.includes('does not support bias'))).toBe(true);

        const cloud = validateSourceDistributions({
            spatial: { type: 'pointcloud', positions: [[0, 0, 0]], bias: { probabilities: [1] } },
            energy: { type: 'uniform', min: 0, max: 1 }
        });
        expect(cloud.some((issue) => issue.message.includes('needs an explicit strengths array'))).toBe(true);

        const support = validateSourceDistributions({
            spatial: { type: 'point', origin: [0, 0, 0] },
            energy: { type: 'uniform', min: 0, max: 10, bias: { distribution: { type: 'uniform', min: 0, max: 5 } } }
        });
        expect(support.some((issue) => issue.message.includes('must match the parent support'))).toBe(true);

        const angle = validateSourceDistributions({
            spatial: { type: 'point', origin: [0, 0, 0] },
            energy: { type: 'uniform', min: 0, max: 10 },
            angle: {
                type: 'isotropic',
                bias: {
                    distribution: {
                        type: 'mu-phi',
                        mu: { type: 'uniform', min: 0, max: 1 },
                        phi: { type: 'uniform', min: 0, max: 2 * Math.PI }
                    }
                }
            }
        });
        expect(angle.some((issue) => issue.message.includes('supported on exactly [-1, 1]'))).toBe(true);

        const decay = validateSourceDistributions({
            spatial: { type: 'point', origin: [0, 0, 0] },
            energy: {
                type: 'decay-spectrum',
                nuclides: [{ name: 'Cs137', density: 1e-8 }],
                volume: 1,
                bias: { distribution: { type: 'uniform', min: 0, max: 1 } }
            } as any
        });
        expect(decay.some((issue) => issue.message.includes('cannot be biased'))).toBe(true);
    });

    it('adds a biased marker to the source summary', () => {
        expect(
            summarizeSource({
                spatial: { type: 'point', origin: [0, 0, 0] },
                energy: { type: 'uniform', min: 0, max: 10, bias: { distribution: { type: 'uniform', min: 0, max: 10 } } }
            })
        ).toContain('· biased');
    });
});
