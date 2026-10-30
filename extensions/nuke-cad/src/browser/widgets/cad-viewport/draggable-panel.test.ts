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
import { clampPanelPosition, PANEL_HEADER_SLIVER_PX } from './draggable-panel';

describe('draggable-panel', () => {
    it('keeps an interior position untouched', () => {
        expect(clampPanelPosition(120, 90, 200, 150, 800, 600)).toEqual({ left: 120, top: 90 });
    });

    it('clamps a fitting panel flush to the bottom-right edges', () => {
        expect(clampPanelPosition(9999, 9999, 200, 150, 800, 600)).toEqual({ left: 600, top: 450 });
    });

    it('clamps negative offsets to the top-left corner', () => {
        expect(clampPanelPosition(-50, -50, 200, 150, 800, 600)).toEqual({ left: 0, top: 0 });
    });

    it('keeps an exactly-fitting panel pinned inside the bounds', () => {
        expect(clampPanelPosition(40, 9999, 800, 600, 800, 600)).toEqual({ left: 0, top: 0 });
    });

    it('keeps the header reachable when the panel is taller than the bounds', () => {
        expect(clampPanelPosition(30, 9999, 200, 900, 800, 600)).toEqual({
            left: 30,
            top: 600 - PANEL_HEADER_SLIVER_PX
        });
    });

    it('keeps a horizontal sliver reachable when the panel is wider than the bounds', () => {
        expect(clampPanelPosition(9999, 10, 1000, 100, 800, 600)).toEqual({
            left: 800 - PANEL_HEADER_SLIVER_PX,
            top: 10
        });
    });

    it('pins to the origin when the bounds collapse to zero', () => {
        expect(clampPanelPosition(40, 40, 200, 150, 0, 0)).toEqual({ left: 0, top: 0 });
    });
});
