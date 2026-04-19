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
import { QuickPickService } from '@theia/core/lib/common/quick-pick-service';
import { OpenMCEnvironmentService } from '../services/openmc-environment-service';
import { OpenMCHealthService } from '../services/openmc-health-service';
import { OpenMCInstallerService } from '../services/openmc-installer-service';

export namespace OpenMCEnvironmentCommands {
    export const CATEGORY = 'OpenMC/Environment';

    export const CHECK_HEALTH: Command = {
        id: 'openmc.environment.checkHealth',
        category: CATEGORY,
        label: 'Check Environment Health'
    };

    export const SWITCH_ENVIRONMENT: Command = {
        id: 'openmc.environment.switch',
        category: CATEGORY,
        label: 'Switch Environment'
    };

    export const REFRESH_ENVIRONMENT: Command = {
        id: 'openmc.environment.refresh',
        category: CATEGORY,
        label: 'Refresh Environment Status'
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

    export const SHOW_DIAGNOSTICS: Command = {
        id: 'openmc.environment.showDiagnostics',
        category: CATEGORY,
        label: 'Show Diagnostics'
    };
}

@injectable()
export class EnvironmentCommands {
    
    @inject(MessageService)
    protected readonly messageService: MessageService;
    
    @inject(QuickPickService)
    protected readonly quickPick: QuickPickService;
    
    @inject(OpenMCEnvironmentService)
    protected readonly envService: OpenMCEnvironmentService;
    
    @inject(OpenMCHealthService)
    protected readonly healthService: OpenMCHealthService;
    
    @inject(OpenMCInstallerService)
    protected readonly installerService: OpenMCInstallerService;

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(OpenMCEnvironmentCommands.CHECK_HEALTH, {
            execute: () => this.checkHealth()
        });
        
        registry.registerCommand(OpenMCEnvironmentCommands.SWITCH_ENVIRONMENT, {
            execute: () => this.switchEnvironment()
        });
        
        registry.registerCommand(OpenMCEnvironmentCommands.REFRESH_ENVIRONMENT, {
            execute: () => this.refreshEnvironment()
        });
        
        registry.registerCommand(OpenMCEnvironmentCommands.INSTALL_OPENMC, {
            execute: () => this.installOpenMC()
        });
        
        registry.registerCommand(OpenMCEnvironmentCommands.INSTALL_DAGMC, {
            execute: () => this.installDAGMC()
        });
        
        registry.registerCommand(OpenMCEnvironmentCommands.SHOW_DIAGNOSTICS, {
            execute: () => this.showDiagnostics()
        });
    }

    private async checkHealth(): Promise<void> {
        this.messageService.info('Running health check...');

        const result = await this.healthService.runHealthCheck();

        // Show summary
        const { errors, warnings, info } = result.summary;
        if (result.ready) {
            if (warnings === 0 && info === 0) {
                this.messageService.info('✓ OpenMC environment is fully healthy');
            } else {
                this.messageService.info(
                    `✓ OpenMC ready (${errors} errors, ${warnings} warnings, ${info} info)`
                );
            }
        } else {
            this.messageService.error(
                `✗ OpenMC not ready (${errors} errors, ${warnings} warnings)`
            );

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

        // Log issues to console for detailed view
        console.log('[OpenMC Health Check] Results:');
        result.issues.forEach(issue => {
            const icon = issue.severity === 'error' ? '✗' : issue.severity === 'warning' ? '⚠' : 'ℹ';
            console.log(`${icon} [${issue.category}] ${issue.message}`);
            if (issue.suggestion) {
                console.log(`   → ${issue.suggestion}`);
            }
        });
    }

    private async switchEnvironment(): Promise<void> {
        const envs = await this.envService.listOpenMCEnvironments();
        
        if (envs.length === 0) {
            this.messageService.error('No environments with OpenMC found');
            return;
        }
        
        const items = envs.map(env => ({
            label: env.name,
            description: env.openmcVersion ? `OpenMC ${env.openmcVersion}` : undefined,
            detail: env.pythonPath,
            value: env
        }));
        
        const selected = await this.quickPick.show(items, {
            placeholder: 'Select environment to switch to'
        });
        
        if (selected) {
            await this.envService.switchToEnvironment(selected.value);
        }
    }

    private async refreshEnvironment(): Promise<void> {
        await this.envService.refreshStatus();
        const status = this.envService.getStatus();

        if (status.ready) {
            this.messageService.info(
                `Environment refreshed: ${status.environment?.name}${status.openmcVersion ? ` (OpenMC ${status.openmcVersion})` : ''}`
            );
        } else {
            // Try to offer installation if OpenMC is missing in the configured env
            const ensureResult = await this.envService.ensureOpenMC();
            if (!ensureResult.success && ensureResult.installed === undefined) {
                // No configured env at all — show generic warning
                this.messageService.warn('No OpenMC environment found. Configure a Python environment first.');
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

    private async showDiagnostics(): Promise<void> {
        // Get diagnostics from nuke-core
        const status = this.envService.getStatus();
        
        if (status.ready && status.environment) {
            this.messageService.info(
                `OpenMC: ${status.environment.name} (${status.openmcVersion || 'unknown'})`,
                { timeout: 5000 }
            );
        } else {
            this.messageService.error(
                status.error || 'OpenMC environment not configured',
                { timeout: 5000 }
            );
        }
    }
}
