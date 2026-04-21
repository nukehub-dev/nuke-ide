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
 * Environment Commands
 * 
 * Commands for environment management, health checks, and package installation.
 * 
 * @module openmc-studio/browser/commands
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { Command, CommandRegistry } from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';
import { OutputChannelManager } from '@theia/output/lib/browser/output-channel';
import { OpenMCEnvironmentService } from '../services/openmc-environment-service';
import { OpenMCHealthService } from '../services/openmc-health-service';
import { OpenMCInstallerService } from '../services/openmc-installer-service';

export namespace OpenMCEnvironmentCommands {
    /** Command category for all environment-related commands. */
    export const CATEGORY = 'OpenMC/Environment';

    /** Run a comprehensive health check on the OpenMC environment. */
    export const CHECK_HEALTH: Command = {
        id: 'openmc.environment.checkHealth',
        category: CATEGORY,
        label: 'Run Health Check'
    };

    /** Install OpenMC into the active Python environment. */
    export const INSTALL_OPENMC: Command = {
        id: 'openmc.environment.installOpenMC',
        category: CATEGORY,
        label: 'Install OpenMC'
    };

    /** Install DAGMC geometry tools into the active Python environment. */
    export const INSTALL_DAGMC: Command = {
        id: 'openmc.environment.installDAGMC',
        category: CATEGORY,
        label: 'Install DAGMC Tools'
    };
}

/**
 * Environment command handler for OpenMC Studio.
 *
 * Registers and executes commands related to environment health checks,
 * OpenMC installation, and DAGMC tools installation.
 *
 * @see {@link OpenMCEnvironmentCommands} for available command identifiers
 */
@injectable()
export class EnvironmentCommands {

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(OpenMCEnvironmentService)
    protected readonly envService: OpenMCEnvironmentService;

    @inject(OpenMCHealthService)
    protected readonly healthService: OpenMCHealthService;

    @inject(OpenMCInstallerService)
    protected readonly installerService: OpenMCInstallerService;

    @inject(OutputChannelManager)
    protected readonly outputChannelManager: OutputChannelManager;

    /**
     * Register environment commands with the command registry.
     * @param registry - The Theia command registry
     */
    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(OpenMCEnvironmentCommands.CHECK_HEALTH, {
            execute: () => this.checkHealth()
        });

        registry.registerCommand(OpenMCEnvironmentCommands.INSTALL_OPENMC, {
            execute: () => this.installOpenMC()
        });

        registry.registerCommand(OpenMCEnvironmentCommands.INSTALL_DAGMC, {
            execute: () => this.installDAGMC()
        });
    }

    /**
     * Execute a health check on the OpenMC environment and display results
     * in the output channel. Offers auto-fix if environment issues are detected.
     */
    private async checkHealth(): Promise<void> {
        this.messageService.info('Running health check...');

        const result = await this.healthService.runHealthCheck();
        const channel = this.outputChannelManager.getChannel('OpenMC Studio');

        channel.clear();
        channel.appendLine('═'.repeat(50));
        channel.appendLine(` OpenMC Studio Health Check`);
        channel.appendLine('═'.repeat(50));

        // Environment header
        if (result.environment) {
            channel.appendLine(` Environment : ${result.environment.name}`);
            if (result.environment.version) {
                channel.appendLine(` OpenMC Ver. : ${result.environment.version}`);
            }
            channel.appendLine(` Python      : ${result.environment.pythonCommand}`);
            channel.appendLine('');
        }

        // Individual checks
        channel.appendLine(' Checks');
        channel.appendLine('─'.repeat(50));
        for (const check of result.checks) {
            const icon = check.passed ? '✓' : check.severity === 'error' ? '✗' : check.severity === 'warning' ? '⚠' : 'ℹ';
            channel.appendLine(` ${icon} ${check.name}: ${check.message}`);
            if (!check.passed && check.suggestion) {
                channel.appendLine(`   → ${check.suggestion}`);
            }
        }

        channel.appendLine('─'.repeat(50));
        const { errors, warnings, info } = result.summary;
        channel.appendLine(` Summary: ${errors} errors, ${warnings} warnings, ${info} info`);
        channel.appendLine('═'.repeat(50));
        channel.show({ preserveFocus: true });

        if (result.ready && errors === 0 && warnings === 0) {
            this.messageService.info('✓ OpenMC environment is fully healthy');
        } else if (result.ready) {
            this.messageService.warn('OpenMC ready with warnings. See OpenMC Studio output for details.');
        } else {
            this.messageService.error('OpenMC not ready. See OpenMC Studio output for details.');

            // If OpenMC is missing, offer to install it via ensureOpenMC()
            const hasEnvIssue = result.issues.some(i =>
                i.category === 'environment' && i.autoFixable
            );
            if (hasEnvIssue) {
                const ensureResult = await this.envService.ensureOpenMC();
                if (ensureResult.success && ensureResult.installed) {
                    this.messageService.info(
                        `✓ OpenMC installed in ${ensureResult.environment?.name}. Run health check again to verify.`
                    );
                }
            }
        }
    }

    /**
     * Install OpenMC via the installer service.
     * Validates that a Python environment is available before proceeding.
     */
    private async installOpenMC(): Promise<void> {
        const canInstall = await this.installerService.canInstall();
        if (!canInstall) {
            this.messageService.error('No Python environment available. Configure environment first.');
            return;
        }
        
        const result = await this.installerService.installOption('openmc');
        if (!result.success) {
            this.messageService.error(`Installation failed: ${result.message}`);
        }
    }

    /**
     * Install DAGMC tools via the installer service.
     * Validates that a Python environment is available before proceeding.
     */
    private async installDAGMC(): Promise<void> {
        const canInstall = await this.installerService.canInstall();
        if (!canInstall) {
            this.messageService.error('No Python environment available. Configure environment first.');
            return;
        }

        const result = await this.installerService.installOption('dagmc');
        if (!result.success) {
            this.messageService.error(`Installation failed: ${result.message}`);
        }
    }
}
