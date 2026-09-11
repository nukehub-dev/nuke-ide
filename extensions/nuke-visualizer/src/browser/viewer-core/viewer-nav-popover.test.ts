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
import {
    clampNavPopoverPosition,
    NAV_POPOVER_ANCHOR_BOTTOM_PX,
    NAV_POPOVER_ANCHOR_RIGHT_PX,
    NAV_POPOVER_MARGIN_PX,
    nextNavPopover
} from './viewer-nav-popover';

describe('nextNavPopover', () => {
    it('opens the clicked card from the closed slot', () => {
        expect(nextNavPopover(undefined, 'clip')).toBe('clip');
        expect(nextNavPopover(undefined, 'shading')).toBe('shading');
    });

    it('re-clicking the active trigger closes the slot (toggle)', () => {
        expect(nextNavPopover('clip', 'clip')).toBeUndefined();
        expect(nextNavPopover('shading', 'shading')).toBeUndefined();
    });

    it('clicking the other trigger switches cards (never both open)', () => {
        expect(nextNavPopover('clip', 'shading')).toBe('shading');
        expect(nextNavPopover('shading', 'clip')).toBe('clip');
    });
});

describe('clampNavPopoverPosition', () => {
    it('keeps the CAD-parity anchor when the container has room', () => {
        const position = clampNavPopoverPosition({ width: 180, height: 120 }, { width: 800, height: 600 });
        expect(position).toEqual({
            left: 800 - NAV_POPOVER_ANCHOR_RIGHT_PX - 180,
            top: 600 - NAV_POPOVER_ANCHOR_BOTTOM_PX - 120
        });
    });

    it('clamps an overflowing origin to the margin', () => {
        // A wide card anchored at the default right offset would spill past
        // the left edge of a narrow container.
        const position = clampNavPopoverPosition({ width: 300, height: 120 }, { width: 200, height: 600 });
        expect(position.left).toBe(NAV_POPOVER_MARGIN_PX);
        // The vertical anchor still fits, so it stays put.
        expect(position.top).toBe(600 - NAV_POPOVER_ANCHOR_BOTTOM_PX - 120);
    });

    it('clamps a tall card to the top margin', () => {
        const position = clampNavPopoverPosition({ width: 180, height: 500 }, { width: 800, height: 300 });
        expect(position.top).toBe(NAV_POPOVER_MARGIN_PX);
        expect(position.left).toBe(800 - NAV_POPOVER_ANCHOR_RIGHT_PX - 180);
    });

    it('pins to the margin (never negative) when the container is smaller than the card', () => {
        const position = clampNavPopoverPosition({ width: 400, height: 400 }, { width: 100, height: 100 });
        expect(position).toEqual({ left: NAV_POPOVER_MARGIN_PX, top: NAV_POPOVER_MARGIN_PX });
    });

    it('honors custom anchors', () => {
        const position = clampNavPopoverPosition({ width: 100, height: 50 }, { width: 800, height: 600 }, 20, 60);
        expect(position).toEqual({ left: 800 - 20 - 100, top: 600 - 60 - 50 });
    });
});
