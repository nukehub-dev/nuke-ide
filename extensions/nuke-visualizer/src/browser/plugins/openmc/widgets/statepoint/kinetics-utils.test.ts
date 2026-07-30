// *****************************************************************************
// Copyright (C) 2026 NukeHub and others.
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
 * Tests for the IFP kinetics helpers: IFP tally detection, uncertainty
 * formatting, and CSV serialization (pure, no DI).
 */

import { describe, expect, it } from 'vitest';
import type { OpenMCKineticsResult } from '../../../../../common/openmc-protocol';
import { formatUncertainty, formatValue, hasIfpTallies, kineticsToCsv } from './kinetics-utils';

describe('hasIfpTallies', () => {
    it('detects IFP scores in the tally list', () => {
        expect(hasIfpTallies([{ scores: ['flux'] }, { scores: ['ifp-denominator', 'ifp-beta-numerator'] }])).toBe(true);
        expect(hasIfpTallies([{ scores: ['ifp-time-numerator'] }])).toBe(true);
    });

    it('is false without IFP scores', () => {
        expect(hasIfpTallies([])).toBe(false);
        expect(hasIfpTallies([{ scores: ['flux', 'heating'] }, { scores: [] }])).toBe(false);
    });
});

describe('formatValue', () => {
    it('uses fixed notation for moderate magnitudes', () => {
        expect(formatValue(0.0075)).toBe('0.0075');
        expect(formatValue(1.00001)).toBe('1.00001');
        expect(formatValue(0)).toBe('0');
    });

    it('uses exponential notation for small and huge magnitudes', () => {
        expect(formatValue(5.1e-5)).toBe('5.10000e-5');
        expect(formatValue(1.2e7)).toBe('1.20000e+7');
    });
});

describe('formatUncertainty', () => {
    it('combines mean and std with ± and 2-digit uncertainty', () => {
        expect(formatUncertainty({ mean: 0.0075, stdDev: 0.00012 })).toBe('0.0075 ± 0.00012');
        expect(formatUncertainty({ mean: 5.1e-5, stdDev: 3.21e-6 })).toBe('5.10000e-5 ± 3.2e-6');
    });
});

describe('kineticsToCsv', () => {
    const result: OpenMCKineticsResult = {
        file: 'statepoint.100.h5',
        method: 'openmc',
        keff: { mean: 1.00001, stdDev: 0.00012 },
        betaEffective: { mean: 0.0075, stdDev: 0.0002 },
        betaEffectiveGroups: [
            { mean: 0.0005, stdDev: 0.0001 },
            { mean: 0.003, stdDev: 0.0001 },
            { mean: 0.004, stdDev: 0.0001 }
        ],
        generationTime: { mean: 5.1e-5, stdDev: 3.2e-6 }
    };

    it('serializes all parameters with a header row', () => {
        const csv = kineticsToCsv(result);
        const lines = csv.trimEnd().split('\n');
        expect(lines[0]).toBe('parameter,group,mean,std_dev');
        expect(lines).toContain('beta_eff,total,0.0075,0.0002');
        expect(lines).toContain('beta_eff,group_1,0.0005,0.0001');
        expect(lines).toContain('beta_eff,group_3,0.004,0.0001');
        expect(lines).toContain('lambda_eff,,0.000051,0.0000032');
        expect(lines).toContain('k_eff,,1.00001,0.00012');
        expect(csv.endsWith('\n')).toBe(true);
        expect(lines).toHaveLength(7);
    });

    it('omits missing parameters', () => {
        const csv = kineticsToCsv({ file: 'sp.h5', method: 'h5py', betaEffective: { mean: 0.007, stdDev: 0.001 } });
        const lines = csv.trimEnd().split('\n');
        expect(lines).toHaveLength(2);
        expect(lines[1]).toBe('beta_eff,total,0.007,0.001');
    });
});
