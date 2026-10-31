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
 * Tests the in-memory OpenMC settings proposal store.
 */

import { describe, expect, it } from 'vitest';
import type { OpenMCSettings } from '../../common/openmc-state-schema';
import {
    OPENMC_SETTINGS_PROPOSAL_LIMIT,
    OPENMC_SETTINGS_PROPOSAL_TTL_MS,
    OpenMCSettingsProposalInput,
    OpenMCSettingsProposalService
} from './openmc-settings-proposal-service';

class TestProposalService extends OpenMCSettingsProposalService {
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

function buildSettings(): OpenMCSettings {
    return {
        run: { mode: 'eigenvalue', particles: 1000, inactive: 10, batches: 50 },
        sources: []
    };
}

function buildInput(summary = 'Tune run'): OpenMCSettingsProposalInput {
    const beforeSettings = buildSettings();
    const afterSettings = buildSettings();
    (afterSettings.run as { particles: number }).particles = 2000;
    return {
        summary,
        changes: [{ path: 'run.particles', label: 'Particles per batch', kind: 'update', before: 1000, after: 2000 }],
        beforeSettings,
        afterSettings
    };
}

describe('OpenMCSettingsProposalService', () => {
    it('creates, reads, and removes proposals', () => {
        const service = new TestProposalService();
        const input = buildInput();
        const proposal = service.create(input);

        expect(proposal).toMatchObject({
            id: 'proposal-1',
            summary: 'Tune run',
            changes: input.changes,
            beforeSettings: input.beforeSettings,
            afterSettings: input.afterSettings,
            createdAt: service.clock.now
        });
        expect(service.get('proposal-1')).toBe(proposal);
        expect(service.remove('proposal-1')).toBe(true);
        expect(service.get('proposal-1')).toBeUndefined();
        expect(service.remove('proposal-1')).toBe(false);
    });

    it('expires proposals at the ten-minute TTL', () => {
        const service = new TestProposalService();
        service.create(buildInput());

        service.clock.now += OPENMC_SETTINGS_PROPOSAL_TTL_MS - 1;
        expect(service.get('proposal-1')).toBeDefined();

        service.clock.now += 1;
        expect(service.get('proposal-1')).toBeUndefined();
        expect(service.get('proposal-1')).toBeUndefined();
    });

    it('prunes expired proposals when creating a new one', () => {
        const service = new TestProposalService();
        service.create(buildInput('First'));
        service.clock.now += OPENMC_SETTINGS_PROPOSAL_TTL_MS;

        service.create(buildInput('Second'));

        expect(service.get('proposal-1')).toBeUndefined();
        expect(service.get('proposal-2')?.summary).toBe('Second');
    });

    it('keeps at most the configured number of proposals and evicts the oldest', () => {
        const service = new TestProposalService();
        for (let index = 0; index < OPENMC_SETTINGS_PROPOSAL_LIMIT + 1; index++) {
            service.create(buildInput(`Change ${index + 1}`));
        }

        expect(service.get('proposal-1')).toBeUndefined();
        expect(service.get(`proposal-${OPENMC_SETTINGS_PROPOSAL_LIMIT}`)?.summary).toBe(`Change ${OPENMC_SETTINGS_PROPOSAL_LIMIT}`);
        expect(service.get(`proposal-${OPENMC_SETTINGS_PROPOSAL_LIMIT + 1}`)?.summary).toBe(`Change ${OPENMC_SETTINGS_PROPOSAL_LIMIT + 1}`);
    });
});
