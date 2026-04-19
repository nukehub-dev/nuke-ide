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
import { QuickPickService, QuickInputService } from '@theia/core/lib/browser/quick-input';
import { OutputChannelManager, OutputChannel } from '@theia/output/lib/browser/output-channel';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import { TerminalWidget } from '@theia/terminal/lib/browser/base/terminal-widget';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { NukeCoreService } from './services/nuke-core-service';
import { NukeEnvironment } from '../common/nuke-core-protocol';
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

    export const CREATE_ENVIRONMENT = {
        id: 'nuke.core.createEnvironment',
        label: 'Nuke: Create Environment'
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

    @inject(QuickInputService)
    protected readonly quickInput: QuickInputService;

    @inject(TerminalService)
    protected readonly terminalService: TerminalService;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;
    
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

        commands.registerCommand(NukeCoreCommands.CREATE_ENVIRONMENT, {
            execute: () => this.createEnvironment()
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
            commandId: NukeCoreCommands.CREATE_ENVIRONMENT.id,
            label: 'Create Environment',
            order: 'b2'
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
                placeholder: 'Select Nuke Environment'
            });

            // Type guard to check if selected is an environment item
            if (selected && 'value' in selected && selected.value && typeof selected.value === 'object') {
                const env = selected.value as NukeEnvironment;
                await this.nukeCore.switchToEnvironment(env);
                this.messageService.info(`Switched to ${env.name}`);
            }
        } catch (error) {
            this.messageService.error(`Failed to switch environment: ${error}`);
        }
    }

    protected async installPackage(): Promise<void> {
        const packageName = await this.quickInput.input({
            prompt: 'Enter package name(s) to install',
            placeHolder: 'e.g., openmc or numpy pandas'
        });

        if (!packageName || !packageName.trim()) {
            return;
        }

        const packages = packageName.trim().split(/\s+/);

        // Ask user which package manager to use
        const managerItems = [
            { label: '📦 pip / uv', description: 'Install with pip (or uv if available)', value: 'pip' as const },
            { label: '🐍 conda / mamba', description: 'Install with conda-forge', value: 'conda' as const }
        ];

        const managerSelected = await this.quickPick.show(managerItems, {
            placeholder: 'Select package manager'
        });

        if (!managerSelected || !('value' in managerSelected)) {
            return;
        }
        const useConda = managerSelected.value === 'conda';

        try {
            const roots = await this.workspaceService.roots;
            const workspaceRoot = roots[0]?.resource?.path?.toString() || '';
            const cmdInfo = await this.nukeCore.prepareInstallPackagesCommand({ packages, useConda, cwd: workspaceRoot });

            const terminal = await this.terminalService.newTerminal({
                title: `Install: ${packages.join(', ')}`,
                cwd: cmdInfo.cwd
            });
            await terminal.start();
            this.terminalService.open(terminal, { mode: 'reveal' });

            const args = this.parseCommandString(cmdInfo.command);
            await terminal.executeCommand({ cwd: cmdInfo.cwd, args });

            this.messageService.info(`Installing ${packages.join(', ')} with ${useConda ? 'conda' : 'pip'} in terminal...`);

            await this.waitForTerminal(terminal);

            const status = terminal.exitStatus;
            if (status && status.code === 0) {
                this.messageService.info(`Successfully installed: ${packages.join(', ')}`);
            } else {
                this.messageService.warn(
                    `Package installation may have failed or produced warnings. Check the terminal for details.`
                );
            }
        } catch (error) {
            this.messageService.error(`Installation failed: ${error}`);
        }
    }

    protected async createEnvironment(): Promise<void> {
        try {
            // Step 1: Choose environment type
            const typeItems = [
                { label: '🐍 Conda Environment', description: 'Create a conda/mamba environment', value: 'conda' as const },
                { label: '📦 Virtualenv (venv)', description: 'Create a Python venv in the workspace', value: 'venv' as const }
            ];

            const typeSelected = await this.quickPick.show(typeItems, {
                placeholder: 'Select environment type'
            });

            if (!typeSelected || !('value' in typeSelected)) {
                return;
            }
            const envType = typeSelected.value as 'conda' | 'venv';

            // Step 2: Enter environment name
            const envName = await this.quickInput.input({
                prompt: `Enter ${envType} environment name`,
                placeHolder: 'e.g., myproject'
            });
            if (!envName || !envName.trim()) {
                return;
            }
            const name = envName.trim();

            // Step 3: Optional Python specifier
            let pythonSpecifier: string | undefined;
            if (envType === 'conda') {
                pythonSpecifier = await this.quickInput.input({
                    prompt: 'Python version (optional)',
                    placeHolder: 'e.g., 3.14 (leave empty for default)'
                }) || undefined;
            } else {
                pythonSpecifier = await this.quickInput.input({
                    prompt: 'Python executable path (optional)',
                    placeHolder: 'e.g., /usr/bin/python3 (leave empty for python3)'
                }) || undefined;
            }

            // Get workspace root for env creation
            const roots = await this.workspaceService.roots;
            const workspaceRoot = roots[0]?.resource?.path?.toString() || '';

            // Get the command from backend
            const cmdInfo = await this.nukeCore.prepareCreateEnvironmentCommand({
                type: envType,
                name,
                pythonSpecifier,
                cwd: envType === 'venv' ? workspaceRoot : undefined
            });

            // Create and open a terminal for live output
            const terminal = await this.terminalService.newTerminal({
                title: `Create ${envType} env: ${name}`,
                cwd: cmdInfo.cwd
            });
            await terminal.start();
            this.terminalService.open(terminal, { mode: 'reveal' });

            // Parse the command string into args for executeCommand
            // The command string from backend is already quoted properly, e.g.:
            // "/opt/miniforge3/condabin/mamba" create --prefix ~/.nuke-ide/envs/nuke python -y
            // We use a simple split approach; the shell command builder will handle escaping
            const args = this.parseCommandString(cmdInfo.command);
            await terminal.executeCommand({ cwd: cmdInfo.cwd, args });

            this.messageService.info(`Creating ${envType} environment '${name}' in terminal...`);

            // Poll for terminal completion
            await this.waitForTerminal(terminal);

            // After terminal closes or process exits, try to detect the new environment
            const envs = await this.nukeCore.listEnvironments(true);
            const newEnv = envs.find(e => e.pythonPath === cmdInfo.expectedPythonPath);

            if (newEnv) {
                const switchAction = await this.messageService.info(
                    `${envType} environment '${name}' created!`,
                    'Switch environment',
                    'Dismiss'
                );
                if (switchAction === 'Switch environment') {
                    await this.nukeCore.switchToEnvironment(newEnv);
                }
            } else {
                this.messageService.warn(
                    `Environment creation may still be in progress, or the new environment was not detected. ` +
                    `Check the terminal for details.`,
                    'Refresh Environments'
                );
            }
        } catch (error) {
            const errMsg = String((error as Error)?.message || error);
            const match = errMsg.match(/ALREADY_EXISTS: Environment '(.+?)'/);
            const existingName = match ? match[1] : '';

            if (existingName) {
                // Environment already exists — offer to switch to it
                const envs = await this.nukeCore.listEnvironments(true);
                const foundEnv = envs.find(e => e.name === existingName || e.name === `${existingName} (workspace)`);
                if (foundEnv) {
                    const action = await this.messageService.warn(
                        `Environment '${existingName}' already exists.`,
                        'Switch environment',
                        'Dismiss'
                    );
                    if (action === 'Switch environment') {
                        await this.nukeCore.switchToEnvironment(foundEnv);
                    }
                } else {
                    this.messageService.warn(`Environment '${existingName}' already exists.`);
                }
            } else {
                this.messageService.error(`Environment creation failed: ${error}`);
            }
        }
    }

    private parseCommandString(command: string): string[] {
        // Very simple parser: split on spaces, respecting double quotes
        const args: string[] = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < command.length; i++) {
            const char = command[i];
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ' ' && !inQuotes) {
                if (current) {
                    args.push(current);
                    current = '';
                }
            } else {
                current += char;
            }
        }
        if (current) {
            args.push(current);
        }
        return args;
    }

    private async waitForTerminal(terminal: TerminalWidget): Promise<void> {
        return new Promise(resolve => {
            const maxWait = 10 * 60 * 1000; // 10 minutes max
            const interval = 1000;
            let elapsed = 0;

            const check = setInterval(() => {
                elapsed += interval;
                const status = terminal.exitStatus;
                if (status || elapsed >= maxWait) {
                    clearInterval(check);
                    resolve();
                }
            }, interval);
        });
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
