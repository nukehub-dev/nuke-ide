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
 * Tests for the element-scoped nuclide-fraction renormalization in
 * parameter-paths (applyParameterByPath): enriching one nuclide scales only
 * its same-element siblings — compound stoichiometry is preserved.
 */

import { describe, it, expect } from 'vitest';

import { applyParameterByPath } from './parameter-paths';
import { OpenMCState } from './openmc-state-schema';

/** Build a minimal state with a compound material (UO2-style fractions summing to 3). */
function buildUo2State(): OpenMCState {
    const now = new Date().toISOString();
    return {
        metadata: { version: '1.1.0', name: 'test', created: now, modified: now },
        geometry: { surfaces: [], cells: [], universes: [], lattices: [], rootUniverseId: 0 },
        materials: [
            {
                id: 1,
                name: 'fuel',
                density: 10.4,
                densityUnit: 'g/cm3',
                nuclides: [
                    { name: 'U235', fraction: 0.03, fractionType: 'ao' },
                    { name: 'U238', fraction: 0.97, fractionType: 'ao' },
                    { name: 'O16', fraction: 2.0, fractionType: 'ao' }
                ],
                thermalScattering: []
            },
            {
                id: 2,
                name: 'moderator',
                density: 1.0,
                densityUnit: 'g/cm3',
                nuclides: [
                    { name: 'H1', fraction: 2.0, fractionType: 'ao' },
                    { name: 'H2', fraction: 0.0003, fractionType: 'ao' },
                    { name: 'O16', fraction: 1.0, fractionType: 'ao' }
                ],
                thermalScattering: []
            }
        ],
        settings: { run: { mode: 'eigenvalue', particles: 1000, inactive: 10, batches: 100 }, sources: [] },
        tallies: [],
        meshes: []
    };
}

describe('applyParameterByPath nuclide fractions (element-scoped renormalization)', () => {
    it('enriching U235 scales only U238 and leaves O16 untouched', () => {
        const state = buildUo2State();
        expect(applyParameterByPath(state, 'fuel.U235', 0.05)).toBe(true);

        const [u235, u238, o16] = state.materials[0].nuclides;
        expect(u235.fraction).toBe(0.05);
        // Element total (1.0) is preserved: U238 takes the remainder
        expect(u238.fraction).toBeCloseTo(0.95, 10);
        // The compound stoichiometry is NOT distorted
        expect(o16.fraction).toBe(2.0);
    });

    it('renormalizes same-element siblings proportionally (H1/H2)', () => {
        const state = buildUo2State();
        applyParameterByPath(state, 'moderator.H1', 1.5);

        const [h1, h2, o16] = state.materials[1].nuclides;
        expect(h1.fraction).toBe(1.5);
        // Element total was 2.0003; H2 keeps its share of the remaining 0.5003
        expect(h2.fraction).toBeCloseTo(0.0003 * (0.5003 / 0.0003), 6);
        expect(o16.fraction).toBe(1.0);
    });

    it('sets the fraction without renormalizing when no same-element siblings exist', () => {
        const state = buildUo2State();
        applyParameterByPath(state, 'fuel.O16', 1.5);

        const [, u238, o16] = state.materials[0].nuclides;
        expect(o16.fraction).toBe(1.5);
        // Nothing to renormalize — other nuclides are untouched
        expect(u238.fraction).toBe(0.97);
    });

    it('returns false for unknown paths and leaves the state unchanged', () => {
        const state = buildUo2State();
        expect(applyParameterByPath(state, 'unobtanium.density', 1.0)).toBe(false);
        expect(state.materials[0].nuclides[0].fraction).toBe(0.03);
    });
});
