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
 * Tests for the DAGMC dataset aggregation (no Theia, DOM, or three.js):
 * combined summary counts/bounds/array catalogue, cross-block table paging
 * (including mismatched column schemas), and merged statistics/integrals.
 */

import { describe, expect, it } from 'vitest';
import type { NativeVtkDataArray } from '../native-vtk/native-vtk-data';
import type { DagmcBlockModel } from './dagmc-multiblock';
import { dagmcStatsForArray, dagmcTableForArray, summarizeDagmcBlocks } from './dagmc-dataset';

function dataArray(
    name: string,
    association: 'point' | 'cell',
    values: readonly number[],
    components = 1,
    range: [number, number] = [0, 0]
): NativeVtkDataArray {
    return { name, association, components, values: new Float64Array(values), range };
}

function dagmcBlock(overrides: Partial<DagmcBlockModel> = {}): DagmcBlockModel {
    return {
        family: 'polydata',
        nPoints: 0,
        positions: new Float32Array(0),
        pointArrays: [],
        cellArrays: [],
        blockName: 'Volume_1',
        blockIndex: 0,
        sourceFile: 'volume_1.vtu',
        nonTriangleCells: 0,
        skippedArrays: [],
        ...overrides
    };
}

/**
 * First block: one triangle (area 4.5), 3 points, a scalar point array, a
 * two-component point array, and two one-value cell arrays.
 */
function firstBlock(): DagmcBlockModel {
    return dagmcBlock({
        blockName: 'Volume_1',
        blockIndex: 0,
        sourceFile: 'volume_1.vtu',
        nPoints: 3,
        positions: new Float32Array([0, 0, 0, 3, 0, 0, 0, 3, 0]),
        triangles: new Uint32Array([0, 1, 2]),
        triangleCells: new Uint32Array([0]),
        pointArrays: [
            dataArray('temperature', 'point', [10, 20, 30], 1, [10, 30]),
            dataArray('offset', 'point', [1, 2, 3, 4, 5, 6], 2, [1, 6])
        ],
        cellArrays: [dataArray('volume_id', 'cell', [0], 1, [0, 0]), dataArray('material_id', 'cell', [7], 1, [7, 7])]
    });
}

/**
 * Second block: two triangles (area 4.5 each, centroids (3,1,0) and (3,0,1)),
 * 4 points, the shared scalar/vector point arrays, an extra scalar array, and
 * a two-value `volume_id` cell array.
 */
function secondBlock(): DagmcBlockModel {
    return dagmcBlock({
        blockName: 'Volume_2',
        blockIndex: 1,
        sourceFile: 'volume_2.vtu',
        nPoints: 4,
        positions: new Float32Array([2, 0, 0, 5, 0, 0, 2, 3, 0, 2, 0, 3]),
        triangles: new Uint32Array([0, 1, 2, 0, 1, 3]),
        triangleCells: new Uint32Array([0, 1]),
        pointArrays: [
            dataArray('temperature', 'point', [40, 50, 60, 70], 1, [40, 70]),
            dataArray('offset', 'point', [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18], 3, [7, 18]),
            dataArray('density', 'point', [0.5, 1.5, 2.5, 3.5], 1, [0.5, 3.5])
        ],
        cellArrays: [dataArray('volume_id', 'cell', [1, 1], 1, [1, 1])]
    });
}

function blocks(): DagmcBlockModel[] {
    return [firstBlock(), secondBlock()];
}

describe('summarizeDagmcBlocks', () => {
    it('aggregates counts, bounds, and shared arrays across both blocks', () => {
        const summary = summarizeDagmcBlocks(blocks());
        expect(summary).toBeDefined();
        expect(summary?.kind).toBe('polydata');
        expect(summary?.nPoints).toBe(7);
        expect(summary?.nCells).toBe(3);
        expect(summary?.bounds).toEqual({ min: [0, 0, 0], max: [5, 3, 3] });
        expect(summary?.arrays).toEqual([
            { name: 'density', association: 'point', components: 1, range: [0.5, 3.5], tupleCount: 4 },
            { name: 'offset', association: 'point', components: 2, range: [1, 18], tupleCount: 7 },
            { name: 'temperature', association: 'point', components: 1, range: [10, 70], tupleCount: 7 },
            { name: 'material_id', association: 'cell', components: 1, range: [7, 7], tupleCount: 1 },
            { name: 'volume_id', association: 'cell', components: 1, range: [0, 1], tupleCount: 3 }
        ]);
    });

    it('keeps the first block schema when component counts disagree', () => {
        const summary = summarizeDagmcBlocks(blocks());
        const offset = summary?.arrays.find((array) => array.name === 'offset');
        expect(offset?.components).toBe(2);
        expect(offset?.tupleCount).toBe(7);
        expect(offset?.range).toEqual([1, 18]);
        expect(summary?.arrays.filter((array) => array.name === 'offset')).toHaveLength(1);
    });

    it('returns undefined for an empty block list', () => {
        expect(summarizeDagmcBlocks([])).toBeUndefined();
    });
});

describe('dagmcTableForArray', () => {
    it('pages point rows across both blocks with coordinates', () => {
        const table = dagmcTableForArray(blocks(), 'point', 'temperature');
        expect(table?.columns).toEqual(['x', 'y', 'z', 'temperature']);
        expect(table?.rowCount).toBe(7);
        expect(table?.rows(0, 10)).toEqual([
            ['0', '0', '0', '10'],
            ['3', '0', '0', '20'],
            ['0', '3', '0', '30'],
            ['2', '0', '0', '40'],
            ['5', '0', '0', '50'],
            ['2', '3', '0', '60'],
            ['2', '0', '3', '70']
        ]);
        expect(table?.rows(2, 3)).toEqual([
            ['0', '3', '0', '30'],
            ['2', '0', '0', '40'],
            ['5', '0', '0', '50']
        ]);
    });

    it('pages cell rows across the block boundary with cell centroids', () => {
        const table = dagmcTableForArray(blocks(), 'cell', 'volume_id');
        expect(table?.columns).toEqual(['x', 'y', 'z', 'volume_id']);
        expect(table?.rowCount).toBe(3);
        expect(table?.rows(0, 10)).toEqual([
            ['1', '1', '0', '0'],
            ['3', '1', '0', '1'],
            ['3', '0', '1', '1']
        ]);
        expect(table?.rows(0, 2)).toEqual([
            ['1', '1', '0', '0'],
            ['3', '1', '0', '1']
        ]);
        expect(table?.rows(1, 2)).toEqual([
            ['3', '1', '0', '1'],
            ['3', '0', '1', '1']
        ]);
    });

    it('honors the row cap and clamps offsets', () => {
        const table = dagmcTableForArray(blocks(), 'point', 'temperature', 4);
        expect(table?.rowCount).toBe(7);
        expect(table?.rows(0, 100)).toHaveLength(4);
        expect(table?.rows(1, 100)).toHaveLength(4);
        expect(table?.rows(5, 100)).toHaveLength(2);
        expect(table?.rows(7, 100)).toEqual([]);
        expect(table?.rows(-3, 1)).toHaveLength(1);
        expect(table?.rows(0, -1)).toEqual([]);
    });

    it('trims later rows to the first block column schema', () => {
        const table = dagmcTableForArray(blocks(), 'point', 'offset');
        expect(table?.columns).toEqual(['x', 'y', 'z', 'offset[0]', 'offset[1]']);
        expect(table?.rowCount).toBe(7);
        const rows = table?.rows(0, 10) ?? [];
        expect(rows).toHaveLength(7);
        expect(rows.every((row) => row.length === 5)).toBe(true);
        expect(rows[3]).toEqual(['2', '0', '0', '7', '8']);
    });

    it('returns undefined for missing arrays and empty tables', () => {
        expect(dagmcTableForArray(blocks(), 'point', 'missing')).toBeUndefined();
        expect(dagmcTableForArray(blocks(), 'cell', 'temperature')).toBeUndefined();
        expect(dagmcTableForArray([], 'point', 'temperature')).toBeUndefined();
        const empty = dagmcBlock({ pointArrays: [dataArray('empty', 'point', [], 1, [0, 0])] });
        expect(dagmcTableForArray([empty], 'point', 'empty')).toBeUndefined();
    });
});

describe('dagmcStatsForArray', () => {
    it('merges point values across blocks into one quantile summary', () => {
        const stats = dagmcStatsForArray(blocks(), 'point', 'temperature');
        expect(stats).toBeDefined();
        expect(stats?.count).toBe(7);
        expect(stats?.min).toBe(10);
        expect(stats?.q1).toBeCloseTo(25, 12);
        expect(stats?.median).toBeCloseTo(40, 12);
        expect(stats?.q3).toBeCloseTo(55, 12);
        expect(stats?.max).toBe(70);
        expect(stats?.mean).toBeCloseTo(40, 12);
        expect(stats?.std).toBeCloseTo(20, 12);
        expect(stats?.total).toBeUndefined();
        expect(stats?.measure).toBeUndefined();
    });

    it('selects one component across every block', () => {
        const stats = dagmcStatsForArray(blocks(), 'point', 'offset', 1);
        expect(stats?.count).toBe(7);
        expect(stats?.min).toBe(2);
        expect(stats?.max).toBe(17);
        expect(stats?.mean).toBeCloseTo(62 / 7, 12);
    });

    it('sums cell area totals over blocks with triangle geometry', () => {
        const stats = dagmcStatsForArray(blocks(), 'cell', 'volume_id');
        expect(stats?.count).toBe(3);
        expect(stats?.min).toBe(0);
        expect(stats?.q1).toBeCloseTo(0.5, 12);
        expect(stats?.median).toBe(1);
        expect(stats?.max).toBe(1);
        expect(stats?.measure).toBe('area');
        expect(stats?.measureTotal).toBeCloseTo(13.5, 12);
        expect(stats?.total).toBeCloseTo(9, 12);
    });

    it('returns undefined for missing arrays and keeps empty-array NaN semantics', () => {
        expect(dagmcStatsForArray(blocks(), 'cell', 'missing')).toBeUndefined();
        expect(dagmcStatsForArray([], 'point', 'temperature')).toBeUndefined();
        const empty = dagmcBlock({ pointArrays: [dataArray('empty', 'point', [], 1, [0, 0])] });
        const stats = dagmcStatsForArray([empty], 'point', 'empty');
        expect(stats?.count).toBe(0);
        expect(Number.isNaN(stats?.min)).toBe(true);
        expect(Number.isNaN(stats?.mean)).toBe(true);
    });
});
