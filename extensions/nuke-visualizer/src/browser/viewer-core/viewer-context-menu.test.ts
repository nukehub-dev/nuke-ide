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
 * Tests for the viewer-core context-menu click detection (no DOM): small
 * press/release offsets count as a right-click, pans do not.
 */

import { describe, expect, it } from 'vitest';
import { isViewerContextMenuClick, VIEWER_CONTEXT_MENU_DRAG_TOLERANCE_PX } from './viewer-context-menu';

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
