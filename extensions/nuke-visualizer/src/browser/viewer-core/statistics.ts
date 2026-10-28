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
 * Distribution statistics for the data panels: 2D histograms, quantiles,
 * even scatter decimation, category box stats, and parallel-coordinate
 * dimensions.
 *
 * Pure functions only (no DOM, no Theia, no Plotly). Non-finite values are
 * skipped everywhere, so a dataset full of NaN sentinels never poisons a
 * range or a bin edge. Equal-width bin edges are delegated to
 * `derived-fields.ts::computeHistogram` — never re-implement the 1D binning
 * rule here.
 */

import { computeArrayStats, computeHistogram, normalizeHistogramBinCount } from './derived-fields';

/** Default bins per axis for the 2D histogram (keeps a 128×128 cap honest). */
export const DEFAULT_HISTOGRAM_2D_BINS = 64;

/** Hard cap per axis; a 128×128 grid is already 16k Plotly cells. */
export const MAX_HISTOGRAM_2D_BINS = 128;

/** Default scatter/parallel-coordinate sample budget. */
export const DEFAULT_SCATTER_MAX_POINTS = 20000;

/** Bin count normalized to [1, MAX_HISTOGRAM_2D_BINS]. */
export function normalizeHistogram2DBinCount(value: unknown, fallback: number = DEFAULT_HISTOGRAM_2D_BINS): number {
    const safeFallback = Number.isFinite(fallback)
        ? Math.min(MAX_HISTOGRAM_2D_BINS, Math.max(1, Math.floor(fallback)))
        : DEFAULT_HISTOGRAM_2D_BINS;
    return Math.min(MAX_HISTOGRAM_2D_BINS, normalizeHistogramBinCount(value, safeFallback));
}

/** 2D histogram over the finite (x, y) pairs of two scalar series. */
export interface Histogram2D {
    /** `xBinCount + 1` equal-width edges spanning the finite x range (zeros when empty). */
    readonly xEdges: Float64Array;
    /** `yBinCount + 1` equal-width edges spanning the finite y range (zeros when empty). */
    readonly yEdges: Float64Array;
    /** Row-major, y-major: `counts[yBin * xBinCount + xBin]`. */
    readonly counts: Uint32Array;
    readonly max: number;
    readonly xBinCount: number;
    readonly yBinCount: number;
    /** Pairs where both values were finite. */
    readonly validCount: number;
}

/**
 * Bin the finite (x, y) pairs into an equal-width grid. Pairs with a NaN or
 * infinite value on either axis are skipped; the edges span the remaining
 * pairs, matching `computeHistogram`'s 1D rule (including a degenerate range,
 * which puts every value in bin 0).
 */
export function computeHistogram2D(x: ArrayLike<number>, y: ArrayLike<number>, xBins: number, yBins: number): Histogram2D {
    const xBinCount = normalizeHistogram2DBinCount(xBins);
    const yBinCount = normalizeHistogram2DBinCount(yBins);
    const length = Math.min(x.length, y.length);
    let validCount = 0;
    for (let i = 0; i < length; i++) {
        if (Number.isFinite(x[i]) && Number.isFinite(y[i])) {
            validCount++;
        }
    }
    if (validCount === 0) {
        return {
            xEdges: new Float64Array(xBinCount + 1),
            yEdges: new Float64Array(yBinCount + 1),
            counts: new Uint32Array(xBinCount * yBinCount),
            max: 0,
            xBinCount,
            yBinCount,
            validCount: 0
        };
    }
    const xs = new Float64Array(validCount);
    const ys = new Float64Array(validCount);
    let cursor = 0;
    for (let i = 0; i < length; i++) {
        const xValue = x[i];
        const yValue = y[i];
        if (Number.isFinite(xValue) && Number.isFinite(yValue)) {
            xs[cursor] = xValue;
            ys[cursor] = yValue;
            cursor++;
        }
    }
    // Reuse the 1D histogram for edges (and its normalization/degenerate-range rule).
    const xHistogram = computeHistogram(xs, xBinCount);
    const yHistogram = computeHistogram(ys, yBinCount);
    const xEdges = Float64Array.from(xHistogram.edges);
    const yEdges = Float64Array.from(yHistogram.edges);
    const counts = new Uint32Array(xBinCount * yBinCount);
    const xWidth = xHistogram.max - xHistogram.min;
    const yWidth = yHistogram.max - yHistogram.min;
    let max = 0;
    for (let i = 0; i < validCount; i++) {
        const xIndex = xWidth <= 0 ? 0 : Math.min(xBinCount - 1, Math.floor(((xs[i] - xHistogram.min) / xWidth) * xBinCount));
        const yIndex = yWidth <= 0 ? 0 : Math.min(yBinCount - 1, Math.floor(((ys[i] - yHistogram.min) / yWidth) * yBinCount));
        const index = yIndex * xBinCount + xIndex;
        const next = counts[index] + 1;
        counts[index] = next;
        if (next > max) {
            max = next;
        }
    }
    return { xEdges, yEdges, counts, max, xBinCount, yBinCount, validCount };
}

/** Five-number summary plus mean/population std over the finite values. */
export interface Quantiles {
    readonly min: number;
    readonly q1: number;
    readonly median: number;
    readonly q3: number;
    readonly max: number;
    readonly mean: number;
    readonly std: number;
    /** Number of finite values included (NaN/infinite values are skipped). */
    readonly count: number;
}

/** Linear-interpolated quantile over an ascending sorted array (numpy/R type 7). */
function quantileFromSorted(sorted: Float64Array, probability: number): number {
    if (sorted.length === 0) {
        return Number.NaN;
    }
    if (sorted.length === 1) {
        return sorted[0];
    }
    const position = (sorted.length - 1) * probability;
    const lower = Math.floor(position);
    const upper = Math.min(sorted.length - 1, lower + 1);
    const weight = position - lower;
    return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

/** Quantiles over one scalar series; NaN and ±Infinity are skipped. */
export function computeQuantiles(values: ArrayLike<number>): Quantiles {
    const stats = computeArrayStats(values);
    if (stats.finiteCount === 0) {
        return {
            min: Number.NaN,
            q1: Number.NaN,
            median: Number.NaN,
            q3: Number.NaN,
            max: Number.NaN,
            mean: Number.NaN,
            std: Number.NaN,
            count: 0
        };
    }
    const sorted = new Float64Array(stats.finiteCount);
    let cursor = 0;
    for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (Number.isFinite(value)) {
            sorted[cursor++] = value;
        }
    }
    sorted.sort();
    return {
        min: stats.min,
        q1: quantileFromSorted(sorted, 0.25),
        median: quantileFromSorted(sorted, 0.5),
        q3: quantileFromSorted(sorted, 0.75),
        max: stats.max,
        mean: stats.mean,
        std: stats.std,
        count: stats.finiteCount
    };
}

/** Evenly decimated finite (x, y) pairs. */
export interface ScatterSample {
    readonly x: Float64Array;
    readonly y: Float64Array;
    /** Finite pairs in the source arrays. */
    readonly sourceCount: number;
    /** Pairs dropped because either value was not finite. */
    readonly skippedCount: number;
    readonly decimated: boolean;
}

function normalizeMaxPoints(maxPoints: number | undefined): number {
    if (maxPoints === undefined || !Number.isFinite(maxPoints)) {
        return DEFAULT_SCATTER_MAX_POINTS;
    }
    return Math.max(2, Math.floor(maxPoints));
}

/**
 * Indices into `count` items at `limit` evenly spaced positions, always
 * including the first and last item. `count <= limit` returns every index.
 */
function evenSampleIndices(count: number, limit: number): Uint32Array {
    if (count <= limit) {
        const indices = new Uint32Array(count);
        for (let i = 0; i < count; i++) {
            indices[i] = i;
        }
        return indices;
    }
    const indices = new Uint32Array(limit);
    const step = (count - 1) / (limit - 1);
    for (let i = 0; i < limit; i++) {
        indices[i] = Math.round(i * step);
    }
    return indices;
}

/** Sample finite (x, y) pairs evenly, including both endpoints, up to `maxPoints`. */
export function sampleScatter(x: ArrayLike<number>, y: ArrayLike<number>, maxPoints: number = DEFAULT_SCATTER_MAX_POINTS): ScatterSample {
    const limit = normalizeMaxPoints(maxPoints);
    const length = Math.min(x.length, y.length);
    let validCount = 0;
    for (let i = 0; i < length; i++) {
        if (Number.isFinite(x[i]) && Number.isFinite(y[i])) {
            validCount++;
        }
    }
    if (validCount === 0) {
        return { x: new Float64Array(0), y: new Float64Array(0), sourceCount: 0, skippedCount: length, decimated: false };
    }
    const xs = new Float64Array(validCount);
    const ys = new Float64Array(validCount);
    let cursor = 0;
    for (let i = 0; i < length; i++) {
        const xValue = x[i];
        const yValue = y[i];
        if (Number.isFinite(xValue) && Number.isFinite(yValue)) {
            xs[cursor] = xValue;
            ys[cursor] = yValue;
            cursor++;
        }
    }
    const indices = evenSampleIndices(validCount, limit);
    const sampleX = new Float64Array(indices.length);
    const sampleY = new Float64Array(indices.length);
    for (let i = 0; i < indices.length; i++) {
        const source = indices[i];
        sampleX[i] = xs[source];
        sampleY[i] = ys[source];
    }
    return {
        x: sampleX,
        y: sampleY,
        sourceCount: validCount,
        skippedCount: length - validCount,
        decimated: indices.length < validCount
    };
}

/** Quantile summary for one numeric category. */
export interface CategoryBoxStats {
    readonly category: number;
    readonly stats: Quantiles;
}

/** Group finite values by numeric category (ascending) and summarize each group. */
export function boxStatsByCategory(values: ArrayLike<number>, categories: ArrayLike<number>): CategoryBoxStats[] {
    const length = Math.min(values.length, categories.length);
    const groups = new Map<number, number[]>();
    for (let i = 0; i < length; i++) {
        const value = values[i];
        const category = categories[i];
        if (!Number.isFinite(value) || !Number.isFinite(category)) {
            continue;
        }
        const group = groups.get(category);
        if (group) {
            group.push(value);
        } else {
            groups.set(category, [value]);
        }
    }
    return [...groups.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([category, group]) => ({ category, stats: computeQuantiles(group) }));
}

/** One named array consumed by {@link parallelCoordinates}. */
export interface ParallelCoordinateArray {
    readonly name: string;
    readonly values: ArrayLike<number>;
}

/** One sampled dimension ready for a Plotly `parcoords` trace. */
export interface ParallelCoordinateDimension {
    readonly name: string;
    readonly values: Float64Array;
}

/** Row-aligned parallel-coordinate dimensions with their sampling counts. */
export interface ParallelCoordinates {
    readonly dimensions: readonly ParallelCoordinateDimension[];
    /** Rows emitted (after row filtering and even decimation). */
    readonly rowCount: number;
    /** Row-aligned tuples in the source arrays (minimum length). */
    readonly sourceRowCount: number;
    /** Rows dropped because at least one dimension was not finite. */
    readonly skippedRows: number;
    readonly decimated: boolean;
}

/**
 * Row-align arrays by tuple index, drop rows with any non-finite dimension,
 * then evenly decimate the surviving rows (endpoints kept, `maxPoints` cap).
 * One sampled dimension per input array is ready to map onto a Plotly
 * `parcoords` trace.
 */
export function parallelCoordinates(
    arrays: readonly ParallelCoordinateArray[],
    maxPoints: number = DEFAULT_SCATTER_MAX_POINTS
): ParallelCoordinates {
    if (arrays.length === 0) {
        return { dimensions: [], rowCount: 0, sourceRowCount: 0, skippedRows: 0, decimated: false };
    }
    const limit = normalizeMaxPoints(maxPoints);
    let sourceRowCount = Number.POSITIVE_INFINITY;
    for (const array of arrays) {
        sourceRowCount = Math.min(sourceRowCount, array.values.length);
    }
    if (!Number.isFinite(sourceRowCount)) {
        sourceRowCount = 0;
    }
    const validRows: number[] = [];
    for (let row = 0; row < sourceRowCount; row++) {
        let valid = true;
        for (const array of arrays) {
            if (!Number.isFinite(array.values[row])) {
                valid = false;
                break;
            }
        }
        if (valid) {
            validRows.push(row);
        }
    }
    const selected = evenSampleIndices(validRows.length, limit);
    const dimensions = arrays.map((array) => {
        const values = new Float64Array(selected.length);
        for (let i = 0; i < selected.length; i++) {
            values[i] = array.values[validRows[selected[i]]];
        }
        return { name: array.name, values };
    });
    return {
        dimensions,
        rowCount: selected.length,
        sourceRowCount,
        skippedRows: sourceRowCount - validRows.length,
        decimated: selected.length < validRows.length
    };
}
