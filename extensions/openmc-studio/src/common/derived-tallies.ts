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
 * Pure derived-tally model: AST formatting/parsing, the visual token editor
 * helpers, validation against project tallies, bin estimation, and a
 * reference evaluator used by unit tests and previews.
 *
 * The authoritative statepoint evaluation happens in
 * `python/derive_tallies.py` (OpenMC `StatePoint` moments and uncertainty
 * propagation); this module only reasons about the expression and the project
 * definition so the UI and tests share one rule set.
 *
 * Formulas use the compact, parseable form `T1[flux] / T2[fission]` and
 * `T1[flux:U235]` for a nuclide-restricted operand.
 *
 * @module openmc-studio/common
 */

import {
    OpenMCDerivedExpression,
    OpenMCDerivedOperand,
    OpenMCDerivedTally,
    OpenMCMesh,
    OpenMCTally,
    OpenMCTallyFilter
} from './openmc-state-schema';
import { getMeshElementCount } from './mesh-utils';

/** One token in the visual expression editor. */
export type OpenMCDerivedToken =
    | { kind: 'operand'; operand: OpenMCDerivedOperand }
    | { kind: 'operator'; op: '+' | '-' | '*' | '/' }
    | { kind: 'paren'; value: '(' | ')' };

/** Validation issue emitted for a derived-tally draft. */
export interface DerivedTallyValidationIssue {
    severity: 'error' | 'warning';
    /** Stable machine-readable reason (used by tests and inline grouping). */
    code: string;
    /** Cause + fix shown in the builder. */
    message: string;
}

/** Error raised when the reference evaluator cannot combine two values. */
export class DerivedExpressionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DerivedExpressionError';
    }
}

/** Resolved operand value used by the reference evaluator. */
export interface DerivedTallyValue {
    mean: number[];
    stdDev: number[];
}

/** Resolver for tally operands in the reference evaluator. */
export type DerivedOperandResolver = (operand: Extract<OpenMCDerivedOperand, { kind: 'tally' }>) => DerivedTallyValue;

/** Result of parsing a formula string. */
export interface DerivedFormulaParseResult {
    expression?: OpenMCDerivedExpression;
    error?: string;
}

const OPERATORS = new Set(['+', '-', '*', '/']);

/** Format a number deterministically: integers stay integral, others use JS notation. */
export function formatDerivedNumber(value: number): string {
    if (Object.is(value, -0) || value === 0) {
        return '0';
    }
    return String(value);
}

/** Render one operand in formula notation. */
export function formatDerivedOperand(operand: OpenMCDerivedOperand): string {
    if (operand.kind === 'scalar') {
        return formatDerivedNumber(operand.value);
    }
    const nuclide = operand.nuclide ? `:${operand.nuclide}` : '';
    return `T${operand.tallyId}[${operand.score}${nuclide}]`;
}

function binaryPrecedence(op: '+' | '-' | '*' | '/'): number {
    return op === '+' || op === '-' ? 1 : 2;
}

function formatChild(expression: OpenMCDerivedExpression, parentOp: '+' | '-' | '*' | '/', right: boolean): string {
    const text = formatDerivedExpression(expression);
    if (expression.kind !== 'binary') {
        return text;
    }
    const parentPrecedence = binaryPrecedence(parentOp);
    const childPrecedence = binaryPrecedence(expression.op);
    const needsParens = childPrecedence < parentPrecedence || (right && childPrecedence === parentPrecedence);
    return needsParens ? `(${text})` : text;
}

/**
 * Canonical, round-trippable formula for an expression. Parentheses are added
 * only where precedence requires them, so `format(parse(text))` is stable.
 */
export function formatDerivedExpression(expression: OpenMCDerivedExpression): string {
    if (expression.kind === 'tally' || expression.kind === 'scalar') {
        return formatDerivedOperand(expression);
    }
    if (expression.kind === 'unary') {
        const operand =
            expression.operand.kind === 'binary'
                ? `(${formatDerivedExpression(expression.operand)})`
                : formatDerivedExpression(expression.operand);
        return `-${operand}`;
    }
    return `${formatChild(expression.left, expression.op, false)} ${expression.op} ${formatChild(expression.right, expression.op, true)}`;
}

/** Text for one editor token. */
export function derivedTokenText(token: OpenMCDerivedToken): string {
    if (token.kind === 'operand') {
        return formatDerivedOperand(token.operand);
    }
    if (token.kind === 'operator') {
        return token.op;
    }
    return token.value;
}

/** Join tokens into the text the formula parser consumes. */
export function tokensToFormula(tokens: readonly OpenMCDerivedToken[]): string {
    return tokens.map(derivedTokenText).join(' ');
}

class FormulaParser {
    private index = 0;

    constructor(private readonly text: string) {}

    parse(): OpenMCDerivedExpression {
        this.skipWhitespace();
        if (this.index >= this.text.length) {
            throw new Error('Expression is empty');
        }
        const expression = this.parseExpression();
        this.skipWhitespace();
        if (this.index < this.text.length) {
            throw new Error(`Unexpected "${this.text.slice(this.index)}" at position ${this.index + 1}`);
        }
        return expression;
    }

    private skipWhitespace(): void {
        while (this.index < this.text.length && /\s/.test(this.text[this.index])) {
            this.index += 1;
        }
    }

    private peek(): string {
        return this.text[this.index] ?? '';
    }

    private parseExpression(): OpenMCDerivedExpression {
        let left = this.parseTerm();
        for (;;) {
            this.skipWhitespace();
            const op = this.peek();
            if (op !== '+' && op !== '-') {
                return left;
            }
            this.index += 1;
            const right = this.parseTerm();
            left = { kind: 'binary', op, left, right };
        }
    }

    private parseTerm(): OpenMCDerivedExpression {
        let left = this.parseFactor();
        for (;;) {
            this.skipWhitespace();
            const op = this.peek();
            if (op !== '*' && op !== '/') {
                return left;
            }
            this.index += 1;
            const right = this.parseFactor();
            left = { kind: 'binary', op, left, right };
        }
    }

    private parseFactor(): OpenMCDerivedExpression {
        this.skipWhitespace();
        if (this.peek() === '-') {
            this.index += 1;
            return { kind: 'unary', op: '-', operand: this.parseFactor() };
        }
        return this.parsePrimary();
    }

    private parsePrimary(): OpenMCDerivedExpression {
        this.skipWhitespace();
        if (this.peek() === '(') {
            this.index += 1;
            const expression = this.parseExpression();
            this.skipWhitespace();
            if (this.peek() !== ')') {
                throw new Error(`Expected ")" at position ${this.index + 1}`);
            }
            this.index += 1;
            return expression;
        }
        if (this.peek() === '[') {
            throw new Error(`Unexpected "[" at position ${this.index + 1}; write an operand as T1[flux]`);
        }
        const rest = this.text.slice(this.index);
        const tallyMatch = /^[Tt]\s*(\d+)\s*\[/.exec(rest);
        if (tallyMatch) {
            this.index += tallyMatch[0].length;
            const closing = this.text.indexOf(']', this.index);
            if (closing < 0) {
                throw new Error(`Missing "]" for the tally operand starting at position ${this.index + 1}`);
            }
            const body = this.text.slice(this.index, closing).trim();
            this.index = closing + 1;
            if (!body) {
                throw new Error('Tally operand needs a score, for example T1[flux]');
            }
            const separator = body.indexOf(':');
            const score = (separator >= 0 ? body.slice(0, separator) : body).trim();
            const nuclide = separator >= 0 ? body.slice(separator + 1).trim() : undefined;
            if (!score) {
                throw new Error('Tally operand needs a score before ":"');
            }
            if (nuclide !== undefined && !nuclide) {
                throw new Error('Tally operand has an empty nuclide after ":"');
            }
            const tallyId = Number(tallyMatch[1]);
            if (!Number.isSafeInteger(tallyId) || tallyId <= 0) {
                throw new Error(`Tally ID must be a positive integer, got ${tallyMatch[1]}`);
            }
            return { kind: 'tally', tallyId, score, ...(nuclide ? { nuclide } : {}) };
        }
        if (/^\d|^\.\d/.test(rest)) {
            const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
            if (!match) {
                throw new Error(`Invalid number at position ${this.index + 1}`);
            }
            const value = Number(match[0]);
            if (!Number.isFinite(value)) {
                throw new Error(`Number "${match[0]}" is not finite`);
            }
            this.index += match[0].length;
            return { kind: 'scalar', value };
        }
        throw new Error(`Unexpected "${rest.slice(0, 12)}" at position ${this.index + 1}; expected an operand, number, "(", or "-"`);
    }
}

/**
 * Parse a formula string into an expression tree. Returns a user-facing error
 * instead of throwing, so the advanced text toggle can validate inline.
 */
export function parseDerivedFormula(text: string): DerivedFormulaParseResult {
    try {
        const expression = new FormulaParser(text).parse();
        return { expression };
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}

function tokenizeCanonical(expression: OpenMCDerivedExpression): OpenMCDerivedToken[] {
    // Walk the canonical formula so inserted parentheses exactly reproduce the
    // tree; formatting is the single source of truth for the editor text.
    const formula = formatDerivedExpression(expression);
    const tokens: OpenMCDerivedToken[] = [];
    let index = 0;
    while (index < formula.length) {
        const char = formula[index];
        if (/\s/.test(char)) {
            index += 1;
            continue;
        }
        if (char === '(' || char === ')') {
            tokens.push({ kind: 'paren', value: char });
            index += 1;
            continue;
        }
        if (OPERATORS.has(char)) {
            tokens.push({ kind: 'operator', op: char as '+' | '-' | '*' | '/' });
            index += 1;
            continue;
        }
        if (char === 'T' || char === 't') {
            const rest = formula.slice(index);
            const match = /^[Tt]\s*(\d+)\s*\[[^\]]*\]/.exec(rest);
            if (!match) {
                index += 1;
                continue;
            }
            const operand = parseDerivedFormula(match[0]).expression;
            if (operand) {
                tokens.push({ kind: 'operand', operand: operand as OpenMCDerivedOperand });
            }
            index += match[0].length;
            continue;
        }
        const numberMatch = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(formula.slice(index));
        if (numberMatch) {
            tokens.push({ kind: 'operand', operand: { kind: 'scalar', value: Number(numberMatch[0]) } });
            index += numberMatch[0].length;
            continue;
        }
        index += 1;
    }
    return tokens;
}

/**
 * Convert an expression tree to editor tokens, including the parentheses
 * needed to preserve grouping (`expressionToTokens(tokensToExpression(t))`).
 */
export function expressionToTokens(expression: OpenMCDerivedExpression): OpenMCDerivedToken[] {
    return tokenizeCanonical(expression);
}

/** Parse editor tokens into an expression tree. */
export function tokensToExpression(tokens: readonly OpenMCDerivedToken[]): DerivedFormulaParseResult {
    return parseDerivedFormula(tokensToFormula(tokens));
}

/** Append a token, returning a new array (never mutates the input). */
export function appendDerivedToken(tokens: readonly OpenMCDerivedToken[], token: OpenMCDerivedToken): OpenMCDerivedToken[] {
    return [...tokens, token];
}

/** Remove the last token, returning a new array (never mutates the input). */
export function removeLastDerivedToken(tokens: readonly OpenMCDerivedToken[]): OpenMCDerivedToken[] {
    return tokens.slice(0, -1);
}

/** Collect every tally operand in evaluation order. */
export function collectTallyOperands(expression: OpenMCDerivedExpression): Extract<OpenMCDerivedOperand, { kind: 'tally' }>[] {
    if (expression.kind === 'tally') {
        return [expression];
    }
    if (expression.kind === 'scalar') {
        return [];
    }
    if (expression.kind === 'unary') {
        return collectTallyOperands(expression.operand);
    }
    return [...collectTallyOperands(expression.left), ...collectTallyOperands(expression.right)];
}

/** Numeric value of a scalar-only subtree, or undefined when it references a tally. */
export function constantExpressionValue(expression: OpenMCDerivedExpression): number | undefined {
    if (expression.kind === 'scalar') {
        return Number.isFinite(expression.value) ? expression.value : undefined;
    }
    if (expression.kind === 'tally') {
        return undefined;
    }
    if (expression.kind === 'unary') {
        const value = constantExpressionValue(expression.operand);
        return value === undefined ? undefined : -value;
    }
    const left = constantExpressionValue(expression.left);
    const right = constantExpressionValue(expression.right);
    if (left === undefined || right === undefined) {
        return undefined;
    }
    switch (expression.op) {
        case '+':
            return left + right;
        case '-':
            return left - right;
        case '*':
            return left * right;
        case '/':
            return right === 0 ? undefined : left / right;
    }
}

function canonicalFilterBins(filter: OpenMCTallyFilter): unknown {
    switch (filter.type) {
        case 'cellinstance':
        case 'meshmaterial':
            return filter.pairs && filter.pairs.length > 0 ? filter.pairs.map((pair) => [pair.first, pair.second]) : filter.bins;
        case 'parentnuclide':
            return filter.nuclideBins ?? filter.bins;
        case 'reaction':
            return filter.reactionBins ?? filter.bins;
        case 'particleproduction':
            return [filter.particleTypes ?? [], filter.productionEnergyBins ?? []];
        default:
            return filter.bins;
    }
}

function filterTransformKey(filter: OpenMCTallyFilter): string {
    return JSON.stringify([filter.meshId ?? null, filter.meshTranslation ?? null, filter.meshRotation ?? null]);
}

function filterSignature(filter: OpenMCTallyFilter): string {
    return JSON.stringify([filter.type, canonicalFilterBins(filter), filterTransformKey(filter)]);
}

const EDGE_FILTER_TYPES = new Set(['energy', 'energyout', 'time', 'mu', 'polar', 'azimuthal', 'musurface', 'weight']);

/** Number of result bins contributed by one state filter (best effort before a run). */
function filterBinCount(filter: OpenMCTallyFilter, meshes: readonly OpenMCMesh[]): number {
    switch (filter.type) {
        case 'cellinstance':
        case 'meshmaterial':
            return Math.max(1, filter.pairs?.length ?? Math.floor(filter.bins.length / 2));
        case 'parentnuclide':
            return Math.max(1, filter.nuclideBins?.length ?? filter.bins.length);
        case 'reaction':
            return Math.max(1, filter.reactionBins?.length ?? filter.bins.length);
        case 'particleproduction': {
            const particles = Math.max(1, filter.particleTypes?.length ?? 1);
            const energies = filter.productionEnergyBins?.length ?? 0;
            return particles * (energies > 1 ? energies - 1 : 1);
        }
        case 'energyfunction':
            return Math.max(1, filter.energyValues?.length ?? filter.bins.length);
        case 'mesh':
        case 'meshsurface':
        case 'meshborn': {
            const mesh = meshes.find((entry) => entry.id === filter.meshId);
            return mesh ? (getMeshElementCount(mesh) ?? 1) : 1;
        }
        default:
            if (EDGE_FILTER_TYPES.has(filter.type) && filter.bins.length > 1) {
                return filter.bins.length - 1;
            }
            return Math.max(1, filter.bins.length);
    }
}

function tallyLabel(tally: OpenMCTally): string {
    return `Tally ${tally.id}${tally.name ? ` (${tally.name})` : ''}`;
}

function filterLabel(type: string): string {
    return type === 'cellinstance' ? 'cell-instance' : type;
}

/**
 * Validate a derived-tally draft against the project tallies and the other
 * derived tallies. Messages state cause + fix; empty result means valid.
 */
export function validateDerivedTally(
    candidate: Pick<OpenMCDerivedTally, 'id' | 'name' | 'expression'>,
    tallies: readonly OpenMCTally[],
    derivedTallies: readonly OpenMCDerivedTally[] = []
): DerivedTallyValidationIssue[] {
    const issues: DerivedTallyValidationIssue[] = [];
    const name = candidate.name?.trim() ?? '';
    if (!name) {
        issues.push({
            severity: 'error',
            code: 'name-required',
            message: 'Give the derived tally a name so it can be identified in results.'
        });
    }
    const duplicate = derivedTallies.find((entry) => entry.id !== candidate.id && entry.name.trim().toLowerCase() === name.toLowerCase());
    if (name && duplicate) {
        issues.push({
            severity: 'error',
            code: 'duplicate-name',
            message: `Another derived tally is already named "${duplicate.name}". Choose a unique name.`
        });
    }

    const tallyOperands = collectTallyOperands(candidate.expression);
    if (tallyOperands.length === 0) {
        issues.push({
            severity: 'error',
            code: 'empty-expression',
            message: 'Add at least one tally score operand; a derived tally needs something to evaluate.'
        });
    }

    const validatedTallies = new Map<number, OpenMCTally>();
    for (const operand of tallyOperands) {
        const tally = tallies.find((entry) => entry.id === operand.tallyId);
        if (!tally) {
            issues.push({
                severity: 'error',
                code: 'unknown-tally',
                message: `Tally ${operand.tallyId} does not exist in this project. Pick an existing tally.`
            });
            continue;
        }
        validatedTallies.set(tally.id, tally);
        if (!tally.scores.includes(operand.score)) {
            const available = tally.scores.length > 0 ? tally.scores.join(', ') : 'none';
            issues.push({
                severity: 'error',
                code: 'unknown-score',
                message: `${tallyLabel(tally)} does not score "${operand.score}" (available: ${available}). Pick one of its scores.`
            });
        }
        if (operand.nuclide && tally.nuclides.length > 0 && !tally.nuclides.includes(operand.nuclide)) {
            const available = tally.nuclides.join(', ');
            issues.push({
                severity: 'error',
                code: 'unknown-nuclide',
                message: `${tallyLabel(tally)} does not track "${operand.nuclide}" (available: ${available}). Pick one of its nuclides or leave the operand unrestricted.`
            });
        }
    }

    // Same filter type with different bins is ambiguous: the axes cannot be
    // aligned one-to-one and OpenMC's own arithmetic can reject the pair.
    const filtersByType = new Map<string, { signature: string; tally: OpenMCTally }[]>();
    for (const tally of validatedTallies.values()) {
        for (const filter of tally.filters) {
            const entries = filtersByType.get(filter.type) ?? [];
            entries.push({ signature: filterSignature(filter), tally });
            filtersByType.set(filter.type, entries);
        }
    }
    for (const [type, entries] of filtersByType) {
        const signatures = new Set(entries.map((entry) => entry.signature));
        if (signatures.size > 1) {
            const names = [...new Set(entries.map((entry) => tallyLabel(entry.tally)))].join(' and ');
            issues.push({
                severity: 'error',
                code: 'incompatible-filter-bins',
                message: `The ${filterLabel(type)} filter bins differ between ${names}. Use the same bins on both tallies or restrict the expression to one of them.`
            });
        }
    }

    issues.push(...validateFiniteScalars(candidate.expression));
    issues.push(...validateDivisionByZero(candidate.expression));
    return issues;
}

function validateFiniteScalars(expression: OpenMCDerivedExpression): DerivedTallyValidationIssue[] {
    if (expression.kind === 'scalar') {
        return Number.isFinite(expression.value)
            ? []
            : [{ severity: 'error', code: 'non-finite-scalar', message: 'Scalar operands must be finite numbers.' }];
    }
    if (expression.kind === 'unary') {
        return validateFiniteScalars(expression.operand);
    }
    if (expression.kind === 'binary') {
        return [...validateFiniteScalars(expression.left), ...validateFiniteScalars(expression.right)];
    }
    return [];
}

function validateDivisionByZero(expression: OpenMCDerivedExpression): DerivedTallyValidationIssue[] {
    if (expression.kind === 'binary') {
        const issues = [...validateDivisionByZero(expression.left), ...validateDivisionByZero(expression.right)];
        if (expression.op === '/') {
            const divisor = constantExpressionValue(expression.right);
            if (divisor === 0) {
                issues.push({
                    severity: 'error',
                    code: 'division-by-zero',
                    message: 'The expression divides by a scalar zero. Replace the divisor with a non-zero value.'
                });
            }
        }
        return issues;
    }
    if (expression.kind === 'unary') {
        return validateDivisionByZero(expression.operand);
    }
    return [];
}

/**
 * Estimated result bins from project metadata (filters + nuclides), or
 * undefined when the operand filter bins are incompatible. The authoritative
 * count comes from the statepoint; this is the builder preview.
 */
export function estimateDerivedBins(
    expression: OpenMCDerivedExpression,
    tallies: readonly OpenMCTally[],
    meshes: readonly OpenMCMesh[] = []
): number | undefined {
    const operands = collectTallyOperands(expression);
    if (operands.length === 0) {
        return undefined;
    }
    const axes = new Map<string, { signature: string; bins: number }>();
    const nuclideLists: string[][] = [];
    const seenTallies = new Set<number>();
    for (const operand of operands) {
        const tally = tallies.find((entry) => entry.id === operand.tallyId);
        if (!tally) {
            return undefined;
        }
        for (const filter of tally.filters) {
            const signature = filterSignature(filter);
            const existing = axes.get(filter.type);
            if (existing && existing.signature !== signature) {
                return undefined;
            }
            if (!existing) {
                axes.set(filter.type, { signature, bins: filterBinCount(filter, meshes) });
            }
        }
        if (!operand.nuclide && !seenTallies.has(tally.id)) {
            nuclideLists.push(tally.nuclides.length > 0 ? tally.nuclides : ['total']);
        }
        seenTallies.add(tally.id);
    }
    const filterBins = [...axes.values()].reduce((product, axis) => product * Math.max(1, axis.bins), 1);
    let nuclideBins = 1;
    if (nuclideLists.length > 0) {
        const first = JSON.stringify(nuclideLists[0]);
        const identical = nuclideLists.every((list) => JSON.stringify(list) === first);
        nuclideBins = identical ? nuclideLists[0].length : nuclideLists.reduce((product, list) => product * list.length, 1);
    }
    return filterBins * nuclideBins;
}

function combineScalar(left: number, right: number, op: '+' | '-' | '*' | '/'): number {
    switch (op) {
        case '+':
            return left + right;
        case '-':
            return left - right;
        case '*':
            return left * right;
        case '/':
            if (right === 0) {
                throw new DerivedExpressionError('Division by zero in the derived-tally expression.');
            }
            return left / right;
    }
}

function ensureSameShape(left: DerivedTallyValue, right: DerivedTallyValue): void {
    if (left.mean.length !== right.mean.length || left.stdDev.length !== right.stdDev.length) {
        throw new DerivedExpressionError(
            `Operand shapes differ (${left.mean.length} bins vs ${right.mean.length} bins). Use tallies with the same filter bins or select a single nuclide.`
        );
    }
}

function vectorBinary(left: DerivedTallyValue, right: DerivedTallyValue, op: '+' | '-' | '*' | '/'): DerivedTallyValue {
    ensureSameShape(left, right);
    const mean: number[] = [];
    const stdDev: number[] = [];
    for (let index = 0; index < left.mean.length; index += 1) {
        const a = left.mean[index];
        const b = right.mean[index];
        if (op === '+' || op === '-') {
            mean.push(op === '+' ? a + b : a - b);
            stdDev.push(Math.sqrt(left.stdDev[index] ** 2 + right.stdDev[index] ** 2));
        } else if (op === '*') {
            const value = a * b;
            if (a === 0 || b === 0) {
                mean.push(0);
                stdDev.push(0);
                continue;
            }
            const relative = Math.sqrt((left.stdDev[index] / a) ** 2 + (right.stdDev[index] / b) ** 2);
            mean.push(value);
            stdDev.push(Math.abs(value) * relative);
        } else {
            if (b === 0) {
                throw new DerivedExpressionError(`Division by zero at bin ${index + 1}. Remove or constrain the zero-valued denominator.`);
            }
            const value = a / b;
            if (a === 0) {
                mean.push(0);
                stdDev.push(0);
                continue;
            }
            const relative = Math.sqrt((left.stdDev[index] / a) ** 2 + (right.stdDev[index] / b) ** 2);
            mean.push(value);
            stdDev.push(Math.abs(value) * relative);
        }
    }
    return { mean, stdDev };
}

function scalarBinary(
    left: number | DerivedTallyValue,
    right: number | DerivedTallyValue,
    op: '+' | '-' | '*' | '/'
): number | DerivedTallyValue {
    if (typeof left === 'number' && typeof right === 'number') {
        return combineScalar(left, right, op);
    }
    if (typeof left === 'number' && typeof right !== 'number') {
        switch (op) {
            case '+':
                return { mean: right.mean.map((value) => left + value), stdDev: [...right.stdDev] };
            case '-':
                return { mean: right.mean.map((value) => left - value), stdDev: [...right.stdDev] };
            case '*':
                return { mean: right.mean.map((value) => left * value), stdDev: right.stdDev.map((value) => Math.abs(left) * value) };
            case '/':
                return {
                    mean: right.mean.map((value, index) => {
                        if (value === 0) {
                            throw new DerivedExpressionError(`Division by zero at bin ${index + 1}.`);
                        }
                        return left / value;
                    }),
                    stdDev: right.mean.map((value, index) =>
                        value === 0 ? 0 : Math.abs(left / value) * (right.stdDev[index] / Math.abs(value))
                    )
                };
        }
    }
    if (typeof left !== 'number' && typeof right === 'number') {
        switch (op) {
            case '+':
                return { mean: left.mean.map((value) => value + right), stdDev: [...left.stdDev] };
            case '-':
                return { mean: left.mean.map((value) => value - right), stdDev: [...left.stdDev] };
            case '*':
                return { mean: left.mean.map((value) => value * right), stdDev: left.stdDev.map((value) => Math.abs(right) * value) };
            case '/':
                if (right === 0) {
                    throw new DerivedExpressionError('Division by a scalar zero.');
                }
                return { mean: left.mean.map((value) => value / right), stdDev: left.stdDev.map((value) => Math.abs(1 / right) * value) };
        }
    }
    return vectorBinary(left as DerivedTallyValue, right as DerivedTallyValue, op);
}

/**
 * Reference evaluator over scalar/vector values. It mirrors OpenMC's
 * independent-tally uncertainty formulas and validates shapes/division so the
 * pure AST tests can assert precedence and arithmetic without OpenMC.
 */
export function evaluateDerivedExpression(
    expression: OpenMCDerivedExpression,
    resolve: DerivedOperandResolver
): number | DerivedTallyValue {
    if (expression.kind === 'scalar') {
        return expression.value;
    }
    if (expression.kind === 'tally') {
        return resolve(expression);
    }
    if (expression.kind === 'unary') {
        const value = evaluateDerivedExpression(expression.operand, resolve);
        return typeof value === 'number' ? -value : { mean: value.mean.map((entry) => -entry), stdDev: [...value.stdDev] };
    }
    const left = evaluateDerivedExpression(expression.left, resolve);
    const right = evaluateDerivedExpression(expression.right, resolve);
    return scalarBinary(left, right, expression.op);
}

/** Aggregate finite bins for comparison views (sum of means, quadrature std). */
export function aggregateDerivedBins(mean: readonly number[], stdDev: readonly number[]): { value: number; stdDev: number; bins: number } {
    let value = 0;
    let variance = 0;
    let bins = 0;
    const count = Math.min(mean.length, stdDev.length);
    for (let index = 0; index < count; index += 1) {
        if (!Number.isFinite(mean[index])) {
            continue;
        }
        value += mean[index];
        const deviation = Number.isFinite(stdDev[index]) ? stdDev[index] : 0;
        variance += deviation ** 2;
        bins += 1;
    }
    return { value, stdDev: Math.sqrt(variance), bins };
}

/** Human-readable unit suffix for plot labels. */
export function derivedTallyUnitLabel(unit?: string): string {
    return unit?.trim() ? unit.trim() : 'value';
}

/** Formula preview with the operand default label when parsing failed. */
export function derivedFormulaPreview(tokens: readonly OpenMCDerivedToken[]): string {
    return tokensToFormula(tokens) || 'No expression yet';
}
