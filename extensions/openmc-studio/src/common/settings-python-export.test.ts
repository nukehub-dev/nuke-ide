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

import { describe, it, expect } from 'vitest';
import { OpenMCState, OpenMCSettings } from './openmc-state-schema';
import { generateMaterialIsotropicPython, generateRuntimeSettingsPython, generateTemperatureCutoffPython } from './settings-python-export';

/** State exercising the runtime/advanced settings Python export. */
function buildState(): OpenMCState {
    const now = new Date().toISOString();
    const settings: OpenMCSettings = {
        run: { mode: 'eigenvalue', particles: 100, inactive: 5, batches: 20 },
        sources: [],
        threads: 4,
        mpi: { enabled: true, processes: 2, hosts: ['node1'] },
        trace: [2, 1, 7],
        keffTrigger: { type: 'rel_err', threshold: 0.001 },
        confidenceIntervals: true,
        temperature: { default: 600, method: 'interpolation', tolerance: 15, multipole: false },
        cutoff: { energyNeutron: 1e-3, energyPhoton: 1000, time: 1e-4, timePhoton: 1e-3, weight: 0.25, weightAvg: 1 },
        resonanceScattering: { enable: true, method: 'dbrc', energyMin: 0.01, energyMax: 1000 },
        freeGasThreshold: 400,
        sharedSecondaryBank: true,
        surfaceGrazingCutoff: 0.001,
        surfaceGrazingRatio: 0.5,
        maxParticleEvents: 1000000,
        maxParticlesInFlight: 100000,
        maxSecondaries: 10000,
        maxHistorySplits: 10000000,
        maxWriteLostParticles: 5,
        noReduce: true,
        stride: 152917,
        plotSeed: 3,
        propertiesFile: '/tmp/properties.h5',
        verbosity: 7,
        materialCellOffsets: false
    };
    return {
        metadata: { version: '1.1.0', name: 'python-export', created: now, modified: now },
        geometry: {
            surfaces: [{ id: 1, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 5 }, boundary: 'vacuum' }],
            cells: [{ id: 1, fillType: 'material', fillId: 1, regionString: '-1' }],
            universes: [{ id: 0, cellIds: [1] }],
            lattices: [],
            rootUniverseId: 0
        },
        materials: [
            {
                id: 1,
                name: 'Water',
                density: 1,
                densityUnit: 'g/cm3',
                nuclides: [{ name: 'H1', fraction: 2, fractionType: 'ao' }],
                thermalScattering: [],
                isotropic: ['H1'],
                temperature: 600
            }
        ],
        settings,
        tallies: [],
        meshes: []
    };
}

describe('OpenMC Python exporter runtime settings', () => {
    it('exports every runtime/advanced setting with valid OpenMC attributes', () => {
        const state = buildState();
        const code = [...generateTemperatureCutoffPython(state.settings), ...generateRuntimeSettingsPython(state.settings)].join('\n');

        // Threads are a CLI concern; the invalid settings.threads line is gone.
        expect(code).not.toContain('settings.threads');
        expect(code).toContain("settings.temperature['default'] = 600");
        expect(code).toContain('settings.temperature[\'method\'] = "interpolation"');
        expect(code).toContain("settings.temperature['tolerance'] = 15");
        expect(code).toContain("settings.temperature['multipole'] = False");
        expect(code).toContain("settings.cutoff['energy_neutron'] = 0.001");
        expect(code).toContain("settings.cutoff['energy_photon'] = 1000");
        expect(code).toContain("settings.cutoff['time_neutron'] = 0.0001");
        expect(code).toContain("settings.cutoff['time_photon'] = 0.001");
        expect(code).toContain("settings.cutoff['weight'] = 0.25");
        expect(code).toContain("settings.cutoff['weight_avg'] = 1");
        expect(code).toContain('settings.trace = (2, 1, 7)');
        expect(code).toContain("settings.keff_trigger = {'type': \"rel_err\", 'threshold': 0.001}");
        expect(code).toContain('settings.confidence_intervals = True');
        expect(code).toContain('settings.free_gas_threshold = 400');
        expect(code).toContain('settings.shared_secondary_bank = True');
        expect(code).toContain('settings.surface_grazing_cutoff = 0.001');
        expect(code).toContain('settings.surface_grazing_ratio = 0.5');
        expect(code).toContain('settings.max_particle_events = 1000000');
        expect(code).toContain('settings.max_particles_in_flight = 100000');
        expect(code).toContain('settings.max_secondaries = 10000');
        expect(code).toContain('settings.max_history_splits = 10000000');
        expect(code).toContain('settings.max_write_lost_particles = 5');
        expect(code).toContain('settings.no_reduce = True');
        expect(code).toContain('settings.stride = 152917');
        expect(code).toContain('settings.plot_seed = 3');
        expect(code).toContain('settings.properties_file = "/tmp/properties.h5"');
        expect(code).toContain('settings.verbosity = 7');
        expect(code).toContain('settings.material_cell_offsets = False');
        expect(code).toContain(
            "settings.resonance_scattering = {'enable': True, 'method': \"dbrc\", 'energy_min': 0.01, 'energy_max': 1000}"
        );
    });

    it('exports Material.isotropic in the materials block', () => {
        const material = buildState().materials[0];
        expect(generateMaterialIsotropicPython(material, 'water')).toEqual(['water.isotropic = ["H1"]']);
    });

    it('omits runtime assignments that are unset', () => {
        const state = buildState();
        state.settings = { run: state.settings.run, sources: [] };
        expect(generateTemperatureCutoffPython(state.settings)).toEqual([]);
        expect(generateRuntimeSettingsPython(state.settings)).toEqual([]);
        expect(generateMaterialIsotropicPython({ ...buildState().materials[0], isotropic: [] }, 'water')).toEqual([]);
    });

    it('gates 0.16-only assignments with the probed capability', () => {
        const state = buildState();
        const code = generateRuntimeSettingsPython(state.settings, {
            raySourceFormat: 'direct',
            adjointSource: false,
            tokamakSource: false,
            s2SampleMethod: false,
            depletionSubsteps: false,
            depletionKeffSearch: false,
            depletionExternalSourceRate: true,
            depletionContinuation: true,
            sharedSecondaryBank: false,
            surfaceGrazing: false
        }).join('\n');
        expect(code).not.toContain('settings.shared_secondary_bank');
        expect(code).not.toContain('settings.surface_grazing_cutoff');
        expect(code).toContain('# shared_secondary_bank requires OpenMC 0.16.0+');
        expect(code).toContain('# Surface grazing cutoffs require OpenMC 0.16.0+');
    });

    it('does not emit an invalid zero max_write_lost_particles assignment', () => {
        const state = buildState();
        state.settings.maxWriteLostParticles = 0;
        const code = generateRuntimeSettingsPython(state.settings).join('\n');
        expect(code).not.toContain('settings.max_write_lost_particles');
        expect(code).toContain('max_write_lost_particles=0');
    });
});
