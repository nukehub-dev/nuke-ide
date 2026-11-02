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
 * CAD edit proposal service
 *
 * In-memory store for previewed `.nuke-cad` edits: feature-parameter changes
 * and sketch-dimension changes. A proposal pins the document path, epoch, and
 * base revision the preview was resolved against and stores detached
 * before/after snapshots, so an apply capability can reject stale or
 * cross-document proposals. Proposals expire after ten minutes and the store
 * keeps at most twenty, mirroring the OpenMC change proposal store.
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
import { FeatureParams, SketchDef } from '../../common/cad-document';
import type { ResolvedSketchEdit, SketchSolveSummary } from '../sketch/sketch-edit-types';
import { CadBoundingBox } from '../../common/nuke-cad-protocol';

/** Maximum number of CAD proposals kept in memory. */
export const NUKE_CAD_FEATURE_PROPOSAL_LIMIT = 20;

/** CAD proposal lifetime in milliseconds. */
export const NUKE_CAD_FEATURE_PROPOSAL_TTL_MS = 10 * 60 * 1000;

/** Apply capability used when a sketch preview does not name one. */
const DEFAULT_SKETCH_APPLY_CAPABILITY_ID = 'nuke.cad.applySketchChange';

/** Topology and size delta measured while previewing a CAD edit proposal. */
export interface NukeCadProposalImpact {
    readonly solids: { readonly before: number; readonly after: number };
    readonly faces: { readonly before: number; readonly after: number };
    readonly triangles: { readonly before: number; readonly after: number };
    readonly boundingBox: { readonly before?: CadBoundingBox; readonly after?: CadBoundingBox };
}

/** Outcome of the preview build backing a CAD edit proposal. */
export interface NukeCadProposalBuild {
    readonly success: boolean;
    readonly solidCount: number;
    readonly faceCount: number;
    readonly triangleCount: number;
}

/** Fields shared by every previewed CAD edit proposal. */
export interface NukeCadProposalCommon {
    readonly id: string;
    readonly summary: string;
    readonly documentPath: string;
    /** `CadDocumentStore.documentEpoch` when the preview was resolved. */
    readonly documentEpoch: number;
    /** `CadDocumentStore.revision` the preview was resolved against. */
    readonly baseRevision: number;
    readonly changes: readonly NukeChange[];
    /** Optional topology and size delta measured by the preview. */
    readonly impact?: NukeCadProposalImpact;
    /** Optional outcome of the preview build. */
    readonly build?: NukeCadProposalBuild;
    readonly createdAt: number;
}

/** Caller-supplied fields shared by every previewed CAD edit proposal. */
export interface NukeCadProposalCommonInput {
    readonly summary: string;
    readonly documentPath: string;
    readonly documentEpoch: number;
    readonly baseRevision: number;
    readonly changes: readonly NukeChange[];
    /** Optional topology and size delta measured by the preview. */
    readonly impact?: NukeCadProposalImpact;
    /** Optional outcome of the preview build. */
    readonly build?: NukeCadProposalBuild;
}

/** A previewed feature change awaiting apply. */
export interface NukeCadFeatureProposal extends NukeCadProposalCommon {
    readonly scope: 'features';
    /** Capability that applies the stored proposal; defaults to `nuke.cad.applyFeatureChange`. */
    readonly applyCapability?: string;
    readonly edits: readonly ResolvedFeatureEdit[];
    /** Parameter snapshot per feature id before the change. */
    readonly before: Record<string, FeatureParams>;
    /** Parameter snapshot per feature id after the change. */
    readonly after: Record<string, FeatureParams>;
}

/** The payload stored when a feature preview creates a proposal. */
export interface NukeCadFeatureProposalInput extends NukeCadProposalCommonInput {
    readonly scope: 'features';
    /** Capability that applies the stored proposal; defaults to `nuke.cad.applyFeatureChange`. */
    readonly applyCapability?: string;
    readonly edits: readonly ResolvedFeatureEdit[];
    /** Parameter snapshot per feature id before the change. */
    readonly before: Record<string, FeatureParams>;
    /** Parameter snapshot per feature id after the change. */
    readonly after: Record<string, FeatureParams>;
}

/** Detached sketch and parameter snapshots captured by a sketch preview. */
export interface NukeCadSketchProposalDetails {
    readonly targetSketchId: string;
    readonly targetSketchName: string;
    readonly affectedSketchIds: readonly string[];
    readonly affectedFeatureIds: readonly string[];
    readonly beforeSketches: Readonly<Record<string, SketchDef>>;
    readonly afterSketches: Readonly<Record<string, SketchDef>>;
    readonly beforeParameters: Readonly<Record<string, number>>;
    readonly afterParameters: Readonly<Record<string, number>>;
    readonly solver: SketchSolveSummary;
    readonly edits: readonly ResolvedSketchEdit[];
}

/** A previewed sketch-dimension change awaiting apply. */
export interface NukeCadSketchProposal extends NukeCadProposalCommon {
    readonly scope: 'sketch';
    /** Capability that applies the stored proposal. */
    readonly applyCapability: string;
    readonly sketch: NukeCadSketchProposalDetails;
}

/** The payload stored when a sketch preview creates a proposal. */
export interface NukeCadSketchProposalInput extends NukeCadProposalCommonInput {
    readonly scope: 'sketch';
    /** Capability that applies the stored proposal; defaults to `nuke.cad.applySketchChange`. */
    readonly applyCapability?: string;
    readonly sketch: NukeCadSketchProposalDetails;
}

/** Any previewed CAD edit awaiting apply. */
export type NukeCadProposal = NukeCadFeatureProposal | NukeCadSketchProposal;

/**
 * Deep-clone a JSON-compatible value so stored snapshots stay detached.
 *
 * @param value - Value to clone; `undefined` is returned as-is.
 * @returns A detached copy.
 */
function cloneValue<T>(value: T): T {
    return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** Whether a proposal edits sketch dimensions rather than feature parameters. */
export function isSketchProposal(proposal: NukeCadProposal): proposal is NukeCadSketchProposal {
    return proposal.scope === 'sketch';
}

/** In-memory CAD proposal store with a fixed capacity and TTL. */
@injectable()
export class NukeCadProposalService implements Disposable {
    protected readonly proposals = new Map<string, NukeCadProposal>();
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
     * store is full. The input is cloned so later caller mutations do not
     * change the stored proposal.
     *
     * @param input - Summary, document binding, diff, resolved edits,
     * before/after snapshots, and optional preview metadata.
     * @returns A detached copy of the stored proposal.
     */
    create(input: NukeCadFeatureProposalInput): NukeCadFeatureProposal;
    create(input: NukeCadSketchProposalInput): NukeCadSketchProposal;
    create(input: NukeCadFeatureProposalInput | NukeCadSketchProposalInput): NukeCadProposal;
    create(input: NukeCadFeatureProposalInput | NukeCadSketchProposalInput): NukeCadProposal {
        this.pruneExpired();
        while (this.proposals.size >= NUKE_CAD_FEATURE_PROPOSAL_LIMIT) {
            const oldest = this.proposals.keys().next().value as string | undefined;
            if (oldest === undefined) {
                break;
            }
            this.proposals.delete(oldest);
        }
        const cloned = cloneValue(input);
        const createdAt = this.now();
        const proposal: NukeCadProposal =
            cloned.scope === 'sketch'
                ? {
                      ...cloned,
                      id: this.createId(),
                      applyCapability: cloned.applyCapability ?? DEFAULT_SKETCH_APPLY_CAPABILITY_ID,
                      createdAt
                  }
                : { ...cloned, id: this.createId(), createdAt };
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
    get(id: string): NukeCadProposal | undefined {
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
    list(): readonly NukeCadProposal[] {
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
