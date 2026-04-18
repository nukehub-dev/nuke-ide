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
 * Main frontend service for the OpenMC Studio extension.
 * 
 * @module openmc-studio/browser
 */

import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { MessageService } from '@theia/core/lib/common/message-service';

import { OpenMCStateManager } from './openmc-state-manager';
import { OpenMCStudioBackendService } from '../common/openmc-studio-protocol';
import { NukeCoreService } from 'nuke-core/lib/common';
import { OpenMCValidationService } from './services/openmc-validation-service';

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
    
    @inject(OpenMCValidationService)
    protected readonly validationService: OpenMCValidationService;

    private _isReady = false;

    @postConstruct()
    protected init(): void {
        console.log('[OpenMC Studio] Service initialized');
    }

    /**
     * Called when the frontend application is ready.
     */
    onStart(): void {
        this._isReady = true;
    }

    /**
     * Check if OpenMC is ready to use.
     * Delegates to nuke-core for validation.
     */
    async checkOpenMCAvailability(): Promise<{ 
        available: boolean; 
        version?: string; 
        error?: string;
        needsConfig?: boolean;
    }> {
        // Use OpenMC validation service (uses nuke-core for environment detection)
        const validation = await this.validationService.validateOpenMCSetup();
        
        if (!validation.ready) {
            return {
                available: false,
                error: validation.errors.join('\n') || 'OpenMC is not properly configured',
                needsConfig: !validation.environmentConfigured
            };
        }
        
        return {
            available: true,
            version: validation.environment?.version
        };
    }

    /**
     * Get the cross-sections path from nuke-core.
     */
    getCrossSectionsPath(): string | undefined {
        return this.nukeCoreService.getCrossSectionsPath();
    }

    /**
     * Whether the service is ready.
     */
    get isReady(): boolean {
        return this._isReady;
    }

    /**
     * Get the state manager.
     */
    getStateManager(): OpenMCStateManager {
        return this.stateManager;
    }

    /**
     * Get the backend service.
     */
    getBackendService(): OpenMCStudioBackendService {
        return this.backendService;
    }
    
    /**
     * Get the nuke-core service for advanced operations.
     */
    getNukeCoreService(): NukeCoreService {
        return this.nukeCoreService;
    }
}
