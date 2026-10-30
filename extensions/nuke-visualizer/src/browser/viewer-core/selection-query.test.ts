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
 * Tests for the Find Data query core (no DOM, no three.js): the closed
 * grammar AST, every comparison operator, inclusive ranges, id resolution
 * (explicit associations and tuple-index fallback), case-insensitive name
 * containment, AND composition, typed errors for invalid input, NaN/infinity
 * exclusion, empty results, multi-component magnitudes, CSV rendering, and
 * the result summary.
 */

import { describe, expect, it } from 'vitest';
import {
    SelectionQueryError,
    evaluateSelectionQuery,
    formatSelectionNumber,
    formatSelectionSummary,
    parseSelectionQuery,
    selectionToCsv,
    selectionTupleCount,
    type SelectionQuerySource
} from './selection-query';

const VALUES = new Float64Array([0, 1, 2, 3]);

function select(query: string, source: SelectionQuerySource): number[] {
    return Array.from(evaluateSelectionQuery(parseSelectionQuery(query), source).indices);
}

function expectCode(text: string, code: SelectionQueryError['code']): void {
    try {
        parseSelectionQuery(text);
    } catch (error) {
        expect(error).toBeInstanceOf(SelectionQueryError);
        expect(error).toBeInstanceOf(Error);
        expect((error as SelectionQueryError).code).toBe(code);
        return;
    }
    throw new Error(`Expected '${text}' to be rejected`);
}

describe('parseSelectionQuery', () => {
    it('parses a numeric comparison', () => {
        expect(parseSelectionQuery('value >= 1.5')).toEqual({
            text: 'value >= 1.5',
            predicates: [{ kind: 'compare', field: 'value', operator: '>=', value: 1.5 }]
        });
    });

    it('is whitespace tolerant and case-insensitive for fields/keywords', () => {
        expect(parseSelectionQuery('  VALUE>=1.5  ')).toEqual({
            text: 'VALUE>=1.5',
            predicates: [{ kind: 'compare', field: 'value', operator: '>=', value: 1.5 }]
        });
        expect(parseSelectionQuery('ID In [ 0 , 10 ]').predicates).toEqual([{ kind: 'range', field: 'id', min: 0, max: 10 }]);
        expect(parseSelectionQuery('name CONTAINS Fuel').predicates).toEqual([{ kind: 'contains', field: 'name', text: 'Fuel' }]);
    });

    it('parses every comparison operator', () => {
        const operators = ['==', '!=', '<', '<=', '>', '>='] as const;
        for (const operator of operators) {
            const [predicate] = parseSelectionQuery(`value ${operator} -2.5e1`).predicates;
            expect(predicate).toEqual({ kind: 'compare', field: 'value', operator, value: -25 });
        }
    });

    it('parses an inclusive range', () => {
        expect(parseSelectionQuery('value in [0, 10]').predicates).toEqual([{ kind: 'range', field: 'value', min: 0, max: 10 }]);
        expect(parseSelectionQuery('value in [-1.5,2]').predicates).toEqual([{ kind: 'range', field: 'value', min: -1.5, max: 2 }]);
    });

    it('parses AND chains only', () => {
        expect(parseSelectionQuery('value > 0 and value < 3').predicates).toEqual([
            { kind: 'compare', field: 'value', operator: '>', value: 0 },
            { kind: 'compare', field: 'value', operator: '<', value: 3 }
        ]);
        expect(parseSelectionQuery('value > 0 AND name contains fuel').predicates).toEqual([
            { kind: 'compare', field: 'value', operator: '>', value: 0 },
            { kind: 'contains', field: 'name', text: 'fuel' }
        ]);
    });

    it('keeps quoted and unquoted name text verbatim', () => {
        expect(parseSelectionQuery('name contains "fuel pin"').predicates).toEqual([{ kind: 'contains', field: 'name', text: 'fuel pin' }]);
        expect(parseSelectionQuery("name contains 'fuel pin'").predicates).toEqual([{ kind: 'contains', field: 'name', text: 'fuel pin' }]);
        expect(parseSelectionQuery('name contains fuel pin').predicates).toEqual([{ kind: 'contains', field: 'name', text: 'fuel pin' }]);
        expect(parseSelectionQuery('name contains rock and roll').predicates).toEqual([
            { kind: 'contains', field: 'name', text: 'rock and roll' }
        ]);
        expect(parseSelectionQuery('name contains rock and value > 1').predicates).toEqual([
            { kind: 'contains', field: 'name', text: 'rock' },
            { kind: 'compare', field: 'value', operator: '>', value: 1 }
        ]);
    });

    it('rejects empty queries', () => {
        expectCode('', 'empty-query');
        expectCode('   ', 'empty-query');
    });

    it('rejects unknown fields and unsupported operators', () => {
        expectCode('foo == 1', 'unknown-field');
        expectCode('value ~ 1', 'invalid-operator');
        expectCode('value', 'invalid-operator');
        expectCode('value contains fuel', 'invalid-operator');
        expectCode('name >= 3', 'invalid-operator');
        expectCode('name in [1, 2]', 'invalid-operator');
    });

    it('rejects malformed numbers and ranges', () => {
        expectCode('value ==', 'invalid-value');
        expectCode('value == abc', 'invalid-value');
        expectCode('value == NaN', 'invalid-value');
        expectCode('value == Infinity', 'invalid-value');
        expectCode('value == 1.2.3', 'invalid-value');
        expectCode('value == 12abc', 'invalid-value');
        expectCode('value == 0x10', 'invalid-value');
        expectCode('value in [1]', 'syntax');
        expectCode('value in [1, 2', 'syntax');
        expectCode('value in (1, 2)', 'syntax');
        expectCode('value in [1, 2, 3]', 'syntax');
        expectCode('value in [5, 1]', 'invalid-range');
        expectCode('name contains', 'invalid-value');
        expectCode('name contains ""', 'invalid-value');
    });

    it('rejects non-integer ids', () => {
        expectCode('id == 4.5', 'invalid-value');
        expectCode('id in [0, 2.5]', 'invalid-value');
    });

    it('rejects OR, nesting, and missing connectors', () => {
        expectCode('value > 1 or value < 2', 'invalid-connector');
        expectCode('(value > 1)', 'syntax');
        expectCode('value > 1 and', 'syntax');
        expectCode('value > 1 value < 2', 'syntax');
    });
});

describe('evaluateSelectionQuery', () => {
    const source: SelectionQuerySource = { values: VALUES };

    it('applies every comparison operator', () => {
        expect(select('value == 2', source)).toEqual([2]);
        expect(select('value != 2', source)).toEqual([0, 1, 3]);
        expect(select('value < 2', source)).toEqual([0, 1]);
        expect(select('value <= 2', source)).toEqual([0, 1, 2]);
        expect(select('value > 2', source)).toEqual([3]);
        expect(select('value >= 2', source)).toEqual([2, 3]);
    });

    it('includes both range endpoints', () => {
        const result = evaluateSelectionQuery(parseSelectionQuery('value in [1, 2]'), source);
        expect(Array.from(result.indices)).toEqual([1, 2]);
        expect(result.matched).toBe(2);
        expect(result.total).toBe(4);
        expect(select('value in [0, 3]', source)).toEqual([0, 1, 2, 3]);
    });

    it('compares only complete tuples', () => {
        const ragged: SelectionQuerySource = { values: new Float64Array([1, 2]), components: 3 };
        expect(selectionTupleCount(ragged)).toBe(0);
        expect(select('value >= 0', ragged)).toEqual([]);
    });

    it('collapses multi-component tuples to their magnitude (color-by parity)', () => {
        const vectors: SelectionQuerySource = { values: new Float64Array([3, 4, 1, 1]), components: 2 };
        expect(select('value == 5', vectors)).toEqual([0]);
        expect(select('value > 2', vectors)).toEqual([0]);
        expect(select('value < 2', vectors)).toEqual([1]);
    });

    it('resolves ids through associations, else the tuple index', () => {
        const identified: SelectionQuerySource = { values: VALUES, associations: new Float64Array([10, 42, 7, 42]) };
        expect(select('id == 42', identified)).toEqual([1, 3]);
        expect(select('id != 42', identified)).toEqual([0, 2]);
        expect(select('id in [7, 10]', identified)).toEqual([0, 2]);
        // Without ids, `id` means the 0-based row number.
        const rows: SelectionQuerySource = { values: new Float64Array(100) };
        expect(select('id == 42', rows)).toEqual([42]);
    });

    it('matches names case-insensitively', () => {
        const named: SelectionQuerySource = {
            values: new Float64Array([0, 1, 2]),
            names: ['fuel pin', 'cladding', 'Fuel Assembly']
        };
        expect(select('name contains fuel', named)).toEqual([0, 2]);
        expect(select('name contains FUEL', named)).toEqual([0, 2]);
        expect(select('name contains "fuel pin"', named)).toEqual([0]);
        expect(select('name contains pin', named)).toEqual([0]);
    });

    it('never matches tuples without a name', () => {
        const named: SelectionQuerySource = { values: new Float64Array([0, 1, 2]), names: ['fuel'] };
        expect(select('name contains fuel', named)).toEqual([0]);
        expect(select('name contains assembly', named)).toEqual([]);
    });

    it('throws a typed error when the source has no names', () => {
        expect(() => evaluateSelectionQuery(parseSelectionQuery('name contains fuel'), source)).toThrowError(SelectionQueryError);
        try {
            evaluateSelectionQuery(parseSelectionQuery('name contains fuel'), source);
        } catch (error) {
            expect((error as SelectionQueryError).code).toBe('missing-names');
        }
    });

    it('combines predicates with AND', () => {
        expect(select('value >= 1 and value <= 2', source)).toEqual([1, 2]);
        expect(select('value > 1 and value < 3', source)).toEqual([2]);
        const identified: SelectionQuerySource = { values: VALUES, associations: new Float64Array([0, 1, 2, 3]) };
        expect(select('value > 1 and id != 2', identified)).toEqual([3]);
        const named: SelectionQuerySource = { values: VALUES, names: ['zero', 'one', 'two', 'three'] };
        expect(select('value >= 2 and name contains t', named)).toEqual([2, 3]);
    });

    it('excludes NaN and infinities from every predicate, including !=', () => {
        const messy: SelectionQuerySource = {
            values: new Float64Array([Number.NaN, 1, 2, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
        };
        expect(select('value != 0', messy)).toEqual([1, 2]);
        expect(select('value != 99', messy)).toEqual([1, 2]);
        expect(select('value >= 0', messy)).toEqual([1, 2]);
        expect(select('value in [0, 10]', messy)).toEqual([1, 2]);
        expect(select('value < 10', messy)).toEqual([1, 2]);
    });

    it('excludes NaN association ids', () => {
        const identified: SelectionQuerySource = { values: new Float64Array([0, 1]), associations: new Float64Array([Number.NaN, 42]) };
        expect(select('id != 0', identified)).toEqual([1]);
    });

    it('returns an empty typed index set when nothing matches', () => {
        const result = evaluateSelectionQuery(parseSelectionQuery('value > 100'), source);
        expect(result.indices).toBeInstanceOf(Uint32Array);
        expect(result.indices.length).toBe(0);
        expect(result.matched).toBe(0);
        expect(result.total).toBe(4);
    });

    it('handles an empty source', () => {
        const result = evaluateSelectionQuery(parseSelectionQuery('value >= 0'), { values: new Float64Array(0) });
        expect(result).toEqual({ indices: new Uint32Array(0), matched: 0, total: 0 });
    });

    it('reports the full match count to the caller', () => {
        const result = evaluateSelectionQuery(parseSelectionQuery('value >= 0'), source);
        expect(result.matched).toBe(result.total);
        expect(Array.from(result.indices)).toEqual([0, 1, 2, 3]);
    });
});

describe('selectionTupleCount', () => {
    it('divides the flattened length by the component count', () => {
        expect(selectionTupleCount({ values: new Float64Array(9), components: 3 })).toBe(3);
        expect(selectionTupleCount({ values: new Float64Array(9) })).toBe(9);
        expect(selectionTupleCount({ values: new Float64Array(9), components: 0 })).toBe(9);
        expect(selectionTupleCount({ values: new Float64Array(9), components: 2.7 })).toBe(4);
        expect(selectionTupleCount({ values: new Float64Array(0) })).toBe(0);
    });
});

describe('formatSelectionNumber', () => {
    it('formats finite values with six significant digits', () => {
        expect(formatSelectionNumber(0)).toBe('0');
        expect(formatSelectionNumber(-0)).toBe('0');
        expect(formatSelectionNumber(1.23456789)).toBe('1.23457');
        expect(formatSelectionNumber(123456789)).toBe('123457000');
    });

    it('blanks non-finite values', () => {
        expect(formatSelectionNumber(Number.NaN)).toBe('');
        expect(formatSelectionNumber(Number.POSITIVE_INFINITY)).toBe('');
    });
});

describe('formatSelectionSummary', () => {
    it('renders matched/total counts and a percentage', () => {
        expect(formatSelectionSummary({ matched: 1234, total: 10000 })).toBe('1,234 of 10,000 tuples (12.3%)');
        expect(formatSelectionSummary({ matched: 2, total: 3 })).toBe('2 of 3 tuples (66.7%)');
        expect(formatSelectionSummary({ matched: 1, total: 1 })).toBe('1 of 1 tuple (100%)');
        expect(formatSelectionSummary({ matched: 0, total: 4 })).toBe('0 of 4 tuples (0%)');
    });

    it('handles empty sources and clamps a stale match count', () => {
        expect(formatSelectionSummary({ matched: 0, total: 0 })).toBe('0 of 0 tuples');
        expect(formatSelectionSummary({ matched: 5, total: 3 })).toBe('3 of 3 tuples (100%)');
        expect(formatSelectionSummary({ matched: -1, total: 3 })).toBe('0 of 3 tuples (0%)');
    });
});

describe('selectionToCsv', () => {
    it('renders index, value, association, and name columns', () => {
        const source: SelectionQuerySource = {
            values: new Float64Array([10, 20, 30]),
            associations: new Float64Array([100, 200, 300]),
            names: ['alpha', 'beta', 'b,c']
        };
        expect(selectionToCsv(source, new Uint32Array([0, 2]))).toBe('index,value,association,name\n0,10,100,alpha\n2,30,300,"b,c"\n');
    });

    it('omits optional columns when the source lacks them', () => {
        expect(selectionToCsv({ values: new Float64Array([10, 20]) }, new Uint32Array([1]))).toBe('index,value\n1,20\n');
    });

    it('honors column options and row caps', () => {
        const source: SelectionQuerySource = {
            values: new Float64Array([10, 20]),
            associations: new Float64Array([1, 2]),
            names: ['a', 'b']
        };
        expect(selectionToCsv(source, new Uint32Array([0, 1]), { includeIndex: false, includeName: false })).toBe(
            'value,association\n10,1\n20,2\n'
        );
        expect(selectionToCsv(source, new Uint32Array([0, 1]), { maxRows: 1 })).toBe('index,value,association,name\n0,10,1,a\n');
        expect(selectionToCsv(source, new Uint32Array([0]), { valueLabel: 'flux' })).toBe('index,flux,association,name\n0,10,1,a\n');
    });

    it('blanks non-finite cells and skips out-of-range indices', () => {
        const source: SelectionQuerySource = { values: new Float64Array([Number.NaN, 2]) };
        expect(selectionToCsv(source, new Uint32Array([0, 1, 9]))).toBe('index,value\n0,\n1,2\n');
    });

    it('renders only the header for an empty selection', () => {
        expect(selectionToCsv({ values: new Float64Array([1]) }, new Uint32Array(0))).toBe('index,value\n');
    });
});
