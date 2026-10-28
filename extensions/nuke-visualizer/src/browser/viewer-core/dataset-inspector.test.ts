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
 * Tests for the dataset inspector core (no DOM, no three.js): summary counts
 * and bounds, point/cell table columns and coordinate sources, missing
 * arrays, the maxRows budget, value formatting, and CSV export.
 */

import { describe, expect, it } from 'vitest';
import type { NativeVtkDataArray, NativeVtkDatasetFamily, NativeVtkModel } from '../plugins/openmc/widgets/native-vtk/native-vtk-data';
import {
    DEFAULT_DATASET_TABLE_ROWS,
    DatasetTable,
    formatDatasetNumber,
    statsForArray,
    summarizeNativeModel,
    tableForArray,
    tableToCsv
} from './dataset-inspector';

function nativeModel(family: NativeVtkDatasetFamily, overrides: Partial<NativeVtkModel> = {}): NativeVtkModel {
    return {
        family,
        nPoints: 0,
        positions: new Float32Array(0),
        pointArrays: [],
        cellArrays: [],
        ...overrides
    };
}

function dataArray(
    name: string,
    association: 'point' | 'cell',
    values: readonly number[],
    components = 1,
    range: [number, number] = [0, 0]
): NativeVtkDataArray {
    return { name, association, components, values: new Float64Array(values), range };
}

/** Four-point square (0,0,0)-(1,2,3) with one point and one cell array. */
function squareModel(): NativeVtkModel {
    return nativeModel('polydata', {
        nPoints: 4,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3]),
        pointArrays: [dataArray('scalar', 'point', [1, 2, 3, 4], 1, [1, 4])],
        cellArrays: [dataArray('cellid', 'cell', [7, 8], 1, [7, 8])],
        segments: new Uint32Array([0, 1, 1, 2]),
        segmentCells: new Uint32Array([0, 1])
    });
}

function rectilinearModel(): NativeVtkModel {
    return nativeModel('rectilinear', {
        nPoints: 6,
        positions: new Float32Array([0.5, 0.5, 0, 1.5, 0.5, 0, 2.5, 0.5, 0, 0.5, 1.5, 0, 1.5, 1.5, 0, 2.5, 1.5, 0]),
        gridDimensions: [3, 2, 1],
        gridAxes: [new Float64Array([0, 1, 2, 3]), new Float64Array([0, 1, 2]), new Float64Array([0, 1])],
        cellArrays: [dataArray('flux', 'cell', [1, 2, 3, 4, 5, 6], 1, [1, 6])]
    });
}

describe('summarizeNativeModel', () => {
    it('summarizes a polydata model with counts, bounds, and array metadata', () => {
        const summary = summarizeNativeModel(squareModel());
        expect(summary.kind).toBe('polydata');
        expect(summary.nPoints).toBe(4);
        expect(summary.nCells).toBe(2);
        expect(summary.bounds).toEqual({ min: [0, 0, 0], max: [1, 2, 3] });
        expect(summary.arrays).toEqual([
            { name: 'scalar', association: 'point', components: 1, range: [1, 4], tupleCount: 4 },
            { name: 'cellid', association: 'cell', components: 1, range: [7, 8], tupleCount: 2 }
        ]);
    });

    it('derives grid point counts from nodal axes and cell counts from the model', () => {
        const summary = summarizeNativeModel(rectilinearModel());
        expect(summary.kind).toBe('rectilinear');
        expect(summary.nPoints).toBe(24);
        expect(summary.nCells).toBe(6);
        expect(summary.bounds).toEqual({ min: [0.5, 0.5, 0], max: [2.5, 1.5, 0] });
        expect(summary.arrays).toEqual([{ name: 'flux', association: 'cell', components: 1, range: [1, 6], tupleCount: 6 }]);
    });

    it('computes bounds from positions instead of grid dimensions', () => {
        const model = nativeModel('image', {
            nPoints: 1,
            positions: new Float32Array([-1, -2, -3]),
            // Cell counts, not extents: using these as bounds would give 100^3.
            gridDimensions: [100, 100, 100],
            gridAxes: [new Float64Array([-1, 1]), new Float64Array([-2, 2]), new Float64Array([-3, 3])]
        });
        const summary = summarizeNativeModel(model);
        expect(summary.kind).toBe('image');
        expect(summary.nCells).toBe(1);
        expect(summary.nPoints).toBe(8);
        expect(summary.bounds).toEqual({ min: [-1, -2, -3], max: [-1, -2, -3] });
    });

    it('reports no bounds for an empty position buffer', () => {
        const summary = summarizeNativeModel(nativeModel('polydata'));
        expect(summary.bounds).toBeUndefined();
        expect(summary.nPoints).toBe(0);
        expect(summary.nCells).toBe(0);
        expect(summary.arrays).toEqual([]);
    });

    it('counts polydata cells from connectivity when there is no cell data', () => {
        const lines = nativeModel('polydata', {
            nPoints: 4,
            positions: new Float32Array(12),
            segments: new Uint32Array([0, 1, 1, 2, 2, 3]),
            segmentCells: new Uint32Array([0, 1, 2])
        });
        expect(summarizeNativeModel(lines).nCells).toBe(3);

        const clouds = nativeModel('polydata', {
            nPoints: 3,
            positions: new Float32Array(9),
            vertices: new Uint32Array([0, 1, 2])
        });
        expect(summarizeNativeModel(clouds).nCells).toBe(3);
    });

    it('falls back to point-array tuples for grids without boundary axes (.vts)', () => {
        const model = nativeModel('rectilinear', {
            nPoints: 2,
            positions: new Float32Array([0, 0, 0, 1, 1, 1]),
            pointArrays: [dataArray('u', 'point', [1, 2, 3, 4], 1, [1, 4])]
        });
        const summary = summarizeNativeModel(model);
        expect(summary.nPoints).toBe(4);
        expect(summary.nCells).toBe(2);
    });
});

describe('tableForArray', () => {
    it('prepends point coordinates to point-data tables', () => {
        const model = nativeModel('polydata', {
            nPoints: 3,
            positions: new Float32Array([0, 0, 0, 1, 2, 3, 10, -1, 0.5]),
            pointArrays: [dataArray('temp', 'point', [1, 2.5, -3], 1, [-3, 2.5])]
        });
        const table = tableForArray(model, 'point', 'temp');
        expect(table).toBeDefined();
        expect(table?.columns).toEqual(['x', 'y', 'z', 'temp']);
        expect(table?.rowCount).toBe(3);
        expect(table?.rows(0, 10)).toEqual([
            ['0', '0', '0', '1'],
            ['1', '2', '3', '2.5'],
            ['10', '-1', '0.5', '-3']
        ]);
    });

    it('expands multi-component arrays into one column per component', () => {
        const model = nativeModel('polydata', {
            nPoints: 2,
            positions: new Float32Array([0, 0, 0, 1, 1, 1]),
            pointArrays: [dataArray('disp', 'point', [1, 2, 3, 4, 5, 6], 3, [3.7416573867739413, 8.774964387392123])]
        });
        const table = tableForArray(model, 'point', 'disp');
        expect(table?.columns).toEqual(['x', 'y', 'z', 'disp[0]', 'disp[1]', 'disp[2]']);
        expect(table?.rowCount).toBe(2);
        expect(table?.rows(0, 10)).toEqual([
            ['0', '0', '0', '1', '2', '3'],
            ['1', '1', '1', '4', '5', '6']
        ]);
    });

    it('uses nodal grid coordinates for grid point tables', () => {
        const model = nativeModel('image', {
            nPoints: 8,
            positions: new Float32Array(24),
            gridDimensions: [2, 2, 2],
            gridAxes: [new Float64Array([0, 10]), new Float64Array([0, 20]), new Float64Array([0, 30])],
            pointArrays: [dataArray('rho', 'point', [0, 1, 2, 3, 4, 5, 6, 7], 1, [0, 7])]
        });
        const table = tableForArray(model, 'point', 'rho');
        expect(table?.columns).toEqual(['x', 'y', 'z', 'rho']);
        expect(table?.rowCount).toBe(8);
        expect(table?.rows(0, 2)).toEqual([
            ['0', '0', '0', '0'],
            ['10', '0', '0', '1']
        ]);
        expect(table?.rows(4, 2)).toEqual([
            ['0', '0', '30', '4'],
            ['10', '0', '30', '5']
        ]);
    });

    it('uses stored cell centers for grid cell tables', () => {
        const table = tableForArray(rectilinearModel(), 'cell', 'flux');
        expect(table?.columns).toEqual(['x', 'y', 'z', 'flux']);
        expect(table?.rowCount).toBe(6);
        expect(table?.rows(0, 2)).toEqual([
            ['0.5', '0.5', '0', '1'],
            ['1.5', '0.5', '0', '2']
        ]);
    });

    it('computes polydata cell centroids from triangles', () => {
        const model = nativeModel('polydata', {
            nPoints: 4,
            positions: new Float32Array([0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0, 3]),
            triangles: new Uint32Array([0, 1, 2]),
            triangleCells: new Uint32Array([0]),
            cellArrays: [dataArray('value', 'cell', [5], 1, [5, 5])]
        });
        const table = tableForArray(model, 'cell', 'value');
        expect(table?.columns).toEqual(['x', 'y', 'z', 'value']);
        expect(table?.rows(0, 1)).toEqual([['1', '1', '0', '5']]);
    });

    it('computes line-cell and vertex-cell centers from connectivity', () => {
        const lines = nativeModel('polydata', {
            nPoints: 3,
            positions: new Float32Array([0, 0, 0, 2, 0, 0, 4, 0, 0]),
            segments: new Uint32Array([0, 1, 1, 2]),
            segmentCells: new Uint32Array([0, 1]),
            cellArrays: [dataArray('id', 'cell', [10, 20], 1, [10, 20])]
        });
        expect(tableForArray(lines, 'cell', 'id')?.rows(0, 2)).toEqual([
            ['1', '0', '0', '10'],
            ['3', '0', '0', '20']
        ]);

        const clouds = nativeModel('polydata', {
            nPoints: 2,
            positions: new Float32Array([5, 6, 7, -1, -2, -3]),
            vertices: new Uint32Array([0, 1]),
            cellArrays: [dataArray('id', 'cell', [1, 2], 1, [1, 2])]
        });
        expect(tableForArray(clouds, 'cell', 'id')?.rows(0, 2)).toEqual([
            ['5', '6', '7', '1'],
            ['-1', '-2', '-3', '2']
        ]);
    });

    it('keeps point coordinates for point data without cell connectivity', () => {
        const model = nativeModel('polydata', {
            nPoints: 2,
            positions: new Float32Array(6),
            pointArrays: [dataArray('scalar', 'point', [1, 2], 1, [1, 2])]
        });
        const table = tableForArray(model, 'point', 'scalar');
        expect(table?.columns).toEqual(['x', 'y', 'z', 'scalar']);
    });

    it('returns undefined for missing arrays and association mismatches', () => {
        const model = squareModel();
        expect(tableForArray(model, 'point', 'missing')).toBeUndefined();
        expect(tableForArray(model, 'cell', 'scalar')).toBeUndefined();
        expect(tableForArray(model, 'point', 'cellid')).toBeUndefined();
    });

    it('caps rows by maxRows while reporting the full row count', () => {
        const model = nativeModel('polydata', {
            nPoints: 5,
            positions: new Float32Array(15),
            pointArrays: [dataArray('v', 'point', [10, 20, 30, 40, 50], 1, [10, 50])]
        });
        const table = tableForArray(model, 'point', 'v', 2);
        expect(table?.rowCount).toBe(5);
        expect(table?.rows(0, 100)).toEqual([
            ['0', '0', '0', '10'],
            ['0', '0', '0', '20']
        ]);
        expect(table?.rows(1, 100)).toEqual([
            ['0', '0', '0', '20'],
            ['0', '0', '0', '30']
        ]);
        expect(table?.rows(4, 100)).toEqual([['0', '0', '0', '50']]);
        expect(table?.rows(5, 100)).toEqual([]);
        expect(table?.rows(-3, 1)).toEqual([['0', '0', '0', '10']]);
        expect(table?.rows(0, -1)).toEqual([]);
    });

    it('renders non-finite values as empty cells and keeps short arrays safe', () => {
        const model = nativeModel('polydata', {
            nPoints: 3,
            positions: new Float32Array(9),
            pointArrays: [dataArray('bad', 'point', [Number.NaN, Number.POSITIVE_INFINITY, 2], 1, [0, 2])]
        });
        const table = tableForArray(model, 'point', 'bad');
        expect(table?.rows(0, 3)).toEqual([
            ['0', '0', '0', ''],
            ['0', '0', '0', ''],
            ['0', '0', '0', '2']
        ]);
    });

    it('defaults to the 200-row inspector window', () => {
        const values = Array.from({ length: DEFAULT_DATASET_TABLE_ROWS + 50 }, (_, index) => index);
        const model = nativeModel('polydata', {
            nPoints: values.length,
            positions: new Float32Array(values.length * 3),
            pointArrays: [dataArray('v', 'point', values, 1, [0, values.length - 1])]
        });
        const table = tableForArray(model, 'point', 'v');
        expect(DEFAULT_DATASET_TABLE_ROWS).toBe(200);
        expect(table?.rowCount).toBe(250);
        expect(table?.rows(0, 10_000)).toHaveLength(200);
        expect(table?.rows(150, 10_000)).toHaveLength(100);
    });
});

describe('tableToCsv', () => {
    it('writes the header and rows with a trailing newline', () => {
        const model = nativeModel('polydata', {
            nPoints: 2,
            positions: new Float32Array([0, 0, 0, 1, 1, 1]),
            pointArrays: [dataArray('temp', 'point', [1.5, 0, 2, 0], 2, [1.5, 2])]
        });
        const table = tableForArray(model, 'point', 'temp');
        expect(tableToCsv(table as DatasetTable)).toBe('x,y,z,temp[0],temp[1]\n0,0,0,1.5,0\n1,1,1,2,0\n');
    });

    it('honors an explicit maxRows argument', () => {
        const model = nativeModel('polydata', {
            nPoints: 5,
            positions: new Float32Array(15),
            pointArrays: [dataArray('v', 'point', [10, 20, 30, 40, 50], 1, [10, 50])]
        });
        const table = tableForArray(model, 'point', 'v', 3);
        expect(tableToCsv(table as DatasetTable, 2)).toBe('x,y,z,v\n0,0,0,10\n0,0,0,20\n');
        expect(tableToCsv(table as DatasetTable, 100)).toBe('x,y,z,v\n0,0,0,10\n0,0,0,20\n0,0,0,30\n');
    });

    it('quotes fields with commas, quotes, and newlines', () => {
        const table: DatasetTable = {
            columns: ['a,b', 'q"x', 'plain'],
            rowCount: 1,
            rows: () => [['1', '2,3', 'line\nbreak']]
        };
        expect(tableToCsv(table)).toBe('"a,b","q""x",plain\n1,"2,3","line\nbreak"\n');
    });

    it('returns an empty string for a table without columns', () => {
        const table: DatasetTable = { columns: [], rowCount: 0, rows: () => [] };
        expect(tableToCsv(table)).toBe('');
    });
});

describe('formatDatasetNumber', () => {
    it('trims trailing zeros, normalizes negative zero, and blanks non-finite values', () => {
        expect(formatDatasetNumber(0)).toBe('0');
        expect(formatDatasetNumber(-0)).toBe('0');
        expect(formatDatasetNumber(0.30000000000000004)).toBe('0.3');
        expect(formatDatasetNumber(2.5)).toBe('2.5');
        expect(formatDatasetNumber(123456789)).toBe('123457000');
        expect(formatDatasetNumber(0.0000001)).toBe('1e-7');
        expect(formatDatasetNumber(Number.NaN)).toBe('');
        expect(formatDatasetNumber(Number.NEGATIVE_INFINITY)).toBe('');
    });
});

describe('statsForArray', () => {
    it('describes a grid cell array and integrates over cell volume', () => {
        const stats = statsForArray(rectilinearModel(), 'cell', 'flux');
        expect(stats).toBeDefined();
        expect(stats?.count).toBe(6);
        expect(stats?.mean).toBeCloseTo(3.5, 12);
        expect(stats?.median).toBeCloseTo(3.5, 12);
        expect(stats?.measure).toBe('volume');
        expect(stats?.measureTotal).toBeCloseTo(6, 12);
        expect(stats?.total).toBeCloseTo(21, 12);
    });

    it('integrates a triangle-cell array over surface area', () => {
        const model = nativeModel('polydata', {
            nPoints: 3,
            positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
            triangles: new Uint32Array([0, 1, 2]),
            triangleCells: new Uint32Array([0]),
            cellArrays: [dataArray('value', 'cell', [2], 1, [2, 2])]
        });
        const stats = statsForArray(model, 'cell', 'value');
        expect(stats?.measure).toBe('area');
        expect(stats?.measureTotal).toBeCloseTo(0.5, 12);
        expect(stats?.total).toBeCloseTo(1, 12);
    });

    it('returns undefined for a missing array and omits the integral for point arrays', () => {
        expect(statsForArray(squareModel(), 'cell', 'missing')).toBeUndefined();
        const pointStats = statsForArray(squareModel(), 'point', 'scalar');
        expect(pointStats?.mean).toBeCloseTo(2.5, 12);
        expect(pointStats?.total).toBeUndefined();
    });
});
