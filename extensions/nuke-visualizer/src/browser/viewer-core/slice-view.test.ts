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
 * Tests for the pure orthoslice core: x-fastest orientation per axis,
 * nearest/linear sampling, fraction clamping, malformed-source rejection,
 * range resolution, and RGBA painting (including the NaN color path).
 */

import { describe, expect, it } from 'vitest';
import { COLORMAPS } from './colormaps';
import { MAGNITUDE_COMPONENT, mapScalar, type ScalarMapping } from './scalar-mapping';
import {
    extractGridSlice,
    slicePlaneSize,
    sliceToRgba,
    type GridSlice,
    type GridSliceSource,
    type SliceAxis,
    type SliceSamplingMode
} from './slice-view';

// 3 x 2 x 2 grid, x-fastest cell ids: (i, j, k) -> i + 3 * (j + 2 * k).
const DIMS: readonly [number, number, number] = [3, 2, 2];
const VALUES = Float64Array.from({ length: 12 }, (_, index) => index);
const AXES: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>] = [
    new Float64Array([0, 1, 2, 3]),
    new Float64Array([0, 1, 2]),
    new Float64Array([0, 1, 2])
];

function source(overrides: Partial<GridSliceSource> = {}): GridSliceSource {
    return { dims: DIMS, axes: AXES, values: VALUES, ...overrides };
}

function sliceAt(axis: SliceAxis, fraction: number, mode: SliceSamplingMode = 'nearest', input: GridSliceSource = source()): GridSlice {
    const slice = extractGridSlice(input, axis, fraction, mode);
    if (!slice) {
        throw new Error(`Expected a ${axis} slice at ${fraction}`);
    }
    return slice;
}

function valuesOf(axis: SliceAxis, fraction: number, mode: SliceSamplingMode = 'nearest', input: GridSliceSource = source()): number[] {
    return Array.from(sliceAt(axis, fraction, mode, input).values);
}

function mapping(definition = COLORMAPS.Jet, overrides: Partial<ScalarMapping> = {}): ScalarMapping {
    return {
        definition,
        range: [0, 10],
        logScale: false,
        invert: false,
        component: MAGNITUDE_COMPONENT,
        ...overrides
    };
}

function byteTriple(color: readonly [number, number, number]): number[] {
    return [0, 1, 2].map((channel) => Math.round(Math.min(1, Math.max(0, color[channel])) * 255));
}

describe('slicePlaneSize', () => {
    it('reports the in-plane dimensions for each axis', () => {
        expect(slicePlaneSize(DIMS, 'X')).toEqual([2, 2]);
        expect(slicePlaneSize(DIMS, 'Y')).toEqual([3, 2]);
        expect(slicePlaneSize(DIMS, 'Z')).toEqual([3, 2]);
    });
});

describe('extractGridSlice orientation', () => {
    it('extracts X as Y x Z with x fastest', () => {
        const slice = sliceAt('X', 0);
        expect(slice.width).toBe(2);
        expect(slice.height).toBe(2);
        expect(slice.index).toBe(0);
        // row 0 (z=0): (y=0) 0, (y=1) 3; row 1 (z=1): 6, 9.
        expect(Array.from(slice.values)).toEqual([0, 3, 6, 9]);
    });

    it('extracts Y as X x Z', () => {
        const slice = sliceAt('Y', 0);
        expect(slice.width).toBe(3);
        expect(slice.height).toBe(2);
        expect(Array.from(slice.values)).toEqual([0, 1, 2, 6, 7, 8]);
    });

    it('extracts Z as X x Y', () => {
        const slice = sliceAt('Z', 0);
        expect(slice.width).toBe(3);
        expect(slice.height).toBe(2);
        expect(Array.from(slice.values)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('selects the last cell layer at fraction 1', () => {
        expect(Array.from(sliceAt('X', 1).values)).toEqual([2, 5, 8, 11]);
        expect(Array.from(sliceAt('Y', 1).values)).toEqual([3, 4, 5, 9, 10, 11]);
        expect(Array.from(sliceAt('Z', 1).values)).toEqual([6, 7, 8, 9, 10, 11]);
    });
});

describe('extractGridSlice sampling', () => {
    it('picks the nearest layer', () => {
        // X has 3 cells: 0.5 -> position 1, 0.9 -> position 1.8 -> round 2.
        expect(sliceAt('X', 0.5).index).toBe(1);
        expect(valuesOf('X', 0.5)).toEqual([1, 4, 7, 10]);
        expect(sliceAt('X', 0.9).index).toBe(2);
        expect(valuesOf('X', 0.9)).toEqual([2, 5, 8, 11]);
        // Z has 2 cells: Math.round(0.5) = 1.
        expect(sliceAt('Z', 0.5).index).toBe(1);
        expect(valuesOf('Z', 0.5)).toEqual([6, 7, 8, 9, 10, 11]);
    });

    it('blends the two adjacent layers in linear mode', () => {
        // X fraction 0.25 -> position 0.5 blends layers i=0 and i=1.
        expect(sliceAt('X', 0.25, 'linear').index).toBe(0);
        expect(valuesOf('X', 0.25, 'linear')).toEqual([0.5, 3.5, 6.5, 9.5]);
        // Y (2 cells) at 0.5 blends j=0 and j=1.
        expect(valuesOf('Y', 0.5, 'linear')).toEqual([1.5, 2.5, 3.5, 7.5, 8.5, 9.5]);
        // Z (2 cells) at 0.5 blends k=0 and k=1.
        expect(valuesOf('Z', 0.5, 'linear')).toEqual([3, 4, 5, 6, 7, 8]);
    });

    it('keeps an exact layer unblended in linear mode', () => {
        expect(valuesOf('X', 0.5, 'linear')).toEqual([1, 4, 7, 10]);
        expect(valuesOf('X', 1, 'linear')).toEqual([2, 5, 8, 11]);
        expect(sliceAt('Y', 0, 'linear').index).toBe(0);
    });

    it('does not blend a single-cell axis', () => {
        const single: GridSliceSource = { dims: [1, 2, 2], axes: AXES, values: Float64Array.from([0, 1, 2, 3]) };
        expect(valuesOf('X', 0.5, 'linear', single)).toEqual([0, 1, 2, 3]);
        expect(sliceAt('X', 1, 'linear', single).index).toBe(0);
    });
});

describe('extractGridSlice clamping', () => {
    it('clamps fractions below 0 and above 1', () => {
        expect(valuesOf('X', -5)).toEqual(valuesOf('X', 0));
        expect(valuesOf('X', 5)).toEqual(valuesOf('X', 1));
        expect(valuesOf('Z', 99)).toEqual(valuesOf('Z', 1));
    });

    it('pins a non-finite fraction to the first layer', () => {
        expect(valuesOf('X', Number.NaN)).toEqual(valuesOf('X', 0));
        expect(valuesOf('Y', Number.POSITIVE_INFINITY)).toEqual(valuesOf('Y', 0));
        expect(sliceAt('Z', Number.NEGATIVE_INFINITY).index).toBe(0);
    });
});

describe('extractGridSlice invalid input', () => {
    it('rejects malformed dimensions', () => {
        expect(extractGridSlice(source({ dims: [0, 2, 2] }), 'X', 0.5)).toBeUndefined();
        expect(extractGridSlice(source({ dims: [3, -2, 2] }), 'X', 0.5)).toBeUndefined();
        expect(extractGridSlice(source({ dims: [3, 2, 2.5] }), 'X', 0.5)).toBeUndefined();
        expect(extractGridSlice(source({ dims: [3, 2, Number.NaN] }), 'X', 0.5)).toBeUndefined();
        expect(extractGridSlice(source({ dims: [3, 2] as unknown as [number, number, number] }), 'X', 0.5)).toBeUndefined();
        expect(extractGridSlice(source({ dims: undefined as unknown as [number, number, number] }), 'X', 0.5)).toBeUndefined();
    });

    it('rejects values that do not hold exactly one scalar per cell', () => {
        expect(extractGridSlice(source({ values: new Float64Array(11) }), 'X', 0.5)).toBeUndefined();
        expect(extractGridSlice(source({ values: new Float64Array(13) }), 'X', 0.5)).toBeUndefined();
        expect(extractGridSlice(source({ values: [] }), 'X', 0.5)).toBeUndefined();
        expect(extractGridSlice(source({ values: undefined as unknown as ArrayLike<number> }), 'X', 0.5)).toBeUndefined();
    });

    it('rejects an unknown axis or a missing source', () => {
        expect(extractGridSlice(source(), 'W' as SliceAxis, 0.5)).toBeUndefined();
        expect(extractGridSlice(undefined as unknown as GridSliceSource, 'X', 0.5)).toBeUndefined();
    });
});

describe('extractGridSlice range', () => {
    it('uses a finite explicit source range, sorted ascending', () => {
        expect(sliceAt('Z', 0, 'nearest', source({ range: [5, 50] })).range).toEqual([5, 50]);
        expect(sliceAt('Z', 0, 'nearest', source({ range: [50, 5] })).range).toEqual([5, 50]);
    });

    it('computes the slice range when the source has none', () => {
        expect(sliceAt('Z', 1).range).toEqual([6, 11]);
        expect(sliceAt('X', 0).range).toEqual([0, 9]);
    });

    it('ignores non-finite values and reports [0, 0] for an empty finite set', () => {
        const mixed = Float64Array.from([Number.NaN, 2, 8, Number.POSITIVE_INFINITY]);
        const slice = sliceAt('Z', 0, 'nearest', { dims: [2, 2, 1], axes: AXES, values: mixed });
        expect(slice.range).toEqual([2, 8]);
        const allNaN = source({ values: new Float64Array(12).fill(Number.NaN) });
        expect(sliceAt('Z', 0, 'nearest', allNaN).range).toEqual([0, 0]);
    });

    it('falls back to the computed range for an unusable explicit range', () => {
        expect(sliceAt('Z', 0, 'nearest', source({ range: [Number.NaN, 5] })).range).toEqual([0, 5]);
    });
});

describe('sliceToRgba', () => {
    it('paints every finite pixel with the mapping color and full alpha', () => {
        const slice = sliceAt('Z', 0);
        const rgba = sliceToRgba(slice, mapping());
        expect(rgba.length).toBe(3 * 2 * 4);
        for (let i = 0; i < slice.values.length; i++) {
            const expected = mapScalar(slice.values[i], mapping());
            expect(expected).not.toBeNull();
            const at = i * 4;
            expect(Array.from(rgba.slice(at, at + 3))).toEqual(byteTriple(expected!));
            expect(rgba[at + 3]).toBe(255);
        }
    });

    it('honors the mapping range and invert', () => {
        const slice = sliceAt('Z', 0);
        const custom = mapping(COLORMAPS.Jet, { range: [2, 4] });
        const inverted = mapping(COLORMAPS.Jet, { invert: true });
        const customRgba = sliceToRgba(slice, custom);
        const invertedRgba = sliceToRgba(slice, inverted);
        // Value 0 is below the custom range and clamps to the first map color.
        expect(Array.from(customRgba.slice(0, 3))).toEqual(byteTriple(mapScalar(0, custom)!));
        // Value 3 sits mid-range.
        expect(Array.from(customRgba.slice(12, 15))).toEqual(byteTriple(mapScalar(3, custom)!));
        expect(Array.from(invertedRgba.slice(0, 3))).toEqual(byteTriple(mapScalar(0, inverted)!));
    });

    it('uses the NaN color path for non-positive values under log scaling', () => {
        const slice = sliceAt('Z', 0);
        const log = mapping(COLORMAPS.Plasma, { range: [1, 100], logScale: true });
        const rgba = sliceToRgba(slice, log);
        // Slice values 0..5: 0 is non-positive, so it maps like a NaN.
        expect(Array.from(rgba.slice(0, 4))).toEqual([0, 255, 0, 255]);
        const finite = mapScalar(5, log)!;
        expect(Array.from(rgba.slice(5 * 4, 5 * 4 + 3))).toEqual(byteTriple(finite));
    });

    it('uses the mapping NaN color for non-finite values', () => {
        const slice: GridSlice = {
            axis: 'Z',
            index: 0,
            width: 2,
            height: 2,
            values: Float64Array.from([Number.NaN, 0, Number.POSITIVE_INFINITY, 1]),
            range: [0, 1]
        };
        const rgba = sliceToRgba(slice, mapping(COLORMAPS.Plasma, { range: [0, 1] }));
        expect(Array.from(rgba.slice(0, 4))).toEqual([0, 255, 0, 255]);
        expect(Array.from(rgba.slice(8, 12))).toEqual([0, 255, 0, 255]);
        expect(rgba[7]).toBe(255);
        expect(rgba[15]).toBe(255);
    });

    it('leaves pixels transparent when the preset has no NaN color', () => {
        const slice: GridSlice = {
            axis: 'X',
            index: 0,
            width: 2,
            height: 1,
            values: Float64Array.from([Number.NaN, 0]),
            range: [0, 1]
        };
        const rgba = sliceToRgba(slice, mapping(COLORMAPS.Jet, { range: [0, 1] }));
        expect(Array.from(rgba.slice(0, 4))).toEqual([0, 0, 0, 0]);
        expect(rgba[7]).toBe(255);
    });
});
