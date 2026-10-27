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

import { describe, expect, it } from 'vitest';
import {
    DRAWING_ZOOM_MAX,
    DRAWING_ZOOM_MIN,
    buildDrawingViewMenu,
    clampDrawingZoom,
    formatDrawingExtent,
    zoomDrawingAtPoint,
    type DrawingZoomState
} from './drawing-sheet-interactions';

const screenPointOf = (state: DrawingZoomState, stageOffset: { x: number; y: number }, center: { x: number; y: number }) => ({
    x: center.x + state.panX + stageOffset.x * state.zoom,
    y: center.y + state.panY + stageOffset.y * state.zoom
});

describe('drawing cursor-centered zoom', () => {
    const center = { x: 300, y: 200 };

    it('keeps the stage point under the cursor fixed while zooming in', () => {
        const start: DrawingZoomState = { zoom: 1, panX: 0, panY: 0 };
        const cursor = { x: 420, y: 240 };
        // Stage-space offset under the cursor before the wheel step.
        const stageOffset = { x: cursor.x - center.x - start.panX, y: cursor.y - center.y - start.panY };
        const next = zoomDrawingAtPoint(start, cursor, center, 1.12);
        expect(next.zoom).toBeCloseTo(1.12, 9);
        const screen = screenPointOf(next, stageOffset, center);
        expect(screen.x).toBeCloseTo(cursor.x, 9);
        expect(screen.y).toBeCloseTo(cursor.y, 9);
    });

    it('keeps the cursor point fixed when the stage is already panned', () => {
        const start: DrawingZoomState = { zoom: 1.4, panX: -80, panY: 35 };
        const cursor = { x: 180, y: 310 };
        const stageOffset = {
            x: (cursor.x - center.x - start.panX) / start.zoom,
            y: (cursor.y - center.y - start.panY) / start.zoom
        };
        const next = zoomDrawingAtPoint(start, cursor, center, start.zoom / 1.12);
        const screen = screenPointOf(next, stageOffset, center);
        expect(screen.x).toBeCloseTo(cursor.x, 9);
        expect(screen.y).toBeCloseTo(cursor.y, 9);
    });

    it('clamps at the zoom limits without moving the pan', () => {
        const maxed = zoomDrawingAtPoint({ zoom: DRAWING_ZOOM_MAX, panX: 12, panY: -4 }, center, center, 10);
        expect(maxed).toEqual({ zoom: DRAWING_ZOOM_MAX, panX: 12, panY: -4 });

        const minned = zoomDrawingAtPoint({ zoom: DRAWING_ZOOM_MIN, panX: -9, panY: 6 }, center, center, 0.01);
        expect(minned).toEqual({ zoom: DRAWING_ZOOM_MIN, panX: -9, panY: 6 });
    });

    it('applies the partial zoom when the request is clamped', () => {
        const start: DrawingZoomState = { zoom: 3.8, panX: 20, panY: -10 };
        const cursor = { x: 250, y: 180 };
        const stageOffset = {
            x: (cursor.x - center.x - start.panX) / start.zoom,
            y: (cursor.y - center.y - start.panY) / start.zoom
        };
        const next = zoomDrawingAtPoint(start, cursor, center, 8);
        expect(next.zoom).toBe(DRAWING_ZOOM_MAX);
        const screen = screenPointOf(next, stageOffset, center);
        expect(screen.x).toBeCloseTo(cursor.x, 9);
        expect(screen.y).toBeCloseTo(cursor.y, 9);
    });

    it('maps non-finite zoom requests back to 100% and clamps helpers', () => {
        expect(clampDrawingZoom(Number.NaN)).toBe(1);
        expect(clampDrawingZoom(0.1)).toBe(DRAWING_ZOOM_MIN);
        expect(clampDrawingZoom(12)).toBe(DRAWING_ZOOM_MAX);
    });
});

describe('drawing selected-view status', () => {
    it('formats naked linework extents with one decimal and trims whole numbers', () => {
        expect(formatDrawingExtent({ width: 13.34, height: 13 })).toBe('13.3 × 13 mm');
        expect(formatDrawingExtent({ width: 0.63, height: 0.63 })).toBe('0.6 × 0.6 mm');
        expect(formatDrawingExtent({ width: Number.NaN, height: 1 })).toBe('—');
    });
});

describe('drawing view context menu', () => {
    const labels = (items: ReturnType<typeof buildDrawingViewMenu>): string[] => items.map((item) => item.label);

    it('offers fit, hidden lines, the four common scales, Scale…, and delete', () => {
        const items = buildDrawingViewMenu({ scale: 0.5, showHidden: false });
        expect(labels(items)).toEqual(['Fit view', 'Show hidden lines', '1:1', '1:2', '2:1', '5:1', 'Scale…', 'Delete view']);
        expect(items[0].icon).toBe('codicon-screen-full');
        expect(items[0].action).toEqual({ kind: 'fitView' });
        expect(items[1].action).toEqual({ kind: 'toggleHidden' });
        expect(items[2].separatorAbove).toBe(true);
        expect(items[3].icon).toBe('codicon-check');
        expect(items[2].icon).toBe('codicon-symbol-ruler');
        expect(items[3].action).toEqual({ kind: 'setScale', scale: 0.5 });
        expect(items[6].action).toEqual({ kind: 'focusScale' });
        expect(items[7].separatorAbove).toBe(true);
        expect(items[7].action).toEqual({ kind: 'deleteView' });
    });

    it('flips the hidden-line item and marks the current scale', () => {
        const hidden = buildDrawingViewMenu({ scale: 2, showHidden: true });
        expect(hidden[1].label).toBe('Hide hidden lines');
        expect(hidden[1].icon).toBe('codicon-eye-closed');
        expect(hidden.find((item) => item.label === '2:1')?.icon).toBe('codicon-check');
        expect(hidden.find((item) => item.label === '1:2')?.icon).toBe('codicon-symbol-ruler');
    });
});
