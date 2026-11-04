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
 * In-memory store for previewed `.nuke-cad` edits: feature-parameter changes,
 * sketch-dimension changes, topology changes with their region and OpenMC
 * impact, imported bodies, assembly-instance placement changes, drawing
 * sheet/view/dimension settings, and sandboxed Python script replacements. A proposal
 * pins the document path, epoch, and base revision the
 * preview was resolved against and stores detached before/after snapshots, so
 * an apply capability can reject stale or cross-document proposals. Proposals
 * expire after ten minutes and the store keeps at most twenty, mirroring the
 * OpenMC change proposal store.
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
import type { AssemblyChangeInput, AssemblyPlacementPlan, AssemblyRemovedRegion } from '../../common/cad-assembly-edit';
import type { AssemblyBomDelta, AssemblyBomQuantityRow } from '../../common/assembly-bom';
import type { AssemblyInstance } from '../../common/assembly-document';
import type { DrawingDimensionKind, DrawingSheetSize, DrawingViewKind, DrawingViewOrientation } from '../../common/cad-drawing';
import type { DrawingChangeAction } from '../../common/cad-drawing-edit';
import type { ResolvedFeatureEdit } from '../../common/cad-feature-edit';
import { FeatureParams, SketchDef } from '../../common/cad-document';
import type { FeatureTopologyAction } from '../../common/cad-topology-edit';
import type { TopologyImpact, TopologyRegionRef } from '../../common/topology-impact';
import type { OpenmcReferenceSnapshot, OpenmcRegionBlocker } from '../../common/openmc-region-references';
import type { ResolvedSketchEdit, SketchSolveSummary } from '../sketch/sketch-edit-types';
import { CadBoundingBox, ImportSolidInfo, ImportSourceFormat, ImportSourceUnit } from '../../common/nuke-cad-protocol';
import type { ImportBodyDraft } from '../document/cad-document-store';

/** Maximum number of CAD proposals kept in memory. */
export const NUKE_CAD_FEATURE_PROPOSAL_LIMIT = 20;

/** CAD proposal lifetime in milliseconds. */
export const NUKE_CAD_FEATURE_PROPOSAL_TTL_MS = 10 * 60 * 1000;

/** Apply capability used when a sketch preview does not name one. */
const DEFAULT_SKETCH_APPLY_CAPABILITY_ID = 'nuke.cad.applySketchChange';

/** Apply capability used when a topology preview does not name one. */
const DEFAULT_TOPOLOGY_APPLY_CAPABILITY_ID = 'nuke.cad.applyTopologyChange';

/** Apply capability used when an import preview does not name one. */
const DEFAULT_IMPORT_APPLY_CAPABILITY_ID = 'nuke.cad.applyImportBodies';

/** Apply capability used when an assembly preview does not name one. */
const DEFAULT_ASSEMBLY_APPLY_CAPABILITY_ID = 'nuke.cad.applyAssemblyChange';

/** Apply capability used when a drawing preview does not name one. */
const DEFAULT_DRAWING_APPLY_CAPABILITY_ID = 'nuke.cad.applyDrawingChange';

/** Apply capability used when a script preview does not name one. */
const DEFAULT_SCRIPT_APPLY_CAPABILITY_ID = 'nuke.cad.applyScriptChange';

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

/** Topology actions, snapshots, region impact, and OpenMC references captured by a topology preview. */
export interface NukeCadTopologyProposalDetails {
    readonly actions: readonly FeatureTopologyAction[];
    readonly before: Readonly<Record<string, FeatureParams>>;
    readonly after: Readonly<Record<string, FeatureParams>>;
    readonly topology: TopologyImpact;
    /** Region references of the candidate build, used to re-check OpenMC blockers on apply. */
    readonly afterRegions: readonly TopologyRegionRef[];
    readonly blockedRegions: readonly OpenmcRegionBlocker[];
    readonly openmcStatus: OpenmcReferenceSnapshot['status'];
    readonly openmcProjectPath?: string;
    readonly openmcWarnings: readonly string[];
}

/** A previewed topology change awaiting apply. */
export interface NukeCadTopologyProposal extends NukeCadProposalCommon {
    readonly scope: 'topology';
    /** Capability that applies the stored proposal. */
    readonly applyCapability: string;
    readonly topology: NukeCadTopologyProposalDetails;
}

/** The payload stored when a topology preview creates a proposal. */
export interface NukeCadTopologyProposalInput extends NukeCadProposalCommonInput {
    readonly scope: 'topology';
    /** Capability that applies the stored proposal; defaults to `nuke.cad.applyTopologyChange`. */
    readonly applyCapability?: string;
    readonly topology: NukeCadTopologyProposalDetails;
}

/** Source metadata, plan, and exact drafts captured by an import preview. */
export interface NukeCadImportProposalDetails {
    readonly source: {
        readonly path: string;
        readonly sourceHash: string;
        readonly sourceSize?: number;
        readonly sourceFormat?: ImportSourceFormat;
        readonly fileUnit?: string;
        readonly effectiveUnit?: string;
        readonly unitScaleFactor?: number;
        readonly unitsMessage?: string;
        readonly sourceUnit?: ImportSourceUnit;
    };
    readonly documentUnits?: string;
    readonly strategy: 'single' | 'perSolid';
    readonly label: string;
    /** Total solids reported by the inspection, including solids not selected for import. */
    readonly solidCount: number;
    readonly solidIndexes: readonly number[];
    readonly selectedSolids: readonly ImportSolidInfo[];
    readonly drafts: readonly ImportBodyDraft[];
    readonly bodies: readonly { name: string; label?: string; material?: string; featureName: string }[];
    readonly warnings: readonly string[];
}

/** A previewed import awaiting apply. */
export interface NukeCadImportProposal extends NukeCadProposalCommon {
    readonly scope: 'import';
    /** Capability that applies the stored proposal. */
    readonly applyCapability: string;
    readonly import: NukeCadImportProposalDetails;
}

/** The payload stored when an import preview creates a proposal. */
export interface NukeCadImportProposalInput extends NukeCadProposalCommonInput {
    readonly scope: 'import';
    /** Capability that applies the stored proposal; defaults to `nuke.cad.applyImportBodies`. */
    readonly applyCapability?: string;
    readonly import: NukeCadImportProposalDetails;
}

/** Assembly snapshots, planned placements, collisions, and region impact captured by an assembly preview. */
export interface NukeCadAssemblyProposalDetails {
    readonly actions: readonly AssemblyChangeInput[];
    readonly before: {
        readonly instances: readonly AssemblyInstance[];
        readonly groundedInstanceId: string;
        readonly bom: readonly AssemblyBomQuantityRow[];
    };
    readonly after: {
        readonly instances: readonly AssemblyInstance[];
        readonly groundedInstanceId: string;
        readonly bom: readonly AssemblyBomQuantityRow[];
    };
    readonly placements: readonly AssemblyPlacementPlan[];
    readonly bomDelta: AssemblyBomDelta;
    readonly warnings: readonly string[];
    readonly collisionWarnings: readonly string[];
    readonly overlapCheck: boolean;
    readonly removedSelectorKeys: readonly string[];
    readonly removedRegions: readonly AssemblyRemovedRegion[];
    readonly blockedRegions: readonly OpenmcRegionBlocker[];
    readonly openmcStatus: OpenmcReferenceSnapshot['status'];
    readonly openmcProjectPath?: string;
    readonly openmcWarnings: readonly string[];
    readonly requiresAcknowledgement: boolean;
}

/** A previewed assembly-instance change awaiting apply. */
export interface NukeCadAssemblyProposal extends NukeCadProposalCommon {
    readonly scope: 'assembly';
    /** Capability that applies the stored proposal. */
    readonly applyCapability: string;
    readonly assembly: NukeCadAssemblyProposalDetails;
}

/** The payload stored when an assembly preview creates a proposal. */
export interface NukeCadAssemblyProposalInput extends NukeCadProposalCommonInput {
    readonly scope: 'assembly';
    /** Capability that applies the stored proposal; defaults to `nuke.cad.applyAssemblyChange`. */
    readonly applyCapability?: string;
    readonly assembly: NukeCadAssemblyProposalDetails;
}

/** Drawing-sheet, view-display, and dimension-visibility snapshots captured by a drawing preview. */
export interface NukeCadDrawingProposalDetails {
    readonly actions: readonly DrawingChangeAction[];
    readonly sheet: {
        readonly id: string;
        readonly name: string;
        readonly sizeBefore: DrawingSheetSize;
        readonly sizeAfter: DrawingSheetSize;
    };
    readonly viewChanges: readonly {
        readonly id: string;
        readonly kind: DrawingViewKind;
        readonly orientation: DrawingViewOrientation;
        readonly scaleBefore: number;
        readonly scaleAfter: number;
        readonly showHiddenBefore: boolean;
        readonly showHiddenAfter: boolean;
    }[];
    readonly dimensionChanges: readonly {
        readonly id: string;
        readonly kind: DrawingDimensionKind;
        readonly viewId: string;
        readonly visibleBefore: boolean;
        readonly visibleAfter: boolean;
    }[];
    readonly titleBlockEditable: false;
    readonly requiresDrawingRefresh: true;
    readonly warnings: readonly string[];
}

/** A previewed drawing-sheet settings change awaiting apply. */
export interface NukeCadDrawingProposal extends NukeCadProposalCommon {
    readonly scope: 'drawing';
    /** Capability that applies the stored proposal. */
    readonly applyCapability: string;
    readonly drawing: NukeCadDrawingProposalDetails;
}

/** The payload stored when a drawing preview creates a proposal. */
export interface NukeCadDrawingProposalInput extends NukeCadProposalCommonInput {
    readonly scope: 'drawing';
    /** Capability that applies the stored proposal; defaults to `nuke.cad.applyDrawingChange`. */
    readonly applyCapability?: string;
    readonly drawing: NukeCadDrawingProposalDetails;
}

/** Script hashes, bounded diff, sandbox result, and build metrics captured by a script preview. */
export interface NukeCadScriptProposalDetails {
    /**
     * Panel-issued approval nonce. Generated by the proposal store, never
     * returned by a preview capability; only the review panel can read it from
     * the stored proposal and pass it back to the apply capability.
     */
    readonly approvalId: string;
    readonly scriptPath: string;
    readonly baseScriptHash: string;
    readonly baseScriptBytes: number;
    /** Full replacement body; never a partial edit. */
    readonly proposedScript: string;
    readonly proposedScriptHash: string;
    readonly proposedScriptBytes: number;
    readonly diff: string;
    readonly diffTruncated: boolean;
    readonly addedLines: number;
    readonly removedLines: number;
    readonly hunkCount: number;
    readonly imports: readonly string[];
    readonly hasModelAssignment: boolean;
    readonly sandbox: {
        readonly available: boolean;
        readonly engine: 'bubblewrap';
        readonly version?: string;
        readonly disableUserns?: boolean;
        readonly seccomp?: boolean;
        readonly seccompVersion?: string;
        readonly limits: { timeoutSeconds: number; memoryMb: number; processLimit: number; fileSizeMb: number };
    };
    readonly auditId: string;
    readonly durationMs: number;
    readonly timedOut: boolean;
    readonly exitCode: number | null;
    readonly build: { success: boolean; solidCount: number; faceCount: number; triangleCount: number };
}

/** A previewed Python script replacement awaiting apply. */
export interface NukeCadScriptProposal extends NukeCadProposalCommon {
    readonly scope: 'script';
    /** Capability that applies the stored proposal. */
    readonly applyCapability: string;
    readonly script: NukeCadScriptProposalDetails;
}

/** The payload stored when a script preview creates a proposal. */
export interface NukeCadScriptProposalInput extends NukeCadProposalCommonInput {
    readonly scope: 'script';
    /** Capability that applies the stored proposal; defaults to `nuke.cad.applyScriptChange`. */
    readonly applyCapability?: string;
    /**
     * Script snapshot and sandbox result. Common proposal fields bind
     * `documentPath` to `script.scriptPath` and both `documentEpoch` and
     * `baseRevision` to `0`; the single change row carries the before/after
     * script hashes. The approval nonce is assigned by the store.
     */
    readonly script: Omit<NukeCadScriptProposalDetails, 'approvalId'> & { readonly approvalId?: never };
}

/** Any previewed CAD edit awaiting apply. */
export type NukeCadProposal =
    | NukeCadFeatureProposal
    | NukeCadSketchProposal
    | NukeCadTopologyProposal
    | NukeCadImportProposal
    | NukeCadAssemblyProposal
    | NukeCadDrawingProposal
    | NukeCadScriptProposal;

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

/** Whether a proposal changes feature topology rather than scalar parameters. */
export function isTopologyProposal(proposal: NukeCadProposal): proposal is NukeCadTopologyProposal {
    return proposal.scope === 'topology';
}

/** Whether a proposal imports external CAD sources as bodies. */
export function isImportProposal(proposal: NukeCadProposal): proposal is NukeCadImportProposal {
    return proposal.scope === 'import';
}

/** Whether a proposal changes assembly instances rather than feature or sketch data. */
export function isAssemblyProposal(proposal: NukeCadProposal): proposal is NukeCadAssemblyProposal {
    return proposal.scope === 'assembly';
}

/** Whether a proposal changes drawing-sheet settings rather than model geometry. */
export function isDrawingProposal(proposal: NukeCadProposal): proposal is NukeCadDrawingProposal {
    return proposal.scope === 'drawing';
}

/** Whether a proposal replaces the active Python model script. */
export function isScriptProposal(proposal: NukeCadProposal): proposal is NukeCadScriptProposal {
    return proposal.scope === 'script';
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
    create(input: NukeCadTopologyProposalInput): NukeCadTopologyProposal;
    create(input: NukeCadImportProposalInput): NukeCadImportProposal;
    create(input: NukeCadAssemblyProposalInput): NukeCadAssemblyProposal;
    create(input: NukeCadDrawingProposalInput): NukeCadDrawingProposal;
    create(input: NukeCadScriptProposalInput): NukeCadScriptProposal;
    create(
        input:
            | NukeCadFeatureProposalInput
            | NukeCadSketchProposalInput
            | NukeCadTopologyProposalInput
            | NukeCadImportProposalInput
            | NukeCadAssemblyProposalInput
            | NukeCadDrawingProposalInput
            | NukeCadScriptProposalInput
    ): NukeCadProposal;
    create(
        input:
            | NukeCadFeatureProposalInput
            | NukeCadSketchProposalInput
            | NukeCadTopologyProposalInput
            | NukeCadImportProposalInput
            | NukeCadAssemblyProposalInput
            | NukeCadDrawingProposalInput
            | NukeCadScriptProposalInput
    ): NukeCadProposal {
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
                : cloned.scope === 'topology'
                  ? {
                        ...cloned,
                        id: this.createId(),
                        applyCapability: cloned.applyCapability ?? DEFAULT_TOPOLOGY_APPLY_CAPABILITY_ID,
                        createdAt
                    }
                  : cloned.scope === 'import'
                    ? {
                          ...cloned,
                          id: this.createId(),
                          applyCapability: cloned.applyCapability ?? DEFAULT_IMPORT_APPLY_CAPABILITY_ID,
                          createdAt
                      }
                    : cloned.scope === 'assembly'
                      ? {
                            ...cloned,
                            id: this.createId(),
                            applyCapability: cloned.applyCapability ?? DEFAULT_ASSEMBLY_APPLY_CAPABILITY_ID,
                            createdAt
                        }
                      : cloned.scope === 'drawing'
                        ? {
                              ...cloned,
                              id: this.createId(),
                              applyCapability: cloned.applyCapability ?? DEFAULT_DRAWING_APPLY_CAPABILITY_ID,
                              createdAt
                          }
                        : cloned.scope === 'script'
                          ? {
                                ...cloned,
                                id: this.createId(),
                                applyCapability: cloned.applyCapability ?? DEFAULT_SCRIPT_APPLY_CAPABILITY_ID,
                                script: { ...cloned.script, approvalId: this.createId() },
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
