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

import { describe, expect, it } from 'vitest';
import { buildSelectionOverlay, type SelectionOverlaySource } from './selection-overlay';

const TRIANGLES: SelectionOverlaySource = {
    family: 'polydata',
    pointCount: 6,
    cellCount: 2,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 2, 0, 0, 1, 2, 0]),
    triangles: new Uint32Array([0, 1, 2, 3, 4, 5]),
    triangleCells: new Uint32Array([0, 1])
};

const LINES: SelectionOverlaySource = {
    family: 'polydata',
    pointCount: 4,
    cellCount: 2,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]),
    segments: new Uint32Array([0, 1, 2, 3]),
    segmentCells: new Uint32Array([0, 1])
};

const GRID: SelectionOverlaySource = {
    family: 'image',
    pointCount: 4,
    cellCount: 4,
    positions: new Float32Array([0.5, 0.5, 0.5, 1.5, 0.5, 0.5, 0.5, 1.5, 0.5, 1.5, 1.5, 0.5])
};

describe('buildSelectionOverlay', () => {
    it('expands selected triangle cells into local triangle geometry', () => {
        const overlay = buildSelectionOverlay(TRIANGLES, 'cell', [1]);
        expect(overlay?.points).toEqual(new Float32Array([1, 1, 0, 2, 0, 0, 1, 2, 0]));
        expect(overlay?.triangles).toEqual(new Uint32Array([0, 1, 2]));
        expect(overlay?.segments).toBeUndefined();
    });

    it('expands selected line cells into segments', () => {
        const overlay = buildSelectionOverlay(LINES, 'cell', [1]);
        expect(overlay?.points).toEqual(new Float32Array([2, 0, 0, 3, 0, 0]));
        expect(overlay?.segments).toEqual(new Uint32Array([0, 1]));
    });

    it('selects point tuples directly', () => {
        const overlay = buildSelectionOverlay(GRID, 'point', [1, 3]);
        expect(overlay?.points).toEqual(new Float32Array([1.5, 0.5, 0.5, 1.5, 1.5, 0.5]));
    });

    it('highlights grid cell centers for cell selections', () => {
        const overlay = buildSelectionOverlay(GRID, 'cell', [0, 2]);
        expect(overlay?.points).toEqual(new Float32Array([0.5, 0.5, 0.5, 0.5, 1.5, 0.5]));
    });

    it('returns undefined for empty, invalid, and out-of-range selections', () => {
        expect(buildSelectionOverlay(TRIANGLES, 'cell', [])).toBeUndefined();
        expect(buildSelectionOverlay(TRIANGLES, 'cell', [99])).toBeUndefined();
        expect(buildSelectionOverlay(TRIANGLES, 'point', [-1])).toBeUndefined();
    });

    it('deduplicates selected tuple indices', () => {
        const overlay = buildSelectionOverlay(TRIANGLES, 'cell', [0, 0, 1]);
        expect(overlay?.triangles?.length).toBe(6);
    });
});
