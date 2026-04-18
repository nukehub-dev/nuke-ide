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
 * OpenMC Environment Management Service
 * 
 * Manages Python environment detection, switching, and monitoring for OpenMC.
 * 
 * @module openmc-studio/browser
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core/lib/common';
import { NukeCoreService, NukeEnvironment } from 'nuke-core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';

export interface OpenMCEnvironmentStatus {
    ready: boolean;
    environment?: NukeEnvironment;
    pythonCommand?: string;
    openmcVersion?: string;
    error?: string;
    warning?: string;
}

@injectable()
export class OpenMCEnvironmentService {
    
    @inject(NukeCoreService)
    protected readonly nukeCore: NukeCoreService;
    
    @inject(MessageService)
    protected readonly messageService: MessageService;

    private readonly _onEnvironmentChanged = new Emitter<OpenMCEnvironmentStatus>();
    readonly onEnvironmentChanged: Event<OpenMCEnvironmentStatus> = this._onEnvironmentChanged.event;

    private currentStatus: OpenMCEnvironmentStatus = { ready: false };

    /**
     * Initialize the service and set up listeners.
     */
    async initialize(): Promise<void> {
        // Listen for nuke-core environment changes
        this.nukeCore.onEnvironmentChanged(async () => {
            await this.refreshStatus();
        });
        
        // Initial status check
        await this.refreshStatus();
    }

    /**
     * Get current environment status.
     */
    getStatus(): OpenMCEnvironmentStatus {
        return this.currentStatus;
    }

    /**
     * Check if OpenMC environment is ready.
     */
    isReady(): boolean {
        return this.currentStatus.ready;
    }

    /**
     * Refresh the environment status.
     */
    async refreshStatus(): Promise<OpenMCEnvironmentStatus> {
        const detection = await this.nukeCore.detectPythonWithRequirements({
            requiredPackages: [{ name: 'openmc' }],
            searchWorkspaceVenvs: true
        });

        if (detection.success && detection.command) {
            // Get OpenMC version
            let openmcVersion: string | undefined;
            try {
                const depCheck = await this.nukeCore.checkDependencies(
                    [{ name: 'openmc' }],
                    detection.command
                );
                openmcVersion = depCheck.versions['openmc'];
            } catch {
                // Version check failed
            }

            this.currentStatus = {
                ready: true,
                environment: detection.environment,
                pythonCommand: detection.command,
                openmcVersion,
                warning: detection.warning
            };
            
            // Note: Fallback warnings are now handled centrally by nuke-core's onEnvironmentFallback event
        } else {
            this.currentStatus = {
                ready: false,
                error: detection.error || 'OpenMC not found in any environment'
            };
        }

        this._onEnvironmentChanged.fire(this.currentStatus);
        return this.currentStatus;
    }

    /**
     * List all available environments that have OpenMC.
     */
    async listOpenMCEnvironments(): Promise<Array<NukeEnvironment & { openmcVersion?: string }>> {
        const allEnvs = await this.nukeCore.listEnvironments(true);
        const openmcEnvs: Array<NukeEnvironment & { openmcVersion?: string }> = [];

        for (const env of allEnvs) {
            try {
                const depCheck = await this.nukeCore.checkDependencies(
                    [{ name: 'openmc' }],
                    env.pythonPath
                );
                if (depCheck.available) {
                    openmcEnvs.push({
                        ...env,
                        openmcVersion: depCheck.versions['openmc']
                    });
                }
            } catch {
                // Skip environments that fail check
            }
        }

        return openmcEnvs;
    }

    /**
     * Switch to a specific environment.
     */
    async switchToEnvironment(environment: NukeEnvironment): Promise<boolean> {
        try {
            await this.nukeCore.switchToEnvironment(environment);
            this.messageService.info(`Switched to environment: ${environment.name}`);
            return true;
        } catch (error) {
            this.messageService.error(`Failed to switch environment: ${error}`);
            return false;
        }
    }

    /**
     * Show environment picker dialog.
     */
    async showEnvironmentPicker(): Promise<NukeEnvironment | undefined> {
        // This will be implemented with a UI component
        // For now, return the best available
        const envs = await this.listOpenMCEnvironments();
        return envs[0];
    }

    /**
     * Get Python command for running OpenMC.
     */
    async getPythonCommand(): Promise<string | undefined> {
        if (!this.currentStatus.ready) {
            await this.refreshStatus();
        }
        return this.currentStatus.pythonCommand;
    }

    /**
     * Check for DAGMC support in current environment.
     */
    async hasDAGMCSupport(): Promise<boolean> {
        const pythonCommand = await this.getPythonCommand();
        if (!pythonCommand) return false;

        try {
            const result = await this.nukeCore.detectPythonWithRequirements({
                requiredPackages: [{ name: 'pydagmc' }],
                searchWorkspaceVenvs: true
            });
            return result.success;
        } catch {
            return false;
        }
    }
}
