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
 * Tests for executePythonScriptJson's stdout parsing: the final JSON object
 * can be followed by openmc log lines (the model run inside a script
 * inherits stdout), and a hard-dying script must surface the real error
 * instead of 'Failed to parse script output: <random log line>'.
 */

import { describe, it, expect } from 'vitest';

import { OpenMCRunnerService } from './openmc-runner-service';

function makeRunner(): OpenMCRunnerService {
    const runner = new OpenMCRunnerService();
    (runner as any).validationService = {
        validateOpenMCSetup: async () => ({ ready: true, pythonCommand: 'python3', errors: [], warnings: [] })
    };
    return runner;
}

describe('executePythonScriptJson stdout parsing', () => {
    it('parses a JSON result that is not the last stdout line', async () => {
        const runner = makeRunner();
        const result = await (runner as any).executePythonScriptJson(
            ['-c', "print('noise before'); print('{\"success\": true, \"value\": 42}'); print(' Reading materials XML file...')"],
            process.cwd()
        );
        expect(result.success).toBe(true);
        expect(result.value).toBe(42);
    });

    it('marks a non-zero exit as failure even when JSON says success', async () => {
        const runner = makeRunner();
        const result = await (runner as any).executePythonScriptJson(
            ['-c', 'import sys; print(\'{"success": true}\'); sys.exit(3)'],
            process.cwd()
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain('code 3');
    });

    it('surfaces stderr detail when no JSON line exists (hard exit)', async () => {
        const runner = makeRunner();
        const result = await (runner as any).executePythonScriptJson(
            [
                '-c',
                "import sys; print(' Reading materials XML file...'); sys.stderr.write('RuntimeError: No macroscopic data or nuclides specified on material 1'); sys.exit(255)"
            ],
            process.cwd()
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain('code 255');
        expect(result.error).toContain('No macroscopic data');
        expect(result.error).not.toContain('Failed to parse script output');
    });

    it('falls back to stdout detail when stderr is empty', async () => {
        const runner = makeRunner();
        const result = await (runner as any).executePythonScriptJson(
            ['-c', "import sys; print('only stdout noise'); sys.exit(1)"],
            process.cwd()
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain('only stdout noise');
    });
});
