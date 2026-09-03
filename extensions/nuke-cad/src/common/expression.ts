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

/**
 * Small recursive-descent expression parser/evaluator for parametric curves.
 *
 * Supports numbers, identifiers (``t`` and caller-provided parameter names),
 * the operators ``+ - * / ^`` (``^`` is right-associative), unary ``-``,
 * parentheses, the functions ``sin cos tan asin acos atan sqrt abs exp log
 * min max``, and the constants ``pi`` and ``e``.
 *
 * @module nuke-cad/common
 */

import { type CurvePoint, type ParametricCurveSource, type FourierCurveSource } from './cad-document';

type TokenType = 'number' | 'ident' | 'operator' | 'paren' | 'comma' | 'eof';

interface Token {
    readonly type: TokenType;
    readonly value: string;
    readonly pos: number;
}

export type Expr =
    | { readonly type: 'number'; readonly value: number }
    | { readonly type: 'ident'; readonly name: string }
    | { readonly type: 'unary'; readonly op: '-'; readonly operand: Expr }
    | { readonly type: 'binary'; readonly op: '+' | '-' | '*' | '/' | '^'; readonly left: Expr; readonly right: Expr }
    | { readonly type: 'call'; readonly name: string; readonly args: readonly Expr[] };

export interface ParseSuccess {
    readonly ok: true;
    readonly ast: Expr;
}

export interface ParseFailure {
    readonly ok: false;
    readonly error: string;
    readonly position: number;
}

export type ParseResult = ParseSuccess | ParseFailure;

class ParseError extends Error {
    constructor(
        message: string,
        public readonly position: number
    ) {
        super(message);
    }
}

function tokenize(src: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        if (/\s/.test(ch)) {
            i++;
            continue;
        }
        if (ch === '(' || ch === ')') {
            tokens.push({ type: 'paren', value: ch, pos: i });
            i++;
            continue;
        }
        if (ch === ',') {
            tokens.push({ type: 'comma', value: ch, pos: i });
            i++;
            continue;
        }
        if (/[+\-*/^]/.test(ch)) {
            tokens.push({ type: 'operator', value: ch, pos: i });
            i++;
            continue;
        }
        if (/[0-9.]/.test(ch)) {
            const start = i;
            let hasDot = ch === '.';
            i++;
            while (i < src.length) {
                const c = src[i];
                if (/[0-9]/.test(c)) {
                    i++;
                } else if (c === '.' && !hasDot) {
                    hasDot = true;
                    i++;
                } else if ((c === 'e' || c === 'E') && i + 1 < src.length) {
                    let j = i + 1;
                    if (src[j] === '+' || src[j] === '-') {
                        j++;
                    }
                    if (j < src.length && /[0-9]/.test(src[j])) {
                        i = j + 1;
                        while (i < src.length && /[0-9]/.test(src[i])) {
                            i++;
                        }
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            }
            tokens.push({ type: 'number', value: src.slice(start, i), pos: start });
            continue;
        }
        if (/[A-Za-z_]/.test(ch)) {
            const start = i;
            i++;
            while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) {
                i++;
            }
            tokens.push({ type: 'ident', value: src.slice(start, i), pos: start });
            continue;
        }
        throw new ParseError(`Unexpected character '${ch}'`, i);
    }
    tokens.push({ type: 'eof', value: '', pos: src.length });
    return tokens;
}

function parseTokens(tokens: Token[]): Expr {
    let pos = 0;

    function peek(): Token {
        return tokens[pos];
    }

    function advance(): Token {
        return tokens[pos++];
    }

    function expect(value: string): Token {
        const token = peek();
        if (token.value !== value) {
            throw new ParseError(`Expected '${value}' but got '${token.value === '' ? 'end of expression' : token.value}'`, token.pos);
        }
        return advance();
    }

    function parseExpression(): Expr {
        return parseAddSub();
    }

    function parseAddSub(): Expr {
        let left = parseMulDiv();
        while (true) {
            const token = peek();
            if (token.value === '+' || token.value === '-') {
                advance();
                const right = parseMulDiv();
                left = { type: 'binary', op: token.value as '+' | '-', left, right };
            } else {
                break;
            }
        }
        return left;
    }

    function parseMulDiv(): Expr {
        let left = parsePower();
        while (true) {
            const token = peek();
            if (token.value === '*' || token.value === '/') {
                advance();
                const right = parsePower();
                left = { type: 'binary', op: token.value as '*' | '/', left, right };
            } else {
                break;
            }
        }
        return left;
    }

    function parsePower(): Expr {
        const left = parseUnary();
        const token = peek();
        if (token.value === '^') {
            advance();
            const right = parsePower();
            return { type: 'binary', op: '^', left, right };
        }
        return left;
    }

    function parseUnary(): Expr {
        const token = peek();
        if (token.value === '-') {
            advance();
            return { type: 'unary', op: '-', operand: parseUnary() };
        }
        return parsePrimary();
    }

    function parsePrimary(): Expr {
        const token = peek();
        if (token.type === 'number') {
            advance();
            const value = Number(token.value);
            if (!Number.isFinite(value)) {
                throw new ParseError(`Invalid number '${token.value}'`, token.pos);
            }
            return { type: 'number', value };
        }
        if (token.type === 'ident') {
            advance();
            if (peek().value === '(') {
                advance();
                const args: Expr[] = [];
                if (peek().value !== ')') {
                    args.push(parseExpression());
                    while (peek().value === ',') {
                        advance();
                        args.push(parseExpression());
                    }
                }
                expect(')');
                return { type: 'call', name: token.value, args };
            }
            return { type: 'ident', name: token.value };
        }
        if (token.value === '(') {
            advance();
            const expr = parseExpression();
            expect(')');
            return expr;
        }
        throw new ParseError(`Unexpected token '${token.value === '' ? 'end of expression' : token.value}'`, token.pos);
    }

    const expr = parseExpression();
    const trailing = peek();
    if (trailing.type !== 'eof') {
        throw new ParseError(`Unexpected token '${trailing.value}'`, trailing.pos);
    }
    return expr;
}

/**
 * Parse an expression string into an AST.
 *
 * Returns ``{ ok: true, ast }`` on success or ``{ ok: false, error, position }``
 * on failure. The ``position`` is the 0-based index of the offending token.
 */
export function parseExpression(src: string): ParseResult {
    try {
        return { ok: true, ast: parseTokens(tokenize(src)) };
    } catch (error) {
        if (error instanceof ParseError) {
            return { ok: false, error: error.message, position: error.position };
        }
        throw error;
    }
}

const FUNCTIONS: Record<string, (args: number[]) => number> = {
    sin: (args) => {
        if (args.length !== 1) {
            throw new Error('sin expects 1 argument');
        }
        return Math.sin(args[0]);
    },
    cos: (args) => {
        if (args.length !== 1) {
            throw new Error('cos expects 1 argument');
        }
        return Math.cos(args[0]);
    },
    tan: (args) => {
        if (args.length !== 1) {
            throw new Error('tan expects 1 argument');
        }
        return Math.tan(args[0]);
    },
    asin: (args) => {
        if (args.length !== 1) {
            throw new Error('asin expects 1 argument');
        }
        return Math.asin(args[0]);
    },
    acos: (args) => {
        if (args.length !== 1) {
            throw new Error('acos expects 1 argument');
        }
        return Math.acos(args[0]);
    },
    atan: (args) => {
        if (args.length !== 1) {
            throw new Error('atan expects 1 argument');
        }
        return Math.atan(args[0]);
    },
    sqrt: (args) => {
        if (args.length !== 1) {
            throw new Error('sqrt expects 1 argument');
        }
        return Math.sqrt(args[0]);
    },
    abs: (args) => {
        if (args.length !== 1) {
            throw new Error('abs expects 1 argument');
        }
        return Math.abs(args[0]);
    },
    exp: (args) => {
        if (args.length !== 1) {
            throw new Error('exp expects 1 argument');
        }
        return Math.exp(args[0]);
    },
    log: (args) => {
        if (args.length !== 1) {
            throw new Error('log expects 1 argument');
        }
        return Math.log(args[0]);
    },
    min: (args) => {
        if (args.length === 0) {
            throw new Error('min expects at least 1 argument');
        }
        return Math.min(...args);
    },
    max: (args) => {
        if (args.length === 0) {
            throw new Error('max expects at least 1 argument');
        }
        return Math.max(...args);
    }
};

function evaluate(ast: Expr, scope: Record<string, number>): number {
    switch (ast.type) {
        case 'number':
            return ast.value;
        case 'ident': {
            if (Object.prototype.hasOwnProperty.call(scope, ast.name)) {
                const value = scope[ast.name];
                if (typeof value !== 'number' || !Number.isFinite(value)) {
                    throw new Error(`Identifier '${ast.name}' resolved to a non-finite value`);
                }
                return value;
            }
            if (ast.name === 'pi') {
                return Math.PI;
            }
            if (ast.name === 'e') {
                return Math.E;
            }
            throw new Error(`Unknown identifier '${ast.name}'`);
        }
        case 'unary':
            return -evaluate(ast.operand, scope);
        case 'binary': {
            const left = evaluate(ast.left, scope);
            const right = evaluate(ast.right, scope);
            switch (ast.op) {
                case '+':
                    return left + right;
                case '-':
                    return left - right;
                case '*':
                    return left * right;
                case '/':
                    if (right === 0) {
                        throw new Error('Division by zero');
                    }
                    return left / right;
                case '^':
                    return Math.pow(left, right);
            }
        }
        // eslint-disable-next-line no-fallthrough
        case 'call': {
            const fn = FUNCTIONS[ast.name];
            if (fn === undefined) {
                throw new Error(`Unknown function '${ast.name}'`);
            }
            const args = ast.args.map((a) => evaluate(a, scope));
            return fn(args);
        }
    }
}

/**
 * Evaluate a parsed expression against a scope of identifier values.
 *
 * ``t`` should be present in ``scope`` for parametric sampling. Document-level
 * parameter names may also be supplied. Throws a descriptive ``Error`` for
 * unknown identifiers, division by zero, or non-finite results.
 */
export function evaluateExpression(ast: Expr, scope: Record<string, number>): number {
    const value = evaluate(ast, scope);
    if (!Number.isFinite(value)) {
        throw new Error('Expression evaluated to a non-finite number');
    }
    return value;
}

function parseAndEvaluate(expr: string, scope: Record<string, number>): number {
    const parsed = parseExpression(expr);
    if (!parsed.ok) {
        throw new Error(parsed.error);
    }
    return evaluateExpression(parsed.ast, scope);
}

/**
 * Sample a parametric curve source into a dense polyline.
 *
 * The ``source.x``, ``source.y``, and ``source.z`` expressions are evaluated at
 * ``sampleCount`` uniformly spaced ``t`` values between ``tStart`` and ``tEnd``
 * (inclusive). ``parameters`` are merged into the scope alongside ``t``.
 */
/**
 * Relative tolerance (against the polyline extent) under which a parametric
 * source's endpoints count as meeting, triggering exact loop closure.
 */
const PARAMETRIC_CLOSURE_TOLERANCE = 1e-9;

/** True when the first and last points fall within `relativeTolerance` of the polyline extent. */
function endpointsMeet(points: readonly CurvePoint[], relativeTolerance: number): boolean {
    let extent = 0;
    for (const point of points) {
        for (const coordinate of point) {
            extent = Math.max(extent, Math.abs(coordinate));
        }
    }
    const first = points[0];
    const last = points[points.length - 1];
    const gap = Math.hypot(first[0] - last[0], first[1] - last[1], first[2] - last[2]);
    return gap <= relativeTolerance * Math.max(1, extent);
}

export function sampleParametric(source: ParametricCurveSource, parameters: Record<string, number>): CurvePoint[] {
    const { x, y, z, tStart, tEnd, sampleCount } = source;
    const count = Math.max(2, Math.floor(sampleCount));
    const points: CurvePoint[] = [];
    for (let i = 0; i < count; i++) {
        const t = tStart + ((tEnd - tStart) * i) / (count - 1);
        const scope = { ...parameters, t };
        points.push([parseAndEvaluate(x, scope), parseAndEvaluate(y, scope), parseAndEvaluate(z, scope)]);
    }
    if (endpointsMeet(points, PARAMETRIC_CLOSURE_TOLERANCE)) {
        // The expressions meet at both ends of the range (e.g. a full-turn
        // circle): repeat the first point exactly so the backend's closed-curve
        // detection builds a periodic wire.
        points.push([points[0][0], points[0][1], points[0][2]]);
    }
    return points;
}

function fourierValue(theta: number, order: number, cos: readonly number[], sin: readonly number[]): number {
    let value = 0;
    for (let m = 0; m <= order; m++) {
        const c = m < cos.length ? cos[m] : 0;
        const s = m < sin.length ? sin[m] : 0;
        value += c * Math.cos(m * theta) + s * Math.sin(m * theta);
    }
    return value;
}

/**
 * Sample a Fourier-series curve source into a dense polyline.
 *
 * ``x(theta) = sum_{m=0..order} cosX[m]*cos(m*theta) + sinX[m]*sin(m*theta)``,
 * likewise for ``y`` and ``z``. ``theta`` is sampled uniformly over ``[0, 2pi)``.
 * The ``nfp`` field is metadata only and does not fold into the modes.
 *
 * The series is periodic in ``theta`` by construction, so the first point is
 * repeated exactly at the end of the returned polyline; the backend's
 * closed-curve detection then builds a periodic wire.
 */
export function sampleFourier(source: FourierCurveSource): CurvePoint[] {
    const { order, cosX, sinX, cosY, sinY, cosZ, sinZ, sampleCount } = source;
    const count = Math.max(2, Math.floor(sampleCount));
    const points: CurvePoint[] = [];
    for (let i = 0; i < count; i++) {
        const theta = (2 * Math.PI * i) / count;
        points.push([
            fourierValue(theta, order, cosX, sinX),
            fourierValue(theta, order, cosY, sinY),
            fourierValue(theta, order, cosZ, sinZ)
        ]);
    }
    points.push([points[0][0], points[0][1], points[0][2]]);
    return points;
}
