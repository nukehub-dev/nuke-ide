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
 * Manages the lifecycle of the extension and provides high-level operations.
 * 
 * @module openmc-studio/browser
 */

import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { MessageService } from '@theia/core/lib/common/message-service';
import { Emitter, Event } from '@theia/core/lib/common';
import { PreferenceService } from '@theia/core/lib/common/preferences';

import { OpenMCStateManager } from './openmc-state-manager';
import { OpenMCStudioBackendService } from '../common/openmc-studio-protocol';

@injectable()
export class OpenMCStudioService implements FrontendApplicationContribution {
    
    @inject(MessageService)
    protected readonly messageService: MessageService;
    
    @inject(OpenMCStateManager)
    protected readonly stateManager: OpenMCStateManager;
    
    @inject(OpenMCStudioBackendService)
    protected readonly backendService: OpenMCStudioBackendService;
    
    @inject(PreferenceService)
    protected readonly preferences: PreferenceService;

    private readonly _onInitialized = new Emitter<void>();
    readonly onInitialized: Event<void> = this._onInitialized.event;

    private _isReady = false;
    private _openmcAvailable?: boolean;
    private _openmcVersion?: string;

    @postConstruct()
    protected init(): void {
        console.log('[OpenMC Studio] Service initialized');
        this.syncPythonConfig();
        
        // Listen for Python preference changes from nuke-visualizer
        this.preferences.onPreferenceChanged(event => {
            if (event.preferenceName === 'nukeVisualizer.pythonPath' || 
                event.preferenceName === 'nukeVisualizer.condaEnv') {
                console.log(`[OpenMC Studio] Python config changed: ${event.preferenceName}`);
                this.syncPythonConfig();
            }
        });
    }
    
    /**
     * Sync Python configuration from nuke-visualizer preferences.
     */
    protected syncPythonConfig(): void {
        const pythonPath = this.preferences.get('nukeVisualizer.pythonPath') as string | undefined;
        const condaEnv = this.preferences.get('nukeVisualizer.condaEnv') as string | undefined;
        
        if (pythonPath || condaEnv) {
            console.log(`[OpenMC Studio] Setting Python config: path=${pythonPath}, conda=${condaEnv}`);
            this.backendService.setPythonConfig({
                pythonPath: pythonPath || undefined,
                condaEnv: condaEnv || undefined
            }).catch(err => {
                console.error('[OpenMC Studio] Failed to set Python config:', err);
            });
        }
    }

    /**
     * Called when the frontend application is ready.
     */
    onStart(): void {
        this._isReady = true;
        this._onInitialized.fire();
        // Don't check OpenMC availability on startup - check lazily when needed
    }

    /**
     * Check if OpenMC is available. Cached after first call.
     */
    async checkOpenMCAvailability(): Promise<{ available: boolean; version?: string; error?: string }> {
        // Return cached result if available
        if (this._openmcAvailable !== undefined) {
            return {
                available: this._openmcAvailable,
                version: this._openmcVersion,
                error: this._openmcAvailable ? undefined : 'OpenMC not available'
            };
        }
        
        try {
            const result = await this.backendService.checkOpenMC();
            this._openmcAvailable = result.available;
            this._openmcVersion = result.version;
            return result;
        } catch (error) {
            console.error('[OpenMC Studio] Error checking OpenMC availability:', error);
            this._openmcAvailable = false;
            return {
                available: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Whether the service is ready.
     */
    get isReady(): boolean {
        return this._isReady;
    }

    /**
     * Whether OpenMC is available (cached from last check).
     */
    get openmcAvailable(): boolean | undefined {
        return this._openmcAvailable;
    }

    /**
     * OpenMC version if available.
     */
    get openmcVersion(): string | undefined {
        return this._openmcVersion;
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
}
