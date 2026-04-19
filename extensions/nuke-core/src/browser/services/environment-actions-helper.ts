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
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import URI from '@theia/core/lib/common/uri';
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

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(NukeCoreService)
    protected readonly nukeCore: NukeCoreService;

    /**
     * Show a quick-pick menu of actions for a given environment.
     */
    async showEnvActions(env: NukeEnvironment): Promise<void> {
        const isConda = env.type === 'conda';
        const envFiles = await this.findWorkspaceEnvFiles();

        const actionItems = [
            { label: `🔄 Re-select ${env.name}`, value: 'switch' as const },
            ...(isConda ? [{ label: '🖥 Open Terminal (conda run)', value: 'terminal' as const }] : []),
            { label: '📦 Install Packages', value: 'install' as const },
            ...(isConda && envFiles.condaYml
                ? [{ label: `🔄 Update from ${envFiles.condaYml.path.base}`, value: 'update-conda-yml' as const }]
                : []),
            ...(envFiles.reqTxt
                ? [{ label: `🔄 Update from ${envFiles.reqTxt.path.base}`, value: 'update-req-txt' as const }]
                : []),
            { label: '📋 Copy Python Path', value: 'copy' as const },
            ...(env.isDeletable ? [{ label: '🗑️ Delete Environment', value: 'delete' as const }] : [])
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
            case 'update-conda-yml':
                if (envFiles.condaYml) {
                    await this.updateFromCondaYml(env, envFiles.condaYml);
                }
                break;
            case 'update-req-txt':
                if (envFiles.reqTxt) {
                    await this.updateFromRequirementsTxt(env, envFiles.reqTxt);
                }
                break;
            case 'copy':
                await navigator.clipboard.writeText(env.pythonPath);
                this.messageService.info(`Copied: ${env.pythonPath}`);
                break;
            case 'delete':
                await this.deleteEnvironment(env);
                break;
        }
    }

    private async deleteEnvironment(env: NukeEnvironment): Promise<void> {
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
    }

    private async findWorkspaceEnvFiles(): Promise<{ condaYml?: URI; reqTxt?: URI }> {
        const result: { condaYml?: URI; reqTxt?: URI } = {};
        try {
            const roots = await this.workspaceService.roots;
            const workspaceUri = roots[0]?.resource;
            if (!workspaceUri) {
                return result;
            }

            const candidates = [
                { uri: workspaceUri.resolve('environment.yml'), type: 'condaYml' as const },
                { uri: workspaceUri.resolve('environment.yaml'), type: 'condaYml' as const },
                { uri: workspaceUri.resolve('requirements.txt'), type: 'reqTxt' as const }
            ];

            for (const c of candidates) {
                try {
                    const stat = await this.fileService.resolve(c.uri);
                    if (stat.isFile) {
                        if (c.type === 'condaYml' && !result.condaYml) {
                            result.condaYml = c.uri;
                        } else if (c.type === 'reqTxt' && !result.reqTxt) {
                            result.reqTxt = c.uri;
                        }
                    }
                } catch {
                    // file doesn't exist
                }
            }
        } catch {
            // ignore scan errors
        }
        return result;
    }

    private async updateFromCondaYml(env: NukeEnvironment, uri: URI): Promise<void> {
        try {
            if (!env.envPath) {
                this.messageService.warn('Cannot update: environment path is unknown.');
                return;
            }
            const success = await this.runCondaEnvFromFile(
                'update',
                uri.path.fsPath(),
                env.envPath,
                `Update ${env.name} from ${uri.path.base}`
            );
            if (success) {
                this.messageService.info(`Environment '${env.name}' updated successfully!`);
            } else {
                this.messageService.warn(`Update may have failed. Check the terminal for details.`);
            }
        } catch (error) {
            console.error('[NukeCore] Error updating from conda yml:', error);
            this.messageService.error(`Failed to update from ${uri.path.base}: ${error}`);
        }
    }

    private async updateFromRequirementsTxt(env: NukeEnvironment, uri: URI): Promise<void> {
        try {
            const success = await this.runPipInstallFromFile(
                env.pythonPath,
                uri.path.fsPath(),
                `Update ${env.name} from ${uri.path.base}`
            );
            if (success) {
                this.messageService.info(`Dependencies installed successfully into '${env.name}'!`);
            } else {
                this.messageService.warn(`Installation may have failed. Check the terminal for details.`);
            }
        } catch (error) {
            console.error('[NukeCore] Error updating from requirements.txt:', error);
            this.messageService.error(`Failed to update from ${uri.path.base}: ${error}`);
        }
    }

    /**
     * Run a conda/mamba env create/update from a YAML file in a live terminal.
     * Returns true on success.
     */
    async runCondaEnvFromFile(
        subCommand: 'create' | 'update',
        filePath: string,
        prefix: string,
        title: string
    ): Promise<boolean> {
        const condaCmd = await this.nukeCore.getCondaCommand();
        if (!condaCmd) {
            this.messageService.warn('No conda or mamba found.');
            return false;
        }

        const roots = await this.workspaceService.roots;
        const workspaceRoot = roots[0]?.resource?.path?.toString() || '';

        const args = ['env', subCommand, '-f', filePath, '--prefix', prefix, '-y'];
        const terminal = await this.terminalService.newTerminal({ title, cwd: workspaceRoot });
        await terminal.start();
        this.terminalService.open(terminal, { mode: 'reveal' });
        await terminal.executeCommand({ cwd: workspaceRoot, args: [condaCmd.cmd, ...args] });

        this.messageService.info(`${title} in terminal...`);
        await this.waitForTerminal(terminal);

        const status = terminal.exitStatus;
        if (status && status.code !== undefined) {
            return status.code === 0;
        }
        // No exit status recorded (user likely closed terminal manually) — assume OK
        return true;
    }

    /**
     * Run pip install -r from a requirements file in a live terminal.
     * Returns true on success.
     */
    async runPipInstallFromFile(
        pythonPath: string,
        filePath: string,
        title: string
    ): Promise<boolean> {
        const roots = await this.workspaceService.roots;
        const workspaceRoot = roots[0]?.resource?.path?.toString() || '';

        const args = ['-m', 'pip', 'install', '-r', filePath];
        const terminal = await this.terminalService.newTerminal({ title, cwd: workspaceRoot });
        await terminal.start();
        this.terminalService.open(terminal, { mode: 'reveal' });
        await terminal.executeCommand({ cwd: workspaceRoot, args: [pythonPath, ...args] });

        this.messageService.info(`${title} in terminal...`);
        await this.waitForTerminal(terminal);

        const status = terminal.exitStatus;
        if (status && status.code !== undefined) {
            return status.code === 0;
        }
        // No exit status recorded (user likely closed terminal manually) — assume OK
        return true;
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
            if (!status || status.code === undefined || status.code === 0) {
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
