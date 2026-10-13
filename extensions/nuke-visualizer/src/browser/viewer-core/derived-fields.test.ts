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
import {
    DEFAULT_HISTOGRAM_BINS,
    DerivedFieldError,
    DerivedFieldSourceArray,
    computeArrayStats,
    computeHistogram,
    derivedFieldName,
    evaluateDerivedField,
    normalizeHistogramBinCount,
    parseDerivedField
} from './derived-fields';

const NAMES = ['mean', 'std', 'flux', 'velocity'];

function scalar(name: string, values: number[], association: 'point' | 'cell' = 'point'): DerivedFieldSourceArray {
    return { name, association, components: 1, values };
}

describe('parseDerivedField', () => {
    it('parses division and subtraction', () => {
        expect(parseDerivedField('std/mean', NAMES)).toMatchObject({
            expression: 'std/mean',
            node: { kind: 'divide', left: 'std', right: 'mean' },
            arrays: ['std', 'mean']
        });
        expect(parseDerivedField('mean-std', NAMES)).toMatchObject({
            expression: 'mean-std',
            node: { kind: 'subtract', left: 'mean', right: 'std' }
        });
    });

    it('tolerates surrounding whitespace', () => {
        expect(parseDerivedField('  std  /  mean ', NAMES).expression).toBe('std/mean');
        expect(parseDerivedField('mag( velocity )', NAMES).expression).toBe('mag(velocity)');
    });

    it('parses mag/log10 calls and bare names', () => {
        expect(parseDerivedField('mag(velocity)', NAMES)).toMatchObject({
            node: { kind: 'magnitude', argument: 'velocity' }
        });
        expect(parseDerivedField('log10(flux)', NAMES)).toMatchObject({
            node: { kind: 'log10', argument: 'flux' }
        });
        expect(parseDerivedField('flux', NAMES)).toMatchObject({ node: { kind: 'array', name: 'flux' } });
    });

    it('rejects unknown array names', () => {
        expect(() => parseDerivedField('std/relerr', NAMES)).toThrow(DerivedFieldError);
        expect(() => parseDerivedField('mag(missing)', NAMES)).toThrow(DerivedFieldError);
        expect(() => parseDerivedField('missing', NAMES)).toThrow(DerivedFieldError);
    });

    it('rejects everything outside the closed grammar', () => {
        for (const text of [
            '',
            '   ',
            'a+b',
            'a*b',
            'a/b/c',
            'a-b-c',
            '-a',
            'a-',
            '/a',
            'mag(a-b)',
            'log10(a, b)',
            'log10()',
            'MAG(velocity)',
            'Log10(flux)',
            'std / mean / flux',
            '(std)',
            'std mean',
            '2*mean'
        ]) {
            expect(() => parseDerivedField(text, [...NAMES, 'a', 'b', 'c', 'flux', 'std', 'mean']), `rejected: ${text}`).toThrow(
                DerivedFieldError
            );
        }
    });

    it('is case-sensitive on array names', () => {
        expect(() => parseDerivedField('STD/mean', NAMES)).toThrow(DerivedFieldError);
    });
});

describe('evaluateDerivedField', () => {
    it('subtracts tuple-wise', () => {
        const result = evaluateDerivedField(parseDerivedField('mean-std', NAMES), [scalar('mean', [5, 7]), scalar('std', [1, 2])]);
        expect([...result.values]).toEqual([4, 5]);
        expect(result.association).toBe('point');
        expect(result.name).toBe(derivedFieldName('mean-std'));
        expect(result.range).toEqual([4, 5]);
    });

    it('maps divide-by-zero to NaN (never Infinity)', () => {
        const result = evaluateDerivedField(parseDerivedField('std/mean', NAMES), [
            scalar('std', [1, 0, 0, 5]),
            scalar('mean', [2, 0, 4, 0])
        ]);
        expect(result.values[0]).toBe(0.5);
        expect(result.values[1]).toBeNaN();
        expect(result.values[2]).toBe(0);
        expect(result.values[3]).toBeNaN();
        expect(result.range).toEqual([0, 0.5]);
    });

    it('computes vector magnitudes', () => {
        const result = evaluateDerivedField(parseDerivedField('mag(velocity)', NAMES), [
            { name: 'velocity', association: 'point', components: 3, values: [3, 4, 0, 1, 2, 2] }
        ]);
        expect([...result.values]).toEqual([5, 3]);
    });

    it('resolves multi-component binary operands to magnitudes', () => {
        const result = evaluateDerivedField(parseDerivedField('velocity-flux', [...NAMES, 'velocity']), [
            { name: 'velocity', association: 'point', components: 2, values: [3, 4, 0, 0] },
            scalar('flux', [5, 1])
        ]);
        expect([...result.values]).toEqual([0, -1]);
    });

    it('takes log10 of positive values and NaN elsewhere', () => {
        const result = evaluateDerivedField(parseDerivedField('log10(flux)', NAMES), [
            scalar('flux', [100, 1, 0, -5, Number.NaN, Number.POSITIVE_INFINITY])
        ]);
        expect(result.values[0]).toBe(2);
        expect(result.values[1]).toBe(0);
        expect(result.values[2]).toBeNaN();
        expect(result.values[3]).toBeNaN();
        expect(result.values[4]).toBeNaN();
        expect(result.values[5]).toBeNaN();
    });

    it('rejects mixed associations and mismatched tuple counts', () => {
        const division = parseDerivedField('std/mean', NAMES);
        expect(() => evaluateDerivedField(division, [scalar('std', [1], 'point'), scalar('mean', [2], 'cell')])).toThrow(DerivedFieldError);
        expect(() => evaluateDerivedField(division, [scalar('std', [1, 2]), scalar('mean', [2])])).toThrow(DerivedFieldError);
        expect(() => evaluateDerivedField(division, [scalar('std', [1])])).toThrow(DerivedFieldError);
    });

    it('ranges over finite values only, defaulting to [0, 0]', () => {
        const allNaN = evaluateDerivedField(parseDerivedField('std/mean', NAMES), [scalar('std', [0]), scalar('mean', [0])]);
        expect(allNaN.values[0]).toBeNaN();
        expect(allNaN.range).toEqual([0, 0]);
    });
});

describe('computeArrayStats', () => {
    it('summarizes finite values and counts the rest', () => {
        const stats = computeArrayStats([1, 2, 3, 4, Number.NaN, Number.POSITIVE_INFINITY]);
        expect(stats.count).toBe(6);
        expect(stats.finiteCount).toBe(4);
        expect(stats.nonFiniteCount).toBe(2);
        expect(stats.min).toBe(1);
        expect(stats.max).toBe(4);
        expect(stats.mean).toBe(2.5);
        expect(stats.std).toBeCloseTo(Math.sqrt(1.25), 12);
    });

    it('reports NaN fields with no finite values', () => {
        const stats = computeArrayStats([Number.NaN]);
        expect(stats.finiteCount).toBe(0);
        expect(stats.nonFiniteCount).toBe(1);
        expect(stats.min).toBeNaN();
        expect(stats.max).toBeNaN();
        expect(stats.mean).toBeNaN();
        expect(stats.std).toBeNaN();
    });

    it('handles empty input', () => {
        const stats = computeArrayStats([]);
        expect(stats.count).toBe(0);
        expect(stats.mean).toBeNaN();
    });
});

describe('computeHistogram', () => {
    it('bins equal-width over [min, max]', () => {
        const histogram = computeHistogram([0, 1, 2, 3], 2);
        expect([...histogram.bins]).toEqual([2, 2]);
        expect([...histogram.edges]).toEqual([0, 1.5, 3]);
        expect(histogram.min).toBe(0);
        expect(histogram.max).toBe(3);
        expect(histogram.finiteCount).toBe(4);
    });

    it('skips non-finite values and pins the top edge', () => {
        const histogram = computeHistogram([0, 10, Number.NaN], 10);
        expect(histogram.bins.reduce((a, b) => a + b, 0)).toBe(2);
        expect(histogram.bins[0]).toBe(1);
        expect(histogram.bins[9]).toBe(1);
    });

    it('puts degenerate ranges in the first bin', () => {
        const histogram = computeHistogram([5, 5, 5], 4);
        expect([...histogram.bins]).toEqual([3, 0, 0, 0]);
        expect(histogram.edges.every((edge) => edge === 5)).toBe(true);
    });

    it('returns zero bins with no finite values', () => {
        const histogram = computeHistogram([Number.NaN], 4);
        expect([...histogram.bins]).toEqual([0, 0, 0, 0]);
        expect(histogram.finiteCount).toBe(0);
    });
});

describe('normalizeHistogramBinCount', () => {
    it('clamps to [1, 256] and falls back on garbage', () => {
        expect(normalizeHistogramBinCount(10)).toBe(10);
        expect(normalizeHistogramBinCount('25')).toBe(25);
        expect(normalizeHistogramBinCount(1000)).toBe(256);
        expect(normalizeHistogramBinCount(0)).toBe(DEFAULT_HISTOGRAM_BINS);
        expect(normalizeHistogramBinCount(-3)).toBe(DEFAULT_HISTOGRAM_BINS);
        expect(normalizeHistogramBinCount(Number.NaN)).toBe(DEFAULT_HISTOGRAM_BINS);
        expect(normalizeHistogramBinCount('many')).toBe(DEFAULT_HISTOGRAM_BINS);
        expect(normalizeHistogramBinCount(undefined)).toBe(DEFAULT_HISTOGRAM_BINS);
        expect(normalizeHistogramBinCount(0, 8)).toBe(8);
    });
});
