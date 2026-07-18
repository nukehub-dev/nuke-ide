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
import { WidgetManager, ApplicationShell } from '@theia/core/lib/browser';
import { PlotlyFigure } from '../../common/base-visualizer-protocol';
import { OpenMCPlotWidget } from '../plugins/openmc/widgets/plotting/openmc-plot-widget';

export const PlotlyService = Symbol('PlotlyService');

export interface PlotlyService {
    /**
     * Show a Plotly figure in a plot widget.
     * @param figure The Plotly figure definition
     * @param widgetId Optional unique ID for the plot widget instance
     */
    showPlot(figure: PlotlyFigure, widgetId?: string): Promise<void>;
}

@injectable()
export class PlotlyServiceImpl implements PlotlyService {
    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    async showPlot(figure: PlotlyFigure, widgetId: string = OpenMCPlotWidget.ID): Promise<void> {
        // For now, we reuse OpenMCPlotWidget but we might want a more generic one later.
        // If widgetId is provided and different from default, we can support multiple plot instances.

        const widget = await this.widgetManager.getOrCreateWidget<OpenMCPlotWidget>(OpenMCPlotWidget.ID, { id: widgetId });

        // We need a way to set generic PlotlyFigure data on OpenMCPlotWidget
        if (widget instanceof OpenMCPlotWidget) {
            widget.setFigure(figure);

            if (!widget.isAttached) {
                this.shell.addWidget(widget, { area: 'main' });
            }
            this.shell.activateWidget(widget.id);
        }
    }
}
