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

import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandRegistry, CommandContribution } from '@theia/core/lib/common';
import { ApplicationShell, WidgetManager } from '@theia/core/lib/browser';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { OpenMCCommands } from './index';
import { OpenMCRandomRayResultsWidget } from '../widgets/random-ray/random-ray-results-widget';

/**
 * Command 'Open as Random Ray Results...': opens a random-ray results file
 * (legacy `.vtk` random-ray output, `.vti`, or a voxel `.h5` plot) in the
 * random-ray results widget. Deliberately not an OutputViewerContribution:
 * random-ray outputs are plain `<name>.vtk` files with no distinctive
 * filename pattern, so double-click keeps the standard VTK open handler and
 * this command is the explicit opt-in.
 */
@injectable()
export class OpenMCRandomRayCommands implements CommandContribution {
    @inject(FileDialogService)
    protected readonly fileDialogService!: FileDialogService;

    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(OpenMCCommands.OPEN_RANDOM_RAY_RESULTS, {
            execute: () => this.openRandomRayResults()
        });
    }

    protected async openRandomRayResults(): Promise<void> {
        const fileUri = await this.fileDialogService.showOpenDialog({
            title: 'Open Random Ray Results',
            openLabel: 'Open',
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'Random Ray / VTK Results': ['vtk', 'vti', 'vtr', 'h5'],
                'All Files': ['*']
            }
        });
        const uri = Array.isArray(fileUri) ? fileUri[0] : fileUri;
        if (!uri) {
            return;
        }

        const widget = await this.widgetManager.getOrCreateWidget<OpenMCRandomRayResultsWidget>(OpenMCRandomRayResultsWidget.ID, {
            id: `${OpenMCRandomRayResultsWidget.ID}:${uri.path.toString()}`
        });
        if (!widget.isAttached) {
            this.shell.addWidget(widget, { area: 'main' });
        }
        this.shell.activateWidget(widget.id);
        widget.setFile(uri);
    }
}
