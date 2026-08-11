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
 * Tests for run-output organization (`moveRunOutputFiles`) and the captured
 * output tail (`appendOutputTail`). Long random ray runs rewrite the same
 * particle restart file names across iterations and emit megabytes of log
 * output; duplicate destinations must be replaced instead of re-logged by
 * every watcher scan, and the in-memory capture must stay bounded.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { OpenMCRunnerService, appendOutputTail, MAX_CAPTURED_OUTPUT_CHARS } from './openmc-runner-service';

function makeRunner(): OpenMCRunnerService {
    return new OpenMCRunnerService();
}

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'run-output-org-'));
}

describe('moveRunOutputFiles', () => {
    const tempDirs: string[] = [];

    function tempDir(): string {
        const dir = makeTempDir();
        tempDirs.push(dir);
        return dir;
    }

    afterEach(() => {
        vi.restoreAllMocks();
        while (tempDirs.length > 0) {
            fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
        }
    });

    it('moves particle restart and track files into subfolders with one summary log', async () => {
        const dir = tempDir();
        fs.writeFileSync(path.join(dir, 'particle_1_100.h5'), 'a');
        fs.writeFileSync(path.join(dir, 'particle_1_101.h5'), 'b');
        fs.writeFileSync(path.join(dir, 'tracks.h5'), 't');
        fs.writeFileSync(path.join(dir, 'settings.xml'), '<settings/>');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        const runner = makeRunner();
        await (runner as any).moveRunOutputFiles(dir, dir);

        expect(fs.readFileSync(path.join(dir, 'particles', 'particle_1_100.h5'), 'utf8')).toBe('a');
        expect(fs.readFileSync(path.join(dir, 'particles', 'particle_1_101.h5'), 'utf8')).toBe('b');
        expect(fs.readFileSync(path.join(dir, 'tracks', 'tracks.h5'), 'utf8')).toBe('t');
        expect(fs.existsSync(path.join(dir, 'particle_1_100.h5'))).toBe(false);
        expect(fs.existsSync(path.join(dir, 'tracks.h5'))).toBe(false);
        expect(fs.existsSync(path.join(dir, 'settings.xml'))).toBe(true);

        const summaries = logSpy.mock.calls.filter((args) => String(args[0]).includes('particle restart file'));
        expect(summaries).toHaveLength(1);
        expect(String(summaries[0][0])).toContain('2 particle restart file(s)');
        expect(String(summaries[0][0])).toContain('1 track file(s)');
    });

    it('replaces an existing destination instead of leaving a stuck source', async () => {
        const dir = tempDir();
        fs.mkdirSync(path.join(dir, 'particles'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'particles', 'particle_1_100.h5'), 'old');
        fs.writeFileSync(path.join(dir, 'particle_1_100.h5'), 'new');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        const runner = makeRunner();
        await (runner as any).moveRunOutputFiles(dir, dir);

        expect(fs.readFileSync(path.join(dir, 'particles', 'particle_1_100.h5'), 'utf8')).toBe('new');
        expect(fs.existsSync(path.join(dir, 'particle_1_100.h5'))).toBe(false);

        // A second pass with no new files must stay silent — the stuck-source
        // "already exists" log loop is what this fix removes.
        logSpy.mockClear();
        await (runner as any).moveRunOutputFiles(dir, dir);
        expect(logSpy).not.toHaveBeenCalled();
    });

    it('leaves the selected restart file in place', async () => {
        const dir = tempDir();
        fs.writeFileSync(path.join(dir, 'particle_3_42.h5'), 'keep');
        fs.writeFileSync(path.join(dir, 'particle_3_43.h5'), 'move');

        const runner = makeRunner();
        await (runner as any).moveRunOutputFiles(dir, dir, path.join(dir, 'particle_3_42.h5'));

        expect(fs.existsSync(path.join(dir, 'particle_3_42.h5'))).toBe(true);
        expect(fs.readFileSync(path.join(dir, 'particles', 'particle_3_43.h5'), 'utf8')).toBe('move');
    });

    it('organizes a separate output directory as well', async () => {
        const dir = tempDir();
        const outputDir = tempDir();
        fs.writeFileSync(path.join(outputDir, 'particle_2_7.h5'), 'p');

        const runner = makeRunner();
        await (runner as any).moveRunOutputFiles(dir, outputDir);

        expect(fs.readFileSync(path.join(outputDir, 'particles', 'particle_2_7.h5'), 'utf8')).toBe('p');
    });
});

describe('appendOutputTail', () => {
    it('appends while under the cap', () => {
        expect(appendOutputTail('abc', 'def')).toBe('abcdef');
        expect(appendOutputTail('', 'chunk')).toBe('chunk');
    });

    it('keeps only the trailing characters once over the cap', () => {
        const buffer = 'x'.repeat(MAX_CAPTURED_OUTPUT_CHARS);
        const chunk = 'y'.repeat(100);
        const result = appendOutputTail(buffer, chunk);
        expect(result).toHaveLength(MAX_CAPTURED_OUTPUT_CHARS);
        expect(result.endsWith(chunk)).toBe(true);
    });

    it('keeps the chunk tail even when the chunk alone exceeds the cap', () => {
        const chunk = 'z'.repeat(MAX_CAPTURED_OUTPUT_CHARS + 10) + 'END';
        const result = appendOutputTail('', chunk);
        expect(result).toHaveLength(MAX_CAPTURED_OUTPUT_CHARS);
        expect(result.endsWith('END')).toBe(true);
    });
});
