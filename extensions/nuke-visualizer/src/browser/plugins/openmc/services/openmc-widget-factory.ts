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
import URI from '@theia/core/lib/common/uri';
import { WidgetManager, ApplicationShell } from '@theia/core/lib/browser';
import { VisualizerWidget } from '../../../visualizer-widget';
import { WIDGET_IDS } from '../widgets/widget-ids';

@injectable()
export class OpenMCWidgetFactory {
    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    /**
     * Create and configure a visualizer widget.
     * Can be called with loading state first, then server URL set later.
     */
    async createVisualizerWidget(
        fileUri: URI,
        label: string,
        widgetId?: string,
        serverInfo?: { port: number; url: string },
        loadingMessage?: string
    ): Promise<VisualizerWidget> {
        const finalWidgetId = widgetId || `${VisualizerWidget.ID}:${fileUri.path.toString()}`;

        const widget = await this.widgetManager.getOrCreateWidget<VisualizerWidget>(
            VisualizerWidget.ID,
            { uri: fileUri.toString(), id: finalWidgetId }
        );

        widget.id = finalWidgetId;
        widget.setUri(fileUri);
        widget.id = finalWidgetId;

        widget.title.label = label;
        widget.title.caption = label;

        if (loadingMessage && !serverInfo) {
            (widget as any).statusMessage = loadingMessage;
            widget.update();
        }

        if (serverInfo) {
            widget.setServerUrl(serverInfo.url, serverInfo.port);
        }

        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);

        return widget;
    }

    /**
     * Create a visualizer widget in loading state.
     * Returns the widget and a function to complete loading once server is ready.
     */
    async createVisualizerWidgetLoading(
        fileUri: URI,
        label: string,
        widgetId: string,
        loadingMessage: string
    ): Promise<{ widget: VisualizerWidget; completeLoading: (port: number, url: string) => void }> {
        const widget = await this.createVisualizerWidget(
            fileUri,
            label,
            widgetId,
            undefined,
            loadingMessage
        );

        const completeLoading = (port: number, url: string) => {
            widget.setServerUrl(url, port);
        };

        return { widget, completeLoading };
    }

    /**
     * Find an existing widget by ID in the main area.
     */
    findExistingWidget(widgetId: string): VisualizerWidget | undefined {
        for (const widget of this.shell.getWidgets('main')) {
            if (widget.id === widgetId && widget instanceof VisualizerWidget) {
                return widget;
            }
        }
        return undefined;
    }

    /**
     * Get or create a plot widget for a specific tally.
     */
    async getPlotWidget(tallyId: number, type: string): Promise<any> {
        const widgetId = `${WIDGET_IDS.OPENMC_PLOT}:${tallyId}:${type}`;
        return this.widgetManager.getOrCreateWidget(WIDGET_IDS.OPENMC_PLOT, {
            id: widgetId
        } as any);
    }

    /**
     * Get or create a heatmap widget for a specific tally.
     */
    async getHeatmapWidget(tallyId: number, score?: string): Promise<any> {
        const widgetId = `${WIDGET_IDS.OPENMC_HEATMAP}:${tallyId}:${score || 'default'}`;
        return this.widgetManager.getOrCreateWidget(WIDGET_IDS.OPENMC_HEATMAP, {
            id: widgetId
        } as any);
    }

    /**
     * Get or create an XS plot widget.
     */
    async getXSPlotWidget(): Promise<any> {
        return this.widgetManager.getOrCreateWidget(WIDGET_IDS.XS_PLOT, {
            id: WIDGET_IDS.XS_PLOT
        } as any);
    }
}
