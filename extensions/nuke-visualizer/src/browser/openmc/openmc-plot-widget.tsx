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

import * as React from 'react';
import { injectable, postConstruct, inject } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import { Message } from '@lumino/messaging';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { OpenMCSpectrumData, OpenMCSpatialPlotData, PlotlyFigure } from '../../common/visualizer-protocol';
import { PlotlyComponent } from '../plotly/plotly-component';
import { PlotlyUtils } from '../plotly/plotly-utils';

@injectable()
export class OpenMCPlotWidget extends ReactWidget {
    static readonly ID = 'openmc-plot-widget';
    static readonly LABEL = 'OpenMC Plot';

    private data: OpenMCSpectrumData | OpenMCSpatialPlotData | null = null;
    private plotType: 'spectrum' | 'spatial' | 'generic' = 'spectrum';
    private titleText: string = 'OpenMC Plot';
    private genericFigure: PlotlyFigure | null = null;

    @inject(ThemeService)
    protected readonly themeService: ThemeService;

    @postConstruct()
    protected init(): void {
        this.id = OpenMCPlotWidget.ID;
        this.title.label = OpenMCPlotWidget.LABEL;
        this.title.caption = OpenMCPlotWidget.LABEL;
        this.title.iconClass = codicon('graph');
        this.title.closable = true;

        // Ensure the widget can be focused
        this.node.tabIndex = 0;

        // Listen for theme changes to re-render the plot
        this.themeService.onDidColorThemeChange(() => this.update());

        this.update();
    }

    focus(): void {
        this.node.focus();
    }

    setData(data: OpenMCSpectrumData | OpenMCSpatialPlotData, type: 'spectrum' | 'spatial', title: string): void {
        this.data = data;
        this.plotType = type;
        this.titleText = title;
        this.title.label = title;
        this.genericFigure = null;
        this.update();
    }

    setFigure(figure: PlotlyFigure): void {
        this.genericFigure = figure;
        this.plotType = 'generic';
        this.titleText = figure.title || 'Scientific Plot';
        this.title.label = this.titleText;
        this.data = null;
        this.update();
    }

    protected getCurrentTheme(): 'dark' | 'light' {
        const themeId = this.themeService.getCurrentTheme().id;
        return themeId.indexOf('light') !== -1 ? 'light' : 'dark';
    }

    protected render(): React.ReactNode {
        if (!this.data && !this.genericFigure) {
            return <div className="openmc-plot empty" style={{ padding: '20px', textAlign: 'center' }}>No data to display</div>;
        }

        const theme = this.getCurrentTheme();
        const bgColor = theme === 'dark' ? '#1e1e1e' : '#ffffff';
        const textColor = theme === 'dark' ? '#cccccc' : '#333333';

        return (
            <div className="openmc-plot" style={{ 
                height: '100%', 
                display: 'flex', 
                flexDirection: 'column',
                backgroundColor: bgColor,
                color: textColor,
                fontFamily: 'Segoe UI, Tahoma, Geneva, Verdana, sans-serif',
                overflow: 'hidden'
            }}>
                <div style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center', 
                    padding: '10px 20px',
                    borderBottom: `1px solid ${theme === 'dark' ? '#333' : '#eee'}`
                }}>
                    <h3 style={{ margin: 0, color: theme === 'dark' ? '#fff' : '#000' }}>{this.titleText}</h3>
                    <div style={{ fontSize: '12px', color: '#888' }}>
                        {this.plotType === 'spectrum' ? 'Log-Log Energy Spectrum' : 
                         this.plotType === 'spatial' ? 'Linear Spatial Distribution' : 'Plotly Figure'}
                    </div>
                </div>
                <div style={{ flex: 1, position: 'relative', minHeight: '350px', overflow: 'hidden' }}>
                    {this.plotType === 'spectrum' ? 
                        this.renderSpectrum(this.data as OpenMCSpectrumData, theme) : 
                     this.plotType === 'spatial' ?
                        this.renderSpatial(this.data as OpenMCSpatialPlotData, theme) :
                        this.renderGeneric(this.genericFigure!, theme)}
                </div>
            </div>
        );
    }

    private renderGeneric(figure: PlotlyFigure, theme: 'dark' | 'light'): React.ReactNode {
        return <PlotlyComponent data={figure.data} layout={figure.layout} config={figure.config} theme={theme} />;
    }

    private renderSpectrum(data: OpenMCSpectrumData, theme: 'dark' | 'light'): React.ReactNode {
        const traces = PlotlyUtils.createSpectrumTraces(data);
        const layout: Partial<Plotly.Layout> = {
            xaxis: {
                title: { text: 'Energy [eV]' },
                type: 'log'
            },
            yaxis: {
                title: { text: 'Tally Value [per src]' },
                type: 'log'
            },
            hovermode: 'closest'
        };

        return <PlotlyComponent data={traces} layout={layout} theme={theme} />;
    }

    private renderSpatial(data: OpenMCSpatialPlotData, theme: 'dark' | 'light'): React.ReactNode {
        const traces = PlotlyUtils.createSpatialTraces(data);
        const layout: Partial<Plotly.Layout> = {
            xaxis: {
                title: { text: 'Position [cm]' }
            },
            yaxis: {
                title: { text: 'Tally Value' }
            },
            hovermode: 'closest'
        };

        return <PlotlyComponent data={traces} layout={layout} theme={theme} />;
    }

    protected onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        this.triggerPlotResize();
    }

    protected onResize(msg: any): void {
        super.onResize(msg);
        this.triggerPlotResize();
    }

    private triggerPlotResize(): void {
        // Many Plotly components rely on window resize events, but Lumino doesn't trigger them
        window.dispatchEvent(new Event('resize'));
    }

    protected onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.node.focus();
    }
}
