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
 * Pure orthoslice extraction for axis-aligned cell-centered grids.
 *
 * Input grids follow the native VTK layout: `dims` is `[nx, ny, nz]` in
 * cells and `values` holds one scalar per cell with x fastest, i.e. cell
 * `(i, j, k)` lives at `i + nx * (j + ny * k)`. This matches
 * `NativeVtkModel.gridDimensions` / `gridAxes` plus the cell arrays the
 * viewer already decodes, so a slice never needs a server round-trip.
 *
 * Plane orientation (the first in-plane axis is horizontal/width, the
 * second is vertical/height, both ascending from row/column 0):
 *
 * - `X` → `Y × Z` (width `ny`, height `nz`)
 * - `Y` → `X × Z` (width `nx`, height `nz`)
 * - `Z` → `X × Y` (width `nx`, height `ny`)
 *
 * `fraction` is clamped to [0, 1] and mapped onto the cell-center axis
 * (`fraction * (dim - 1)`), so 0 is the first cell layer and 1 the last.
 * `nearest` picks one layer; `linear` blends the two adjacent layers.
 *
 * `axes` is part of the source contract for callers that need world
 * coordinates (the viewer provides cell-boundary axes from `gridAxes`);
 * extraction itself indexes cells only, so axes never affect the result.
 *
 * Pure data helpers only: no DOM, no three.js, no Theia imports.
 */

import { mapScalar, type ScalarMapping } from './scalar-mapping';

/** One axis-aligned slice plane. */
export type SliceAxis = 'X' | 'Y' | 'Z';

/** Axis order offered by slice tab/selector controls. */
export const SLICE_AXES: readonly SliceAxis[] = ['X', 'Y', 'Z'];

/** Sampling between two adjacent cell layers. */
export type SliceSamplingMode = 'nearest' | 'linear';

/**
 * One axis-aligned, cell-centered 3D grid.
 *
 * `dims` is `[nx, ny, nz]`; `values` holds exactly `nx * ny * nz` scalars
 * (x-fastest). Multi-component arrays must be reduced (component select or
 * magnitude) by the caller. `range` is the effective data range when the
 * caller already has one (auto/custom range); when absent the extracted
 * slice computes its own finite range.
 */
export interface GridSliceSource {
    readonly dims: readonly [number, number, number];
    readonly axes: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>];
    readonly values: ArrayLike<number>;
    readonly range?: readonly [number, number];
}

/** One extracted 2D slice, row-major with the first in-plane axis fastest. */
export interface GridSlice {
    readonly axis: SliceAxis;
    /** Dominant cell layer: the nearest layer, or the lower layer of a linear blend. */
    readonly index: number;
    readonly width: number;
    readonly height: number;
    readonly values: Float64Array;
    readonly range: readonly [number, number];
}

/** In-plane axes per slice axis: [horizontal (width), vertical (height)]. */
const IN_PLANE_AXES: Record<SliceAxis, readonly [number, number]> = {
    X: [1, 2],
    Y: [0, 2],
    Z: [0, 1]
};

const AXIS_INDEX: Record<SliceAxis, number> = { X: 0, Y: 1, Z: 2 };

function isSliceAxis(value: string): value is SliceAxis {
    return value === 'X' || value === 'Y' || value === 'Z';
}

function isPositiveInteger(value: number): boolean {
    return Number.isInteger(value) && value > 0;
}

/** Clamp a user fraction to [0, 1]; non-finite input pins to the first layer. */
function clampFraction(fraction: number): number {
    if (!Number.isFinite(fraction)) {
        return 0;
    }
    return fraction <= 0 ? 0 : fraction >= 1 ? 1 : fraction;
}

/** The finite [min, max] range of `count` values, or undefined when none are finite. */
function finiteRange(values: ArrayLike<number>, count: number): [number, number] | undefined {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < count; i++) {
        const value = values[i];
        if (!Number.isFinite(value)) {
            continue;
        }
        if (value < min) {
            min = value;
        }
        if (value > max) {
            max = value;
        }
    }
    return min <= max ? [min, max] : undefined;
}

/** Normalize an explicit range to ascending finite endpoints; undefined when unusable. */
function normalizeRange(range: readonly [number, number] | undefined): readonly [number, number] | undefined {
    if (!range || range.length !== 2 || !Number.isFinite(range[0]) || !Number.isFinite(range[1])) {
        return undefined;
    }
    return range[0] <= range[1] ? [range[0], range[1]] : [range[1], range[0]];
}

/** In-plane `[width, height]` for a grid and axis (useful for previews). */
export function slicePlaneSize(dims: readonly [number, number, number], axis: SliceAxis): [number, number] {
    const [horizontal, vertical] = IN_PLANE_AXES[axis];
    return [dims[horizontal], dims[vertical]];
}

/**
 * Extract the orthoslice at `fraction` along `axis`.
 *
 * Returns undefined for a malformed source: non-finite/non-positive or
 * non-integer `dims`, a `values` length that does not match `nx * ny * nz`,
 * or an unknown axis.
 */
export function extractGridSlice(
    source: GridSliceSource,
    axis: SliceAxis,
    fraction: number,
    mode: SliceSamplingMode = 'nearest'
): GridSlice | undefined {
    if (!source || !isSliceAxis(axis)) {
        return undefined;
    }
    const dims = source.dims;
    if (!dims || dims.length !== 3 || !dims.every(isPositiveInteger)) {
        return undefined;
    }
    const [nx, ny, nz] = dims;
    const cellCount = nx * ny * nz;
    const values = source.values;
    if (!Number.isSafeInteger(cellCount) || !values || values.length !== cellCount) {
        return undefined;
    }

    const axisIndex = AXIS_INDEX[axis];
    const axisCells = dims[axisIndex];
    const position = axisCells > 1 ? clampFraction(fraction) * (axisCells - 1) : 0;

    let lower: number;
    let upper: number;
    let blend = 0;
    if (mode === 'linear' && axisCells > 1) {
        lower = Math.min(axisCells - 1, Math.max(0, Math.floor(position)));
        upper = Math.min(axisCells - 1, lower + 1);
        blend = Math.min(1, Math.max(0, position - lower));
    } else {
        lower = axisCells > 1 ? Math.min(axisCells - 1, Math.max(0, Math.round(position))) : 0;
        upper = lower;
    }

    const strides: readonly [number, number, number] = [1, nx, nx * ny];
    const [horizontal, vertical] = IN_PLANE_AXES[axis];
    const width = dims[horizontal];
    const height = dims[vertical];
    const columnStride = strides[horizontal];
    const rowStride = strides[vertical];
    const lowerBase = lower * strides[axisIndex];
    const upperBase = upper * strides[axisIndex];

    const sliceValues = new Float64Array(width * height);
    let at = 0;
    for (let row = 0; row < height; row++) {
        const lowerRow = lowerBase + row * rowStride;
        const upperRow = upperBase + row * rowStride;
        for (let column = 0; column < width; column++) {
            const cell = lowerRow + column * columnStride;
            if (blend === 0) {
                sliceValues[at++] = values[cell];
            } else {
                const lowerValue = values[cell];
                sliceValues[at++] = lowerValue + (values[upperRow + column * columnStride] - lowerValue) * blend;
            }
        }
    }

    const range: readonly [number, number] = normalizeRange(source.range) ?? finiteRange(sliceValues, sliceValues.length) ?? [0, 0];
    return { axis, index: lower, width, height, values: sliceValues, range };
}

function toByte(channel: number): number {
    return Math.round(Math.min(1, Math.max(0, channel)) * 255);
}

/**
 * Paint a slice with the viewer's scalar mapping (colormap, effective range,
 * log/invert/component semantics shared with the 3D path).
 *
 * Pixel order matches `slice.values`, RGBA with full alpha for every mapped
 * value. Non-finite values (and non-positive values under log scaling) take
 * `mapScalar`'s `nanColor` path; when the preset defines no NaN color the
 * pixel stays fully transparent instead of pretending to be data.
 */
export function sliceToRgba(slice: GridSlice, mapping: ScalarMapping): Uint8ClampedArray {
    const pixelCount = slice.width * slice.height;
    const rgba = new Uint8ClampedArray(pixelCount * 4);
    for (let i = 0; i < pixelCount; i++) {
        const color = mapScalar(slice.values[i], mapping);
        if (!color) {
            continue;
        }
        const at = i * 4;
        rgba[at] = toByte(color[0]);
        rgba[at + 1] = toByte(color[1]);
        rgba[at + 2] = toByte(color[2]);
        rgba[at + 3] = 255;
    }
    return rgba;
}
