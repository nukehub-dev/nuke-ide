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
 * Tests for the random ray (multi-group) restrictions in validateState:
 * IFP kinetics and non-supported tally scores are errors.
 */

import { describe, it, expect } from 'vitest';

import { OpenMCStudioBackendServiceImpl } from './openmc-studio-backend-service';
import { OpenMCState } from '../common/openmc-state-schema';

/** Minimal state that passes the unrelated checks (materials + geometry present). */
function buildState(): OpenMCState {
    const now = new Date().toISOString();
    return {
        metadata: { version: '1.1.0', name: 'Validation Test', created: now, modified: now },
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
            run: { mode: 'eigenvalue', particles: 100, inactive: 5, batches: 10 },
            sources: []
        },
        tallies: [],
        meshes: [],
        plots: []
    } as OpenMCState;
}

describe('validateState depletion operator restrictions', () => {
    /** Enable depletion with the required basics so only the operator checks fire. */
    function enableDepletion(state: OpenMCState): void {
        state.depletion = { enabled: true, chainFile: '/chains/chain.xml', power: 1e6, timeSteps: [86400] };
        (state.materials[0] as any).isDepletable = true;
    }

    it('errors on coupled depletion in multi-group mode', async () => {
        const state = buildState();
        state.settings.energyMode = 'multigroup';
        enableDepletion(state);

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(
            result.issues.some((i) => i.severity === 'error' && i.message.includes('Coupled depletion requires continuous-energy mode'))
        ).toBe(true);
    });

    it('accepts coupled depletion in continuous-energy mode', async () => {
        const state = buildState();
        enableDepletion(state);

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(result.issues.some((i) => i.message.includes('Coupled depletion'))).toBe(false);
    });

    it('errors on the independent operator without flux/MicroXS inputs', async () => {
        const state = buildState();
        state.settings.energyMode = 'multigroup';
        enableDepletion(state);
        state.depletion!.operator = 'independent';

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(
            result.issues.some(
                (i) => i.severity === 'error' && i.message.includes('Independent depletion operator requires flux and MicroXS files')
            )
        ).toBe(true);
    });

    it('errors on model-based MicroXS generation in multi-group mode', async () => {
        const state = buildState();
        state.settings.energyMode = 'multigroup';
        enableDepletion(state);
        state.depletion!.operator = 'independent';
        state.depletion!.generateFromModel = true;

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(
            result.issues.some((i) => i.severity === 'error' && i.message.includes('MicroXS generation requires continuous-energy mode'))
        ).toBe(true);
    });

    it('accepts model-based MicroXS generation in continuous-energy mode', async () => {
        const state = buildState();
        enableDepletion(state);
        state.depletion!.operator = 'independent';
        state.depletion!.generateFromModel = true;

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(result.issues.some((i) => i.message.includes('MicroXS generation'))).toBe(false);
        expect(result.issues.some((i) => i.message.includes('Coupled depletion'))).toBe(false);
    });

    it('errors when a depletable material is macroscopic', async () => {
        const state = buildState();
        enableDepletion(state);
        (state.materials[0] as any).macroscopic = { name: 'Water' };

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        const macroError = result.issues.find(
            (i) => i.severity === 'error' && i.message.includes('Depletion requires nuclide-decomposed materials')
        );
        expect(macroError).toBeDefined();
        expect(macroError!.message).toContain('Water');
    });

    it('accepts the independent operator with per-material flux/MicroXS files', async () => {
        const state = buildState();
        enableDepletion(state);
        state.depletion!.operator = 'independent';
        state.depletion!.fluxFiles = ['/data/flux_1.npy'];
        state.depletion!.microxsFiles = ['/data/micro_1.csv'];

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(result.issues.some((i) => i.message.includes('flux and MicroXS'))).toBe(false);
    });
});

describe('validateState random ray (multi-group) restrictions', () => {
    it('errors when IFP kinetics is enabled in multi-group mode', async () => {
        const state = buildState();
        state.settings.energyMode = 'multigroup';
        state.settings.kinetics = { enabled: true, ifpNGenerations: 4 };

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(result.valid).toBe(false);
        expect(
            result.issues.some((i) => i.severity === 'error' && i.message.includes('IFP kinetics is not supported in random ray mode'))
        ).toBe(true);
    });

    it('does not error on kinetics in continuous-energy mode', async () => {
        const state = buildState();
        state.settings.kinetics = { enabled: true, ifpNGenerations: 4 };

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(result.issues.some((i) => i.message.includes('random ray'))).toBe(false);
    });

    it('errors on tally scores outside the random ray set, listing the offenders', async () => {
        const state = buildState();
        state.settings.energyMode = 'multigroup';
        state.tallies = [
            { id: 1, name: 'Fuel Flux', scores: ['flux', 'absorption'], nuclides: [], filters: [] },
            { id: 2, name: 'Heating Tally', scores: ['heating'], nuclides: [], filters: [] },
            {
                id: 3,
                name: 'Good Tally',
                scores: ['flux', 'total', 'fission', 'nu-fission', 'kappa-fission', 'events'],
                nuclides: [],
                filters: []
            }
        ];

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        const scoreError = result.issues.find(
            (i) => i.severity === 'error' && i.message.includes('Scores not supported in random ray mode')
        );
        expect(scoreError).toBeDefined();
        expect(scoreError!.message).toContain('tally 1 (Fuel Flux): absorption');
        expect(scoreError!.message).toContain('tally 2 (Heating Tally): heating');
        expect(scoreError!.message).not.toContain('Good Tally');
    });

    it('accepts the six supported random ray scores without error', async () => {
        const state = buildState();
        state.settings.energyMode = 'multigroup';
        state.tallies = [
            {
                id: 1,
                name: 'RR Tally',
                scores: ['flux', 'total', 'fission', 'nu-fission', 'kappa-fission', 'events'],
                nuclides: [],
                filters: []
            }
        ];

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(result.issues.some((i) => i.message.includes('random ray'))).toBe(false);
    });

    it('errors when multi-group mode has nuclide-decomposed materials', async () => {
        const state = buildState();
        state.settings.energyMode = 'multigroup';
        state.settings.mgxsLibrary = '/lib/mgxs.h5';

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(
            result.issues.some((i) => i.severity === 'error' && i.message.includes('Multi-group mode requires macroscopic materials'))
        ).toBe(true);
    });

    it('accepts multi-group mode with macroscopic materials', async () => {
        const state = buildState();
        state.settings.energyMode = 'multigroup';
        state.settings.mgxsLibrary = '/lib/mgxs.h5';
        (state.materials[0] as any).macroscopic = { name: 'Water' };
        (state.materials[0] as any).nuclides = [];

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(result.issues.some((i) => i.message.includes('macroscopic materials'))).toBe(false);
    });

    it('errors when a fixed-source random ray source is not domain-constrained', async () => {
        const state = buildState();
        state.settings.energyMode = 'multigroup';
        state.settings.run.mode = 'fixed source';
        state.settings.randomRay = { distanceInactive: 500, distanceActive: 1000 };
        state.settings.sources = [
            {
                type: 'independent',
                spatial: { type: 'box', lowerLeft: [0, 0, 0], upperRight: [10, 10, 10] },
                energy: { type: 'discrete', energies: [1e6], probabilities: [1] },
                angle: { type: 'isotropic' }
            }
        ];

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(
            result.issues.some(
                (i) =>
                    i.severity === 'error' &&
                    i.message.includes('Fixed-source random ray requires') &&
                    i.message.includes('constrained to a domain')
            )
        ).toBe(true);
    });

    it('accepts a point source in fixed-source random ray mode', async () => {
        const state = buildState();
        state.settings.energyMode = 'multigroup';
        state.settings.run.mode = 'fixed source';
        state.settings.randomRay = { distanceInactive: 500, distanceActive: 1000 };
        state.settings.sources = [
            {
                type: 'independent',
                spatial: { type: 'point', origin: [0, 0, 0] },
                energy: { type: 'discrete', energies: [1e6], probabilities: [1] },
                angle: { type: 'isotropic' }
            }
        ];

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(result.issues.some((i) => i.message.includes('Fixed-source random ray requires'))).toBe(false);
    });

    it('accepts a domain-constrained source in fixed-source random ray mode', async () => {
        const state = buildState();
        state.settings.energyMode = 'multigroup';
        state.settings.run.mode = 'fixed source';
        state.settings.randomRay = { distanceInactive: 500, distanceActive: 1000 };
        state.settings.sources = [
            {
                type: 'independent',
                spatial: { type: 'box', lowerLeft: [0, 0, 0], upperRight: [10, 10, 10] },
                energy: { type: 'discrete', energies: [1e6], probabilities: [1] },
                angle: { type: 'isotropic' },
                constraints: { domainType: 'material', domainIds: [1] }
            }
        ];

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(result.issues.some((i) => i.message.includes('Fixed-source random ray requires'))).toBe(false);
    });

    it('warns when a point source is outside the geometry bounds', async () => {
        const state = buildState();
        state.settings.energyMode = 'multigroup';
        state.settings.run.mode = 'fixed source';
        state.settings.randomRay = { distanceInactive: 500, distanceActive: 1000 };
        state.settings.sources = [
            {
                type: 'independent',
                spatial: { type: 'point', origin: [100, 0, 0] },
                energy: { type: 'discrete', energies: [1e6], probabilities: [1] },
                angle: { type: 'isotropic' }
            }
        ];

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(result.issues.some((i) => i.severity === 'warning' && i.message.includes('outside the geometry bounds'))).toBe(true);
    });

    it('warns when a box source does not overlap the geometry', async () => {
        const state = buildState();
        state.settings.energyMode = 'multigroup';
        state.settings.run.mode = 'fixed source';
        state.settings.randomRay = { distanceInactive: 500, distanceActive: 1000 };
        state.settings.sources = [
            {
                type: 'independent',
                spatial: { type: 'box', lowerLeft: [50, 0, 0], upperRight: [60, 10, 10] },
                energy: { type: 'discrete', energies: [1e6], probabilities: [1] },
                angle: { type: 'isotropic' },
                constraints: { domainType: 'material', domainIds: [1] }
            }
        ];

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(result.issues.some((i) => i.severity === 'warning' && i.message.includes('does not overlap the geometry'))).toBe(true);
    });

    it('errors when a source domain constraint references an unknown material ID', async () => {
        const state = buildState();
        state.settings.energyMode = 'multigroup';
        state.settings.run.mode = 'fixed source';
        state.settings.randomRay = { distanceInactive: 500, distanceActive: 1000 };
        state.settings.sources = [
            {
                type: 'independent',
                spatial: { type: 'box', lowerLeft: [0, 0, 0], upperRight: [10, 10, 10] },
                energy: { type: 'discrete', energies: [1e6], probabilities: [1] },
                angle: { type: 'isotropic' },
                constraints: { domainType: 'material', domainIds: [999] }
            }
        ];

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(result.issues.some((i) => i.severity === 'error' && i.message.includes('unknown material IDs: 999'))).toBe(true);
    });

    it('accepts a source domain constraint with a valid material ID', async () => {
        const state = buildState();
        state.settings.energyMode = 'multigroup';
        state.settings.run.mode = 'fixed source';
        state.settings.randomRay = { distanceInactive: 500, distanceActive: 1000 };
        state.settings.sources = [
            {
                type: 'independent',
                spatial: { type: 'box', lowerLeft: [0, 0, 0], upperRight: [10, 10, 10] },
                energy: { type: 'discrete', energies: [1e6], probabilities: [1] },
                angle: { type: 'isotropic' },
                constraints: { domainType: 'material', domainIds: [1] }
            }
        ];

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(result.issues.some((i) => i.message.includes('unknown material IDs'))).toBe(false);
    });
});

describe('validateState nuclide-wise multi-group mode', () => {
    it('accepts nuclide-decomposed materials when nuclideWiseMgxs is set', async () => {
        const state = buildState();
        state.settings.energyMode = 'multigroup';
        state.settings.mgxsLibrary = '/lib/mgxs.h5';
        state.settings.nuclideWiseMgxs = true;

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(result.issues.some((i) => i.message.includes('Multi-group mode requires macroscopic materials'))).toBe(false);
    });

    it('errors on macroscopic materials when nuclideWiseMgxs is set', async () => {
        const state = buildState();
        state.settings.energyMode = 'multigroup';
        state.settings.mgxsLibrary = '/lib/mgxs.h5';
        state.settings.nuclideWiseMgxs = true;
        (state.materials[0] as any).macroscopic = { name: 'Water' };

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(
            result.issues.some(
                (i) => i.severity === 'error' && i.message.includes('Nuclide-wise multi-group mode keeps materials nuclide-decomposed')
            )
        ).toBe(true);
    });

    it('still errors on nuclide-decomposed materials without the nuclide-wise flag', async () => {
        const state = buildState();
        state.settings.energyMode = 'multigroup';
        state.settings.mgxsLibrary = '/lib/mgxs.h5';

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(
            result.issues.some((i) => i.severity === 'error' && i.message.includes('Multi-group mode requires macroscopic materials'))
        ).toBe(true);
    });
});

describe('validateState random ray + DAGMC', () => {
    /** Enable random ray on a DAGMC geometry with the required basics. */
    function enableDagmcRandomRay(state: OpenMCState): void {
        state.settings.dagmcFile = '/data/tokamak.h5m';
        state.settings.randomRay = { distanceInactive: 500, distanceActive: 1000 };
        state.settings.mgxsLibrary = '/lib/mgxs.h5';
    }

    it('errors on macroscopic materials (OpenMC aborts at initialization)', async () => {
        const state = buildState();
        enableDagmcRandomRay(state);
        state.settings.energyMode = 'multigroup';
        state.settings.nuclideWiseMgxs = true;
        (state.materials[0] as any).macroscopic = { name: 'Water' };
        (state.materials[0] as any).nuclides = [];

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(
            result.issues.some((i) => i.severity === 'error' && i.message.includes('does not support macroscopic multi-group materials'))
        ).toBe(true);
    });

    it('errors outside multi-group mode', async () => {
        const state = buildState();
        enableDagmcRandomRay(state);

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(result.issues.some((i) => i.severity === 'error' && i.message.includes('Random ray requires multi-group energy mode'))).toBe(
            true
        );
    });

    it('errors on a material-wise library in multi-group mode', async () => {
        const state = buildState();
        enableDagmcRandomRay(state);
        state.settings.energyMode = 'multigroup';

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(result.issues.some((i) => i.severity === 'error' && i.message.includes('requires a nuclide-wise MGXS library'))).toBe(true);
    });

    it('accepts nuclide-wise multi-group with nuclide-decomposed materials', async () => {
        const state = buildState();
        enableDagmcRandomRay(state);
        state.settings.energyMode = 'multigroup';
        state.settings.nuclideWiseMgxs = true;

        const backend = new OpenMCStudioBackendServiceImpl();
        const result = await backend.validateState({ state });

        expect(result.issues.some((i) => i.message.includes('DAGMC') && i.severity === 'error')).toBe(false);
    });
});
