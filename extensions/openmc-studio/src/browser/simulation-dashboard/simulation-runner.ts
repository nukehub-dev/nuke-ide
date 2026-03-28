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
 * Simulation Runner
 * 
 * Frontend service for running OpenMC simulations and monitoring progress.
 * This is a placeholder for Phase 1 implementation.
 * 
 * @module openmc-studio/browser
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { MessageService } from '@theia/core/lib/common/message-service';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { Emitter, Event } from '@theia/core/lib/common';

import {
    SimulationRunRequest,
    SimulationRunResult,
    SimulationProgress,
    SimulationStatusEvent,
    OpenMCStudioBackendService
} from '../../common/openmc-studio-protocol';
import { NukeCoreService } from 'nuke-core/lib/common';

@injectable()
export class OpenMCSimulationRunner {
    
    @inject(MessageService)
    protected readonly messageService: MessageService;
    
    @inject(OpenMCStudioBackendService)
    protected readonly backendService: OpenMCStudioBackendService;
    
    @inject(PreferenceService)
    protected readonly preferences: PreferenceService;
    
    @inject(NukeCoreService)
    protected readonly nukeCoreService: NukeCoreService;
    
    private _isRunning = false;
    private _currentProcessId?: string;

    // Event emitters
    private readonly _onSimulationStart = new Emitter<void>();
    readonly onSimulationStart: Event<void> = this._onSimulationStart.event;

    private readonly _onSimulationComplete = new Emitter<SimulationRunResult>();
    readonly onSimulationComplete: Event<SimulationRunResult> = this._onSimulationComplete.event;

    private readonly _onProgress = new Emitter<SimulationProgress>();
    readonly onProgress: Event<SimulationProgress> = this._onProgress.event;

    private readonly _onStatusChange = new Emitter<SimulationStatusEvent>();
    readonly onStatusChange: Event<SimulationStatusEvent> = this._onStatusChange.event;

    /**
     * Start an OpenMC simulation.
     */
    async runSimulation(request: SimulationRunRequest): Promise<void> {
        if (this._isRunning) {
            this.messageService.warn('A simulation is already running.');
            return;
        }

        this._isRunning = true;
        this._onSimulationStart.fire();

        try {
            // Get cross-sections environment if available
            const env = await this.getCrossSectionsEnv();
            const fullRequest = {
                ...request,
                env: {
                    ...request.env,
                    ...env
                }
            };

            await this.backendService.runSimulation(fullRequest);
            // Result from backend already contains simulation results if it finishes immediately,
            // but usually it just starts. Actually, the protocol says runSimulation returns SimulationRunResult.
            // If it's a long running process, the backend might handle it differently.
            
            this._onStatusChange.fire({
                processId: '', // Placeholder since SimulationRunResult doesn't have it
                status: 'running'
            });

        } catch (error) {
            this._isRunning = false;
            const msg = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to start simulation: ${msg}`);
            this._onSimulationComplete.fire({
                success: false,
                error: msg,
                stdout: '',
                stderr: '',
                outputFiles: [],
                timing: {
                    startTime: new Date().toISOString(),
                    endTime: new Date().toISOString(),
                    duration: 0
                }
            });
        }
    }

    /**
     * Handle simulation completion.
     */
    onSimulationFinished(result: SimulationRunResult): void {
        this._isRunning = false;
        this._currentProcessId = undefined;
        this._onSimulationComplete.fire(result);
        
        this._onStatusChange.fire({
            processId: '',
            status: result.success ? 'completed' : 'failed',
            result
        });
    }

    /**
     * Stop a running simulation.
     */
    async stopSimulation(): Promise<boolean> {
        if (!this._isRunning || !this._currentProcessId) {
            return false;
        }

        try {
            const success = await this.backendService.cancelSimulation(this._currentProcessId);
            if (success) {
                this._isRunning = false;
                this._currentProcessId = undefined;
                this._onStatusChange.fire({
                    processId: '',
                    status: 'cancelled'
                });
            }

            return success;
        } catch (error) {
            console.error('[OpenMC Studio] Error stopping simulation:', error);
            return false;
        }
    }

    /**
     * Get cross-sections environment variable if configured.
     * Uses nuke-core cross-sections path.
     */
    private async getCrossSectionsEnv(): Promise<{ [key: string]: string } | undefined> {
        // Use nuke-core cross-sections path
        let xsPath = this.nukeCoreService.getCrossSectionsPath();
        
        // Check environment variable as last resort if nuke-core doesn't have it
        if (!xsPath && typeof process !== 'undefined' && process.env) {
            xsPath = process.env.OPENMC_CROSS_SECTIONS;
        }
        
        if (xsPath) {
            console.log(`[OpenMC Studio] Using cross-sections path: ${xsPath}`);
            return { OPENMC_CROSS_SECTIONS: xsPath };
        }
        
        return undefined;
    }

    /**
     * Handle progress update from backend.
     */
    onProgressUpdate(progress: SimulationProgress): void {
        this._onProgress.fire(progress);
    }
}
