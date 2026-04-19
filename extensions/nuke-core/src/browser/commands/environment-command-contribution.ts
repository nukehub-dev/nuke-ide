// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * Environment Command Contribution
 *
 * Commands: Switch Environment, Create Environment, Delete Environment, Environment Actions
 *
 * @module nuke-core/browser/commands
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, MenuContribution, MenuModelRegistry } from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';
import { QuickPickService, QuickInputService } from '@theia/core/lib/browser/quick-input';
import { QuickPickItem, QuickPickSeparator } from '@theia/core/lib/common/quick-pick-service';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { EnvironmentActionsHelper, NukeCoreService } from '../services';
import { NukeEnvironment } from '../../common/nuke-core-protocol';
import { NukeCoreCommands } from './index';
import { NukeMenus } from '../nuke-core-menus';

@injectable()
export class NukeEnvironmentCommandContribution implements CommandContribution, MenuContribution {

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

    @inject(EnvironmentActionsHelper)
    protected readonly envActions: EnvironmentActionsHelper;

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(NukeCoreCommands.SWITCH_ENVIRONMENT, {
            execute: () => this.switchEnvironment()
        });

        commands.registerCommand(NukeCoreCommands.CREATE_ENVIRONMENT, {
            execute: () => this.createEnvironment()
        });

        commands.registerCommand(NukeCoreCommands.DELETE_ENVIRONMENT, {
            execute: () => this.deleteEnvironment()
        });

        commands.registerCommand(NukeCoreCommands.ENVIRONMENT_ACTIONS, {
            execute: () => this.environmentActions()
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(NukeMenus.TOOLS, {
            commandId: NukeCoreCommands.SWITCH_ENVIRONMENT.id,
            label: 'Switch Environment',
            order: 'a'
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
            commandId: NukeCoreCommands.DELETE_ENVIRONMENT.id,
            label: 'Delete Environment',
            order: 'b4'
        });
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

            const items = this.buildEnvironmentPickerItems(environments, current, true);
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
            await this.envActions.showEnvActions(env);
        } catch (error) {
            this.messageService.error(`Failed to open environment actions: ${error}`);
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

            const args = this.envActions.parseCommandString(cmdInfo.command);
            await terminal.executeCommand({ cwd: cmdInfo.cwd, args });

            this.messageService.info(`Creating ${envType} environment '${name}' in terminal...`);

            await this.envActions.waitForTerminal(terminal);

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

    protected async deleteEnvironment(): Promise<void> {
        try {
            const environments = await this.nukeCore.listEnvironments(true);
            const current = await this.nukeCore.getSelectedEnvironment();

            if (environments.length === 0) {
                this.messageService.warn('No Python environments found.');
                return;
            }

            const items = this.buildEnvironmentPickerItems(environments, current, false);
            const selected = await this.quickPick.show(items, {
                placeholder: 'Select environment to delete'
            });

            if (!selected || !('value' in selected)) {
                return;
            }

            const value = selected.value;
            if (value === '__create__' || value === '__refresh__') {
                return;
            }

            const env = value as NukeEnvironment;

            // Type-to-confirm safety
            const confirmInput = await this.quickInput.input({
                prompt: `Type "${env.name}" to confirm deletion. This cannot be undone.`,
                placeHolder: env.name
            });

            if (confirmInput !== env.name) {
                this.messageService.info('Deletion cancelled.');
                return;
            }

            this.messageService.info(`Deleting ${env.name}...`);
            const result = await this.nukeCore.deleteEnvironment(env);

            if (result.success) {
                this.messageService.info(`Environment '${env.name}' deleted.`);
            } else {
                this.messageService.error(`Failed to delete '${env.name}': ${result.error}`);
            }
        } catch (error) {
            this.messageService.error(`Failed to delete environment: ${error}`);
        }
    }

    protected buildEnvironmentPickerItems(
        environments: NukeEnvironment[],
        current?: NukeEnvironment,
        includeActions = true
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
                items.push({
                    label: `${activeBadge}${icon} ${env.name}`,
                    description: env.version || '',
                    detail: env.pythonPath,
                    value: env
                });
            }
        };

        addGroup('Conda Environments', condaEnvs, '🐍');
        addGroup('Virtual Environments', venvEnvs, '📦');
        addGroup('Other', otherEnvs, '🐧');

        if (includeActions) {
            items.push({ type: 'separator', label: 'Actions' } as QuickPickSeparator);
            items.push({ label: '➕ Create new environment', value: '__create__' });
            items.push({ label: '🔄 Refresh environments', value: '__refresh__' });
        }

        return items;
    }
}
