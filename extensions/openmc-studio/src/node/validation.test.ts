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
});
