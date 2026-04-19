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
 * OpenMC Installer Service
 * 
 * Handles package installation for OpenMC and related tools.
 * 
 * @module openmc-studio/browser
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { MessageService } from '@theia/core/lib/common/message-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { NukeCoreService } from 'nuke-core/lib/common';
import { EnvironmentActionsHelper } from 'nuke-core/lib/browser/services/environment-actions-helper';
import { OpenMCEnvironmentService } from './openmc-environment-service';

export interface InstallOption {
    id: string;
    label: string;
    description: string;
    packages: string[];
    useConda?: boolean;
    channels?: string[];
    extraIndexUrl?: string;
}

export interface InstallResult {
    success: boolean;
    installed: string[];
    failed: string[];
    message?: string;
}

@injectable()
export class OpenMCInstallerService {
    
    @inject(NukeCoreService)
    protected readonly nukeCore: NukeCoreService;
    
    @inject(OpenMCEnvironmentService)
    protected readonly envService: OpenMCEnvironmentService;

    @inject(EnvironmentActionsHelper)
    protected readonly envActions: EnvironmentActionsHelper;
    
    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    /**
     * Predefined installation options.
     */
    readonly installOptions: InstallOption[] = [
        {
            id: 'openmc',
            label: 'OpenMC',
            description: 'Core OpenMC Monte Carlo simulation package (pip + shimwell wheels)',
            packages: ['openmc'],
            extraIndexUrl: 'https://shimwell.github.io/wheels'
        },
        {
            id: 'dagmc',
            label: 'DAGMC Tools',
            description: 'CAD-based geometry support (pip + shimwell wheels)',
            packages: ['moab', 'pydagmc'],
            extraIndexUrl: 'https://shimwell.github.io/wheels'
        },
        {
            id: 'mpi',
            label: 'MPI Support',
            description: 'Parallel processing with mpi4py — conda recommended',
            packages: ['mpi4py'],
            useConda: true,
            channels: ['conda-forge']
        },
        {
            id: 'depletion',
            label: 'Depletion Tools',
            description: 'Burnup and depletion calculation support',
            packages: ['openmc', 'numpy', 'scipy'],
            extraIndexUrl: 'https://shimwell.github.io/wheels'
        }
    ];

    /**
     * Check which packages are missing from the current environment.
     */
    async checkMissingPackages(packages: string[]): Promise<string[]> {
        const pythonCommand = await this.envService.getPythonCommand();
        if (!pythonCommand) {
            return packages;
        }

        try {
            const depCheck = await this.nukeCore.checkDependencies(
                packages.map(p => ({ name: p, required: true })),
                pythonCommand
            );
            return depCheck.missing;
        } catch {
            return packages;
        }
    }

    /**
     * Install packages using nuke-core in a live terminal.
     */
    async installPackages(
        packages: string[],
        useConda: boolean = false,
        channels?: string[],
        extraIndexUrl?: string
    ): Promise<InstallResult> {
        // Use the configured environment's python path, not the fallback-detected one.
        // getPythonCommand() may return a different env that happens to have the packages.
        const config = await this.nukeCore.getConfig();
        const selectedEnv = await this.nukeCore.getSelectedEnvironment();

        let pythonPath: string | undefined;
        if (selectedEnv && (
            (config.condaEnv && selectedEnv.name === config.condaEnv) ||
            (config.pythonPath && selectedEnv.pythonPath === config.pythonPath)
        )) {
            pythonPath = selectedEnv.pythonPath;
        } else if (config.pythonPath) {
            pythonPath = config.pythonPath;
        } else {
            // No configured env — fall back to detected
            pythonPath = await this.envService.getPythonCommand();
        }

        if (!pythonPath) {
            return {
                success: false,
                installed: [],
                failed: packages,
                message: 'No Python environment available'
            };
        }

        // Resolve workspace root for CWD so installs run in the project directory
        const roots = await this.workspaceService.roots;
        const workspaceRoot = roots[0]?.resource?.path?.toString() || '';

        try {
            // 1. Prepare the install command
            const cmdInfo = await this.nukeCore.prepareInstallPackagesCommand({
                packages,
                useConda,
                channels,
                extraIndexUrl,
                pythonPath,
                cwd: workspaceRoot
            });

            // 2. Run in a live terminal so the user sees progress
            const success = await this.envActions.runCommandInTerminal({
                title: `Install: ${packages.join(', ')}`,
                cwd: cmdInfo.cwd,
                args: this.envActions.parseCommandString(cmdInfo.command)
            });

            // 3. Refresh environment status after installation
            await this.envService.refreshStatus();

            if (success) {
                this.messageService.info(`Successfully installed: ${packages.join(', ')}`);
                return {
                    success: true,
                    installed: packages,
                    failed: [],
                    message: `Installed ${packages.join(', ')} in terminal`
                };
            } else {
                this.messageService.warn(
                    `Installation may have failed. Check the terminal for details.`
                );
                return {
                    success: false,
                    installed: [],
                    failed: packages,
                    message: 'Installation failed or was cancelled. Check the terminal for details.'
                };
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Installation failed: ${msg}`);
            return {
                success: false,
                installed: [],
                failed: packages,
                message: msg
            };
        }
    }

    /**
     * Install a predefined option by ID.
     */
    async installOption(optionId: string): Promise<InstallResult> {
        const option = this.installOptions.find(o => o.id === optionId);
        if (!option) {
            return {
                success: false,
                installed: [],
                failed: [],
                message: `Unknown installation option: ${optionId}`
            };
        }

        return this.installPackages(option.packages, option.useConda, option.channels, option.extraIndexUrl);
    }

    /**
     * Get installation command for display purposes.
     */
    async getInstallCommand(packages: string[], useConda: boolean = true): Promise<string> {
        if (useConda) {
            const config = await this.nukeCore.getConfig();
            const channels = config.condaChannels?.split(',').map(c => c.trim()).filter(Boolean) || ['conda-forge'];
            const channelArgs = channels.flatMap(c => ['-c', c]).join(' ');
            return `conda install ${channelArgs} ${packages.join(' ')}`;
        }
        return `pip install ${packages.join(' ')}`;
    }

    /**
     * Check if installation is possible (environment available).
     */
    async canInstall(): Promise<boolean> {
        const pythonCommand = await this.envService.getPythonCommand();
        return !!pythonCommand;
    }

    /**
     * Show installation dialog and handle user selection.
     */
    async showInstallDialog(): Promise<void> {
        // This will be implemented with a UI component
        // For now, just log available options
        console.log('[OpenMC Installer] Available options:', this.installOptions);
    }
}
