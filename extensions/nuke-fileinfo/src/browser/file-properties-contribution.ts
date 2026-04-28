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

import { inject, injectable } from '@theia/core/shared/inversify';
import { Command, CommandContribution, CommandRegistry, MenuContribution, MenuModelRegistry } from '@theia/core/lib/common';
import { UriAwareCommandHandler } from '@theia/core/lib/common/uri-command-handler';
import { SelectionService } from '@theia/core/lib/common/selection-service';
import { URI } from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { NavigatorContextMenu } from '@theia/navigator/lib/browser/navigator-contribution';
import { FilePropertiesDialog } from './file-properties-dialog';
import { nls } from '@theia/core';

/**
 * Command definitions for the file properties extension.
 */
export namespace FilePropertiesCommands {
    export const FILE_PROPERTIES: Command = {
        id: 'nuke.file.properties',
        label: nls.localize('nuke/fileinfo/command', 'Properties')
    };
}

/**
 * Contribution that registers the **Properties** command and menu item
 * in the file navigator context menu.
 */
@injectable()
export class FilePropertiesContribution implements CommandContribution, MenuContribution {

    @inject(SelectionService)
    protected readonly selectionService: SelectionService;

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(FilePropertiesDialog)
    protected readonly dialog: FilePropertiesDialog;

    /**
     * Register the Properties command bound to a single URI selection.
     * @param commands - Theia command registry.
     */
    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(
            FilePropertiesCommands.FILE_PROPERTIES,
            UriAwareCommandHandler.MonoSelect(this.selectionService, {
                execute: async (uri: URI) => {
                    try {
                        const stat = await this.fileService.resolve(uri, { resolveMetadata: true });
                        this.dialog.setFile(uri, stat);
                        await this.dialog.open();
                    } catch (err) {
                        console.error('[FileProperties] Failed to open properties:', err);
                    }
                },
                isEnabled: (uri: URI) => uri !== undefined,
                isVisible: (uri: URI) => uri !== undefined
            })
        );
    }

    /**
     * Add the Properties command to the navigator modification context menu.
     * @param menus - Theia menu model registry.
     */
    registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(NavigatorContextMenu.MODIFICATION, {
            commandId: FilePropertiesCommands.FILE_PROPERTIES.id,
            label: FilePropertiesCommands.FILE_PROPERTIES.label,
            order: 'z0'
        });
    }
}
