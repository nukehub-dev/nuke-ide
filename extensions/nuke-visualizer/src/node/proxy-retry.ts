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
 * Retry policy for the visualizer reverse proxy. Trame servers print their
 * "starting" line before they finish binding the port, so the browser's first
 * request after a server start races the bind and hits ECONNREFUSED. Retrying
 * for a short budget turns that race into a slightly slower first load
 * instead of a permanent 'Visualizer server unreachable' iframe.
 *
 * Pure helpers (no DI) — unit-testable in node.
 */

export interface ProxyRetryPolicy {
    /** Total time budget for retries, in milliseconds */
    budgetMs: number;
    /** Delay between attempts, in milliseconds */
    intervalMs: number;
}

/** Default retry budget: ~5 s total, one attempt every 250 ms. */
export const DEFAULT_PROXY_RETRY: ProxyRetryPolicy = { budgetMs: 5000, intervalMs: 250 };

/** True for connection errors that mean 'server not up yet' (worth retrying). */
export function isRetryableProxyError(err: unknown): boolean {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return code === 'ECONNREFUSED' || code === 'ECONNRESET';
}

/**
 * Run `attempt` until it succeeds (resolves undefined), fails with a
 * non-retryable error, or the retry budget is exhausted. Returns undefined
 * on success, otherwise the last error.
 *
 * `sleep` and `now` are injectable for deterministic tests.
 */
export async function retryOnRefused(
    attempt: () => Promise<Error | undefined>,
    policy: ProxyRetryPolicy = DEFAULT_PROXY_RETRY,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => number = () => Date.now()
): Promise<Error | undefined> {
    const deadline = now() + policy.budgetMs;
    for (;;) {
        const err = await attempt();
        if (!err || !isRetryableProxyError(err)) {
            return err;
        }
        if (now() + policy.intervalMs > deadline) {
            return err;
        }
        await sleep(policy.intervalMs);
    }
}
