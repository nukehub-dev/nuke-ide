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
 * Short-lived, one-shot proposals for AI-created CAD documents.
 *
 * Creation has no active document to bind to, so this store is deliberately
 * separate from {@link NukeCadProposalService}: a proposal carries the resolved
 * template body and its preview build instead of a document epoch/revision.
 * Apply redeems the proposal exactly once; expiry and capacity are bounded.
 *
 * @module nuke-cad/browser/capabilities
 */

import { injectable } from '@theia/core/shared/inversify';
import type { Disposable } from '@theia/core/lib/common/disposable';
import type { NukeCadDocument } from '../../common/cad-document';
import type { ResolvedComponentParameter } from '../../common/component-templates';

/** Ten minutes is enough to review a creation card without leaving stale geometry around. */
export const CAD_CREATION_PROPOSAL_TTL_MS = 10 * 60 * 1000;

/** Bound the in-memory store; creation proposals hold a full template body. */
const CAD_CREATION_PROPOSAL_CAPACITY = 20;

/** Outcome of the preview build backing a creation proposal. */
export interface NukeCadCreationBuild {
    readonly success: boolean;
    readonly solidCount: number;
    readonly faceCount: number;
    readonly triangleCount: number;
    /** Warnings reported by the preview build. */
    readonly warnings: readonly string[];
}

/** Caller-supplied fields for a creation proposal. */
export interface NukeCadCreationProposalInput {
    readonly templateId: string;
    readonly templateName: string;
    /** SHA-256 of the resolved candidate document. */
    readonly templateHash: string;
    readonly summary: string;
    /** Every template parameter with its resolved document-unit value. */
    readonly parameters: readonly ResolvedComponentParameter[];
    /** Fully resolved, unsaved candidate document. */
    readonly document: NukeCadDocument;
    readonly build: NukeCadCreationBuild;
}

/** A resolved, built, unsaved document awaiting a target path. */
export interface NukeCadCreationProposal extends NukeCadCreationProposalInput {
    readonly id: string;
    readonly createdAt: number;
}

/** In-memory creation-proposal store with a fixed capacity and TTL. */
@injectable()
export class NukeCadCreationProposalService implements Disposable {
    protected readonly proposals = new Map<string, NukeCadCreationProposal>();

    /** Current time; overridden by tests for deterministic TTL checks. */
    protected now(): number {
        return Date.now();
    }

    /** Opaque proposal id. */
    protected createId(): string {
        return globalThis.crypto.randomUUID();
    }

    /**
     * Store a proposal, pruning expired entries and the oldest entry when full.
     *
     * @param input - Resolved template, parameters, body, and build result.
     * @returns A detached copy of the stored proposal.
     */
    create(input: NukeCadCreationProposalInput): NukeCadCreationProposal {
        this.pruneExpired();
        while (this.proposals.size >= CAD_CREATION_PROPOSAL_CAPACITY) {
            const oldest = this.proposals.keys().next();
            if (oldest.done === true) {
                break;
            }
            this.proposals.delete(oldest.value);
        }
        const proposal: NukeCadCreationProposal = {
            ...cloneValue(input),
            id: this.createId(),
            createdAt: this.now()
        };
        this.proposals.set(proposal.id, proposal);
        return cloneValue(proposal);
    }

    /**
     * Read a live proposal without consuming it.
     *
     * @param id - Proposal id.
     * @returns The proposal, or `undefined` when missing or expired.
     */
    get(id: string): NukeCadCreationProposal | undefined {
        this.pruneExpired();
        const proposal = this.proposals.get(id);
        return proposal === undefined ? undefined : cloneValue(proposal);
    }

    /**
     * Redeem a live proposal. A proposal can be applied at most once.
     *
     * @param id - Proposal id.
     * @returns The proposal, or `undefined` when missing or expired.
     */
    take(id: string): NukeCadCreationProposal | undefined {
        this.pruneExpired();
        const proposal = this.proposals.get(id);
        if (proposal === undefined) {
            return undefined;
        }
        this.proposals.delete(id);
        return cloneValue(proposal);
    }

    /** Remove a proposal without applying it. */
    remove(id: string): void {
        this.proposals.delete(id);
    }

    /** Remove every expired proposal. */
    prune(): void {
        this.pruneExpired();
    }

    /** Drop expired proposals without notifying listeners. */
    protected pruneExpired(): boolean {
        const cutoff = this.now() - CAD_CREATION_PROPOSAL_TTL_MS;
        let removed = false;
        for (const [id, proposal] of this.proposals) {
            if (proposal.createdAt <= cutoff) {
                this.proposals.delete(id);
                removed = true;
            }
        }
        return removed;
    }

    dispose(): void {
        this.proposals.clear();
    }
}

/** Deep-clone a JSON-compatible value so stored proposals stay detached. */
function cloneValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}
