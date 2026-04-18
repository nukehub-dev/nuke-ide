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
    SimulationLogResult,
    OpenMCStudioBackendService
} from '../../../common/openmc-studio-protocol';
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
     * Note: This method returns immediately and the simulation runs asynchronously.
     * Listen to onStatusChange and onSimulationComplete events for updates.
     */
    async runSimulation(request: SimulationRunRequest): Promise<void> {
        if (this._isRunning) {
            this.messageService.warn('A simulation is already running.');
            return;
        }

        this._isRunning = true;
        this._onSimulationStart.fire();

        try {
            // Get cross-sections and chain file environment if available
            const crossSectionsEnv = await this.getCrossSectionsEnv();
            const chainFileEnv = await this.getChainFileEnv();
            const env = { ...crossSectionsEnv, ...chainFileEnv };
            const fullRequest = {
                ...request,
                env: {
                    ...request.env,
                    ...env
                }
            };

            // Fire starting status
            this._onStatusChange.fire({
                processId: '',
                status: 'starting'
            });

            // Start simulation non-blocking - returns processId immediately
            const response = await this.backendService.startSimulation(fullRequest);
            
            if (!response.success) {
                this._isRunning = false;
                const errorMsg = response.error || 'Failed to start simulation';
                this.messageService.error(errorMsg);
                this._onSimulationComplete.fire({
                    success: false,
                    error: errorMsg,
                    stdout: '',
                    stderr: '',
                    outputFiles: [],
                    timing: {
                        startTime: new Date().toISOString(),
                        endTime: new Date().toISOString(),
                        duration: 0
                    }
                });
                this._onStatusChange.fire({
                    processId: '',
                    status: 'failed',
                    result: {
                        success: false,
                        error: errorMsg,
                        stdout: '',
                        stderr: '',
                        outputFiles: [],
                        timing: {
                            startTime: new Date().toISOString(),
                            endTime: new Date().toISOString(),
                            duration: 0
                        }
                    }
                });
                return;
            }

            // Store processId for cancellation
            this._currentProcessId = response.processId;
            
            // Fire running status
            this._onStatusChange.fire({
                processId: response.processId,
                status: 'running'
            });

        } catch (error) {
            this._isRunning = false;
            this._currentProcessId = undefined;
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
     * Get chain file environment variable if configured.
     * Uses nuke-core chain file path.
     */
    private async getChainFileEnv(): Promise<{ [key: string]: string } | undefined> {
        let chainPath = this.nukeCoreService.getChainFilePath();
        
        if (!chainPath && typeof process !== 'undefined' && process.env) {
            chainPath = process.env.OPENMC_CHAIN_FILE;
        }
        
        if (chainPath) {
            console.log(`[OpenMC Studio] Using chain file path: ${chainPath}`);
            return { OPENMC_CHAIN_FILE: chainPath };
        }
        
        return undefined;
    }

    /**
     * Handle progress update from backend.
     */
    onProgressUpdate(progress: SimulationProgress): void {
        this._onProgress.fire(progress);
    }

    /**
     * Get the current process ID.
     */
    get currentProcessId(): string | undefined {
        return this._currentProcessId;
    }

    /**
     * Check if a simulation is running.
     */
    get isRunning(): boolean {
        return this._isRunning;
    }

    /**
     * Get simulation log file content.
     */
    async getSimulationLog(processId?: string): Promise<SimulationLogResult> {
        const pid = processId || this._currentProcessId;
        if (!pid) {
            return {
                success: false,
                error: 'No simulation running or processId provided'
            };
        }
        return this.backendService.getSimulationLog(pid);
    }
}
