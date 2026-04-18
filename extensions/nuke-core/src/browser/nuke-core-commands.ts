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

import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, MenuContribution, MenuModelRegistry } from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';
import { QuickPickService } from '@theia/core/lib/browser/quick-input';
import { OutputChannelManager, OutputChannel } from '@theia/output/lib/browser/output-channel';
import { NukeCoreService } from './services/nuke-core-service';
import { PythonEnvironment } from '../common/nuke-core-protocol';
import { NukeMenus } from './nuke-core-menus';

export namespace NukeCoreCommands {
    export const HEALTH_CHECK = {
        id: 'nuke.core.healthCheck',
        label: 'Nuke: Run Health Check'
    };
    
    export const DIAGNOSTICS = {
        id: 'nuke.core.diagnostics',
        label: 'Nuke: Show Diagnostics'
    };
    
    export const VALIDATE_CONFIG = {
        id: 'nuke.core.validateConfig',
        label: 'Nuke: Validate Configuration'
    };
    
    export const SWITCH_ENVIRONMENT = {
        id: 'nuke.core.switchEnvironment',
        label: 'Nuke: Switch Environment'
    };
    
    export const INSTALL_PACKAGE = {
        id: 'nuke.core.installPackage',
        label: 'Nuke: Install Package'
    };
}

@injectable()
export class NukeCoreCommandContribution implements CommandContribution, MenuContribution {
    
    @inject(NukeCoreService)
    protected readonly nukeCore: NukeCoreService;
    
    @inject(MessageService)
    protected readonly messageService: MessageService;
    
    @inject(QuickPickService)
    protected readonly quickPick: QuickPickService;
    
    @inject(OutputChannelManager)
    protected readonly outputManager: OutputChannelManager;

    private outputChannel?: OutputChannel;

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(NukeCoreCommands.HEALTH_CHECK, {
            execute: () => this.runHealthCheck()
        });

        commands.registerCommand(NukeCoreCommands.DIAGNOSTICS, {
            execute: () => this.showDiagnostics()
        });

        commands.registerCommand(NukeCoreCommands.VALIDATE_CONFIG, {
            execute: () => this.validateConfig()
        });

        commands.registerCommand(NukeCoreCommands.SWITCH_ENVIRONMENT, {
            execute: () => this.switchEnvironment()
        });

        commands.registerCommand(NukeCoreCommands.INSTALL_PACKAGE, {
            execute: () => this.installPackage()
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        // Add commands to Tools menu
        menus.registerMenuAction(NukeMenus.TOOLS, {
            commandId: NukeCoreCommands.SWITCH_ENVIRONMENT.id,
            label: 'Switch Environment',
            order: 'a'
        });

        menus.registerMenuAction(NukeMenus.TOOLS, {
            commandId: NukeCoreCommands.INSTALL_PACKAGE.id,
            label: 'Install Package',
            order: 'b'
        });

        menus.registerMenuAction(NukeMenus.TOOLS, {
            commandId: NukeCoreCommands.HEALTH_CHECK.id,
            label: 'Run Health Check',
            order: 'c'
        });

        menus.registerMenuAction(NukeMenus.TOOLS, {
            commandId: NukeCoreCommands.VALIDATE_CONFIG.id,
            label: 'Validate Configuration',
            order: 'd'
        });

        menus.registerMenuAction(NukeMenus.TOOLS, {
            commandId: NukeCoreCommands.DIAGNOSTICS.id,
            label: 'Show Diagnostics',
            order: 'e'
        });
    }

    protected async runHealthCheck(): Promise<void> {
        this.messageService.info('Running health check...', { timeout: 2000 });
        
        try {
            const result = await this.nukeCore.healthCheck();
            
            const lines: string[] = ['=== Nuke Core Health Check ===\n'];
            
            for (const check of result.checks) {
                const icon = check.passed ? '✓' : check.severity === 'error' ? '✗' : '⚠';
                lines.push(`${icon} ${check.name}: ${check.message}`);
                if (check.suggestion) {
                    lines.push(`  → ${check.suggestion}`);
                }
            }
            
            lines.push('');
            lines.push(result.healthy ? '✓ Overall: Healthy' : '✗ Overall: Issues Found');
            
            this.showOutput('Health Check', lines.join('\n'));
            
            if (result.healthy) {
                this.messageService.info('Health check passed!');
            } else {
                this.messageService.warn('Health check found issues. See output for details.');
            }
        } catch (error) {
            this.messageService.error(`Health check failed: ${error}`);
        }
    }

    protected async showDiagnostics(): Promise<void> {
        try {
            const diagnostics = await this.nukeCore.getDiagnostics();
            const formatted = JSON.stringify(diagnostics, null, 2);
            this.showOutput('Diagnostics', formatted);
            this.messageService.info('Diagnostics displayed in output panel');
        } catch (error) {
            this.messageService.error(`Failed to get diagnostics: ${error}`);
        }
    }

    protected async validateConfig(): Promise<void> {
        try {
            const result = await this.nukeCore.validateConfig();
            
            const lines: string[] = ['=== Configuration Validation ===\n'];
            
            if (result.errors.length === 0 && result.warnings.length === 0) {
                lines.push('✓ Configuration is valid!');
            } else {
                for (const error of result.errors) {
                    lines.push(`✗ Error - ${error.field}: ${error.message}`);
                    if (error.value) {
                        lines.push(`  Current value: ${error.value}`);
                    }
                }
                
                for (const warning of result.warnings) {
                    lines.push(`⚠ Warning - ${warning.field}: ${warning.message}`);
                    if (warning.value) {
                        lines.push(`  Current value: ${warning.value}`);
                    }
                }
            }
            
            this.showOutput('Configuration Validation', lines.join('\n'));
            
            if (result.valid) {
                this.messageService.info('Configuration is valid!');
            } else {
                this.messageService.error('Configuration has errors. See output for details.');
            }
        } catch (error) {
            this.messageService.error(`Validation failed: ${error}`);
        }
    }

    protected async switchEnvironment(): Promise<void> {
        try {
            const environments = await this.nukeCore.listEnvironments(true);
            const current = await this.nukeCore.getSelectedEnvironment();

            if (environments.length === 0) {
                this.messageService.warn('No Python environments found. Please configure one in Settings.');
                return;
            }

            const items = environments.map(env => ({
                label: `${env.type === 'conda' ? '🐍' : env.type === 'system' ? '🐧' : '📦'} ${env.name}`,
                description: env.version || '',
                detail: env.pythonPath,
                value: env,
                picked: current?.pythonPath === env.pythonPath
            }));

            const selected = await this.quickPick.show(items, {
                placeholder: 'Select Python Environment'
            });

            // Type guard to check if selected is an environment item
            if (selected && 'value' in selected && selected.value && typeof selected.value === 'object') {
                const env = selected.value as PythonEnvironment;
                await this.nukeCore.switchToEnvironment(env);
                this.messageService.info(`Switched to ${env.name}`);
            }
        } catch (error) {
            this.messageService.error(`Failed to switch environment: ${error}`);
        }
    }

    protected async installPackage(): Promise<void> {
        // Use native prompt for simple text input
        const packageName = prompt('Enter package name(s) to install (e.g., "openmc" or "numpy pandas"):');

        if (!packageName || !packageName.trim()) {
            return;
        }

        const packages = packageName.trim().split(/\s+/);
        
        this.messageService.info(`Installing ${packages.join(', ')}...`);
        
        try {
            const result = await this.nukeCore.installPackages({ packages });
            
            if (result.success) {
                this.messageService.info(`Successfully installed: ${result.installed.join(', ')}`);
            } else {
                const failed = result.failed.length > 0 ? result.failed : packages;
                this.messageService.error(`Failed to install: ${failed.join(', ')}`);
                if (result.output) {
                    this.showOutput('Installation Output', result.output);
                }
            }
        } catch (error) {
            this.messageService.error(`Installation failed: ${error}`);
        }
    }

    protected showOutput(title: string, content: string): void {
        if (!this.outputChannel) {
            this.outputChannel = this.outputManager.getChannel('Nuke Core');
        }
        this.outputChannel.clear();
        this.outputChannel.appendLine(content);
        this.outputChannel.show();
    }
}
