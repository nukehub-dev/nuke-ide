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
 * Tests for the kinetics (IFP) tally helpers (src/common/kinetics-ifp.ts).
 */

import { describe, it, expect } from 'vitest';

import { IFP_SCORES, isIfpTally, getAutoIfpTallies, deriveKineticsFromTallies } from './kinetics-ifp';
import { OpenMCTally } from './openmc-state-schema';

/** Build a minimal tally for testing. */
function tally(id: number, scores: string[], filters: OpenMCTally['filters'] = []): OpenMCTally {
    return { id, scores, nuclides: [], filters };
}

describe('isIfpTally', () => {
    it('detects IFP scores', () => {
        expect(isIfpTally(tally(1, ['ifp-denominator']))).toBe(true);
        expect(isIfpTally(tally(1, ['flux', 'ifp-beta-numerator']))).toBe(true);
        expect(isIfpTally(tally(1, ['flux']))).toBe(false);
    });
});

describe('getAutoIfpTallies', () => {
    it('returns an empty list when kinetics are disabled or absent', () => {
        expect(getAutoIfpTallies([], undefined, 1)).toEqual([]);
        expect(getAutoIfpTallies([], { enabled: false }, 1)).toEqual([]);
    });

    it('generates all three IFP tallies by default', () => {
        const auto = getAutoIfpTallies([], { enabled: true }, 5);
        expect(auto.map((t) => t.scores[0])).toEqual([IFP_SCORES.timeNumerator, IFP_SCORES.betaNumerator, IFP_SCORES.denominator]);
        expect(auto.map((t) => t.id)).toEqual([5, 6, 7]);
        expect(auto.every((t) => t.filters.length === 0)).toBe(true);
    });

    it('adds a delayed group filter for group-wise beta', () => {
        const auto = getAutoIfpTallies([], { enabled: true, numPrecursorGroups: 6 }, 1);
        const beta = auto.find((t) => t.scores.includes(IFP_SCORES.betaNumerator));
        expect(beta?.filters).toEqual([{ type: 'delayedgroup', bins: [1, 2, 3, 4, 5, 6] }]);
    });

    it('skips scores the user already defined', () => {
        const existing = [tally(3, ['ifp-denominator'])];
        const auto = getAutoIfpTallies(existing, { enabled: true }, 4);
        expect(auto.map((t) => t.scores[0])).toEqual([IFP_SCORES.timeNumerator, IFP_SCORES.betaNumerator]);
    });

    it('respects the compute flags', () => {
        const betaOnly = getAutoIfpTallies([], { enabled: true, computeGenerationTime: false }, 1);
        expect(betaOnly.map((t) => t.scores[0])).toEqual([IFP_SCORES.betaNumerator, IFP_SCORES.denominator]);

        const timeOnly = getAutoIfpTallies([], { enabled: true, computeBetaEff: false }, 1);
        expect(timeOnly.map((t) => t.scores[0])).toEqual([IFP_SCORES.timeNumerator, IFP_SCORES.denominator]);
    });
});

describe('deriveKineticsFromTallies', () => {
    it('returns the existing value when no IFP tally is present', () => {
        expect(deriveKineticsFromTallies([tally(1, ['flux'])], undefined)).toBeUndefined();
        const existing = { enabled: false };
        expect(deriveKineticsFromTallies([], existing)).toBe(existing);
    });

    it('derives enabled settings with group count from parsed tallies', () => {
        const tallies = [
            tally(1, ['ifp-time-numerator']),
            tally(2, ['ifp-beta-numerator'], [{ type: 'delayedgroup', bins: [1, 2, 3, 4, 5, 6] }]),
            tally(3, ['ifp-denominator'])
        ];
        expect(deriveKineticsFromTallies(tallies, { ifpNGenerations: 4 })).toEqual({
            enabled: true,
            ifpNGenerations: 4,
            numPrecursorGroups: 6,
            computeBetaEff: true,
            computeGenerationTime: true
        });
    });

    it('derives total-only beta and disabled generation time', () => {
        const tallies = [tally(1, ['ifp-beta-numerator']), tally(2, ['ifp-denominator'])];
        expect(deriveKineticsFromTallies(tallies, undefined)).toEqual({
            enabled: true,
            ifpNGenerations: undefined,
            numPrecursorGroups: undefined,
            computeBetaEff: true,
            computeGenerationTime: false
        });
    });
});
