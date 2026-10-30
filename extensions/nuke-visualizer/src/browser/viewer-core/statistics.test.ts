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
    DEFAULT_SCATTER_MAX_POINTS,
    MAX_HISTOGRAM_2D_BINS,
    boxStatsByCategory,
    computeHistogram2D,
    computeQuantiles,
    normalizeHistogram2DBinCount,
    parallelCoordinates,
    sampleScatter
} from './statistics';

describe('computeHistogram2D', () => {
    it('builds equal-width edges and row-major counts', () => {
        const histogram = computeHistogram2D([0, 1, 2, 3], [0, 1, 2, 3], 2, 2);
        expect(Array.from(histogram.xEdges)).toEqual([0, 1.5, 3]);
        expect(Array.from(histogram.yEdges)).toEqual([0, 1.5, 3]);
        // rows are y, columns are x
        expect(Array.from(histogram.counts)).toEqual([2, 0, 0, 2]);
        expect(histogram.max).toBe(2);
        expect(histogram.validCount).toBe(4);
        expect(histogram.xBinCount).toBe(2);
        expect(histogram.yBinCount).toBe(2);
    });

    it('assigns the maximum value to the last bin', () => {
        const histogram = computeHistogram2D([0, 10], [5, 5], 2, 1);
        expect(Array.from(histogram.counts)).toEqual([1, 1]);
        expect(histogram.xEdges[histogram.xBinCount]).toBe(10);
    });

    it('skips pairs where either axis is not finite', () => {
        const histogram = computeHistogram2D([0, 1, Number.NaN, 3, 4], [0, Number.NaN, 2, 3, 4], 2, 2);
        expect(histogram.validCount).toBe(3);
        expect(Array.from(histogram.xEdges)).toEqual([0, 2, 4]);
        expect(Array.from(histogram.yEdges)).toEqual([0, 2, 4]);
        expect(Array.from(histogram.counts)).toEqual([1, 0, 0, 2]);
        expect(histogram.max).toBe(2);
    });

    it('returns zeroed edges and counts when no pair is finite', () => {
        const histogram = computeHistogram2D([Number.NaN, Number.POSITIVE_INFINITY], [1, 2], 3, 4);
        expect(Array.from(histogram.xEdges)).toEqual([0, 0, 0, 0]);
        expect(Array.from(histogram.yEdges)).toEqual([0, 0, 0, 0, 0]);
        expect(histogram.counts.every((count) => count === 0)).toBe(true);
        expect(histogram.max).toBe(0);
        expect(histogram.validCount).toBe(0);
    });

    it('puts a degenerate range in the first bin', () => {
        const histogram = computeHistogram2D([5, 5, 5], [1, 2, 3], 2, 2);
        expect(Array.from(histogram.xEdges)).toEqual([5, 5, 5]);
        expect(Array.from(histogram.counts)).toEqual([1, 0, 2, 0]);
    });

    it('caps bins at 128 per axis', () => {
        expect(MAX_HISTOGRAM_2D_BINS).toBe(128);
        expect(normalizeHistogram2DBinCount(1000)).toBe(128);
        expect(normalizeHistogram2DBinCount(0)).toBe(64);
        expect(normalizeHistogram2DBinCount('bad')).toBe(64);
        const histogram = computeHistogram2D([0, 1], [0, 1], 1000, 1000);
        expect(histogram.xBinCount).toBe(128);
        expect(histogram.yBinCount).toBe(128);
        expect(histogram.xEdges.length).toBe(129);
        expect(histogram.counts.length).toBe(128 * 128);
    });

    it('uses the shorter input when the arrays differ in length', () => {
        const histogram = computeHistogram2D([0, 1, 2, 3], [0, 1], 2, 2);
        expect(histogram.validCount).toBe(2);
        expect(histogram.max).toBe(1);
    });
});

describe('computeQuantiles', () => {
    it('matches linear-interpolated quartiles', () => {
        const stats = computeQuantiles([1, 2, 3, 4]);
        expect(stats.min).toBe(1);
        expect(stats.q1).toBe(1.75);
        expect(stats.median).toBe(2.5);
        expect(stats.q3).toBe(3.25);
        expect(stats.max).toBe(4);
        expect(stats.mean).toBe(2.5);
        expect(stats.std).toBeCloseTo(Math.sqrt(1.25), 12);
        expect(stats.count).toBe(4);
    });

    it('handles an odd count and a single value', () => {
        const odd = computeQuantiles([1, 2, 3]);
        expect(odd.q1).toBe(1.5);
        expect(odd.median).toBe(2);
        expect(odd.q3).toBe(2.5);

        const single = computeQuantiles([7]);
        expect(single).toEqual({ min: 7, q1: 7, median: 7, q3: 7, max: 7, mean: 7, std: 0, count: 1 });
    });

    it('sorts unordered input before computing quartiles', () => {
        const stats = computeQuantiles([4, 1, 3, 2]);
        expect(stats.q1).toBe(1.75);
        expect(stats.median).toBe(2.5);
        expect(stats.q3).toBe(3.25);
    });

    it('skips NaN and infinite values', () => {
        const stats = computeQuantiles([1, Number.NaN, 3, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
        expect(stats).toEqual({ min: 1, q1: 1.5, median: 2, q3: 2.5, max: 3, mean: 2, std: 1, count: 2 });
    });

    it('returns NaNs for empty input', () => {
        const stats = computeQuantiles([]);
        expect(stats.count).toBe(0);
        for (const value of [stats.min, stats.q1, stats.median, stats.q3, stats.max, stats.mean, stats.std]) {
            expect(Number.isNaN(value)).toBe(true);
        }
    });
});

describe('sampleScatter', () => {
    it('copies every pair when under the limit', () => {
        const sample = sampleScatter([0, 1, 2], [3, 4, 5], 10);
        expect(Array.from(sample.x)).toEqual([0, 1, 2]);
        expect(Array.from(sample.y)).toEqual([3, 4, 5]);
        expect(sample.sourceCount).toBe(3);
        expect(sample.skippedCount).toBe(0);
        expect(sample.decimated).toBe(false);
    });

    it('evenly decimates, keeping exactly maxPoints and both endpoints', () => {
        const x = Array.from({ length: 100 }, (_, index) => index);
        const y = x.map((value) => value * 2);
        const sample = sampleScatter(x, y, 10);
        expect(sample.x.length).toBe(10);
        expect(sample.y.length).toBe(10);
        expect(sample.x[0]).toBe(0);
        expect(sample.x[9]).toBe(99);
        expect(sample.y[0]).toBe(0);
        expect(sample.y[9]).toBe(198);
        expect(sample.decimated).toBe(true);
        for (let i = 1; i < sample.x.length; i++) {
            expect(sample.x[i]).toBeGreaterThan(sample.x[i - 1]);
        }
    });

    it('defaults to 20k points', () => {
        const x = Array.from({ length: DEFAULT_SCATTER_MAX_POINTS + 5000 }, (_, index) => index);
        const sample = sampleScatter(x, x);
        expect(sample.x.length).toBe(DEFAULT_SCATTER_MAX_POINTS);
        expect(sample.x[0]).toBe(0);
        expect(sample.x[sample.x.length - 1]).toBe(x.length - 1);
    });

    it('drops non-finite pairs and samples the surviving endpoints', () => {
        const sample = sampleScatter([Number.NaN, 1, 2, 3, 4], [0, 1, Number.NaN, 3, 4], 3);
        expect(sample.sourceCount).toBe(3);
        expect(sample.skippedCount).toBe(2);
        expect(Array.from(sample.x)).toEqual([1, 3, 4]);
        expect(Array.from(sample.y)).toEqual([1, 3, 4]);
        expect(sample.decimated).toBe(false);
    });

    it('returns empty samples when nothing is finite', () => {
        const sample = sampleScatter([Number.NaN], [1], 10);
        expect(sample.x.length).toBe(0);
        expect(sample.y.length).toBe(0);
        expect(sample.sourceCount).toBe(0);
        expect(sample.decimated).toBe(false);
    });
});

describe('boxStatsByCategory', () => {
    it('groups values by ascending category and summarizes each group', () => {
        const boxes = boxStatsByCategory([1, 2, 3, 10, 20], [2, 1, 2, 2, 1]);
        expect(boxes.map((box) => box.category)).toEqual([1, 2]);
        expect(boxes[0].stats).toMatchObject({ min: 2, median: 11, max: 20, count: 2 });
        expect(boxes[1].stats).toMatchObject({ min: 1, median: 3, max: 10, count: 3 });
    });

    it('skips non-finite values and categories', () => {
        const boxes = boxStatsByCategory([1, Number.NaN, 3, 4], [1, 1, Number.NaN, 1]);
        expect(boxes).toHaveLength(1);
        expect(boxes[0].stats.count).toBe(2);
        expect(boxes[0].stats.median).toBe(2.5);
    });

    it('returns no boxes for empty input', () => {
        expect(boxStatsByCategory([], [])).toEqual([]);
    });
});

describe('parallelCoordinates', () => {
    it('builds row-aligned dimensions', () => {
        const result = parallelCoordinates([
            { name: 'a', values: [1, 2, 3] },
            { name: 'b', values: [4, 5, 6] }
        ]);
        expect(result.rowCount).toBe(3);
        expect(result.sourceRowCount).toBe(3);
        expect(result.skippedRows).toBe(0);
        expect(result.decimated).toBe(false);
        expect(result.dimensions.map((dimension) => dimension.name)).toEqual(['a', 'b']);
        expect(Array.from(result.dimensions[0].values)).toEqual([1, 2, 3]);
        expect(Array.from(result.dimensions[1].values)).toEqual([4, 5, 6]);
    });

    it('uses the shortest array and drops rows with any non-finite dimension', () => {
        const result = parallelCoordinates([
            { name: 'a', values: [1, 2, Number.NaN, 4, 5] },
            { name: 'b', values: [1, 2, 3, 4] }
        ]);
        expect(result.sourceRowCount).toBe(4);
        expect(result.skippedRows).toBe(1);
        expect(result.rowCount).toBe(3);
        expect(Array.from(result.dimensions[0].values)).toEqual([1, 2, 4]);
        expect(Array.from(result.dimensions[1].values)).toEqual([1, 2, 4]);
    });

    it('evenly decimates surviving rows, keeping endpoints', () => {
        const values = Array.from({ length: 100 }, (_, index) => index);
        const result = parallelCoordinates(
            [
                { name: 'a', values },
                { name: 'b', values: values.map((value) => value * 10) }
            ],
            10
        );
        expect(result.rowCount).toBe(10);
        expect(result.decimated).toBe(true);
        expect(result.dimensions[0].values[0]).toBe(0);
        expect(result.dimensions[0].values[9]).toBe(99);
        expect(result.dimensions[1].values[9]).toBe(990);
    });

    it('returns empty dimensions for no arrays or no rows', () => {
        expect(parallelCoordinates([])).toEqual({
            dimensions: [],
            rowCount: 0,
            sourceRowCount: 0,
            skippedRows: 0,
            decimated: false
        });
        const empty = parallelCoordinates([{ name: 'a', values: [] }]);
        expect(empty.rowCount).toBe(0);
        expect(empty.sourceRowCount).toBe(0);
        expect(empty.dimensions[0].values.length).toBe(0);
    });
});
