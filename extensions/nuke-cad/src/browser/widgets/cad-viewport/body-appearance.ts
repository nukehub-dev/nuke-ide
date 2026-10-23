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
 * Display-only per-body appearance resolution.
 *
 * The document stores an optional {@link BodyAppearance} on each body; this
 * module turns it into the viewport-usable override (explicit color and/or
 * opacity) and supplies the dialog defaults. Pure — no three.js, no Theia —
 * so vitest covers the resolution rules directly.
 *
 * @module nuke-cad/browser/widgets/cad-viewport
 */

import type { BodyAppearance, NukeCadDocument } from '../../../common/cad-document';

/** Dialog/default color when a body has no color override. */
export const BODY_APPEARANCE_DEFAULT_COLOR = '#c4c7cc';

/** Dialog/default opacity when a body has no opacity override. */
export const BODY_APPEARANCE_DEFAULT_OPACITY = 1;

/** Normalized display override resolved for one body. */
export interface ResolvedBodyAppearance {
    /** Explicit `#rrggbb` color; undefined means follow the theme body color. */
    readonly color?: string;
    /** Explicit opacity in the inclusive range 0–1; undefined means follow the shading mode. */
    readonly opacity?: number;
}

/**
 * One user-level appearance preset (`nukeCad.appearancePresets`).
 *
 * Presets are preferences, never document data: applying one only stages its
 * values in the dialog, and the document stores the resulting per-body
 * override. Names are unique after trimming in app code (the preference
 * schema cannot enforce per-item uniqueness).
 */
export interface AppearancePreset {
    readonly name: string;
    readonly color: string;
    readonly opacity: number;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Normalize a raw preference value into usable appearance presets.
 *
 * Tolerates hand-edited preferences: trims names, drops empty/non-string
 * names, drops entries with a malformed color or non-finite opacity, clamps
 * opacity to 0–1, lower-cases hex colors, and dedupes by name (first entry
 * wins, preserving order). Never throws.
 */
export function normalizeAppearancePresets(value: unknown): AppearancePreset[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const presets: AppearancePreset[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            continue;
        }
        const { name, color, opacity } = entry as { name?: unknown; color?: unknown; opacity?: unknown };
        if (typeof name !== 'string') {
            continue;
        }
        const trimmed = name.trim();
        if (trimmed.length === 0 || seen.has(trimmed)) {
            continue;
        }
        if (typeof color !== 'string' || !HEX_COLOR.test(color)) {
            continue;
        }
        if (typeof opacity !== 'number' || !Number.isFinite(opacity)) {
            continue;
        }
        seen.add(trimmed);
        presets.push({ name: trimmed, color: color.toLowerCase(), opacity: Math.min(1, Math.max(0, opacity)) });
    }
    return presets;
}

/**
 * Resolve the appearance override for one body.
 *
 * Returns undefined when the document/body/override is absent, or when no
 * field survives normalization (invalid color and non-finite/out-of-range
 * opacity). Valid fields are independent: a color-only override leaves the
 * opacity to the shading mode and vice versa.
 */
export function resolveBodyAppearance(
    document: NukeCadDocument | undefined,
    bodyId: string | undefined
): ResolvedBodyAppearance | undefined {
    if (document === undefined || bodyId === undefined) {
        return undefined;
    }
    const appearance: BodyAppearance | undefined = document.bodies.find((body) => body.id === bodyId)?.appearance;
    if (appearance === undefined) {
        return undefined;
    }
    const color = typeof appearance.color === 'string' && HEX_COLOR.test(appearance.color) ? appearance.color : undefined;
    const opacity =
        typeof appearance.opacity === 'number' && Number.isFinite(appearance.opacity) && appearance.opacity >= 0 && appearance.opacity <= 1
            ? appearance.opacity
            : undefined;
    if (color === undefined && opacity === undefined) {
        return undefined;
    }
    return {
        ...(color !== undefined ? { color } : {}),
        ...(opacity !== undefined ? { opacity } : {})
    };
}
