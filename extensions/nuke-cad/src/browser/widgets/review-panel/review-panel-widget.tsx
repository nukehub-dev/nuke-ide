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
 * previewed feature edits, confirms and invokes the existing
 * `nuke.cad.applyFeatureChange` capability, keeps applied entries for session
 * undo through `NukeUndoService`, and dismisses proposals. Opened through
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
import { NukeCadProposalService } from '../../capabilities/nuke-cad-proposal-service';
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

    /** Live proposals from the store; the store already prunes expired entries. */
    protected currentProposals(): readonly CadReviewProposalView[] {
        return this.proposalService.list();
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
                onApply={(proposalId) => void this.handleApply(proposalId)}
                onDismiss={(proposalId) => this.handleDismiss(proposalId)}
                onUndo={(proposalId) => void this.handleUndo(proposalId)}
                onOpenSettings={() => void this.commandService.executeCommand(CommonCommands.OPEN_PREFERENCES.id, AI_AUTHORING_PREFERENCE)}
            />
        );
    }

    /**
     * Confirm, then invoke the canonical apply capability with the same
     * validation and capability context the AI tool bridge uses. The proposal
     * is removed by the capability after a successful document commit.
     */
    protected async handleApply(proposalId: string): Promise<void> {
        const proposal = this.currentProposals().find((candidate) => candidate.id === proposalId);
        if (proposal === undefined) {
            this.messageService.warn('This CAD proposal is no longer available. Preview the change again.');
            return;
        }
        const confirmation = await this.messageService.warn(`Apply this CAD feature change? ${proposal.summary}`, 'Apply');
        if (confirmation !== 'Apply') {
            return;
        }

        const capability = this.capabilityRegistry.get(APPLY_FEATURE_CHANGE_ID);
        if (capability === undefined) {
            this.messageService.error('The CAD feature-change capability is not registered. Reload the window and try again.');
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
        const input = { proposalId };
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
                this.messageService.error(result.message || 'The CAD feature change could not be applied.');
                return;
            }
            this.proposalService.remove(proposalId);
            this.applied = [
                {
                    proposalId,
                    summary: proposal.summary,
                    undoToken: result.undoToken ?? ''
                },
                ...this.applied
            ];
            this.messageService.info(result.message || 'CAD feature change applied.');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.messageService.error(`The CAD feature change could not be applied: ${message}`);
        } finally {
            this.applying = false;
            this.update();
        }
    }

    /** Dismiss a proposal; the store event refreshes the panel. */
    protected handleDismiss(proposalId: string): void {
        this.proposalService.remove(proposalId);
        this.update();
    }

    /** Confirm and redeem the applied entry's session undo token. */
    protected async handleUndo(proposalId: string): Promise<void> {
        const entry = this.applied.find((candidate) => candidate.proposalId === proposalId);
        if (entry === undefined || entry.undoToken.length === 0) {
            this.messageService.warn('This CAD edit has no undo token left.');
            return;
        }
        const confirmation = await this.messageService.warn(
            `Undo this CAD edit and restore the previous feature parameters? ${entry.summary}`,
            'Undo'
        );
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
