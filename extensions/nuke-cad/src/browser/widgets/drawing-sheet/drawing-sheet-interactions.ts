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
 * Pure interaction math and menu model for the drawing sheet canvas.
 *
 * The stage renders with `translate(pan) scale(zoom)` and a center transform
 * origin (`drawing-sheet.css`), so pointer-anchored zoom is a plain 2D
 * affine correction around the stage center. Keeping it here lets vitest
 * verify the cursor point stays fixed without a DOM.
 *
 * @module nuke-cad/browser/widgets/drawing-sheet
 */

import { formatDrawingScale } from '../../../common/cad-drawing';
import type { ContextMenuItem } from '../cad-viewport/viewport-context-menu';

/** Canvas zoom limits shared by the wheel and toolbar paths. */
export const DRAWING_ZOOM_MIN = 0.4;
export const DRAWING_ZOOM_MAX = 4;

/** Scale entries offered by the view context menu (view multiplier). */
export const DRAWING_VIEW_MENU_SCALES: readonly number[] = [1, 0.5, 2, 5];

/** Pan/zoom state of the drawing stage. */
export interface DrawingZoomState {
    readonly zoom: number;
    readonly panX: number;
    readonly panY: number;
}

/** Canvas-relative point (CSS pixels). */
export interface DrawingCanvasPoint {
    readonly x: number;
    readonly y: number;
}

/** Clamp a zoom factor to the drawing canvas limits. */
export function clampDrawingZoom(zoom: number): number {
    return Math.min(Math.max(Number.isFinite(zoom) ? zoom : 1, DRAWING_ZOOM_MIN), DRAWING_ZOOM_MAX);
}

/**
 * Zoom around a canvas point while keeping that point stationary.
 *
 * The stage center is `center`, the cursor is `cursor`, and the stage maps a
 * stage-space point `p` to `center + pan + (p - center) * zoom`. Solving for
 * the new pan that keeps the cursor's stage point fixed gives
 * `pan' = (cursor - center) - (cursor - center - pan) * (zoom' / zoom)`.
 */
export function zoomDrawingAtPoint(
    state: DrawingZoomState,
    cursor: DrawingCanvasPoint,
    center: DrawingCanvasPoint,
    requestedZoom: number
): DrawingZoomState {
    const zoom = clampDrawingZoom(requestedZoom);
    if (zoom === state.zoom) {
        return { zoom, panX: state.panX, panY: state.panY };
    }
    const ratio = zoom / state.zoom;
    return {
        zoom,
        panX: cursor.x - center.x - (cursor.x - center.x - state.panX) * ratio,
        panY: cursor.y - center.y - (cursor.y - center.y - state.panY) * ratio
    };
}

/** Linework extent shown in the selected-view status segment. */
export interface DrawingLineworkExtent {
    readonly width: number;
    readonly height: number;
}

/** Format a linework extent as `13.3 × 13 mm` (one decimal, trailing zero trimmed). */
export function formatDrawingExtent(extent: DrawingLineworkExtent): string {
    if (!Number.isFinite(extent.width) || !Number.isFinite(extent.height)) {
        return '—';
    }
    const format = (value: number): string => value.toFixed(1).replace(/\.0$/, '');
    return `${format(extent.width)} × ${format(extent.height)} mm`;
}

/** Actions the drawing widget dispatches for a view menu item. */
export type DrawingViewMenuAction =
    | { readonly kind: 'fitView' }
    | { readonly kind: 'toggleHidden' }
    | { readonly kind: 'setScale'; readonly scale: number }
    | { readonly kind: 'focusScale' }
    | { readonly kind: 'deleteView' };

export interface DrawingViewMenuInput {
    /** Current view scale multiplier (1 = 1:1). */
    readonly scale: number;
    readonly showHidden?: boolean;
}

/**
 * Compact view menu: Fit, hidden-line toggle, the four common drafting
 * scales, an inspector-scale shortcut, and Delete. The shared renderer
 * (`openContextMenu`) supplies the panel/pointer/Escape grammar.
 */
export function buildDrawingViewMenu(input: DrawingViewMenuInput): readonly ContextMenuItem<DrawingViewMenuAction>[] {
    const showHidden = input.showHidden === true;
    return [
        { label: 'Fit view', icon: 'codicon-screen-full', action: { kind: 'fitView' } },
        {
            label: showHidden ? 'Hide hidden lines' : 'Show hidden lines',
            icon: showHidden ? 'codicon-eye-closed' : 'codicon-eye',
            action: { kind: 'toggleHidden' }
        },
        ...DRAWING_VIEW_MENU_SCALES.map((scale, index) => ({
            label: formatDrawingScale(scale),
            icon: Math.abs(input.scale - scale) < 1e-9 ? 'codicon-check' : 'codicon-symbol-ruler',
            separatorAbove: index === 0 ? true : undefined,
            action: { kind: 'setScale', scale } as const
        })),
        { label: 'Scale…', icon: 'codicon-settings-gear', action: { kind: 'focusScale' } },
        { label: 'Delete view', icon: 'codicon-trash', separatorAbove: true, action: { kind: 'deleteView' } }
    ];
}
