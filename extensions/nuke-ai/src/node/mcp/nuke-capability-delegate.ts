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
 * Nuke Capability Delegate Backend
 *
 * Holds connected frontend clients for the MCP contribution. The external API
 * configuration is backend-global. Multiple IDE windows are registered in
 * connection order; the oldest live connection serves MCP so a second window
 * cannot silently replace the first. When the serving window closes, the next
 * live connection takes over.
 *
 * @module nuke-ai/node/mcp
 */

import { injectable } from '@theia/core/shared/inversify';
import { NukeCapabilityResult } from 'nuke-core/lib/common/nuke-capability-protocol';
import {
    NukeCapabilityDelegate,
    NukeCapabilityDelegateClient,
    NukeCapabilityDescriptor,
    NukeMcpResourceDescriptor
} from '../../common/nuke-capability-delegate';

/** Message returned when no frontend has opened the delegate RPC channel. */
export const FRONTEND_NOT_CONNECTED = 'NukeIDE frontend is not connected.';

/** Forward capability calls to the current frontend client. */
@injectable()
export class NukeCapabilityDelegateImpl implements NukeCapabilityDelegate {
    protected readonly clients: NukeCapabilityDelegateClient[] = [];

    setClient(client: NukeCapabilityDelegateClient): void {
        if (!this.clients.includes(client)) {
            this.clients.push(client);
        }
    }

    /** Release one frontend connection; the next live connection takes over. */
    removeClient(client: NukeCapabilityDelegateClient): void {
        const index = this.clients.indexOf(client);
        if (index >= 0) {
            this.clients.splice(index, 1);
        }
    }

    async listCapabilities(): Promise<NukeCapabilityDescriptor[]> {
        return this.getClient().listCapabilities();
    }

    async listResources(): Promise<NukeMcpResourceDescriptor[]> {
        return this.getClient().listResources();
    }

    async invoke(capabilityId: string, input: unknown): Promise<NukeCapabilityResult> {
        return this.getClient().invoke(capabilityId, input);
    }

    async readResource(uri: string): Promise<string> {
        return this.getClient().readResource(uri);
    }

    protected getClient(): NukeCapabilityDelegateClient {
        const client = this.clients[0];
        if (!client) {
            throw new Error(FRONTEND_NOT_CONNECTED);
        }
        return client;
    }
}
