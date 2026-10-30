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
 * Pure toolbar state model for the native 3D viewer core.
 *
 * Mirrors the trame `UIComponents` factory in
 * `python/plugins/base/lib/common.py` for the controls the native viewers
 * actually surface (color-by + colormap selectors, opacity / point-size /
 * line-width sliders, background picker, ortho toggle, screenshot status)
 * without trame or vuetify: plain types plus defaults.
 *
 * Scalar defaults match `DEFAULT_STATE`; slider ranges match the
 * `UIComponents.*_slider` factory defaults; the camera view list matches
 * `VIEW_TYPES`.
 *
 * Pure functions + types only; no trame, no vuetify, no DOM.
 */

/** Color-by value for uncolored geometry. */
export const SOLID_COLOR = 'Solid Color';

/** Prefix for point-data array color-by values (`Point: <array>`). */
export const POINT_COLOR_PREFIX = 'Point: ';

/** Prefix for cell-data array color-by values (`Cell: <array>`). */
export const CELL_COLOR_PREFIX = 'Cell: ';

/** Which dataset attribute a color-by value addresses. */
export type ColorByKind = 'solid' | 'point' | 'cell';

/** Parsed form of a color-by string. */
export interface ParsedColorBy {
    readonly kind: ColorByKind;
    /** Array name for point/cell kinds, null for solid color. */
    readonly arrayName: string | null;
}

/**
 * Parse a color-by string (`Solid Color|Point: <name>|Cell: <name>`, the
 * format accepted by `base.serve --color-by`).
 */
export function parseColorBy(value: string): ParsedColorBy {
    if (value.startsWith(POINT_COLOR_PREFIX)) {
        return { kind: 'point', arrayName: value.slice(POINT_COLOR_PREFIX.length) };
    }
    if (value.startsWith(CELL_COLOR_PREFIX)) {
        return { kind: 'cell', arrayName: value.slice(CELL_COLOR_PREFIX.length) };
    }
    return { kind: 'solid', arrayName: null };
}

/** Format a point-data array color-by value. */
export function formatPointColorBy(arrayName: string): string {
    return `${POINT_COLOR_PREFIX}${arrayName}`;
}

/** Format a cell-data array color-by value. */
export function formatCellColorBy(arrayName: string): string {
    return `${CELL_COLOR_PREFIX}${arrayName}`;
}

/** Range + default of one toolbar slider (mirrors the factory defaults). */
export interface SliderSpec {
    readonly min: number;
    readonly max: number;
    readonly step: number;
    readonly defaultValue: number;
}

/** Opacity slider: min 0, max 1, step 0.05, default 1.0. */
export const OPACITY_SPEC: SliderSpec = { min: 0, max: 1, step: 0.05, defaultValue: 1.0 };

/** Point-size slider: min 1, max 20, step 0.5, default 2.0. */
export const POINT_SIZE_SPEC: SliderSpec = { min: 1, max: 20, step: 0.5, defaultValue: 2.0 };

/** Line-width slider: min 0.5, max 10, step 0.5, default 1.0. */
export const LINE_WIDTH_SPEC: SliderSpec = { min: 0.5, max: 10, step: 0.5, defaultValue: 1.0 };

/**
 * Clamp a value into a slider range and snap it to the slider step.
 * Keeps toolbar-driven material props inside the trame slider bounds.
 */
export function clampSliderValue(value: number, spec: SliderSpec): number {
    const clamped = Math.min(spec.max, Math.max(spec.min, value));
    const steps = Math.round((clamped - spec.min) / spec.step);
    const snapped = spec.min + steps * spec.step;
    return Math.min(spec.max, Math.max(spec.min, Number(snapped.toFixed(6))));
}

/** Camera preset views offered by the camera buttons (`VIEW_TYPES`). */
export const CAMERA_VIEWS = ['isometric', 'front', 'back', 'left', 'right', 'top', 'bottom'] as const;

/** One camera preset view. */
export type CameraView = (typeof CAMERA_VIEWS)[number];

/**
 * Full toolbar state. Field defaults match `DEFAULT_STATE` in
 * `python/plugins/base/lib/common.py`; `colormap` accepts any ParaView
 * preset name and defaults to the trame default `Cool to Warm`.
 */
export interface ViewerToolbarState {
    /** Color-by string (`Solid Color|Point: <name>|Cell: <name>`). */
    readonly colorBy: string;
    /** ParaView preset name; the full LUT pack lives in `colormaps.ts`. */
    readonly colormap: string;
    readonly showScalarBar: boolean;
    readonly opacity: number;
    readonly pointSize: number;
    readonly lineWidth: number;
    /** Background color as a hex string (`background_color_hex`). */
    readonly background: string;
    /** Ortho toggle state (`parallel_projection`). */
    readonly parallelProjection: boolean;
    /** Screenshot status line shown under the screenshot button. */
    readonly screenshotStatus: string;
}

/** Default toolbar state (matches `DEFAULT_STATE`). */
export const DEFAULT_VIEWER_TOOLBAR_STATE: ViewerToolbarState = {
    colorBy: SOLID_COLOR,
    colormap: 'Cool to Warm',
    showScalarBar: false,
    opacity: 1.0,
    pointSize: 2.0,
    lineWidth: 1.0,
    background: '#1a1a26',
    parallelProjection: false,
    screenshotStatus: ''
};

/** Fresh copy of the default toolbar state. */
export function createDefaultToolbarState(): ViewerToolbarState {
    return { ...DEFAULT_VIEWER_TOOLBAR_STATE };
}

/**
 * Return a copy of `state` with the given fields replaced.
 * Numeric slider fields are clamped/snapped to their slider specs so the
 * model can never hold values the trame sliders could not produce.
 */
export function updateToolbarState(state: ViewerToolbarState, patch: Partial<ViewerToolbarState>): ViewerToolbarState {
    const next: ViewerToolbarState = { ...state, ...patch };
    if (patch.opacity !== undefined) {
        return { ...next, opacity: clampSliderValue(patch.opacity, OPACITY_SPEC) };
    }
    if (patch.pointSize !== undefined) {
        return { ...next, pointSize: clampSliderValue(patch.pointSize, POINT_SIZE_SPEC) };
    }
    if (patch.lineWidth !== undefined) {
        return { ...next, lineWidth: clampSliderValue(patch.lineWidth, LINE_WIDTH_SPEC) };
    }
    return next;
}

/** Runtime guard for camera view values. */
export function isCameraView(value: string): value is CameraView {
    return (CAMERA_VIEWS as readonly string[]).includes(value);
}
