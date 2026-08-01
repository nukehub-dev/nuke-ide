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
 * Tests for the proxy retry helpers (pure, no DI).
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_PROXY_RETRY, isRetryableProxyError, retryOnRefused } from './proxy-retry';

function errno(code: string): Error {
    const err = new Error(`connect ${code}`) as NodeJS.ErrnoException;
    err.code = code;
    return err;
}

/** Deterministic clock/sleep: sleep advances the fake time instantly. */
function fakeClock(start = 0): { now: () => number; sleep: (ms: number) => Promise<void> } {
    let time = start;
    return {
        now: () => time,
        sleep: (ms) => {
            time += ms;
            return Promise.resolve();
        }
    };
}

describe('isRetryableProxyError', () => {
    it('treats connection-refused/reset as retryable', () => {
        expect(isRetryableProxyError(errno('ECONNREFUSED'))).toBe(true);
        expect(isRetryableProxyError(errno('ECONNRESET'))).toBe(true);
    });

    it('rejects other errors and non-errors', () => {
        expect(isRetryableProxyError(errno('ENOTFOUND'))).toBe(false);
        expect(isRetryableProxyError(new Error('boom'))).toBe(false);
        expect(isRetryableProxyError(undefined)).toBe(false);
    });
});

describe('retryOnRefused', () => {
    it('returns immediately on first-attempt success', async () => {
        const { now, sleep } = fakeClock();
        let attempts = 0;
        const result = await retryOnRefused(
            () => {
                attempts++;
                return Promise.resolve(undefined);
            },
            DEFAULT_PROXY_RETRY,
            sleep,
            now
        );
        expect(result).toBeUndefined();
        expect(attempts).toBe(1);
    });

    it('retries ECONNREFUSED until the attempt succeeds', async () => {
        const { now, sleep } = fakeClock();
        let attempts = 0;
        const result = await retryOnRefused(
            () => {
                attempts++;
                return Promise.resolve(attempts < 3 ? errno('ECONNREFUSED') : undefined);
            },
            { budgetMs: 5000, intervalMs: 250 },
            sleep,
            now
        );
        expect(result).toBeUndefined();
        expect(attempts).toBe(3);
    });

    it('does not retry non-retryable errors', async () => {
        const { now, sleep } = fakeClock();
        let attempts = 0;
        const result = await retryOnRefused(
            () => {
                attempts++;
                return Promise.resolve(errno('ENOTFOUND'));
            },
            DEFAULT_PROXY_RETRY,
            sleep,
            now
        );
        expect(result?.message).toContain('ENOTFOUND');
        expect(attempts).toBe(1);
    });

    it('gives up after the budget and returns the last error', async () => {
        const { now, sleep } = fakeClock();
        let attempts = 0;
        const result = await retryOnRefused(
            () => {
                attempts++;
                return Promise.resolve(errno('ECONNREFUSED'));
            },
            { budgetMs: 500, intervalMs: 250 },
            sleep,
            now
        );
        // t=0 attempt, sleep to 250 attempt, sleep to 500 attempt, then stop
        expect(attempts).toBe(3);
        expect(result?.message).toContain('ECONNREFUSED');
    });
});
