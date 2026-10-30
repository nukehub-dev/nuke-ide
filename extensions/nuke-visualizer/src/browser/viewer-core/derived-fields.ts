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
 * Derived-field (calculator) expressions + array statistics for the native
 * 3D output viewers.
 *
 * Closed mini-grammar over dataset arrays — NOT a general parser. The whole
 * language is:
 *
 * ```
 * expr := name | name '/' name | name '-' name | 'mag(' name ')' | 'log10(' name ')'
 * name := [A-Za-z_][A-Za-z0-9_.]*   (must match a dataset array, exact case)
 * ```
 *
 * Operands are always bare array names (no nesting, no literals, no unary
 * operators); anything else is a {@link DerivedFieldError} that the hosting
 * panel shows inline and never commits. Multi-component operands resolve
 * per tuple through the shared `tupleScalar` default (single-component
 * passes through, vectors collapse to their L2 magnitude), so the transient
 * result is always a single-component array the color-by pipeline in
 * `scalar-mapping.ts` consumes identically to a parsed array — including
 * divide-by-zero, which yields NaN per tuple and therefore routes through
 * the existing `nanColor` path (`log10` of a non-positive value is NaN for
 * the same reason).
 *
 * Pure functions + types only; no three.js, no DOM, no Theia imports.
 */

import { tupleScalar } from './scalar-mapping';

/** Rejected expressions surface as panel errors, never committed state. */
export class DerivedFieldError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DerivedFieldError';
    }
}

/** Dataset association a derived field inherits from its operands. */
export type DerivedFieldAssociation = 'point' | 'cell';

/** Minimal array shape the evaluator reads (satisfied by the parsed VTK arrays). */
export interface DerivedFieldSourceArray {
    readonly name: string;
    readonly association: DerivedFieldAssociation;
    readonly components: number;
    readonly values: ArrayLike<number>;
}

/** One parsed expression: operands stay bare names (the grammar has no nesting). */
export type DerivedFieldNode =
    | { readonly kind: 'array'; readonly name: string }
    | { readonly kind: 'subtract' | 'divide'; readonly left: string; readonly right: string }
    | { readonly kind: 'magnitude' | 'log10'; readonly argument: string };

/** A validated expression plus its normalized text and referenced arrays. */
export interface ParsedDerivedField {
    /** Canonical text (`a / b` normalizes to `a/b`); the transient array name derives from it. */
    readonly expression: string;
    readonly node: DerivedFieldNode;
    readonly arrays: readonly string[];
}

/** Prefix keeping transient results distinct from parsed dataset arrays. */
export const DERIVED_FIELD_PREFIX = 'derived';

/** Transient array name for a normalized expression (`derived(a/b)`). */
export function derivedFieldName(expression: string): string {
    return `${DERIVED_FIELD_PREFIX}(${expression})`;
}

const NAME_TOKEN = '[A-Za-z_][A-Za-z0-9_.]*';
const CALL_RE = new RegExp(`^(mag|log10)\\s*\\(\\s*(${NAME_TOKEN})\\s*\\)$`);
const BINARY_RE = new RegExp(`^(${NAME_TOKEN})\\s*(\\/|-)\\s*(${NAME_TOKEN})$`);
const NAME_RE = new RegExp(`^${NAME_TOKEN}$`);

const GRAMMAR_HELP = 'Supported forms: a/b, a-b, mag(v), log10(a) — where a, b, v are dataset array names.';

/**
 * Parse and validate one expression against the dataset's array names
 * (exact, case-sensitive). Throws {@link DerivedFieldError} on empty input,
 * unknown names, or anything outside the closed grammar.
 */
export function parseDerivedField(text: string, arrayNames: readonly string[]): ParsedDerivedField {
    const trimmed = text.trim();
    if (!trimmed) {
        throw new DerivedFieldError(`Enter a derived-field expression (for example upper_g1/lower_g1). ${GRAMMAR_HELP}`);
    }
    const known = new Set(arrayNames);
    const check = (name: string): void => {
        if (!known.has(name)) {
            throw new DerivedFieldError(`Unknown array "${name}" (no dataset array with that name). ${GRAMMAR_HELP}`);
        }
    };
    const call = CALL_RE.exec(trimmed);
    if (call) {
        const argument = call[2];
        check(argument);
        const node: DerivedFieldNode = call[1] === 'mag' ? { kind: 'magnitude', argument } : { kind: 'log10', argument };
        return { expression: `${call[1]}(${argument})`, node, arrays: [argument] };
    }
    const binary = BINARY_RE.exec(trimmed);
    if (binary) {
        const left = binary[1];
        const right = binary[3];
        check(left);
        check(right);
        const node: DerivedFieldNode = binary[2] === '/' ? { kind: 'divide', left, right } : { kind: 'subtract', left, right };
        return { expression: `${left}${binary[2]}${right}`, node, arrays: [left, right] };
    }
    if (NAME_RE.test(trimmed)) {
        check(trimmed);
        return { expression: trimmed, node: { kind: 'array', name: trimmed }, arrays: [trimmed] };
    }
    throw new DerivedFieldError(`Invalid derived-field expression "${trimmed}". ${GRAMMAR_HELP}`);
}

/** A materialized transient array: single-component, named `derived(<expr>)`. */
export interface DerivedFieldResult {
    readonly name: string;
    readonly association: DerivedFieldAssociation;
    readonly values: Float64Array;
    /** [min, max] over the finite values ([0, 0] when there are none). */
    readonly range: [number, number];
}

/**
 * Evaluate a parsed expression tuple-wise over the source arrays. All
 * referenced arrays must share one association and one tuple count, or a
 * {@link DerivedFieldError} is thrown. Divide-by-zero yields NaN per tuple
 * (never ±Infinity); `log10` of a non-positive or non-finite scalar is NaN.
 */
export function evaluateDerivedField(parsed: ParsedDerivedField, sources: readonly DerivedFieldSourceArray[]): DerivedFieldResult {
    const byName = new Map<string, DerivedFieldSourceArray>();
    for (const source of sources) {
        byName.set(source.name, source);
    }
    const operands = parsed.arrays.map((name) => {
        const source = byName.get(name);
        if (!source) {
            throw new DerivedFieldError(`Unknown array "${name}" (no dataset array with that name).`);
        }
        return source;
    });
    const association = operands[0].association;
    for (const operand of operands) {
        if (operand.association !== association) {
            throw new DerivedFieldError(
                `Cannot combine "${operands[0].name}" (${operands[0].association}) with "${operand.name}" (${operand.association}): derived fields combine point arrays with point arrays, or cell arrays with cell arrays.`
            );
        }
    }
    const tupleCount = Math.floor(operands[0].values.length / Math.max(1, operands[0].components));
    for (const operand of operands) {
        const count = Math.floor(operand.values.length / Math.max(1, operand.components));
        if (count !== tupleCount) {
            throw new DerivedFieldError(
                `Cannot combine "${operands[0].name}" (${tupleCount} tuples) with "${operand.name}" (${count} tuples): arrays must cover the same tuples.`
            );
        }
    }
    const scalarAt = (operand: DerivedFieldSourceArray, tuple: number): number => tupleScalar(operand.values, operand.components, tuple);
    const values = new Float64Array(tupleCount);
    const node = parsed.node;
    if (node.kind === 'array') {
        const operand = operands[0];
        for (let t = 0; t < tupleCount; t++) {
            values[t] = scalarAt(operand, t);
        }
    } else if (node.kind === 'subtract') {
        const [left, right] = operands;
        for (let t = 0; t < tupleCount; t++) {
            values[t] = scalarAt(left, t) - scalarAt(right, t);
        }
    } else if (node.kind === 'divide') {
        const [numerator, denominator] = operands;
        for (let t = 0; t < tupleCount; t++) {
            const divisor = scalarAt(denominator, t);
            values[t] = divisor === 0 ? Number.NaN : scalarAt(numerator, t) / divisor;
        }
    } else if (node.kind === 'magnitude') {
        const operand = operands[0];
        for (let t = 0; t < tupleCount; t++) {
            values[t] = scalarAt(operand, t);
        }
    } else {
        const operand = operands[0];
        for (let t = 0; t < tupleCount; t++) {
            const scalar = scalarAt(operand, t);
            values[t] = Number.isFinite(scalar) && scalar > 0 ? Math.log10(scalar) : Number.NaN;
        }
    }
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let t = 0; t < tupleCount; t++) {
        const value = values[t];
        if (Number.isFinite(value)) {
            if (value < min) {
                min = value;
            }
            if (value > max) {
                max = value;
            }
        }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
        min = 0;
        max = 0;
    }
    return { name: derivedFieldName(parsed.expression), association, values, range: [min, max] };
}

/** Summary statistics over one scalar series (finite values only). */
export interface ArrayStats {
    /** Total values seen (finite + non-finite). */
    readonly count: number;
    readonly finiteCount: number;
    readonly nonFiniteCount: number;
    /** NaN when there are no finite values. */
    readonly min: number;
    readonly max: number;
    readonly mean: number;
    /** Population standard deviation; NaN when there are no finite values. */
    readonly std: number;
}

/** Summarize one scalar series; non-finite values are counted and skipped. */
export function computeArrayStats(values: ArrayLike<number>): ArrayStats {
    let finiteCount = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    let sumSquares = 0;
    for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (!Number.isFinite(value)) {
            continue;
        }
        finiteCount++;
        if (value < min) {
            min = value;
        }
        if (value > max) {
            max = value;
        }
        sum += value;
        sumSquares += value * value;
    }
    if (finiteCount === 0) {
        return {
            count: values.length,
            finiteCount: 0,
            nonFiniteCount: values.length,
            min: Number.NaN,
            max: Number.NaN,
            mean: Number.NaN,
            std: Number.NaN
        };
    }
    const mean = sum / finiteCount;
    const variance = Math.max(0, sumSquares / finiteCount - mean * mean);
    return {
        count: values.length,
        finiteCount,
        nonFiniteCount: values.length - finiteCount,
        min,
        max,
        mean,
        std: Math.sqrt(variance)
    };
}

/** Equal-width histogram over the finite values of one scalar series. */
export interface ArrayHistogram {
    readonly binCount: number;
    readonly bins: readonly number[];
    /** `binCount + 1` edges spanning [min, max] (all equal when min === max). */
    readonly edges: readonly number[];
    readonly min: number;
    readonly max: number;
    readonly finiteCount: number;
}

/** Default bin count for the histogram readout. */
export const DEFAULT_HISTOGRAM_BINS = 20;

/** Hard cap keeping the SVG readout cheap. */
export const MAX_HISTOGRAM_BINS = 256;

/** Normalize a bins input (panel text field) to [1, MAX]; garbage falls back. */
export function normalizeHistogramBinCount(value: unknown, fallback: number = DEFAULT_HISTOGRAM_BINS): number {
    const parsed = typeof value === 'number' ? value : parseInt(String(value), 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
        return fallback;
    }
    return Math.min(parsed, MAX_HISTOGRAM_BINS);
}

/**
 * Bin one scalar series into equal-width bins over its finite [min, max].
 * With no finite values every bin is 0 and the edges are 0; with a
 * degenerate (min === max) range every finite value lands in the first bin.
 */
export function computeHistogram(values: ArrayLike<number>, binCount: number): ArrayHistogram {
    const count = normalizeHistogramBinCount(binCount);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let finiteCount = 0;
    for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (!Number.isFinite(value)) {
            continue;
        }
        finiteCount++;
        if (value < min) {
            min = value;
        }
        if (value > max) {
            max = value;
        }
    }
    if (finiteCount === 0) {
        return { binCount: count, bins: new Array(count).fill(0), edges: new Array(count + 1).fill(0), min: 0, max: 0, finiteCount: 0 };
    }
    const edges: number[] = [];
    for (let b = 0; b <= count; b++) {
        edges.push(min + ((max - min) * b) / count);
    }
    const bins = new Array<number>(count).fill(0);
    const width = max - min;
    for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (!Number.isFinite(value)) {
            continue;
        }
        const index = width <= 0 ? 0 : Math.min(count - 1, Math.floor(((value - min) / width) * count));
        bins[index]++;
    }
    return { binCount: count, bins, edges, min, max, finiteCount };
}
