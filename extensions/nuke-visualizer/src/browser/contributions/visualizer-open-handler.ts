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
import { OpenHandler, FrontendApplication, WidgetManager } from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';
import { VisualizerWidget } from '../visualizer-widget';
import { NukeCoreStatusBarVisibility, NukeCoreStatusBarVisibilityService } from 'nuke-core/lib/common';

@injectable()
export class VisualizerOpenHandler implements OpenHandler {
    readonly id = 'nuke-visualizer.opener';
    readonly label = 'Open in Nuke Visualizer';

    @inject(FrontendApplication)
    protected readonly app: FrontendApplication;

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(NukeCoreStatusBarVisibility)
    protected readonly visibilityService: NukeCoreStatusBarVisibilityService;

    canHandle(uri: URI): number {
        const ext = uri.path.ext.toLowerCase();
        if (ext === '.h5m') {
            return 1000;
        }
        if (['.vtk', '.vtu', '.vtp', '.vts', '.vtr', '.pvtu', '.pvtp'].includes(ext)) {
            return 500;
        }
        if (['.stl', '.ply', '.obj'].includes(ext)) {
            return 200;
        }
        if (['.step', '.stp', '.brep'].includes(ext)) {
            return 200;
        }
        return 0;
    }

    async open(uri: URI): Promise<VisualizerWidget> {
        const filePath = uri.path.toString();
        
        const widgets = this.app.shell.getWidgets('main');
        const existing = widgets.find(w => w instanceof VisualizerWidget && w.id.endsWith(filePath)) as VisualizerWidget;
        
        if (existing) {
            console.log(`[Visualizer] Found existing widget for ${filePath}, activating: ${existing.id}`);
            this.app.shell.activateWidget(existing.id);
            await existing.loadFile(uri);
            return existing;
        }

        console.log(`[Visualizer] Creating new widget for ${filePath}`);
        
        const widget = await this.widgetManager.getOrCreateWidget(VisualizerWidget.ID, { 
            uri: uri.toString() 
        }) as VisualizerWidget;
        
        widget.setUri(uri);

        if (!widget.isAttached) {
            this.app.shell.addWidget(widget, { area: 'main' });
        }
        
        this.app.shell.activateWidget(widget.id);
        await widget.loadFile(uri);

        const handle = this.visibilityService.requestVisibility('nuke-visualizer');
        widget.disposed.connect(() => handle.dispose());
        
        return widget;
    }
}
