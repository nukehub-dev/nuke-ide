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
 * Scalar-to-color mapping pipeline for the native 3D viewers.
 *
 * One pure path shared by every viewer: pick the scalar from a (possibly
 * multi-component) tuple, resolve the effective range (auto = data range, or
 * a user range), map to the unit interval (linear or log), invert on demand,
 * and sample the colormap. Non-finite values — and non-positive values under
 * log scaling — map to the preset's `nanColor` when it defines one, or to
 * null so the caller can fall back (native viewers fall back to the solid
 * color, matching the pre-LUT behavior).
 *
 * Pure functions + types only; no three.js, no DOM, no Theia imports.
 */

import { ColormapDefinition, RgbColor, rgbToCss, sampleColormap } from './colormaps';

/** Component selector for multi-component arrays: -1 is the L2 magnitude. */
export const MAGNITUDE_COMPONENT = -1;

/** Everything needed to map one scalar tuple to a color. */
export interface ScalarMapping {
    readonly definition: ColormapDefinition;
    /** Effective (already resolved) range. */
    readonly range: readonly [number, number];
    readonly logScale: boolean;
    readonly invert: boolean;
    /** Component index, or {@link MAGNITUDE_COMPONENT}. */
    readonly component: number;
}

export type ColorRangeMode = 'auto' | 'custom';

/**
 * Extract the scalar for one tuple. `component` picks a single component;
 * {@link MAGNITUDE_COMPONENT} (or any out-of-range index) falls back to the
 * L2 norm over all components. Single-component arrays pass through.
 */
export function tupleScalar(
    values: ArrayLike<number>,
    components: number,
    tupleIndex: number,
    component: number = MAGNITUDE_COMPONENT
): number {
    const offset = tupleIndex * components;
    if (components <= 1) {
        return values[offset];
    }
    if (component >= 0 && component < components) {
        return values[offset + component];
    }
    let sum = 0;
    for (let c = 0; c < components; c++) {
        const v = values[offset + c];
        sum += v * v;
    }
    return Math.sqrt(sum);
}

/** Axis labels used for the component picker. */
export const VECTOR_COMPONENT_LABELS = ['X', 'Y', 'Z'] as const;

/**
 * Component picker options for an array with `components` components:
 * always Magnitude first, then one entry per component (up to 3 named,
 * `Component N` beyond).
 */
export function componentOptions(components: number): readonly { value: number; label: string }[] {
    if (components <= 1) {
        return [];
    }
    const options = [{ value: MAGNITUDE_COMPONENT, label: 'Magnitude' }];
    for (let c = 0; c < components; c++) {
        options.push({ value: c, label: VECTOR_COMPONENT_LABELS[c] ?? `Component ${c}` });
    }
    return options;
}

/**
 * Resolve the effective range: `auto` is the data range; `custom` is the
 * user range (endpoints sorted so a swapped min/max still works). A custom
 * range with equal endpoints degenerates to the data range (a zero-width
 * range would paint everything one color).
 */
export function resolveEffectiveRange(
    mode: ColorRangeMode,
    dataRange: readonly [number, number],
    customRange: readonly [number, number] | undefined
): [number, number] {
    if (mode === 'custom' && customRange && customRange.every(Number.isFinite) && customRange[0] !== customRange[1]) {
        return customRange[0] < customRange[1] ? [customRange[0], customRange[1]] : [customRange[1], customRange[0]];
    }
    return [dataRange[0], dataRange[1]];
}

/** Log scaling needs a strictly positive range. */
export function logScaleAvailable(range: readonly [number, number]): boolean {
    return range[0] > 0 && range[1] > 0;
}

/** Normalize `value` into [0, 1] over `range` (clamped); a degenerate range maps to 0. */
export function normalizeToRange(value: number, range: readonly [number, number]): number {
    const [min, max] = range;
    if (max <= min) {
        return 0;
    }
    return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/**
 * Map one scalar to an sRGB color. Non-finite values, and non-positive
 * values under log scaling, resolve to the preset `nanColor` or null.
 */
export function mapScalar(value: number, mapping: ScalarMapping): RgbColor | null {
    if (!Number.isFinite(value)) {
        return mapping.definition.nanColor;
    }
    let t: number;
    if (mapping.logScale) {
        if (!logScaleAvailable(mapping.range) || value <= 0) {
            return mapping.definition.nanColor;
        }
        const [min, max] = mapping.range;
        t = normalizeToRange(Math.log(value), [Math.log(min), Math.log(max)]);
    } else {
        t = normalizeToRange(value, mapping.range);
    }
    return sampleColormap(mapping.definition, mapping.invert ? 1 - t : t);
}

/** Legend-label formatting parity with the existing viewers. */
export function formatRangeValue(value: number): string {
    return Number(value).toPrecision(3);
}

/**
 * Build the legend CSS gradient for a mapping (honors invert, so the bar
 * matches the painted colors left-to-right from range min to max).
 */
export function mappingToCssGradient(mapping: ScalarMapping, samples = 8): string {
    const stops: string[] = [];
    for (let i = 0; i < samples; i++) {
        const t = samples === 1 ? 0 : i / (samples - 1);
        stops.push(rgbToCss(sampleColormap(mapping.definition, mapping.invert ? 1 - t : t)));
    }
    return `linear-gradient(to right, ${stops.join(', ')})`;
}
