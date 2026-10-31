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
 * Nuke MCP Auth Helpers
 *
 * Small, pure helpers used by the MCP contribution's defense-in-depth checks.
 * The external API server already rejects cross-origin requests and verifies
 * its configured token; the MCP endpoint repeats both checks against the
 * config-file token so it cannot serve unprotected if the two configurations
 * drift apart.
 *
 * @module nuke-ai/node/mcp
 */

import { createHash, timingSafeEqual } from 'crypto';

/** Response message used when the config file has no usable token. */
export const MCP_DISABLED_MESSAGE = 'MCP is disabled until a token is configured.';

/** True when the request carries an `Origin` header. */
export function hasOrigin(headers: { origin?: string | string[] }): boolean {
    return headers.origin !== undefined;
}

/** Compare two strings without leaking their contents through timing. */
export function timingSafeEqualText(left: string, right: string): boolean {
    const leftDigest = createHash('sha256').update(left).digest();
    const rightDigest = createHash('sha256').update(right).digest();
    return timingSafeEqual(leftDigest, rightDigest);
}

/** True when the Authorization header is exactly `Bearer <token>`. */
export function isAuthorizedBearer(authorization: string | undefined, token: string): boolean {
    if (authorization === undefined || token.length === 0) {
        return false;
    }
    return timingSafeEqualText(authorization, `Bearer ${token}`);
}
