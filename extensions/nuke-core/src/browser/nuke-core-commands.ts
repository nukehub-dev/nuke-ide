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
import { OS } from '@theia/core/lib/common/os';
import { MessageService } from '@theia/core/lib/common/message-service';
import { QuickPickService, QuickInputService } from '@theia/core/lib/browser/quick-input';
import { QuickPickItem, QuickPickSeparator } from '@theia/core/lib/common/quick-pick-service';
import { OutputChannelManager, OutputChannel } from '@theia/output/lib/browser/output-channel';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import { TerminalWidget } from '@theia/terminal/lib/browser/base/terminal-widget';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
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

    export const ENVIRONMENT_ACTIONS = {
        id: 'nuke.core.environmentActions',
        label: 'Nuke: Environment Actions'
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

    @inject(WindowService)
    protected readonly windowService: WindowService;

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

        commands.registerCommand(NukeCoreCommands.ENVIRONMENT_ACTIONS, {
            execute: () => this.environmentActions()
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
            commandId: NukeCoreCommands.ENVIRONMENT_ACTIONS.id,
            label: 'Environment Actions',
            order: 'b3'
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
                const action = await this.messageService.warn(
                    'No Python environments found.',
                    'Create Environment',
                    'Open Settings'
                );
                if (action === 'Create Environment') {
                    await this.createEnvironment();
                }
                return;
            }

            const items = this.buildEnvironmentPickerItems(environments, current);
            const selected = await this.quickPick.show(items, {
                placeholder: 'Select Nuke Environment'
            });

            if (!selected || !('value' in selected)) {
                return;
            }

            const value = selected.value;
            if (value === '__create__') {
                await this.createEnvironment();
            } else if (value === '__refresh__') {
                await this.switchEnvironment();
            } else if (typeof value === 'object' && value) {
                const env = value as NukeEnvironment;
                await this.nukeCore.switchToEnvironment(env);
                this.messageService.info(`Switched to ${env.name}`);
            }
        } catch (error) {
            this.messageService.error(`Failed to switch environment: ${error}`);
        }
    }

    protected async environmentActions(): Promise<void> {
        try {
            const environments = await this.nukeCore.listEnvironments(true);

            if (environments.length === 0) {
                const action = await this.messageService.warn(
                    'No Python environments found.',
                    'Create Environment',
                    'Open Settings'
                );
                if (action === 'Create Environment') {
                    await this.createEnvironment();
                }
                return;
            }

            const current = await this.nukeCore.getSelectedEnvironment();
            const items = this.buildEnvironmentPickerItems(environments, current);
            const selected = await this.quickPick.show(items, {
                placeholder: 'Select environment for actions'
            });

            if (!selected || !('value' in selected)) {
                return;
            }

            const value = selected.value;
            if (value === '__create__') {
                await this.createEnvironment();
                return;
            } else if (value === '__refresh__') {
                await this.environmentActions();
                return;
            }

            const env = value as NukeEnvironment;
            await this.showEnvironmentActionMenu(env);
        } catch (error) {
            this.messageService.error(`Failed to open environment actions: ${error}`);
        }
    }

    private async showEnvironmentActionMenu(env: NukeEnvironment): Promise<void> {
        const isConda = env.type === 'conda';
        const actionItems = [
            { label: '🔄 Switch to this environment', value: 'switch' as const },
            ...(isConda ? [{ label: '🖥 Open Terminal (conda run)', value: 'terminal' as const }] : []),
            { label: '📦 Install Packages', value: 'install' as const },
            { label: '📋 Copy Python Path', value: 'copy' as const }
        ];

        const action = await this.quickPick.show(actionItems, {
            placeholder: `Actions for ${env.name}`
        });

        if (!action || !('value' in action)) {
            return;
        }

        switch (action.value) {
            case 'switch':
                await this.nukeCore.switchToEnvironment(env);
                this.messageService.info(`Switched to ${env.name}`);
                break;
            case 'terminal':
                await this.openEnvTerminal(env);
                break;
            case 'install':
                await this.installPackageForEnv(env);
                break;
            case 'copy':
                await navigator.clipboard.writeText(env.pythonPath);
                this.messageService.info(`Copied: ${env.pythonPath}`);
                break;
        }
    }

    private async openEnvTerminal(env: NukeEnvironment): Promise<void> {
        try {
            const roots = await this.workspaceService.roots;
            const workspaceRoot = roots[0]?.resource?.path?.toString() || '';

            const terminal = await this.terminalService.newTerminal({
                title: `${env.name}`,
                cwd: workspaceRoot
            });
            await terminal.start();
            this.terminalService.open(terminal, { mode: 'reveal' });

            if (env.type === 'conda' && env.envPath) {
                const isWindows = OS.type() === OS.Type.Windows;
                const eol = isWindows ? '\r\n' : '\n';
                // Use the user's default shell: $SHELL on Unix, cmd.exe on Windows
                const shellCommand = isWindows ? 'cmd.exe /k' : '$SHELL';
                terminal.sendText(
                    `mamba run --prefix "${env.envPath}" ${shellCommand} || conda run --prefix "${env.envPath}" ${shellCommand}${eol}`
                );
            }
        } catch (error) {
            this.messageService.error(`Failed to open terminal: ${error}`);
        }
    }

    private async installPackageForEnv(env: NukeEnvironment): Promise<void> {
        const packageName = await this.quickInput.input({
            prompt: `Install package(s) in ${env.name}`,
            placeHolder: 'e.g., numpy openmc'
        });

        if (!packageName || !packageName.trim()) {
            return;
        }

        const packages = packageName.trim().split(/\s+/);
        const managerItems = [
            { label: '📦 pip / uv', description: 'Install with pip', value: 'pip' as const },
            ...(env.type === 'conda' ? [{ label: '🐍 conda / mamba', description: 'Install with conda-forge', value: 'conda' as const }] : [])
        ];

        const manager = await this.quickPick.show(managerItems, {
            placeholder: 'Select package manager'
        });

        if (!manager || !('value' in manager)) {
            return;
        }

        try {
            const roots = await this.workspaceService.roots;
            const workspaceRoot = roots[0]?.resource?.path?.toString() || '';
            const useConda = manager.value === 'conda';
            const cmdInfo = await this.nukeCore.prepareInstallPackagesCommand({
                packages,
                useConda,
                pythonPath: env.pythonPath,
                cwd: workspaceRoot
            });

            const terminal = await this.terminalService.newTerminal({
                title: `Install in ${env.name}: ${packages.join(', ')}`,
                cwd: cmdInfo.cwd
            });
            await terminal.start();
            this.terminalService.open(terminal, { mode: 'reveal' });

            const args = this.parseCommandString(cmdInfo.command);
            await terminal.executeCommand({ cwd: cmdInfo.cwd, args });

            await this.waitForTerminal(terminal);

            const status = terminal.exitStatus;
            if (status && status.code === 0) {
                this.messageService.info(`Installed in ${env.name}: ${packages.join(', ')}`);
            } else {
                this.messageService.warn(`Check terminal for installation results.`);
            }
        } catch (error) {
            this.messageService.error(`Installation failed: ${error}`);
        }
    }

    private buildEnvironmentPickerItems(
        environments: NukeEnvironment[],
        current?: NukeEnvironment
    ): Array<QuickPickItem & { value?: unknown } | QuickPickSeparator> {
        const condaEnvs = environments.filter(e => e.type === 'conda');
        const venvEnvs = environments.filter(e => e.type === 'venv' || e.type === 'virtualenv');
        const otherEnvs = environments.filter(e => !['conda', 'venv', 'virtualenv'].includes(e.type));

        const items: Array<QuickPickItem & { value?: unknown } | QuickPickSeparator> = [];

        const addGroup = (label: string, envs: NukeEnvironment[], icon: string) => {
            if (envs.length === 0) return;
            items.push({ type: 'separator', label } as QuickPickSeparator);
            for (const env of envs) {
                const isActive = current?.pythonPath === env.pythonPath;
                const activeBadge = isActive ? '✓ ' : '';
                const fallbackBadge = '';
                items.push({
                    label: `${activeBadge}${fallbackBadge}${icon} ${env.name}`,
                    description: env.version || '',
                    detail: env.pythonPath,
                    value: env
                });
            }
        };

        addGroup('Conda Environments', condaEnvs, '🐍');
        addGroup('Virtual Environments', venvEnvs, '📦');
        addGroup('Other', otherEnvs, '🐧');

        items.push({ type: 'separator', label: 'Actions' } as QuickPickSeparator);
        items.push({ label: '➕ Create new environment', value: '__create__' });
        items.push({ label: '🔄 Refresh environments', value: '__refresh__' });

        return items;
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
            } else if (errMsg.includes('No conda or mamba installation found')) {
                const action = await this.messageService.warn(
                    'No conda or mamba installation found. Install Miniforge3 to create conda environments.',
                    'Open Miniforge Website',
                    'Dismiss'
                );
                if (action === 'Open Miniforge Website') {
                    this.windowService.openNewWindow('https://github.com/conda-forge/miniforge');
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
