// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
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

import { describe, it, expect } from 'vitest';
import {
    bboxSize,
    buildSolidSummaries,
    compareSolidRows,
    countTriangles,
    formatQuantity,
    formatSi,
    formatVec3,
    MISSING_VALUE,
    SolidTableRow
} from './solid-summaries';

function makeRow(
    solidId: number,
    label: string,
    data?: { volume?: number; area?: number; faceCount?: number; triangleCount?: number }
): SolidTableRow {
    return {
        solidId,
        label,
        summary: data
            ? {
                  solidId,
                  faceCount: data.faceCount ?? 0,
                  edgeCount: 0,
                  triangleCount: data.triangleCount ?? 0,
                  properties: { volume: data.volume, area: data.area }
              }
            : undefined
    };
}

describe('solid-summaries', () => {
    describe('countTriangles', () => {
        it('returns 0 without faces', () => {
            expect(countTriangles(undefined)).toBe(0);
            expect(countTriangles([])).toBe(0);
        });

        it('sums the index-triple count over all faces', () => {
            const faces = [
                {
                    triangles: [
                        [0, 1, 2],
                        [0, 2, 3]
                    ]
                },
                { triangles: [[4, 5, 6]] },
                {},
                { triangles: undefined }
            ];
            expect(countTriangles(faces)).toBe(3);
        });
    });

    describe('buildSolidSummaries', () => {
        it('returns an empty list without solids', () => {
            expect(buildSolidSummaries(undefined)).toEqual([]);
            expect(buildSolidSummaries([])).toEqual([]);
        });

        it('extracts counts and passes properties through', () => {
            const properties = { volume: 8, area: 24, centerOfMass: [1, 2, 3] };
            const solids = [
                {
                    solidId: 2,
                    bodyId: 'body-b',
                    faces: [
                        { triangles: [[0, 1, 2]] },
                        {
                            triangles: [
                                [0, 1, 2],
                                [0, 2, 3]
                            ]
                        }
                    ],
                    edges: [{ points: [] }, { points: [] }, { points: [] }],
                    properties
                }
            ];
            expect(buildSolidSummaries(solids)).toEqual([
                {
                    solidId: 2,
                    bodyId: 'body-b',
                    faceCount: 2,
                    edgeCount: 3,
                    triangleCount: 3,
                    properties
                }
            ]);
        });

        it('tolerates solids without faces or edges', () => {
            expect(buildSolidSummaries([{ solidId: 1 }])).toEqual([
                {
                    solidId: 1,
                    bodyId: undefined,
                    faceCount: 0,
                    edgeCount: 0,
                    triangleCount: 0,
                    properties: undefined
                }
            ]);
        });
    });

    describe('formatSi', () => {
        it('renders the placeholder for missing or non-finite values', () => {
            expect(formatSi(undefined)).toBe(MISSING_VALUE);
            expect(formatSi(null)).toBe(MISSING_VALUE);
            expect(formatSi(Number.NaN)).toBe(MISSING_VALUE);
            expect(formatSi(Number.POSITIVE_INFINITY)).toBe(MISSING_VALUE);
        });

        it('keeps plain magnitudes readable', () => {
            expect(formatSi(0)).toBe('0');
            expect(formatSi(42)).toBe('42');
            expect(formatSi(250)).toBe('250');
            expect(formatSi(123456)).toBe('123k');
        });

        it('applies large SI prefixes', () => {
            expect(formatSi(1234.5)).toBe('1.23k');
            expect(formatSi(-2700)).toBe('-2.7k');
            expect(formatSi(2.5e6)).toBe('2.5M');
            expect(formatSi(1e9)).toBe('1G');
            expect(formatSi(1e12)).toBe('1T');
        });

        it('applies small SI prefixes', () => {
            expect(formatSi(0.0125)).toBe('12.5m');
            expect(formatSi(-0.05)).toBe('-50m');
            expect(formatSi(3.3e-7)).toBe('330n');
            expect(formatSi(2e-9)).toBe('2n');
            expect(formatSi(1e-10)).toBe('1.00e-10');
        });
    });

    describe('formatQuantity', () => {
        it('appends the model-unit suffix', () => {
            expect(formatQuantity(1234.5, 'u³')).toBe('1.23k u³');
            expect(formatQuantity(250, 'u²')).toBe('250 u²');
            expect(formatQuantity(0.0125, 'u')).toBe('12.5m u');
        });

        it('renders the placeholder without a unit for missing values', () => {
            expect(formatQuantity(undefined, 'u³')).toBe(MISSING_VALUE);
        });
    });

    describe('formatVec3', () => {
        it('joins formatted components', () => {
            expect(formatVec3([1, 2000, 0.5])).toBe('1, 2k, 500m');
            expect(formatVec3([1, 2000, 0.5], 'u')).toBe('1, 2k, 500m u');
        });

        it('renders the placeholder for malformed vectors', () => {
            expect(formatVec3(undefined)).toBe(MISSING_VALUE);
            expect(formatVec3([1, 2])).toBe(MISSING_VALUE);
            expect(formatVec3([1, Number.NaN, 3])).toBe(MISSING_VALUE);
        });
    });

    describe('bboxSize', () => {
        it('computes the dx/dy/dz extent', () => {
            expect(bboxSize({ bbox: { min: [0, -1, 2], max: [2, 3, 2] } })).toEqual([2, 4, 0]);
        });

        it('returns undefined without bbox data', () => {
            expect(bboxSize(undefined)).toBeUndefined();
            expect(bboxSize({})).toBeUndefined();
            expect(bboxSize({ bbox: { min: [0, 0], max: [1, 1, 1] } })).toBeUndefined();
        });
    });

    describe('compareSolidRows', () => {
        it('sorts numeric keys ascending and descending', () => {
            const rows = [makeRow(1, 'a', { volume: 10 }), makeRow(2, 'b', { volume: 5 })];
            const sorted = [...rows].sort((x, y) => compareSolidRows(x, y, 'volume', false));
            expect(sorted.map((r) => r.solidId)).toEqual([2, 1]);
            const reversed = [...rows].sort((x, y) => compareSolidRows(x, y, 'volume', true));
            expect(reversed.map((r) => r.solidId)).toEqual([1, 2]);
        });

        it('always places missing numeric data last', () => {
            const withData = makeRow(1, 'a', { triangleCount: 10 });
            const noData = makeRow(2, 'b');
            expect([noData, withData].sort((x, y) => compareSolidRows(x, y, 'triangleCount', false))[0]).toBe(withData);
            expect([noData, withData].sort((x, y) => compareSolidRows(x, y, 'triangleCount', true))[0]).toBe(withData);
        });

        it('breaks ties by solid id', () => {
            const rows = [makeRow(3, 'c'), makeRow(1, 'a')];
            const sorted = [...rows].sort((x, y) => compareSolidRows(x, y, 'area', false));
            expect(sorted.map((r) => r.solidId)).toEqual([1, 3]);
        });

        it('compares labels lexically', () => {
            const rows = [makeRow(1, 'banana'), makeRow(2, 'apple')];
            const sorted = [...rows].sort((x, y) => compareSolidRows(x, y, 'label', false));
            expect(sorted.map((r) => r.label)).toEqual(['apple', 'banana']);
            const reversed = [...rows].sort((x, y) => compareSolidRows(x, y, 'label', true));
            expect(reversed.map((r) => r.label)).toEqual(['banana', 'apple']);
        });
    });
});
