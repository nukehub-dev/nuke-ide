// *****************************************************************************
// Copyright (C) 2026 NukeHub and others.
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
 * Nuke Preview Gallery Commands
 *
 * Opens the read-only preview gallery widget from the Command Palette.
 *
 * @module nuke-ai/browser/preview
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { Command, CommandRegistry } from '@theia/core/lib/common/command';
import { AbstractViewContribution } from '@theia/core/lib/browser';
import { MessageService } from '@theia/core/lib/common/message-service';
import { NukePreviewGalleryWidget } from './nuke-preview-gallery-widget';
import { NukePreviewGalleryService } from './nuke-preview-gallery-service';

/** Commands owned by the preview gallery. */
export const NukePreviewGalleryCommands = {
    OPEN: {
        id: 'nuke.ai.openPreviewGallery',
        label: 'NukeAI: Open Preview Gallery',
        category: 'NukeAI'
    } as Command,
    CLEAR: {
        id: 'nuke.ai.clearPreviewHistory',
        label: 'NukeAI: Clear Preview History',
        category: 'NukeAI'
    } as Command
};

/** Contribute the gallery view and its Command Palette entry. */
@injectable()
export class NukePreviewGalleryContribution extends AbstractViewContribution<NukePreviewGalleryWidget> {
    @inject(NukePreviewGalleryService)
    protected readonly galleryService: NukePreviewGalleryService;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    constructor() {
        super({
            widgetId: NukePreviewGalleryWidget.ID,
            widgetName: NukePreviewGalleryWidget.LABEL,
            defaultWidgetOptions: {
                area: 'main'
            }
        });
    }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(NukePreviewGalleryCommands.OPEN, {
            execute: () => this.openView({ activate: true })
        });
        commands.registerCommand(NukePreviewGalleryCommands.CLEAR, {
            execute: () => this.clearHistory()
        });
    }

    protected async clearHistory(): Promise<void> {
        const choice = await this.messageService.warn(
            'Delete every saved preview and trajectory in this workspace? This cannot be undone.',
            'Clear History'
        );
        if (choice !== 'Clear History') {
            return;
        }
        const result = await this.galleryService.clear();
        if (result.cleared) {
            this.messageService.info(result.message);
            await this.tryGetWidget()?.refresh();
        } else {
            this.messageService.warn(result.message);
        }
    }
}
