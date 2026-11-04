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
 * OpenMC Change Proposal Service
 *
 * In-memory store for previewed OpenMC model edits. Every proposal is scoped
 * to one domain (settings, materials, tallies, or project metadata) and pins
 * the scoped snapshots the preview was built from, so apply capabilities can
 * reject stale or cross-domain proposals. Snapshots are deep-cloned on create
 * and on read, proposals expire after ten minutes, and the store keeps at most
 * twenty, so a long agent conversation cannot accumulate stale state.
 *
 * @module openmc-studio/browser/capabilities
 */

import { injectable } from '@theia/core/shared/inversify';
import { NukeChange } from 'nuke-core/lib/common/nuke-capability-protocol';

/** Maximum number of proposals kept in memory. */
export const OPENMC_CHANGE_PROPOSAL_LIMIT = 20;

/** Proposal lifetime in milliseconds. */
export const OPENMC_CHANGE_PROPOSAL_TTL_MS = 10 * 60 * 1000;

/** Domain that owns a previewed change. */
export type OpenMCChangeScope = 'settings' | 'materials' | 'tallies' | 'project' | 'dagmc' | 'geometry';

/** A previewed change awaiting apply. */
export interface OpenMCChangeProposal {
    readonly id: string;
    readonly scope: OpenMCChangeScope;
    readonly summary: string;
    readonly changes: readonly NukeChange[];
    /** Scoped snapshot before the change (settings object, materials array, ...). */
    readonly before: unknown;
    /** Scoped snapshot after the change. */
    readonly after: unknown;
    readonly createdAt: number;
}

/** The payload stored when a preview creates a proposal. */
export interface OpenMCChangeProposalInput {
    readonly scope: OpenMCChangeScope;
    readonly summary: string;
    readonly changes: readonly NukeChange[];
    readonly before: unknown;
    readonly after: unknown;
}

/** Display label for a scope in cross-domain rejection messages. */
const SCOPE_LABELS: Record<OpenMCChangeScope, string> = {
    settings: 'settings',
    materials: 'materials',
    tallies: 'tallies',
    project: 'project metadata',
    dagmc: 'DAGMC geometry',
    geometry: 'CSG geometry'
};

/**
 * Deep-clone a JSON-compatible value so stored snapshots stay detached.
 *
 * @param value - Value to clone; `undefined` is returned as-is.
 * @returns A detached copy.
 */
export function clone<T>(value: T): T {
    return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Check that a proposal belongs to the expected domain.
 *
 * @param proposal - Proposal being applied.
 * @param scope - Domain the apply capability owns.
 * @returns `undefined` when the scopes match, otherwise a message naming both.
 */
export function scopeError(proposal: Pick<OpenMCChangeProposal, 'id' | 'scope'>, scope: OpenMCChangeScope): string | undefined {
    if (proposal.scope === scope) {
        return undefined;
    }
    return `Proposal ${proposal.id} is for ${SCOPE_LABELS[proposal.scope]}, not ${SCOPE_LABELS[scope]}.`;
}

/** In-memory proposal store with a fixed capacity and TTL. */
@injectable()
export class OpenMCChangeProposalService {
    protected readonly proposals = new Map<string, OpenMCChangeProposal>();

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
     * store is full. Snapshots are cloned so later caller mutations do not
     * change the stored proposal.
     *
     * @param input - Scope, preview summary, diff, and before/after snapshots.
     * @returns A detached copy of the stored proposal.
     */
    create(input: OpenMCChangeProposalInput): OpenMCChangeProposal {
        this.prune();
        while (this.proposals.size >= OPENMC_CHANGE_PROPOSAL_LIMIT) {
            const oldest = this.proposals.keys().next().value as string | undefined;
            if (oldest === undefined) {
                break;
            }
            this.proposals.delete(oldest);
        }
        const proposal: OpenMCChangeProposal = {
            id: this.createId(),
            scope: input.scope,
            summary: input.summary,
            changes: clone(input.changes),
            before: clone(input.before),
            after: clone(input.after),
            createdAt: this.now()
        };
        this.proposals.set(proposal.id, proposal);
        return clone(proposal);
    }

    /**
     * Read a live proposal. Expired proposals are removed before returning and
     * the result is a detached copy.
     *
     * @param id - Proposal id.
     * @returns The proposal, or `undefined` when missing or expired.
     */
    get(id: string): OpenMCChangeProposal | undefined {
        const proposal = this.proposals.get(id);
        if (!proposal) {
            return undefined;
        }
        if (this.isExpired(proposal)) {
            this.proposals.delete(id);
            return undefined;
        }
        return clone(proposal);
    }

    /**
     * Whether a live proposal exists for the id. Expired proposals are removed.
     *
     * @param id - Proposal id.
     * @returns Whether the proposal exists and has not expired.
     */
    has(id: string): boolean {
        const proposal = this.proposals.get(id);
        if (!proposal) {
            return false;
        }
        if (this.isExpired(proposal)) {
            this.proposals.delete(id);
            return false;
        }
        return true;
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
    protected isExpired(proposal: OpenMCChangeProposal): boolean {
        return this.now() - proposal.createdAt >= OPENMC_CHANGE_PROPOSAL_TTL_MS;
    }
}
