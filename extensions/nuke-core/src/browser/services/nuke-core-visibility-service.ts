// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
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
 * Status Bar Visibility Service
 *
 * Allows dependent extensions to request status bar visibility when their tools are active.
 * Uses reference counting - status bar shows when any extension requests visibility.
 *
 * @module nuke-core/browser
 */

import { injectable } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core/lib/common';
import { NukeCoreStatusBarVisibilityService } from '../../common/nuke-core-protocol';

/**
 * Reference-counted visibility service for the Nuke Core status bar.
 *
 * Multiple extensions can simultaneously request visibility; the status bar
 * remains visible until all requesters have released their claim.
 *
 * DI token: {@link NukeCoreStatusBarVisibility}
 *
 * @see {@link NukeCoreService}
 */
@injectable()
export class NukeCoreVisibilityService implements NukeCoreStatusBarVisibilityService {
    private requesters = new Set<string>();

    /** Emitted whenever the aggregated visibility state changes. */
    private readonly _onVisibilityChanged = new Emitter<boolean>();
    readonly onVisibilityChanged: Event<boolean> = this._onVisibilityChanged.event;

    /**
     * Request the status bar to be visible.
     *
     * @param source - Identifier for the extension requesting visibility.
     * @returns A disposable handle. Call `dispose()` when visibility is no longer needed.
     */
    requestVisibility(source: string): { dispose: () => void } {
        const wasRequested = this.requesters.size > 0;
        this.requesters.add(source);
        console.log(`[NukeCore] Visibility requested by: ${source} (total: ${this.requesters.size})`);

        // Notify if this is the first request
        if (!wasRequested) {
            this._onVisibilityChanged.fire(true);
        }

        // Return disposable handle
        return {
            dispose: () => {
                this.releaseVisibility(source);
            }
        };
    }

    /**
     * Release a visibility request.
     *
     * @param source - Identifier previously passed to {@link requestVisibility}.
     */
    private releaseVisibility(source: string): void {
        if (this.requesters.has(source)) {
            this.requesters.delete(source);
            console.log(`[NukeCore] Visibility released by: ${source} (remaining: ${this.requesters.size})`);

            // Notify if no more requests
            if (this.requesters.size === 0) {
                this._onVisibilityChanged.fire(false);
            }
        }
    }

    /**
     * Check if any extension is currently requesting visibility.
     *
     * @returns `true` when at least one requester is registered.
     */
    isVisibilityRequested(): boolean {
        return this.requesters.size > 0;
    }

    /**
     * Get list of current requesters (for debugging).
     *
     * @returns Array of source identifiers.
     */
    getRequesters(): string[] {
        return Array.from(this.requesters);
    }
}
