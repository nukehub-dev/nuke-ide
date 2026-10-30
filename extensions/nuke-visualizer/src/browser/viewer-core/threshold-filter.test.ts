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
 * Tests for the viewer-core threshold predicate (no DOM, no three.js):
 * window normalization (empty/inverted/non-finite guards), the NaN-stays-
 * visible rule matching the `nanColor` convention, tuple/component
 * resolution, coverage counts, and the in-place soup collapse helpers.
 */

import { describe, expect, it } from 'vitest';
import { MAGNITUDE_COMPONENT } from './scalar-mapping';
import {
    collapsePointSoup,
    collapseSegmentSoup,
    collapseTriangleSoup,
    countThresholdVisible,
    hiddenPoints,
    hiddenSegments,
    hiddenTriangles,
    normalizeThresholdRange,
    thresholdScalarVisible,
    thresholdTupleVisible
} from './threshold-filter';

describe('normalizeThresholdRange', () => {
    it('keeps an ordered window as-is', () => {
        expect(normalizeThresholdRange(0, 10)).toEqual([0, 10]);
    });

    it('sorts an inverted window instead of hiding everything (Range parity)', () => {
        expect(normalizeThresholdRange(10, 0)).toEqual([0, 10]);
    });

    it('keeps an empty window (exact matches still pass)', () => {
        expect(normalizeThresholdRange(5, 5)).toEqual([5, 5]);
    });

    it('disables the window on non-finite endpoints', () => {
        expect(normalizeThresholdRange(Number.NaN, 10)).toBeUndefined();
        expect(normalizeThresholdRange(0, Number.POSITIVE_INFINITY)).toBeUndefined();
        expect(normalizeThresholdRange(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)).toBeUndefined();
    });
});

describe('thresholdScalarVisible', () => {
    it('keeps values inside the inclusive window', () => {
        expect(thresholdScalarVisible(0, 0, 10)).toBe(true);
        expect(thresholdScalarVisible(10, 0, 10)).toBe(true);
        expect(thresholdScalarVisible(4.5, 0, 10)).toBe(true);
    });

    it('hides values outside the window', () => {
        expect(thresholdScalarVisible(-0.5, 0, 10)).toBe(false);
        expect(thresholdScalarVisible(10.5, 0, 10)).toBe(false);
    });

    it('keeps non-finite values visible (nanColor convention: render, never drop)', () => {
        expect(thresholdScalarVisible(Number.NaN, 0, 10)).toBe(true);
        expect(thresholdScalarVisible(Number.POSITIVE_INFINITY, 0, 10)).toBe(true);
        expect(thresholdScalarVisible(Number.NEGATIVE_INFINITY, 0, 10)).toBe(true);
    });

    it('keeps only exact matches in an empty window', () => {
        expect(thresholdScalarVisible(5, 5, 5)).toBe(true);
        expect(thresholdScalarVisible(5.0001, 5, 5)).toBe(false);
        expect(thresholdScalarVisible(Number.NaN, 5, 5)).toBe(true);
    });
});

describe('thresholdTupleVisible', () => {
    it('resolves single-component tuples directly', () => {
        const values = new Float64Array([1, 5, 9]);
        expect(thresholdTupleVisible(values, 1, 0, MAGNITUDE_COMPONENT, 0, 6)).toBe(true);
        expect(thresholdTupleVisible(values, 1, 2, MAGNITUDE_COMPONENT, 0, 6)).toBe(false);
    });

    it('picks the active component for multi-component arrays', () => {
        const values = new Float64Array([1, 100, 2, 200]);
        expect(thresholdTupleVisible(values, 2, 0, 1, 0, 150)).toBe(true);
        expect(thresholdTupleVisible(values, 2, 1, 1, 0, 150)).toBe(false);
        expect(thresholdTupleVisible(values, 2, 1, 0, 0, 150)).toBe(true);
    });

    it('collapses vectors to their magnitude by default (color-by parity)', () => {
        const values = new Float64Array([3, 4]);
        expect(thresholdTupleVisible(values, 2, 0, MAGNITUDE_COMPONENT, 4.9, 5.1)).toBe(true);
        expect(thresholdTupleVisible(values, 2, 0, MAGNITUDE_COMPONENT, 5.1, 9)).toBe(false);
    });

    it('keeps unmapped tuples visible (out-of-range reads stay painted)', () => {
        const values = new Float64Array([100]);
        expect(thresholdTupleVisible(values, 1, -1, MAGNITUDE_COMPONENT, 0, 6)).toBe(true);
        expect(thresholdTupleVisible(values, 1, 99, MAGNITUDE_COMPONENT, 0, 6)).toBe(true);
    });
});

describe('countThresholdVisible', () => {
    it('counts survivors over the whole series', () => {
        const values = new Float64Array([1, 5, 9, Number.NaN]);
        expect(countThresholdVisible(values, 1, MAGNITUDE_COMPONENT, 0, 6)).toEqual({ visible: 3, total: 4 });
    });

    it('reports zero survivors when the window excludes everything finite', () => {
        const values = new Float64Array([1, 2, 3]);
        expect(countThresholdVisible(values, 1, MAGNITUDE_COMPONENT, 10, 20)).toEqual({ visible: 0, total: 3 });
    });
});

describe('hiddenTriangles + collapseTriangleSoup', () => {
    it('hides a triangle only when every corner fails (VTK point-data rule)', () => {
        const tupleOfVertex = (vertex: number): number => vertex;
        const tupleVisible = (tuple: number): boolean => tuple < 3;
        // Triangle 0 corners (0, 1, 2): all pass -> visible.
        // Triangle 1 corners (3, 4, 5): all fail -> hidden.
        expect(Array.from(hiddenTriangles(2, tupleOfVertex, tupleVisible))).toEqual([0, 1]);
    });

    it('collapses hidden triangles onto their first corner (zero-area, finite)', () => {
        const soup = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5, 6, 5, 5, 5, 6, 5]);
        collapseTriangleSoup(soup, new Uint8Array([0, 1]));
        expect(Array.from(soup.slice(0, 9))).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
        expect(Array.from(soup.slice(9))).toEqual([5, 5, 5, 5, 5, 5, 5, 5, 5]);
    });

    it('leaves the soup untouched when nothing hides', () => {
        const soup = new Float32Array([0, 0, 1, 2, 3, 4, 5, 6, 7]);
        collapseTriangleSoup(soup, new Uint8Array([0]));
        expect(Array.from(soup)).toEqual([0, 0, 1, 2, 3, 4, 5, 6, 7]);
    });
});

describe('hiddenSegments + collapseSegmentSoup', () => {
    it('hides a segment only when both endpoints fail', () => {
        const tupleOfVertex = (vertex: number): number => vertex;
        const tupleVisible = (tuple: number): boolean => tuple === 0;
        // Segment 0 (0, 1): endpoint 0 passes -> visible. Segment 1 (1, 2): both fail -> hidden.
        expect(Array.from(hiddenSegments(2, tupleOfVertex, tupleVisible))).toEqual([0, 1]);
    });

    it('folds the second endpoint onto the first (zero-length)', () => {
        const soup = new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]);
        collapseSegmentSoup(soup, new Uint8Array([0, 1]));
        expect(Array.from(soup)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
    });
});

describe('hiddenPoints + collapsePointSoup', () => {
    it('flags exactly the failing vertices', () => {
        const tupleOfVertex = (vertex: number): number => vertex;
        const tupleVisible = (tuple: number): boolean => tuple !== 1;
        expect(Array.from(hiddenPoints(3, tupleOfVertex, tupleVisible))).toEqual([0, 1, 0]);
    });

    it('drops hidden vertices to NaN and reports the hidden count', () => {
        const soup = new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]);
        expect(collapsePointSoup(soup, new Uint8Array([0, 1, 0]))).toBe(1);
        expect(soup[0]).toBe(0);
        expect(soup[3]).toBeNaN();
        expect(soup[6]).toBe(2);
    });

    it('returns zero and touches nothing when all vertices pass', () => {
        const soup = new Float32Array([0, 0, 0]);
        expect(collapsePointSoup(soup, new Uint8Array([0]))).toBe(0);
        expect(Array.from(soup)).toEqual([0, 0, 0]);
    });
});
