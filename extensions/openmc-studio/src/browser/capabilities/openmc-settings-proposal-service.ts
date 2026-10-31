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
 * OpenMC Settings Proposal Service
 *
 * In-memory store for previewed settings edits. A proposal pins the exact
 * settings snapshot the preview was built from so apply can reject stale
 * edits, and it carries the computed after-settings for the write capability.
 * Proposals expire after ten minutes and the store keeps at most twenty, so a
 * long agent conversation cannot accumulate stale state.
 *
 * @module openmc-studio/browser/capabilities
 */

import { injectable } from '@theia/core/shared/inversify';
import { NukeChange } from 'nuke-core/lib/common/nuke-capability-protocol';
import { OpenMCSettings } from '../../common/openmc-state-schema';

/** Maximum number of proposals kept in memory. */
export const OPENMC_SETTINGS_PROPOSAL_LIMIT = 20;

/** Proposal lifetime in milliseconds. */
export const OPENMC_SETTINGS_PROPOSAL_TTL_MS = 10 * 60 * 1000;

/** A previewed settings edit awaiting apply. */
export interface OpenMCSettingsProposal {
    readonly id: string;
    readonly summary: string;
    readonly changes: readonly NukeChange[];
    readonly beforeSettings: OpenMCSettings;
    readonly afterSettings: OpenMCSettings;
    readonly createdAt: number;
}

/** The payload stored when a preview creates a proposal. */
export interface OpenMCSettingsProposalInput {
    readonly summary: string;
    readonly changes: readonly NukeChange[];
    readonly beforeSettings: OpenMCSettings;
    readonly afterSettings: OpenMCSettings;
}

/** In-memory proposal store with a fixed capacity and TTL. */
@injectable()
export class OpenMCSettingsProposalService {
    protected readonly proposals = new Map<string, OpenMCSettingsProposal>();

    /** Current time; overridden by tests for deterministic TTL checks. */
    protected now(): number {
        return Date.now();
    }

    /** Opaque proposal id. */
    protected createId(): string {
        return globalThis.crypto.randomUUID();
    }

    /**
     * Store a proposal, pruning expired entries and the oldest entry when the
     * store is full.
     *
     * @param input - Preview summary, diff, and before/after snapshots.
     * @returns The stored proposal.
     */
    create(input: OpenMCSettingsProposalInput): OpenMCSettingsProposal {
        this.prune();
        while (this.proposals.size >= OPENMC_SETTINGS_PROPOSAL_LIMIT) {
            const oldest = this.proposals.keys().next().value as string | undefined;
            if (oldest === undefined) {
                break;
            }
            this.proposals.delete(oldest);
        }
        const proposal: OpenMCSettingsProposal = {
            id: this.createId(),
            summary: input.summary,
            changes: input.changes,
            beforeSettings: input.beforeSettings,
            afterSettings: input.afterSettings,
            createdAt: this.now()
        };
        this.proposals.set(proposal.id, proposal);
        return proposal;
    }

    /**
     * Read a live proposal. Expired proposals are removed before returning.
     *
     * @param id - Proposal id.
     * @returns The proposal, or `undefined` when missing or expired.
     */
    get(id: string): OpenMCSettingsProposal | undefined {
        const proposal = this.proposals.get(id);
        if (!proposal) {
            return undefined;
        }
        if (this.isExpired(proposal)) {
            this.proposals.delete(id);
            return undefined;
        }
        return proposal;
    }

    /**
     * Remove a proposal.
     *
     * @param id - Proposal id.
     * @returns Whether a proposal was removed.
     */
    remove(id: string): boolean {
        return this.proposals.delete(id);
    }

    /** Remove every expired proposal. */
    protected prune(): void {
        for (const [id, proposal] of this.proposals) {
            if (this.isExpired(proposal)) {
                this.proposals.delete(id);
            }
        }
    }

    /** True when the proposal reached the TTL. */
    protected isExpired(proposal: OpenMCSettingsProposal): boolean {
        return this.now() - proposal.createdAt >= OPENMC_SETTINGS_PROPOSAL_TTL_MS;
    }
}
