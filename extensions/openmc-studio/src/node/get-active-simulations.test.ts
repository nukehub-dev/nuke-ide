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
 * Tests for the getActiveSimulations RPC. Frontend re-attach after a tab
 * reload depends on this listing: status events are one-shot pushes, so a
 * fresh frontend can only discover in-flight runs by querying the backend.
 */

import { describe, it, expect } from 'vitest';

import { OpenMCRunnerService } from './openmc-runner-service';

function seedRunningSimulation(
    runner: OpenMCRunnerService,
    processId: string,
    workingDirectory: string,
    startTime = new Date('2026-08-12T10:00:00.000Z')
): void {
    (runner as any).runningSimulations.set(processId, {
        processId,
        process: { kill: () => undefined },
        startTime,
        request: { workingDirectory },
        logFilePath: `/tmp/logs/${processId}.log`
    });
}

describe('getActiveSimulations', () => {
    it('returns an empty list when nothing is running', async () => {
        const runner = new OpenMCRunnerService();
        expect(await runner.getActiveSimulations()).toEqual([]);
    });

    it('maps running simulations to serializable re-attach info', async () => {
        const runner = new OpenMCRunnerService();
        seedRunningSimulation(runner, 'sim-1', '/projects/tokamak');
        seedRunningSimulation(runner, 'sim-2', '/projects/pincell');

        const active = await runner.getActiveSimulations();
        expect(active).toHaveLength(2);

        const sim1 = active.find((s) => s.processId === 'sim-1');
        expect(sim1).toEqual({
            processId: 'sim-1',
            workingDirectory: '/projects/tokamak',
            logFilePath: '/tmp/logs/sim-1.log',
            startTime: '2026-08-12T10:00:00.000Z'
        });
    });

    it('does not include completed simulations', async () => {
        const runner = new OpenMCRunnerService();
        (runner as any).completedSimulations.set('sim-done', {
            processId: 'sim-done',
            logFilePath: '/tmp/logs/sim-done.log'
        });

        expect(await runner.getActiveSimulations()).toEqual([]);
    });
});
