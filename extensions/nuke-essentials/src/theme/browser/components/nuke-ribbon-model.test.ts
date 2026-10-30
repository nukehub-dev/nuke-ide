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
 * Tests for the ribbon promotion/density model (no DOM): clamp behavior,
 * threshold mapping, and both hysteresis directions.
 */

import { describe, expect, it } from 'vitest';
import {
    RIBBON_DENSITY_HYSTERESIS,
    RIBBON_ICONS_MIN_WIDTH,
    RIBBON_INLINE_PIN_CAP,
    RIBBON_TILES_MIN_WIDTH,
    selectRibbonDensity,
    splitRibbonByPromotion,
    splitRibbonItems
} from './nuke-ribbon-model';

const ITEMS = ['new', 'save', 'undo', 'redo'] as const;
const OBJECT_ITEMS = ITEMS.map((id) => ({ id }));

describe('splitRibbonItems', () => {
    it('splits after the promoted count in order', () => {
        const split = splitRibbonItems(ITEMS, 2);
        expect(split.promoted).toEqual(['new', 'save']);
        expect(split.menu).toEqual(['undo', 'redo']);
    });

    it('promotes nothing when the count is zero or negative', () => {
        for (const promoted of [0, -3]) {
            const split = splitRibbonItems(ITEMS, promoted);
            expect(split.promoted).toEqual([]);
            expect(split.menu).toEqual([...ITEMS]);
        }
    });

    it('clamps an over-long count to the whole list', () => {
        const split = splitRibbonItems(ITEMS, 99);
        expect(split.promoted).toEqual([...ITEMS]);
        expect(split.menu).toEqual([]);
    });

    it('truncates fractional counts and tolerates non-finite input', () => {
        expect(splitRibbonItems(ITEMS, 2.9).promoted).toEqual(['new', 'save']);
        expect(splitRibbonItems(ITEMS, Number.NaN).promoted).toEqual([]);
    });

    it('preserves object identity and leaves the input untouched', () => {
        const items = [{ id: 'a' }, { id: 'b' }];
        const split = splitRibbonItems(items, 1);
        expect(split.promoted[0]).toBe(items[0]);
        expect(split.menu[0]).toBe(items[1]);
        expect(items).toHaveLength(2);
    });
});

describe('splitRibbonByPromotion', () => {
    it('keeps the default promoted prefix without pins', () => {
        const split = splitRibbonByPromotion(OBJECT_ITEMS, 2);
        expect(split.promoted.map((item) => item.id)).toEqual(['new', 'save']);
        expect(split.menu.map((item) => item.id)).toEqual(['undo', 'redo']);
    });

    it('adds pinned ids inline while preserving section order', () => {
        const split = splitRibbonByPromotion(OBJECT_ITEMS, 2, ['redo', 'undo']);
        expect(split.promoted.map((item) => item.id)).toEqual(['new', 'save', 'undo', 'redo']);
        expect(split.menu).toEqual([]);
    });

    it('places a single pin after the defaults regardless of pin-list order', () => {
        const split = splitRibbonByPromotion(OBJECT_ITEMS, 2, ['redo']);
        expect(split.promoted.map((item) => item.id)).toEqual(['new', 'save', 'redo']);
        expect(split.menu.map((item) => item.id)).toEqual(['undo']);
    });

    it('ignores unknown pinned ids', () => {
        const split = splitRibbonByPromotion(OBJECT_ITEMS, 2, ['missing']);
        expect(split.promoted.map((item) => item.id)).toEqual(['new', 'save']);
        expect(split.menu.map((item) => item.id)).toEqual(['undo', 'redo']);
    });

    it('dedupes pins that already sit in the default promotion', () => {
        const split = splitRibbonByPromotion(OBJECT_ITEMS, 2, ['save', 'save']);
        expect(split.promoted.map((item) => item.id)).toEqual(['new', 'save']);
        expect(split.menu.map((item) => item.id)).toEqual(['undo', 'redo']);
    });

    it('caps the inline set at eight items in section order', () => {
        expect(RIBBON_INLINE_PIN_CAP).toBe(8);
        const many = Array.from({ length: 12 }, (_, index) => ({ id: `c${index}` }));
        const split = splitRibbonByPromotion(many, 6, ['c9', 'c8', 'c7', 'c6']);
        expect(split.promoted.map((item) => item.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
        expect(split.menu.map((item) => item.id)).toEqual(['c8', 'c9', 'c10', 'c11']);
    });

    it('honors an explicit cap before later pins', () => {
        const split = splitRibbonByPromotion(OBJECT_ITEMS, 2, ['redo'], 2);
        expect(split.promoted.map((item) => item.id)).toEqual(['new', 'save']);
        expect(split.menu.map((item) => item.id)).toEqual(['undo', 'redo']);
    });

    it('preserves object identity and leaves the input untouched', () => {
        const split = splitRibbonByPromotion(OBJECT_ITEMS, 1, ['redo']);
        expect(split.promoted[0]).toBe(OBJECT_ITEMS[0]);
        expect(split.promoted[1]).toBe(OBJECT_ITEMS[3]);
        expect(OBJECT_ITEMS).toHaveLength(4);
    });
});

describe('selectRibbonDensity', () => {
    it('uses the base thresholds for the first measurement', () => {
        expect(selectRibbonDensity(RIBBON_TILES_MIN_WIDTH)).toBe('tiles');
        expect(selectRibbonDensity(RIBBON_TILES_MIN_WIDTH - 1)).toBe('icons');
        expect(selectRibbonDensity(RIBBON_ICONS_MIN_WIDTH)).toBe('icons');
        expect(selectRibbonDensity(RIBBON_ICONS_MIN_WIDTH - 1)).toBe('menus');
    });

    it('keeps tiles until the lower hysteresis margin when shrinking', () => {
        expect(selectRibbonDensity(RIBBON_TILES_MIN_WIDTH - RIBBON_DENSITY_HYSTERESIS, 'tiles')).toBe('tiles');
        expect(selectRibbonDensity(RIBBON_TILES_MIN_WIDTH - RIBBON_DENSITY_HYSTERESIS - 1, 'tiles')).toBe('icons');
    });

    it('requires the upper hysteresis margin to grow back into tiles', () => {
        expect(selectRibbonDensity(RIBBON_TILES_MIN_WIDTH + RIBBON_DENSITY_HYSTERESIS - 1, 'icons')).toBe('icons');
        expect(selectRibbonDensity(RIBBON_TILES_MIN_WIDTH + RIBBON_DENSITY_HYSTERESIS, 'icons')).toBe('tiles');
    });

    it('keeps icons down to the lower margin and leaves them below it', () => {
        expect(selectRibbonDensity(RIBBON_ICONS_MIN_WIDTH - RIBBON_DENSITY_HYSTERESIS, 'icons')).toBe('icons');
        expect(selectRibbonDensity(RIBBON_ICONS_MIN_WIDTH - RIBBON_DENSITY_HYSTERESIS - 1, 'icons')).toBe('menus');
    });

    it('requires the upper margin to grow from menus into icons', () => {
        expect(selectRibbonDensity(RIBBON_ICONS_MIN_WIDTH + RIBBON_DENSITY_HYSTERESIS - 1, 'menus')).toBe('menus');
        expect(selectRibbonDensity(RIBBON_ICONS_MIN_WIDTH + RIBBON_DENSITY_HYSTERESIS, 'menus')).toBe('icons');
    });

    it('jumps straight to tiles only once the upper tiles margin is cleared', () => {
        expect(selectRibbonDensity(RIBBON_TILES_MIN_WIDTH + RIBBON_DENSITY_HYSTERESIS, 'menus')).toBe('tiles');
        expect(selectRibbonDensity(RIBBON_TILES_MIN_WIDTH + RIBBON_DENSITY_HYSTERESIS - 1, 'menus')).toBe('icons');
    });

    it('falls back to menus for non-finite widths', () => {
        expect(selectRibbonDensity(Number.NaN)).toBe('menus');
        expect(selectRibbonDensity(Number.POSITIVE_INFINITY, 'icons')).toBe('icons');
    });
});
