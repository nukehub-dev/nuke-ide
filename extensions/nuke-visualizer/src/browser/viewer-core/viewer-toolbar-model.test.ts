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
 * Tests for the viewer toolbar model, the ortho toggle, and the canvas
 * screenshot helper. Expected defaults mirror `DEFAULT_STATE` in
 * `python/plugins/base/lib/common.py`.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import {
    CAMERA_VIEWS,
    CELL_COLOR_PREFIX,
    DEFAULT_VIEWER_TOOLBAR_STATE,
    LINE_WIDTH_SPEC,
    OPACITY_SPEC,
    POINT_COLOR_PREFIX,
    POINT_SIZE_SPEC,
    SOLID_COLOR,
    clampSliderValue,
    createDefaultToolbarState,
    formatCellColorBy,
    formatPointColorBy,
    isCameraView,
    parseColorBy,
    updateToolbarState
} from './viewer-toolbar-model';
import { isOrthographic, setParallelProjection, toggleParallelProjection } from './ortho-projection';
import { SCREENSHOT_MIME_TYPE, buildScreenshotFilename, canvasToDataUrl, downloadCanvasScreenshot } from './canvas-screenshot';

describe('viewer toolbar model', () => {
    it('matches the trame VisualizerState defaults', () => {
        expect(DEFAULT_VIEWER_TOOLBAR_STATE).toEqual({
            colorBy: 'Solid Color',
            colormap: 'Cool to Warm',
            showScalarBar: false,
            opacity: 1.0,
            pointSize: 2.0,
            lineWidth: 1.0,
            background: '#1a1a26',
            parallelProjection: false,
            screenshotStatus: ''
        });
    });

    it('creates independent default copies', () => {
        const first = createDefaultToolbarState();
        const second = createDefaultToolbarState();
        expect(first).toEqual(second);
        expect(first).not.toBe(second);
    });

    it('lists the trame camera views', () => {
        expect([...CAMERA_VIEWS]).toEqual(['isometric', 'front', 'back', 'left', 'right', 'top', 'bottom']);
        expect(isCameraView('top')).toBe(true);
        expect(isCameraView('iso')).toBe(false);
    });

    it('round-trips the trame color-by string format', () => {
        expect(parseColorBy(SOLID_COLOR)).toEqual({ kind: 'solid', arrayName: null });
        expect(parseColorBy(`${POINT_COLOR_PREFIX}Temperature`)).toEqual({ kind: 'point', arrayName: 'Temperature' });
        expect(parseColorBy(`${CELL_COLOR_PREFIX}material`)).toEqual({ kind: 'cell', arrayName: 'material' });
        expect(formatPointColorBy('Temperature')).toBe('Point: Temperature');
        expect(formatCellColorBy('material')).toBe('Cell: material');
    });

    it('pins the trame slider specs', () => {
        expect(OPACITY_SPEC).toEqual({ min: 0, max: 1, step: 0.05, defaultValue: 1.0 });
        expect(POINT_SIZE_SPEC).toEqual({ min: 1, max: 20, step: 0.5, defaultValue: 2.0 });
        expect(LINE_WIDTH_SPEC).toEqual({ min: 0.5, max: 10, step: 0.5, defaultValue: 1.0 });
    });

    it('clamps and snaps slider values', () => {
        expect(clampSliderValue(0.53, OPACITY_SPEC)).toBeCloseTo(0.55, 10);
        expect(clampSliderValue(99, OPACITY_SPEC)).toBe(1);
        expect(clampSliderValue(-3, POINT_SIZE_SPEC)).toBe(1);
        expect(clampSliderValue(2.26, POINT_SIZE_SPEC)).toBe(2.5);
    });

    it('applies patches immutably with slider clamping', () => {
        const state = createDefaultToolbarState();
        const next = updateToolbarState(state, { opacity: 99, colorBy: 'Point: flux' });
        expect(next.opacity).toBe(1);
        expect(next.colorBy).toBe('Point: flux');
        expect(state.opacity).toBe(1.0);
        expect(state.colorBy).toBe('Solid Color');
    });
});

describe('ortho projection toggle', () => {
    it('reads, sets, and flips the parallel-projection flag', () => {
        const state = createDefaultToolbarState();
        expect(isOrthographic(state)).toBe(false);
        const ortho = toggleParallelProjection(state);
        expect(isOrthographic(ortho)).toBe(true);
        expect(isOrthographic(state)).toBe(false);
        expect(isOrthographic(setParallelProjection(ortho, false))).toBe(false);
    });
});

describe('canvas screenshot', () => {
    const originalDocument = globalThis.document;

    afterEach(() => {
        if (originalDocument === undefined) {
            delete (globalThis as { document?: unknown }).document;
        } else {
            (globalThis as { document?: unknown }).document = originalDocument;
        }
    });

    it('captures the canvas data URL with the PNG MIME type', () => {
        const canvas = { toDataURL: vi.fn(() => 'data:image/png;base64,AAA') };
        expect(canvasToDataUrl(canvas)).toBe('data:image/png;base64,AAA');
        expect(canvas.toDataURL).toHaveBeenCalledWith(SCREENSHOT_MIME_TYPE);
    });

    it('builds timestamped filenames', () => {
        const now = new Date(2026, 8, 6, 12, 30, 5);
        expect(buildScreenshotFilename('mesh', now)).toBe('mesh-20260906-123005.png');
        expect(buildScreenshotFilename('screenshot', now)).toBe('screenshot-20260906-123005.png');
    });

    it('downloads via an anchor click and returns the filename', () => {
        const click = vi.fn();
        const anchor = { href: '', download: '', click };
        (globalThis as { document?: unknown }).document = { createElement: vi.fn(() => anchor) };
        const canvas = { toDataURL: vi.fn(() => 'data:image/png;base64,AAA') };
        const name = downloadCanvasScreenshot(canvas, 'mesh-20260906-123005.png');
        expect(name).toBe('mesh-20260906-123005.png');
        expect(anchor.href).toBe('data:image/png;base64,AAA');
        expect(anchor.download).toBe('mesh-20260906-123005.png');
        expect(click).toHaveBeenCalledTimes(1);
    });

    it('throws without a DOM', () => {
        delete (globalThis as { document?: unknown }).document;
        expect(() => downloadCanvasScreenshot({ toDataURL: () => '' })).toThrow('requires a DOM');
    });
});
