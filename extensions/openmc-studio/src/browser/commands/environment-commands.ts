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
    export const CATEGORY = 'OpenMC/Environment';

    export const CHECK_HEALTH: Command = {
        id: 'openmc.environment.checkHealth',
        category: CATEGORY,
        label: 'Run Health Check'
    };

    export const INSTALL_OPENMC: Command = {
        id: 'openmc.environment.installOpenMC',
        category: CATEGORY,
        label: 'Install OpenMC'
    };

    export const INSTALL_DAGMC: Command = {
        id: 'openmc.environment.installDAGMC',
        category: CATEGORY,
        label: 'Install DAGMC Tools'
    };
}

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
