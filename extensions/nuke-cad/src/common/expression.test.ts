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
    parseExpression,
    evaluateExpression,
    evaluateQuantity,
    parseAndEvaluateQuantity,
    convertQuantity,
    coerceToQuantity,
    unitToString,
    quantityToString,
    unitEquals,
    isKnownUnit,
    parseUnit,
    DIMENSIONLESS,
    sampleParametric,
    sampleFourier
} from './expression';

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

describe('unit registry', () => {
    it('recognizes known units and rejects unknown ones', () => {
        expect(isKnownUnit('mm')).toBe(true);
        expect(isKnownUnit('deg')).toBe(true);
        expect(isKnownUnit('furlong')).toBe(false);
        expect(parseUnit('mm')).toEqual({ scale: 0.001, unit: { length: 1 } });
        expect(() => parseUnit('furlong')).toThrow("Unknown unit 'furlong'");
    });

    it('compares and renders units', () => {
        expect(unitEquals({ length: 1 }, { length: 1 })).toBe(true);
        expect(unitEquals({ length: 1 }, { time: 1 })).toBe(false);
        expect(unitToString(DIMENSIONLESS)).toBe('');
        expect(unitToString({ length: 1 })).toBe('m');
        expect(unitToString({ length: 2 })).toBe('m^2');
        expect(quantityToString({ value: 2, unit: DIMENSIONLESS })).toBe('2');
        expect(quantityToString({ value: 0.01, unit: { length: 1 } })).toBe('0.01 m');
    });
});

describe('unit literals', () => {
    it('parses quantity literals with and without a space', () => {
        for (const src of ['10mm', '10 mm']) {
            const parsed = parseExpression(src);
            expect(parsed.ok).toBe(true);
            if (!parsed.ok) {
                continue;
            }
            expect(parsed.ast).toEqual({ type: 'quantity', value: 10, unit: 'mm' });
        }
    });

    it('evaluates bare unit names as one of that unit', () => {
        expect(parseAndEvaluateQuantity('mm', {})).toEqual({ value: 0.001, unit: { length: 1 } });
        expect(parseAndEvaluateQuantity('deg', {})).toEqual({ value: Math.PI / 180, unit: { angle: 1 } });
    });

    it('lets scope bindings shadow unit names', () => {
        expect(parseAndEvaluateQuantity('m', { m: 3 })).toEqual({ value: 3, unit: DIMENSIONLESS });
    });

    it('keeps explicit multiplication with unit-named parameters working', () => {
        expect(parseAndEvaluateQuantity('2*m', { m: 3 })).toEqual({ value: 6, unit: DIMENSIONLESS });
    });

    it('rejects quantity literals on the unit-less path', () => {
        const parsed = parseExpression('10mm');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
            return;
        }
        expect(() => evaluateExpression(parsed.ast, {})).toThrow(/unit-less.*quantities|unit 'mm'/);
    });

    it('rejects quantities nested inside larger unit-less expressions', () => {
        for (const src of ['2 * 3mm', 'sin(90deg)', '10mm + 1']) {
            const parsed = parseExpression(src);
            expect(parsed.ok).toBe(true);
            if (!parsed.ok) {
                continue;
            }
            expect(() => evaluateExpression(parsed.ast, {})).toThrow(/does not accept quantities/);
        }
    });

    it('still rejects bare unit names as unknown identifiers on the unit-less path', () => {
        const parsed = parseExpression('mm');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
            return;
        }
        expect(() => evaluateExpression(parsed.ast, {})).toThrow("Unknown identifier 'mm'");
    });

    it('rejects unit syntax when sampling parametric curves', () => {
        expect(() =>
            sampleParametric(
                {
                    kind: 'parametric',
                    x: '10mm * t',
                    y: '0',
                    z: '0',
                    tStart: 0,
                    tEnd: 1,
                    sampleCount: 8
                },
                {}
            )
        ).toThrow(/does not accept quantities/);
    });
});

describe('evaluateQuantity operators', () => {
    it('treats unit-less expressions as dimensionless', () => {
        const parsed = parseExpression('1 + 2 * 3');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
            return;
        }
        expect(evaluateQuantity(parsed.ast, {})).toEqual({ value: 7, unit: DIMENSIONLESS });
    });

    it('adds and subtracts equal units with conversion', () => {
        expect(parseAndEvaluateQuantity('10mm + 1cm', {}).value).toBeCloseTo(0.02, 12);
        expect(parseAndEvaluateQuantity('10mm - 1cm', {}).value).toBeCloseTo(0, 12);
    });

    it('rejects adding inconsistent units', () => {
        expect(() => parseAndEvaluateQuantity('10mm + 5s', {})).toThrow('inconsistent units');
        expect(() => parseAndEvaluateQuantity('10mm + 5', {})).toThrow('inconsistent units');
    });

    it('combines units for multiplication and division', () => {
        const area = parseAndEvaluateQuantity('2mm * 3mm', {});
        expect(area.value).toBeCloseTo(6e-6, 15);
        expect(area.unit).toEqual({ length: 2 });
        const speed = parseAndEvaluateQuantity('10mm / 2s', {});
        expect(speed.value).toBeCloseTo(0.005, 12);
        expect(speed.unit).toEqual({ length: 1, time: -1 });
        expect(parseAndEvaluateQuantity('2 * 3mm', {}).value).toBeCloseTo(0.006, 12);
    });

    it('throws division by zero for dimensioned divisors', () => {
        expect(() => parseAndEvaluateQuantity('1mm / 0s', {})).toThrow('Division by zero');
    });

    it('requires a dimensionless exponent for pow', () => {
        expect(parseAndEvaluateQuantity('2 ^ 3', {}).value).toBe(8);
        const square = parseAndEvaluateQuantity('(2mm) ^ 2', {});
        expect(square.value).toBeCloseTo(4e-6, 15);
        expect(square.unit).toEqual({ length: 2 });
        expect(() => parseAndEvaluateQuantity('2 ^ 3mm', {})).toThrow('dimensionless');
    });

    it('requires an integer exponent for dimensioned bases', () => {
        expect(() => parseAndEvaluateQuantity('(2mm) ^ 0.5', {})).toThrow('must be an integer');
        expect(parseAndEvaluateQuantity('(4m^2) ^ -1', {}).unit).toEqual({ length: -2 });
    });

    it('negates quantities preserving the unit', () => {
        expect(parseAndEvaluateQuantity('-5mm', {})).toEqual({ value: -0.005, unit: { length: 1 } });
    });
});

describe('evaluateQuantity functions', () => {
    it('takes angles in trig and returns dimensionless', () => {
        expect(parseAndEvaluateQuantity('sin(90deg)', {}).value).toBeCloseTo(1, 10);
        expect(parseAndEvaluateQuantity('cos(0deg)', {}).value).toBeCloseTo(1, 10);
        expect(() => parseAndEvaluateQuantity('sin(1)', {})).toThrow('expects an angle');
    });

    it('returns angles from inverse trig of dimensionless args', () => {
        const angle = parseAndEvaluateQuantity('asin(1)', {});
        expect(angle.unit).toEqual({ angle: 1 });
        expect(angle.value).toBeCloseTo(Math.PI / 2, 10);
        expect(() => parseAndEvaluateQuantity('asin(1mm)', {})).toThrow('dimensionless');
    });

    it('halves units in sqrt and rejects odd exponents', () => {
        const root = parseAndEvaluateQuantity('sqrt(4mm^2)', {});
        expect(root.value).toBeCloseTo(0.004, 12);
        expect(root.unit).toEqual({ length: 1 });
        expect(() => parseAndEvaluateQuantity('sqrt(2mm)', {})).toThrow('even unit exponents');
    });

    it('gates exp/log to dimensionless and preserves units in abs/min/max', () => {
        expect(parseAndEvaluateQuantity('log(e)', {}).value).toBeCloseTo(1, 10);
        expect(() => parseAndEvaluateQuantity('exp(1mm)', {})).toThrow('dimensionless');
        expect(() => parseAndEvaluateQuantity('log(2s)', {})).toThrow('dimensionless');
        expect(parseAndEvaluateQuantity('abs(-5mm)', {})).toEqual({ value: 0.005, unit: { length: 1 } });
        expect(parseAndEvaluateQuantity('min(1mm, 5mm)', {})).toEqual({ value: 0.001, unit: { length: 1 } });
        expect(() => parseAndEvaluateQuantity('min(1mm, 5s)', {})).toThrow('equal units');
    });

    it('resolves quantity scope values and reports errors like the unit-less path', () => {
        expect(parseAndEvaluateQuantity('r * 2mm', { r: 3 }).value).toBeCloseTo(0.006, 12);
        expect(parseAndEvaluateQuantity('r * 2', { r: { value: 0.01, unit: { length: 1 } } }).unit).toEqual({ length: 1 });
        expect(() => parseAndEvaluateQuantity('missing', {})).toThrow("Unknown identifier 'missing'");
        expect(() => parseAndEvaluateQuantity('foo(1)', {})).toThrow("Unknown function 'foo'");
        expect(() => parseAndEvaluateQuantity('1 / 0', {})).toThrow('Division by zero');
    });
});

describe('unit conversion and assignment coercion', () => {
    it('reads values back in target units', () => {
        expect(convertQuantity({ value: 1, unit: { length: 1 } }, 'mm')).toBeCloseTo(1000, 10);
        expect(convertQuantity({ value: 0.01, unit: { length: 1 } }, 'cm')).toBeCloseTo(1, 10);
        expect(convertQuantity({ value: 2, unit: DIMENSIONLESS }, DIMENSIONLESS)).toBe(2);
    });

    it('fails conversion with a clear error on mismatch', () => {
        expect(() => convertQuantity({ value: 1, unit: { length: 1 } }, 's')).toThrow('Failed to convert');
        expect(() => convertQuantity({ value: 1, unit: { length: 1 } }, 'furlong')).toThrow("Unknown unit 'furlong'");
    });

    it('treats assigned numbers as expressed in the declared unit', () => {
        expect(coerceToQuantity(5, 'mm')).toEqual({ value: 0.005, unit: { length: 1 } });
        expect(coerceToQuantity(5)).toEqual({ value: 5, unit: DIMENSIONLESS });
    });

    it('converts assigned quantities and names the parameter on failure', () => {
        const coerced = coerceToQuantity({ value: 0.02, unit: { length: 1 } }, 'mm', 'width');
        expect(coerced.value).toBeCloseTo(0.02, 12);
        expect(coerced.unit).toEqual({ length: 1 });
        expect(() => coerceToQuantity({ value: 5, unit: { time: 1 } }, 'mm', 'width')).toThrow(/Failed to convert.*parameter 'width'/);
    });
});
