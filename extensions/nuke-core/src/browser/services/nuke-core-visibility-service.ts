// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
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

@injectable()
export class NukeCoreVisibilityService implements NukeCoreStatusBarVisibilityService {
    
    private requesters = new Set<string>();
    private readonly _onVisibilityChanged = new Emitter<boolean>();
    readonly onVisibilityChanged: Event<boolean> = this._onVisibilityChanged.event;

    /**
     * Request the status bar to be visible.
     * @param source Identifier for the extension requesting visibility
     * @returns A disposable handle. Call dispose() when visibility is no longer needed.
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
     */
    isVisibilityRequested(): boolean {
        return this.requesters.size > 0;
    }

    /**
     * Get list of current requesters (for debugging).
     */
    getRequesters(): string[] {
        return Array.from(this.requesters);
    }
}
