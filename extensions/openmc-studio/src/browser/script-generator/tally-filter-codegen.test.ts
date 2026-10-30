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
 * Python exporter snapshots for the additional tally filters and the
 * `multiply_density` / `higher_moments` output options.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@theia/filesystem/lib/browser', () => ({ FileDialogService: class {}, SaveFileDialogProps: {} }));
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class {} }));
vi.mock('@theia/workspace/lib/browser/workspace-service', () => ({ WorkspaceService: class {} }));

import { OpenMCPythonExporter } from './python-exporter';
import { OpenMCState } from '../../common/openmc-state-schema';
import { NEUTRON_PARTICLE, PHOTON_PARTICLE } from '../../common/particle-types';
import { DEFAULT_OPENMC_COMPAT, OpenMCCompat } from '../../common/openmc-studio-protocol';

/** Build a minimal state with all additional filter types on one tally. */
function buildState(): OpenMCState {
    const now = new Date().toISOString();
    return {
        metadata: { version: '1.2.0', name: 'Tally filters', created: now, modified: now },
        geometry: {
            surfaces: [{ id: 1, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 10 }, boundary: 'vacuum' }],
            cells: [{ id: 1, name: 'Fuel', fillType: 'material', fillId: 1, regionString: '-1' }],
            universes: [{ id: 0, name: 'root', cellIds: [1] }],
            lattices: [],
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
            }
        ],
        settings: {
            run: { mode: 'fixed source', particles: 100, batches: 5 },
            sources: [
                {
                    spatial: { type: 'point', origin: [0, 0, 0] },
                    energy: { type: 'uniform', min: 1e5, max: 2e7 },
                    particle: NEUTRON_PARTICLE,
                    strength: 1
                }
            ]
        },
        tallies: [
            {
                id: 1,
                name: 'All filters',
                scores: ['flux', 'current'],
                nuclides: ['total'],
                multiplyDensity: false,
                higherMoments: true,
                filters: [
                    { type: 'materialfrom', bins: [1] },
                    {
                        type: 'cellinstance',
                        bins: [1, 0, 1, 1],
                        pairs: [
                            { first: 1, second: 0 },
                            { first: 1, second: 1 }
                        ]
                    },
                    { type: 'parentnuclide', bins: [], nuclideBins: ['U235', 'Pu239'] },
                    { type: 'meshborn', bins: [1], meshId: 1, meshTranslation: [1, 2, 3] },
                    {
                        type: 'meshmaterial',
                        bins: [0, 1, 1, 1],
                        pairs: [
                            { first: 0, second: 1 },
                            { first: 1, second: 1 }
                        ],
                        meshId: 1,
                        meshTranslation: [4, 5, 6]
                    },
                    { type: 'collision', bins: [1, 2] },
                    { type: 'reaction', bins: [], reactionBins: ['(n,gamma)', '(n,2n)'] },
                    {
                        type: 'particleproduction',
                        bins: [],
                        particleTypes: [PHOTON_PARTICLE, NEUTRON_PARTICLE],
                        productionEnergyBins: [0, 1e5, 2e7]
                    },
                    { type: 'musurface', bins: [-1, 0, 1] },
                    { type: 'weight', bins: [0, 0.5, 1, 2] }
                ]
            }
        ],
        meshes: [{ type: 'regular', id: 1, lowerLeft: [-5, -5, -5], upperRight: [5, 5, 5], dimension: [2, 2, 2] }],
        plots: []
    };
}

/** Render the single-file model script with an explicit compat profile. */
function render(compat: OpenMCCompat): string {
    const exporter = new OpenMCPythonExporter();
    return (exporter as unknown as { generateModelScript(state: OpenMCState, options: object): string }).generateModelScript(buildState(), {
        mode: 'single',
        includeComments: true,
        compat
    });
}

describe('python exporter tally filters', () => {
    it('emits every additional filter with the OpenMC Python API', () => {
        const script = render({ ...DEFAULT_OPENMC_COMPAT, reactionFilter: true, particleProductionFilter: true });

        expect(script).toContain('tally_1.multiply_density = False');
        expect(script).toContain('tally_1.higher_moments = True');
        expect(script).toContain('filter_1_0 = openmc.MaterialFromFilter([1])');
        expect(script).toContain('filter_1_1 = openmc.CellInstanceFilter([(1, 0), (1, 1)])');
        expect(script).toContain('filter_1_2 = openmc.ParentNuclideFilter(["U235", "Pu239"])');
        expect(script).toContain('filter_1_3 = openmc.MeshBornFilter(mesh_1)');
        expect(script).toContain('filter_1_3.translation = [1, 2, 3]');
        expect(script).toContain('filter_1_4 = openmc.MeshMaterialFilter(mesh_1, [(0, 1), (1, 1)])');
        expect(script).toContain('filter_1_4.translation = [4, 5, 6]');
        expect(script).toContain('filter_1_5 = openmc.CollisionFilter([1, 2])');
        expect(script).toContain('filter_1_6 = openmc.ReactionFilter(["(n,gamma)", "(n,2n)"])');
        expect(script).toContain('filter_1_7 = openmc.ParticleProductionFilter(["photon", "neutron"], energies=[0, 100000, 20000000])');
        expect(script).toContain('filter_1_8 = openmc.MuSurfaceFilter([-1, 0, 1])');
        expect(script).toContain('filter_1_9 = openmc.WeightFilter([0, 0.5, 1, 2])');
        expect(script).toContain(
            'tally_1.filters = [filter_1_0, filter_1_1, filter_1_2, filter_1_3, filter_1_4, filter_1_5, filter_1_6, filter_1_7, filter_1_8, filter_1_9]'
        );
    });

    it('normalizes an MT-number reaction to the canonical name', () => {
        const state = buildState();
        state.tallies[0].filters = [{ type: 'reaction', bins: [], reactionBins: ['102'] }];
        const exporter = new OpenMCPythonExporter();
        const script = (exporter as unknown as { generateModelScript(s: OpenMCState, o: object): string }).generateModelScript(state, {
            mode: 'single',
            compat: { ...DEFAULT_OPENMC_COMPAT, reactionFilter: true }
        });
        expect(script).toContain('filter_1_0 = openmc.ReactionFilter(["(n,gamma)"])');
    });

    it('omits 0.16-only filters with a comment on release environments', () => {
        const script = render(DEFAULT_OPENMC_COMPAT);
        expect(script).toContain('Reaction filters require OpenMC 0.16 or newer');
        expect(script).toContain('Particle-production filters require OpenMC 0.16 or newer');
        expect(script).not.toContain('openmc.ReactionFilter');
        expect(script).not.toContain('openmc.ParticleProductionFilter');
        // The supported filters are still emitted.
        expect(script).toContain('openmc.CellInstanceFilter');
        expect(script).toContain('openmc.MeshMaterialFilter');
    });
});
