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
 * Theme-adaptive viewport colors for the CAD viewport.
 *
 * The model body follows `--theia-foreground` on dark themes (the established
 * look), but a light theme's foreground is near-black, which renders the model
 * as a silhouette on the light background. On light themes the body switches
 * to a mid steel tone and the edge lines flip from white to a dark slate so
 * both stay readable against the light editor background.
 *
 * Pure string math — no three.js or Theia imports, so vitest covers it.
 *
 * @module nuke-cad/browser/widgets/cad-viewport
 */

/** Body color on light themes: mid steel gray, readable on white. */
export const LIGHT_THEME_BODY_COLOR = '#9aa5b1';
/** Edge-line color on light themes: dark slate, readable on white. */
export const LIGHT_THEME_EDGE_COLOR = '#4a5560';
/** Edge-line color on dark themes (the historical default). */
export const DARK_THEME_EDGE_COLOR = '#ffffff';

/** Viewport background choice: theme color, fixed dark/light, or CSS gradient. */
export type ViewportBackgroundStyle = 'theme' | 'dark' | 'light' | 'gradient';

/** Fixed dark viewport background. */
export const DARK_BACKGROUND = '#1e1e1e';
/** Fixed light viewport background. */
export const LIGHT_BACKGROUND = '#f5f5f5';
/** CSS backdrop used when the background style is gradient. */
export const BACKGROUND_GRADIENT_CSS = 'linear-gradient(to bottom, #334155 0%, #000000 100%)';

/**
 * Resolve the solid scene color for a background style. Returns `undefined`
 * for gradient: the CSS backdrop shows through a transparent renderer.
 */
export function resolveViewportBackground(style: ViewportBackgroundStyle, themeBackground: string): string | undefined {
    switch (style) {
        case 'dark':
            return DARK_BACKGROUND;
        case 'light':
            return LIGHT_BACKGROUND;
        case 'gradient':
            return undefined;
        case 'theme':
        default:
            return themeBackground;
    }
}

/** Colors the 3D scene derives from the active Theia theme. */
export interface CadViewportColors {
    /** Albedo for the model's face materials. */
    readonly body: string;
    /** Color for the B-rep edge lines. */
    readonly edges: string;
}

/**
 * Parse a CSS color (`#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`) into
 * `[r, g, b]` channels in 0–1. Returns `undefined` for unparseable input.
 */
export function parseCssColor(value: string): [number, number, number] | undefined {
    const trimmed = value.trim();
    const hexMatch = trimmed.match(/^#([0-9a-fA-F]{3,8})$/);
    if (hexMatch) {
        let hex = hexMatch[1];
        if (hex.length === 3 || hex.length === 4) {
            hex = hex
                .split('')
                .map((ch) => ch + ch)
                .join('');
        }
        if (hex.length !== 6 && hex.length !== 8) {
            return undefined;
        }
        return [parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255];
    }
    const rgbMatch = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (rgbMatch) {
        return [Number(rgbMatch[1]) / 255, Number(rgbMatch[2]) / 255, Number(rgbMatch[3]) / 255];
    }
    return undefined;
}

/** Rec. 709 relative luminance of a CSS color, `undefined` when unparseable. */
export function relativeLuminance(cssColor: string): number | undefined {
    const parsed = parseCssColor(cssColor);
    if (parsed === undefined) {
        return undefined;
    }
    const linear = parsed.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/**
 * Pick the model body and edge colors for the given theme colors. A light
 * editor background (luminance above 0.5) selects the steel/slate pair;
 * anything else (or an unparseable background) keeps the dark-theme behavior
 * of using the theme foreground for the body and white edges.
 */
export function cadViewportColors(backgroundCss: string, foregroundCss: string): CadViewportColors {
    const luminance = relativeLuminance(backgroundCss);
    if (luminance !== undefined && luminance > 0.5) {
        return { body: LIGHT_THEME_BODY_COLOR, edges: LIGHT_THEME_EDGE_COLOR };
    }
    return { body: foregroundCss, edges: DARK_THEME_EDGE_COLOR };
}
