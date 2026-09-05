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

/**
 * Viewport navigation styles (mouse/touch bindings for OrbitControls).
 *
 * Switchers from other CAD tools expect their orbit habits to travel with
 * them (FreeCAD offers Blender/SolidWorks/NX/Revit-style navigation for the
 * same reason). Each style is a plain button→action table applied onto a
 * live controls object, so it survives controls re-creation and needs no
 * Theia or three.js imports — vitest covers it directly.
 *
 * Numeric codes mirror ``THREE.MOUSE``/``THREE.TOUCH`` (rotate 0, dolly 1,
 * pan 2; touches add dolly-pan 2, dolly-rotate 3); ``NAV_ACTION_NONE`` (-1)
 * disables the button (OrbitControls treats unknown actions as no-op).
 * Modifier-key styles (Blender Shift+MMB pan, Maya Alt+LMB orbit) are out of
 * scope: OrbitControls button maps have no modifier layer, so those need
 * custom pointer handling if ever demanded.
 *
 * @module nuke-cad/browser/widgets/cad-viewport
 */

/** No action for a mouse/touch input. */
export const NAV_ACTION_NONE = -1;
/** Orbit (rotate) action. */
export const NAV_ACTION_ROTATE = 0;
/** Dolly (zoom) action. */
export const NAV_ACTION_DOLLY = 1;
/** Pan action. */
export const NAV_ACTION_PAN = 2;
/** Two-finger dolly+pan action. */
export const NAV_ACTION_DOLLY_PAN = 2;
/** Two-finger dolly+rotate action. */
export const NAV_ACTION_DOLLY_ROTATE = 3;

export type NavigationStyle = 'orbit' | 'solidworks' | 'tinkercad' | 'touchpad';

/** Display metadata for one navigation style. */
export interface NavigationStyleInfo {
    readonly id: NavigationStyle;
    readonly label: string;
    readonly description: string;
}

export const NAVIGATION_STYLES: readonly NavigationStyleInfo[] = [
    {
        id: 'orbit',
        label: 'Orbit',
        description: 'Left-drag orbits, wheel zooms, right-drag pans (three.js defaults).'
    },
    {
        id: 'solidworks',
        label: 'SolidWorks',
        description: 'Middle-drag orbits, wheel zooms, right-drag pans; left-drag only selects.'
    },
    {
        id: 'tinkercad',
        label: 'TinkerCAD',
        description: 'Right-drag orbits, middle-drag pans, wheel zooms; left-drag only selects.'
    },
    {
        id: 'touchpad',
        label: 'Touchpad',
        description: 'Orbit mouse bindings; one-finger drag pans, two-finger drag dollies and rotates.'
    }
];

/** Mouse button bindings for a style. */
export interface NavigationMouseButtons {
    readonly left: number;
    readonly middle: number;
    readonly right: number;
}

/** Touch bindings for a style. */
export interface NavigationTouches {
    readonly one: number;
    readonly two: number;
}

const ORBIT_TOUCHES: NavigationTouches = { one: NAV_ACTION_ROTATE, two: NAV_ACTION_DOLLY_PAN };

/** Button table per style; touch defaults to orbit bindings unless overridden. */
export function navigationMouseButtons(style: NavigationStyle): NavigationMouseButtons {
    switch (style) {
        case 'solidworks':
            return { left: NAV_ACTION_NONE, middle: NAV_ACTION_ROTATE, right: NAV_ACTION_PAN };
        case 'tinkercad':
            return { left: NAV_ACTION_NONE, middle: NAV_ACTION_PAN, right: NAV_ACTION_ROTATE };
        case 'touchpad':
        case 'orbit':
            return { left: NAV_ACTION_ROTATE, middle: NAV_ACTION_DOLLY, right: NAV_ACTION_PAN };
    }
}

/** Touch table per style. */
export function navigationTouches(style: NavigationStyle): NavigationTouches {
    switch (style) {
        case 'touchpad':
            return { one: NAV_ACTION_PAN, two: NAV_ACTION_DOLLY_ROTATE };
        case 'orbit':
        case 'solidworks':
        case 'tinkercad':
            return ORBIT_TOUCHES;
    }
}

/** Minimal structural surface of OrbitControls this module writes to. */
export interface NavigationControlsTarget {
    mouseButtons: { LEFT?: number | null; MIDDLE?: number | null; RIGHT?: number | null };
    touches: { ONE?: number | null; TWO?: number | null };
}

/**
 * Apply a style's button tables onto a live controls object. OrbitControls
 * reads the tables per gesture, so this takes effect immediately and must be
 * re-applied after every controls re-creation (view snaps re-create them).
 */
export function applyNavigationStyle(controls: NavigationControlsTarget, style: NavigationStyle): void {
    const buttons = navigationMouseButtons(style);
    controls.mouseButtons.LEFT = buttons.left;
    controls.mouseButtons.MIDDLE = buttons.middle;
    controls.mouseButtons.RIGHT = buttons.right;
    const touches = navigationTouches(style);
    controls.touches.ONE = touches.one;
    controls.touches.TWO = touches.two;
}
