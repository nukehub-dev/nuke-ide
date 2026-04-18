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
import { NukeCoreService } from 'nuke-core/lib/common';
import { OpenMCEnvironmentService } from './openmc-environment-service';

export interface InstallOption {
    id: string;
    label: string;
    description: string;
    packages: string[];
    useConda: boolean;
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
    
    @inject(MessageService)
    protected readonly messageService: MessageService;

    /**
     * Predefined installation options.
     */
    readonly installOptions: InstallOption[] = [
        {
            id: 'openmc',
            label: 'OpenMC',
            description: 'Core OpenMC Monte Carlo simulation package',
            packages: ['openmc'],
            useConda: true
        },
        {
            id: 'openmc-plotter',
            label: 'OpenMC Plotter',
            description: 'Interactive visualization tool for OpenMC',
            packages: ['openmc-plotter'],
            useConda: true
        },
        {
            id: 'dagmc',
            label: 'DAGMC Tools',
            description: 'CAD-based geometry support (pymoab, pydagmc)',
            packages: ['moab', 'pydagmc'],
            useConda: true
        },
        {
            id: 'visualization',
            label: 'Visualization Tools',
            description: 'VTK, matplotlib, and plotting utilities',
            packages: ['vtk', 'matplotlib', 'numpy'],
            useConda: true
        },
        {
            id: 'mpi',
            label: 'MPI Support',
            description: 'Parallel processing with mpi4py',
            packages: ['mpi4py'],
            useConda: true
        },
        {
            id: 'depletion',
            label: 'Depletion Tools',
            description: 'Burnup and depletion calculation support',
            packages: ['openmc', 'numpy', 'scipy'],
            useConda: true
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
     * Install packages using nuke-core.
     */
    async installPackages(
        packages: string[],
        useConda: boolean = true
    ): Promise<InstallResult> {
        const pythonCommand = await this.envService.getPythonCommand();
        
        if (!pythonCommand) {
            return {
                success: false,
                installed: [],
                failed: packages,
                message: 'No Python environment available'
            };
        }

        this.messageService.info(`Installing packages: ${packages.join(', ')}...`);

        try {
            const result = await this.nukeCore.installPackages({
                packages,
                useConda,
                pythonPath: pythonCommand
            });

            if (result.success) {
                this.messageService.info(`Successfully installed: ${result.installed.join(', ')}`);
                
                // Refresh environment status after installation
                await this.envService.refreshStatus();
            } else {
                const failedList = result.failed.length > 0 ? result.failed.join(', ') : 'unknown packages';
                this.messageService.error(`Failed to install: ${failedList}`);
            }

            return {
                success: result.success,
                installed: result.installed,
                failed: result.failed,
                message: result.output
            };
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

        return this.installPackages(option.packages, option.useConda);
    }

    /**
     * Get installation command for display purposes.
     */
    getInstallCommand(packages: string[], useConda: boolean = true): string {
        if (useConda) {
            return `conda install -c conda-forge ${packages.join(' ')}`;
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
