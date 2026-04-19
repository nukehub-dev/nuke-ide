// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * Workspace Environment File Contribution
 *
 * Auto-detects environment.yml / requirements.txt in the workspace and
 * offers to set up the Python environment accordingly.
 *
 * @module nuke-core/browser
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { MessageService } from '@theia/core/lib/common';
import { CommandService } from '@theia/core/lib/common/command';
import { CommonCommands } from '@theia/core/lib/browser/common-commands';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import { TerminalWidget } from '@theia/terminal/lib/browser/base/terminal-widget';
import URI from '@theia/core/lib/common/uri';
import { NukeCoreService } from '../services/nuke-core-service';

export interface EnvFileInfo {
    type: 'conda-yml' | 'requirements-txt';
    uri: URI;
    name: string;
}

@injectable()
export class WorkspaceEnvContribution implements FrontendApplicationContribution {

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(NukeCoreService)
    protected readonly nukeCore: NukeCoreService;

    @inject(TerminalService)
    protected readonly terminalService: TerminalService;

    @inject(CommandService)
    protected readonly commandService: CommandService;

    @inject(WindowService)
    protected readonly windowService: WindowService;

    /** Track which specific files we've already suggested, so we don't spam. */
    private notifiedFiles = new Set<string>();

    async onStart(): Promise<void> {
        // Initial scan after workspace has loaded
        setTimeout(() => this.scanWorkspace(), 3000);

        // Re-scan whenever the workspace changes (user opens a different folder)
        this.workspaceService.onWorkspaceChanged(() => {
            this.scanWorkspace();
        });
    }

    private async scanWorkspace(): Promise<void> {
        try {
            const envFiles = await this.findEnvFiles();
            // Filter out files we've already notified about
            const newFiles = envFiles.filter(f => !this.notifiedFiles.has(f.uri.toString()));
            if (newFiles.length === 0) {
                return;
            }

            // Only prompt if no environment is currently configured
            const config = await this.nukeCore.getConfig();
            if (config.pythonPath || config.condaEnv) {
                return;
            }

            // Mark all found files as notified so we don't re-prompt
            for (const f of envFiles) {
                this.notifiedFiles.add(f.uri.toString());
            }

            const condaYml = newFiles.find(f => f.type === 'conda-yml');
            const reqTxt = newFiles.find(f => f.type === 'requirements-txt');

            if (condaYml && reqTxt) {
                const action = await this.messageService.info(
                    `Found environment files in workspace: ${condaYml.name} and ${reqTxt.name}. Set up a Python environment?`,
                    'Create from environment.yml',
                    'Install requirements.txt',
                    'Dismiss'
                );
                if (action === 'Create from environment.yml') {
                    await this.setupFromCondaYml(condaYml);
                } else if (action === 'Install requirements.txt') {
                    await this.setupFromRequirementsTxt(reqTxt);
                }
            } else if (condaYml) {
                const action = await this.messageService.info(
                    `Found ${condaYml.name} in workspace. Create a conda environment from it?`,
                    'Create Environment',
                    'Dismiss'
                );
                if (action === 'Create Environment') {
                    await this.setupFromCondaYml(condaYml);
                }
            } else if (reqTxt) {
                const action = await this.messageService.info(
                    `Found ${reqTxt.name} in workspace. Install dependencies?`,
                    'Install with pip',
                    'Dismiss'
                );
                if (action === 'Install with pip') {
                    await this.setupFromRequirementsTxt(reqTxt);
                }
            }
        } catch (error) {
            console.error('[NukeCore] Error scanning workspace for env files:', error);
        }
    }

    private async findEnvFiles(): Promise<EnvFileInfo[]> {
        const files: EnvFileInfo[] = [];
        const roots = await this.workspaceService.roots;

        for (const root of roots) {
            const rootUri = root.resource;

            const candidates = [
                { uri: rootUri.resolve('environment.yml'), type: 'conda-yml' as const, name: 'environment.yml' },
                { uri: rootUri.resolve('environment.yaml'), type: 'conda-yml' as const, name: 'environment.yaml' },
                { uri: rootUri.resolve('requirements.txt'), type: 'requirements-txt' as const, name: 'requirements.txt' },
            ];

            for (const candidate of candidates) {
                try {
                    if (await this.fileService.exists(candidate.uri)) {
                        files.push(candidate);
                    }
                } catch {
                    // Ignore errors for individual files
                }
            }
        }

        return files;
    }

    private async setupFromCondaYml(file: EnvFileInfo): Promise<void> {
        try {
            const condaCmd = await this.nukeCore.getCondaCommand();
            if (!condaCmd) {
                const action = await this.messageService.warn(
                    'No conda or mamba installation found. Please install Miniforge3 to use environment.yml files.',
                    'Open Miniforge Website',
                    'Dismiss'
                );
                if (action === 'Open Miniforge Website') {
                    this.windowService.openNewWindow('https://github.com/conda-forge/miniforge');
                }
                return;
            }

            const roots = await this.workspaceService.roots;
            const workspaceRoot = roots[0]?.resource?.path?.toString() || '';
            const filePath = file.uri.path.fsPath();

            const args = ['env', 'create', '-f', filePath, '-y'];
            const terminal = await this.terminalService.newTerminal({
                title: `Create env from ${file.name}`,
                cwd: workspaceRoot
            });
            await terminal.start();
            this.terminalService.open(terminal, { mode: 'reveal' });
            await terminal.executeCommand({ cwd: workspaceRoot, args: [condaCmd.cmd, ...args] });

            this.messageService.info(`Creating environment from ${file.name} in terminal...`);

            await this.waitForTerminal(terminal);

            const status = terminal.exitStatus;
            if (status && status.code === 0) {
                const action = await this.messageService.info(
                    `Environment created from ${file.name}! Switch to it?`,
                    'Switch Environment',
                    'Dismiss'
                );
                if (action === 'Switch Environment') {
                    // Refresh environments and let user pick
                    const envs = await this.nukeCore.listEnvironments(true);
                    if (envs.length > 0) {
                        await this.nukeCore.switchToEnvironment(envs[0]);
                    }
                }
            } else {
                this.messageService.warn(
                    `Environment creation from ${file.name} may have failed. Check the terminal for details.`
                );
            }
        } catch (error) {
            console.error('[NukeCore] Error setting up from conda yml:', error);
            this.messageService.error(`Failed to create environment from ${file.name}: ${error}`);
        }
    }

    private async setupFromRequirementsTxt(file: EnvFileInfo): Promise<void> {
        try {
            const python = await this.nukeCore.detectPython();
            if (!python.success || !python.command) {
                const action = await this.messageService.warn(
                    'No Python environment detected. Please configure one in Settings → Nuke Utils first.',
                    'Open Settings'
                );
                if (action === 'Open Settings') {
                    this.commandService.executeCommand(CommonCommands.OPEN_PREFERENCES.id, 'nuke.');
                }
                return;
            }

            const roots = await this.workspaceService.roots;
            const workspaceRoot = roots[0]?.resource?.path?.toString() || '';
            const filePath = file.uri.path.fsPath();

            const args = ['-m', 'pip', 'install', '-r', filePath];
            const terminal = await this.terminalService.newTerminal({
                title: `Install from ${file.name}`,
                cwd: workspaceRoot
            });
            await terminal.start();
            this.terminalService.open(terminal, { mode: 'reveal' });
            await terminal.executeCommand({ cwd: workspaceRoot, args: [python.command, ...args] });

            this.messageService.info(`Installing dependencies from ${file.name} in terminal...`);

            await this.waitForTerminal(terminal);

            const status = terminal.exitStatus;
            if (status && status.code === 0) {
                this.messageService.info(`Dependencies from ${file.name} installed successfully!`);
            } else {
                this.messageService.warn(
                    `Installation from ${file.name} may have failed or produced warnings. Check the terminal for details.`
                );
            }
        } catch (error) {
            console.error('[NukeCore] Error setting up from requirements.txt:', error);
            this.messageService.error(`Failed to install from ${file.name}: ${error}`);
        }
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
}
