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
 * Unified diff for model script proposals.
 *
 * The diff is a pure display artifact: it never renders HTML and never feeds
 * back into the build. Inputs are normalized to LF for display, the edit script
 * comes from a bounded longest-common-subsequence pass, and the emitted text is
 * capped by both line count and UTF-8 byte size. Added/removed counts and the
 * hunk count always describe the complete diff, even when the text is truncated.
 *
 * @module nuke-cad/browser/capabilities
 */

import { MAX_DIFF_BYTES, MAX_DIFF_LINES } from './script-source-policy';

/** Unchanged context lines kept on each side of a hunk. */
export const SCRIPT_DIFF_CONTEXT_LINES = 3;

const OLD_FILE_HEADER = '--- a/model.py';
const NEW_FILE_HEADER = '+++ b/model.py';

/** Upper bound on input lines for the quadratic LCS pass. */
const MAX_LCS_INPUT_LINES = 3000;

const UTF8_ENCODER = new TextEncoder();

/** Options for {@link unifiedScriptDiff}. */
export interface ScriptDiffOptions {
    /** Unchanged lines before and after each change. Defaults to 3. */
    readonly contextLines?: number;
    /** Maximum UTF-8 bytes in {@link ScriptDiff.text}. Defaults to 32 KiB. */
    readonly maxBytes?: number;
    /** Maximum lines in {@link ScriptDiff.text}. Defaults to 200. */
    readonly maxLines?: number;
}

/** Bounded unified diff and full-diff counters. */
export interface ScriptDiff {
    readonly text: string;
    readonly truncated: boolean;
    readonly addedLines: number;
    readonly removedLines: number;
    readonly hunkCount: number;
}

interface DiffEntry {
    readonly kind: 'equal' | 'remove' | 'add';
    readonly text: string;
}

interface DiffOperation extends DiffEntry {
    /** 1-based line number in the before text this operation refers to. */
    readonly beforeLine: number;
    /** 1-based line number in the after text this operation refers to. */
    readonly afterLine: number;
}

interface HunkRange {
    start: number;
    end: number;
}

/**
 * Compute a bounded unified diff between two script bodies.
 *
 * @param before - Current script text.
 * @param after - Proposed script text.
 * @param options - Context and output size caps.
 * @returns The diff text plus full-diff counters.
 */
export function unifiedScriptDiff(before: string, after: string, options: ScriptDiffOptions = {}): ScriptDiff {
    const beforeLines = splitScriptLines(before);
    const afterLines = splitScriptLines(after);
    const entries = diffEntries(beforeLines, afterLines);
    let addedLines = 0;
    let removedLines = 0;
    for (const entry of entries) {
        if (entry.kind === 'add') {
            addedLines++;
        } else if (entry.kind === 'remove') {
            removedLines++;
        }
    }
    if (addedLines === 0 && removedLines === 0) {
        return { text: '', truncated: false, addedLines: 0, removedLines: 0, hunkCount: 0 };
    }

    const operations = annotateLines(entries);
    const contextLines = boundedOption(options.contextLines, SCRIPT_DIFF_CONTEXT_LINES);
    const ranges = hunkRanges(operations, contextLines);
    const lines = [OLD_FILE_HEADER, NEW_FILE_HEADER];
    for (const range of ranges) {
        lines.push(hunkHeader(operations, range));
        for (const operation of operations.slice(range.start, range.end + 1)) {
            lines.push(`${prefix(operation.kind)}${operation.text}`);
        }
    }

    const capped = capDiffLines(lines, boundedOption(options.maxLines, MAX_DIFF_LINES), boundedOption(options.maxBytes, MAX_DIFF_BYTES));
    return {
        text: capped.lines.length === 0 ? '' : `${capped.lines.join('\n')}\n`,
        truncated: capped.truncated,
        addedLines,
        removedLines,
        hunkCount: ranges.length
    };
}

/** Normalize CRLF/CR to LF and split into lines, ignoring one trailing newline. */
function splitScriptLines(text: string): string[] {
    const normalized = text.replace(/\r\n?/g, '\n');
    if (normalized.length === 0) {
        return [];
    }
    const lines = normalized.split('\n');
    if (lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

/** Longest-common-subsequence edit script; bounded by input line count. */
function diffEntries(before: readonly string[], after: readonly string[]): DiffEntry[] {
    if (before.length > MAX_LCS_INPUT_LINES || after.length > MAX_LCS_INPUT_LINES) {
        return coarseEntries(before, after);
    }
    const width = after.length + 1;
    const table = new Uint16Array((before.length + 1) * width);
    for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex--) {
        const row = beforeIndex * width;
        const nextRow = row + width;
        for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex--) {
            table[row + afterIndex] =
                before[beforeIndex] === after[afterIndex]
                    ? table[nextRow + afterIndex + 1] + 1
                    : Math.max(table[nextRow + afterIndex], table[row + afterIndex + 1]);
        }
    }

    const entries: DiffEntry[] = [];
    let beforeIndex = 0;
    let afterIndex = 0;
    while (beforeIndex < before.length && afterIndex < after.length) {
        if (before[beforeIndex] === after[afterIndex]) {
            entries.push({ kind: 'equal', text: before[beforeIndex] });
            beforeIndex++;
            afterIndex++;
        } else if (table[(beforeIndex + 1) * width + afterIndex] >= table[beforeIndex * width + afterIndex + 1]) {
            entries.push({ kind: 'remove', text: before[beforeIndex] });
            beforeIndex++;
        } else {
            entries.push({ kind: 'add', text: after[afterIndex] });
            afterIndex++;
        }
    }
    while (beforeIndex < before.length) {
        entries.push({ kind: 'remove', text: before[beforeIndex] });
        beforeIndex++;
    }
    while (afterIndex < after.length) {
        entries.push({ kind: 'add', text: after[afterIndex] });
        afterIndex++;
    }
    return entries;
}

/** Coarse replacement for inputs too large for the LCS table. */
function coarseEntries(before: readonly string[], after: readonly string[]): DiffEntry[] {
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
        prefix++;
    }
    let suffix = 0;
    while (
        suffix < before.length - prefix &&
        suffix < after.length - prefix &&
        before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    ) {
        suffix++;
    }
    const entries: DiffEntry[] = [];
    for (let index = 0; index < prefix; index++) {
        entries.push({ kind: 'equal', text: before[index] });
    }
    for (let index = prefix; index < before.length - suffix; index++) {
        entries.push({ kind: 'remove', text: before[index] });
    }
    for (let index = prefix; index < after.length - suffix; index++) {
        entries.push({ kind: 'add', text: after[index] });
    }
    for (let index = before.length - suffix; index < before.length; index++) {
        entries.push({ kind: 'equal', text: before[index] });
    }
    return entries;
}

/** Attach 1-based before/after line numbers to the edit script. */
function annotateLines(entries: readonly DiffEntry[]): DiffOperation[] {
    let beforeLine = 1;
    let afterLine = 1;
    return entries.map((entry) => {
        const operation = { ...entry, beforeLine, afterLine };
        if (entry.kind !== 'add') {
            beforeLine++;
        }
        if (entry.kind !== 'remove') {
            afterLine++;
        }
        return operation;
    });
}

/** Merge expanded change ranges into non-overlapping hunks. */
function hunkRanges(operations: readonly DiffOperation[], contextLines: number): HunkRange[] {
    const ranges: HunkRange[] = [];
    let current: HunkRange | undefined;
    for (let index = 0; index < operations.length; index++) {
        if (operations[index].kind === 'equal') {
            continue;
        }
        const start = Math.max(0, index - contextLines);
        const end = Math.min(operations.length - 1, index + contextLines);
        if (current === undefined) {
            current = { start, end };
        } else if (start <= current.end + 1) {
            current.end = Math.max(current.end, end);
        } else {
            ranges.push(current);
            current = { start, end };
        }
    }
    if (current !== undefined) {
        ranges.push(current);
    }
    return ranges;
}

/** Format one `@@ -a,b +c,d @@` hunk header. */
function hunkHeader(operations: readonly DiffOperation[], range: HunkRange): string {
    const hunk = operations.slice(range.start, range.end + 1);
    let beforeCount = 0;
    let afterCount = 0;
    let beforeStart: number | undefined;
    let afterStart: number | undefined;
    for (const operation of hunk) {
        if (operation.kind !== 'add') {
            beforeCount++;
            beforeStart ??= operation.beforeLine;
        }
        if (operation.kind !== 'remove') {
            afterCount++;
            afterStart ??= operation.afterLine;
        }
    }
    const first = hunk[0];
    beforeStart ??= first.beforeLine - 1;
    afterStart ??= first.afterLine - 1;
    return `@@ -${formatRange(beforeStart, beforeCount)} +${formatRange(afterStart, afterCount)} @@`;
}

/** Unified-diff range notation: omit a count of one. */
function formatRange(start: number, count: number): string {
    return count === 1 ? `${start}` : `${start},${count}`;
}

function prefix(kind: DiffEntry['kind']): string {
    return kind === 'add' ? '+' : kind === 'remove' ? '-' : ' ';
}

/** Coerce an option to a non-negative integer, falling back when absent. */
function boundedOption(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

interface CappedLines {
    readonly lines: readonly string[];
    readonly truncated: boolean;
}

/** Apply the line and UTF-8 byte caps, reporting whether anything was dropped. */
function capDiffLines(lines: readonly string[], maxLines: number, maxBytes: number): CappedLines {
    const lineLimited = lines.length > maxLines ? lines.slice(0, maxLines) : lines;
    let truncated = lineLimited.length < lines.length;
    let kept = 0;
    let bytes = 0;
    for (const line of lineLimited) {
        const size = utf8Length(line) + 1;
        if (bytes + size > maxBytes) {
            truncated = true;
            break;
        }
        bytes += size;
        kept++;
    }
    if (kept < lineLimited.length) {
        const capped = lineLimited.slice(0, kept);
        if (kept === 0 && lineLimited.length > 0 && maxBytes > 0) {
            const head = truncateUtf8(lineLimited[0], maxBytes - 1);
            if (head.length > 0) {
                return { lines: [head], truncated: true };
            }
        }
        return { lines: capped, truncated };
    }
    return { lines: lineLimited, truncated };
}

/** Keep the longest prefix of one line that fits the byte budget. */
function truncateUtf8(text: string, maxBytes: number): string {
    if (maxBytes <= 0) {
        return '';
    }
    let result = '';
    let bytes = 0;
    for (const character of text) {
        const size = utf8Length(character);
        if (bytes + size > maxBytes) {
            break;
        }
        result += character;
        bytes += size;
    }
    return result;
}

function utf8Length(value: string): number {
    return UTF8_ENCODER.encode(value).byteLength;
}
