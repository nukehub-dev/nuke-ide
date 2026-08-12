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
 * Tests for computeOutputWatcherExcludes: dedicated output subdirectories are
 * excluded wholesale, an output directory that IS the project directory only
 * excludes the churn subfolders (excluding the project root itself would
 * unwatch the whole project), and output directories outside the workspace
 * produce no patterns.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';

import { computeOutputWatcherExcludes } from './output-watcher-excludes';

const root = path.resolve('/ws');
const projectDir = path.join(root, 'tokamak');

describe('computeOutputWatcherExcludes', () => {
    it('excludes a dedicated output subdirectory wholesale', () => {
        const patterns = computeOutputWatcherExcludes(path.join(projectDir, 'output'), projectDir, [root]);
        expect(patterns).toEqual(['tokamak/output/**']);
    });

    it('excludes only the churn subfolders when output lands in the project directory', () => {
        const patterns = computeOutputWatcherExcludes(projectDir, projectDir, [root]);
        expect(patterns).toEqual(['tokamak/particles/**', 'tokamak/tracks/**']);
    });

    it('handles the project directory being the workspace root', () => {
        const patterns = computeOutputWatcherExcludes(path.join(root, 'output'), root, [root]);
        expect(patterns).toEqual(['output/**']);
    });

    it('handles output at the workspace root without a dedicated subdirectory', () => {
        const patterns = computeOutputWatcherExcludes(root, root, [root]);
        expect(patterns).toEqual(['particles/**', 'tracks/**']);
    });

    it('emits one pattern per containing root (multi-root workspace)', () => {
        const otherRoot = projectDir; // project mounted directly as an additional root
        const patterns = computeOutputWatcherExcludes(path.join(projectDir, 'output'), projectDir, [root, otherRoot]);
        expect(patterns).toEqual(['tokamak/output/**', 'output/**']);
    });

    it('returns nothing when the output directory is outside every workspace root', () => {
        const patterns = computeOutputWatcherExcludes(path.resolve('/elsewhere/output'), projectDir, [root]);
        expect(patterns).toEqual([]);
    });

    it('does not match a sibling whose name starts with the project directory name', () => {
        const sibling = path.join(root, 'tokamak-other');
        const patterns = computeOutputWatcherExcludes(path.join(sibling, 'output'), sibling, [root]);
        expect(patterns).toEqual(['tokamak-other/output/**']);
    });
});
