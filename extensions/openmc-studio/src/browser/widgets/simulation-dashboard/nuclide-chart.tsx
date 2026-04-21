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

/**
 * @module openmc-studio/browser/widgets
 */

import * as React from 'react';
import { PlotlyComponent } from 'nuke-visualizer/lib/browser/plotly/plotly-component';

/**
 * Placeholder nuclide concentration chart using Plotly.
 *
 * Displays sample U-235 and Pu-239 concentration trends over time steps.
 * This is a temporary visualization pending real depletion data integration.
 *
 * @see {@link PlotlyComponent} for the underlying Plotly wrapper
 */
export const NuclideChart: React.FC = () => {
    // Placeholder data for the chart
    const data = [
        {
            x: [0, 1, 2, 3, 4, 5],
            y: [100, 95, 90, 86, 82, 79],
            type: 'scatter',
            mode: 'lines+markers',
            name: 'U235',
            line: { color: '#3498db', width: 3 },
            marker: { size: 8 }
        },
        {
            x: [0, 1, 2, 3, 4, 5],
            y: [0, 2, 5, 8, 12, 15],
            type: 'scatter',
            mode: 'lines+markers',
            name: 'Pu239',
            line: { color: '#e74c3c', width: 3 },
            marker: { size: 8 }
        }
    ];

    const layout = {
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        xaxis: { 
            title: 'Time Steps',
            gridcolor: 'var(--theia-panel-border)',
            zerolinecolor: 'var(--theia-panel-border)'
        },
        yaxis: { 
            title: 'Concentration (atom/b-cm)',
            gridcolor: 'var(--theia-panel-border)',
            zerolinecolor: 'var(--theia-panel-border)'
        },
        margin: { t: 20, r: 20, b: 40, l: 60 },
        autosize: true,
        showlegend: true,
        legend: {
            orientation: 'h',
            y: -0.2,
            x: 0.5,
            xanchor: 'center'
        },
        font: {
            color: 'var(--theia-foreground)',
            family: 'var(--theia-ui-font-family)'
        }
    };

    const config = {
        responsive: true,
        displayModeBar: false, // Disable modebar to prevent overflow
    };

    return (
        <div className='nuclide-chart-section'>
            <div className='nuclide-chart-container'>
                <PlotlyComponent 
                    data={data as any} 
                    layout={layout as any} 
                    config={config as any}
                />
            </div>
        </div>
    );
};
