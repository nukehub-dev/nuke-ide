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
 * Dataset Inspector aggregation for DAGMC multiblock viewers.
 *
 * The inspector contract (`ViewerDatasetHost`) describes one dataset, but a
 * DAGMC `.vtm` is a list of per-volume blocks. These helpers treat every
 * loaded block as one logical polydata dataset: counts and bounds aggregate,
 * arrays with the same association + name merge into one catalogue entry,
 * table pages cross block boundaries, and statistics combine the selected
 * component/magnitude values over every block carrying the array.
 *
 * Cell integrals stay per block (each block owns its triangles and positions)
 * and are summed only when the block's measure is area. Pure functions only;
 * no three.js, DOM, or Theia imports.
 */

import type { NativeVtkDataArray } from '../native-vtk/native-vtk-data';
import type { DagmcBlockModel } from './dagmc-multiblock';
import {
    DEFAULT_DATASET_TABLE_ROWS,
    statsForArray,
    summarizeNativeModel,
    tableForArray,
    type DatasetArrayInfo,
    type DatasetAssociation,
    type DatasetBounds,
    type DatasetStats,
    type DatasetSummary,
    type DatasetTable
} from '../../../../viewer-core/dataset-inspector';
import { tupleScalar } from '../../../../viewer-core/scalar-mapping';
import { computeQuantiles } from '../../../../viewer-core/statistics';

/**
 * Aggregate summary for every loaded DAGMC block, or undefined before a
 * dataset lands. Counts and bounds are sums/unions; arrays merge by
 * association + name with tuple counts summed and ranges unioned. The first
 * block's schema wins when component counts disagree, so one array never
 * appears twice in the catalogue.
 */
export function summarizeDagmcBlocks(blocks: readonly DagmcBlockModel[]): DatasetSummary | undefined {
    if (blocks.length === 0) {
        return undefined;
    }
    let nPoints = 0;
    let nCells = 0;
    let bounds: DatasetBounds | undefined;
    const arrays = new Map<string, DatasetArrayInfo>();
    for (const block of blocks) {
        const summary = summarizeNativeModel(block);
        nPoints += Math.max(0, Math.floor(summary.nPoints));
        nCells += Math.max(0, Math.floor(summary.nCells));
        bounds = unionBounds(bounds, summary.bounds);
        for (const array of summary.arrays) {
            const key = `${array.association}\u0000${array.name}`;
            const existing = arrays.get(key);
            if (!existing) {
                arrays.set(key, array);
                continue;
            }
            arrays.set(key, {
                name: existing.name,
                association: existing.association,
                components: existing.components,
                range: unionRange(existing.range, array.range),
                tupleCount: existing.tupleCount + array.tupleCount
            });
        }
    }
    return {
        kind: 'polydata',
        nPoints,
        nCells,
        bounds,
        arrays: [...arrays.values()].sort(compareArrayInfo)
    };
}

/**
 * Paged inspector table for one array across every block that carries it.
 * Columns come from the first matching block table; later blocks with a
 * different column count are padded/sliced onto that schema. `rowCount` is
 * the sum over blocks, while `rows()` still honors the caller's row budget
 * and the table-wide `maxRows` cap.
 */
export function dagmcTableForArray(
    blocks: readonly DagmcBlockModel[],
    association: DatasetAssociation,
    name: string,
    maxRows: number = DEFAULT_DATASET_TABLE_ROWS
): DatasetTable | undefined {
    const tables: DatasetTable[] = [];
    for (const block of blocks) {
        const table = tableForArray(block, association, name, maxRows);
        if (table) {
            tables.push(table);
        }
    }
    const first = tables[0];
    if (!first) {
        return undefined;
    }
    const columns = [...first.columns];
    if (columns.length === 0) {
        return undefined;
    }
    let rowCount = 0;
    for (const table of tables) {
        rowCount += Math.max(0, Math.floor(table.rowCount));
    }
    if (rowCount === 0) {
        return undefined;
    }
    const rowLimit = normalizeRowLimit(maxRows);
    const columnCount = columns.length;
    return {
        columns,
        rowCount,
        rows(offset: number, limit: number): string[][] {
            const start = clampRowOffset(offset, rowCount);
            const requested = normalizeRowLimit(limit);
            let remaining = Math.min(requested, rowLimit, rowCount - start);
            const rows: string[][] = [];
            let tableIndex = 0;
            let localOffset = start;
            while (remaining > 0 && tableIndex < tables.length) {
                const table = tables[tableIndex];
                const tableRows = Math.max(0, Math.floor(table.rowCount));
                if (localOffset >= tableRows) {
                    localOffset -= tableRows;
                    tableIndex++;
                    continue;
                }
                const take = Math.min(remaining, tableRows - localOffset);
                const window = table.rows(localOffset, take);
                for (const row of window) {
                    rows.push(normalizeRow(row, columnCount));
                    remaining--;
                    if (remaining <= 0) {
                        break;
                    }
                }
                if (window.length === 0) {
                    // A malformed block table must not wedge the cross-block page.
                    localOffset = 0;
                    tableIndex++;
                    continue;
                }
                localOffset += window.length;
                if (localOffset >= tableRows) {
                    localOffset = 0;
                    tableIndex++;
                }
            }
            return rows;
        }
    };
}

/**
 * Descriptive statistics for one array merged across every block that
 * carries it. Values use the same component/magnitude selection as
 * `statsForArray`, then go through `computeQuantiles` once over the combined
 * series. Cell arrays additionally sum each block's area integral, so a
 * surface array reports one `total`/`measureTotal` for the whole multiblock.
 *
 * Returns undefined only when no block has the array; an array with no
 * finite values keeps `statsForArray` semantics (NaN quantiles, count 0).
 */
export function dagmcStatsForArray(
    blocks: readonly DagmcBlockModel[],
    association: DatasetAssociation,
    name: string,
    component = -1
): DatasetStats | undefined {
    const chunks: Float64Array[] = [];
    let totalTuples = 0;
    let total: number | undefined;
    let measureTotal: number | undefined;
    for (const block of blocks) {
        const array = findArray(block, association, name);
        if (!array) {
            continue;
        }
        const components = Math.max(1, array.components);
        const tuples = Math.max(0, Math.floor(array.values.length / components));
        const values = new Float64Array(tuples);
        for (let tuple = 0; tuple < tuples; tuple++) {
            values[tuple] = tupleScalar(array.values, components, tuple, component);
        }
        chunks.push(values);
        totalTuples += tuples;
        if (association === 'cell') {
            const blockStats = statsForArray(block, association, name, component);
            if (blockStats?.measure === 'area' && blockStats.total !== undefined && blockStats.measureTotal !== undefined) {
                total = (total ?? 0) + blockStats.total;
                measureTotal = (measureTotal ?? 0) + blockStats.measureTotal;
            }
        }
    }
    if (chunks.length === 0) {
        return undefined;
    }
    const values = new Float64Array(totalTuples);
    let offset = 0;
    for (const chunk of chunks) {
        values.set(chunk, offset);
        offset += chunk.length;
    }
    const stats = computeQuantiles(values);
    if (association === 'cell' && total !== undefined && measureTotal !== undefined) {
        return { ...stats, total, measure: 'area', measureTotal };
    }
    return stats;
}

function findArray(block: DagmcBlockModel, association: DatasetAssociation, name: string): NativeVtkDataArray | undefined {
    const arrays = association === 'point' ? block.pointArrays : block.cellArrays;
    return arrays.find((array) => array.name === name);
}

function unionBounds(current: DatasetBounds | undefined, next: DatasetBounds | undefined): DatasetBounds | undefined {
    if (!next) {
        return current;
    }
    if (!current) {
        return next;
    }
    return {
        min: [Math.min(current.min[0], next.min[0]), Math.min(current.min[1], next.min[1]), Math.min(current.min[2], next.min[2])],
        max: [Math.max(current.max[0], next.max[0]), Math.max(current.max[1], next.max[1]), Math.max(current.max[2], next.max[2])]
    };
}

function unionRange(current: readonly [number, number], next: readonly [number, number]): [number, number] {
    return [Math.min(current[0], next[0]), Math.max(current[1], next[1])];
}

function compareArrayInfo(a: DatasetArrayInfo, b: DatasetArrayInfo): number {
    if (a.association !== b.association) {
        return a.association === 'point' ? -1 : 1;
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Fit a block table row onto the declared column schema (pad short rows, trim long ones). */
function normalizeRow(row: readonly string[], columnCount: number): string[] {
    if (row.length === columnCount) {
        return [...row];
    }
    if (row.length > columnCount) {
        return row.slice(0, columnCount);
    }
    const padded = [...row];
    while (padded.length < columnCount) {
        padded.push('');
    }
    return padded;
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
