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
 * Thin wrapper around nuke-core's unified installPackages().
 * Extensions should follow this pattern: define options → show dialog → call installPackages().
 *
 * @module openmc-studio/browser
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { MessageService } from '@theia/core/lib/common/message-service';
import { QuickPickService } from '@theia/core/lib/browser/quick-input';
import { NukeCoreService } from 'nuke-core/lib/common';
import { EnvironmentActionsHelper } from 'nuke-core/lib/browser/services';
import { OpenMCEnvironmentService, OPENMC_EXTRA_INDEX_URL } from './openmc-environment-service';

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

    @inject(QuickPickService)
    protected readonly quickPick: QuickPickService;

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
            extraIndexUrl: OPENMC_EXTRA_INDEX_URL
        },
        {
            id: 'dagmc',
            label: 'DAGMC Tools',
            description: 'CAD-based geometry support (moab, pydagmc) — conda only',
            packages: ['moab', 'pydagmc'],
            useConda: true,
            channels: ['conda-forge']
        },
        {
            id: 'openmc-plotter',
            label: 'OpenMC Plotter',
            description: 'Interactive visualization tool for OpenMC',
            packages: ['openmc-plotter']
        },
        {
            id: 'visualization',
            label: 'Visualization Tools',
            description: 'VTK, matplotlib, and plotting utilities',
            packages: ['vtk', 'matplotlib', 'numpy']
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
            extraIndexUrl: OPENMC_EXTRA_INDEX_URL
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
     * Install packages into the configured environment using nuke-core's
     * unified installPackages(). Handles CWD, terminal, and messages.
     */
    async installPackages(
        packages: string[],
        useConda: boolean = false,
        channels?: string[],
        extraIndexUrl?: string
    ): Promise<InstallResult> {
        const result = await this.envActions.installPackages({
            packages,
            title: `Install: ${packages.join(', ')}`,
            useConda,
            channels,
            extraIndexUrl
        });

        // Refresh OpenMC-specific status after install
        await this.envService.refreshStatus();

        if (result.success) {
            this.messageService.info(`Successfully installed: ${packages.join(', ')}`);
            return {
                success: true,
                installed: packages,
                failed: [],
                message: result.message
            };
        }

        this.messageService.warn(result.message);
        return {
            success: false,
            installed: [],
            failed: packages,
            message: result.message
        };
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
     * Show a QuickPick dialog with predefined install options.
     */
    async showInstallDialog(): Promise<void> {
        const items = this.installOptions.map(opt => ({
            label: opt.label,
            description: opt.packages.join(', '),
            detail: opt.description,
            value: opt.id
        }));

        const selected = await this.quickPick.show(items, {
            placeholder: 'Select packages to install into the configured environment'
        });

        if (!selected || !('value' in selected)) {
            return;
        }

        const result = await this.installOption(selected.value as string);
        if (!result.success) {
            this.messageService.error(result.message || 'Installation failed');
        }
    }

    /**
     * Check if installation is possible (environment available).
     */
    async canInstall(): Promise<boolean> {
        const pythonCommand = await this.envService.getPythonCommand();
        return !!pythonCommand;
    }
}
