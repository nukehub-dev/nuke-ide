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
 * Tests for the re-attach matching logic used after a tab reload: which
 * backend run (if any) should a freshly loaded frontend attach to?
 */

import { describe, it, expect } from 'vitest';

import { pickReattachTarget } from './simulation-reattach';
import { ActiveSimulationInfo } from './openmc-studio-protocol';

function activeRun(processId: string, workingDirectory: string): ActiveSimulationInfo {
    return {
        processId,
        workingDirectory,
        logFilePath: `/tmp/logs/${processId}.log`,
        startTime: '2026-08-12T10:00:00.000Z'
    };
}

describe('pickReattachTarget', () => {
    it('picks the run matching the project directory', () => {
        const active = [activeRun('sim-1', '/projects/tokamak'), activeRun('sim-2', '/projects/pincell')];

        expect(pickReattachTarget(active, '/projects/tokamak')?.processId).toBe('sim-1');
        expect(pickReattachTarget(active, '/projects/pincell')?.processId).toBe('sim-2');
    });

    it('falls back to the only active run when no directory matches', () => {
        const active = [activeRun('sim-1', '/custom/workdir')];

        expect(pickReattachTarget(active, '/projects/tokamak')?.processId).toBe('sim-1');
    });

    it('does not guess when multiple runs are active and none matches', () => {
        const active = [activeRun('sim-1', '/projects/a'), activeRun('sim-2', '/projects/b')];

        expect(pickReattachTarget(active, '/projects/tokamak')).toBeUndefined();
    });

    it('returns undefined when nothing is running', () => {
        expect(pickReattachTarget([], '/projects/tokamak')).toBeUndefined();
    });
});
