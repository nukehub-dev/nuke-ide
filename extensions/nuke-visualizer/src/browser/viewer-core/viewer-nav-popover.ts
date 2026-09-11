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
 * Bottom-bar popover state for the native 3D viewers (CAD anchored-popover
 * parity).
 *
 * The nuke-cad viewport opens small floating cards above its `ViewerNavBar`
 * (a shading mode list, a section axis/flip/offset card) from tool buttons
 * on the same bar. The visualizer quick actions follow that exact pattern:
 * a Clip card (X/Y/Z tabs + enable + flip + offset) and a Shading card
 * (mode list) ride the shared bar as popovers instead of inline toggles.
 *
 * Pure functions + types only; no three.js, no DOM, no React, no Theia
 * imports. The React shell lives in
 * `widgets/viewer-nav-extras.tsx`; the host widgets own the open slot and
 * route every control onto their existing setters.
 */

/** Which quick-access card is open above the bottom bar (single slot, like CAD's `openPopover`). */
export type ViewerNavPopoverKind = 'clip' | 'shading';

/**
 * Toggle the open slot: re-clicking the active trigger closes it, clicking
 * the other trigger switches cards (never both open). Pure.
 */
export function nextNavPopover(current: ViewerNavPopoverKind | undefined, clicked: ViewerNavPopoverKind): ViewerNavPopoverKind | undefined {
    return current === clicked ? undefined : clicked;
}

/** Measured popover size (px) driving the clamp. */
export interface NavPopoverSize {
    readonly width: number;
    readonly height: number;
}

/** Size of the positioned container the popover is anchored in (px). */
export interface NavPopoverViewport {
    readonly width: number;
    readonly height: number;
}

/** Clamped popover origin in container coordinates (px). */
export interface NavPopoverPosition {
    readonly left: number;
    readonly top: number;
}

/** Margin (px) kept between the popover and the container edges. */
export const NAV_POPOVER_MARGIN_PX = 8;

/** Default anchor above the bottom-right navigation cluster (CAD `bottom: 42px; right: 8px` parity). */
export const NAV_POPOVER_ANCHOR_RIGHT_PX = 8;
export const NAV_POPOVER_ANCHOR_BOTTOM_PX = 42;

/**
 * Clamp an anchored popover origin into its container, so the card stays
 * fully visible on narrow viewports. The default anchor renders CAD-identical
 * when there is room; only overflowing origins move (pinned to the margin,
 * never negative). Pure.
 */
export function clampNavPopoverPosition(
    popover: NavPopoverSize,
    viewport: NavPopoverViewport,
    anchorRight: number = NAV_POPOVER_ANCHOR_RIGHT_PX,
    anchorBottom: number = NAV_POPOVER_ANCHOR_BOTTOM_PX,
    margin: number = NAV_POPOVER_MARGIN_PX
): NavPopoverPosition {
    const left = viewport.width - anchorRight - popover.width;
    const top = viewport.height - anchorBottom - popover.height;
    // When the container is smaller than the card, `maxLeft`/`maxTop`
    // collapse to the margin instead of going negative (the card additionally
    // caps its own width in CSS).
    const maxLeft = Math.max(margin, viewport.width - popover.width - margin);
    const maxTop = Math.max(margin, viewport.height - popover.height - margin);
    return {
        left: Math.min(Math.max(left, margin), maxLeft),
        top: Math.min(Math.max(top, margin), maxTop)
    };
}
