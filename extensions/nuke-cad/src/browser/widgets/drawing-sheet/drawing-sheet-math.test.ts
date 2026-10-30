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
 * Placement-math and label-offset acceptance for the drawing-sheet widget
 *
 * The widget renders these pure helpers from `common/cad-drawing`; drag,
 * snap, alignment lock, and label deconflict are verified here without DOM.
 */
import { describe, it, expect } from 'vitest';
import {
    DRAWING_DEFAULT_LABEL_OFFSET,
    DRAWING_GRID_SNAP_MM,
    clampDrawingLabel,
    clampSheetPosition,
    formatDrawingScale,
    layoutDrawingLabels,
    lockProjectedViewPosition,
    pointerToSheetMm,
    sheetDimensions,
    snapDrawingPosition
} from '../../../common/cad-drawing';

describe('drawing-sheet placement math', () => {
    it('formats view scales as drafting ratios', () => {
        expect(formatDrawingScale(1)).toBe('1:1');
        expect(formatDrawingScale(0.5)).toBe('1:2');
        expect(formatDrawingScale(0.25)).toBe('1:4');
        expect(formatDrawingScale(2)).toBe('2:1');
        expect(formatDrawingScale(1.5)).toBe('1.5:1');
        expect(formatDrawingScale(0)).toBe('?');
        expect(formatDrawingScale(Number.NaN)).toBe('?');
    });

    it('snaps drag positions to the 5 mm grid', () => {
        expect(DRAWING_GRID_SNAP_MM).toBe(5);
        // A full drag pipeline: pointer mm -> snap -> clamp on A4.
        const { width, height } = sheetDimensions('A4');
        const pointer: [number, number] = [123.4, 67.8];
        const snapped = clampSheetPosition([snapDrawingPosition(pointer[0]), snapDrawingPosition(pointer[1])], width, height);
        expect(snapped).toEqual([125, 70]);
    });

    it('keeps snapped positions on A3 sheets', () => {
        const { width, height } = sheetDimensions('A3');
        expect(clampSheetPosition([snapDrawingPosition(419), snapDrawingPosition(296)], width, height)).toEqual([420, 295]);
        expect(clampSheetPosition([snapDrawingPosition(500), snapDrawingPosition(-3)], width, height)).toEqual([420, 0]);
    });

    it('locks a dragged projected view to its parent alignment axis', () => {
        const parent: [number, number] = [148.5, 105];
        // Top view dragged freely: x snaps back to the parent.
        const candidate: [number, number] = [snapDrawingPosition(162.3), snapDrawingPosition(171.1)];
        expect(lockProjectedViewPosition('top', parent, candidate)).toEqual([148.5, 170]);
        // Right view: y snaps back to the parent.
        expect(lockProjectedViewPosition('right', parent, candidate)).toEqual([160, 105]);
    });

    it('maps pointer drag deltas through the sheet rect', () => {
        // Full-bleed A4 SVG at 2x scale: 10 client px == 5 sheet mm.
        const rect = { left: 0, top: 0, width: 594, height: 420 };
        const start = pointerToSheetMm(200, 200, rect, 297, 210);
        const end = pointerToSheetMm(220, 180, rect, 297, 210);
        expect(end[0] - start[0]).toBeCloseTo(10, 9);
        expect(end[1] - start[1]).toBeCloseTo(10, 9);
    });
});

describe('drawing-sheet label offsets', () => {
    it('places new dimension labels above the owning view by default', () => {
        const view: [number, number] = [100, 100];
        const anchor: [number, number] = [view[0] + DRAWING_DEFAULT_LABEL_OFFSET[0], view[1] + DRAWING_DEFAULT_LABEL_OFFSET[1]];
        expect(anchor).toEqual([100, 112]);
    });

    it('auto-shifts stacked labels while pinned labels stay out of the layout', () => {
        // Only unpinned labels enter the layout (pinned ones opt out, per the
        // sketch dimension-label pattern); the stack resolves the collision.
        const laidOut = layoutDrawingLabels(
            [
                { id: 'dim-1', x: 100, y: 112, width: 24, height: 8 },
                { id: 'dim-2', x: 100, y: 112, width: 24, height: 8 }
            ],
            297,
            210
        );
        expect(laidOut.get('dim-1')).toEqual({ x: 100, y: 112 });
        expect(laidOut.get('dim-2')!.y).toBeGreaterThan(112);
    });

    it('clamps label centers so boxes stay on the sheet', () => {
        expect(clampDrawingLabel(290, 205, 24, 8, 297, 210)).toEqual({ x: 285, y: 205 });
        expect(clampDrawingLabel(2, 2, 24, 8, 297, 210)).toEqual({ x: 12, y: 4 });
    });
});
