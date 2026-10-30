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
 * Find Data selection query core: a deliberately tiny, closed grammar
 * over the tuples of one numeric array.
 *
 * ```
 * value >= 1.5 | value < 0 | value == 10 | value != 0
 * value in [min, max]                (inclusive; `id` works the same way)
 * id == 42
 * name contains fuel                 (case-insensitive substring)
 * <predicate> and <predicate> ...    (and only: no OR, no nesting, no parens)
 * ```
 *
 * Field and keyword names are case-insensitive and whitespace is free-form.
 * `value` is the tuple scalar the color-by pipeline reads (`tupleScalar`):
 * single-component arrays pass through, multi-component arrays use the L2
 * magnitude. `id` reads `source.associations[tuple]` when supplied and falls
 * back to the tuple index, so `id == 42` locates row 42 on datasets without
 * explicit ids. `name` reads `source.names[tuple]` (categorical labels); a
 * `name contains` query without names is a typed evaluation error rather than
 * a silent empty selection.
 *
 * Non-finite values never satisfy a predicate — including `!=` and ranges —
 * because NaN is missing data, not an inequality. Inverted ranges, non-integer
 * id bounds, unknown fields/operators, and malformed literals are rejected at
 * parse time as {@link SelectionQueryError}s instead of producing a surprising
 * selection.
 *
 * The query never mutates the dataset: callers keep the returned transient
 * index set and decide how to paint/extract it. Pure functions + types only;
 * no three.js, no DOM, no Theia imports.
 */

import { tupleScalar } from './scalar-mapping';

// ============================================================================
// Typed errors
// ============================================================================

/** Why a query could not be parsed or evaluated. */
export type SelectionQueryErrorCode =
    | 'empty-query'
    | 'unknown-field'
    | 'invalid-operator'
    | 'invalid-value'
    | 'invalid-range'
    | 'invalid-connector'
    | 'syntax'
    | 'missing-names';

/** Typed query failure: `code` is stable for callers, `message` is user-facing. */
export class SelectionQueryError extends Error {
    readonly code: SelectionQueryErrorCode;
    /** Character offset of the failure in the query text (0 for evaluation errors). */
    readonly position: number;

    constructor(code: SelectionQueryErrorCode, message: string, position = 0) {
        super(message);
        this.name = 'SelectionQueryError';
        this.code = code;
        this.position = position;
    }
}

// ============================================================================
// AST
// ============================================================================

/** Numeric fields: the active array scalar, or the tuple id. */
export type SelectionNumericField = 'value' | 'id';

/** All fields the grammar understands. */
export type SelectionQueryField = SelectionNumericField | 'name';

/** Value comparison operators (`in` is a separate range predicate). */
export type SelectionComparisonOperator = '==' | '!=' | '<' | '<=' | '>' | '>=';

/** `field <op> number`. */
export interface SelectionComparePredicate {
    readonly kind: 'compare';
    readonly field: SelectionNumericField;
    readonly operator: SelectionComparisonOperator;
    readonly value: number;
}

/** `field in [min, max]` (inclusive on both ends). */
export interface SelectionRangePredicate {
    readonly kind: 'range';
    readonly field: SelectionNumericField;
    readonly min: number;
    readonly max: number;
}

/** `name contains text` (case-insensitive substring). */
export interface SelectionContainsPredicate {
    readonly kind: 'contains';
    readonly field: 'name';
    readonly text: string;
}

/** One parsed selection condition. */
export type SelectionPredicate = SelectionComparePredicate | SelectionRangePredicate | SelectionContainsPredicate;

/** Parsed query: conjunctive predicates plus the trimmed source text. */
export interface SelectionQuery {
    /** Trimmed query text exactly as parsed (kept for status/echo). */
    readonly text: string;
    /** Every predicate must pass for a tuple to be selected (AND semantics). */
    readonly predicates: readonly SelectionPredicate[];
}

// ============================================================================
// Evaluation source + result
// ============================================================================

/**
 * Data the query runs against. `values` is the flattened array (tuples of
 * `components` values); `names`/`associations` are the optional categorical
 * labels and per-tuple ids.
 */
export interface SelectionQuerySource {
    readonly values: ArrayLike<number>;
    /** Per-tuple ids for `id` predicates; the tuple index is the fallback. */
    readonly associations?: ArrayLike<number>;
    /** Per-tuple categorical labels for `name contains` predicates. */
    readonly names?: readonly string[];
    /** Values per tuple (default 1; multi-component tuples use the L2 magnitude for `value`). */
    readonly components?: number;
}

/** Counts shared by the evaluation result and the summary formatter. */
export interface SelectionCounts {
    /** Tuples that passed every predicate. */
    readonly matched: number;
    /** Tuples evaluated. */
    readonly total: number;
}

/** Evaluation result: selected tuple indices plus counts. */
export interface SelectionQueryResult extends SelectionCounts {
    /** Ascending 0-based tuple indices (a fresh `Uint32Array`, never a dataset view). */
    readonly indices: Uint32Array;
}

// ============================================================================
// Parser
// ============================================================================

interface Cursor {
    readonly text: string;
    position: number;
}

const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

function isWhitespace(char: string | undefined): boolean {
    return char !== undefined && /\s/.test(char);
}

function skipWhitespace(cursor: Cursor): void {
    while (isWhitespace(cursor.text[cursor.position])) {
        cursor.position++;
    }
}

function atEnd(cursor: Cursor): boolean {
    return cursor.position >= cursor.text.length;
}

function readIdentifier(cursor: Cursor): string | undefined {
    const match = IDENTIFIER_RE.exec(cursor.text.slice(cursor.position));
    if (!match) {
        return undefined;
    }
    cursor.position += match[0].length;
    return match[0];
}

function isFieldName(value: string): value is SelectionQueryField {
    return value === 'value' || value === 'id' || value === 'name';
}

/**
 * Read a numeric literal at the cursor. The literal must be followed by a
 * non-number character so `1.2.3`/`12abc` are rejected instead of silently
 * parsing as their valid prefix.
 */
function readNumber(cursor: Cursor): number | undefined {
    const match = NUMBER_RE.exec(cursor.text.slice(cursor.position));
    if (!match) {
        return undefined;
    }
    const next = cursor.text[cursor.position + match[0].length];
    if (next !== undefined && /[A-Za-z0-9_.]/.test(next)) {
        return undefined;
    }
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
        return undefined;
    }
    cursor.position += match[0].length;
    return value;
}

function readQuoted(cursor: Cursor): string {
    const quote = cursor.text[cursor.position];
    const start = cursor.position;
    cursor.position++;
    let out = '';
    while (cursor.position < cursor.text.length) {
        const char = cursor.text[cursor.position++];
        if (char === '\\' && cursor.position < cursor.text.length) {
            out += cursor.text[cursor.position++];
            continue;
        }
        if (char === quote) {
            return out;
        }
        out += char;
    }
    throw new SelectionQueryError('syntax', 'Unterminated quoted text', start);
}

function readBareWord(cursor: Cursor): string {
    const start = cursor.position;
    while (!atEnd(cursor) && !isWhitespace(cursor.text[cursor.position])) {
        cursor.position++;
    }
    return cursor.text.slice(start, cursor.position);
}

/**
 * Read the `contains` operand: a quoted string (spaces and `and` allowed), or
 * bare words joined by single spaces. A bare `and` ends the operand only when
 * a field name follows (another predicate starts) or the query ends (the
 * connector parser then reports the missing predicate), so
 * `name contains rock and roll` searches the whole phrase while
 * `name contains fuel and value > 1` combines two predicates.
 */
function readContainsText(cursor: Cursor): string {
    skipWhitespace(cursor);
    const quote = cursor.text[cursor.position];
    if (quote === '"' || quote === "'") {
        return readQuoted(cursor);
    }
    const words: string[] = [];
    while (true) {
        skipWhitespace(cursor);
        if (atEnd(cursor)) {
            break;
        }
        const wordStart = cursor.position;
        const word = readBareWord(cursor);
        if (word.toLowerCase() === 'and') {
            const afterWord = cursor.position;
            skipWhitespace(cursor);
            const next = atEnd(cursor) ? undefined : readIdentifier(cursor);
            if (next === undefined || isFieldName(next.toLowerCase())) {
                cursor.position = wordStart;
                break;
            }
            cursor.position = afterWord;
        }
        words.push(word);
    }
    return words.join(' ');
}

function parseRange(cursor: Cursor, field: SelectionNumericField): SelectionRangePredicate {
    skipWhitespace(cursor);
    if (cursor.text[cursor.position] !== '[') {
        throw new SelectionQueryError('syntax', "Expected '[' after 'in'", cursor.position);
    }
    cursor.position++;
    skipWhitespace(cursor);
    const min = readNumber(cursor);
    if (min === undefined) {
        throw new SelectionQueryError('invalid-value', "Expected a number after '['", cursor.position);
    }
    skipWhitespace(cursor);
    if (cursor.text[cursor.position] !== ',') {
        throw new SelectionQueryError('syntax', "Expected ',' between the range bounds", cursor.position);
    }
    cursor.position++;
    skipWhitespace(cursor);
    const max = readNumber(cursor);
    if (max === undefined) {
        throw new SelectionQueryError('invalid-value', "Expected a number after ','", cursor.position);
    }
    skipWhitespace(cursor);
    if (cursor.text[cursor.position] !== ']') {
        throw new SelectionQueryError('syntax', "Expected ']' to close the range", cursor.position);
    }
    cursor.position++;
    if (min > max) {
        throw new SelectionQueryError('invalid-range', `Range minimum ${min} exceeds maximum ${max}`, cursor.position);
    }
    if (field === 'id' && (!Number.isInteger(min) || !Number.isInteger(max))) {
        throw new SelectionQueryError('invalid-value', 'id range bounds must be integers', cursor.position);
    }
    return { kind: 'range', field, min, max };
}

function parseContains(cursor: Cursor): SelectionContainsPredicate {
    skipWhitespace(cursor);
    const start = cursor.position;
    const keyword = readIdentifier(cursor);
    if (keyword?.toLowerCase() !== 'contains') {
        throw new SelectionQueryError('invalid-operator', "The name field supports only 'contains'", start);
    }
    const text = readContainsText(cursor);
    if (text.trim().length === 0) {
        throw new SelectionQueryError('invalid-value', "Expected text after 'contains'", cursor.position);
    }
    return { kind: 'contains', field: 'name', text };
}

function parseNumericPredicate(cursor: Cursor, field: SelectionNumericField): SelectionComparePredicate | SelectionRangePredicate {
    skipWhitespace(cursor);
    const start = cursor.position;
    const twoChars = cursor.text.slice(start, start + 2);
    let operator: SelectionComparisonOperator | 'in' | undefined;
    if (twoChars === '==' || twoChars === '!=' || twoChars === '<=' || twoChars === '>=') {
        operator = twoChars as SelectionComparisonOperator;
        cursor.position += 2;
    } else {
        const single = cursor.text[start];
        if (single === '<' || single === '>') {
            operator = single;
            cursor.position++;
        } else {
            const word = readIdentifier(cursor);
            if (word?.toLowerCase() === 'in') {
                operator = 'in';
            } else if (word?.toLowerCase() === 'contains') {
                throw new SelectionQueryError('invalid-operator', "'contains' only applies to the name field", start);
            }
        }
    }
    if (operator === undefined) {
        throw new SelectionQueryError('invalid-operator', `Expected one of ==, !=, <, <=, >, >=, in for '${field}'`, start);
    }
    if (operator === 'in') {
        return parseRange(cursor, field);
    }
    skipWhitespace(cursor);
    const value = readNumber(cursor);
    if (value === undefined) {
        throw new SelectionQueryError('invalid-value', `Expected a number after '${operator}'`, cursor.position);
    }
    if (field === 'id' && !Number.isInteger(value)) {
        throw new SelectionQueryError('invalid-value', 'id values must be integers', cursor.position);
    }
    return { kind: 'compare', field, operator, value };
}

function parsePredicate(cursor: Cursor): SelectionPredicate {
    const start = cursor.position;
    const rawField = readIdentifier(cursor);
    if (rawField === undefined) {
        throw new SelectionQueryError('syntax', "Expected a field name: 'value', 'id', or 'name'", start);
    }
    const field = rawField.toLowerCase();
    if (!isFieldName(field)) {
        throw new SelectionQueryError('unknown-field', `Unknown field '${rawField}' (use value, id, or name)`, start);
    }
    if (field === 'name') {
        return parseContains(cursor);
    }
    return parseNumericPredicate(cursor, field);
}

function consumeConnector(cursor: Cursor): void {
    skipWhitespace(cursor);
    const start = cursor.position;
    const word = readIdentifier(cursor);
    if (word === undefined) {
        throw new SelectionQueryError('syntax', "Expected 'and' between predicates", start);
    }
    const lowered = word.toLowerCase();
    if (lowered === 'or') {
        throw new SelectionQueryError('invalid-connector', "Only 'and' can combine predicates (no OR)", start);
    }
    if (lowered !== 'and') {
        throw new SelectionQueryError('syntax', `Expected 'and' between predicates (found '${word}')`, start);
    }
    skipWhitespace(cursor);
    if (atEnd(cursor)) {
        throw new SelectionQueryError('syntax', "Expected a predicate after 'and'", cursor.position);
    }
}

/**
 * Parse the closed query grammar into an AST. Throws
 * {@link SelectionQueryError} with a stable `code` and user-facing message
 * for empty, malformed, or unsupported input.
 */
export function parseSelectionQuery(text: string): SelectionQuery {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
        throw new SelectionQueryError('empty-query', 'Enter a query, e.g. "value >= 1.5"');
    }
    const cursor: Cursor = { text, position: 0 };
    const predicates: SelectionPredicate[] = [];
    while (true) {
        skipWhitespace(cursor);
        if (atEnd(cursor)) {
            break;
        }
        predicates.push(parsePredicate(cursor));
        skipWhitespace(cursor);
        if (atEnd(cursor)) {
            break;
        }
        consumeConnector(cursor);
    }
    return { text: trimmed, predicates };
}

// ============================================================================
// Evaluation
// ============================================================================

function normalizeComponents(components: number | undefined): number {
    if (components === undefined || !Number.isFinite(components)) {
        return 1;
    }
    return Math.max(1, Math.floor(components));
}

/** Number of tuples in a query source (flattened length / components). */
export function selectionTupleCount(source: Pick<SelectionQuerySource, 'values' | 'components'>): number {
    return Math.max(0, Math.floor(source.values.length / normalizeComponents(source.components)));
}

function tupleId(source: SelectionQuerySource, tuple: number): number {
    const id = source.associations?.[tuple];
    return id === undefined ? tuple : id;
}

function compareValue(actual: number, operator: SelectionComparisonOperator, expected: number): boolean {
    if (!Number.isFinite(actual) || !Number.isFinite(expected)) {
        return false;
    }
    switch (operator) {
        case '==':
            return actual === expected;
        case '!=':
            return actual !== expected;
        case '<':
            return actual < expected;
        case '<=':
            return actual <= expected;
        case '>':
            return actual > expected;
        case '>=':
            return actual >= expected;
    }
}

function predicateMatches(
    predicate: SelectionPredicate,
    needle: string,
    source: SelectionQuerySource,
    components: number,
    tuple: number
): boolean {
    switch (predicate.kind) {
        case 'compare': {
            const actual = predicate.field === 'value' ? tupleScalar(source.values, components, tuple) : tupleId(source, tuple);
            return compareValue(actual, predicate.operator, predicate.value);
        }
        case 'range': {
            const actual = predicate.field === 'value' ? tupleScalar(source.values, components, tuple) : tupleId(source, tuple);
            return Number.isFinite(actual) && actual >= predicate.min && actual <= predicate.max;
        }
        case 'contains': {
            const name = source.names?.[tuple];
            return name !== undefined && name.toLowerCase().includes(needle);
        }
    }
}

/**
 * Run a parsed query over a source and return the selected tuple indices
 * (ascending) plus matched/total counts. Non-finite scalars and tuples without
 * a name never match. Throws {@link SelectionQueryError} (`missing-names`)
 * when the query needs names the source does not provide.
 */
export function evaluateSelectionQuery(query: SelectionQuery, source: SelectionQuerySource): SelectionQueryResult {
    const components = normalizeComponents(source.components);
    const total = selectionTupleCount(source);
    const requiresNames = query.predicates.some((predicate) => predicate.kind === 'contains');
    if (requiresNames && source.names === undefined) {
        throw new SelectionQueryError('missing-names', "This query needs an array with names ('name contains')");
    }
    const needles = query.predicates.map((predicate) => (predicate.kind === 'contains' ? predicate.text.toLowerCase() : ''));
    const indices = new Uint32Array(total);
    let matched = 0;
    for (let tuple = 0; tuple < total; tuple++) {
        let passes = true;
        for (let index = 0; index < query.predicates.length; index++) {
            if (!predicateMatches(query.predicates[index], needles[index], source, components, tuple)) {
                passes = false;
                break;
            }
        }
        if (passes) {
            indices[matched++] = tuple;
        }
    }
    // Trim the tail for sparse selections (a full match keeps the allocation).
    return { indices: matched === total ? indices : indices.slice(0, matched), matched, total };
}

// ============================================================================
// Display helpers
// ============================================================================

/**
 * Display formatting shared by CSV cells and the dialog hint: six significant
 * digits, no locale separators, trailing zeros trimmed. Non-finite values
 * render as an empty cell (CSV-safe), and negative zero normalizes to `0`
 * (dataset-inspector parity).
 */
export function formatSelectionNumber(value: number): string {
    if (!Number.isFinite(value)) {
        return '';
    }
    if (value === 0) {
        return '0';
    }
    return Number(value.toPrecision(6)).toString();
}

function formatCount(value: number): string {
    return String(Math.max(0, Math.floor(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * One-line result summary for the live count: `"1,234 of 10,000 tuples (12.3%)"`.
 * A zero-tuple source omits the percentage; matched is clamped to total.
 */
export function formatSelectionSummary(counts: SelectionCounts): string {
    const total = Math.max(0, Math.floor(counts.total));
    const matched = Math.min(Math.max(0, Math.floor(counts.matched)), total);
    const noun = total === 1 ? 'tuple' : 'tuples';
    if (total === 0) {
        return `0 of 0 ${noun}`;
    }
    const percent = `${((matched / total) * 100).toFixed(1).replace(/\.0$/, '')}%`;
    return `${formatCount(matched)} of ${formatCount(total)} ${noun} (${percent})`;
}

/** CSV export options for {@link selectionToCsv}. */
export interface SelectionCsvOptions {
    /** Include the 0-based tuple index column (default true). */
    readonly includeIndex?: boolean;
    /** Include the association/id column when the source has one (default true). */
    readonly includeAssociation?: boolean;
    /** Include categorical names when the source has them (default true). */
    readonly includeName?: boolean;
    /** Header for the value column (default `value`). */
    readonly valueLabel?: string;
    /** Cap exported rows (default all; the header always renders). */
    readonly maxRows?: number;
}

function csvField(value: string): string {
    return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function normalizeMaxRows(maxRows: number | undefined): number {
    if (maxRows === undefined || !Number.isFinite(maxRows)) {
        return Number.MAX_SAFE_INTEGER;
    }
    return Math.max(0, Math.floor(maxRows));
}

/**
 * Render selected tuples as RFC 4180 CSV: `index,value[,association][,name]`
 * plus a trailing newline. Values use {@link formatSelectionNumber} (non-finite
 * blank), names are quoted when needed, and out-of-range indices are skipped.
 * The current array is never mutated; the CSV is built from the source and the
 * transient index set only.
 */
export function selectionToCsv(source: SelectionQuerySource, indices: ArrayLike<number>, options: SelectionCsvOptions = {}): string {
    const components = normalizeComponents(source.components);
    const tupleCount = selectionTupleCount(source);
    const includeIndex = options.includeIndex !== false;
    const includeAssociation = options.includeAssociation !== false && source.associations !== undefined;
    const includeName = options.includeName !== false && source.names !== undefined;
    const header: string[] = [];
    if (includeIndex) {
        header.push('index');
    }
    header.push(options.valueLabel ?? 'value');
    if (includeAssociation) {
        header.push('association');
    }
    if (includeName) {
        header.push('name');
    }
    const lines = [header.map(csvField).join(',')];
    const limit = Math.min(Math.floor(indices.length), normalizeMaxRows(options.maxRows));
    for (let row = 0; row < limit; row++) {
        const tuple = indices[row];
        if (!Number.isInteger(tuple) || tuple < 0 || tuple >= tupleCount) {
            continue;
        }
        const cells: string[] = [];
        if (includeIndex) {
            cells.push(String(tuple));
        }
        cells.push(formatSelectionNumber(tupleScalar(source.values, components, tuple)));
        if (includeAssociation) {
            cells.push(formatSelectionNumber(source.associations?.[tuple] ?? Number.NaN));
        }
        if (includeName) {
            cells.push(source.names?.[tuple] ?? '');
        }
        lines.push(cells.map(csvField).join(','));
    }
    return `${lines.join('\n')}\n`;
}
