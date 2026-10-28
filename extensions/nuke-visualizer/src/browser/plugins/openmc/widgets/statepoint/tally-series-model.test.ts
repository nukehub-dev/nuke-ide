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
 * Tests for the pure tally series model: payload validation, step/index math,
 * chart ranges and labels, statepoint filename detection, and candidate
 * resolution.
 */

import { describe, expect, it } from 'vitest';
import type { OpenMCTallySeries, OpenMCTallySeriesStatistic } from '../../../../../common/openmc-protocol';
import {
    buildSeriesChart,
    clampSeriesIndex,
    isStatepointSeriesFile,
    nextSeriesIndex,
    parseTallySeriesPayload,
    previousSeriesIndex,
    seriesCandidatePaths,
    seriesStatisticLabel,
    seriesYRange,
    TallySeriesModelError
} from './tally-series-model';

function makeSeries(): OpenMCTallySeries {
    return {
        files: ['/data/statepoint.10.h5', '/data/statepoint.20.h5'],
        tallyId: 1,
        tallyName: 'flux mesh',
        score: 'flux',
        nuclide: 'total',
        statistic: 'total',
        timeLabel: 'Statepoint step',
        steps: [
            {
                index: 0,
                time: 10,
                file: '/data/statepoint.10.h5',
                fileName: 'statepoint.10.h5',
                value: 312,
                std: 4.2,
                nBins: 12
            },
            {
                index: 1,
                time: 20,
                file: '/data/statepoint.20.h5',
                fileName: 'statepoint.20.h5',
                value: 624,
                std: 8.4,
                nBins: 12
            }
        ],
        range: [312, 624],
        viewRange: [1, 24],
        hasMesh: true,
        volumeWeighted: true
    };
}

function payloadWith(overrides: Record<string, unknown>): Record<string, unknown> {
    return { ...makeSeries(), ...overrides };
}

function payloadWithSecondStep(overrides: Record<string, unknown>): Record<string, unknown> {
    const series = makeSeries();
    return { ...series, steps: [series.steps[0], { ...series.steps[1], ...overrides }] };
}

function sibling(name: string): { name: string; path: string } {
    return { name, path: `/data/${name}` };
}

describe('parseTallySeriesPayload', () => {
    it('round-trips a valid payload and ignores extra fields', () => {
        const input = { ...makeSeries(), future: true };
        const parsed = parseTallySeriesPayload(input);
        expect(parsed).toEqual(makeSeries());
        expect(parsed).not.toBe(input);
        expect(parsed.files).not.toBe(input.files);
        expect(parsed.steps).not.toBe(input.steps);
        expect(parsed.steps[0]).not.toBe(input.steps[0]);
    });

    it('does not alias input arrays or ranges', () => {
        const input = makeSeries();
        const parsed = parseTallySeriesPayload(input);
        parsed.steps[0].value = 999;
        parsed.range[0] = -1;
        expect(input.steps[0].value).toBe(312);
        expect(input.range).toEqual([312, 624]);
    });

    it('rejects malformed roots', () => {
        for (const root of [undefined, null, 42, 'series', []]) {
            expect(() => parseTallySeriesPayload(root)).toThrow(TallySeriesModelError);
        }
        expect(() => parseTallySeriesPayload(null)).toThrow('payload must be an object');
    });

    it('rejects malformed scalar and collection fields', () => {
        const base = makeSeries();
        expect(() => parseTallySeriesPayload(payloadWith({ files: 'x' }))).toThrow('files must be an array');
        expect(() => parseTallySeriesPayload(payloadWith({ files: ['ok', 2] }))).toThrow('files[1] must be a string');
        expect(() => parseTallySeriesPayload(payloadWith({ tallyId: Number.NaN }))).toThrow('tallyId must be a finite number');
        expect(() => parseTallySeriesPayload(payloadWith({ tallyName: 1 }))).toThrow('tallyName must be a string');
        expect(() => parseTallySeriesPayload(payloadWith({ score: null }))).toThrow('score must be a string');
        expect(() => parseTallySeriesPayload(payloadWith({ nuclide: false }))).toThrow('nuclide must be a string');
        expect(() => parseTallySeriesPayload(payloadWith({ timeLabel: 3 }))).toThrow('timeLabel must be a string');
        expect(() => parseTallySeriesPayload(payloadWith({ hasMesh: 'yes' }))).toThrow('hasMesh must be a boolean');
        expect(() => parseTallySeriesPayload(payloadWith({ volumeWeighted: 1 }))).toThrow('volumeWeighted must be a boolean');
        expect(() => parseTallySeriesPayload({ ...base, steps: {} })).toThrow('steps must be an array');
        expect(() => parseTallySeriesPayload({ ...base, steps: [1] })).toThrow('steps[0] must be an object');
    });

    it('requires a non-empty steps array', () => {
        expect(() => parseTallySeriesPayload(payloadWith({ steps: [] }))).toThrow('steps must contain at least one step');
    });

    it('validates range and optional viewRange pairs', () => {
        const base = makeSeries();
        expect(() => parseTallySeriesPayload(payloadWith({ range: [1] }))).toThrow('range must be a [min, max] pair');
        expect(() => parseTallySeriesPayload(payloadWith({ range: [1, 2, 3] }))).toThrow('range must be a [min, max] pair');
        expect(() => parseTallySeriesPayload(payloadWith({ range: [Number.NaN, 1] }))).toThrow('range[0] must be a finite number');
        expect(() => parseTallySeriesPayload(payloadWith({ range: [1, Number.POSITIVE_INFINITY] }))).toThrow(
            'range[1] must be a finite number'
        );

        const withoutViewRange = { ...base, viewRange: undefined };
        expect(parseTallySeriesPayload(withoutViewRange)).not.toHaveProperty('viewRange');
        expect(parseTallySeriesPayload(payloadWith({ viewRange: [0, 5] })).viewRange).toEqual([0, 5]);
        expect(() => parseTallySeriesPayload(payloadWith({ viewRange: null }))).toThrow('viewRange must be a [min, max] pair');
        expect(() => parseTallySeriesPayload(payloadWith({ viewRange: [0] }))).toThrow('viewRange must be a [min, max] pair');
        expect(() => parseTallySeriesPayload(payloadWith({ viewRange: [0, Number.NaN] }))).toThrow('viewRange[1] must be a finite number');
    });

    it('rejects unknown statistics', () => {
        expect(() => parseTallySeriesPayload(payloadWith({ statistic: 'median' }))).toThrow("statistic must be 'total', 'mean', or 'max'");
        expect(() => parseTallySeriesPayload(payloadWith({ statistic: undefined }))).toThrow(TallySeriesModelError);
    });

    it('reports the field path of malformed step entries', () => {
        const cases: readonly [Record<string, unknown>, string][] = [
            [{ index: '0' }, 'steps[1].index must be a finite number'],
            [{ time: Number.NaN }, 'steps[1].time must be a finite number'],
            [{ value: Number.POSITIVE_INFINITY }, 'steps[1].value must be a finite number'],
            [{ std: '0' }, 'steps[1].std must be a finite number'],
            [{ nBins: -1 }, 'steps[1].nBins must be a non-negative integer'],
            [{ nBins: 1.5 }, 'steps[1].nBins must be a non-negative integer'],
            [{ file: 7 }, 'steps[1].file must be a string'],
            [{ fileName: null }, 'steps[1].fileName must be a string']
        ];
        for (const [overrides, message] of cases) {
            expect(() => parseTallySeriesPayload(payloadWithSecondStep(overrides))).toThrow(message);
        }
    });
});

describe('step index math', () => {
    it('clamps indices into range', () => {
        expect(clampSeriesIndex(1, 3)).toBe(1);
        expect(clampSeriesIndex(-4, 3)).toBe(0);
        expect(clampSeriesIndex(99, 3)).toBe(2);
        expect(clampSeriesIndex(1.9, 3)).toBe(1);
        expect(clampSeriesIndex(Number.NaN, 3)).toBe(0);
        expect(clampSeriesIndex(Number.POSITIVE_INFINITY, 3)).toBe(0);
        expect(clampSeriesIndex(0, 0)).toBe(0);
        expect(clampSeriesIndex(5, -1)).toBe(0);
    });

    it('steps backward and clamps at 0', () => {
        expect(previousSeriesIndex(2)).toBe(1);
        expect(previousSeriesIndex(0)).toBe(0);
        expect(previousSeriesIndex(-3)).toBe(0);
        expect(previousSeriesIndex(1.9)).toBe(0);
        expect(previousSeriesIndex(Number.NaN)).toBe(0);
        expect(previousSeriesIndex(Number.POSITIVE_INFINITY)).toBe(0);
        expect(previousSeriesIndex(2, 3)).toBe(1);
        expect(previousSeriesIndex(99, 3)).toBe(1);
        expect(previousSeriesIndex(0, 3)).toBe(0);
        expect(previousSeriesIndex(1, 0)).toBe(0);
    });

    it('steps forward and clamps at the last step', () => {
        expect(nextSeriesIndex(1, 3)).toBe(2);
        expect(nextSeriesIndex(2, 3)).toBe(2);
        expect(nextSeriesIndex(2.7, 3)).toBe(2);
        expect(nextSeriesIndex(-2, 3)).toBe(1);
        expect(nextSeriesIndex(0, 0)).toBe(0);
        expect(nextSeriesIndex(0, 2)).toBe(1);
    });
});

describe('seriesYRange', () => {
    it('includes error bars across all steps', () => {
        expect(seriesYRange(makeSeries())).toEqual([312 - 4.2, 624 + 8.4]);
    });

    it('pads a flat range by 5% of its magnitude', () => {
        const flat = makeSeries();
        for (const step of flat.steps) {
            step.value = 100;
            step.std = 0;
        }
        expect(seriesYRange(flat)).toEqual([95, 105]);

        for (const step of flat.steps) {
            step.value = 0;
        }
        expect(seriesYRange(flat)).toEqual([-1, 1]);
    });

    it('ignores non-finite entries and falls back when none remain', () => {
        const series = makeSeries();
        series.steps[0].std = Number.NaN;
        expect(seriesYRange(series)).toEqual([624 - 8.4, 624 + 8.4]);

        series.steps[1].value = Number.POSITIVE_INFINITY;
        expect(seriesYRange(series)).toEqual([0, 1]);
    });
});

describe('labels and chart data', () => {
    it('maps statistics to display labels', () => {
        expect(seriesStatisticLabel('total')).toBe('Total');
        expect(seriesStatisticLabel('mean')).toBe('Mean');
        expect(seriesStatisticLabel('max')).toBe('Max');
    });

    it('builds chart arrays and clamps the current marker', () => {
        const chart = buildSeriesChart(makeSeries(), 99);
        expect(chart.x).toEqual([10, 20]);
        expect(chart.y).toEqual([312, 624]);
        expect(chart.errorY).toEqual([4.2, 8.4]);
        expect(chart.currentIndex).toBe(1);
        expect(chart.xTitle).toBe('Statepoint step');
        expect(chart.yTitle).toBe('Total flux');
        expect(buildSeriesChart(makeSeries(), -4).currentIndex).toBe(0);
    });

    it('includes the statistic and non-total nuclide in the y title', () => {
        const title = (statistic: OpenMCTallySeriesStatistic, nuclide: string): string =>
            buildSeriesChart({ ...makeSeries(), statistic, nuclide }, 0).yTitle;
        expect(title('mean', 'U235')).toBe('Mean flux (U235)');
        expect(title('max', 'U235')).toBe('Max flux (U235)');
        expect(title('mean', 'total')).toBe('Mean flux');
    });
});

describe('isStatepointSeriesFile', () => {
    it('accepts statepoint and openmc simulation names case-insensitively', () => {
        for (const name of [
            'statepoint.10.h5',
            'statepoint.h5',
            'StatePoint.20.H5',
            'openmc_simulation_n2.h5',
            'OPENMC_SIMULATION_N10.H5'
        ]) {
            expect(isStatepointSeriesFile(name)).toBe(true);
        }
    });

    it('rejects other HDF5 and unrelated names', () => {
        for (const name of [
            '',
            'statepoint.10.h5.bak',
            'statepoint.10.txt',
            'statepoint.10.hdf5',
            'openmc_simulation.h5',
            'openmc_simulation_n.h5',
            'simulation_n2.h5',
            'plot_2.h5',
            'notes.h5'
        ]) {
            expect(isStatepointSeriesFile(name)).toBe(false);
        }
    });
});

describe('seriesCandidatePaths', () => {
    it('includes the current path and sorts statepoints numerically', () => {
        expect(seriesCandidatePaths('/data/statepoint.10.h5', [sibling('statepoint.20.h5'), sibling('statepoint.2.h5')])).toEqual([
            '/data/statepoint.2.h5',
            '/data/statepoint.10.h5',
            '/data/statepoint.20.h5'
        ]);
    });

    it('sorts openmc_simulation_n suffixes numerically', () => {
        expect(
            seriesCandidatePaths('/data/openmc_simulation_n10.h5', [
                sibling('openmc_simulation_n10.h5'),
                sibling('openmc_simulation_n2.h5'),
                sibling('statepoint.20.h5')
            ])
        ).toEqual(['/data/openmc_simulation_n2.h5', '/data/openmc_simulation_n10.h5', '/data/statepoint.20.h5']);
    });

    it('filters non-series siblings and dedupes exact paths', () => {
        expect(
            seriesCandidatePaths('/data/statepoint.10.h5', [
                sibling('statepoint.20.h5'),
                sibling('statepoint.10.h5'),
                sibling('statepoint.20.h5'),
                sibling('notes.h5'),
                sibling('plot_2.h5')
            ])
        ).toEqual(['/data/statepoint.10.h5', '/data/statepoint.20.h5']);
    });

    it('always includes the current path even when it is not a series or is absent', () => {
        expect(seriesCandidatePaths('/data/custom.h5', [sibling('statepoint.10.h5')])).toEqual([
            '/data/statepoint.10.h5',
            '/data/custom.h5'
        ]);
        expect(seriesCandidatePaths('/data/statepoint.5.h5', [])).toEqual(['/data/statepoint.5.h5']);
    });

    it('places non-numeric names after numeric ones and sorts them lexicographically', () => {
        expect(
            seriesCandidatePaths('/data/statepoint_latest.h5', [
                sibling('statepoint_zeta.h5'),
                sibling('statepoint.10.h5'),
                sibling('statepoint_alpha.h5')
            ])
        ).toEqual(['/data/statepoint.10.h5', '/data/statepoint_alpha.h5', '/data/statepoint_latest.h5', '/data/statepoint_zeta.h5']);
    });
});
