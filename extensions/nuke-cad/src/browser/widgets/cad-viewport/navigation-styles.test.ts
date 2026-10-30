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
import {
    NAV_ACTION_DOLLY,
    NAV_ACTION_DOLLY_PAN,
    NAV_ACTION_DOLLY_ROTATE,
    NAV_ACTION_NONE,
    NAV_ACTION_PAN,
    NAV_ACTION_ROTATE,
    NAVIGATION_STYLES,
    applyNavigationStyle,
    navigationMouseButtons,
    navigationTouches,
    type NavigationControlsTarget,
    type NavigationStyle
} from './navigation-styles';

describe('navigation-styles', () => {
    it('lists one entry per style id', () => {
        const ids = NAVIGATION_STYLES.map((style) => style.id).sort();
        expect(ids).toEqual(['orbit', 'solidworks', 'tinkercad', 'touchpad']);
    });

    it('keeps left-drag orbiting only in the default style', () => {
        expect(navigationMouseButtons('orbit').left).toBe(NAV_ACTION_ROTATE);
        for (const style of ['solidworks', 'tinkercad'] as const) {
            // Selection-first styles reserve left-drag for picking, never orbiting.
            expect(navigationMouseButtons(style).left).toBe(NAV_ACTION_NONE);
        }
    });

    it('orbits on middle-drag for SolidWorks and right-drag for TinkerCAD', () => {
        expect(navigationMouseButtons('solidworks')).toEqual({
            left: NAV_ACTION_NONE,
            middle: NAV_ACTION_ROTATE,
            right: NAV_ACTION_PAN
        });
        expect(navigationMouseButtons('tinkercad')).toEqual({
            left: NAV_ACTION_NONE,
            middle: NAV_ACTION_PAN,
            right: NAV_ACTION_ROTATE
        });
    });

    it('keeps orbit mouse bindings for the touchpad style', () => {
        expect(navigationMouseButtons('touchpad')).toEqual(navigationMouseButtons('orbit'));
        expect(navigationMouseButtons('orbit').middle).toBe(NAV_ACTION_DOLLY);
    });

    it('gives the touchpad single-finger pan and two-finger dolly-rotate', () => {
        expect(navigationTouches('touchpad')).toEqual({ one: NAV_ACTION_PAN, two: NAV_ACTION_DOLLY_ROTATE });
        for (const style of ['orbit', 'solidworks', 'tinkercad'] as const) {
            expect(navigationTouches(style)).toEqual({ one: NAV_ACTION_ROTATE, two: NAV_ACTION_DOLLY_PAN });
        }
    });

    it('applies button tables onto a controls object', () => {
        const controls: NavigationControlsTarget = {
            mouseButtons: { LEFT: -9, MIDDLE: -9, RIGHT: -9 },
            touches: { ONE: -9, TWO: -9 }
        };
        applyNavigationStyle(controls, 'solidworks');
        expect(controls.mouseButtons).toEqual({ LEFT: NAV_ACTION_NONE, MIDDLE: NAV_ACTION_ROTATE, RIGHT: NAV_ACTION_PAN });
        applyNavigationStyle(controls, 'touchpad');
        expect(controls.touches).toEqual({ ONE: NAV_ACTION_PAN, TWO: NAV_ACTION_DOLLY_ROTATE });
    });

    it('covers every style in both tables', () => {
        for (const { id } of NAVIGATION_STYLES) {
            const style = id as NavigationStyle;
            expect(Object.values(navigationMouseButtons(style)).every((action) => Number.isInteger(action))).toBe(true);
            expect(Object.values(navigationTouches(style)).every((action) => Number.isInteger(action))).toBe(true);
        }
    });
});
