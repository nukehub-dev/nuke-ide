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
import { injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';

/**
 * Configures RPC buffer limits to prevent "Max disconnected buffer size exceeded" errors.
 *
 * This error occurs when the frontend disconnects but the backend keeps sending messages.
 * The messages accumulate in a buffer until it overflows (default 100MB).
 *
 * Solution: Increase the buffer size limit for disconnected clients.
 */
@injectable()
export class RpcBufferConfiguration implements BackendApplicationContribution {
    initialize(): void {
        // Set environment variable to increase disconnected buffer size to 500MB
        // This prevents crashes during long-running simulations when user refreshes/closes browser
        if (!process.env.THEIA_RPC_MAX_BUFFER_SIZE) {
            process.env.THEIA_RPC_MAX_BUFFER_SIZE = '524288000'; // 500MB in bytes
        }

        // Also set the disconnected buffer size
        if (!process.env.THEIA_RPC_MAX_DISCONNECTED_BUFFER_SIZE) {
            process.env.THEIA_RPC_MAX_DISCONNECTED_BUFFER_SIZE = '524288000'; // 500MB
        }

        console.log('[OpenMC] RPC buffer limits configured for simulation workloads');
    }
}
