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
import { NukeCapability, NukeCapabilityContext } from '../../common/nuke-capability-protocol';
import { buildCapabilityCatalog, capabilityVersion, formatCapabilityDetails } from './nuke-capability-catalog';

function capability(overrides: Partial<NukeCapability> = {}): NukeCapability {
    return {
        id: 'nuke.example.describe',
        title: 'Describe',
        description: 'Describe the current state.',
        category: ['Example', 'Project'],
        inputSchema: { type: 'object', properties: {} },
        risk: 'read',
        invoke: async () => ({ ok: true }),
        ...overrides
    };
}

const CONTEXT: NukeCapabilityContext = { workspaceRoots: ['/workspace'] };

describe('buildCapabilityCatalog', () => {
    it('defaults a missing version to 1 and preserves an explicit version', () => {
        expect(capabilityVersion(capability())).toBe(1);
        expect(capabilityVersion(capability({ version: 3 }))).toBe(3);

        const entries = buildCapabilityCatalog([
            capability({ id: 'nuke.example.defaultVersion' }),
            capability({ id: 'nuke.example.explicitVersion', version: 2 })
        ]);

        expect(entries.map((entry) => entry.version)).toEqual([1, 2]);
    });

    it('projects id, title, risk, tags, and category without handlers', () => {
        const entries = buildCapabilityCatalog([
            capability({ id: 'nuke.example.write', title: 'Write it', risk: 'write', tags: ['settings', 'safe'] })
        ]);

        expect(entries).toEqual([
            {
                id: 'nuke.example.write',
                title: 'Write it',
                risk: 'write',
                version: 1,
                tags: ['settings', 'safe'],
                category: 'Example / Project',
                available: true
            }
        ]);
        expect(entries[0]).not.toHaveProperty('invoke');
    });

    it('marks capabilities unavailable when a context is supplied', () => {
        const entries = buildCapabilityCatalog(
            [
                capability({ id: 'nuke.example.always' }),
                capability({ id: 'nuke.example.cadOnly', when: (current) => current.activeCadDocument !== undefined }),
                capability({
                    id: 'nuke.example.broken',
                    when: () => {
                        throw new Error('predicate failed');
                    }
                })
            ],
            CONTEXT
        );

        expect(entries.map((entry) => [entry.id, entry.available])).toEqual([
            ['nuke.example.always', true],
            ['nuke.example.cadOnly', false],
            ['nuke.example.broken', false]
        ]);
    });

    it('keeps the registry order and defaults tags to an empty list', () => {
        const entries = buildCapabilityCatalog([
            capability({ id: 'nuke.example.second', title: 'Second' }),
            capability({ id: 'nuke.example.first', title: 'First' })
        ]);

        expect(entries.map((entry) => entry.id)).toEqual(['nuke.example.second', 'nuke.example.first']);
        expect(entries[0].tags).toEqual([]);
    });
});

describe('formatCapabilityDetails', () => {
    it('includes identity, version, risk, tags, and availability as read-only lines', () => {
        const entry = buildCapabilityCatalog([capability({ version: 4, tags: ['audit'] })])[0];
        const details = formatCapabilityDetails(entry, capability({ version: 4, tags: ['audit'] })).join('\n');

        expect(details).toContain('Describe the current state.');
        expect(details).toContain('Id: nuke.example.describe');
        expect(details).toContain('Title: Describe');
        expect(details).toContain('Version: 4');
        expect(details).toContain('Risk: read');
        expect(details).toContain('Category: Example / Project');
        expect(details).toContain('Tags: audit');
        expect(details).toContain('Availability: available in the current context');
    });
});
