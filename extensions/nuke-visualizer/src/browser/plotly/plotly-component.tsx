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
import * as Plotly from 'plotly.js-dist-min';
import { PlotlyTheme, PlotlyThemeColors, resolvePlotlyThemeColors, usePlotlyTheme } from './plotly-theme';

const PLOTLY_NOTIFIER_CSS = `
    .plotly-notifier { display: none !important; }
    .plotly-notifier-cn { display: none !important; }
    .js-plotly-plot .plotly .modebar { display: block !important; }
    [class*="notifier"] { display: none !important; }
`;

const DEFAULT_FONT_FAMILY = 'var(--theia-ui-font-family), Segoe UI, Tahoma, Geneva, Verdana, sans-serif';

export interface PlotlyComponentProps {
    data: Partial<Plotly.Data>[];
    layout?: Partial<Plotly.Layout>;
    config?: Partial<Plotly.Config>;
    /** Force a theme instead of following Theia's body theme class. */
    theme?: PlotlyTheme;
    style?: React.CSSProperties;
    className?: string;
}

/**
 * Merge the caller's axis options with the active theme's colors. Every
 * non-color option (type, ranges, domains, titles, tick settings, ...) is
 * preserved; only the primary-axis colors are theme-owned.
 */
function themedAxis(caller: Partial<Plotly.Axis> | undefined, colors: PlotlyThemeColors): Partial<Plotly.Axis> {
    const merged: Partial<Plotly.Axis> = {
        type: 'linear',
        exponentformat: 'e',
        showgrid: true,
        ...(caller ?? {})
    };
    const callerTitle = merged.title as Partial<Plotly.DataTitle> | string | undefined;
    const title: Partial<Plotly.DataTitle> = typeof callerTitle === 'string' ? { text: callerTitle } : { ...(callerTitle ?? {}) };
    return {
        ...merged,
        color: colors.panelBorder,
        gridcolor: colors.panelBorder,
        zerolinecolor: colors.panelBorder,
        linecolor: colors.panelBorder,
        tickcolor: colors.panelBorder,
        tickfont: { ...(merged.tickfont ?? {}), color: colors.descriptionForeground },
        title: {
            ...title,
            font: { ...(title.font ?? {}), color: colors.foreground }
        }
    };
}

/**
 * A more robust Plotly component that uses a ref and Plotly.newPlot directly.
 * This ensures compatibility with Theia's Lumino layout system.
 */
export const PlotlyComponent: React.FC<PlotlyComponentProps> = (props) => {
    const { data, layout, config, theme, style, className } = props;
    const detectedTheme = usePlotlyTheme();
    const activeTheme = theme ?? detectedTheme;
    const colors = resolvePlotlyThemeColors(activeTheme);
    const colorSignature = [
        colors.foreground,
        colors.descriptionForeground,
        colors.panelBorder,
        colors.editorBackground,
        colors.editorWidgetBackground
    ].join('|');
    const plotRef = React.useRef<HTMLDivElement>(null);
    const containerRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        const styleEl = document.createElement('style');
        styleEl.textContent = PLOTLY_NOTIFIER_CSS;
        document.head.appendChild(styleEl);

        const observer = new MutationObserver(() => {
            document.querySelectorAll('.plotly-notifier, .js-plotly-notifier').forEach((el) => {
                (el as HTMLElement).style.display = 'none';
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });

        return () => {
            document.head.removeChild(styleEl);
            observer.disconnect();
        };
    }, []);

    const defaultLayout: Partial<Plotly.Layout> = {
        autosize: true,
        template: (activeTheme === 'dark' ? 'plotly_dark' : 'plotly_white') as any,
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        font: {
            color: colors.foreground,
            family: DEFAULT_FONT_FAMILY
        },
        margin: { t: 40, r: 40, b: 60, l: 80 },
        showlegend: true,
        legend: {
            font: { color: colors.foreground },
            bgcolor: colors.editorWidgetBackground,
            bordercolor: colors.panelBorder,
            borderwidth: 1,
            x: 0.02,
            y: 0.98
        },
        xaxis: themedAxis(undefined, colors),
        yaxis: themedAxis(undefined, colors),
        modebar: {
            bgcolor: 'transparent',
            color: colors.descriptionForeground,
            activecolor: colors.foreground
        }
    };

    const combinedLayout: Partial<Plotly.Layout> = {
        ...defaultLayout,
        ...layout,
        template: (activeTheme === 'dark' ? 'plotly_dark' : 'plotly_white') as any,
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        font: {
            ...(defaultLayout.font ?? {}),
            ...(layout?.font ?? {}),
            color: colors.foreground
        },
        legend: {
            ...(defaultLayout.legend ?? {}),
            ...(layout?.legend ?? {}),
            font: {
                ...(layout?.legend?.font ?? {}),
                color: colors.foreground
            },
            bgcolor: colors.editorWidgetBackground,
            bordercolor: colors.panelBorder
        },
        modebar: {
            ...(layout?.modebar ?? {}),
            bgcolor: 'transparent',
            color: colors.descriptionForeground,
            activecolor: colors.foreground
        },
        xaxis: themedAxis(layout?.xaxis, colors),
        yaxis: themedAxis(layout?.yaxis, colors)
    };

    const combinedConfig: Partial<Plotly.Config> = {
        responsive: true,
        displayModeBar: true,
        modeBarButtonsToRemove: ['lasso2d', 'select2d'],
        displaylogo: false,
        toImageButtonOptions: {
            format: 'png',
            filename: 'plot',
            height: 600,
            width: 800,
            scale: 2
        },
        ...config
    };

    React.useEffect(() => {
        if (plotRef.current) {
            // Suppress Plotly.js global errors/warnings in console
            const originalError = console.error;
            console.error = (...args: any[]) => {
                if (args[0] && typeof args[0] === 'string' && args[0].includes('Plotly')) {
                    return;
                }
                originalError.apply(console, args);
            };

            Plotly.react(plotRef.current, data as any, combinedLayout as any, combinedConfig as any);

            // Restore console.error
            console.error = originalError;

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
    }, [data, layout, config, activeTheme, colorSignature]);

    return (
        <div
            ref={containerRef}
            style={{
                width: style?.width || '100%',
                height: style?.height || '100%',
                position: 'relative',
                overflow: 'hidden'
            }}
            className={className}
        >
            <div
                ref={plotRef}
                style={{
                    width: '100%',
                    height: '100%'
                }}
            />
        </div>
    );
};
