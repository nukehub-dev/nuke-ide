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
 * CAD edit review panel widget.
 *
 * Hosts {@link CadReviewPanelView} and owns the proposal lifecycle: it lists
 * previewed feature, sketch, topology, import, and assembly edits, tracks
 * region-impact acknowledgement, confirms and invokes the proposal's apply
 * capability (`nuke.cad.applyFeatureChange`, `nuke.cad.applySketchChange`,
 * `nuke.cad.applyTopologyChange`, `nuke.cad.applyImportBodies`, or
 * `nuke.cad.applyAssemblyChange`), keeps applied entries for session undo
 * through `NukeUndoService`, and dismisses proposals. Opened through
 * `nuke.cad.openReviewPanel` in the right area, the CAD Studio menu, and the
 * Nuke Tools sidebar.
 *
 * @module nuke-cad/browser/widgets
 */

import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Disposable } from '@theia/core/lib/common/disposable';
import { MessageService } from '@theia/core/lib/common/message-service';
import { CommandService } from '@theia/core/lib/common/command';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { CommonCommands } from '@theia/core/lib/browser/common-commands';
import { NukeUndoService } from 'nuke-core/lib/browser/capabilities/nuke-undo-service';
import { NukeCapabilityContextService, NukeCapabilityRegistry } from 'nuke-core/lib/common/nuke-capability-protocol';
import { validateCapabilityInput } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import { CadDocumentStore } from '../../document/cad-document-store';
import { NukeCadProposal, NukeCadProposalService } from '../../capabilities/nuke-cad-proposal-service';
import { APPLY_FEATURE_CHANGE_ID } from '../../capabilities/nuke-cad-authoring-capabilities';
import { AI_AUTHORING_PREFERENCE } from '../../capabilities/nuke-cad-authoring-constants';
import { CadReviewAppliedEntry, CadReviewPanelView, CadReviewProposalView } from './review-panel-view';
import './review-panel.css';

@injectable()
export class CadReviewPanelWidget extends ReactWidget {
    static readonly ID = 'nuke-cad-review-panel-widget';
    static readonly LABEL = 'CAD Edit Review';

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(CommandService)
    protected readonly commandService: CommandService;

    @inject(PreferenceService)
    protected readonly preferenceService: PreferenceService;

    @inject(NukeCadProposalService)
    protected readonly proposalService: NukeCadProposalService;

    @inject(NukeUndoService)
    protected readonly undoService: NukeUndoService;

    @inject(NukeCapabilityRegistry)
    protected readonly capabilityRegistry: NukeCapabilityRegistry;

    @inject(NukeCapabilityContextService)
    protected readonly capabilityContext: NukeCapabilityContextService;

    @inject(CadDocumentStore)
    protected readonly documentStore: CadDocumentStore;

    /** Applied proposals kept for session undo, newest first. */
    protected applied: CadReviewAppliedEntry[] = [];

    /** Topology proposal ids whose region impact the user acknowledged. */
    protected acknowledgedProposalIds = new Set<string>();

    /** True from the confirmed apply until the capability settles. */
    protected applying = false;

    constructor(options?: any) {
        super(options);
        // Sidebar panels scroll natively (see the panel CSS) — no PerfectScrollbar thumb overlay.
        this.scrollOptions = undefined;
    }

    @postConstruct()
    protected init(): void {
        this.id = CadReviewPanelWidget.ID;
        this.title.label = CadReviewPanelWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-git-compare';

        this.toDispose.push(this.proposalService.onDidChange(() => this.update()));
        this.toDispose.push(Disposable.create(this.documentStore.onChange(() => this.update())));
        this.toDispose.push(this.undoService.onDidChange(() => this.update()));
        this.toDispose.push(this.capabilityRegistry.onDidChange(() => this.update()));
        this.toDispose.push(this.capabilityContext.onDidChangeContext(() => this.update()));
        this.toDispose.push(
            this.preferenceService.onPreferenceChanged((event) => {
                if (event.preferenceName === AI_AUTHORING_PREFERENCE) {
                    this.update();
                }
            })
        );
        this.update();
    }

    /** `nukeCad.aiAuthoringEnabled`, read fresh on every render. */
    protected isAuthoringEnabled(): boolean {
        return this.preferenceService.get<boolean>(AI_AUTHORING_PREFERENCE, false) === true;
    }

    /** Live proposals from the store, mapped to the presentational view model. */
    protected currentProposals(): readonly CadReviewProposalView[] {
        const proposals = this.proposalService.list().map((proposal) => this.toView(proposal));
        this.dropMissingAcknowledgements(proposals);
        return proposals;
    }

    /** Forget acknowledgements for proposals that left the store or no longer need one. */
    protected dropMissingAcknowledgements(proposals: readonly CadReviewProposalView[]): void {
        const liveAcknowledgementIds = new Set(
            proposals
                .filter(
                    (proposal) =>
                        proposal.scope === 'topology' ||
                        (proposal.scope === 'assembly' && proposal.assembly?.requiresAcknowledgement === true)
                )
                .map((proposal) => proposal.id)
        );
        for (const id of this.acknowledgedProposalIds) {
            if (!liveAcknowledgementIds.has(id)) {
                this.acknowledgedProposalIds.delete(id);
            }
        }
    }

    /** Map a stored proposal to the panel view, including sketch, topology, import, and assembly context. */
    protected toView(proposal: NukeCadProposal): CadReviewProposalView {
        const common: CadReviewProposalView = {
            id: proposal.id,
            summary: proposal.summary,
            documentPath: proposal.documentPath,
            changes: proposal.changes,
            scope: proposal.scope,
            applyCapability: proposal.applyCapability,
            impact: proposal.impact,
            build: proposal.build
        };
        if (proposal.scope === 'sketch') {
            return {
                ...common,
                sketch: {
                    targetSketchId: proposal.sketch.targetSketchId,
                    targetSketchName: proposal.sketch.targetSketchName,
                    affectedSketchIds: proposal.sketch.affectedSketchIds,
                    solver: proposal.sketch.solver
                }
            };
        }
        if (proposal.scope === 'topology') {
            return {
                ...common,
                topology: {
                    impact: proposal.topology.topology,
                    blockedRegions: proposal.topology.blockedRegions,
                    openmcStatus: proposal.topology.openmcStatus,
                    openmcProjectPath: proposal.topology.openmcProjectPath,
                    openmcWarnings: proposal.topology.openmcWarnings
                }
            };
        }
        if (proposal.scope === 'import') {
            const details = proposal.import;
            const totalSolids = (details as { readonly solidCount?: number }).solidCount;
            return {
                ...common,
                importContext: {
                    sourcePath: details.source.path,
                    sourceHash: details.source.sourceHash,
                    sourceSize: details.source.sourceSize,
                    sourceFormat: details.source.sourceFormat,
                    fileUnit: details.source.fileUnit,
                    effectiveUnit: details.source.effectiveUnit,
                    unitScaleFactor: details.source.unitScaleFactor,
                    unitsMessage: details.source.unitsMessage,
                    documentUnits: details.documentUnits,
                    solidCount: totalSolids ?? details.selectedSolids.length,
                    selectedSolidCount: details.selectedSolids.length,
                    strategy: details.strategy,
                    bodies: details.bodies,
                    warnings: details.warnings
                }
            };
        }
        if (proposal.scope === 'assembly') {
            const details = proposal.assembly;
            return {
                ...common,
                assembly: {
                    placements: details.placements,
                    bomDelta: details.bomDelta,
                    collisionWarnings: details.collisionWarnings,
                    overlapCheck: details.overlapCheck,
                    removedSelectorKeys: details.removedSelectorKeys,
                    removedRegions: details.removedRegions,
                    blockedRegions: details.blockedRegions,
                    openmcStatus: details.openmcStatus,
                    openmcProjectPath: details.openmcProjectPath,
                    openmcWarnings: details.openmcWarnings,
                    requiresAcknowledgement: details.requiresAcknowledgement
                }
            };
        }
        return common;
    }

    /** Applied proposal ids whose tokens are still redeemable. */
    protected undoableProposalIds(): readonly string[] {
        return this.applied
            .filter((entry) => entry.undoToken.length > 0 && this.undoService.has(entry.undoToken))
            .map((entry) => entry.proposalId);
    }

    protected render(): React.ReactNode {
        return (
            <CadReviewPanelView
                proposals={this.currentProposals()}
                applied={this.applied}
                authoringEnabled={this.isAuthoringEnabled()}
                applying={this.applying}
                undoableProposalIds={this.undoableProposalIds()}
                acknowledgedProposalIds={Array.from(this.acknowledgedProposalIds)}
                onApply={(proposalId) => void this.handleApply(proposalId)}
                onDismiss={(proposalId) => this.handleDismiss(proposalId)}
                onUndo={(proposalId) => void this.handleUndo(proposalId)}
                onAcknowledge={(proposalId, acknowledged) => this.handleAcknowledge(proposalId, acknowledged)}
                onOpenSettings={() => void this.commandService.executeCommand(CommonCommands.OPEN_PREFERENCES.id, AI_AUTHORING_PREFERENCE)}
            />
        );
    }

    /** Track the region-impact acknowledgement shown on a topology proposal. */
    protected handleAcknowledge(proposalId: string, acknowledged: boolean): void {
        if (acknowledged && !this.proposalService.has(proposalId)) {
            return;
        }
        const next = new Set(this.acknowledgedProposalIds);
        if (acknowledged) {
            next.add(proposalId);
        } else {
            next.delete(proposalId);
        }
        this.acknowledgedProposalIds = next;
        this.update();
    }

    /**
     * Confirm, then invoke the canonical apply capability with the same
     * validation and capability context the AI tool bridge uses. Topology
     * proposals also carry the explicit region-impact acknowledgement the
     * apply capability requires. The proposal is removed by the capability
     * after a successful document commit.
     */
    protected async handleApply(proposalId: string): Promise<void> {
        const proposal = this.currentProposals().find((candidate) => candidate.id === proposalId);
        if (proposal === undefined) {
            this.messageService.warn('This CAD proposal is no longer available. Preview the change again.');
            return;
        }
        const confirmPrompt =
            proposal.scope === 'sketch'
                ? 'Apply this CAD sketch edit?'
                : proposal.scope === 'topology'
                  ? 'Apply this CAD topology change?'
                  : proposal.scope === 'import'
                    ? 'Apply this CAD import?'
                    : proposal.scope === 'assembly'
                      ? 'Apply this CAD assembly change?'
                      : 'Apply this CAD feature change?';
        const confirmation = await this.messageService.warn(`${confirmPrompt} ${proposal.summary}`, 'Apply');
        if (confirmation !== 'Apply') {
            return;
        }

        const capabilityId = proposal.applyCapability ?? APPLY_FEATURE_CHANGE_ID;
        const capability = this.capabilityRegistry.get(capabilityId);
        if (capability === undefined) {
            this.messageService.error('The CAD edit apply capability is not registered. Reload the window and try again.');
            return;
        }
        const context = await this.capabilityContext.getContext();
        let enabled = true;
        try {
            enabled = capability.when === undefined ? true : capability.when(context);
        } catch {
            enabled = false;
        }
        if (!enabled) {
            this.messageService.warn(
                'CAD AI authoring is unavailable for the active document. Enable it in Settings → Nuke CAD → AI Authoring and open a saved document.'
            );
            return;
        }
        const requiresRegionAcknowledgement =
            proposal.scope === 'topology' || (proposal.scope === 'assembly' && proposal.assembly?.requiresAcknowledgement === true);
        const input = requiresRegionAcknowledgement ? { proposalId, acknowledgeRegionChanges: true } : { proposalId };
        const inputErrors = validateCapabilityInput(capability, input);
        if (inputErrors.length > 0) {
            this.messageService.error(`Invalid CAD apply request: ${inputErrors.join('; ')}`);
            return;
        }

        this.applying = true;
        this.update();
        try {
            const result = await capability.invoke(input, context);
            if (!result.ok) {
                this.messageService.error(result.message || 'The CAD edit could not be applied.');
                return;
            }
            this.proposalService.remove(proposalId);
            this.acknowledgedProposalIds.delete(proposalId);
            this.applied = [
                {
                    proposalId,
                    summary: proposal.summary,
                    detail:
                        proposal.scope === 'import'
                            ? (describeImportApply(result.data) ?? describeAppliedChange(proposal.changes[0]))
                            : proposal.scope === 'assembly'
                              ? (describeAssemblyApply(result.data) ?? describeAssemblyChange(proposal.changes[0]))
                              : describeAppliedChange(proposal.changes[0]),
                    undoToken: result.undoToken ?? '',
                    scope: proposal.scope
                },
                ...this.applied
            ];
            this.messageService.info(result.message || 'CAD edit applied.');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.messageService.error(`The CAD edit could not be applied: ${message}`);
        } finally {
            this.applying = false;
            this.update();
        }
    }

    /** Dismiss a proposal and forget its acknowledgement; the store event refreshes the panel. */
    protected handleDismiss(proposalId: string): void {
        this.proposalService.remove(proposalId);
        this.acknowledgedProposalIds.delete(proposalId);
        this.update();
    }

    /** Confirm and redeem the applied entry's session undo token. */
    protected async handleUndo(proposalId: string): Promise<void> {
        const entry = this.applied.find((candidate) => candidate.proposalId === proposalId);
        if (entry === undefined || entry.undoToken.length === 0) {
            this.messageService.warn('This CAD edit has no undo token left.');
            return;
        }
        const confirmPrompt =
            entry.scope === 'sketch'
                ? 'Undo this CAD sketch edit and restore the previous sketch dimensions?'
                : entry.scope === 'topology'
                  ? 'Undo this CAD topology change and restore the previous feature parameters?'
                  : entry.scope === 'import'
                    ? 'Undo this CAD import and remove the imported bodies?'
                    : entry.scope === 'assembly'
                      ? 'Undo this CAD assembly change and restore the previous instances and placements?'
                      : 'Undo this CAD edit and restore the previous feature parameters?';
        const confirmation = await this.messageService.warn(`${confirmPrompt} ${entry.summary}`, 'Undo');
        if (confirmation !== 'Undo') {
            return;
        }
        const result = await this.undoService.undo(entry.undoToken);
        if (!result.ok) {
            this.messageService.error(result.message || 'The CAD edit could not be undone.');
            return;
        }
        this.applied = this.applied.filter((candidate) => candidate.proposalId !== proposalId);
        this.messageService.info(result.message || 'CAD change undone.');
        this.update();
    }
}

function formatAppliedValue(value: unknown): string {
    if (value === undefined) {
        return '—';
    }
    if (typeof value === 'number') {
        return String(Number(value.toFixed(6)));
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Compact one-change detail for the applied entry; falls back to the full summary. */
/** Short applied detail for a placement-only assembly edit. */
function describeAssemblyChange(change: CadReviewProposalView['changes'][number] | undefined): string | undefined {
    if (change === undefined) {
        return undefined;
    }
    const id = change.label.replace(/^Assembly instance /, '');
    if (change.kind === 'add') {
        return `Added ${id}`;
    }
    if (change.kind === 'remove') {
        return `Removed ${id}`;
    }
    const after = change.after as { readonly position?: readonly number[] } | undefined;
    return after?.position !== undefined ? `Moved ${id} to [${after.position.join(', ')}]` : `Moved ${id}`;
}

function describeAppliedChange(change: CadReviewProposalView['changes'][number] | undefined): string | undefined {
    if (change === undefined) {
        return undefined;
    }
    return `${change.label} ${formatAppliedValue(change.before)} → ${formatAppliedValue(change.after)}`;
}

function formatCount(count: number, singular: string, plural: string): string {
    return `${count} ${count === 1 ? singular : plural}`;
}

function resultIds(value: unknown): readonly string[] {
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
}

/** Applied-entry detail from the assembly apply result's actual instance ids. */
function describeAssemblyApply(data: unknown): string | undefined {
    if (data === undefined || data === null || typeof data !== 'object') {
        return undefined;
    }
    const result = data as { readonly addedInstanceIds?: unknown; readonly removedInstanceIds?: unknown };
    const added = resultIds(result.addedInstanceIds);
    const removed = resultIds(result.removedInstanceIds);
    const parts: string[] = [];
    if (added.length > 0) {
        parts.push(`Added ${added.length <= 3 ? added.join(', ') : formatCount(added.length, 'instance', 'instances')}`);
    }
    if (removed.length > 0) {
        parts.push(`Removed ${removed.length <= 3 ? removed.join(', ') : formatCount(removed.length, 'instance', 'instances')}`);
    }
    return parts.length > 0 ? parts.join(' \u00b7 ') : undefined;
}

/** Applied-entry detail from the import apply result's actual body and feature ids. */
function describeImportApply(data: unknown): string | undefined {
    if (data === undefined || data === null || typeof data !== 'object') {
        return undefined;
    }
    const result = data as { readonly bodyIds?: unknown; readonly featureIds?: unknown };
    const bodyIds = resultIds(result.bodyIds);
    const featureIds = resultIds(result.featureIds);
    const parts: string[] = [];
    if (bodyIds.length > 0) {
        parts.push(bodyIds.length <= 3 ? `Bodies ${bodyIds.join(', ')}` : formatCount(bodyIds.length, 'body', 'bodies'));
    }
    if (featureIds.length > 0) {
        parts.push(formatCount(featureIds.length, 'import feature', 'import features'));
    }
    return parts.length > 0 ? parts.join(' \u00b7 ') : undefined;
}
