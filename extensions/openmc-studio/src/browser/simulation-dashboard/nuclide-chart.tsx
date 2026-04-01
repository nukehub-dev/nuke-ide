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
import { PlotlyComponent } from 'nuke-visualizer/lib/browser/plotly/plotly-component';

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
