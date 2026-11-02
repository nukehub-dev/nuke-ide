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
 * Tests the bounded unified script diff.
 */

import { describe, expect, it } from 'vitest';
import { MAX_DIFF_BYTES, MAX_DIFF_LINES } from './script-source-policy';
import { SCRIPT_DIFF_CONTEXT_LINES, unifiedScriptDiff } from './script-diff';

function utf8Length(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}

describe('unifiedScriptDiff', () => {
    it('returns an empty diff for unchanged and empty inputs', () => {
        expect(unifiedScriptDiff('model = Box(1, 2, 3)\n', 'model = Box(1, 2, 3)\n')).toEqual({
            text: '',
            truncated: false,
            addedLines: 0,
            removedLines: 0,
            hunkCount: 0
        });
        expect(unifiedScriptDiff('', '')).toEqual({
            text: '',
            truncated: false,
            addedLines: 0,
            removedLines: 0,
            hunkCount: 0
        });
    });

    it('renders an addition with context lines', () => {
        const diff = unifiedScriptDiff('a\nb\n', 'a\nc\nb\n');

        expect(diff.text).toBe('--- a/model.py\n+++ b/model.py\n@@ -1,2 +1,3 @@\n a\n+c\n b\n');
        expect(diff.addedLines).toBe(1);
        expect(diff.removedLines).toBe(0);
        expect(diff.hunkCount).toBe(1);
        expect(diff.truncated).toBe(false);
    });

    it('renders a removal and a one-for-one replacement', () => {
        const removal = unifiedScriptDiff('a\nb\nc\n', 'a\nc\n');
        expect(removal.text).toBe('--- a/model.py\n+++ b/model.py\n@@ -1,3 +1,2 @@\n a\n-b\n c\n');
        expect(removal.addedLines).toBe(0);
        expect(removal.removedLines).toBe(1);

        const replacement = unifiedScriptDiff('a\n', 'b\n');
        expect(replacement.text).toBe('--- a/model.py\n+++ b/model.py\n@@ -1 +1 @@\n-a\n+b\n');
        expect(replacement.addedLines).toBe(1);
        expect(replacement.removedLines).toBe(1);
        expect(replacement.hunkCount).toBe(1);
    });

    it('splits distant changes into hunks and keeps the configured context', () => {
        const before = Array.from({ length: 10 }, (_, index) => `line${index + 1}`).join('\n');
        const after = before.replace('line2', 'LINE2').replace('line9', 'LINE9');

        const diff = unifiedScriptDiff(before, after, { contextLines: 1 });

        expect(diff.hunkCount).toBe(2);
        expect(diff.text).toContain('@@ -1,3 +1,3 @@');
        expect(diff.text).toContain('@@ -8,3 +8,3 @@');
        expect(diff.text).toContain('-line2\n+LINE2');
        expect(diff.text).toContain('-line9\n+LINE9');
        expect(diff.addedLines).toBe(2);
        expect(diff.removedLines).toBe(2);
    });

    it('defaults to three context lines', () => {
        const before = Array.from({ length: 20 }, (_, index) => `line${index + 1}`).join('\n');
        const after = before.replace('line10', 'LINE10');
        const diff = unifiedScriptDiff(before, after);

        expect(SCRIPT_DIFF_CONTEXT_LINES).toBe(3);
        expect(diff.text).toContain('@@ -7,7 +7,7 @@');
        expect(diff.text).toContain(' line7\n line8\n line9\n-line10\n+LINE10\n line11\n line12\n line13');
    });

    it('normalizes CRLF and lone CR for display', () => {
        const diff = unifiedScriptDiff('a\r\nb\r\n', 'a\r\nc\r\n');
        expect(diff.text).toBe('--- a/model.py\n+++ b/model.py\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n');
        expect(diff.text).not.toContain('\r');

        const loneCr = unifiedScriptDiff('a\rb\r', 'a\rc\r');
        expect(loneCr.text).not.toContain('\r');
    });

    it('diffs empty sides without inventing a phantom trailing line', () => {
        const added = unifiedScriptDiff('', 'model = Box(1, 2, 3)\n');
        expect(added.text).toBe('--- a/model.py\n+++ b/model.py\n@@ -0,0 +1 @@\n+model = Box(1, 2, 3)\n');
        expect(added.addedLines).toBe(1);
        expect(added.removedLines).toBe(0);

        const removed = unifiedScriptDiff('model = Box(1, 2, 3)\n', '');
        expect(removed.text).toBe('--- a/model.py\n+++ b/model.py\n@@ -1 +0,0 @@\n-model = Box(1, 2, 3)\n');
        expect(removed.addedLines).toBe(0);
        expect(removed.removedLines).toBe(1);

        const blankLine = unifiedScriptDiff('', '\n');
        expect(blankLine.text).toBe('--- a/model.py\n+++ b/model.py\n@@ -0,0 +1 @@\n+\n');
        expect(blankLine.addedLines).toBe(1);
    });

    it('truncates by line count while keeping full-diff counters', () => {
        const before = Array.from({ length: 300 }, (_, index) => `before${index}`).join('\n');
        const after = Array.from({ length: 300 }, (_, index) => `after${index}`).join('\n');

        const diff = unifiedScriptDiff(before, after, { maxLines: 5 });

        expect(diff.truncated).toBe(true);
        expect(diff.addedLines).toBe(300);
        expect(diff.removedLines).toBe(300);
        expect(diff.hunkCount).toBe(1);
        expect(diff.text.trimEnd().split('\n')).toHaveLength(5);
        expect(diff.text.endsWith('\n')).toBe(true);
    });

    it('truncates by UTF-8 bytes and never exceeds the byte cap', () => {
        const after = `${'λ'.repeat(100)}\n`;
        const diff = unifiedScriptDiff('', after, { maxBytes: 40 });

        expect(diff.truncated).toBe(true);
        expect(utf8Length(diff.text)).toBeLessThanOrEqual(40);
        expect(diff.addedLines).toBe(1);
    });

    it('uses the public caps by default', () => {
        const before = Array.from({ length: 500 }, (_, index) => `-${index}`).join('\n');
        const after = Array.from({ length: 500 }, (_, index) => `+${index}`).join('\n');

        const diff = unifiedScriptDiff(before, after);

        expect(MAX_DIFF_LINES).toBe(200);
        expect(MAX_DIFF_BYTES).toBe(32 * 1024);
        expect(diff.truncated).toBe(true);
        expect(diff.text.split('\n').length - 1).toBeLessThanOrEqual(MAX_DIFF_LINES);
        expect(utf8Length(diff.text)).toBeLessThanOrEqual(MAX_DIFF_BYTES);
        expect(diff.addedLines).toBe(500);
        expect(diff.removedLines).toBe(500);
    });
});
