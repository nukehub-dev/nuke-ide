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
 * Units layer (FreeCAD-inspired): a numeric literal may carry a unit suffix
 * (``10mm``, ``10 mm``), and bare unit names (``mm``, ``deg``) evaluate to
 * unit quantities. Caller scopes may bind ``number`` (dimensionless) or
 * ``Quantity`` values. The unit-less ``evaluateExpression`` path rejects
 * ``quantity`` nodes with a clear error (unit syntax was a parse error before
 * the units layer, so silently folding ``10mm`` to SI in millimetre-scale
 * documents would be wrong); use ``evaluateQuantity`` for unit-aware
 * evaluation. The dimension-aware ``evaluateQuantity`` path enforces
 * per-operator rules (``+``/``-`` need equal units, ``*``/``/`` combine,
 * ``^`` needs a dimensionless — and, for dimensioned bases, integer —
 * exponent, trig takes angles, ``exp``/``log`` need dimensionless args) and
 * ``convertQuantity``/``coerceToQuantity`` convert with clear
 * ``Failed to convert`` errors on mismatch.
 *
 * Quantity values are stored in SI base units (metre, kilogram, second,
 * radian); use ``convertQuantity`` to read a value back in display units.
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
    | { readonly type: 'quantity'; readonly value: number; readonly unit: string }
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
            // Unit suffix bolt-on: a number directly followed by a known unit
            // name (``10mm`` or ``10 mm``) is a quantity literal. An explicit
            // ``*`` (``2*m``) never folds, so caller parameters keep working
            // and scope bindings shadow unit names at evaluation time.
            const suffix = peek();
            if (suffix.type === 'ident' && isKnownUnit(suffix.value)) {
                advance();
                return { type: 'quantity', value, unit: suffix.value };
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

/**
 * Base dimensions tracked by the units layer. This is the CAD-relevant
 * subset (length, mass, time, angle); derived units such as ``N`` or ``Pa``
 * are expressed as exponents over these bases.
 */
export type UnitDimension = 'length' | 'mass' | 'time' | 'angle';

/** Dimensional exponents; absent dimensions are zero. ``{}`` is dimensionless. */
export type Unit = Readonly<Partial<Record<UnitDimension, number>>>;

/** A value in SI base units (metre, kilogram, second, radian) plus its dimensions. */
export interface Quantity {
    readonly value: number;
    readonly unit: Unit;
}

/** Scope for the dimension-aware evaluator: plain numbers are dimensionless. */
export type QuantityScope = Record<string, number | Quantity>;

/** The dimensionless unit. */
export const DIMENSIONLESS: Unit = {};

const DIMENSIONS: readonly UnitDimension[] = ['length', 'mass', 'time', 'angle'];

const LENGTH: Unit = { length: 1 };
const MASS: Unit = { mass: 1 };
const TIME: Unit = { time: 1 };
const ANGLE: Unit = { angle: 1 };

interface UnitDefinition {
    /** Scale factor converting one of this unit into SI base units. */
    readonly scale: number;
    readonly unit: Unit;
}

// Note: single-letter aliases that would collide with common curve/parameter
// names are deliberately absent (``t`` is the curve parameter, so the tonne
// is ``tonne`` only; ``e`` stays Euler's constant).
const UNIT_TABLE: Record<string, UnitDefinition> = {
    mm: { scale: 0.001, unit: LENGTH },
    cm: { scale: 0.01, unit: LENGTH },
    m: { scale: 1, unit: LENGTH },
    km: { scale: 1000, unit: LENGTH },
    um: { scale: 1e-6, unit: LENGTH },
    nm: { scale: 1e-9, unit: LENGTH },
    in: { scale: 0.0254, unit: LENGTH },
    inch: { scale: 0.0254, unit: LENGTH },
    ft: { scale: 0.3048, unit: LENGTH },
    mil: { scale: 0.0000254, unit: LENGTH },
    mg: { scale: 1e-6, unit: MASS },
    g: { scale: 0.001, unit: MASS },
    kg: { scale: 1, unit: MASS },
    tonne: { scale: 1000, unit: MASS },
    ms: { scale: 0.001, unit: TIME },
    s: { scale: 1, unit: TIME },
    min: { scale: 60, unit: TIME },
    h: { scale: 3600, unit: TIME },
    rad: { scale: 1, unit: ANGLE },
    deg: { scale: Math.PI / 180, unit: ANGLE },
    Hz: { scale: 1, unit: { time: -1 } },
    N: { scale: 1, unit: { mass: 1, length: 1, time: -2 } },
    kN: { scale: 1000, unit: { mass: 1, length: 1, time: -2 } },
    Pa: { scale: 1, unit: { mass: 1, length: -1, time: -2 } },
    kPa: { scale: 1000, unit: { mass: 1, length: -1, time: -2 } },
    MPa: { scale: 1e6, unit: { mass: 1, length: -1, time: -2 } },
    J: { scale: 1, unit: { mass: 1, length: 2, time: -2 } },
    kJ: { scale: 1000, unit: { mass: 1, length: 2, time: -2 } },
    W: { scale: 1, unit: { mass: 1, length: 2, time: -3 } },
    kW: { scale: 1000, unit: { mass: 1, length: 2, time: -3 } }
};

function lookupUnit(name: string): UnitDefinition | undefined {
    if (Object.prototype.hasOwnProperty.call(UNIT_TABLE, name)) {
        return UNIT_TABLE[name];
    }
    return undefined;
}

/** True when ``name`` is a known unit suffix (``mm``, ``deg``, ...). */
export function isKnownUnit(name: string): boolean {
    return lookupUnit(name) !== undefined;
}

/** Type guard for ``Quantity`` scope values. */
export function isQuantity(value: unknown): value is Quantity {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as Quantity).value === 'number' &&
        typeof (value as Quantity).unit === 'object' &&
        (value as Quantity).unit !== null
    );
}

/**
 * Resolve a unit name to its SI scale factor and dimensions.
 * Throws ``Unknown unit '<name>'`` for unregistered names.
 */
export function parseUnit(name: string): { readonly scale: number; readonly unit: Unit } {
    const definition = lookupUnit(name);
    if (definition === undefined) {
        throw new Error(`Unknown unit '${name}'`);
    }
    return definition;
}

function dimensionOf(unit: Unit, dimension: UnitDimension): number {
    return unit[dimension] ?? 0;
}

/** True when two units have identical dimensional exponents. */
export function unitEquals(a: Unit, b: Unit): boolean {
    return DIMENSIONS.every((dimension) => dimensionOf(a, dimension) === dimensionOf(b, dimension));
}

/** True for the dimensionless unit (``{}``). */
export function isDimensionless(unit: Unit): boolean {
    return unitEquals(unit, DIMENSIONLESS);
}

const UNIT_SYMBOLS: Record<UnitDimension, string> = { length: 'm', mass: 'kg', time: 's', angle: 'rad' };

/** Render dimensions in SI symbols (``m``, ``m^2``, ``m*kg/s^2``); ``''`` when dimensionless. */
export function unitToString(unit: Unit): string {
    const parts: string[] = [];
    for (const dimension of DIMENSIONS) {
        const exponent = dimensionOf(unit, dimension);
        if (exponent !== 0) {
            parts.push(exponent === 1 ? UNIT_SYMBOLS[dimension] : `${UNIT_SYMBOLS[dimension]}^${exponent}`);
        }
    }
    return parts.join('*');
}

/** Human-readable unit for error messages: SI symbols or ``dimensionless``. */
function describeUnit(unit: Unit): string {
    const text = unitToString(unit);
    return text === '' ? 'dimensionless' : text;
}

/** Render a quantity as ``<value> <unit>`` (``<value>`` alone when dimensionless). */
export function quantityToString(quantity: Quantity): string {
    const text = unitToString(quantity.unit);
    return text === '' ? `${quantity.value}` : `${quantity.value} ${text}`;
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
        case 'quantity': {
            // Unreachable through evaluateExpression (quantity nodes are
            // rejected up front by findQuantityUnit); kept as a fallback so a
            // quantity literal can never silently fold to SI here.
            // Dimension checks live in evaluateQuantity.
            const definition = lookupUnit(ast.unit);
            return definition === undefined ? ast.value : ast.value * definition.scale;
        }
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
 * unknown identifiers, division by zero, non-finite results, or unit syntax
 * (``quantity`` nodes — use {@link evaluateQuantity} for those).
 */
export function evaluateExpression(ast: Expr, scope: Record<string, number>): number {
    const quantity = findQuantityUnit(ast);
    if (quantity !== undefined) {
        throw new Error(
            `Expression uses unit '${quantity}' but the unit-less evaluator does not accept quantities; use evaluateQuantity instead`
        );
    }
    const value = evaluate(ast, scope);
    if (!Number.isFinite(value)) {
        throw new Error('Expression evaluated to a non-finite number');
    }
    return value;
}

/**
 * Unit name of the first ``quantity`` node in the AST, or undefined when the
 * expression is unit-free. The unit-less evaluator rejects any expression for
 * which this returns a name.
 */
function findQuantityUnit(ast: Expr): string | undefined {
    switch (ast.type) {
        case 'quantity':
            return ast.unit;
        case 'unary':
            return findQuantityUnit(ast.operand);
        case 'binary':
            return findQuantityUnit(ast.left) ?? findQuantityUnit(ast.right);
        case 'call':
            for (const arg of ast.args) {
                const unit = findQuantityUnit(arg);
                if (unit !== undefined) {
                    return unit;
                }
            }
            return undefined;
        default:
            return undefined;
    }
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

/** Combine two dimension vectors for ``*`` (sign +1) or ``/`` (sign -1). */
function combineUnits(a: Unit, b: Unit, sign: 1 | -1): Unit {
    const combined: Partial<Record<UnitDimension, number>> = {};
    for (const dimension of DIMENSIONS) {
        const exponent = dimensionOf(a, dimension) + sign * dimensionOf(b, dimension);
        if (exponent !== 0) {
            combined[dimension] = exponent;
        }
    }
    return combined;
}

/** Scale every dimensional exponent (used by ``^`` and ``sqrt``). */
function scaleUnitExponents(unit: Unit, factor: number): Unit {
    const scaled: Partial<Record<UnitDimension, number>> = {};
    for (const dimension of DIMENSIONS) {
        const exponent = dimensionOf(unit, dimension) * factor;
        if (exponent !== 0) {
            scaled[dimension] = exponent;
        }
    }
    return scaled;
}

function requireSameUnits(op: string, a: Quantity, b: Quantity): void {
    if (!unitEquals(a.unit, b.unit)) {
        throw new Error(`Cannot ${op} quantities with inconsistent units ('${describeUnit(a.unit)}' vs '${describeUnit(b.unit)}')`);
    }
}

function requireAngle(fn: string, arg: Quantity): void {
    if (!unitEquals(arg.unit, ANGLE)) {
        throw new Error(`${fn} expects an angle, got '${describeUnit(arg.unit)}'`);
    }
}

function requireDimensionless(fn: string, arg: Quantity): void {
    if (!isDimensionless(arg.unit)) {
        throw new Error(`${fn} expects a dimensionless argument, got '${describeUnit(arg.unit)}'`);
    }
}

function resolveQuantityIdent(name: string, scope: QuantityScope): Quantity {
    if (Object.prototype.hasOwnProperty.call(scope, name)) {
        const value = scope[name];
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) {
                throw new Error(`Identifier '${name}' resolved to a non-finite value`);
            }
            return { value, unit: DIMENSIONLESS };
        }
        if (!Number.isFinite(value.value)) {
            throw new Error(`Identifier '${name}' resolved to a non-finite value`);
        }
        return value;
    }
    if (name === 'pi') {
        return { value: Math.PI, unit: DIMENSIONLESS };
    }
    if (name === 'e') {
        return { value: Math.E, unit: DIMENSIONLESS };
    }
    // Scope bindings shadow unit names; a bare unit is one of that unit.
    const definition = lookupUnit(name);
    if (definition !== undefined) {
        return { value: definition.scale, unit: definition.unit };
    }
    throw new Error(`Unknown identifier '${name}'`);
}

function evaluateQuantityCall(name: string, args: readonly Quantity[]): Quantity {
    switch (name) {
        case 'sin':
        case 'cos':
        case 'tan': {
            if (args.length !== 1) {
                throw new Error(`${name} expects 1 argument`);
            }
            requireAngle(name, args[0]);
            const value = name === 'sin' ? Math.sin(args[0].value) : name === 'cos' ? Math.cos(args[0].value) : Math.tan(args[0].value);
            return { value, unit: DIMENSIONLESS };
        }
        case 'asin':
        case 'acos':
        case 'atan': {
            if (args.length !== 1) {
                throw new Error(`${name} expects 1 argument`);
            }
            requireDimensionless(name, args[0]);
            const value =
                name === 'asin' ? Math.asin(args[0].value) : name === 'acos' ? Math.acos(args[0].value) : Math.atan(args[0].value);
            return { value, unit: ANGLE };
        }
        case 'sqrt': {
            if (args.length !== 1) {
                throw new Error('sqrt expects 1 argument');
            }
            const arg = args[0];
            for (const dimension of DIMENSIONS) {
                if (dimensionOf(arg.unit, dimension) % 2 !== 0) {
                    throw new Error(`sqrt requires even unit exponents, got '${describeUnit(arg.unit)}'`);
                }
            }
            return { value: Math.sqrt(arg.value), unit: scaleUnitExponents(arg.unit, 0.5) };
        }
        case 'abs': {
            if (args.length !== 1) {
                throw new Error('abs expects 1 argument');
            }
            return { value: Math.abs(args[0].value), unit: args[0].unit };
        }
        case 'exp':
        case 'log': {
            if (args.length !== 1) {
                throw new Error(`${name} expects 1 argument`);
            }
            requireDimensionless(name, args[0]);
            return { value: name === 'exp' ? Math.exp(args[0].value) : Math.log(args[0].value), unit: DIMENSIONLESS };
        }
        case 'min':
        case 'max': {
            if (args.length === 0) {
                throw new Error(`${name} expects at least 1 argument`);
            }
            for (const arg of args) {
                if (!unitEquals(arg.unit, args[0].unit)) {
                    throw new Error(`${name} requires equal units, got '${describeUnit(args[0].unit)}' and '${describeUnit(arg.unit)}'`);
                }
            }
            const values = args.map((arg) => arg.value);
            return { value: name === 'min' ? Math.min(...values) : Math.max(...values), unit: args[0].unit };
        }
        default:
            throw new Error(`Unknown function '${name}'`);
    }
}

function evaluateQty(ast: Expr, scope: QuantityScope): Quantity {
    switch (ast.type) {
        case 'number':
            return { value: ast.value, unit: DIMENSIONLESS };
        case 'quantity': {
            const definition = parseUnit(ast.unit);
            return { value: ast.value * definition.scale, unit: definition.unit };
        }
        case 'ident':
            return resolveQuantityIdent(ast.name, scope);
        case 'unary': {
            const operand = evaluateQty(ast.operand, scope);
            return { value: -operand.value, unit: operand.unit };
        }
        case 'binary': {
            const left = evaluateQty(ast.left, scope);
            const right = evaluateQty(ast.right, scope);
            switch (ast.op) {
                case '+':
                case '-': {
                    requireSameUnits(ast.op === '+' ? 'add' : 'subtract', left, right);
                    return { value: ast.op === '+' ? left.value + right.value : left.value - right.value, unit: left.unit };
                }
                case '*':
                    return { value: left.value * right.value, unit: combineUnits(left.unit, right.unit, 1) };
                case '/': {
                    if (right.value === 0) {
                        throw new Error('Division by zero');
                    }
                    return { value: left.value / right.value, unit: combineUnits(left.unit, right.unit, -1) };
                }
                case '^': {
                    if (!isDimensionless(right.unit)) {
                        throw new Error(`Exponent must be dimensionless, got '${describeUnit(right.unit)}'`);
                    }
                    if (!isDimensionless(left.unit) && Math.abs(right.value - Math.round(right.value)) > 1e-9) {
                        throw new Error(`Exponent of a dimensioned quantity must be an integer, got ${right.value}`);
                    }
                    return { value: Math.pow(left.value, right.value), unit: scaleUnitExponents(left.unit, right.value) };
                }
            }
            break;
        }
        case 'call': {
            return evaluateQuantityCall(
                ast.name,
                ast.args.map((arg) => evaluateQty(arg, scope))
            );
        }
    }
}

/**
 * Dimension-aware counterpart of ``evaluateExpression``.
 *
 * Unit-less expressions behave exactly as in the unit-less path (plain
 * numbers are dimensionless). Throws a descriptive ``Error`` for
 * inconsistent units, gated functions, division by zero, unknown
 * identifiers/functions, or non-finite results.
 */
export function evaluateQuantity(ast: Expr, scope: QuantityScope): Quantity {
    const result = evaluateQty(ast, scope);
    if (!Number.isFinite(result.value)) {
        throw new Error('Expression evaluated to a non-finite number');
    }
    return result;
}

/**
 * Parse ``expr`` and evaluate it with units in one step.
 * Throws the parse error message on invalid syntax.
 */
export function parseAndEvaluateQuantity(expr: string, scope: QuantityScope): Quantity {
    const parsed = parseExpression(expr);
    if (!parsed.ok) {
        throw new Error(parsed.error);
    }
    return evaluateQuantity(parsed.ast, scope);
}

function resolveTargetUnit(target: Unit | string): { readonly scale: number; readonly unit: Unit } {
    return typeof target === 'string' ? parseUnit(target) : { scale: 1, unit: target };
}

function targetName(target: Unit | string): string {
    return typeof target === 'string' ? target : describeUnit(target);
}

/**
 * Read a quantity in the given target units (name or dimensions).
 *
 * Returns the numeric value expressed in ``target``; throws
 * ``Failed to convert ...`` when the dimensions differ.
 */
export function convertQuantity(quantity: Quantity, target: Unit | string, what = 'value'): number {
    const resolved = resolveTargetUnit(target);
    if (!unitEquals(quantity.unit, resolved.unit)) {
        throw new Error(
            `Failed to convert '${quantityToString(quantity)}' to '${targetName(target)}' for ${what}: ` +
                `inconsistent units ('${describeUnit(quantity.unit)}' vs '${describeUnit(resolved.unit)}')`
        );
    }
    return quantity.value / resolved.scale;
}

/**
 * Coerce an assigned value to the expected (declared) unit, FreeCAD-style.
 *
 * Plain numbers are taken as already expressed in the expected unit (or
 * dimensionless when no unit is declared); quantities are converted.
 * Throws ``Failed to convert ... for parameter '<name>'`` on mismatch.
 * The returned quantity is stored in SI base units.
 */
export function coerceToQuantity(value: number | Quantity, expectedUnit?: Unit | string, name = 'value'): Quantity {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error(`Parameter '${name}' resolved to a non-finite value`);
        }
        if (expectedUnit === undefined) {
            return { value, unit: DIMENSIONLESS };
        }
        const resolved = resolveTargetUnit(expectedUnit);
        return { value: value * resolved.scale, unit: resolved.unit };
    }
    if (!Number.isFinite(value.value)) {
        throw new Error(`Parameter '${name}' resolved to a non-finite value`);
    }
    if (expectedUnit === undefined) {
        return value;
    }
    const resolved = resolveTargetUnit(expectedUnit);
    if (!unitEquals(value.unit, resolved.unit)) {
        throw new Error(
            `Failed to convert '${quantityToString(value)}' to '${targetName(expectedUnit)}' for parameter '${name}': ` +
                `inconsistent units ('${describeUnit(value.unit)}' vs '${describeUnit(resolved.unit)}')`
        );
    }
    return { value: value.value, unit: resolved.unit };
}
