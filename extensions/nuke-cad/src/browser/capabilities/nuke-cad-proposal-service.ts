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
 * CAD feature change proposal service
 *
 * In-memory store for previewed `.nuke-cad` feature-parameter edits. A proposal
 * pins the document path, epoch, and base revision the preview was resolved
 * against and stores detached before/after parameter snapshots, so an apply
 * capability can reject stale or cross-document proposals. Proposals expire
 * after ten minutes and the store keeps at most twenty, mirroring the OpenMC
 * change proposal store.
 *
 * Store changes are announced through `onDidChange` for review surfaces.
 * Reads (`get`/`has`/`list`) drop expired proposals silently so polling a
 * proposal never spams listeners; only explicit `prune()` announces expiry.
 *
 * @module nuke-cad/browser/capabilities
 */

import { Disposable } from '@theia/core/lib/common/disposable';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { injectable } from '@theia/core/shared/inversify';
import { NukeChange } from 'nuke-core/lib/common/nuke-capability-protocol';
import type { ResolvedFeatureEdit } from '../../common/cad-feature-edit';
import { FeatureParams } from '../../common/cad-document';
import { CadBoundingBox } from '../../common/nuke-cad-protocol';

/** Maximum number of feature proposals kept in memory. */
export const NUKE_CAD_FEATURE_PROPOSAL_LIMIT = 20;

/** Feature proposal lifetime in milliseconds. */
export const NUKE_CAD_FEATURE_PROPOSAL_TTL_MS = 10 * 60 * 1000;

/** Topology and size delta measured while previewing a feature proposal. */
export interface NukeCadProposalImpact {
    readonly solids: { readonly before: number; readonly after: number };
    readonly faces: { readonly before: number; readonly after: number };
    readonly triangles: { readonly before: number; readonly after: number };
    readonly boundingBox: { readonly before?: CadBoundingBox; readonly after?: CadBoundingBox };
}

/** Outcome of the preview build backing a feature proposal. */
export interface NukeCadProposalBuild {
    readonly success: boolean;
    readonly solidCount: number;
    readonly faceCount: number;
    readonly triangleCount: number;
}

/** A previewed feature change awaiting apply. */
export interface NukeCadFeatureProposal {
    readonly id: string;
    readonly scope: 'features';
    readonly summary: string;
    readonly documentPath: string;
    /** `CadDocumentStore.documentEpoch` when the preview was resolved. */
    readonly documentEpoch: number;
    /** `CadDocumentStore.revision` the preview was resolved against. */
    readonly baseRevision: number;
    readonly changes: readonly NukeChange[];
    readonly edits: readonly ResolvedFeatureEdit[];
    /** Parameter snapshot per feature id before the change. */
    readonly before: Record<string, FeatureParams>;
    /** Parameter snapshot per feature id after the change. */
    readonly after: Record<string, FeatureParams>;
    /** Optional topology and size delta measured by the preview. */
    readonly impact?: NukeCadProposalImpact;
    /** Optional outcome of the preview build. */
    readonly build?: NukeCadProposalBuild;
    readonly createdAt: number;
}

/** The payload stored when a feature preview creates a proposal. */
export interface NukeCadFeatureProposalInput {
    readonly scope: 'features';
    readonly summary: string;
    readonly documentPath: string;
    readonly documentEpoch: number;
    readonly baseRevision: number;
    readonly changes: readonly NukeChange[];
    readonly edits: readonly ResolvedFeatureEdit[];
    readonly before: Record<string, FeatureParams>;
    readonly after: Record<string, FeatureParams>;
    /** Optional topology and size delta measured by the preview. */
    readonly impact?: NukeCadProposalImpact;
    /** Optional outcome of the preview build. */
    readonly build?: NukeCadProposalBuild;
}

/**
 * Deep-clone a JSON-compatible value so stored snapshots stay detached.
 *
 * @param value - Value to clone; `undefined` is returned as-is.
 * @returns A detached copy.
 */
function cloneValue<T>(value: T): T {
    return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** In-memory feature proposal store with a fixed capacity and TTL. */
@injectable()
export class NukeCadProposalService implements Disposable {
    protected readonly proposals = new Map<string, NukeCadFeatureProposal>();
    protected readonly onDidChangeEmitter = new Emitter<void>();

    /** Fires whenever a proposal is added or removed from the store. */
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

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
     * @param input - Summary, document binding, diff, resolved edits,
     * before/after parameter snapshots, and optional preview metadata.
     * @returns A detached copy of the stored proposal.
     */
    create(input: NukeCadFeatureProposalInput): NukeCadFeatureProposal {
        this.pruneExpired();
        while (this.proposals.size >= NUKE_CAD_FEATURE_PROPOSAL_LIMIT) {
            const oldest = this.proposals.keys().next().value as string | undefined;
            if (oldest === undefined) {
                break;
            }
            this.proposals.delete(oldest);
        }
        const proposal: NukeCadFeatureProposal = {
            id: this.createId(),
            scope: input.scope,
            summary: input.summary,
            documentPath: input.documentPath,
            documentEpoch: input.documentEpoch,
            baseRevision: input.baseRevision,
            changes: cloneValue(input.changes),
            edits: cloneValue(input.edits),
            before: cloneValue(input.before),
            after: cloneValue(input.after),
            ...(input.impact === undefined ? {} : { impact: cloneValue(input.impact) }),
            ...(input.build === undefined ? {} : { build: cloneValue(input.build) }),
            createdAt: this.now()
        };
        this.proposals.set(proposal.id, proposal);
        this.onDidChangeEmitter.fire();
        return cloneValue(proposal);
    }

    /**
     * Read a live proposal. Expired proposals are removed before returning and
     * the result is a detached copy.
     *
     * @param id - Proposal id.
     * @returns The proposal, or `undefined` when missing or expired.
     */
    get(id: string): NukeCadFeatureProposal | undefined {
        this.pruneExpired();
        const proposal = this.proposals.get(id);
        return proposal === undefined ? undefined : cloneValue(proposal);
    }

    /**
     * Whether a live proposal exists for the id. Expired proposals are removed
     * before the lookup.
     *
     * @param id - Proposal id.
     * @returns Whether the proposal exists and has not expired.
     */
    has(id: string): boolean {
        this.pruneExpired();
        return this.proposals.has(id);
    }

    /**
     * List every live proposal in insertion order as detached clones. Expired
     * proposals are removed before the listing.
     *
     * @returns The live proposals.
     */
    list(): readonly NukeCadFeatureProposal[] {
        this.pruneExpired();
        return Array.from(this.proposals.values(), (proposal) => cloneValue(proposal));
    }

    /**
     * Remove a proposal.
     *
     * @param id - Proposal id.
     */
    remove(id: string): void {
        if (this.proposals.delete(id)) {
            this.onDidChangeEmitter.fire();
        }
    }

    /** Remove every expired proposal and notify listeners when the set changed. */
    prune(): void {
        if (this.pruneExpired()) {
            this.onDidChangeEmitter.fire();
        }
    }

    /**
     * Drop expired proposals without notifying listeners.
     *
     * @returns Whether any proposal was removed.
     */
    protected pruneExpired(): boolean {
        const cutoff = this.now() - NUKE_CAD_FEATURE_PROPOSAL_TTL_MS;
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
        this.onDidChangeEmitter.dispose();
    }
}
