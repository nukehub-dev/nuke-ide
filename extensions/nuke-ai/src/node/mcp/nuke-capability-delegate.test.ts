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

import { describe, expect, it } from 'vitest';
import { NukeCapabilityDelegateClient, NukeCapabilityDescriptor, NukeMcpResourceDescriptor } from '../../common/nuke-capability-delegate';
import { FRONTEND_NOT_CONNECTED, NukeCapabilityDelegateImpl } from './nuke-capability-delegate';

function client(label: string): NukeCapabilityDelegateClient {
    return {
        listCapabilities: async (): Promise<NukeCapabilityDescriptor[]> => [{ id: label } as NukeCapabilityDescriptor],
        listResources: async (): Promise<NukeMcpResourceDescriptor[]> => [],
        invoke: async () => ({ ok: true, data: label }),
        readResource: async () => label
    };
}

describe('NukeCapabilityDelegateImpl', () => {
    it('fails closed without a frontend', async () => {
        const delegate = new NukeCapabilityDelegateImpl();

        await expect(delegate.listCapabilities()).rejects.toThrow(FRONTEND_NOT_CONNECTED);
    });

    it('serves the oldest live frontend and promotes the next on disconnect', async () => {
        const delegate = new NukeCapabilityDelegateImpl();
        const first = client('first');
        const second = client('second');

        delegate.setClient(first);
        delegate.setClient(second);
        delegate.setClient(first);

        expect((await delegate.listCapabilities())[0].id).toBe('first');
        expect(await delegate.readResource('nuke://context')).toBe('first');

        delegate.removeClient(first);
        expect((await delegate.listCapabilities())[0].id).toBe('second');
        expect(await delegate.readResource('nuke://context')).toBe('second');

        delegate.removeClient(second);
        await expect(delegate.listCapabilities()).rejects.toThrow(FRONTEND_NOT_CONNECTED);
    });
});
