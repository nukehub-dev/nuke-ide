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
 * Docs contract: every relative Markdown link under `extensions/openmc-studio/docs`
 * points at a file that exists. External and site-absolute links are skipped.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const DOCS_ROOT = path.resolve(__dirname, '../../docs');

/** Collect every Markdown file under the docs tree. */
function markdownFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...markdownFiles(fullPath));
        } else if (entry.name.endsWith('.md')) {
            files.push(fullPath);
        }
    }
    return files;
}

describe('openmc-studio docs links', () => {
    it('resolves every relative Markdown link', () => {
        const files = markdownFiles(DOCS_ROOT);
        expect(files.length).toBeGreaterThan(10);

        const broken: string[] = [];
        for (const file of files) {
            const content = fs.readFileSync(file, 'utf-8');
            for (const match of content.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
                const target = match[1];
                if (/^(?:https?:|mailto:|#|\/)/.test(target)) {
                    continue;
                }
                const withoutAnchor = target.split('#')[0].split('?')[0];
                if (!withoutAnchor || !withoutAnchor.endsWith('.md')) {
                    continue;
                }
                const resolved = path.resolve(path.dirname(file), withoutAnchor);
                if (!fs.existsSync(resolved)) {
                    broken.push(`${path.relative(DOCS_ROOT, file)} -> ${target}`);
                }
            }
        }

        expect(broken, `broken doc links:\n${broken.join('\n')}`).toEqual([]);
    });

    it('links the coverage page from the user index', () => {
        const index = fs.readFileSync(path.join(DOCS_ROOT, 'user/index.md'), 'utf-8');
        expect(index).toContain('](coverage.md)');
        const coverage = fs.readFileSync(path.join(DOCS_ROOT, 'user/coverage.md'), 'utf-8');
        expect(coverage).toContain('## Explicit Non-Goals');
        expect(coverage).toContain('## What Still Requires OpenMC / Python');
    });
});
