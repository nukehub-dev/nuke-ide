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
 * Pure model for the shared ribbon toolbar (no DOM, no React).
 *
 * The host owns the action table; this module only decides how many actions
 * stay inline and which density the measured host width maps to.
 */

/** Section rendering density: labelled tiles, compact icons, or caption menus. */
export type NukeRibbonDensity = 'tiles' | 'icons' | 'menus';

/** Width at (and above) which the ribbon uses tile buttons. */
export const RIBBON_TILES_MIN_WIDTH = 1700;

/** Width at (and above) which the ribbon uses compact icon buttons. */
export const RIBBON_ICONS_MIN_WIDTH = 930;

/**
 * Dead band around both density thresholds. Crossing a boundary requires the
 * width to clear it by this margin, so a slow window drag cannot flicker
 * between densities at the exact boundary.
 */
export const RIBBON_DENSITY_HYSTERESIS = 40;

/** Split of a section's actions into inline buttons and the caret-menu tail. */
export interface RibbonItemSplit<T> {
    /** Actions rendered inline (first `promoted` entries). */
    readonly promoted: readonly T[];
    /** Remaining actions, rendered in the section menu. */
    readonly menu: readonly T[];
}

/**
 * Split `items` after `promoted` entries, clamping the requested count to
 * `[0, items.length]`. Fractional counts truncate; non-numeric counts fall
 * back to zero (everything in the menu).
 */
export function splitRibbonItems<T>(items: readonly T[], promoted: number): RibbonItemSplit<T> {
    const inlineCount = Math.min(Math.max(Math.trunc(promoted), 0), items.length);
    return {
        promoted: items.slice(0, inlineCount),
        menu: items.slice(inlineCount)
    };
}

/**
 * Map a measured host width to a ribbon density.
 *
 * Base thresholds: `>= 1400` tiles, `1000–1399` icons, `< 1000` menus. With a
 * previous density the effective boundary moves by
 * {@link RIBBON_DENSITY_HYSTERESIS}: growing into a denser mode requires the
 * threshold plus the margin, while shrinking out of it keeps the current mode
 * until the threshold minus the margin. The first measurement (no previous
 * density) uses the base thresholds unchanged.
 */
export function selectRibbonDensity(width: number, previous?: NukeRibbonDensity): NukeRibbonDensity {
    if (!Number.isFinite(width)) {
        return previous ?? 'menus';
    }
    const tilesThreshold =
        previous === undefined
            ? RIBBON_TILES_MIN_WIDTH
            : previous === 'tiles'
              ? RIBBON_TILES_MIN_WIDTH - RIBBON_DENSITY_HYSTERESIS
              : RIBBON_TILES_MIN_WIDTH + RIBBON_DENSITY_HYSTERESIS;
    const iconsThreshold =
        previous === undefined
            ? RIBBON_ICONS_MIN_WIDTH
            : previous === 'icons'
              ? RIBBON_ICONS_MIN_WIDTH - RIBBON_DENSITY_HYSTERESIS
              : RIBBON_ICONS_MIN_WIDTH + RIBBON_DENSITY_HYSTERESIS;
    if (width >= tilesThreshold) {
        return 'tiles';
    }
    if (width >= iconsThreshold) {
        return 'icons';
    }
    return 'menus';
}
