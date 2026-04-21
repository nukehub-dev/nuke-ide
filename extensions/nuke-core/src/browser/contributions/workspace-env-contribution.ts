// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice,
//    this list of conditions and the following disclaimer.
//
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.
// SPDX-License-Identifier: BSD-2-Clause
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
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import URI from '@theia/core/lib/common/uri';
import { EnvironmentActionsHelper, NukeCoreService } from '../services';

/**
 * Describes a discovered environment definition file in the workspace.
 */
export interface EnvFileInfo {
    type: 'conda-yml' | 'requirements-txt';
    uri: URI;
    name: string;
}

/**
 * Contributes automatic detection of environment files (`environment.yml`, `requirements.txt`)
 * in the workspace and offers to set up the Python environment accordingly.
 *
 * Binds to Theia's {@link FrontendApplicationContribution} lifecycle and rescans whenever
 * the workspace roots change.  Previously-dismissed prompts are persisted in `localStorage`
 * so the user is not spammed on reload.
 *
 * ### DI Bindings
 * - `WorkspaceService` – workspace root access and change events.
 * - `FileService` – file existence checks and content reads.
 * - `MessageService` – confirmation / warning toasts.
 * - `NukeCoreService` – environment detection, configuration and switching.
 * - `CommandService` – opens settings when no Python is configured.
 * - `WindowService` – opens external URLs (e.g. Miniforge download page).
 * - `EnvVariablesServer` – resolves `$HOME` for default install prefix.
 * - `EnvironmentActionsHelper` – runs conda / pip commands in a terminal.
 *
 * @see {@link NukeCoreService}
 * @see {@link EnvironmentActionsHelper}
 */
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

    @inject(CommandService)
    protected readonly commandService: CommandService;

    @inject(WindowService)
    protected readonly windowService: WindowService;

    @inject(EnvVariablesServer)
    protected readonly envVariables: EnvVariablesServer;

    @inject(EnvironmentActionsHelper)
    protected readonly envActions: EnvironmentActionsHelper;

    /** Track which specific files we've already suggested, so we don't spam. */
    private notifiedFiles = new Set<string>();
    private readonly STORAGE_KEY = 'nuke-core:notified-env-files';

    /**
     * Lifecycle hook invoked when the frontend application starts.
     * Restores dismissed-prompt state, schedules an initial scan and listens
     * for future workspace changes.
     */
    async onStart(): Promise<void> {
        // Restore previously-dismissed prompts from localStorage
        this.loadNotifiedFiles();

        // Initial scan after workspace has loaded
        setTimeout(() => this.scanWorkspace(), 3000);

        // Re-scan whenever the workspace changes (user opens a different folder)
        this.workspaceService.onWorkspaceChanged(() => {
            this.scanWorkspace();
        });
    }

    /**
     * Restores the set of previously-notified environment files from `localStorage`.
     */
    private loadNotifiedFiles(): void {
        try {
            const raw = localStorage.getItem(this.STORAGE_KEY);
            if (raw) {
                const arr = JSON.parse(raw) as string[];
                for (const uri of arr) {
                    this.notifiedFiles.add(uri);
                }
            }
        } catch {
            // ignore corrupted storage
        }
    }

    /**
     * Persists the set of dismissed environment files to `localStorage`.
     */
    private saveNotifiedFiles(): void {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify([...this.notifiedFiles]));
        } catch {
            // ignore storage errors
        }
    }

    /**
     * Scans workspace roots for known environment files and prompts the user
     * when new ones are found.  Handles three scenarios:
     * 1. Both `environment.yml` and `requirements.txt` present.
     * 2. Only `environment.yml` present.
     * 3. Only `requirements.txt` present (skipped when no working Python is available).
     *
     * @returns A promise that resolves once scanning and any prompts complete.
     * @see {@link findEnvFiles}
     * @see {@link setupFromCondaYml}
     * @see {@link setupFromRequirementsTxt}
     */
    private async scanWorkspace(): Promise<void> {
        try {
            const envFiles = await this.findEnvFiles();
            // Filter out files we've already notified about
            const newFiles = envFiles.filter(f => !this.notifiedFiles.has(f.uri.toString()));
            if (newFiles.length === 0) {
                return;
            }

            const config = await this.nukeCore.getConfig();
            const hasConfig = !!(config.pythonPath || config.condaEnv);

            // For requirements.txt, we need a working Python. Skip if none available.
            const python = hasConfig ? await this.nukeCore.detectPython() : undefined;
            const hasPython = python?.success ?? false;

            // Determine which files to actually suggest
            const condaYml = newFiles.find(f => f.type === 'conda-yml');
            const reqTxt = newFiles.find(f => f.type === 'requirements-txt');

            // Mark all found files as notified so we don't re-prompt
            for (const f of envFiles) {
                this.notifiedFiles.add(f.uri.toString());
            }
            this.saveNotifiedFiles();

            if (condaYml && reqTxt) {
                const buttons: string[] = [];
                if (condaYml) {
                    buttons.push(hasConfig ? 'Update from environment.yml' : 'Create from environment.yml');
                }
                if (reqTxt && hasPython) {
                    buttons.push('Install requirements.txt');
                }
                buttons.push('Dismiss');

                const action = await this.messageService.info(
                    `Found environment files in workspace: ${condaYml.name} and ${reqTxt.name}.`,
                    ...(buttons as [string, ...string[]])
                );
                if (action?.includes('environment.yml')) {
                    await this.setupFromCondaYml(condaYml);
                } else if (action === 'Install requirements.txt') {
                    await this.setupFromRequirementsTxt(reqTxt);
                }
            } else if (condaYml) {
                const action = await this.messageService.info(
                    hasConfig
                        ? `Found ${condaYml.name} in workspace. Recreate/update environment from it?`
                        : `Found ${condaYml.name} in workspace. Create a conda environment from it?`,
                    hasConfig ? 'Recreate Environment' : 'Create Environment',
                    'Dismiss'
                );
                if (action === 'Create Environment' || action === 'Recreate Environment') {
                    await this.setupFromCondaYml(condaYml);
                }
            } else if (reqTxt && hasPython) {
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

    /**
     * Looks for `environment.yml`, `environment.yaml` and `requirements.txt`
     * at the root of every workspace folder.
     *
     * @returns A promise resolving to the list of discovered files.
     */
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

    /**
     * Creates or updates a conda environment from the given YAML file.
     * The environment is installed under `~/.nuke-ide/envs/<envName>`.
     * On success the user is offered an immediate switch to the new environment.
     *
     * @param file - The `environment.yml` (or `.yaml`) file to process.
     * @returns A promise that resolves once the operation finishes.
     * @see {@link parseEnvNameFromYml}
     * @see {@link EnvironmentActionsHelper.runCondaEnvFromFile}
     */
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

            // Parse the environment name from the YAML so we can install into ~/.nuke-ide/envs/
            const envName = await this.parseEnvNameFromYml(file.uri);
            const homeVar = await this.envVariables.getValue('HOME');
            const roots = await this.workspaceService.roots;
            const workspaceRoot = roots[0]?.resource?.path?.toString() || '';
            const homeDir = homeVar?.value || workspaceRoot;
            const prefix = `${homeDir}/.nuke-ide/envs/${envName}`;
            const filePath = file.uri.path.fsPath();

            // Check if environment already exists — use update instead of create
            let subCommand: 'create' | 'update' = 'create';
            try {
                const stat = await this.fileService.resolve(new URI(prefix + '/conda-meta'));
                if (stat.isDirectory) {
                    subCommand = 'update';
                }
            } catch {
                // doesn't exist — safe to create
            }

            const success = await this.envActions.runCondaEnvFromFile(
                subCommand,
                filePath,
                prefix,
                `${subCommand === 'update' ? 'Update' : 'Create'} env from ${file.name}`
            );

            if (success) {
                const action = await this.messageService.info(
                    `Environment ${subCommand === 'update' ? 'updated' : 'created'} from ${file.name}! Switch to it?`,
                    'Switch Environment',
                    'Dismiss'
                );
                if (action === 'Switch Environment') {
                    const envs = await this.nukeCore.listEnvironments(true);
                    const newEnv = envs.find(e => e.envPath === prefix || e.name === envName);
                    if (newEnv) {
                        await this.nukeCore.switchToEnvironment(newEnv);
                    } else if (envs.length > 0) {
                        await this.nukeCore.switchToEnvironment(envs[0]);
                    }
                }
            } else {
                this.messageService.warn(
                    `Environment ${subCommand} from ${file.name} may have failed. Check the terminal for details.`
                );
            }
        } catch (error) {
            console.error('[NukeCore] Error setting up from conda yml:', error);
            this.messageService.error(`Failed to create environment from ${file.name}: ${error}`);
        }
    }

    /**
     * Extracts the `name:` field from a conda environment YAML file.
     * Falls back to the parent directory name or `nuke-env`.
     *
     * @param uri - Absolute URI of the YAML file.
     * @returns The resolved environment name.
     */
    private async parseEnvNameFromYml(uri: URI): Promise<string> {
        try {
            const content = await this.fileService.read(uri);
            const match = content.value.match(/^name:\s*(.+)$/m);
            if (match) {
                return match[1].trim();
            }
        } catch {
            // ignore read errors
        }
        // Fallback: use the workspace folder name
        const parts = uri.path.toString().split('/');
        // Remove empty parts and the filename itself
        const dirs = parts.filter(p => p).slice(0, -1);
        return dirs[dirs.length - 1] || 'nuke-env';
    }

    /**
     * Installs dependencies from a `requirements.txt` file into the currently
     * configured Python environment using pip.  If no Python is configured the
     * user is directed to settings.
     *
     * @param file - The `requirements.txt` file to process.
     * @returns A promise that resolves once the operation finishes.
     * @see {@link EnvironmentActionsHelper.runPipInstallFromFile}
     */
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

            const success = await this.envActions.runPipInstallFromFile(
                python.command,
                file.uri.path.fsPath(),
                `Install from ${file.name}`
            );

            if (success) {
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
}
