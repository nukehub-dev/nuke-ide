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
import * as Plotly from 'plotly.js-dist-min';

export interface PlotlyComponentProps {
    data: Partial<Plotly.Data>[];
    layout?: Partial<Plotly.Layout>;
    config?: Partial<Plotly.Config>;
    theme?: 'dark' | 'light';
    style?: React.CSSProperties;
    className?: string;
}

/**
 * A more robust Plotly component that uses a ref and Plotly.newPlot directly.
 * This ensures compatibility with Theia's Lumino layout system.
 */
export const PlotlyComponent: React.FC<PlotlyComponentProps> = (props) => {
    const { data, layout, config, theme = 'dark', style, className } = props;
    const plotRef = React.useRef<HTMLDivElement>(null);

    const getAxisDefaults = (type: any = 'linear'): Partial<Plotly.Axis> => ({
        type,
        exponentformat: 'e',
        showgrid: true,
        gridcolor: theme === 'dark' ? '#333333' : '#eeeeee',
        zerolinecolor: theme === 'dark' ? '#444444' : '#dddddd',
        linecolor: theme === 'dark' ? '#555555' : '#cccccc',
        tickcolor: theme === 'dark' ? '#555555' : '#cccccc',
        tickfont: { color: theme === 'dark' ? '#888888' : '#666666' },
        title: {
            font: { color: theme === 'dark' ? '#cccccc' : '#333333' }
        }
    });

    const defaultLayout: Partial<Plotly.Layout> = {
        autosize: true,
        template: (theme === 'dark' ? 'plotly_dark' : 'plotly_white') as any,
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        font: {
            color: theme === 'dark' ? '#cccccc' : '#333333',
            family: 'Segoe UI, Tahoma, Geneva, Verdana, sans-serif'
        },
        margin: { t: 40, r: 40, b: 60, l: 80 },
        showlegend: true,
        legend: {
            font: { color: theme === 'dark' ? '#cccccc' : '#333333' },
            bgcolor: 'rgba(0,0,0,0)'
        },
        xaxis: { ...getAxisDefaults(layout?.xaxis?.type), automargin: true },
        yaxis: { ...getAxisDefaults(layout?.yaxis?.type), automargin: true }
    };

    const combinedLayout = {
        ...defaultLayout,
        ...layout,
        xaxis: { ...defaultLayout.xaxis, ...layout?.xaxis },
        yaxis: { ...defaultLayout.yaxis, ...layout?.yaxis },
        template: (theme === 'dark' ? 'plotly_dark' : 'plotly_white') as any,
    };

    const combinedConfig: Partial<Plotly.Config> = {
        responsive: true,
        displayModeBar: true,
        modeBarButtonsToRemove: [], // Enable all default buttons including 'toImage'
        displaylogo: false,
        ...config
    };

    React.useEffect(() => {
        if (plotRef.current) {
            Plotly.react(plotRef.current, data as any, combinedLayout as any, combinedConfig as any);
            
            // Handle window resize events
            const onResize = () => {
                if (plotRef.current) {
                    Plotly.Plots.resize(plotRef.current);
                }
            };
            window.addEventListener('resize', onResize);
            
            return () => {
                window.removeEventListener('resize', onResize);
            };
        }
    }, [data, layout, theme, config]);

    return (
        <div 
            ref={plotRef}
            style={style || { width: '100%', height: '100%' }}
            className={className}
        />
    );
};
