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
 * Pure time-series model for the native Exodus viewer.
 *
 * Consumes the `base.exodus-series` extractor shape
 * (`python/plugins/base/lib/exodus_series.py`): `{ sourceFile, nSteps,
 * arrays, steps }` where each step carries `{ index, time, mesh, values }`.
 * This module owns step/index math, per-step and global range computation,
 * color-by option derivation (`base.serve --color-by` format), and tolerant
 * payload parsing — everything a time-slider widget needs without a trame
 * server (`reader.TimestepValues` -> `view.ViewTime` becomes a client-side
 * step index over this payload).
 *
 * Pure functions + types only; no trame, no vuetify, no DOM, no three.js.
 * Color-by strings reuse the viewer-core toolbar model; LUT sampling stays
 * in `viewer-core/colormaps.ts`.
 */

import {
    CELL_COLOR_PREFIX,
    formatCellColorBy,
    formatPointColorBy,
    POINT_COLOR_PREFIX,
    SOLID_COLOR
} from '../../../../viewer-core/viewer-toolbar-model';

/** Where an Exodus variable lives: nodal, element (cell), or global. */
export type ExodusArrayLocation = 'node' | 'cell' | 'global';

/** One variable summary with its global range across all steps. */
export interface ExodusSeriesArraySummary {
    readonly name: string;
    readonly location: ExodusArrayLocation;
    readonly range: readonly [number, number];
}

/** Per-step decimated mesh snapshot. */
export interface ExodusStepMesh {
    readonly nNodes: number;
    readonly nElements: number;
    /** Decimated `[x, y, z]` node positions (server-side point budget). */
    readonly nodes: readonly (readonly [number, number, number])[];
    readonly blocks: readonly { readonly name: string; readonly count: number }[];
}

/** Per-step summary of one variable (stats + decimated samples). */
export interface ExodusValueSummary {
    readonly min: number;
    readonly max: number;
    readonly mean: number;
    readonly count: number;
    readonly samples: readonly number[];
}

/** One time step of the series. */
export interface ExodusSeriesStep {
    readonly index: number;
    readonly time: number;
    readonly mesh: ExodusStepMesh;
    readonly values: Readonly<Record<string, ExodusValueSummary>>;
}

/** Full extractor payload for one Exodus file. */
export interface ExodusSeriesPayload {
    readonly sourceFile: string;
    readonly nSteps: number;
    readonly arrays: readonly ExodusSeriesArraySummary[];
    readonly steps: readonly ExodusSeriesStep[];
}

/** Error thrown when a series payload fails validation. */
export class ExodusSeriesModelError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ExodusSeriesModelError';
    }
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new ExodusSeriesModelError(`series payload field '${field}' must be an object`);
    }
    return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ExodusSeriesModelError(`series payload field '${field}' must be a finite number`);
    }
    return value;
}

function asNonNegativeInt(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new ExodusSeriesModelError(`series payload field '${field}' must be a non-negative integer`);
    }
    return value;
}

function asString(value: unknown, field: string): string {
    if (typeof value !== 'string') {
        throw new ExodusSeriesModelError(`series payload field '${field}' must be a string`);
    }
    return value;
}

function asRange(value: unknown, field: string): readonly [number, number] {
    if (!Array.isArray(value) || value.length !== 2) {
        throw new ExodusSeriesModelError(`series payload field '${field}' must be a [min, max] pair`);
    }
    return [asFiniteNumber(value[0], field), asFiniteNumber(value[1], field)];
}

function parseLocation(value: unknown): ExodusArrayLocation {
    if (value === 'node' || value === 'cell' || value === 'global') {
        return value;
    }
    throw new ExodusSeriesModelError(`series array location must be 'node', 'cell', or 'global'`);
}

function parseArraySummary(value: unknown): ExodusSeriesArraySummary {
    const record = asRecord(value, 'arrays[]');
    return {
        name: asString(record['name'], 'arrays[].name'),
        location: parseLocation(record['location']),
        range: asRange(record['range'], 'arrays[].range')
    };
}

function parseTriple(value: unknown, field: string): readonly [number, number, number] {
    if (!Array.isArray(value) || value.length !== 3) {
        throw new ExodusSeriesModelError(`series payload field '${field}' must be an [x, y, z] triple`);
    }
    return [asFiniteNumber(value[0], field), asFiniteNumber(value[1], field), asFiniteNumber(value[2], field)];
}

function parseValueSummary(value: unknown, field: string): ExodusValueSummary {
    const record = asRecord(value, field);
    const samples = record['samples'];
    if (!Array.isArray(samples)) {
        throw new ExodusSeriesModelError(`series payload field '${field}.samples' must be an array`);
    }
    return {
        min: asFiniteNumber(record['min'], `${field}.min`),
        max: asFiniteNumber(record['max'], `${field}.max`),
        mean: asFiniteNumber(record['mean'], `${field}.mean`),
        count: asNonNegativeInt(record['count'], `${field}.count`),
        samples: samples.map((sample, at) => asFiniteNumber(sample, `${field}.samples[${at}]`))
    };
}

function parseStep(value: unknown, at: number): ExodusSeriesStep {
    const record = asRecord(value, `steps[${at}]`);
    const mesh = asRecord(record['mesh'], `steps[${at}].mesh`);
    const nodes = mesh['nodes'];
    if (!Array.isArray(nodes)) {
        throw new ExodusSeriesModelError(`series payload field 'steps[${at}].mesh.nodes' must be an array`);
    }
    const blocks = mesh['blocks'];
    if (!Array.isArray(blocks)) {
        throw new ExodusSeriesModelError(`series payload field 'steps[${at}].mesh.blocks' must be an array`);
    }
    const values = asRecord(record['values'], `steps[${at}].values`);
    const parsedValues: Record<string, ExodusValueSummary> = {};
    for (const [name, summary] of Object.entries(values)) {
        parsedValues[name] = parseValueSummary(summary, `steps[${at}].values['${name}']`);
    }
    return {
        index: asNonNegativeInt(record['index'], `steps[${at}].index`),
        time: asFiniteNumber(record['time'], `steps[${at}].time`),
        mesh: {
            nNodes: asNonNegativeInt(mesh['nNodes'], `steps[${at}].mesh.nNodes`),
            nElements: asNonNegativeInt(mesh['nElements'], `steps[${at}].mesh.nElements`),
            nodes: nodes.map((node, nodeAt) => parseTriple(node, `steps[${at}].mesh.nodes[${nodeAt}]`)),
            blocks: blocks.map((block, blockAt) => {
                const entry = asRecord(block, `steps[${at}].mesh.blocks[${blockAt}]`);
                return { name: asString(entry['name'], 'block.name'), count: asNonNegativeInt(entry['count'], 'block.count') };
            })
        },
        values: parsedValues
    };
}

/**
 * Validate an unknown value as an Exodus series payload. Accepts payloads
 * with extra fields (forward-compatible); rejects missing or mistyped
 * required fields with an `ExodusSeriesModelError`.
 */
export function parseExodusSeries(value: unknown): ExodusSeriesPayload {
    const record = asRecord(value, 'payload');
    const arrays = record['arrays'];
    if (!Array.isArray(arrays)) {
        throw new ExodusSeriesModelError(`series payload field 'arrays' must be an array`);
    }
    const steps = record['steps'];
    if (!Array.isArray(steps)) {
        throw new ExodusSeriesModelError(`series payload field 'steps' must be an array`);
    }
    const nSteps = asNonNegativeInt(record['nSteps'], 'nSteps');
    if (steps.length !== nSteps) {
        throw new ExodusSeriesModelError(`series payload 'steps' has ${steps.length} entries but nSteps is ${nSteps}`);
    }
    return {
        sourceFile: asString(record['sourceFile'], 'sourceFile'),
        nSteps,
        arrays: arrays.map(parseArraySummary),
        steps: steps.map((step, at) => parseStep(step, at))
    };
}

/** Number of steps in the series (0 for an empty payload). */
export function stepCount(series: ExodusSeriesPayload): number {
    return series.steps.length;
}

/**
 * Clamp a step index into `[0, nSteps - 1]`. Non-integers floor; NaN and
 * negative values clamp to 0; empty series always yield 0.
 */
export function clampStepIndex(index: number, nSteps: number): number {
    if (!(nSteps > 0)) {
        return 0;
    }
    if (!Number.isFinite(index)) {
        return 0;
    }
    return Math.min(nSteps - 1, Math.max(0, Math.floor(index)));
}

/** Step at a clamped index; undefined for an empty series. */
export function stepAt(series: ExodusSeriesPayload, index: number): ExodusSeriesStep | undefined {
    if (series.steps.length === 0) {
        return undefined;
    }
    return series.steps[clampStepIndex(index, series.steps.length)];
}

/** Simulation time of the clamped step; undefined for an empty series. */
export function stepTime(series: ExodusSeriesPayload, index: number): number | undefined {
    return stepAt(series, index)?.time;
}

/**
 * Next step index, clamped at the last step (or wrapped to 0 when `wrap`
 * is true). Empty series yield 0.
 */
export function nextStepIndex(index: number, nSteps: number, wrap = false): number {
    if (!(nSteps > 0)) {
        return 0;
    }
    const current = clampStepIndex(index, nSteps);
    if (current + 1 < nSteps) {
        return current + 1;
    }
    return wrap ? 0 : current;
}

/**
 * Previous step index, clamped at 0 (or wrapped to the last step when
 * `wrap` is true). Empty series yield 0.
 */
export function previousStepIndex(index: number, nSteps: number, wrap = false): number {
    if (!(nSteps > 0)) {
        return 0;
    }
    const current = clampStepIndex(index, nSteps);
    if (current > 0) {
        return current - 1;
    }
    return wrap ? nSteps - 1 : current;
}

/** Global `[min, max]` of an array across all steps; undefined when unknown. */
export function arrayRange(series: ExodusSeriesPayload, arrayName: string): readonly [number, number] | undefined {
    return series.arrays.find((array) => array.name === arrayName)?.range;
}

/** `[min, max]` of an array at one step; undefined when absent. */
export function stepValueRange(series: ExodusSeriesPayload, stepIndex: number, arrayName: string): readonly [number, number] | undefined {
    const summary = stepAt(series, stepIndex)?.values[arrayName];
    return summary ? [summary.min, summary.max] : undefined;
}

/** Decimated samples of an array at one step; empty when absent. */
export function stepValueSamples(series: ExodusSeriesPayload, stepIndex: number, arrayName: string): readonly number[] {
    return stepAt(series, stepIndex)?.values[arrayName]?.samples ?? [];
}

/**
 * Color-by options for the series (`base.serve --color-by` format):
 * `Solid Color` plus `Point: <name>` for nodal and `Cell: <name>` for
 * element arrays. Global arrays have no spatial mapping and are excluded.
 */
export function colorByOptions(series: ExodusSeriesPayload): string[] {
    const options = [SOLID_COLOR];
    for (const array of series.arrays) {
        if (array.location === 'node') {
            options.push(formatPointColorBy(array.name));
        } else if (array.location === 'cell') {
            options.push(formatCellColorBy(array.name));
        }
    }
    return options;
}

/** True when a color-by value names a point/cell array present in the series. */
export function hasColorByArray(series: ExodusSeriesPayload, colorBy: string): boolean {
    if (colorBy === SOLID_COLOR) {
        return true;
    }
    if (colorBy.startsWith(POINT_COLOR_PREFIX)) {
        const name = colorBy.slice(POINT_COLOR_PREFIX.length);
        return series.arrays.some((array) => array.location === 'node' && array.name === name);
    }
    if (colorBy.startsWith(CELL_COLOR_PREFIX)) {
        const name = colorBy.slice(CELL_COLOR_PREFIX.length);
        return series.arrays.some((array) => array.location === 'cell' && array.name === name);
    }
    return false;
}

/** Slider label for the clamped step (`Step 2 of 5 · t=1`). */
export function formatStepLabel(series: ExodusSeriesPayload, index: number): string {
    const step = stepAt(series, index);
    if (!step) {
        return 'No steps';
    }
    return `Step ${step.index + 1} of ${series.steps.length} · t=${step.time}`;
}

/**
 * Flat xyz positions of the clamped step's decimated mesh nodes, ready to
 * feed a three.js `BufferAttribute` (or the native-vtk decimation path) at
 * wiring time without re-parsing the payload.
 */
export function stepPositions(series: ExodusSeriesPayload, index: number): Float32Array {
    const step = stepAt(series, index);
    if (!step) {
        return new Float32Array(0);
    }
    const out = new Float32Array(step.mesh.nodes.length * 3);
    step.mesh.nodes.forEach((node, at) => {
        out[at * 3] = node[0];
        out[at * 3 + 1] = node[1];
        out[at * 3 + 2] = node[2];
    });
    return out;
}
