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
import { NukeEnvironment, PackageDependency } from '../../common/nuke-core-protocol';

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
     * Run an arbitrary command in a live terminal.
     * Returns true on success (exit code 0).
     */
    async runCommandInTerminal(options: {
        title: string;
        cwd: string;
        args: string[];
    }): Promise<boolean> {
        const terminal = await this.terminalService.newTerminal({
            title: options.title,
            cwd: options.cwd
        });
        await terminal.start();
        this.terminalService.open(terminal, { mode: 'reveal' });
        await terminal.executeCommand({ cwd: options.cwd, args: options.args });

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
     * Unified package install into the configured (or explicit) environment.
     * Resolves workspace CWD, prepares the command, runs in a live terminal,
     * and returns success/failure. Extensions should prefer this over
     * calling prepareInstallPackagesCommand + runCommandInTerminal manually.
     */
    async installPackages(options: {
        packages: string[];
        title?: string;
        useConda?: boolean;
        channels?: string[];
        extraIndexUrl?: string;
        pythonPath?: string;
        cwd?: string;
    }): Promise<{ success: boolean; message: string }> {
        const {
            packages,
            title = `Install: ${packages.join(', ')}`,
            useConda = false,
            channels,
            extraIndexUrl,
            pythonPath: explicitPythonPath,
            cwd: explicitCwd
        } = options;

        // Resolve CWD: explicit > workspace root > process.cwd()
        let cwd = explicitCwd;
        if (!cwd) {
            const roots = await this.workspaceService.roots;
            cwd = roots[0]?.resource?.path?.toString() || '';
        }

        // Resolve target python: explicit > configured env > fallback detected
        let pythonPath = explicitPythonPath;
        if (!pythonPath) {
            const config = await this.nukeCore.getConfig();
            const selectedEnv = await this.nukeCore.getSelectedEnvironment();
            if (selectedEnv && (
                (config.condaEnv && selectedEnv.name === config.condaEnv) ||
                (config.pythonPath && selectedEnv.pythonPath === config.pythonPath)
            )) {
                pythonPath = selectedEnv.pythonPath;
            } else if (config.pythonPath) {
                pythonPath = config.pythonPath;
            }
        }

        try {
            const cmdInfo = await this.nukeCore.prepareInstallPackagesCommand({
                packages,
                useConda,
                channels,
                extraIndexUrl,
                pythonPath,
                cwd
            });

            const success = await this.runCommandInTerminal({
                title,
                cwd: cmdInfo.cwd,
                args: this.parseCommandString(cmdInfo.command)
            });

            if (success) {
                return {
                    success: true,
                    message: `Installed ${packages.join(', ')} successfully`
                };
            }
            return {
                success: false,
                message: 'Installation failed or was cancelled. Check the terminal for details.'
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return { success: false, message: msg };
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

        const useConda = manager.value === 'conda';
        const result = await this.installPackages({
            packages,
            title: `Install in ${env.name}: ${packages.join(', ')}`,
            useConda,
            pythonPath: env.pythonPath
        });

        if (result.success) {
            this.messageService.info(`Installed in ${env.name}: ${packages.join(', ')}`);
        } else {
            this.messageService.warn(result.message);
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
     * Check the configured environment for required packages.
     * If packages are missing, show a notification asking the user
     * whether to install them into the configured environment via a live terminal.
     * Re-checks after installation to verify.
     *
     * Unlike detectPythonWithRequirements(), this checks ONLY the configured
     * environment and never falls back to a different one.
     */
    async ensurePackages(options: {
        requiredPackages: PackageDependency[];
        title?: string;
    }): Promise<{
        success: boolean;
        environment?: NukeEnvironment;
        command?: string;
        missingPackages?: string[];
        installed?: boolean;
    }> {
        const {
            requiredPackages,
            title = 'Install missing dependencies'
        } = options;

        // 1. Get the configured environment only (no fallback discovery)
        const env = await this.nukeCore.getSelectedEnvironment();
        if (!env) {
            return { success: false };
        }

        // 2. Check dependencies in the configured env only
        const check = await this.nukeCore.checkDependencies(requiredPackages, env.pythonPath);
        if (check.available) {
            return { success: true, environment: env, command: env.pythonPath };
        }

        const missing = check.missing ?? [];
        if (missing.length === 0) {
            // Version mismatches or other issues — can't auto-fix
            return { success: false, environment: env, missingPackages: [] };
        }

        const pkgList = missing.join(', ');

        // 3. Prompt user with a notification action
        const action = await this.messageService.warn(
            `Missing packages in ${env.name}: ${pkgList}`,
            'Install'
        );

        if (action !== 'Install') {
            return {
                success: false,
                environment: env,
                missingPackages: missing,
                installed: false
            };
        }

        // 4. Derive install options from the PackageDependency definitions
        const missingDefs = requiredPackages.filter(p => missing.includes(p.name));
        const useConda = missingDefs.some(p => p.condaOnly);
        const channels = [...new Set(missingDefs.flatMap(p => p.channels ?? []))];
        const extraIndexUrl = missingDefs.find(p => p.extraIndexUrl)?.extraIndexUrl;

        // 5. Install missing packages via unified helper
        const installResult = await this.installPackages({
            packages: missing,
            title,
            useConda,
            channels: channels.length > 0 ? channels : undefined,
            extraIndexUrl
        });

        if (!installResult.success) {
            this.messageService.error(`Failed to install: ${installResult.message}`);
            return {
                success: false,
                environment: env,
                missingPackages: missing,
                installed: false
            };
        }

        // 5. Re-check the configured env to verify
        const retry = await this.nukeCore.checkDependencies(requiredPackages, env.pythonPath);
        if (retry.available) {
            this.messageService.info(`Environment ready: ${env.name}`);
        } else {
            this.messageService.warn('Packages were installed but are still reported as missing. Check the terminal for details.');
        }

        return {
            success: retry.available,
            environment: env,
            command: env.pythonPath,
            missingPackages: retry.missing,
            installed: true
        };
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
