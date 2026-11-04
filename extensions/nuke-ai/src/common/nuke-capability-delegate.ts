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
 * Nuke Capability Delegate
 *
 * Frontend-to-backend bridge used by the external MCP endpoint. Only the
 * projection of a capability crosses the RPC boundary: handlers, live `when`
 * predicates, services, and DOM state stay in the frontend process.
 *
 * @module nuke-ai/common
 */

import type { NukeCapability, NukeCapabilityResult } from 'nuke-core/lib/common/nuke-capability-protocol';

/** Tool/resource projection; no handler or live predicate crosses the RPC boundary. */
export type NukeCapabilityDescriptor = Omit<NukeCapability, 'invoke' | 'when'>;

/** Read-only resource projection; the read callback stays in the frontend. */
export interface NukeMcpResourceDescriptor {
    readonly uri: string;
    readonly name: string;
    readonly description: string;
    readonly mimeType: string;
}

/** JSON-RPC path for the capability delegate. */
export const NukeCapabilityDelegatePath = '/services/nuke-ai/capability-delegate';

/** DI symbol for the frontend delegate client. */
export const NukeCapabilityDelegateClient = Symbol('NukeCapabilityDelegateClient');

/** Frontend implementation exposed to the backend over RPC. */
export interface NukeCapabilityDelegateClient {
    listCapabilities(): Promise<NukeCapabilityDescriptor[]>;
    listResources(): Promise<NukeMcpResourceDescriptor[]>;
    invoke(capabilityId: string, input: unknown): Promise<NukeCapabilityResult>;
    readResource(uri: string): Promise<string>;
}

/** DI symbol for the backend delegate. */
export const NukeCapabilityDelegate = Symbol('NukeCapabilityDelegate');

/** Backend delegate that forwards MCP calls to the connected frontend. */
export interface NukeCapabilityDelegate extends NukeCapabilityDelegateClient {
    setClient(client: NukeCapabilityDelegateClient): void;
}
