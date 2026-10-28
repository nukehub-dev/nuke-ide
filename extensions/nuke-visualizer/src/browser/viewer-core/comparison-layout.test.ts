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
 * Tests for the pure comparison-layout model: the 2/3-pane horizontal rows,
 * the 4-pane 2x2 grid, and the invalid-count contract.
 */

import { describe, expect, it } from 'vitest';
import { comparisonPanePlacements } from './comparison-layout';

describe('comparisonPanePlacements', () => {
    it('splits a second pane right of the first', () => {
        expect(comparisonPanePlacements(2)).toEqual([{ pane: 1, ref: 0, mode: 'split-right' }]);
    });

    it('keeps three panes in one row, each right of the previous pane', () => {
        expect(comparisonPanePlacements(3)).toEqual([
            { pane: 1, ref: 0, mode: 'split-right' },
            { pane: 2, ref: 1, mode: 'split-right' }
        ]);
    });

    it('places four panes as A top-left, B top-right, C bottom-left, D bottom-right', () => {
        expect(comparisonPanePlacements(4)).toEqual([
            { pane: 1, ref: 0, mode: 'split-right' },
            { pane: 2, ref: 0, mode: 'split-bottom' },
            { pane: 3, ref: 2, mode: 'split-right' }
        ]);
    });

    it('only targets panes that are already placed', () => {
        for (const viewCount of [2, 3, 4]) {
            for (const placement of comparisonPanePlacements(viewCount)) {
                expect(placement.pane).toBeGreaterThan(placement.ref);
                expect(placement.ref).toBeGreaterThanOrEqual(0);
                expect(placement.pane).toBeLessThan(viewCount);
            }
        }
    });

    it('rejects counts below two', () => {
        for (const viewCount of [-1, 0, 1]) {
            expect(() => comparisonPanePlacements(viewCount)).toThrow(RangeError);
        }
    });

    it('rejects counts above four', () => {
        expect(() => comparisonPanePlacements(5)).toThrow(RangeError);
    });

    it('rejects non-integer counts', () => {
        for (const viewCount of [2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() => comparisonPanePlacements(viewCount)).toThrow(RangeError);
        }
    });
});
