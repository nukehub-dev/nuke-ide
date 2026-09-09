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
 * Tests for the shared viewer bottom-bar action model (no DOM): item order,
 * text/icon split, tooltips, and the action guard.
 */

import { describe, expect, it } from 'vitest';
import { VIEWER_NAV_ITEMS, isViewerNavAction } from './viewer-nav-actions';

describe('VIEWER_NAV_ITEMS', () => {
    it('lists the seven bottom-bar actions in render order', () => {
        expect(VIEWER_NAV_ITEMS.map((item) => item.action)).toEqual(['iso', 'top', 'front', 'right', 'fit', 'zoom-in', 'zoom-out']);
    });

    it('renders standard views as text buttons and fit/zoom as icon buttons', () => {
        for (const item of VIEWER_NAV_ITEMS.slice(0, 4)) {
            expect(item.label?.length).toBeGreaterThan(0);
            expect(item.icon).toBeUndefined();
        }
        for (const item of VIEWER_NAV_ITEMS.slice(4)) {
            expect(item.icon?.length).toBeGreaterThan(0);
            expect(item.label).toBeUndefined();
        }
    });

    it('gives every control a tooltip', () => {
        for (const item of VIEWER_NAV_ITEMS) {
            expect(item.tooltip.length).toBeGreaterThan(0);
        }
    });
});

describe('isViewerNavAction', () => {
    it('accepts the seven actions and rejects anything else', () => {
        for (const item of VIEWER_NAV_ITEMS) {
            expect(isViewerNavAction(item.action)).toBe(true);
        }
        expect(isViewerNavAction('explode')).toBe(false);
        expect(isViewerNavAction('')).toBe(false);
    });
});
