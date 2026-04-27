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
import { MessageService } from '@theia/core/lib/common';
import { QuickInputService, QuickPickValue, LabelProvider, ApplicationShell, WidgetManager } from '@theia/core/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { OpenMCService } from '../openmc-service';
import { XSPlotWidget } from '../widgets/plotting/xs-plot-widget';
import { OpenMCFileDiscovery } from './openmc-file-discovery';

@injectable()
export class OpenMCPlottingContribution {
    @inject(OpenMCService)
    protected readonly openmcService: OpenMCService;

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(QuickInputService)
    protected readonly quickInput: QuickInputService;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(FileDialogService)
    protected readonly fileDialogService: FileDialogService;

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(LabelProvider)
    protected readonly labelProvider: LabelProvider;

    @inject(OpenMCFileDiscovery)
    protected readonly fileDiscovery: OpenMCFileDiscovery;

    private async getOrCreateXSPlotWidget(): Promise<XSPlotWidget> {
        return this.widgetManager.getOrCreateWidget<XSPlotWidget>(XSPlotWidget.ID, {
            id: XSPlotWidget.ID
        } as any);
    }

    async plotXSCommand(): Promise<void> {
        const widget = await this.getOrCreateXSPlotWidget();
        
        if (!widget.isAttached) {
            await this.shell.addWidget(widget, { area: 'main' });
        }
        
        await this.shell.activateWidget(widget.id);
    }

    async visualizeSourceCommand(): Promise<void> {
        // Get source files from workspace
        const files = await this.fileDiscovery.getSourceFiles();
        
        // Add "Browse..." option
        const options: QuickPickValue<string>[] = [
            { value: '__browse__', label: '$(folder-opened) Browse for file...', description: 'Select source.h5 file from any location' }
        ];
        
        if (files.length > 0) {
            options.push({ type: 'separator', label: 'Workspace Files' } as any, ...files);
        }

        const selection = await this.quickInput.showQuickPick(options, {
            title: 'Select Source File',
            placeholder: files.length > 0 ? 'Choose a file or browse...' : 'Browse for source.h5 file...'
        });

        if (!selection) return;

        if (selection.value === '__browse__') {
            // Open file dialog
            const fileUri = await this.fileDialogService.showOpenDialog({
                title: 'Select Source File',
                openLabel: 'Open',
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'HDF5 Files': ['h5'],
                    'All Files': ['*']
                }
            });
            
            if (fileUri) {
                const uri = Array.isArray(fileUri) ? fileUri[0] : fileUri;
                await this.openmcService.visualizeSource(uri);
            }
        } else {
            await this.openmcService.visualizeSource(new URI(selection.value));
        }
    }
}
