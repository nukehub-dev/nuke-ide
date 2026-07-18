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
import { OpenMCDepletionWidget } from '../widgets/depletion/openmc-depletion-widget';
import { OpenMCDepletionCompareWidget } from '../widgets/depletion/openmc-depletion-compare-widget';
import { OpenMCFileDiscovery } from './openmc-file-discovery';

@injectable()
export class OpenMCDepletionContribution {
    @inject(OpenMCService)
    protected readonly openmcService: OpenMCService;

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(FileDialogService)
    protected readonly fileDialogService: FileDialogService;

    @inject(QuickInputService)
    protected readonly quickInput: QuickInputService;

    @inject(LabelProvider)
    protected readonly labelProvider: LabelProvider;

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(OpenMCFileDiscovery)
    protected readonly fileDiscovery: OpenMCFileDiscovery;

    async openDepletionFile(filePath: string, fileName: string): Promise<void> {
        try {
            const widget = await this.widgetManager.getOrCreateWidget<OpenMCDepletionWidget>(OpenMCDepletionWidget.ID, {
                id: `${OpenMCDepletionWidget.ID}:${filePath}`
            } as any);

            widget.setDepletionFile(new URI(filePath), fileName);

            if (!widget.isAttached) {
                this.shell.addWidget(widget, { area: 'main' });
            }
            this.shell.activateWidget(widget.id);
        } catch (error) {
            this.messageService.error(`Failed to open depletion file: ${error}`);
        }
    }

    async openDepletionViewerCommand(): Promise<void> {
        // Find depletion results files in workspace
        const files = await this.fileDiscovery.getDepletionFiles();

        // Add "Browse..." option to select file from anywhere
        const options: QuickPickValue<string>[] = [
            { value: '__browse__', label: '$(folder-opened) Browse for file...', description: 'Select depletion file from any location' },
            { type: 'separator', label: 'Workspace Files' } as any,
            ...files
        ];

        if (files.length === 0) {
            // Remove separator if no files
            options.splice(1, 1);
        }

        const selection = await this.quickInput.showQuickPick(options, {
            title: 'Open Depletion Results',
            placeholder: files.length > 0 ? 'Choose a file or browse...' : 'Browse for depletion file...'
        });

        if (!selection) return;

        if (selection.value === '__browse__') {
            // Open file dialog
            const fileUri = await this.fileDialogService.showOpenDialog({
                title: 'Select Depletion Results File',
                openLabel: 'Open',
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false
            });

            if (fileUri) {
                const uri = Array.isArray(fileUri) ? fileUri[0] : fileUri;
                const fileName = uri.path.base;
                await this.openDepletionFile(uri.toString(), fileName);
            }
        } else {
            await this.openDepletionFile(selection.value, selection.label);
        }
    }

    async compareDepletionCommand(): Promise<void> {
        // Get depletion files from workspace
        const workspaceFiles = await this.fileDiscovery.getDepletionFiles();

        // Build options with browse
        const options: QuickPickValue<string>[] = [
            { value: '__browse_a__', label: '$(folder-opened) Browse for Case A...', description: 'Select file from any location' }
        ];

        if (workspaceFiles.length > 0) {
            options.push({ type: 'separator', label: 'Workspace Files' } as any, ...workspaceFiles);
        }

        // Select Case A
        const selectionA = await this.quickInput.showQuickPick(options, {
            title: 'Select Case A (Reference)',
            placeholder: 'Choose file or browse...'
        });

        if (!selectionA) return;

        let uriA: URI;
        let labelA: string;

        if (selectionA.value === '__browse_a__') {
            const fileUri = await this.fileDialogService.showOpenDialog({
                title: 'Select Case A (Reference)',
                openLabel: 'Select',
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false
            });
            if (!fileUri) return;
            uriA = Array.isArray(fileUri) ? fileUri[0] : fileUri;
            labelA = uriA.path.base;
        } else {
            uriA = new URI(selectionA.value);
            labelA = selectionA.label;
        }

        // Build options for Case B
        const optionsB: QuickPickValue<string>[] = [
            { value: '__browse_b__', label: '$(folder-opened) Browse for Case B...', description: 'Select file from any location' }
        ];

        const remainingFiles = workspaceFiles.filter((f) => f.value !== uriA.toString());
        if (remainingFiles.length > 0) {
            optionsB.push({ type: 'separator', label: 'Workspace Files' } as any, ...remainingFiles);
        }

        // Select Case B
        const selectionB = await this.quickInput.showQuickPick(optionsB, {
            title: 'Select Case B (Comparison)',
            placeholder: 'Choose file or browse...'
        });

        if (!selectionB) return;

        let uriB: URI;
        let labelB: string;

        if (selectionB.value === '__browse_b__') {
            const fileUri = await this.fileDialogService.showOpenDialog({
                title: 'Select Case B (Comparison)',
                openLabel: 'Select',
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false
            });
            if (!fileUri) return;
            uriB = Array.isArray(fileUri) ? fileUri[0] : fileUri;
            labelB = uriB.path.base;
        } else {
            uriB = new URI(selectionB.value);
            labelB = selectionB.label;
        }

        // Open comparison widget
        try {
            const progress = await this.messageService.showProgress({
                text: 'Loading comparison data...',
                options: { cancelable: false }
            });
            try {
                const widget = await this.widgetManager.getOrCreateWidget<OpenMCDepletionCompareWidget>(OpenMCDepletionCompareWidget.ID, {
                    id: `${OpenMCDepletionCompareWidget.ID}:${uriA.toString()}:${uriB.toString()}`
                } as any);

                await widget.setComparisonFiles(uriA, labelA, uriB, labelB);

                if (!widget.isAttached) {
                    this.shell.addWidget(widget, { area: 'main' });
                }
                this.shell.activateWidget(widget.id);
            } finally {
                progress.cancel();
            }
        } catch (error) {
            this.messageService.error(`Failed to open comparison: ${error}`);
        }
    }

    async compareDepletionWithCommand(uriA: URI): Promise<void> {
        // Use the provided file as Case A
        const labelA = uriA.path.base;

        // Get files for Case B selection
        const workspaceFiles = await this.fileDiscovery.getDepletionFiles();

        // Build options for Case B
        const options: QuickPickValue<string>[] = [
            { value: '__browse_b__', label: '$(folder-opened) Browse for Case B...', description: 'Select file from any location' }
        ];

        // Filter out Case A from workspace files
        const remainingFiles = workspaceFiles.filter((f) => f.value !== uriA.toString());
        if (remainingFiles.length > 0) {
            options.push({ type: 'separator', label: 'Workspace Files' } as any, ...remainingFiles);
        }

        // Select Case B
        const selectionB = await this.quickInput.showQuickPick(options, {
            title: `Compare "${labelA}" with...`,
            placeholder: 'Choose second depletion file'
        });

        if (!selectionB) return;

        let uriB: URI;
        let labelB: string;

        if (selectionB.value === '__browse_b__') {
            const fileUri = await this.fileDialogService.showOpenDialog({
                title: 'Select Case B (Comparison)',
                openLabel: 'Select',
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false
            });
            if (!fileUri) return;
            uriB = Array.isArray(fileUri) ? fileUri[0] : fileUri;
            labelB = uriB.path.base;
        } else {
            uriB = new URI(selectionB.value);
            labelB = selectionB.label;
        }

        // Open comparison widget
        try {
            const progress = await this.messageService.showProgress({
                text: 'Loading comparison data...',
                options: { cancelable: false }
            });
            try {
                const widget = await this.widgetManager.getOrCreateWidget<OpenMCDepletionCompareWidget>(OpenMCDepletionCompareWidget.ID, {
                    id: `${OpenMCDepletionCompareWidget.ID}:${uriA.toString()}:${uriB.toString()}`
                } as any);

                await widget.setComparisonFiles(uriA, labelA, uriB, labelB);

                if (!widget.isAttached) {
                    this.shell.addWidget(widget, { area: 'main' });
                }
                this.shell.activateWidget(widget.id);
            } finally {
                progress.cancel();
            }
        } catch (error) {
            this.messageService.error(`Failed to open comparison: ${error}`);
        }
    }
}
