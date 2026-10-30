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
 * Tests for the viewer-core context menu: click-vs-pan detection plus the
 * pure menu model (item builder) and viewport clamping. The DOM renderer
 * itself stays untested (vitest runs in node, no DOM) — it measures the
 * laid-out menu after render and routes the numbers through
 * `clampViewerContextMenuPosition`, which is covered here.
 */

import { describe, expect, it } from 'vitest';
import {
    buildViewerContextMenuItems,
    clampViewerContextMenuPosition,
    isViewerContextMenuClick,
    VIEWER_CONTEXT_MENU_DRAG_TOLERANCE_PX,
    VIEWER_CONTEXT_MENU_MARGIN_PX,
    VIEWER_SHADING_MENU_ICONS
} from './viewer-context-menu';
import { VIEWER_SHADING_MODES } from './shading-mode';

describe('isViewerContextMenuClick', () => {
    it('accepts a stationary press and small jitter', () => {
        expect(isViewerContextMenuClick(10, 10, 10, 10)).toBe(true);
        expect(isViewerContextMenuClick(10, 10, 12, 11)).toBe(true);
    });

    it('treats the tolerance boundary as inclusive', () => {
        expect(isViewerContextMenuClick(0, 0, 3, 4)).toBe(true);
        expect(isViewerContextMenuClick(0, 0, 3, 4.1)).toBe(false);
    });

    it('rejects right-drag pans', () => {
        expect(isViewerContextMenuClick(10, 10, 60, 10)).toBe(false);
        expect(isViewerContextMenuClick(10, 10, 10, 60)).toBe(false);
    });

    it('honors an explicit tolerance', () => {
        expect(isViewerContextMenuClick(0, 0, 9, 0, 10)).toBe(true);
        expect(isViewerContextMenuClick(0, 0, 11, 0, 10)).toBe(false);
    });

    it('defaults to the documented tolerance', () => {
        expect(VIEWER_CONTEXT_MENU_DRAG_TOLERANCE_PX).toBe(5);
    });
});

describe('buildViewerContextMenuItems', () => {
    it('lists view actions, clip toggle, then one row per shading mode', () => {
        const items = buildViewerContextMenuItems({ shading: 'shaded', clipChecked: false });
        expect(items.map((item) => item.id)).toEqual([
            'fit',
            'screenshot',
            'clip',
            ...VIEWER_SHADING_MODES.map((mode) => `shading:${mode.id}`)
        ]);
        expect(items[0].label).toBe('Fit to View');
        expect(items[1].label).toBe('Save Screenshot (PNG)');
    });

    it('checks the active shading mode only', () => {
        const items = buildViewerContextMenuItems({ shading: 'wireframe', clipChecked: false });
        const shading = items.filter((item) => item.id.startsWith('shading:'));
        expect(shading).toHaveLength(VIEWER_SHADING_MODES.length);
        for (const item of shading) {
            expect(item.checked).toBe(item.id === 'shading:wireframe');
        }
    });

    it('passes the clip state through to the clip row', () => {
        expect(buildViewerContextMenuItems({ shading: 'shaded', clipChecked: true })[2].checked).toBe(true);
        expect(buildViewerContextMenuItems({ shading: 'shaded', clipChecked: false })[2].checked).toBe(false);
    });

    it('separates the view, clip, and shading groups', () => {
        const items = buildViewerContextMenuItems({ shading: 'shaded', clipChecked: false });
        expect(items[0].separatorAbove).toBeFalsy();
        expect(items[1].separatorAbove).toBeFalsy();
        expect(items[2].separatorAbove).toBe(true);
        expect(items[3].separatorAbove).toBe(true);
        for (const item of items.slice(4)) {
            expect(item.separatorAbove).toBeFalsy();
        }
    });

    it('icons every row with a codicon (CAD menu grammar)', () => {
        const items = buildViewerContextMenuItems({ shading: 'shaded', clipChecked: false });
        for (const item of items) {
            expect(item.icon).toMatch(/^codicon-/);
        }
    });

    it('gives each shading mode its own icon', () => {
        const items = buildViewerContextMenuItems({ shading: 'shaded', clipChecked: false });
        const shading = items.filter((item) => item.id.startsWith('shading:'));
        expect(shading).toHaveLength(VIEWER_SHADING_MODES.length);
        const icons = new Set(shading.map((item) => item.icon));
        expect(icons.size).toBe(VIEWER_SHADING_MODES.length);
        for (const mode of VIEWER_SHADING_MODES) {
            expect(VIEWER_SHADING_MENU_ICONS[mode.id]).toMatch(/^codicon-/);
            expect(shading.find((item) => item.id === `shading:${mode.id}`)?.icon).toBe(VIEWER_SHADING_MENU_ICONS[mode.id]);
        }
    });
});

describe('clampViewerContextMenuPosition', () => {
    it('keeps an interior anchor exactly at the cursor', () => {
        expect(clampViewerContextMenuPosition(200, 150, 190, 120, 1024, 768)).toEqual({ x: 200, y: 150 });
    });

    it('pulls right/bottom-edge anchors inside so no row clips', () => {
        expect(clampViewerContextMenuPosition(950, 700, 190, 120, 1024, 768)).toEqual({ x: 830, y: 644 });
    });

    it('lifts near-edge anchors off the viewport margin', () => {
        expect(clampViewerContextMenuPosition(0, 1, 190, 120, 1024, 768)).toEqual({
            x: VIEWER_CONTEXT_MENU_MARGIN_PX,
            y: VIEWER_CONTEXT_MENU_MARGIN_PX
        });
    });

    it('pins an oversized menu at the margin instead of going negative', () => {
        expect(clampViewerContextMenuPosition(400, 300, 2000, 1500, 1024, 768)).toEqual({
            x: VIEWER_CONTEXT_MENU_MARGIN_PX,
            y: VIEWER_CONTEXT_MENU_MARGIN_PX
        });
    });

    it('honors an explicit margin', () => {
        expect(clampViewerContextMenuPosition(1010, 760, 190, 120, 1024, 768, 10)).toEqual({ x: 824, y: 638 });
    });
});
