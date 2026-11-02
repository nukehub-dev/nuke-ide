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
 * Ghost-preview state for candidate CAD builds.
 *
 * Holds the parsed tessellation of the latest candidate preview together with
 * the solid-level diff, so viewport contributions can render the ghost overlay
 * without owning the candidate payload themselves. The state is dropped as soon
 * as the backing feature proposal is gone (applied, removed, or expired).
 *
 * @module nuke-cad/browser/preview
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { Disposable } from '@theia/core/lib/common/disposable';
import { Emitter, Event } from '@theia/core/lib/common/event';
import type { ParsedTessData } from '../viewer-core/tess-reuse';
import { NukeCadProposalService } from '../capabilities/nuke-cad-proposal-service';

/** One candidate build currently previewed as a ghost overlay. */
export interface NukeCadGhostPreviewState {
    /** Feature proposal whose build produced `tessData`. */
    readonly proposalId: string;
    readonly tessData: ParsedTessData;
    readonly changedSolidIds: readonly number[];
    readonly addedSolidIds: readonly number[];
    readonly removedSolidIds: readonly number[];
    readonly changedBodyIds: readonly string[];
}

/** Stores the active candidate ghost and notifies observers when it changes. */
@injectable()
export class NukeCadGhostPreviewService implements Disposable {
    protected readonly onDidChangeEmitter = new Emitter<NukeCadGhostPreviewState | undefined>();
    protected readonly proposalSubscription: Disposable;
    protected _state: NukeCadGhostPreviewState | undefined;
    protected disposed = false;

    readonly onDidChange: Event<NukeCadGhostPreviewState | undefined> = this.onDidChangeEmitter.event;

    constructor(@inject(NukeCadProposalService) protected readonly proposals: NukeCadProposalService) {
        this.proposalSubscription = this.proposals.onDidChange(() => this.handleProposalChange());
    }

    get state(): NukeCadGhostPreviewState | undefined {
        return this._state;
    }

    /** Replace the active ghost and notify observers. */
    show(state: NukeCadGhostPreviewState): void {
        if (this.disposed) {
            return;
        }
        this._state = state;
        this.onDidChangeEmitter.fire(state);
    }

    /** Drop the active ghost; no event is emitted when none was shown. */
    clear(): void {
        if (this.disposed || this._state === undefined) {
            return;
        }
        this._state = undefined;
        this.onDidChangeEmitter.fire(undefined);
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this._state = undefined;
        this.proposalSubscription.dispose();
        this.onDidChangeEmitter.dispose();
    }

    protected handleProposalChange(): void {
        const state = this._state;
        if (state === undefined) {
            return;
        }
        if (!this.proposals.has(state.proposalId)) {
            this.clear();
        }
    }
}
