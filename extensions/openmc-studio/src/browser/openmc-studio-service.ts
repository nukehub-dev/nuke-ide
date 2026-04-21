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
