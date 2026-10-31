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
 * Tests the in-memory OpenMC change proposal store.
 */

import { describe, expect, it } from 'vitest';
import type { OpenMCSettings } from '../../common/openmc-state-schema';
import {
    clone,
    OPENMC_CHANGE_PROPOSAL_LIMIT,
    OPENMC_CHANGE_PROPOSAL_TTL_MS,
    OpenMCChangeProposalInput,
    OpenMCChangeProposalService,
    OpenMCChangeScope,
    scopeError
} from './openmc-change-proposal-service';

class TestProposalService extends OpenMCChangeProposalService {
    readonly clock = { now: 1_000_000 };
    protected counter = 0;

    protected override now(): number {
        return this.clock.now;
    }

    protected override createId(): string {
        this.counter += 1;
        return `proposal-${this.counter}`;
    }
}

function buildSettings(particles = 1000): OpenMCSettings {
    return {
        run: { mode: 'eigenvalue', particles, inactive: 10, batches: 50 },
        sources: []
    };
}

function buildInput(summary = 'Tune run', scope: OpenMCChangeScope = 'settings'): OpenMCChangeProposalInput {
    return {
        scope,
        summary,
        changes: [{ path: 'run.particles', label: 'Particles per batch', kind: 'update', before: 1000, after: 2000 }],
        before: buildSettings(),
        after: buildSettings(2000)
    };
}

describe('OpenMCChangeProposalService', () => {
    it('creates, reads, and removes proposals', () => {
        const service = new TestProposalService();
        const input = buildInput();
        const proposal = service.create(input);

        expect(proposal).toEqual({
            id: 'proposal-1',
            scope: 'settings',
            summary: 'Tune run',
            changes: input.changes,
            before: input.before,
            after: input.after,
            createdAt: service.clock.now
        });
        expect(service.has('proposal-1')).toBe(true);
        expect(service.get('proposal-1')).toEqual(proposal);
        expect(service.remove('proposal-1')).toBe(true);
        expect(service.has('proposal-1')).toBe(false);
        expect(service.get('proposal-1')).toBeUndefined();
        expect(service.remove('proposal-1')).toBe(false);
    });

    it('expires proposals at the ten-minute TTL', () => {
        const service = new TestProposalService();
        service.create(buildInput());

        service.clock.now += OPENMC_CHANGE_PROPOSAL_TTL_MS - 1;
        expect(service.get('proposal-1')).toBeDefined();

        service.clock.now += 1;
        expect(service.get('proposal-1')).toBeUndefined();
        expect(service.has('proposal-1')).toBe(false);
        expect(service.get('proposal-1')).toBeUndefined();
    });

    it('prunes expired proposals when creating a new one', () => {
        const service = new TestProposalService();
        service.create(buildInput('First'));
        service.clock.now += OPENMC_CHANGE_PROPOSAL_TTL_MS;

        service.create(buildInput('Second'));

        expect(service.get('proposal-1')).toBeUndefined();
        expect(service.get('proposal-2')?.summary).toBe('Second');
    });

    it('keeps at most the configured number of proposals and evicts the oldest', () => {
        const service = new TestProposalService();
        for (let index = 0; index < OPENMC_CHANGE_PROPOSAL_LIMIT + 1; index++) {
            service.create(buildInput(`Change ${index + 1}`));
        }

        expect(service.get('proposal-1')).toBeUndefined();
        expect(service.get(`proposal-${OPENMC_CHANGE_PROPOSAL_LIMIT}`)?.summary).toBe(`Change ${OPENMC_CHANGE_PROPOSAL_LIMIT}`);
        expect(service.get(`proposal-${OPENMC_CHANGE_PROPOSAL_LIMIT + 1}`)?.summary).toBe(`Change ${OPENMC_CHANGE_PROPOSAL_LIMIT + 1}`);
    });

    it('clones snapshots on create and on read', () => {
        const service = new TestProposalService();
        const input = buildInput();
        const proposal = service.create(input);

        (input.before as { run: { particles: number } }).run.particles = 111;
        (input.after as { run: { particles: number } }).run.particles = 111;
        (input.changes[0] as { after: unknown }).after = 111;
        (proposal as { summary: string }).summary = 'Mutated';

        const stored = service.get('proposal-1')!;
        expect(stored.summary).toBe('Tune run');
        expect(stored.before).toMatchObject({ run: { particles: 1000 } });
        expect(stored.after).toMatchObject({ run: { particles: 2000 } });
        expect(stored.changes[0].after).toBe(2000);

        (stored.before as { run: { particles: number } }).run.particles = 222;
        (stored.after as { run: { particles: number } }).run.particles = 222;
        (stored.changes[0] as { after: unknown }).after = 222;

        const reread = service.get('proposal-1')!;
        expect(reread.before).toMatchObject({ run: { particles: 1000 } });
        expect(reread.after).toMatchObject({ run: { particles: 2000 } });
        expect(reread.changes[0].after).toBe(2000);
    });

    it('deep-clones detached values', () => {
        const source = { nested: { value: 1 }, list: [1, 2] };
        const copy = clone(source);
        copy.nested.value = 2;
        copy.list.push(3);

        expect(source).toEqual({ nested: { value: 1 }, list: [1, 2] });
        expect(clone(undefined)).toBeUndefined();
    });

    it('accepts matching scopes and rejects cross-domain proposals', () => {
        const service = new TestProposalService();
        const settings = service.create(buildInput());
        const materials = service.create(buildInput('Swap materials', 'materials'));

        expect(scopeError(settings, 'settings')).toBeUndefined();
        expect(scopeError(materials, 'materials')).toBeUndefined();
        expect(scopeError(materials, 'settings')).toBe('Proposal proposal-2 is for materials, not settings.');
        expect(scopeError(settings, 'tallies')).toBe('Proposal proposal-1 is for settings, not tallies.');
        expect(scopeError(materials, 'project')).toBe('Proposal proposal-2 is for materials, not project metadata.');
    });

    it('generates unique UUID ids', () => {
        const service = new OpenMCChangeProposalService();
        const ids = new Set<string>();
        for (let index = 0; index < OPENMC_CHANGE_PROPOSAL_LIMIT; index++) {
            ids.add(service.create(buildInput(`Change ${index + 1}`)).id);
        }

        expect(ids.size).toBe(OPENMC_CHANGE_PROPOSAL_LIMIT);
        for (const id of ids) {
            expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        }
    });
});
