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
 * Tests for {@link getPythonInfo}, in particular the conda-prefix
 * reclassification of interpreters discovered as bare "system" pythons.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getPythonInfo } from './python-info';

/** Create a fake `<dir>/bin/python` shim that reports a fixed version. */
function makeFakePython(prefixDir: string): string {
    const binDir = path.join(prefixDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const pythonPath = path.join(binDir, 'python');
    fs.writeFileSync(pythonPath, '#!/bin/sh\necho "Python 3.13.1"\n');
    fs.chmodSync(pythonPath, 0o755);
    return pythonPath;
}

describe('getPythonInfo', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuke-pyinfo-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('classifies a bare interpreter as system', async () => {
        const pythonPath = makeFakePython(path.join(tmpDir, 'usr'));
        const env = await getPythonInfo(pythonPath, 'system');
        expect(env?.type).toBe('system');
        expect(env?.name).toBe('system');
        expect(env?.version).toBe('3.13.1');
    });

    it('reclassifies a system python inside a conda prefix env', async () => {
        // Prefix envs such as /opt/nuke are invisible to `conda env list`
        // when another user created them, but conda-meta gives them away.
        const prefix = path.join(tmpDir, 'nuke');
        const pythonPath = makeFakePython(prefix);
        fs.mkdirSync(path.join(prefix, 'conda-meta'));

        const env = await getPythonInfo(pythonPath, 'system');
        expect(env?.type).toBe('conda');
        expect(env?.name).toBe('nuke');
        expect(env?.envPath).toBe(prefix);
    });

    it('names the conda root prefix "base"', async () => {
        const prefix = path.join(tmpDir, 'miniforge3');
        const pythonPath = makeFakePython(prefix);
        fs.mkdirSync(path.join(prefix, 'conda-meta'));
        fs.mkdirSync(path.join(prefix, 'envs'));

        const env = await getPythonInfo(pythonPath, 'system');
        expect(env?.type).toBe('conda');
        expect(env?.name).toBe('base');
    });

    it('returns undefined for a missing executable', async () => {
        const env = await getPythonInfo(path.join(tmpDir, 'nope', 'bin', 'python'), 'system');
        expect(env).toBeUndefined();
    });
});
