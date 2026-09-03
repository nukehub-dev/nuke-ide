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
import { parseExpression, evaluateExpression, sampleParametric, sampleFourier } from './expression';

describe('parseExpression', () => {
    it('parses numbers, identifiers, and arithmetic operators', () => {
        const result = parseExpression('a + b * 2');
        expect(result.ok).toBe(true);
    });

    it('respects operator precedence', () => {
        const result = parseExpression('1 + 2 * 3');
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(evaluateExpression(result.ast, {})).toBe(7);
    });

    it('makes ^ right-associative', () => {
        const result = parseExpression('2 ^ 3 ^ 2');
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(evaluateExpression(result.ast, {})).toBe(512);
    });

    it('supports unary minus', () => {
        const result = parseExpression('-5 + 3');
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(evaluateExpression(result.ast, {})).toBe(-2);
    });

    it('supports parentheses for grouping', () => {
        const result = parseExpression('(1 + 2) * 3');
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(evaluateExpression(result.ast, {})).toBe(9);
    });

    it('parses function calls with multiple arguments', () => {
        const result = parseExpression('max(1, 2, 3)');
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(evaluateExpression(result.ast, {})).toBe(3);
    });

    it('parses scientific notation', () => {
        const result = parseExpression('1.2e3 + 4E-1');
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(evaluateExpression(result.ast, {})).toBeCloseTo(1200.4, 10);
    });

    it('reports unexpected characters with a position', () => {
        const result = parseExpression('1 + $');
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }
        expect(result.position).toBe(4);
        expect(result.error).toContain("'$'");
    });

    it('reports unexpected end of expression', () => {
        const result = parseExpression('1 + (');
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }
        expect(result.error.toLowerCase()).toContain('end of expression');
    });

    it('reports trailing tokens', () => {
        const result = parseExpression('1 2');
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }
        expect(result.error).toContain('Unexpected token');
    });
});

describe('evaluateExpression', () => {
    it('resolves caller-provided parameters', () => {
        const parsed = parseExpression('r * cos(t)');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
            return;
        }
        expect(evaluateExpression(parsed.ast, { r: 2, t: 0 })).toBe(2);
    });

    it('provides pi and e constants', () => {
        const pi = parseExpression('pi');
        expect(pi.ok).toBe(true);
        if (!pi.ok) {
            return;
        }
        expect(evaluateExpression(pi.ast, {})).toBe(Math.PI);

        const e = parseExpression('e');
        expect(e.ok).toBe(true);
        if (!e.ok) {
            return;
        }
        expect(evaluateExpression(e.ast, {})).toBe(Math.E);
    });

    it('evaluates the full function set', () => {
        const cases: { expr: string; scope: Record<string, number>; expected: number }[] = [
            { expr: 'sin(pi/2)', scope: {}, expected: 1 },
            { expr: 'cos(0)', scope: {}, expected: 1 },
            { expr: 'tan(0)', scope: {}, expected: 0 },
            { expr: 'asin(1)', scope: {}, expected: Math.PI / 2 },
            { expr: 'acos(1)', scope: {}, expected: 0 },
            { expr: 'atan(1)', scope: {}, expected: Math.PI / 4 },
            { expr: 'sqrt(9)', scope: {}, expected: 3 },
            { expr: 'abs(-5)', scope: {}, expected: 5 },
            { expr: 'exp(0)', scope: {}, expected: 1 },
            { expr: 'log(e)', scope: {}, expected: 1 },
            { expr: 'min(3, 1, 2)', scope: {}, expected: 1 },
            { expr: 'max(3, 1, 2)', scope: {}, expected: 3 }
        ];
        for (const { expr, scope, expected } of cases) {
            const parsed = parseExpression(expr);
            expect(parsed.ok).toBe(true);
            if (!parsed.ok) {
                continue;
            }
            expect(evaluateExpression(parsed.ast, scope)).toBeCloseTo(expected, 10);
        }
    });

    it('throws for unknown identifiers', () => {
        const parsed = parseExpression('missing');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
            return;
        }
        expect(() => evaluateExpression(parsed.ast, {})).toThrow("Unknown identifier 'missing'");
    });

    it('throws for unknown functions', () => {
        const parsed = parseExpression('foo(1)');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
            return;
        }
        expect(() => evaluateExpression(parsed.ast, {})).toThrow("Unknown function 'foo'");
    });

    it('throws on division by zero', () => {
        const parsed = parseExpression('1 / 0');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
            return;
        }
        expect(() => evaluateExpression(parsed.ast, {})).toThrow('Division by zero');
    });

    it('throws when the result is non-finite', () => {
        const parsed = parseExpression('1 / 0');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
            return;
        }
        expect(() => evaluateExpression(parsed.ast, { '0': Number.EPSILON })).toThrow();
    });
});

describe('sampleParametric', () => {
    it('samples a parametric circle', () => {
        const points = sampleParametric(
            {
                kind: 'parametric',
                x: 'cos(t)',
                y: 'sin(t)',
                z: '0',
                tStart: 0,
                tEnd: 2 * Math.PI,
                sampleCount: 64
            },
            {}
        );
        expect(points).toHaveLength(65);
        const first = points[0];
        expect(first[0]).toBeCloseTo(1, 10);
        expect(first[1]).toBeCloseTo(0, 10);
        expect(first[2]).toBe(0);
        // A full-turn parametric curve is closed: the first point repeats exactly at the end.
        expect(points[64]).toEqual(first);
    });

    it('does not close a parametric curve whose endpoints do not meet', () => {
        const points = sampleParametric(
            {
                kind: 'parametric',
                x: 't',
                y: '0',
                z: '0',
                tStart: 0,
                tEnd: 1,
                sampleCount: 16
            },
            {}
        );
        expect(points).toHaveLength(16);
        expect(points[15]).toEqual([1, 0, 0]);
    });

    it('merges document parameters into the scope', () => {
        const points = sampleParametric(
            {
                kind: 'parametric',
                x: 'r * t',
                y: '0',
                z: '0',
                tStart: 0,
                tEnd: 1,
                sampleCount: 8
            },
            { r: 5 }
        );
        expect(points).toHaveLength(8);
        expect(points[points.length - 1][0]).toBeCloseTo(5, 10);
    });

    it('is deterministic for the same inputs', () => {
        const source = {
            kind: 'parametric' as const,
            x: 'sin(t)',
            y: 'cos(t)',
            z: 't',
            tStart: 0,
            tEnd: 1,
            sampleCount: 16
        };
        const a = sampleParametric(source, {});
        const b = sampleParametric(source, {});
        expect(a).toEqual(b);
    });
});

describe('sampleFourier', () => {
    it('reconstructs a circle from the first-order modes', () => {
        const points = sampleFourier({
            kind: 'fourier',
            nfp: 1,
            order: 1,
            cosX: [0, 1],
            sinX: [0, 0],
            cosY: [0, 0],
            sinY: [0, 1],
            cosZ: [0, 0],
            sinZ: [0, 0],
            sampleCount: 64
        });
        expect(points).toHaveLength(65);
        const first = points[0];
        expect(first[0]).toBeCloseTo(1, 10);
        expect(first[1]).toBeCloseTo(0, 10);
        expect(first[2]).toBe(0);
        // A Fourier series is periodic: the first point repeats exactly at the end.
        expect(points[64]).toEqual(first);
    });

    it('is deterministic for the same inputs', () => {
        const source = {
            kind: 'fourier' as const,
            nfp: 1,
            order: 2,
            cosX: [0, 1, 0],
            sinX: [0, 0, 0],
            cosY: [0, 0, 1],
            sinY: [0, 0, 0],
            cosZ: [0, 0, 0],
            sinZ: [0, 0, 0],
            sampleCount: 32
        };
        const a = sampleFourier(source);
        const b = sampleFourier(source);
        expect(a).toEqual(b);
    });
});
