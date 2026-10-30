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
 * Volume transfer function for the native raycast volume.
 *
 * Colors stay on the shared `ScalarMapping` pipeline (`mapScalar`, so
 * colormap, range, log scale, invert, and NaN behave exactly like the
 * surface/voxel paths); the transfer function only replaces the old
 * `opacity * intensity` alpha ramp with an editable 1D curve over display
 * intensity. `DEFAULT_OPACITY_STOPS` is the identity ramp, which keeps the
 * legacy MIP look byte-for-byte.
 *
 * Blend mode and shading live here as pure option types so settings,
 * persistence, and the raycast shader share one vocabulary. This module has
 * no three.js/DOM/Theia imports.
 */

import { mapScalar, normalizeToRange, type ScalarMapping } from './scalar-mapping';

/**
 * One opacity control point. `t` is display intensity in [0, 1]: the data
 * value mapped through `mapping.range` and log scaling (clamped), with
 * invert excluded — invert only flips the color ramp.
 */
export interface OpacityStop {
    readonly t: number;
    readonly alpha: number;
}

/** Hard cap on control points (settings editors should not exceed it). */
export const MAX_OPACITY_STOPS = 16;

/**
 * Identity ramp: alpha follows display intensity exactly, matching the
 * pre-transfer-function `opacity * t` behavior (including zero alpha at
 * exact-zero data).
 */
export const DEFAULT_OPACITY_STOPS: readonly OpacityStop[] = Object.freeze([
    Object.freeze({ t: 0, alpha: 0 }),
    Object.freeze({ t: 1, alpha: 1 })
]);

/** How the raycast shader combines samples along a ray. */
export type VolumeBlendMode = 'mip' | 'composite';

/** Volume transfer function state shared by settings, widgets, and the LUT builder. */
export interface VolumeTransferOptions {
    readonly opacityStops: readonly OpacityStop[];
    readonly blendMode: VolumeBlendMode;
    readonly shade: boolean;
}

/** Defaults preserve the existing boxes + MIP presentation. */
export const DEFAULT_VOLUME_TRANSFER: VolumeTransferOptions = Object.freeze({
    opacityStops: DEFAULT_OPACITY_STOPS,
    blendMode: 'mip',
    shade: false
});

function clampUnit(value: number): number {
    return Math.min(1, Math.max(0, value));
}

/**
 * Normalize an editable stop list into a usable ramp:
 *
 * - non-finite `t` entries are dropped; `t` and `alpha` clamp to [0, 1]
 * - sorted ascending by `t` (stable, so equal positions keep input order)
 * - duplicate positions collapse to the later input stop
 * - more than {@link MAX_OPACITY_STOPS} points downsample evenly while
 *   keeping both endpoints
 * - an empty result falls back to {@link DEFAULT_OPACITY_STOPS}
 *
 * Always returns a fresh array; callers may mutate the result.
 */
export function normalizeOpacityStops(stops: readonly OpacityStop[]): OpacityStop[] {
    const cleaned: OpacityStop[] = [];
    for (const stop of stops) {
        if (!Number.isFinite(stop.t)) {
            continue;
        }
        cleaned.push({
            t: clampUnit(stop.t),
            alpha: Number.isFinite(stop.alpha) ? clampUnit(stop.alpha) : 0
        });
    }
    if (cleaned.length === 0) {
        return DEFAULT_OPACITY_STOPS.map((stop) => ({ t: stop.t, alpha: stop.alpha }));
    }
    cleaned.sort((a, b) => a.t - b.t);
    const deduped: OpacityStop[] = [];
    for (const stop of cleaned) {
        const previous = deduped[deduped.length - 1];
        if (previous && previous.t === stop.t) {
            deduped[deduped.length - 1] = stop;
        } else {
            deduped.push(stop);
        }
    }
    if (deduped.length <= MAX_OPACITY_STOPS) {
        return deduped;
    }
    const capped: OpacityStop[] = [];
    for (let i = 0; i < MAX_OPACITY_STOPS; i++) {
        const index = Math.round((i * (deduped.length - 1)) / (MAX_OPACITY_STOPS - 1));
        capped.push(deduped[index]);
    }
    return capped;
}

function sampleNormalizedOpacity(stops: readonly OpacityStop[], t: number): number {
    if (!Number.isFinite(t)) {
        return 0;
    }
    const clamped = clampUnit(t);
    const first = stops[0];
    if (clamped <= first.t) {
        return first.alpha;
    }
    const last = stops[stops.length - 1];
    if (clamped >= last.t) {
        return last.alpha;
    }
    for (let i = 1; i < stops.length; i++) {
        const next = stops[i];
        if (clamped <= next.t) {
            const previous = stops[i - 1];
            const span = next.t - previous.t;
            const local = span <= 0 ? 0 : (clamped - previous.t) / span;
            return previous.alpha + (next.alpha - previous.alpha) * local;
        }
    }
    return last.alpha;
}

/**
 * Sample the piecewise-linear opacity ramp at display intensity `t`.
 * Input is clamped to [0, 1]; values before the first / after the last
 * stop hold that stop's alpha. Stops are normalized defensively (sorted,
 * clamped, deduped), an empty list means {@link DEFAULT_OPACITY_STOPS},
 * and a non-finite `t` samples as fully transparent.
 */
export function sampleOpacity(stops: readonly OpacityStop[], t: number): number {
    return sampleNormalizedOpacity(normalizeOpacityStops(stops), t);
}

/**
 * Display intensity for a data value: the same range/log/positive rules as
 * `mapScalar`, deliberately NOT inverted (alpha follows data magnitude while
 * invert only flips the colormap direction).
 */
function displayIntensity(value: number, mapping: ScalarMapping): number {
    if (mapping.logScale) {
        const [min, max] = mapping.range;
        return min > 0 && max > 0 ? normalizeToRange(Math.log(value), [Math.log(min), Math.log(max)]) : 0;
    }
    return normalizeToRange(value, mapping.range);
}

/**
 * Build an RGBA lookup texture from a resolved `ScalarMapping` and a
 * transfer function. Color semantics are identical to `buildVolumeLut`
 * (`mapScalar`, so range/log/invert/NaN match the surface paths); alpha is
 * `sampleOpacity(t) * opacity` where `t` is the display intensity.
 *
 * Exact-zero data keeps zero alpha (collapsed empty cells stay invisible),
 * as do non-positive values under log scaling and non-finite data. `size`
 * defaults to the 256 entries the raycast shader expects; `opacity` is the
 * optional widget-level multiplier kept separate from the editable ramp.
 */
export function buildVolumeTransferLut(
    mapping: ScalarMapping,
    dataRange: readonly [number, number],
    options: VolumeTransferOptions,
    size = 256,
    opacity = 1
): Uint8Array<ArrayBuffer> {
    const entryCount = Number.isFinite(size) ? Math.max(1, Math.floor(size)) : 256;
    const lut = new Uint8Array(new ArrayBuffer(entryCount * 4));
    const stops = normalizeOpacityStops(options.opacityStops);
    const globalAlpha = Number.isFinite(opacity) ? clampUnit(opacity) : 1;
    const [dataMin, dataMax] = dataRange;
    const span = dataMax - dataMin;
    const logAvailable = !mapping.logScale || (mapping.range[0] > 0 && mapping.range[1] > 0);
    for (let i = 0; i < entryCount; i++) {
        const position = entryCount === 1 ? 0 : i / (entryCount - 1);
        const dataValue = Number.isFinite(span) && span > 0 ? dataMin + position * span : 0;
        const rgb = mapScalar(dataValue, mapping) ?? [0, 0, 0];
        const at = i * 4;
        lut[at] = Math.round(clampUnit(rgb[0]) * 255);
        lut[at + 1] = Math.round(clampUnit(rgb[1]) * 255);
        lut[at + 2] = Math.round(clampUnit(rgb[2]) * 255);
        let alpha = 0;
        if (Number.isFinite(dataValue) && dataValue !== 0 && logAvailable && !(mapping.logScale && dataValue <= 0)) {
            alpha = sampleNormalizedOpacity(stops, displayIntensity(dataValue, mapping)) * globalAlpha;
        }
        lut[at + 3] = Math.round(clampUnit(alpha) * 255);
    }
    return lut;
}
