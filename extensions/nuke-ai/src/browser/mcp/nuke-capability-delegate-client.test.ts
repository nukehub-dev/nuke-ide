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

import { describe, expect, it, vi } from 'vitest';
import { Event } from '@theia/core/lib/common/event';
import {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityContextService,
    NukeCapabilityRegistry,
    NukeCapabilityResult
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { SPIKE_CAPABILITY } from '../../common/nuke-mcp-protocol';
import type { NukeResourceService } from '../resources/nuke-resource-service';
import { NukeCapabilityDelegateClientImpl, toCapabilityDescriptor } from './nuke-capability-delegate-client';

vi.mock('@theia/filesystem/lib/browser/file-service', () => ({
    FileService: Symbol('FileService')
}));

interface TestSetup {
    readonly client: NukeCapabilityDelegateClientImpl;
    readonly invoke: ReturnType<typeof vi.fn>;
    readonly read: ReturnType<typeof vi.fn>;
    readonly context: NukeCapabilityContext;
}

function capability(invokeResult: NukeCapabilityResult = { ok: true, data: { success: true } }): NukeCapability {
    return {
        ...SPIKE_CAPABILITY,
        invoke: vi.fn(async () => invokeResult)
    };
}

function setup(candidate: NukeCapability = capability(), enabled = true): TestSetup {
    const context: NukeCapabilityContext = {
        workspaceRoots: ['/workspace'],
        activeCadDocument: '/workspace/model.nuke-cad'
    };
    const registry = {
        ready: Promise.resolve(),
        onDidChange: Event.None,
        register: vi.fn(),
        get: (id: string) => (id === candidate.id ? candidate : undefined),
        getAll: () => [candidate],
        getEnabled: () => (enabled ? [candidate] : [])
    } as unknown as NukeCapabilityRegistry;
    const contextService = {
        getContext: vi.fn(async () => context),
        onDidChangeContext: Event.None
    } as unknown as NukeCapabilityContextService;
    const read = vi.fn(async (uri: string) => `resource:${uri}`);
    const resourceService = { read } as unknown as NukeResourceService;
    return {
        client: new NukeCapabilityDelegateClientImpl(registry, contextService, resourceService),
        invoke: candidate.invoke as unknown as ReturnType<typeof vi.fn>,
        read,
        context
    };
}

describe('NukeCapabilityDelegateClientImpl', () => {
    it('projects enabled capabilities without handlers or predicates', async () => {
        const { client } = setup();

        const descriptors = await client.listCapabilities();

        expect(descriptors).toHaveLength(1);
        expect(descriptors[0]).toEqual(toCapabilityDescriptor(capability()));
        expect(descriptors[0]).not.toHaveProperty('invoke');
        expect(descriptors[0]).not.toHaveProperty('when');
        expect(descriptors[0]).toMatchObject({
            id: SPIKE_CAPABILITY.id,
            title: SPIKE_CAPABILITY.title,
            risk: 'read',
            inputSchema: SPIKE_CAPABILITY.inputSchema,
            outputSchema: SPIKE_CAPABILITY.outputSchema
        });
    });

    it('omits capabilities disabled by the registry context', async () => {
        const { client } = setup(capability(), false);

        expect(await client.listCapabilities()).toEqual([]);
    });

    it('invokes a known capability with the ambient context', async () => {
        const result = { ok: true, data: { solidCount: 1 } };
        const { client, invoke, context } = setup(capability(result));

        expect(await client.invoke(SPIKE_CAPABILITY.id, { includeSolids: true })).toEqual(result);
        expect(invoke).toHaveBeenCalledWith({ includeSolids: true }, context);
    });

    it('rejects invalid input before calling the capability', async () => {
        const { client, invoke } = setup();

        const result = await client.invoke(SPIKE_CAPABILITY.id, { includeSolids: 'yes' });

        expect(result.ok).toBe(false);
        expect(result.message).toContain('includeSolids');
        expect(result.message).toContain('boolean');
        expect(invoke).not.toHaveBeenCalled();
    });

    it('returns an error result for an unknown capability', async () => {
        const { client } = setup();

        expect(await client.invoke('nuke.cad.missing', {})).toEqual({
            ok: false,
            message: 'Unknown capability: nuke.cad.missing.'
        });
    });

    it('returns an error result when the capability is unavailable in the context', async () => {
        const { client } = setup({ ...capability(), when: () => false });

        const result = await client.invoke(SPIKE_CAPABILITY.id, {});

        expect(result.ok).toBe(false);
        expect(result.message).toContain('not available');
    });

    it('turns a thrown capability error into a failed result', async () => {
        const candidate = {
            ...capability(),
            invoke: vi.fn(async () => {
                throw new Error('backend exploded');
            })
        };
        const { client } = setup(candidate);

        expect(await client.invoke(SPIKE_CAPABILITY.id, {})).toEqual({
            ok: false,
            message: 'Capability nuke.cad.summarizeDocument failed: backend exploded'
        });
    });

    it('delegates resource reads to the scoped resource service', async () => {
        const { client, read } = setup();

        expect(await client.readResource('nuke://context')).toBe('resource:nuke://context');
        expect(read).toHaveBeenCalledWith('nuke://context');
    });

    it('keeps the spike capability read-only and structurally complete', () => {
        expect(SPIKE_CAPABILITY).toMatchObject({
            id: 'nuke.cad.summarizeDocument',
            title: 'Summarize CAD document',
            risk: 'read',
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            }
        });
        expect(SPIKE_CAPABILITY.inputSchema.properties.includeSolids).toMatchObject({ type: 'boolean', default: false });
        expect(SPIKE_CAPABILITY.outputSchema?.required).toEqual(['documentPath', 'success', 'selection']);
        expect(SPIKE_CAPABILITY.outputSchema?.properties.selection).toBeDefined();
        expect(SPIKE_CAPABILITY.outputSchema?.properties.solids).toBeDefined();
    });
});
