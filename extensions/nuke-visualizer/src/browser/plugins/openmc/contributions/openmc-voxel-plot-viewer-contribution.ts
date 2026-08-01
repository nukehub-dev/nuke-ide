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
import { ApplicationShell, WidgetManager } from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';
import { OutputViewerContribution } from '../../../output-viewer/output-viewer-registry';
import { isVoxelPlotFileName } from '../../../output-viewer/output-file-patterns';
import { OpenMCRandomRayResultsWidget } from '../widgets/random-ray/random-ray-results-widget';

/**
 * Routes OpenMC voxel plot HDF5 files (`*voxel*.h5`, `plot_*.h5`) to the
 * random-ray results viewer, which converts them via `openmc.voxel-vtk` and
 * renders the multigroup voxel grid.
 */
@injectable()
export class OpenMCVoxelPlotViewerContribution implements OutputViewerContribution {
    readonly id = 'openmc-voxel-plot-viewer';
    readonly label = 'OpenMC Voxel Plot Viewer';
    readonly priority = 100;

    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    canHandle(uri: URI): number {
        return isVoxelPlotFileName(uri.path.base) ? 600 : 0;
    }

    async open(uri: URI): Promise<void> {
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
