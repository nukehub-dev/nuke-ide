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

import { describe, expect, it } from 'vitest';
import type { OpenMCDerivedTallyResult } from '../../../../../common/openmc-protocol';
import { aggregateDerivedResult, buildDerivedChart, derivedBinRows, derivedFilterBinCount, derivedTallyToCsv } from './derived-tally-model';

function result(overrides: Partial<OpenMCDerivedTallyResult> = {}): OpenMCDerivedTallyResult {
    return {
        id: 1,
        name: 'Flux ratio',
        formula: 'T1[flux] / T2[fission]',
        unit: 'ratio',
        mean: [1, 2, 3, 4],
        stdDev: [0.1, 0.2, 0.3, 0.4],
        totalBins: 4,
        filters: [
            { type: 'cell', bins: [1, 2] },
            {
                type: 'energy',
                bins: [
                    [0, 1e6],
                    [1e6, 2e6]
                ]
            }
        ],
        scores: ['(flux / fission)'],
        nuclides: ['total'],
        shape: { filterBins: 4, nuclides: 1, scores: 1 },
        ...overrides
    };
}

describe('derived tally result model', () => {
    it('decodes filter-major bins into labeled rows', () => {
        const rows = derivedBinRows(result());
        expect(derivedFilterBinCount(result())).toBe(4);
        expect(rows).toHaveLength(4);
        expect(rows[0]).toMatchObject({ mean: 1, stdDev: 0.1, nuclide: 'total', filterLabels: ['cell 1', 'energy 0–1.000e+6 eV'] });
        expect(rows[3].filterLabels).toEqual(['cell 2', 'energy 1.000e+6–2.000e+6 eV']);
        expect(rows[3].mean).toBe(4);
    });

    it('expands the nuclide axis after the filter axes', () => {
        const rows = derivedBinRows(
            result({
                mean: [1, 10, 2, 20],
                stdDev: [0, 0, 0, 0],
                filters: [{ type: 'cell', bins: [1] }],
                nuclides: ['total', 'U235'],
                shape: { filterBins: 2, nuclides: 2, scores: 1 }
            })
        );
        expect(rows.map((row) => [row.nuclide, row.mean])).toEqual([
            ['total', 1],
            ['U235', 10],
            ['total', 2],
            ['U235', 20]
        ]);
    });

    it('aggregates finite bins and combines uncertainty in quadrature', () => {
        expect(aggregateDerivedResult(result())).toEqual({
            value: 10,
            stdDev: Math.sqrt(0.1 ** 2 + 0.2 ** 2 + 0.3 ** 2 + 0.4 ** 2),
            bins: 4
        });
    });

    it('uses real energy midpoints for a single energy axis and bin indexes otherwise', () => {
        const energy = buildDerivedChart(
            result({
                mean: [1, 2],
                stdDev: [0.1, 0.2],
                filters: [
                    {
                        type: 'energy',
                        bins: [
                            [0, 1e6],
                            [1e6, 2e6]
                        ]
                    }
                ],
                shape: { filterBins: 2, nuclides: 1, scores: 1 }
            })
        );
        expect(energy.x).toEqual([500000, 1500000]);
        expect(energy.xTitle).toBe('Energy (eV)');
        expect(energy.yTitle).toContain('[ratio]');

        const binned = buildDerivedChart(result());
        expect(binned.x).toEqual([1, 2, 3, 4]);
        expect(binned.xTitle).toBe('Bin');
    });

    it('exports one CSV row per filter bin with unit metadata preserved separately', () => {
        const csv = derivedTallyToCsv(result());
        const lines = csv.split('\n');
        expect(lines[0]).toBe('bin,cell,energy,score,nuclide,mean,std_dev');
        expect(lines).toHaveLength(5);
        expect(lines[1]).toContain('(flux / fission)');
        expect(lines[1]).toContain(',1,0.1');
    });
});
