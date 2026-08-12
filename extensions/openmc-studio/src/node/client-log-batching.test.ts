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
 * Tests for client log batching in the runner service. Runs that emit tens of
 * thousands of output lines (e.g. DAGMC geometry warnings) must not push one
 * JSON-RPC notification per line — that stalls the frontend renderer
 * ("Page Unresponsive"). Output is buffered and flushed on a short timer,
 * on size, and before every status transition.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { OpenMCRunnerService } from './openmc-runner-service';

function makeRunnerWithClient(): { runner: OpenMCRunnerService; client: { log: any; warn: any; onSimulationStatus: any } } {
    const runner = new OpenMCRunnerService();
    const client = {
        log: vi.fn(),
        warn: vi.fn(),
        onSimulationStatus: vi.fn()
    };
    (runner as any).client = client;
    return { runner, client };
}

describe('client log batching', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('batches rapid log lines into one client call per flush window', () => {
        vi.useFakeTimers();
        const { runner, client } = makeRunnerWithClient();

        for (let i = 0; i < 1000; i++) {
            (runner as any).safeLog(` WARNING: line ${i}\n`);
        }
        expect(client.log).not.toHaveBeenCalled();

        vi.advanceTimersByTime(250);
        expect(client.log).toHaveBeenCalledTimes(1);
        expect(client.log.mock.calls[0][0]).toContain('line 0');
        expect(client.log.mock.calls[0][0]).toContain('line 999');
    });

    it('flushes immediately once the buffer exceeds the size cap', () => {
        vi.useFakeTimers();
        const { runner, client } = makeRunnerWithClient();

        (runner as any).safeLog('x'.repeat(300 * 1024));
        expect(client.log).toHaveBeenCalledTimes(1);

        // Buffer drained: nothing left for the timer window
        vi.advanceTimersByTime(1000);
        expect(client.log).toHaveBeenCalledTimes(1);
    });

    it('flushes buffered output before status transitions', () => {
        vi.useFakeTimers();
        const { runner, client } = makeRunnerWithClient();

        (runner as any).safeWarn(' WARNING: something\n');
        (runner as any).safeSendStatus({ processId: 'p1', status: 'completed' });

        expect(client.warn).toHaveBeenCalledTimes(1);
        expect(client.onSimulationStatus).toHaveBeenCalledTimes(1);
        // warn flushed before the status event
        const warnOrder = client.warn.mock.invocationCallOrder[0];
        const statusOrder = client.onSimulationStatus.mock.invocationCallOrder[0];
        expect(warnOrder).toBeLessThan(statusOrder);
    });

    it('clears the client on disconnect and stops sending without throwing', () => {
        vi.useFakeTimers();
        const { runner, client } = makeRunnerWithClient();
        client.log.mockImplementation(() => {
            throw new Error('disconnected');
        });

        (runner as any).safeLog('hello\n');
        expect(() => vi.advanceTimersByTime(250)).not.toThrow();
        expect((runner as any).client).toBeUndefined();

        // Subsequent logging is a silent no-op
        expect(() => (runner as any).safeLog('more\n')).not.toThrow();
        vi.advanceTimersByTime(250);
        expect(client.log).toHaveBeenCalledTimes(1);
    });
});
