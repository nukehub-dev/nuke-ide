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
 * Pure model for a tally score series across OpenMC statepoints
 * (`openmc.tally-series`). Validates the command payload, owns step/index
 * math, computes chart ranges/labels, recognizes statepoint filenames, and
 * resolves sibling series candidates for the widget.
 *
 * Kept free of Plotly, DOM, Theia, and three.js so it is unit-testable in node.
 */

import type { OpenMCTallySeries, OpenMCTallySeriesStatistic, OpenMCTallySeriesStep } from '../../../../../common/openmc-protocol';

/** Error thrown when a tally series payload fails validation. */
export class TallySeriesModelError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TallySeriesModelError';
    }
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TallySeriesModelError(`${field} must be an object`);
    }
    return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TallySeriesModelError(`${field} must be a finite number`);
    }
    return value;
}

function asNonNegativeInteger(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new TallySeriesModelError(`${field} must be a non-negative integer`);
    }
    return value;
}

function asString(value: unknown, field: string): string {
    if (typeof value !== 'string') {
        throw new TallySeriesModelError(`${field} must be a string`);
    }
    return value;
}

function asBoolean(value: unknown, field: string): boolean {
    if (typeof value !== 'boolean') {
        throw new TallySeriesModelError(`${field} must be a boolean`);
    }
    return value;
}

function asStringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value)) {
        throw new TallySeriesModelError(`${field} must be an array`);
    }
    return value.map((entry, at) => asString(entry, `${field}[${at}]`));
}

function asRange(value: unknown, field: string): [number, number] {
    if (!Array.isArray(value) || value.length !== 2) {
        throw new TallySeriesModelError(`${field} must be a [min, max] pair`);
    }
    return [asFiniteNumber(value[0], `${field}[0]`), asFiniteNumber(value[1], `${field}[1]`)];
}

function parseStatistic(value: unknown): OpenMCTallySeriesStatistic {
    if (value === 'total' || value === 'mean' || value === 'max') {
        return value;
    }
    throw new TallySeriesModelError(`statistic must be 'total', 'mean', or 'max'`);
}

function parseStep(value: unknown, at: number): OpenMCTallySeriesStep {
    const record = asRecord(value, `steps[${at}]`);
    return {
        index: asFiniteNumber(record['index'], `steps[${at}].index`),
        time: asFiniteNumber(record['time'], `steps[${at}].time`),
        file: asString(record['file'], `steps[${at}].file`),
        fileName: asString(record['fileName'], `steps[${at}].fileName`),
        value: asFiniteNumber(record['value'], `steps[${at}].value`),
        std: asFiniteNumber(record['std'], `steps[${at}].std`),
        nBins: asNonNegativeInteger(record['nBins'], `steps[${at}].nBins`)
    };
}

/**
 * Validate an unknown value as an `openmc.tally-series` payload. Accepts
 * extra fields (forward-compatible), copies every array/range, and rejects
 * missing or mistyped fields with a `TallySeriesModelError` naming the field
 * path (for example `steps[1].value must be a finite number`).
 */
export function parseTallySeriesPayload(value: unknown): OpenMCTallySeries {
    const record = asRecord(value, 'payload');
    const steps = record['steps'];
    if (!Array.isArray(steps)) {
        throw new TallySeriesModelError('steps must be an array');
    }
    if (steps.length === 0) {
        throw new TallySeriesModelError('steps must contain at least one step');
    }
    const viewRange = record['viewRange'];
    return {
        files: asStringArray(record['files'], 'files'),
        tallyId: asFiniteNumber(record['tallyId'], 'tallyId'),
        tallyName: asString(record['tallyName'], 'tallyName'),
        score: asString(record['score'], 'score'),
        nuclide: asString(record['nuclide'], 'nuclide'),
        statistic: parseStatistic(record['statistic']),
        timeLabel: asString(record['timeLabel'], 'timeLabel'),
        steps: steps.map((step, at) => parseStep(step, at)),
        range: asRange(record['range'], 'range'),
        ...(viewRange === undefined ? {} : { viewRange: asRange(viewRange, 'viewRange') }),
        hasMesh: asBoolean(record['hasMesh'], 'hasMesh'),
        volumeWeighted: asBoolean(record['volumeWeighted'], 'volumeWeighted')
    };
}

/**
 * Clamp a step index into `[0, count - 1]`. Non-integers floor; NaN, infinite,
 * and negative values clamp to 0; an empty series always yields 0.
 */
export function clampSeriesIndex(index: number, count: number): number {
    if (!(count > 0) || !Number.isFinite(index)) {
        return 0;
    }
    return Math.min(count - 1, Math.max(0, Math.floor(index)));
}

/**
 * Previous step index, clamped at 0. Non-finite input yields 0. An optional
 * step count clamps the current index into range before stepping back.
 */
export function previousSeriesIndex(index: number, count?: number): number {
    if (count !== undefined && !(count > 0)) {
        return 0;
    }
    if (!Number.isFinite(index)) {
        return 0;
    }
    const current = count === undefined ? Math.floor(index) : clampSeriesIndex(index, count);
    return Math.max(0, current - 1);
}

/** Next step index, clamped at `count - 1`. Empty series yield 0. */
export function nextSeriesIndex(index: number, count: number): number {
    if (!(count > 0)) {
        return 0;
    }
    return Math.min(count - 1, clampSeriesIndex(index, count) + 1);
}

/**
 * Y range of the aggregated step values including `±std`, over steps with
 * finite value/std. A flat range is padded by 5% of its magnitude (1 at
 * zero); no finite steps yield `[0, 1]`.
 */
export function seriesYRange(series: OpenMCTallySeries): [number, number] {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const step of series.steps) {
        if (!Number.isFinite(step.value) || !Number.isFinite(step.std)) {
            continue;
        }
        const low = step.value - step.std;
        const high = step.value + step.std;
        if (!Number.isFinite(low) || !Number.isFinite(high)) {
            continue;
        }
        min = Math.min(min, low);
        max = Math.max(max, high);
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
        return [0, 1];
    }
    if (min === max) {
        const padding = Math.abs(min) * 0.05 || 1;
        return [min - padding, min + padding];
    }
    return [min, max];
}

const STATISTIC_LABELS: Record<OpenMCTallySeriesStatistic, string> = {
    total: 'Total',
    mean: 'Mean',
    max: 'Max'
};

/** Display label for a tally aggregation statistic. */
export function seriesStatisticLabel(statistic: OpenMCTallySeriesStatistic): string {
    return STATISTIC_LABELS[statistic] ?? 'Total';
}

/**
 * Chart-ready series at a clamped step index. `yTitle` combines the statistic
 * with the score and appends the nuclide unless it is the `total` aggregate.
 */
export function buildSeriesChart(
    series: OpenMCTallySeries,
    currentIndex: number
): {
    x: number[];
    y: number[];
    errorY: number[];
    currentIndex: number;
    xTitle: string;
    yTitle: string;
} {
    const index = clampSeriesIndex(currentIndex, series.steps.length);
    const statistic = seriesStatisticLabel(series.statistic);
    const nuclide = series.nuclide === 'total' ? '' : ` (${series.nuclide})`;
    return {
        x: series.steps.map((step) => step.time),
        y: series.steps.map((step) => step.value),
        errorY: series.steps.map((step) => step.std),
        currentIndex: index,
        xTitle: series.timeLabel,
        yTitle: `${statistic} ${series.score}${nuclide}`
    };
}

const STATEPOINT_FILE_PATTERN = /^statepoint.*\.h5$/i;
const OPENMC_SIMULATION_FILE_PATTERN = /^openmc_simulation_n\d+\.h5$/i;

/** True for `statepoint*.h5` and `openmc_simulation_n<N>.h5` (case-insensitive). */
export function isStatepointSeriesFile(name: string): boolean {
    return STATEPOINT_FILE_PATTERN.test(name) || OPENMC_SIMULATION_FILE_PATTERN.test(name);
}

interface SeriesCandidate {
    readonly name: string;
    readonly path: string;
}

function baseName(path: string): string {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || path;
}

/** Last digit run in the filename stem, e.g. `statepoint.10.h5` -> 10. */
function numericSuffix(name: string): number | undefined {
    const stem = name.replace(/\.[^.]+$/, '');
    const match = /(\d+)(?!.*\d)/.exec(stem);
    if (!match) {
        return undefined;
    }
    const suffix = Number(match[1]);
    return Number.isFinite(suffix) ? suffix : undefined;
}

function compareCandidates(left: SeriesCandidate, right: SeriesCandidate): number {
    const leftSuffix = numericSuffix(left.name);
    const rightSuffix = numericSuffix(right.name);
    if (leftSuffix !== undefined && rightSuffix === undefined) {
        return -1;
    }
    if (leftSuffix === undefined && rightSuffix !== undefined) {
        return 1;
    }
    if (leftSuffix !== undefined && rightSuffix !== undefined && leftSuffix !== rightSuffix) {
        return leftSuffix - rightSuffix;
    }
    if (left.name !== right.name) {
        return left.name < right.name ? -1 : 1;
    }
    if (left.path !== right.path) {
        return left.path < right.path ? -1 : 1;
    }
    return 0;
}

/**
 * Statepoint series files for the current file's directory: the current path
 * plus matching siblings, deduped by exact path and natural-sorted by numeric
 * filename suffix then name. Non-numeric names sort after numeric ones.
 */
export function seriesCandidatePaths(currentPath: string, siblings: readonly { readonly name: string; readonly path: string }[]): string[] {
    const candidates = new Map<string, SeriesCandidate>();
    candidates.set(currentPath, { name: baseName(currentPath), path: currentPath });
    for (const sibling of siblings) {
        if (!isStatepointSeriesFile(sibling.name) || candidates.has(sibling.path)) {
            continue;
        }
        candidates.set(sibling.path, { name: sibling.name, path: sibling.path });
    }
    return Array.from(candidates.values())
        .sort(compareCandidates)
        .map((candidate) => candidate.path);
}
