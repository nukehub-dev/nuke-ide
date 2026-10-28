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
 * Dataset inspector core (D1): summarize a parsed native VTK model (kind,
 * point/cell counts, world bounds, named data arrays) and page one numeric
 * array into a spreadsheet-shaped table with optional point coordinates
 * (polydata points, grid nodes) or cell-center coordinates (grid centers,
 * polydata cell centroids).
 *
 * Bounds always come from the position buffer — `gridDimensions` holds cell
 * counts, not extents, so it can never answer "how big is this dataset".
 * Tables are capped (default 200 rows) so the inspector never materializes a
 * 100k-row DOM; `rowCount` still reports the full array length for the
 * status line. Missing arrays and empty datasets return undefined instead of
 * a fabricated table. Pure functions + types only; no three.js, no DOM, no
 * Theia imports.
 */

import type { NativeVtkDataArray, NativeVtkDatasetFamily, NativeVtkModel } from '../plugins/openmc/widgets/native-vtk/native-vtk-data';
import { boundingBoxFromPositions } from './clip-plane';
import { tupleScalar } from './scalar-mapping';
import { computeQuantiles, type Quantiles } from './statistics';

/** Data-array association shown by the inspector. */
export type DatasetAssociation = 'point' | 'cell';

/** Default row cap for one inspector table (the "first 200 rows" view). */
export const DEFAULT_DATASET_TABLE_ROWS = 200;

/** One named data array exposed by the active dataset. */
export interface DatasetArrayInfo {
    readonly name: string;
    readonly association: DatasetAssociation;
    readonly components: number;
    /** Scalar range (tuple magnitude for multi-component arrays), as the color-by pipeline reads it. */
    readonly range: readonly [number, number];
    /** Number of tuples (point or cell values) in the array. */
    readonly tupleCount: number;
}

/** Axis-aligned dataset bounds in world coordinates. */
export interface DatasetBounds {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
}

/** Everything the inspector summary card renders for one dataset. */
export interface DatasetSummary {
    readonly kind: NativeVtkDatasetFamily;
    readonly nPoints: number;
    readonly nCells: number;
    readonly bounds: DatasetBounds | undefined;
    readonly arrays: readonly DatasetArrayInfo[];
}

/**
 * One paged numeric table: stable column headers, the underlying row count,
 * and a windowed `rows()` accessor. `rows()` never returns more rows than the
 * table's `maxRows` budget, whatever the caller asks for.
 */
export interface DatasetTable {
    readonly columns: readonly string[];
    readonly rowCount: number;
    rows(offset: number, limit: number): string[][];
}

/** Descriptive statistics (plus an optional integral) for one array. */
export interface DatasetStats extends Quantiles {
    /** Integral of the scalar over the cell measure, when the geometry supplies one. */
    readonly total?: number;
    /** Cell measure used by {@link total} (grid volume or triangle area). */
    readonly measure?: 'volume' | 'area';
    /** Sum of the cell measures over the array's cells. */
    readonly measureTotal?: number;
}

function cellMeasure(model: NativeVtkModel, cellCount: number): { measure: 'volume' | 'area'; perCell: Float64Array } | undefined {
    if (model.gridAxes && model.gridDimensions) {
        const [xAxis, yAxis, zAxis] = model.gridAxes;
        const dx = xAxis.length > 1 ? xAxis[1] - xAxis[0] : 0;
        const dy = yAxis.length > 1 ? yAxis[1] - yAxis[0] : 0;
        const dz = zAxis.length > 1 ? zAxis[1] - zAxis[0] : 0;
        const volume = dx * dy * dz;
        if (Number.isFinite(volume) && volume > 0) {
            return { measure: 'volume', perCell: new Float64Array(cellCount).fill(volume) };
        }
        const area = dx * dy;
        if (Number.isFinite(area) && area > 0) {
            return { measure: 'area', perCell: new Float64Array(cellCount).fill(area) };
        }
        return undefined;
    }
    const triangles = model.triangles;
    const triangleCells = model.triangleCells;
    if (!triangles || !triangleCells || triangles.length === 0) {
        return undefined;
    }
    const perCell = new Float64Array(cellCount);
    for (let t = 0; t + 2 < triangles.length; t += 3) {
        const a = triangles[t] * 3;
        const b = triangles[t + 1] * 3;
        const c = triangles[t + 2] * 3;
        const abx = (model.positions[b] ?? 0) - (model.positions[a] ?? 0);
        const aby = (model.positions[b + 1] ?? 0) - (model.positions[a + 1] ?? 0);
        const abz = (model.positions[b + 2] ?? 0) - (model.positions[a + 2] ?? 0);
        const acx = (model.positions[c] ?? 0) - (model.positions[a] ?? 0);
        const acy = (model.positions[c + 1] ?? 0) - (model.positions[a + 1] ?? 0);
        const acz = (model.positions[c + 2] ?? 0) - (model.positions[a + 2] ?? 0);
        const cx = aby * acz - abz * acy;
        const cy = abz * acx - abx * acz;
        const cz = abx * acy - aby * acx;
        const area = 0.5 * Math.hypot(cx, cy, cz);
        const cell = triangleCells[t / 3];
        if (Number.isFinite(area) && cell !== undefined && cell >= 0 && cell < perCell.length) {
            perCell[cell] += area;
        }
    }
    return { measure: 'area', perCell };
}

/**
 * Describe one array: min/Q1/median/Q3/max/mean/std/count over finite tuples.
 * Cell arrays on axis-aligned grids or triangle meshes also get `total`
 * (Σ value × cell measure) and `measureTotal`; point arrays do not, because
 * nodal volumes need shape functions the viewer does not carry.
 */
export function statsForArray(
    model: NativeVtkModel,
    association: DatasetAssociation,
    name: string,
    component = -1
): DatasetStats | undefined {
    const array = findArray(model, association, name);
    if (!array) {
        return undefined;
    }
    const components = Math.max(1, array.components);
    const tuples = Math.floor(array.values.length / components);
    const values = new Float64Array(tuples);
    for (let i = 0; i < tuples; i++) {
        values[i] = tupleScalar(array.values, components, i, component);
    }
    const stats = computeQuantiles(values);
    if (association !== 'cell') {
        return stats;
    }
    const measure = cellMeasure(model, tuples);
    if (!measure) {
        return stats;
    }
    let total = 0;
    let measureTotal = 0;
    for (let i = 0; i < tuples; i++) {
        const weight = measure.perCell[i];
        measureTotal += weight;
        if (Number.isFinite(values[i])) {
            total += values[i] * weight;
        }
    }
    return { ...stats, total, measure: measure.measure, measureTotal };
}

/**
 * Summarize a parsed native model. Grid point counts come from the nodal
 * boundary axes (or the point-array tuple count when axes are absent, e.g.
 * `.vts`); grid cell counts are the cell-center positions. Polydata cell
 * counts prefer the cell-array tuple count, then the highest cell index in
 * the connectivity maps, then the vertex-cell count for point clouds.
 */
export function summarizeNativeModel(model: NativeVtkModel): DatasetSummary {
    return {
        kind: model.family,
        nPoints: summarizePointCount(model),
        nCells: summarizeCellCount(model),
        bounds: boundingBoxFromPositions(model.positions),
        arrays: collectArrayInfo(model)
    };
}

/**
 * Build the inspector table for one array, or undefined when the dataset has
 * no such array for that association. Coordinate columns are prepended when
 * the positions (or connectivity) can supply them: `x, y, z` for point data,
 * cell centers for cell data. Multi-component arrays expand to one column per
 * component (`name[0]`, `name[1]`, ...).
 */
export function tableForArray(
    model: NativeVtkModel,
    association: DatasetAssociation,
    name: string,
    maxRows: number = DEFAULT_DATASET_TABLE_ROWS
): DatasetTable | undefined {
    const array = findArray(model, association, name);
    if (!array) {
        return undefined;
    }
    const components = Math.max(1, Math.floor(array.components));
    const rowCount = Math.max(0, Math.floor(array.values.length / components));
    const rowLimit = normalizeRowLimit(maxRows);
    const coordinates = association === 'point' ? pointCoordinatesAvailable(model, rowCount) : cellCoordinatesAvailable(model, rowCount);
    const columns: string[] = coordinates ? ['x', 'y', 'z'] : [];
    if (components <= 1) {
        columns.push(array.name);
    } else {
        for (let component = 0; component < components; component++) {
            columns.push(`${array.name}[${component}]`);
        }
    }
    return {
        columns,
        rowCount,
        rows(offset: number, limit: number): string[][] {
            const start = clampRowOffset(offset, rowCount);
            const requested = normalizeRowLimit(limit);
            const count = Math.min(requested, rowLimit, rowCount - start);
            const centers =
                coordinates && association === 'cell' && model.family === 'polydata'
                    ? polydataCellCenters(model, start, start + count)
                    : undefined;
            const rows: string[][] = [];
            for (let index = 0; index < count; index++) {
                const row = start + index;
                const values: string[] = [];
                if (coordinates) {
                    const point =
                        association === 'point'
                            ? pointCoordinates(model, row)
                            : model.family === 'polydata'
                              ? centers
                                  ? [centers[index * 3], centers[index * 3 + 1], centers[index * 3 + 2]]
                                  : undefined
                              : gridCellCenter(model, row);
                    if (point) {
                        values.push(formatDatasetNumber(point[0]), formatDatasetNumber(point[1]), formatDatasetNumber(point[2]));
                    } else {
                        values.push('', '', '');
                    }
                }
                for (let component = 0; component < components; component++) {
                    const at = row * components + component;
                    values.push(at < array.values.length ? formatDatasetNumber(array.values[at]) : '');
                }
                rows.push(values);
            }
            return rows;
        }
    };
}

/**
 * Render a table as CSV (header plus the first `maxRows` rows, trailing
 * newline). Values reuse the inspector's display formatting, so the copied
 * CSV always matches what the panel shows; non-finite values stay blank.
 * Fields with commas, quotes, or newlines are quoted per RFC 4180.
 */
export function tableToCsv(table: DatasetTable, maxRows: number = DEFAULT_DATASET_TABLE_ROWS): string {
    if (table.columns.length === 0) {
        return '';
    }
    const rows = table.rows(0, normalizeRowLimit(maxRows));
    const lines = [table.columns.map(csvField).join(',')];
    for (const row of rows) {
        lines.push(row.map(csvField).join(','));
    }
    return `${lines.join('\n')}\n`;
}

/**
 * Display formatting shared by table cells, bounds, and CSV: six significant
 * digits, no locale separators, trailing zeros trimmed. Non-finite values
 * render as an empty cell (CSV-safe), and negative zero normalizes to `0`.
 */
export function formatDatasetNumber(value: number): string {
    if (!Number.isFinite(value)) {
        return '';
    }
    if (value === 0) {
        return '0';
    }
    return Number(value.toPrecision(6)).toString();
}

function findArray(model: NativeVtkModel, association: DatasetAssociation, name: string): NativeVtkDataArray | undefined {
    const arrays = association === 'point' ? model.pointArrays : model.cellArrays;
    return arrays.find((array) => array.name === name);
}

function tupleCountOf(array: NativeVtkDataArray): number {
    return Math.max(0, Math.floor(array.values.length / Math.max(1, Math.floor(array.components))));
}

function collectArrayInfo(model: NativeVtkModel): DatasetArrayInfo[] {
    const infos: DatasetArrayInfo[] = [];
    for (const array of model.pointArrays) {
        infos.push(arrayInfo(array));
    }
    for (const array of model.cellArrays) {
        infos.push(arrayInfo(array));
    }
    return infos;
}

function arrayInfo(array: NativeVtkDataArray): DatasetArrayInfo {
    const components = Math.max(1, Math.floor(array.components));
    return {
        name: array.name,
        association: array.association,
        components,
        range: array.range,
        tupleCount: tupleCountOf(array)
    };
}

function summarizePointCount(model: NativeVtkModel): number {
    if (model.family === 'polydata') {
        return Math.max(0, Math.floor(model.nPoints));
    }
    if (model.gridAxes) {
        const [xs, ys, zs] = model.gridAxes;
        return Math.max(0, xs.length * ys.length * zs.length);
    }
    // `.vts` carries no boundary axes: the point-data tuple count is the
    // closest honest answer, then the model's cell-count fallback.
    const fromArrays = model.pointArrays.reduce((max, array) => Math.max(max, tupleCountOf(array)), 0);
    return fromArrays > 0 ? fromArrays : Math.max(0, Math.floor(model.nPoints));
}

function summarizeCellCount(model: NativeVtkModel): number {
    if (model.family !== 'polydata') {
        // Grids store cell centers in `positions`; `nPoints` is the cell count.
        return Math.max(0, Math.floor(model.nPoints));
    }
    const fromArrays = model.cellArrays.reduce((max, array) => Math.max(max, tupleCountOf(array)), 0);
    if (fromArrays > 0) {
        return fromArrays;
    }
    let highest = -1;
    for (const cell of model.segmentCells ?? []) {
        if (cell > highest) {
            highest = cell;
        }
    }
    for (const cell of model.triangleCells ?? []) {
        if (cell > highest) {
            highest = cell;
        }
    }
    if (highest >= 0) {
        return highest + 1;
    }
    // Vertex-only polydata: one vertex cell per entry, numbered from 0.
    return model.vertices?.length ?? 0;
}

function pointCoordinatesAvailable(model: NativeVtkModel, rowCount: number): boolean {
    if (rowCount === 0) {
        return false;
    }
    if (model.family === 'polydata') {
        return model.positions.length >= rowCount * 3;
    }
    return model.gridAxes !== undefined;
}

function cellCoordinatesAvailable(model: NativeVtkModel, rowCount: number): boolean {
    if (rowCount === 0) {
        return false;
    }
    if (model.family !== 'polydata') {
        return model.positions.length >= rowCount * 3;
    }
    if (model.positions.length === 0) {
        return false;
    }
    return (
        (model.triangles !== undefined && model.triangleCells !== undefined) ||
        (model.segments !== undefined && model.segmentCells !== undefined) ||
        (model.vertices !== undefined && model.vertices.length > 0)
    );
}

/** Point coordinates: polydata point positions, or grid nodes from the boundary axes. */
function pointCoordinates(model: NativeVtkModel, point: number): [number, number, number] | undefined {
    if (model.family !== 'polydata') {
        const axes = model.gridAxes;
        if (!axes) {
            return undefined;
        }
        const [xs, ys, zs] = axes;
        const nx = xs.length;
        const ny = ys.length;
        if (nx === 0 || ny === 0 || zs.length === 0 || point >= nx * ny * zs.length) {
            return undefined;
        }
        return [xs[point % nx], ys[Math.floor(point / nx) % ny], zs[Math.floor(point / (nx * ny))]];
    }
    return positionAt(model.positions, point);
}

/** Grid cell centers are stored in `positions` by the parser. */
function gridCellCenter(model: NativeVtkModel, cell: number): [number, number, number] | undefined {
    return positionAt(model.positions, cell);
}

function positionAt(positions: Float32Array, index: number): [number, number, number] | undefined {
    const at = index * 3;
    if (at + 2 >= positions.length) {
        return undefined;
    }
    return [positions[at], positions[at + 1], positions[at + 2]];
}

/**
 * Cell centers for a polydata window as xyz triples (NaN-filled where the
 * connectivity has no geometry for that cell, e.g. volumetric cells the
 * surface parser skipped). Triangles win; line cells fall back to their
 * endpoint average; vertex cells use their single point. Only the requested
 * window is accumulated, so opening a table on a million-cell dataset stays
 * bounded to the row budget.
 */
function polydataCellCenters(model: NativeVtkModel, start: number, end: number): Float64Array {
    const count = Math.max(0, end - start);
    const sums = new Float64Array(count * 3);
    const seen = new Uint32Array(count);
    const add = (cell: number, point: number): void => {
        if (cell < start || cell >= end) {
            return;
        }
        const at = point * 3;
        if (at + 2 >= model.positions.length) {
            return;
        }
        const slot = (cell - start) * 3;
        sums[slot] += model.positions[at];
        sums[slot + 1] += model.positions[at + 1];
        sums[slot + 2] += model.positions[at + 2];
        seen[cell - start] += 1;
    };
    const { triangles, triangleCells, segments, segmentCells, vertices } = model;
    if (triangles && triangleCells) {
        const triangleCount = Math.min(triangleCells.length, Math.floor(triangles.length / 3));
        for (let triangle = 0; triangle < triangleCount; triangle++) {
            const cell = triangleCells[triangle];
            add(cell, triangles[triangle * 3]);
            add(cell, triangles[triangle * 3 + 1]);
            add(cell, triangles[triangle * 3 + 2]);
        }
    }
    if (segments && segmentCells) {
        const segmentCount = Math.min(segmentCells.length, Math.floor(segments.length / 2));
        for (let segment = 0; segment < segmentCount; segment++) {
            const cell = segmentCells[segment];
            // Surface outlines duplicate triangle corners for the same cell;
            // keep the triangle weighting when the cell already has one.
            if (cell >= start && cell < end && seen[cell - start] > 0) {
                continue;
            }
            add(cell, segments[segment * 2]);
            add(cell, segments[segment * 2 + 1]);
        }
    }
    if (vertices) {
        const limit = Math.min(vertices.length, end);
        for (let cell = start; cell < limit; cell++) {
            if (seen[cell - start] === 0) {
                add(cell, vertices[cell]);
            }
        }
    }
    for (let slot = 0; slot < count; slot++) {
        if (seen[slot] === 0) {
            sums[slot * 3] = Number.NaN;
            sums[slot * 3 + 1] = Number.NaN;
            sums[slot * 3 + 2] = Number.NaN;
        } else {
            sums[slot * 3] /= seen[slot];
            sums[slot * 3 + 1] /= seen[slot];
            sums[slot * 3 + 2] /= seen[slot];
        }
    }
    return sums;
}

/** Non-negative integer row limit; +Infinity means "no caller limit" (still capped by the table budget). */
function normalizeRowLimit(limit: number): number {
    if (!Number.isFinite(limit)) {
        return limit > 0 ? Number.MAX_SAFE_INTEGER : 0;
    }
    return Math.max(0, Math.floor(limit));
}

function clampRowOffset(offset: number, rowCount: number): number {
    if (!Number.isFinite(offset)) {
        return 0;
    }
    return Math.min(rowCount, Math.max(0, Math.floor(offset)));
}

function csvField(value: string): string {
    return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
