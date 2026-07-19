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

import { injectable, inject } from '@theia/core/shared/inversify';
import { ArrayUtils, CommandRegistry, MenuModelRegistry, PreferenceService } from '@theia/core/lib/common';
import {
    CommonCommands,
    CommonMenus,
    AbstractViewContribution,
    FrontendApplicationContribution,
    FrontendApplication
} from '@theia/core/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { GettingStartedWidget } from './getting-started-widget';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { WorkspaceService } from '@theia/workspace/lib/browser';

/**
 * Triggers opening the `GettingStartedWidget`.
 */
export const GettingStartedCommand = {
    id: GettingStartedWidget.ID,
    label: 'Getting Started'
};

@injectable()
export class GettingStartedContribution extends AbstractViewContribution<GettingStartedWidget> implements FrontendApplicationContribution {
    @inject(CommandRegistry)
    protected readonly commandRegistry: CommandRegistry;

    @inject(EditorManager)
    protected readonly editorManager: EditorManager;

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(PreferenceService)
    protected readonly preferenceService: PreferenceService;

    @inject(FrontendApplicationStateService)
    protected readonly stateService: FrontendApplicationStateService;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    constructor() {
        super({
            widgetId: GettingStartedWidget.ID,
            widgetName: GettingStartedWidget.LABEL,
            defaultWidgetOptions: {
                area: 'main'
            }
        });
    }

    async onStart(app: FrontendApplication): Promise<void> {
        this.stateService.reachedState('ready').then(async () => {
            if (this.editorManager.all.length === 0) {
                await this.preferenceService.ready;
                const startupEditor = this.preferenceService.get('workbench.startupEditor');
                switch (startupEditor) {
                    case 'welcomePage':
                        this.openView({ reveal: true, activate: true });
                        break;
                    case 'welcomePageInEmptyWorkbench':
                        if (!this.workspaceService.opened) {
                            this.openView({ reveal: true, activate: true });
                        }
                        break;
                    case 'newUntitledFile':
                        this.commandRegistry.executeCommand(CommonCommands.NEW_UNTITLED_TEXT_FILE.id);
                        break;
                    case 'readme':
                        await this.openReadme();
                        break;
                }
            }
        });
    }

    protected async openReadme(): Promise<void> {
        const roots = await this.workspaceService.roots;
        const readmes = await Promise.all(
            roots.map(async (folder) => {
                const folderStat = await this.fileService.resolve(folder.resource);
                const fileArr = folderStat?.children?.sort((a, b) => a.name.localeCompare(b.name)) || [];
                const filePath =
                    fileArr.find((file) => file.name.toLowerCase() === 'readme.md') ||
                    fileArr.find((file) => file.name.toLowerCase().startsWith('readme'));
                return filePath?.resource;
            })
        );
        const validReadmes = ArrayUtils.coalesce(readmes);
        if (validReadmes.length) {
            for (const readme of validReadmes) {
                await this.editorManager.open(readme, { mode: 'reveal' });
            }
        } else {
            // If no readme is found, show the welcome page.
            this.openView({ reveal: true, activate: true });
        }
    }

    override registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(GettingStartedCommand, {
            execute: () => this.openView({ reveal: true, activate: true })
        });
    }

    override registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(CommonMenus.HELP, {
            commandId: GettingStartedCommand.id,
            label: GettingStartedCommand.label,
            order: 'a10'
        });
    }
}
