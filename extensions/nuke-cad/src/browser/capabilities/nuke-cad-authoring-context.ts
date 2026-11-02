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
 * NukeCAD Authoring Context
 *
 * Emits a capability-context change when either AI authoring switch flips, so
 * the tool bridge and capability catalog add or remove the preview/apply tools
 * immediately instead of waiting for the next document change.
 *
 * @module nuke-cad/browser/capabilities
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { Disposable, DisposableCollection } from '@theia/core/lib/common/disposable';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { NukeCapabilityContext, NukeCapabilityContextContribution } from 'nuke-core/lib/common/nuke-capability-protocol';
import { AI_AUTHORING_PREFERENCE, SCRIPT_AUTHORING_PREFERENCE } from './nuke-cad-authoring-constants';

/** Context contribution that refreshes the tool set when the authoring switch changes. */
@injectable()
export class NukeCadAuthoringContextContribution implements NukeCapabilityContextContribution, Disposable {
    protected readonly onDidChangeContextEmitter = new Emitter<void>();
    protected readonly toDispose = new DisposableCollection();

    readonly onDidChangeContext: Event<void> = this.onDidChangeContextEmitter.event;

    constructor(@inject(PreferenceService) protected readonly preferences: PreferenceService) {
        this.toDispose.push(
            this.preferences.onPreferenceChanged((event) => {
                if (event.preferenceName === AI_AUTHORING_PREFERENCE || event.preferenceName === SCRIPT_AUTHORING_PREFERENCE) {
                    this.onDidChangeContextEmitter.fire();
                }
            })
        );
    }

    getContext(): Partial<NukeCapabilityContext> {
        // The capabilities read the switch and the active document directly.
        return {};
    }

    dispose(): void {
        this.toDispose.dispose();
        this.onDidChangeContextEmitter.dispose();
    }
}
