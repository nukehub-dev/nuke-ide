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
 * Provides status tracking, environment selection, and ensures required packages
 * (OpenMC core, DAGMC tools) are available in the active environment.
 *
 * @see {@link OpenMCHealthService} for comprehensive health checks
 * @see {@link OpenMCInstallerService} for package installation workflows
 * @module openmc-studio/browser
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core/lib/common';
import { NukeCoreService, NukeEnvironment } from 'nuke-core/lib/common';
import { EnvironmentActionsHelper } from 'nuke-core/lib/browser/services';
import { MessageService } from '@theia/core/lib/common/message-service';

/** Status snapshot of the OpenMC environment at a given point in time. */
export interface OpenMCEnvironmentStatus {
    /** Whether the environment is ready to run OpenMC. */
    ready: boolean;
    /** The currently selected Python environment, if any. */
    environment?: NukeEnvironment;
    /** Absolute path to the Python executable in the active environment. */
    pythonCommand?: string;
    /** Detected OpenMC package version string, e.g. "0.14.0". */
    openmcVersion?: string;
    /** Critical error message preventing OpenMC from running. */
    error?: string;
    /** Non-critical warning message (e.g. missing optional packages). */
    warning?: string;
}

/** Shared extra index URL for OpenMC pip installs. Single source of truth. */
export const OPENMC_EXTRA_INDEX_URL = 'https://shimwell.github.io/wheels';

@injectable()
export class OpenMCEnvironmentService {

    @inject(NukeCoreService)
    protected readonly nukeCore: NukeCoreService;

    @inject(EnvironmentActionsHelper)
    protected readonly envActions: EnvironmentActionsHelper;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    /** Emitter fired whenever the environment status changes. */
    private readonly _onEnvironmentChanged = new Emitter<OpenMCEnvironmentStatus>();
    /** Event subscribers can listen to for environment status updates. */
    readonly onEnvironmentChanged: Event<OpenMCEnvironmentStatus> = this._onEnvironmentChanged.event;

    /** Cached current environment status. */
    private currentStatus: OpenMCEnvironmentStatus = { ready: false };

    /**
     * Initialize the service and set up listeners.
     * Wires up nuke-core environment change events and performs an initial status check.
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
     * Get the current environment status.
     * @returns The cached {@link OpenMCEnvironmentStatus} snapshot.
     */
    getStatus(): OpenMCEnvironmentStatus {
        return this.currentStatus;
    }

    /**
     * Check if the OpenMC environment is ready to use.
     * @returns `true` if a Python environment is configured and OpenMC is installed.
     */
    isReady(): boolean {
        return this.currentStatus.ready;
    }

    /**
     * Refresh the environment status.
     * Checks ONLY the configured environment — never falls back to a different one.
     * Fires {@link onEnvironmentChanged} if the status changes.
     * @returns The updated {@link OpenMCEnvironmentStatus}.
     */
    async refreshStatus(): Promise<OpenMCEnvironmentStatus> {
        const env = await this.nukeCore.getSelectedEnvironment();

        if (!env) {
            this.currentStatus = {
                ready: false,
                error: 'No Python environment configured'
            };
            this._onEnvironmentChanged.fire(this.currentStatus);
            return this.currentStatus;
        }

        // Check OpenMC in the configured env only (no fallback discovery)
        try {
            const depCheck = await this.nukeCore.checkDependencies(
                [{ name: 'openmc' }],
                env.pythonPath
            );

            if (depCheck.available) {
                this.currentStatus = {
                    ready: true,
                    environment: env,
                    pythonCommand: env.pythonPath,
                    openmcVersion: depCheck.versions['openmc']
                };
            } else {
                this.currentStatus = {
                    ready: false,
                    environment: env,
                    error: `OpenMC not installed in ${env.name}`
                };
            }
        } catch {
            this.currentStatus = {
                ready: false,
                environment: env,
                error: `Failed to check OpenMC in ${env.name}`
            };
        }

        this._onEnvironmentChanged.fire(this.currentStatus);
        return this.currentStatus;
    }

    /**
     * List all available environments that have OpenMC installed.
     * Iterates over every environment known to nuke-core and checks for the `openmc` package.
     * @returns Array of environments augmented with their `openmcVersion`, if detected.
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
     * Switch to a specific Python environment.
     * @param environment The {@link NukeEnvironment} to activate.
     * @returns `true` if the switch succeeded.
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
     * Show an environment picker dialog.
     * Returns the first available OpenMC environment as a placeholder until UI is implemented.
     * @returns The selected {@link NukeEnvironment}, or `undefined` if none are available.
     */
    async showEnvironmentPicker(): Promise<NukeEnvironment | undefined> {
        // This will be implemented with a UI component
        // For now, return the best available
        const envs = await this.listOpenMCEnvironments();
        return envs[0];
    }

    /**
     * Get the Python command for running OpenMC in the active environment.
     * Triggers a status refresh if the current status is not ready.
     * @returns Absolute path to the Python executable, or `undefined` if no environment is ready.
     */
    async getPythonCommand(): Promise<string | undefined> {
        if (!this.currentStatus.ready) {
            await this.refreshStatus();
        }
        return this.currentStatus.pythonCommand;
    }

    /**
     * Ensure OpenMC is installed in the configured environment.
     * Detects first; if missing, prompts the user with a notification
     * to install via a live terminal. Re-detects after installation.
     * @returns Result object indicating success, whether packages were installed,
     *          and the active environment details.
     */
    async ensureOpenMC(): Promise<{
        success: boolean;
        installed?: boolean;
        environment?: NukeEnvironment;
        pythonCommand?: string;
    }> {
        const result = await this.envActions.ensurePackages({
            requiredPackages: [
                { name: 'openmc', extraIndexUrl: OPENMC_EXTRA_INDEX_URL }
            ],
            title: 'Install OpenMC'
        });

        if (result.success && result.environment) {
            // Refresh our cached status
            await this.refreshStatus();
            return {
                success: true,
                installed: result.installed,
                environment: result.environment,
                pythonCommand: result.command
            };
        }

        return {
            success: false,
            installed: result.installed
        };
    }

    /**
     * Ensure DAGMC tools (moab, pydagmc) are installed in the configured environment.
     * These packages are conda-only and pulled from the `conda-forge` channel.
     * @returns Result object indicating success and installation state.
     */
    async ensureDAGMC(): Promise<{
        success: boolean;
        installed?: boolean;
        environment?: NukeEnvironment;
        pythonCommand?: string;
    }> {
        const result = await this.envActions.ensurePackages({
            requiredPackages: [
                { name: 'moab', condaOnly: true, channels: ['conda-forge'] },
                { name: 'pydagmc', condaOnly: true, channels: ['conda-forge'] }
            ],
            title: 'Install DAGMC Tools'
        });

        if (result.success && result.environment) {
            await this.refreshStatus();
            return {
                success: true,
                installed: result.installed,
                environment: result.environment,
                pythonCommand: result.command
            };
        }

        return {
            success: false,
            installed: result.installed
        };
    }

    /**
     * Check for DAGMC support in the current environment.
     * Verifies that both `pydagmc` and `pymoab` are importable.
     * @returns `true` if DAGMC libraries are available.
     */
    async hasDAGMCSupport(): Promise<boolean> {
        const pythonCommand = await this.getPythonCommand();
        if (!pythonCommand) return false;

        try {
            const result = await this.nukeCore.checkDependencies(
                [
                    { name: 'pydagmc' },
                    { name: 'pymoab' }
                ],
                pythonCommand
            );
            return result.available;
        } catch {
            return false;
        }
    }
}
