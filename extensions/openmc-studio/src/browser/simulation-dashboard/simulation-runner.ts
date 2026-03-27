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
import { Emitter, Event } from '@theia/core/lib/common';

import {
    SimulationRunRequest,
    SimulationRunResult,
    SimulationProgress,
    SimulationStatusEvent,
    OpenMCStudioBackendService
} from '../../common/openmc-studio-protocol';

@injectable()
export class OpenMCSimulationRunner {
    
    @inject(MessageService)
    protected readonly messageService: MessageService;
    
    @inject(OpenMCStudioBackendService)
    protected readonly backendService: OpenMCStudioBackendService;

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

    // ============================================================================
    // Properties
    // ============================================================================

    /**
     * Whether a simulation is currently running.
     */
    get isRunning(): boolean {
        return this._isRunning;
    }

    /**
     * Current process ID if running.
     */
    get currentProcessId(): string | undefined {
        return this._currentProcessId;
    }

    // ============================================================================
    // Simulation Control
    // ============================================================================

    /**
     * Run an OpenMC simulation.
     */
    async runSimulation(request: SimulationRunRequest): Promise<SimulationRunResult> {
        if (this._isRunning) {
            throw new Error('Simulation already running');
        }

        this._isRunning = true;
        this._onSimulationStart.fire();
        this._onStatusChange.fire({
            processId: request.workingDirectory,
            status: 'starting'
        });

        try {
            this._onStatusChange.fire({
                processId: request.workingDirectory,
                status: 'running'
            });

            const result = await this.backendService.runSimulation(request);
            
            this._isRunning = false;
            
            if (result.success) {
                this.messageService.info('Simulation completed successfully');
                this._onStatusChange.fire({
                    processId: request.workingDirectory,
                    status: 'completed',
                    result
                });
            } else {
                const errorMsg = result.error || `Exit code: ${result.exitCode}`;
                this.messageService.error(`Simulation failed: ${errorMsg}`);
                this._onStatusChange.fire({
                    processId: request.workingDirectory,
                    status: 'failed',
                    result
                });
            }
            
            this._onSimulationComplete.fire(result);
            return result;
            
        } catch (error) {
            this._isRunning = false;
            const msg = error instanceof Error ? error.message : String(error);
            
            this.messageService.error(`Simulation error: ${msg}`);
            this._onStatusChange.fire({
                processId: request.workingDirectory,
                status: 'failed',
                result: {
                    success: false,
                    stdout: '',
                    stderr: msg,
                    outputFiles: []
                }
            });
            
            throw error;
        }
    }

    /**
     * Cancel the current simulation.
     */
    async cancelSimulation(): Promise<boolean> {
        return this.stopSimulation();
    }

    /**
     * Stop the current simulation.
     */
    async stopSimulation(): Promise<boolean> {
        if (!this._isRunning || !this._currentProcessId) {
            return false;
        }

        try {
            const success = await this.backendService.cancelSimulation(this._currentProcessId);
            
            if (success) {
                this._isRunning = false;
                this.messageService.info('Simulation stopped');
                this._onStatusChange.fire({
                    processId: this._currentProcessId,
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
     * Handle progress update from backend.
     */
    onProgressUpdate(progress: SimulationProgress): void {
        this._onProgress.fire(progress);
    }
}
