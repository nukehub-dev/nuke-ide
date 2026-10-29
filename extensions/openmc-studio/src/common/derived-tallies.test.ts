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

import { describe, expect, it } from 'vitest';
import { OpenMCDerivedExpression, OpenMCDerivedTally, OpenMCTally } from './openmc-state-schema';
import {
    aggregateDerivedBins,
    appendDerivedToken,
    constantExpressionValue,
    DerivedExpressionError,
    estimateDerivedBins,
    evaluateDerivedExpression,
    expressionToTokens,
    formatDerivedExpression,
    parseDerivedFormula,
    removeLastDerivedToken,
    tokensToExpression,
    validateDerivedTally
} from './derived-tallies';

function tally(id: number, scores: string[], overrides: Partial<OpenMCTally> = {}): OpenMCTally {
    return {
        id,
        name: `Tally ${id}`,
        scores,
        nuclides: ['total', 'U235'],
        filters: [],
        ...overrides
    };
}

const flux = tally(1, ['flux']);
const fission = tally(2, ['fission'], { filters: [{ type: 'cell', bins: [1] }] });

describe('derived formula parsing and formatting', () => {
    it('parses operands, scalars, operators, parentheses, and unary negation', () => {
        const parsed = parseDerivedFormula('(T1[flux] + T2[fission:U235]) * -2');
        expect(parsed.error).toBeUndefined();
        expect(parsed.expression).toEqual({
            kind: 'binary',
            op: '*',
            left: {
                kind: 'binary',
                op: '+',
                left: { kind: 'tally', tallyId: 1, score: 'flux' },
                right: { kind: 'tally', tallyId: 2, score: 'fission', nuclide: 'U235' }
            },
            right: { kind: 'unary', op: '-', operand: { kind: 'scalar', value: 2 } }
        } as OpenMCDerivedExpression);
    });

    it('honours operator precedence and preserves it when formatting', () => {
        const parsed = parseDerivedFormula('T1[flux] + T2[fission] * 2');
        expect(parsed.expression).toEqual({
            kind: 'binary',
            op: '+',
            left: { kind: 'tally', tallyId: 1, score: 'flux' },
            right: { kind: 'binary', op: '*', left: { kind: 'tally', tallyId: 2, score: 'fission' }, right: { kind: 'scalar', value: 2 } }
        } as OpenMCDerivedExpression);
        expect(formatDerivedExpression(parsed.expression!)).toBe('T1[flux] + T2[fission] * 2');

        const grouped = parseDerivedFormula('(T1[flux] + T2[fission]) * 2');
        expect(formatDerivedExpression(grouped.expression!)).toBe('(T1[flux] + T2[fission]) * 2');
    });

    it('round-trips subtraction/division grouping without changing the tree', () => {
        const parsed = parseDerivedFormula('T1[flux] - (T2[fission] - 3)');
        const formatted = formatDerivedExpression(parsed.expression!);
        expect(formatted).toBe('T1[flux] - (T2[fission] - 3)');
        expect(parseDerivedFormula(formatted).expression).toEqual(parsed.expression);

        const division = parseDerivedFormula('T1[flux] / (T2[fission] / 3)');
        expect(formatDerivedExpression(division.expression!)).toBe('T1[flux] / (T2[fission] / 3)');
        expect(parseDerivedFormula(formatDerivedExpression(division.expression!)).expression).toEqual(division.expression);

        const addition = parseDerivedFormula('T1[flux] + (2 + 3)');
        expect(formatDerivedExpression(addition.expression!)).toBe('T1[flux] + (2 + 3)');
        expect(parseDerivedFormula(formatDerivedExpression(addition.expression!)).expression).toEqual(addition.expression);
    });

    it('reports actionable parse errors', () => {
        expect(parseDerivedFormula('').error).toContain('empty');
        expect(parseDerivedFormula('T1[flux').error).toContain('Missing "]"');
        expect(parseDerivedFormula('T1[]').error).toContain('needs a score');
        expect(parseDerivedFormula('T1[flux] +').error).toContain('expected');
        expect(parseDerivedFormula('T1[flux] & 2').error).toContain('Unexpected');
    });

    it('converts expressions to tokens and back', () => {
        const expression = parseDerivedFormula('(T1[flux] + 2) * T2[fission]').expression!;
        const tokens = expressionToTokens(expression);
        expect(tokens.length).toBeGreaterThan(5);
        expect(tokensToExpression(tokens).expression).toEqual(expression);

        const appended = appendDerivedToken(
            appendDerivedToken([], { kind: 'operand', operand: { kind: 'tally', tallyId: 1, score: 'flux' } }),
            {
                kind: 'operator',
                op: '/'
            }
        );
        expect(tokensToExpression(appended).error).toContain('expected');
        expect(removeLastDerivedToken(appended)).toHaveLength(1);
    });

    it('evaluates with precedence, scalar scaling, and unary negation', () => {
        const resolve = (operand: { tallyId: number }): { mean: number[]; stdDev: number[] } =>
            operand.tallyId === 1 ? { mean: [10], stdDev: [1] } : { mean: [2], stdDev: [0.2] };
        const addThenScale = parseDerivedFormula('(T1[flux] + T2[fission]) * 2').expression!;
        expect(evaluateDerivedExpression(addThenScale, resolve)).toEqual({ mean: [24], stdDev: [2.039607805437114] });

        const negated = parseDerivedFormula('-T1[flux] + 5').expression!;
        expect(evaluateDerivedExpression(negated, resolve)).toEqual({ mean: [-5], stdDev: [1] });
    });

    it('propagates uncertainty for ratio and product', () => {
        const resolve = (operand: { tallyId: number }): { mean: number[]; stdDev: number[] } =>
            operand.tallyId === 1 ? { mean: [10], stdDev: [1] } : { mean: [2], stdDev: [0.2] };
        const ratio = evaluateDerivedExpression(parseDerivedFormula('T1[flux] / T2[fission]').expression!, resolve) as {
            mean: number[];
            stdDev: number[];
        };
        expect(ratio.mean).toEqual([5]);
        expect(ratio.stdDev[0]).toBeCloseTo(5 * Math.sqrt(0.1 ** 2 + 0.1 ** 2), 12);

        const product = evaluateDerivedExpression(parseDerivedFormula('T1[flux] * T2[fission]').expression!, resolve) as {
            mean: number[];
            stdDev: number[];
        };
        expect(product.mean).toEqual([20]);
        expect(product.stdDev[0]).toBeCloseTo(20 * Math.sqrt(0.1 ** 2 + 0.1 ** 2), 12);
    });

    it('rejects scalar division by zero and vector shape mismatches', () => {
        expect(() =>
            evaluateDerivedExpression(parseDerivedFormula('T1[flux] / 0').expression!, () => ({ mean: [1], stdDev: [0] }))
        ).toThrow(DerivedExpressionError);
        const mismatch = parseDerivedFormula('T1[flux] / T2[fission]').expression!;
        expect(() =>
            evaluateDerivedExpression(mismatch, (operand) =>
                operand.tallyId === 1 ? { mean: [1, 2], stdDev: [0, 0] } : { mean: [1], stdDev: [0] }
            )
        ).toThrow(/shapes differ/i);
    });
});

describe('derived tally validation', () => {
    const candidate = (expression: OpenMCDerivedExpression, name = 'Capture / fission'): OpenMCDerivedTally => ({
        id: 1,
        name,
        expression
    });

    it('accepts a valid ratio and rejects unknown tally/score/nuclide', () => {
        const ratio = candidate({
            kind: 'binary',
            op: '/',
            left: { kind: 'tally', tallyId: 1, score: 'flux' },
            right: { kind: 'tally', tallyId: 2, score: 'fission' }
        });
        expect(validateDerivedTally(ratio, [flux, fission])).toEqual([]);

        const unknownTally = validateDerivedTally(candidate({ kind: 'tally', tallyId: 99, score: 'flux' }), [flux, fission]);
        expect(unknownTally.map((issue) => issue.code)).toContain('unknown-tally');

        const unknownScore = validateDerivedTally(candidate({ kind: 'tally', tallyId: 1, score: 'heating' }), [flux, fission]);
        expect(unknownScore.map((issue) => issue.code)).toContain('unknown-score');

        const unknownNuclide = validateDerivedTally(candidate({ kind: 'tally', tallyId: 1, score: 'flux', nuclide: 'Pu239' }), [
            flux,
            fission
        ]);
        expect(unknownNuclide.map((issue) => issue.code)).toContain('unknown-nuclide');
    });

    it('rejects empty expressions, duplicate names, and scalar division by zero', () => {
        expect(validateDerivedTally(candidate({ kind: 'scalar', value: 2 }), [flux, fission]).map((issue) => issue.code)).toContain(
            'empty-expression'
        );

        const duplicate = validateDerivedTally(
            candidate({ kind: 'tally', tallyId: 1, score: 'flux' }, 'flux ratio'),
            [flux, fission],
            [{ id: 2, name: 'Flux Ratio', expression: { kind: 'tally', tallyId: 1, score: 'flux' } }]
        );
        expect(duplicate.map((issue) => issue.code)).toContain('duplicate-name');

        const zero = candidate({
            kind: 'binary',
            op: '/',
            left: { kind: 'tally', tallyId: 1, score: 'flux' },
            right: { kind: 'binary', op: '-', left: { kind: 'scalar', value: 1 }, right: { kind: 'scalar', value: 1 } }
        });
        expect(validateDerivedTally(zero, [flux, fission]).map((issue) => issue.code)).toContain('division-by-zero');
        expect(constantExpressionValue(zero.expression)).toBeUndefined();

        const nonFinite = validateDerivedTally(
            candidate({
                kind: 'binary',
                op: '+',
                left: { kind: 'tally', tallyId: 1, score: 'flux' },
                right: { kind: 'scalar', value: Number.POSITIVE_INFINITY }
            }),
            [flux, fission]
        );
        expect(nonFinite.map((issue) => issue.code)).toContain('non-finite-scalar');
    });

    it('rejects the same filter type with different bins', () => {
        const otherCell = tally(3, ['flux'], { filters: [{ type: 'cell', bins: [2] }] });
        const expression: OpenMCDerivedExpression = {
            kind: 'binary',
            op: '/',
            left: { kind: 'tally', tallyId: 2, score: 'fission' },
            right: { kind: 'tally', tallyId: 3, score: 'flux' }
        };
        const issues = validateDerivedTally(candidate(expression), [flux, fission, otherCell]);
        expect(issues.map((issue) => issue.code)).toContain('incompatible-filter-bins');
        expect(issues.find((issue) => issue.code === 'incompatible-filter-bins')?.message).toContain('cell');
    });

    it('estimates bins from compatible filter axes and nuclides', () => {
        const multi = tally(4, ['flux'], { filters: [{ type: 'cell', bins: [1] }] });
        expect(estimateDerivedBins({ kind: 'tally', tallyId: 4, score: 'flux' }, [multi])).toBe(2);
        expect(estimateDerivedBins({ kind: 'tally', tallyId: 4, score: 'flux', nuclide: 'U235' }, [multi])).toBe(1);

        const energy = tally(5, ['flux'], { filters: [{ type: 'energy', bins: [0, 1, 2] }] });
        expect(
            estimateDerivedBins(
                {
                    kind: 'binary',
                    op: '/',
                    left: { kind: 'tally', tallyId: 4, score: 'flux', nuclide: 'total' },
                    right: { kind: 'tally', tallyId: 5, score: 'flux', nuclide: 'total' }
                },
                [multi, energy]
            )
        ).toBe(2);

        const incompatible = tally(6, ['flux'], { filters: [{ type: 'cell', bins: [2] }] });
        expect(
            estimateDerivedBins(
                {
                    kind: 'binary',
                    op: '+',
                    left: { kind: 'tally', tallyId: 4, score: 'flux' },
                    right: { kind: 'tally', tallyId: 6, score: 'flux' }
                },
                [multi, incompatible]
            )
        ).toBeUndefined();
    });
});

describe('derived aggregation', () => {
    it('sums finite bins and combines uncertainty in quadrature', () => {
        expect(aggregateDerivedBins([1, 2, Number.NaN], [0.1, 0.2, 1])).toEqual({
            value: 3,
            stdDev: Math.sqrt(0.1 ** 2 + 0.2 ** 2),
            bins: 2
        });
    });
});
