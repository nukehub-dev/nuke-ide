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

import * as React from 'react';
import { injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import { Message } from '@lumino/messaging';
import { OpenMCSpectrumData, OpenMCSpatialPlotData } from '../../../../../common/openmc-protocol';
import { PlotlyFigure } from '../../../../../common/base-visualizer-protocol';
import { PlotlyComponent } from '../../../../plotly/plotly-component';
import { PlotlyUtils } from '../../../../plotly/plotly-utils';
import { LoadingAnimations, FancyLoadingSpinner } from 'nuke-essentials/lib/theme/browser/components/loading-spinner';

@injectable()
export class OpenMCPlotWidget extends ReactWidget {
    static readonly ID = 'openmc-plot-widget';
    static readonly LABEL = 'OpenMC Plot';

    private data: OpenMCSpectrumData | OpenMCSpatialPlotData | null = null;
    private plotType: 'spectrum' | 'spatial' | 'generic' = 'spectrum';
    private titleText: string = 'OpenMC Plot';
    private genericFigure: PlotlyFigure | null = null;

    @postConstruct()
    protected init(): void {
        this.id = OpenMCPlotWidget.ID;
        this.title.label = OpenMCPlotWidget.LABEL;
        this.title.caption = OpenMCPlotWidget.LABEL;
        this.title.iconClass = codicon('graph');
        this.title.closable = true;

        // Ensure the widget can be focused
        this.node.tabIndex = 0;

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



    protected render(): React.ReactNode {
        if (!this.data && !this.genericFigure) {
            return (
                <div className="openmc-plot empty" style={{
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: 'var(--theia-editor-background)'
                }}>
                    <LoadingAnimations />
                    <FancyLoadingSpinner
                        message="Loading plot data..."
                        subMessage="Fetching from statepoint"
                    />
                </div>
            );
        }

        return (
            <div className="openmc-plot" style={{ 
                height: '100%', 
                display: 'flex', 
                flexDirection: 'column',
                backgroundColor: 'var(--theia-editor-background)',
                color: 'var(--theia-foreground)',
                fontFamily: 'var(--theia-ui-font-family)',
                overflow: 'hidden'
            }}>
                <div style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center', 
                    padding: '10px 20px',
                    borderBottom: '1px solid var(--theia-panel-border)'
                }}>
                    <h3 style={{ margin: 0, color: 'var(--theia-foreground)' }}>{this.titleText}</h3>
                    <div style={{ fontSize: '12px', color: 'var(--theia-descriptionForeground)' }}>
                        {this.plotType === 'spectrum' ? 'Log-Log Energy Spectrum' : 
                         this.plotType === 'spatial' ? 'Linear Spatial Distribution' : 'Plotly Figure'}
                    </div>
                </div>
                <div style={{ flex: 1, position: 'relative', minHeight: '350px', overflow: 'hidden' }}>
                    {this.plotType === 'spectrum' ? 
                        this.renderSpectrum(this.data as OpenMCSpectrumData) : 
                     this.plotType === 'spatial' ?
                        this.renderSpatial(this.data as OpenMCSpatialPlotData) :
                        this.renderGeneric(this.genericFigure!)}
                </div>
            </div>
        );
    }

    private renderGeneric(figure: PlotlyFigure): React.ReactNode {
        return <PlotlyComponent data={figure.data} layout={figure.layout} config={figure.config} />;
    }

    private renderSpectrum(data: OpenMCSpectrumData): React.ReactNode {
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

        return <PlotlyComponent data={traces} layout={layout} />;
    }

    private renderSpatial(data: OpenMCSpatialPlotData): React.ReactNode {
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

        return <PlotlyComponent data={traces} layout={layout} />;
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
