// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { injectable, inject } from '@theia/core/shared/inversify';
import { WidgetManager, ApplicationShell } from '@theia/core/lib/browser';
import { PlotlyFigure } from '../../common/visualizer-protocol';
import { OpenMCPlotWidget } from '../openmc/openmc-plot-widget';

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
