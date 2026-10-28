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

/**
 * Shared Plotly theming: follows Theia's body theme class and resolves the
 * CSS variables Plotly needs as concrete colors (canvas/SVG cannot use
 * `var(...)`), with deterministic fallbacks for SSR and node test runs.
 */

import * as React from 'react';

/** NukeIDE's light/dark Plotly surface. */
export type PlotlyTheme = 'dark' | 'light';

/** Concrete theme colors shared by every Plotly layout. */
export interface PlotlyThemeColors {
    readonly foreground: string;
    readonly descriptionForeground: string;
    readonly panelBorder: string;
    readonly editorBackground: string;
    readonly editorWidgetBackground: string;
}

const FALLBACK_COLORS: Record<PlotlyTheme, PlotlyThemeColors> = {
    dark: {
        foreground: '#d4d4d4',
        descriptionForeground: '#9e9e9e',
        panelBorder: '#3c3c3c',
        editorBackground: '#1e1e1e',
        editorWidgetBackground: '#252526'
    },
    light: {
        foreground: '#333333',
        descriptionForeground: '#666666',
        panelBorder: '#dddddd',
        editorBackground: '#ffffff',
        editorWidgetBackground: '#f3f3f3'
    }
};

/** Dark unless the Theia body theme explicitly marks light/high-contrast-light. */
export function detectPlotlyTheme(): PlotlyTheme {
    if (typeof document === 'undefined' || !document.body) {
        return 'dark';
    }
    const classes = document.body.classList;
    return classes.contains('theia-light') || classes.contains('theia-hcLight') ? 'light' : 'dark';
}

/** Follow Theia's body theme class without injecting ThemeService. */
export function usePlotlyTheme(): PlotlyTheme {
    const [theme, setTheme] = React.useState<PlotlyTheme>(detectPlotlyTheme);
    React.useEffect(() => {
        if (typeof document === 'undefined' || !document.body || typeof MutationObserver === 'undefined') {
            return;
        }
        const observer = new MutationObserver(() => setTheme(detectPlotlyTheme()));
        observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);
    return theme;
}

function readCssVariable(name: string): string | undefined {
    if (typeof document === 'undefined' || !document.body || typeof getComputedStyle !== 'function') {
        return undefined;
    }
    const value = getComputedStyle(document.body).getPropertyValue(name).trim();
    return value.length > 0 ? value : undefined;
}

/** Resolve concrete theme colors from Theia CSS variables with stable fallbacks. */
export function resolvePlotlyThemeColors(theme: PlotlyTheme): PlotlyThemeColors {
    const fallbacks = FALLBACK_COLORS[theme];
    return {
        foreground: readCssVariable('--theia-foreground') ?? fallbacks.foreground,
        descriptionForeground: readCssVariable('--theia-descriptionForeground') ?? fallbacks.descriptionForeground,
        panelBorder: readCssVariable('--theia-panel-border') ?? fallbacks.panelBorder,
        editorBackground: readCssVariable('--theia-editor-background') ?? fallbacks.editorBackground,
        editorWidgetBackground: readCssVariable('--theia-editorWidget-background') ?? fallbacks.editorWidgetBackground
    };
}
