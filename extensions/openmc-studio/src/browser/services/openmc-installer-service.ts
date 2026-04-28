// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice,
//    this list of conditions and the following disclaimer.
//
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.
// SPDX-License-Identifier: BSD-2-Clause
// *****************************************************************************

/**
 * OpenMC Installer Service
 *
 * Thin wrapper around nuke-core's unified `installPackages()`.
 * Extensions should follow this pattern: define options → show dialog → call `installPackages()`.
 *
 * @see {@link OpenMCEnvironmentService} for environment detection and switching
 * @see {@link OpenMCHealthService} for post-install health verification
 * @module openmc-studio/browser
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { MessageService } from '@theia/core/lib/common/message-service';
import { QuickPickService } from '@theia/core/lib/browser/quick-input';
import { NukeCoreService } from 'nuke-core/lib/common';
import { EnvironmentActionsHelper } from 'nuke-core/lib/browser/services';
import { OpenMCEnvironmentService, OPENMC_EXTRA_INDEX_URL } from './openmc-environment-service';
import { getOpenMCHealthPackages } from './openmc-package-metadata';

/** Predefined installation option that maps a user-facing label to a set of packages. */
export interface InstallOption {
    /** Machine-readable identifier for the option (e.g. 'openmc', 'dagmc'). */
    id: string;
    /** Human-readable label shown in UI pickers. */
    label: string;
    /** Longer description explaining what the option provides. */
    description: string;
    /** Package names to install for this option. */
    packages: string[];
    /** Whether to use `conda install` instead of `pip install`. */
    useConda?: boolean;
    /** Conda channels to use when `useConda` is true. */
    channels?: string[];
    /** Extra pip index URL for packages not on PyPI. */
    extraIndexUrl?: string;
}

/** Result of an installation attempt. */
export interface InstallResult {
    /** Whether the overall operation succeeded. */
    success: boolean;
    /** Packages that were successfully installed. */
    installed: string[];
    /** Packages that failed to install. */
    failed: string[];
    /** Human-readable message describing the outcome. */
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
     * Predefined installation options exposed to users.
     * Each option bundles packages, install method, and metadata for a common use-case.
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
            description: 'CAD-based geometry support (moab, pydagmc, ocp) — conda only',
            packages: ['moab', 'pydagmc', 'ocp'],
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
     * Uses shared package metadata so suggestions stay consistent with health checks.
     * @param packages Package names to verify.
     * @returns Array of package names that are not installed or not importable.
     */
    async checkMissingPackages(packages: string[]): Promise<string[]> {
        const pythonCommand = await this.envService.getPythonCommand();
        if (!pythonCommand) {
            return packages;
        }

        const healthPackages = getOpenMCHealthPackages();
        const toCheck = packages
            .map(name => healthPackages.find(p => p.name === name) || { name, required: true })
            .filter((p): p is NonNullable<typeof p> => !!p);

        try {
            const depCheck = await this.nukeCore.checkDependencies(toCheck, pythonCommand);
            return depCheck.missing;
        } catch {
            return packages;
        }
    }

    /**
     * Install packages into the configured environment using nuke-core's
     * unified `installPackages()`. Handles CWD, terminal, and messages.
     * @param packages Package names to install.
     * @param useConda Whether to use `conda install` instead of `pip install`.
     * @param channels Conda channels to use when `useConda` is true.
     * @param extraIndexUrl Extra pip index URL for packages not on PyPI.
     * @returns An {@link InstallResult} describing the outcome.
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
     * Install a predefined option by its ID.
     * @param optionId The {@link InstallOption.id} to install (e.g. 'openmc', 'dagmc').
     * @returns An {@link InstallResult} describing the outcome.
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
     * Triggers installation for the option selected by the user.
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
     * Check if installation is possible (i.e. a Python environment is available).
     * @returns `true` if the active environment has a valid Python command.
     */
    async canInstall(): Promise<boolean> {
        const pythonCommand = await this.envService.getPythonCommand();
        return !!pythonCommand;
    }
}
