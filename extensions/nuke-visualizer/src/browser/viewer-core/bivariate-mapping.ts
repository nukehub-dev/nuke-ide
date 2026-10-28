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
 * Bivariate (mean + relative error) mapping for tally overlays.
 *
 * The mean still drives hue through `scalar-mapping.ts`; the relative
 * statistical error drives a second channel — opacity, desaturation, or a
 * renderer-side noise texture — and cells above `maxRelativeError` collapse
 * to the low-quality mask color. One pure path is shared by the mesh,
 * slice/overlay and volume clients so every viewer agrees on the encoding.
 *
 * The Python exporters (`tally_vtk.py`) emit `<score>-mean`, `<score>-std`
 * and `<score>-rel-err` with `relErr = std / |mean|` for every bin whose mean
 * is non-zero and `0` for exact-zero (void) bins; this module mirrors that
 * convention so a missing/NaN uncertainty is treated as bad, never as good.
 *
 * Pure functions + types only; no three.js, no DOM, no Theia imports.
 */

import type { RgbColor } from './colormaps';

/** Second visual channel driven by the relative statistical error. */
export type UncertaintyChannel = 'opacity' | 'desaturate' | 'noise';

/** Bivariate rendering settings shared by the editor, host and renderer. */
export interface BivariateOptions {
    /** How unreliable cells are de-emphasized. */
    readonly channel: UncertaintyChannel;
    /** Relative-error threshold (e.g. `0.1` = 10%); at or above it a bin is fully masked. */
    readonly maxRelativeError: number;
    /** CSS hex color painted on cells at/above `maxRelativeError`. */
    readonly lowQualityColor: string;
}

/** Runtime guard for persisted/deserialized uncertainty channels. */
export function isUncertaintyChannel(value: unknown): value is UncertaintyChannel {
    return value === 'opacity' || value === 'desaturate' || value === 'noise';
}

/** Defaults: fade unreliable cells, 10% threshold, neutral gray mask. */
export const DEFAULT_BIVARIATE_OPTIONS: BivariateOptions = {
    channel: 'opacity',
    maxRelativeError: 0.1,
    lowQualityColor: '#808080'
};

/** Neutral gray used when `lowQualityColor` is not a `#rgb`/`#rrggbb` string. */
const DEFAULT_MASK_COLOR: RgbColor = [128 / 255, 128 / 255, 128 / 255];

/**
 * Relative statistical error of one tally bin: `std / |mean|`.
 *
 * - Non-finite `mean`/`std`, and a negative `std` (not a standard
 *   deviation), return `NaN` — the uncertainty is unknown, not zero.
 * - An exact-zero bin (`mean = 0`, `std = 0`) returns `0`, matching the
 *   Python exporters' void-bin rule (`_tally_score_moments` keeps `std` at 0
 *   when the mean is exactly zero, and `rel-err` stays 0 there).
 * - A zero mean with a non-zero spread has no finite relative error and
 *   returns `Infinity`.
 */
export function relativeError(mean: number, std: number): number {
    if (!Number.isFinite(mean) || !Number.isFinite(std) || std < 0) {
        return Number.NaN;
    }
    if (mean === 0) {
        return std === 0 ? 0 : Number.POSITIVE_INFINITY;
    }
    return std / Math.abs(mean);
}

/**
 * Clamp/sanitize a configured relative-error threshold. Non-finite or
 * non-positive values fall back to {@link DEFAULT_BIVARIATE_OPTIONS}, so a
 * stale preference can never turn every bin into the mask color.
 */
export function normalizeMaxRelativeError(value: number): number {
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_BIVARIATE_OPTIONS.maxRelativeError;
}

/**
 * Quality weight for one relative error, in `[0, 1]`.
 *
 * `1` is a trustworthy bin (`relErr = 0`) and `0` is a bin at/above
 * `maxRelativeError` (or one whose error is `NaN`/`Infinity`, which must not
 * silently pass as good data). The falloff is linear between the two ends,
 * so weight `w` corresponds to `relErr = (1 - w) * maxRelativeError`.
 */
export function bivariateWeight(relErr: number, options: BivariateOptions): number {
    if (Number.isNaN(relErr)) {
        return 0;
    }
    if (relErr <= 0) {
        return 1;
    }
    const max = normalizeMaxRelativeError(options.maxRelativeError);
    if (relErr >= max) {
        return 0;
    }
    return 1 - relErr / max;
}

/**
 * Parse a `#rgb` / `#rrggbb` CSS color into sRGB channels in `[0, 1]`.
 * Returns undefined for anything else (named colors, `rgb(...)`, alpha
 * hex) — callers fall back to the default mask color.
 */
export function parseHexColor(value: string): RgbColor | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const hex = value.trim().replace(/^#/, '');
    if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(hex)) {
        return undefined;
    }
    const expanded = hex.length === 3 ? hex.replace(/(.)/g, '$1$1') : hex;
    return [parseInt(expanded.slice(0, 2), 16) / 255, parseInt(expanded.slice(2, 4), 16) / 255, parseInt(expanded.slice(4, 6), 16) / 255];
}

function clamp01(value: number): number {
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function clampWeight(value: number): number {
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * Color/alpha for one bin from the mean color and its quality weight.
 *
 * `meanColor` is the colormap sample (sRGB in `[0, 1]`). Every channel
 * blends linearly from the parsed `lowQualityColor` at `weight = 0` to
 * `meanColor` at `weight = 1`, so the mask color is what a fully
 * untrustworthy bin shows. Alpha is `weight` for the `opacity` channel and
 * `1` for `desaturate`/`noise` (those channels carry the quality in the
 * color or a renderer-side texture instead of transparency). Because the
 * opacity channel returns the mask color with alpha `0` at weight `0`, a
 * caller that must keep the mask visible there should composite it over a
 * background or floor the alpha itself. An invalid
 * mask color falls back to the default neutral gray, and a non-finite
 * weight is treated as `0` (mask it rather than show it as reliable).
 */
export function bivariateRgba(
    meanColor: readonly [number, number, number],
    weight: number,
    options: BivariateOptions
): [number, number, number, number] {
    const w = clampWeight(weight);
    const mask = parseHexColor(options.lowQualityColor) ?? parseHexColor(DEFAULT_BIVARIATE_OPTIONS.lowQualityColor) ?? DEFAULT_MASK_COLOR;
    const color: [number, number, number] = [
        mask[0] + (clamp01(meanColor[0]) - mask[0]) * w,
        mask[1] + (clamp01(meanColor[1]) - mask[1]) * w,
        mask[2] + (clamp01(meanColor[2]) - mask[2]) * w
    ];
    return [color[0], color[1], color[2], options.channel === 'opacity' ? w : 1];
}
