// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * Environment Actions Helper
 *
 * Shared action logic for environment management (terminal, install, copy path).
 * Used by both the status bar contribution and the command contribution.
 *
 * @module nuke-core/browser
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { QuickPickService, QuickInputService } from '@theia/core/lib/browser/quick-input';
import { MessageService } from '@theia/core/lib/common/message-service';
import { OS } from '@theia/core/lib/common/os';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import { TerminalWidget } from '@theia/terminal/lib/browser/base/terminal-widget';
import { NukeCoreService } from './nuke-core-service';
import { NukeEnvironment } from '../../common/nuke-core-protocol';

@injectable()
export class EnvironmentActionsHelper {

    @inject(TerminalService)
    protected readonly terminalService: TerminalService;

    @inject(QuickPickService)
    protected readonly quickPick: QuickPickService;

    @inject(QuickInputService)
    protected readonly quickInput: QuickInputService;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(NukeCoreService)
    protected readonly nukeCore: NukeCoreService;

    /**
     * Show a quick-pick menu of actions for a given environment.
     */
    async showEnvActions(env: NukeEnvironment): Promise<void> {
        const isConda = env.type === 'conda';
        const actionItems = [
            { label: `🔄 Re-select ${env.name}`, value: 'switch' as const },
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

    /**
     * Open a terminal with the environment activated (conda/mamba run).
     */
    async openEnvTerminal(env: NukeEnvironment): Promise<void> {
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
                const shellCommand = isWindows ? 'cmd.exe /k' : '$SHELL';
                terminal.sendText(
                    `mamba run --prefix "${env.envPath}" ${shellCommand} || conda run --prefix "${env.envPath}" ${shellCommand}${eol}`
                );
            }
        } catch (error) {
            this.messageService.error(`Failed to open terminal: ${error}`);
        }
    }

    /**
     * Install packages in the specified environment via live terminal.
     */
    async installPackageForEnv(env: NukeEnvironment): Promise<void> {
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

    /**
     * Very simple parser: split on spaces, respecting double quotes.
     */
    parseCommandString(command: string): string[] {
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

    /**
     * Poll until the terminal process exits (or 10-minute timeout).
     */
    async waitForTerminal(terminal: TerminalWidget): Promise<void> {
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
}
