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
import { COLORMAPS } from './colormaps';
import {
    MAGNITUDE_COMPONENT,
    ScalarMapping,
    componentOptions,
    formatRangeValue,
    logScaleAvailable,
    mapScalar,
    mappingToCssGradient,
    normalizeToRange,
    resolveEffectiveRange,
    tupleScalar
} from './scalar-mapping';

const JET = COLORMAPS.Jet;

function mapping(overrides: Partial<ScalarMapping> = {}): ScalarMapping {
    return { definition: JET, range: [0, 10], logScale: false, invert: false, component: MAGNITUDE_COMPONENT, ...overrides };
}

describe('tupleScalar', () => {
    const vector = [3, 4, 0, 1, 2, 2]; // two 3-component tuples

    it('passes single-component tuples through', () => {
        expect(tupleScalar([5, 7], 1, 1)).toBe(7);
    });

    it('computes the L2 magnitude by default', () => {
        expect(tupleScalar(vector, 3, 0)).toBe(5);
        expect(tupleScalar(vector, 3, 1, MAGNITUDE_COMPONENT)).toBe(3);
    });

    it('picks one component when asked', () => {
        expect(tupleScalar(vector, 3, 1, 0)).toBe(1);
        expect(tupleScalar(vector, 3, 1, 2)).toBe(2);
    });

    it('falls back to magnitude for out-of-range components', () => {
        expect(tupleScalar(vector, 3, 0, 7)).toBe(5);
    });
});

describe('componentOptions', () => {
    it('is empty for scalar arrays', () => {
        expect(componentOptions(1)).toEqual([]);
    });

    it('offers Magnitude plus named axes for vectors', () => {
        expect(componentOptions(3)).toEqual([
            { value: -1, label: 'Magnitude' },
            { value: 0, label: 'X' },
            { value: 1, label: 'Y' },
            { value: 2, label: 'Z' }
        ]);
        expect(componentOptions(2)).toEqual([
            { value: -1, label: 'Magnitude' },
            { value: 0, label: 'X' },
            { value: 1, label: 'Y' }
        ]);
    });

    it('numbers components beyond three', () => {
        const options = componentOptions(4);
        expect(options[4]).toEqual({ value: 3, label: 'Component 3' });
    });
});

describe('resolveEffectiveRange', () => {
    it('auto mode returns the data range', () => {
        expect(resolveEffectiveRange('auto', [1, 9], [3, 4])).toEqual([1, 9]);
    });

    it('custom mode returns the user range, sorted', () => {
        expect(resolveEffectiveRange('custom', [1, 9], [3, 4])).toEqual([3, 4]);
        expect(resolveEffectiveRange('custom', [1, 9], [4, 3])).toEqual([3, 4]);
    });

    it('falls back to the data range for unusable custom ranges', () => {
        expect(resolveEffectiveRange('custom', [1, 9], undefined)).toEqual([1, 9]);
        expect(resolveEffectiveRange('custom', [1, 9], [5, 5])).toEqual([1, 9]);
        expect(resolveEffectiveRange('custom', [1, 9], [NaN, 5])).toEqual([1, 9]);
    });
});

describe('logScaleAvailable', () => {
    it('requires a strictly positive range', () => {
        expect(logScaleAvailable([0.1, 10])).toBe(true);
        expect(logScaleAvailable([0, 10])).toBe(false);
        expect(logScaleAvailable([-5, 10])).toBe(false);
    });
});

describe('normalizeToRange', () => {
    it('normalizes and clamps', () => {
        expect(normalizeToRange(5, [0, 10])).toBe(0.5);
        expect(normalizeToRange(-1, [0, 10])).toBe(0);
        expect(normalizeToRange(11, [0, 10])).toBe(1);
    });

    it('maps a degenerate range to 0', () => {
        expect(normalizeToRange(5, [5, 5])).toBe(0);
    });
});

describe('mapScalar', () => {
    it('maps the linear range ends to the map ends', () => {
        expect(mapScalar(0, mapping())).toEqual([0, 0, 0.5625]);
        expect(mapScalar(10, mapping())).toEqual([0.5, 0, 0]);
    });

    it('inverts the map on demand', () => {
        expect(mapScalar(0, mapping({ invert: true }))).toEqual(mapScalar(10, mapping()));
    });

    it('honors a custom range', () => {
        expect(mapScalar(4, mapping({ range: [4, 8] }))).toEqual(mapScalar(0, mapping()));
    });

    it('maps non-finite values to the preset NaN color or null', () => {
        // Jet defines no NaN color; Plasma defines [0, 1, 0].
        expect(mapScalar(NaN, mapping())).toBeNull();
        expect(mapScalar(Infinity, mapping({ definition: COLORMAPS.Plasma }))).toEqual([0, 1, 0]);
    });

    it('log-scales inside a positive range', () => {
        const log = mapping({ range: [1, 100], logScale: true });
        const mid = mapScalar(10, log);
        expect(mid).not.toBeNull();
        // log midpoint of [1, 100] is 10 → t = 0.5, the same color as linear 5 over [0, 10].
        expect(mid).toEqual(mapScalar(5, mapping()));
    });

    it('treats non-positive values under log scale as NaN', () => {
        const log = mapping({ range: [1, 100], logScale: true, definition: COLORMAPS.Plasma });
        expect(mapScalar(0, log)).toEqual([0, 1, 0]);
        expect(mapScalar(-3, log)).toEqual([0, 1, 0]);
    });
});

describe('legend helpers', () => {
    it('formats range labels with toPrecision(3) parity', () => {
        expect(formatRangeValue(1.23456)).toBe('1.23');
        expect(formatRangeValue(1234567)).toBe('1.23e+6');
    });

    it('builds a gradient that honors invert', () => {
        const plain = mappingToCssGradient(mapping());
        const inverted = mappingToCssGradient(mapping({ invert: true }));
        expect(plain.startsWith('linear-gradient(to right, ')).toBe(true);
        expect(inverted.startsWith('linear-gradient(to right, ')).toBe(true);
        // Inverted starts where plain ends.
        const plainFirst = plain.match(/rgb\([^)]+\)/)![0];
        const invertedFirst = inverted.match(/rgb\([^)]+\)/)![0];
        const plainLast = [...plain.matchAll(/rgb\([^)]+\)/g)].pop()![0];
        expect(invertedFirst).toBe(plainLast);
        expect(plainFirst).not.toBe(plainLast);
    });
});
