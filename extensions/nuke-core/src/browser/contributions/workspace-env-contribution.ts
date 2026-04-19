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
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
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

    private hasNotified = false;

    async onStart(): Promise<void> {
        // Wait a bit for the workspace to be fully loaded
        setTimeout(() => this.scanWorkspace(), 3000);
    }

    private async scanWorkspace(): Promise<void> {
        if (this.hasNotified) {
            return;
        }

        try {
            const envFiles = await this.findEnvFiles();
            if (envFiles.length === 0) {
                return;
            }

            // Only prompt if no environment is currently configured
            const config = await this.nukeCore.getConfig();
            if (config.pythonPath || config.condaEnv) {
                return;
            }

            this.hasNotified = true;

            const condaYml = envFiles.find(f => f.type === 'conda-yml');
            const reqTxt = envFiles.find(f => f.type === 'requirements-txt');

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
            await this.messageService.info(
                `Use the command palette (Ctrl+Shift+P) and run "Nuke: Create Environment" to create an environment from ${file.name}.`,
                'OK'
            );
            // TODO: In a future iteration, implement the actual env creation command.
            // For now, we direct the user to the existing environment switcher.
        } catch (error) {
            console.error('[NukeCore] Error setting up from conda yml:', error);
        }
    }

    private async setupFromRequirementsTxt(file: EnvFileInfo): Promise<void> {
        try {
            // For requirements.txt, we can try to install packages in the detected Python
            const python = await this.nukeCore.detectPython();
            if (!python.success || !python.command) {
                await this.messageService.warn(
                    'No Python environment detected. Please configure one in Settings → Nuke Utils first.',
                    'Open Settings'
                );
                return;
            }

            // Read the requirements file via backend (we don't have direct file read here easily)
            // For now, just suggest the command
            const action = await this.messageService.info(
                `Run the following to install dependencies from ${file.name}:`,
                'Copy Command',
                'Dismiss'
            );
            if (action === 'Copy Command') {
                const cmd = `${python.command} -m pip install -r ${file.uri.path.fsPath()}`;
                await navigator.clipboard.writeText(cmd);
                await this.messageService.info('Command copied to clipboard!');
            }
        } catch (error) {
            console.error('[NukeCore] Error setting up from requirements.txt:', error);
        }
    }
}
