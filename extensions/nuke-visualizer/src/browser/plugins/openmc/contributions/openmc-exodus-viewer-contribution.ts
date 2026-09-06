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
import { MessageService } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { OutputViewerContribution } from '../../../output-viewer/output-viewer-registry';
import { VisualizerBackendService } from '../../../../common/base-visualizer-protocol';
import { ExodusTimeSliderWidget } from '../widgets/exodus-series/exodus-time-slider-widget';

/**
 * Exodus-II file names claimed by the native time-slider viewer: the
 * canonical `.e` suffix plus the `.exo*` family (`.exo`, `.exoii`,
 * `.exodus`). The extractor accepts more (`EXODUS_SUFFIXES` also lists
 * `.ex2`/`.nc`/`.cdf`), but those stay unclaimed — `.nc`/`.cdf` are generic
 * netCDF names that must keep their default handler.
 */
export function isExodusFileName(baseName: string): boolean {
    const name = baseName.toLowerCase();
    return name.endsWith('.e') || /\.exo[^/]*$/.test(name);
}

/**
 * Routes Exodus-II files (e.g. `run.e` from an `IOExodus`-backed simulation)
 * to the native time-slider viewer via the OutputViewerRegistry: the backend
 * extracts the whole series with `base.exodus-series` (netCDF4, meshio
 * fallback) and the payload loads into `ExodusTimeSliderWidget.setSeriesText`
 * — no trame server, stepping and color-by apply instantly client-side.
 *
 * When the extraction fails the file stays unopened and the error names the
 * missing dependency (netCDF4/meshio) where that is the cause.
 */
@injectable()
export class OpenMCExodusViewerContribution implements OutputViewerContribution {
    readonly id = 'openmc-exodus-viewer';
    readonly label = 'Native Exodus Viewer';
    readonly priority = 100;

    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    @inject(VisualizerBackendService)
    protected readonly visualizerBackend!: VisualizerBackendService;

    canHandle(uri: URI): number {
        return isExodusFileName(uri.path.base) ? 600 : 0;
    }

    async open(uri: URI): Promise<void> {
        let seriesText: string;
        try {
            const series = await this.visualizerBackend.getExodusSeries(uri.path.toString());
            seriesText = JSON.stringify(series);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[exodus-viewer] base.exodus-series failed for ${uri.path.toString()}: ${message}`);
            this.messageService.error(`Exodus series extraction failed: ${message}`);
            return;
        }

        const widget = await this.widgetManager.getOrCreateWidget<ExodusTimeSliderWidget>(ExodusTimeSliderWidget.ID, {
            id: `${ExodusTimeSliderWidget.ID}:${uri.path.toString()}`
        });
        if (!widget.isAttached) {
            this.shell.addWidget(widget, { area: 'main' });
        }
        this.shell.activateWidget(widget.id);
        widget.setSeriesText(seriesText, uri);
    }
}
