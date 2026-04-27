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
import { CommandRegistry, CommandContribution } from '@theia/core/lib/common';
import { SelectionService } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { OpenMCCommands } from './index';
import { OpenMCContribution } from '../openmc-contribution';
import { OpenMCDepletionCompareWidget } from '../widgets/depletion/openmc-depletion-compare-widget';
import { WidgetManager } from '@theia/core/lib/browser';
import { ApplicationShell } from '@theia/core/lib/browser';
import { MessageService } from '@theia/core/lib/common';

@injectable()
export class OpenMCDepletionCommands implements CommandContribution {
    @inject(OpenMCContribution)
    protected readonly contribution: OpenMCContribution;

    @inject(SelectionService)
    protected readonly selectionService: SelectionService;

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(OpenMCCommands.OPEN_DEPLETION_VIEWER, {
            execute: () => this.contribution.openDepletionViewerCommand()
        });
        registry.registerCommand(OpenMCCommands.COMPARE_DEPLETION, {
            execute: () => this.contribution.compareDepletionCommand()
        });
        registry.registerCommand(OpenMCCommands.COMPARE_DEPLETION_WITH, {
            execute: async () => {
                const selection = this.selectionService.selection;

                // Handle multiple selection (exactly 2 files)
                if (Array.isArray(selection) && selection.length === 2) {
                    const uriA = selection[0] instanceof URI ? selection[0] : (selection[0] as any).uri;
                    const uriB = selection[1] instanceof URI ? selection[1] : (selection[1] as any).uri;

                    if (uriA && uriB) {
                        const isDepletionA = uriA.path.base.includes('depletion') && uriA.path.base.endsWith('.h5');
                        const isDepletionB = uriB.path.base.includes('depletion') && uriB.path.base.endsWith('.h5');

                        if (isDepletionA && isDepletionB) {
                            try {
                                const progress = await this.messageService.showProgress({
                                    text: 'Loading comparison data...',
                                    options: { cancelable: false }
                                });
                                try {
                                    const widget = await this.widgetManager.getOrCreateWidget<OpenMCDepletionCompareWidget>(
                                        OpenMCDepletionCompareWidget.ID,
                                        { id: `${OpenMCDepletionCompareWidget.ID}:${uriA.toString()}:${uriB.toString()}` } as any
                                    );
                                    await widget.setComparisonFiles(uriA, uriA.path.base, uriB, uriB.path.base);
                                    if (!widget.isAttached) {
                                        this.shell.addWidget(widget, { area: 'main' });
                                    }
                                    this.shell.activateWidget(widget.id);
                                    return;
                                } finally {
                                    progress.cancel();
                                }
                            } catch (error) {
                                this.messageService.error(`Failed to open comparison: ${error}`);
                            }
                        }
                    }
                }

                // Fallback to single selection behavior
                let uri: URI | undefined;
                if (Array.isArray(selection) && selection.length > 0) {
                    uri = selection[0] instanceof URI ? selection[0] : (selection[0] as any).uri;
                } else if (selection instanceof URI) {
                    uri = selection;
                } else if (selection && 'uri' in selection) {
                    uri = (selection as any).uri;
                }

                if (uri) {
                    this.contribution.compareDepletionWithCommand(uri);
                } else {
                    this.messageService.error('No file selected');
                }
            }
        });
    }
}
