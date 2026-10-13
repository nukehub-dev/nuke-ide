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
import { BOM_CSV_HEADER, buildBomCsvRows, compareParamRows, describeParamUsage, formatBomCsv, type BomSourceModel } from './param-table';
import type { ParameterUsage } from '../../document/cad-document-store';
import type { SolidSummary } from '../../state/nuke-cad-state-manager';

function usage(name: string, value: number, usedByCount: number): ParameterUsage {
    return {
        name,
        value,
        usedBy: Array.from({ length: usedByCount }, (_, i) => ({ kind: 'sketch', id: `sk${i}`, label: `sk${i}`, detail: 'x' }))
    };
}

function summary(solidId: number, volume?: number, bodyId?: string): SolidSummary {
    return {
        solidId,
        bodyId,
        faceCount: 6,
        edgeCount: 12,
        triangleCount: 12,
        properties: volume === undefined ? undefined : { volume, area: 6 }
    };
}

describe('compareParamRows', () => {
    it('sorts by name with locale order', () => {
        const rows = [usage('width', 1, 0), usage('depth', 2, 0), usage('height', 3, 0)];
        expect([...rows].sort((a, b) => compareParamRows(a, b, 'name', false)).map((r) => r.name)).toEqual(['depth', 'height', 'width']);
    });

    it('sorts by value numerically, breaking ties by name', () => {
        const rows = [usage('b', 10, 0), usage('a', 10, 0), usage('c', 5, 0)];
        expect([...rows].sort((a, b) => compareParamRows(a, b, 'value', false)).map((r) => r.name)).toEqual(['c', 'a', 'b']);
    });

    it('sorts by used-by count, breaking ties by name, and reverses when descending', () => {
        const rows = [usage('b', 1, 0), usage('a', 1, 2), usage('c', 1, 1)];
        expect([...rows].sort((a, b) => compareParamRows(a, b, 'usedBy', false)).map((r) => r.name)).toEqual(['b', 'c', 'a']);
        expect([...rows].sort((a, b) => compareParamRows(a, b, 'usedBy', true)).map((r) => r.name)).toEqual(['a', 'c', 'b']);
        expect([...rows].sort((a, b) => compareParamRows(a, b, 'name', true)).map((r) => r.name)).toEqual(['c', 'b', 'a']);
    });
});

describe('describeParamUsage', () => {
    it('covers the unreferenced and referenced cases', () => {
        expect(describeParamUsage(usage('a', 1, 0))).toContain('Not referenced');
        expect(describeParamUsage(usage('a', 1, 1))).toContain("sketch 'sk0'");
    });
});

describe('buildBomCsvRows', () => {
    const source: BomSourceModel = {
        volumes: [
            { selector: 'fuel', name: 'Fuel', material: 'UO2' },
            { selector: 'clad', name: 'Clad', material: 'Zr' }
        ],
        selectorMap: { fuel: [1], clad: [2] }
    };

    it('joins manifest labels/materials with summary volumes', () => {
        const rows = buildBomCsvRows(source, [summary(1, 100), summary(2, 50)], new Map());
        expect(rows).toEqual([
            { instance: 'fuel', label: 'Fuel', material: 'UO2', volume: '100' },
            { instance: 'clad', label: 'Clad', material: 'Zr', volume: '50' }
        ]);
    });

    it('prefers manifest material but falls back to the in-CAD body tag', () => {
        const untagged: BomSourceModel = { volumes: [{ selector: 'fuel', name: 'Fuel' }], selectorMap: { fuel: [1] } };
        const rows = buildBomCsvRows(untagged, [summary(1, 100)], new Map([['fuel', 'UO2']]));
        expect(rows[0].material).toBe('UO2');
    });

    it('leaves volume empty when the payload omits it', () => {
        const rows = buildBomCsvRows(source, [summary(1)], new Map());
        expect(rows[0].volume).toBe('');
    });

    it('falls back to positional rows without a manifest', () => {
        const rows = buildBomCsvRows(undefined, [summary(2, 50), summary(1, 100)], new Map());
        expect(rows).toEqual([
            { instance: 'mat_1', label: 'mat_1', material: '', volume: '100' },
            { instance: 'mat_2', label: 'mat_2', material: '', volume: '50' }
        ]);
    });

    it('keeps assembly instance selector keys verbatim', () => {
        const assembly: BomSourceModel = {
            volumes: [{ selector: 'inst-1/fuel', name: 'Fuel', material: 'UO2' }],
            selectorMap: { 'inst-1/fuel': [3] }
        };
        const rows = buildBomCsvRows(assembly, [summary(3, 7, 'body-1')], new Map());
        expect(rows).toEqual([{ instance: 'inst-1/fuel', label: 'Fuel', material: 'UO2', volume: '7' }]);
    });
});

describe('formatBomCsv', () => {
    it('emits the header plus one line per row, LF-terminated', () => {
        const csv = formatBomCsv([{ instance: 'fuel', label: 'Fuel', material: 'UO2', volume: '100' }]);
        expect(csv).toBe(`${BOM_CSV_HEADER}\nfuel,Fuel,UO2,100\n`);
    });

    it('quotes cells containing commas, quotes, or newlines', () => {
        const csv = formatBomCsv([{ instance: 'a,b', label: 'say "hi"', material: 'x\ny', volume: '' }]);
        expect(csv).toBe(`${BOM_CSV_HEADER}\n"a,b","say ""hi""","x\ny",\n`);
    });

    it('emits a header-only file for no rows', () => {
        expect(formatBomCsv([])).toBe(`${BOM_CSV_HEADER}\n`);
    });
});
