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
 * Pure decoding/aggregation helpers for derived-tally results in the
 * statepoint viewer: filter-bin labels, table rows, chart series, and CSV.
 * Kept free of React, Plotly, and Theia so vitest runs in node.
 */

import type { OpenMCDerivedTallyAxis, OpenMCDerivedTallyResult } from '../../../../../common/openmc-protocol';

export interface DerivedBinRow {
    index: number;
    filterLabels: string[];
    filterValues: unknown[];
    score: string;
    nuclide: string;
    mean: number;
    stdDev: number;
}

function formatNumber(value: number): string {
    if (!Number.isFinite(value)) {
        return '0';
    }
    if (value === 0) {
        return '0';
    }
    if (Math.abs(value) >= 1e5 || Math.abs(value) < 1e-3) {
        return value.toExponential(3);
    }
    return String(Number(value.toPrecision(6)));
}

function axisBinCount(axis: OpenMCDerivedTallyAxis): number {
    return Math.max(1, axis.bins.length);
}

/** Flattened filter-bin count implied by the axis metadata. */
export function derivedFilterBinCount(result: OpenMCDerivedTallyResult): number {
    return result.filters.reduce((product, axis) => product * axisBinCount(axis), 1);
}

function axisLabel(axis: OpenMCDerivedTallyAxis, index: number): string {
    const value = axis.bins[index];
    if (Array.isArray(value)) {
        if ((axis.type === 'energy' || axis.type === 'energyout') && value.length === 2) {
            return `${axis.type} ${formatNumber(Number(value[0]))}–${formatNumber(Number(value[1]))} eV`;
        }
        if (axis.type === 'time' && value.length === 2) {
            return `time ${formatNumber(Number(value[0]))}–${formatNumber(Number(value[1]))} s`;
        }
        if (axis.type === 'mesh' || axis.type === 'meshsurface' || axis.type === 'meshborn') {
            return `${axis.type} (${value.map((entry) => formatNumber(Number(entry))).join(', ')})`;
        }
        return `${axis.type} [${value.map((entry) => formatNumber(Number(entry))).join(', ')}]`;
    }
    if (typeof value === 'string') {
        return `${axis.type} ${value}`;
    }
    if (typeof value === 'number') {
        return `${axis.type} ${formatNumber(value)}`;
    }
    return `${axis.type} ${String(value)}`;
}

function filterPositions(result: OpenMCDerivedTallyResult, filterIndex: number): number[] {
    const positions = new Array(result.filters.length).fill(0);
    let remaining = filterIndex;
    for (let axisIndex = result.filters.length - 1; axisIndex >= 0; axisIndex -= 1) {
        const count = axisBinCount(result.filters[axisIndex]);
        positions[axisIndex] = remaining % count;
        remaining = Math.floor(remaining / count);
    }
    return positions;
}

/**
 * Table rows in the same filter-major, nuclide-last order as the backend
 * payload. Scores are always one per derived tally.
 */
export function derivedBinRows(result: OpenMCDerivedTallyResult): DerivedBinRow[] {
    const filterBins = Math.max(1, result.shape?.filterBins ?? derivedFilterBinCount(result));
    const nuclides = result.nuclides.length > 0 ? result.nuclides : ['total'];
    const rows: DerivedBinRow[] = [];
    for (let filterIndex = 0; filterIndex < filterBins; filterIndex += 1) {
        const positions = filterPositions(result, filterIndex);
        const filterLabels = result.filters.map((axis, axisIndex) => axisLabel(axis, positions[axisIndex]));
        const filterValues = result.filters.map((axis, axisIndex) => axis.bins[positions[axisIndex]]);
        for (let nuclideIndex = 0; nuclideIndex < nuclides.length; nuclideIndex += 1) {
            const flatIndex = filterIndex * nuclides.length + nuclideIndex;
            rows.push({
                index: rows.length,
                filterLabels,
                filterValues,
                score: result.scores[0] ?? 'derived',
                nuclide: nuclides[nuclideIndex],
                mean: result.mean[flatIndex] ?? 0,
                stdDev: result.stdDev[flatIndex] ?? 0
            });
        }
    }
    return rows;
}

/** Sum finite bins and combine uncertainty in quadrature (independent bins). */
export function aggregateDerivedResult(result: OpenMCDerivedTallyResult): { value: number; stdDev: number; bins: number } {
    let value = 0;
    let variance = 0;
    let bins = 0;
    for (let index = 0; index < result.mean.length; index += 1) {
        const mean = result.mean[index];
        if (!Number.isFinite(mean)) {
            continue;
        }
        value += mean;
        const stdDev = Number.isFinite(result.stdDev[index]) ? result.stdDev[index] : 0;
        variance += stdDev ** 2;
        bins += 1;
    }
    return { value, stdDev: Math.sqrt(variance), bins };
}

export interface DerivedChart {
    x: Array<number | string>;
    y: number[];
    errorY: number[];
    xTitle: string;
    yTitle: string;
}

/**
 * Chart series for one derived tally: a real energy axis when the only filter
 * is an energy binning, otherwise the flattened bin index. Multi-nuclide
 * results are labeled by nuclide so the bins remain distinguishable.
 */
export function buildDerivedChart(result: OpenMCDerivedTallyResult): DerivedChart {
    const rows = derivedBinRows(result);
    const energyOnly =
        result.filters.length === 1 &&
        result.filters[0].type === 'energy' &&
        result.filters[0].bins.every((bin) => Array.isArray(bin) && bin.length >= 2);
    const x = energyOnly
        ? result.filters[0].bins.map((bin) => (Number((bin as number[])[0]) + Number((bin as number[])[1])) / 2)
        : rows.map((row) => (result.nuclides.length > 1 ? `${row.index + 1} · ${row.nuclide}` : row.index + 1));
    const unit = result.unit?.trim();
    const score = result.scores[0] ?? 'derived';
    return {
        x,
        y: rows.map((row) => row.mean),
        errorY: rows.map((row) => row.stdDev),
        xTitle: energyOnly ? 'Energy (eV)' : 'Bin',
        yTitle: unit ? `${score} [${unit}]` : score
    };
}

function csvCell(value: unknown): string {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV export: one row per filter-bin/nuclide with mean and standard deviation. */
export function derivedTallyToCsv(result: OpenMCDerivedTallyResult): string {
    const filterHeaders = result.filters.map((axis) => axis.type);
    const header = ['bin', ...filterHeaders, 'score', 'nuclide', 'mean', 'std_dev'];
    const rows = derivedBinRows(result).map((row) => [row.index + 1, ...row.filterValues, row.score, row.nuclide, row.mean, row.stdDev]);
    return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}

/** True when every reported bin is finite (the backend already zeroes non-finite moments). */
export function derivedResultIsFinite(result: OpenMCDerivedTallyResult): boolean {
    return result.mean.every((value) => Number.isFinite(value)) && result.stdDev.every((value) => Number.isFinite(value));
}
