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
 * OpenMC Studio Service
 *
 * Main frontend service for the OpenMC Studio extension. Acts as a central
 * coordinator by exposing the {@link OpenMCStateManager}, backend service,
 * and nuke-core integrations to the rest of the frontend.
 *
 * Implements {@link FrontendApplicationContribution} to receive lifecycle
 * callbacks when the Theia application starts.
 *
 * @module openmc-studio/browser
 */

import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { MessageService } from '@theia/core/lib/common/message-service';

import { OpenMCStateManager } from './openmc-state-manager';
import { OpenMCStudioBackendService } from '../common/openmc-studio-protocol';
import { NukeCoreService } from 'nuke-core/lib/common';


@injectable()
export class OpenMCStudioService implements FrontendApplicationContribution {

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(OpenMCStateManager)
    protected readonly stateManager: OpenMCStateManager;

    @inject(OpenMCStudioBackendService)
    protected readonly backendService: OpenMCStudioBackendService;

    @inject(NukeCoreService)
    protected readonly nukeCoreService: NukeCoreService;

    /** Internal readiness flag set once the frontend application has started. */
    private _isReady = false;

    /**
     * Initialize the service after construction.
     *
     * Sets up listeners for environment fallback events from nuke-core and
     * logs the initialization to the console.
     */
    @postConstruct()
    protected init(): void {
        console.log('[OpenMC Studio] Service initialized');

        // Listen for environment fallback events from nuke-core
        this.nukeCoreService.onEnvironmentFallback(event => {
            console.log('[OpenMC Studio] Environment fallback detected:', event);
            this.messageService.warn(event.warning, { timeout: 10000 });
        });
    }

    /**
     * Called by the Theia framework when the frontend application is ready.
     *
     * Sets the internal readiness flag to `true`.
     */
    onStart(): void {
        this._isReady = true;
    }

    /**
     * Get the cross-sections path from nuke-core.
     *
     * @returns The configured cross-sections data path, or `undefined` if not set.
     */
    getCrossSectionsPath(): string | undefined {
        return this.nukeCoreService.getCrossSectionsPath();
    }

    /**
     * Whether the service has finished initialization and the application is ready.
     *
     * @returns `true` if the frontend application has started.
     */
    get isReady(): boolean {
        return this._isReady;
    }

    /**
     * Get the {@link OpenMCStateManager} instance.
     *
     * @returns The state manager responsible for simulation state CRUD operations.
     * @see {@link OpenMCStateManager}
     */
    getStateManager(): OpenMCStateManager {
        return this.stateManager;
    }

    /**
     * Get the {@link OpenMCStudioBackendService} proxy.
     *
     * @returns The backend service proxy for server-side operations.
     * @see {@link OpenMCStudioBackendService}
     */
    getBackendService(): OpenMCStudioBackendService {
        return this.backendService;
    }

    /**
     * Get the nuke-core service for advanced operations.
     *
     * @returns The shared {@link NukeCoreService} instance.
     * @see {@link NukeCoreService}
     */
    getNukeCoreService(): NukeCoreService {
        return this.nukeCoreService;
    }
}
