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
 * Threshold (hide-cells-outside-a-range) math for the native 3D viewer core:
 * a per-cell visibility predicate over the active scalar array + range,
 * ParaView `Threshold` parity computed client-side with no backend work.
 *
 * The predicate resolves through the same tuple scalars the color-by
 * pipeline paints (`tupleScalar` in `scalar-mapping.ts`, honoring the
 * active component pick), so thresholding the active array — parsed or a
 * transient `derived(<expr>)` field — always agrees with the colors:
 *
 * - finite values are visible exactly inside the inclusive `[min, max]`
 *   window;
 * - non-finite values (NaN from divide-by-zero derived fields, missing
 *   tuples) stay visible, consistent with the `nanColor` convention (the
 *   mapper renders them instead of dropping them);
 * - an empty window (`min === max`) keeps exact matches only;
 * - an inverted window normalizes to the sorted range (Range-slider
 *   parity — `resolveEffectiveRange` sorts swapped endpoints the same way);
 * - a non-finite endpoint disables the window (no range to test against).
 *
 * A cell with several tuples (triangle corners over point data, segment
 * endpoints) is visible when any of its tuples passes — the VTK
 * `vtkThreshold` rule for point data. Collapsing hidden primitives is the
 * widget's job (zero-area triangles / zero-length segments /
 * scale-zero voxel instances); this module only decides visibility and
 * performs the in-place soup collapse.
 *
 * Pure functions + types only; no three.js, no DOM, no Theia imports.
 */

import { tupleScalar } from './scalar-mapping';

/**
 * Normalize a threshold window: non-finite endpoints carry no range (the
 * window cannot apply), otherwise endpoints sort ascending so an inverted
 * input still works (Range-slider parity).
 */
export function normalizeThresholdRange(min: number, max: number): [number, number] | undefined {
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
        return undefined;
    }
    return min <= max ? [min, max] : [max, min];
}

/**
 * Whether one scalar survives the threshold window (inclusive on both
 * ends). Non-finite values stay visible — the `nanColor` convention renders
 * them instead of dropping them, so thresholding never hides what the
 * colormap still paints.
 */
export function thresholdScalarVisible(value: number, min: number, max: number): boolean {
    if (!Number.isFinite(value)) {
        return true;
    }
    return value >= min && value <= max;
}

/**
 * Whether one array tuple survives the threshold window. `component`
 * follows the active color-by pick (`MAGNITUDE_COMPONENT` collapses vectors
 * to their L2 norm, exactly like the painted colors). Out-of-range tuples
 * read as NaN and stay visible, so unmapped primitives never vanish.
 */
export function thresholdTupleVisible(
    values: ArrayLike<number>,
    components: number,
    tuple: number,
    component: number,
    min: number,
    max: number
): boolean {
    return thresholdScalarVisible(tupleScalar(values, components, tuple, component), min, max);
}

/** Visible/total tuple counts over one scalar series (NaN counts as visible). */
export interface ThresholdCoverage {
    readonly visible: number;
    readonly total: number;
}

/** Count the tuples surviving the window (one pass; used for the status line). */
export function countThresholdVisible(
    values: ArrayLike<number>,
    components: number,
    component: number,
    min: number,
    max: number
): ThresholdCoverage {
    const total = Math.floor(values.length / Math.max(1, components));
    let visible = 0;
    for (let tuple = 0; tuple < total; tuple++) {
        if (thresholdTupleVisible(values, components, tuple, component, min, max)) {
            visible++;
        }
    }
    return { visible, total };
}

/**
 * Per-triangle hidden flags for a non-indexed corner soup: triangle `t`
 * (corners `3t..3t+2`) hides only when every corner tuple fails (a cell is
 * visible when any of its tuples passes — the VTK point-data rule).
 */
export function hiddenTriangles(
    triangleCount: number,
    tupleOfVertex: (vertex: number) => number,
    tupleVisible: (tuple: number) => boolean
): Uint8Array {
    const hidden = new Uint8Array(triangleCount);
    for (let t = 0; t < triangleCount; t++) {
        const base = t * 3;
        if (!tupleVisible(tupleOfVertex(base)) && !tupleVisible(tupleOfVertex(base + 1)) && !tupleVisible(tupleOfVertex(base + 2))) {
            hidden[t] = 1;
        }
    }
    return hidden;
}

/**
 * Collapse hidden triangles in place: every hidden corner triplet folds
 * onto its first corner (zero-area, finite — bounds stay sane and the
 * rebuilt edges overlay contributes only zero-length, invisible lines).
 */
export function collapseTriangleSoup(soup: Float32Array, hidden: Uint8Array): void {
    for (let t = 0; t < hidden.length; t++) {
        if (hidden[t] === 0) {
            continue;
        }
        const base = t * 9;
        const x = soup[base];
        const y = soup[base + 1];
        const z = soup[base + 2];
        soup[base + 3] = x;
        soup[base + 4] = y;
        soup[base + 5] = z;
        soup[base + 6] = x;
        soup[base + 7] = y;
        soup[base + 8] = z;
    }
}

/**
 * Per-segment hidden flags for an expanded vertex-pair soup: segment `s`
 * (vertices `2s..2s+1`) hides only when both endpoint tuples fail.
 */
export function hiddenSegments(
    segmentCount: number,
    tupleOfVertex: (vertex: number) => number,
    tupleVisible: (tuple: number) => boolean
): Uint8Array {
    const hidden = new Uint8Array(segmentCount);
    for (let s = 0; s < segmentCount; s++) {
        const base = s * 2;
        if (!tupleVisible(tupleOfVertex(base)) && !tupleVisible(tupleOfVertex(base + 1))) {
            hidden[s] = 1;
        }
    }
    return hidden;
}

/** Collapse hidden segments in place: the second endpoint folds onto the first (zero-length, invisible). */
export function collapseSegmentSoup(soup: Float32Array, hidden: Uint8Array): void {
    for (let s = 0; s < hidden.length; s++) {
        if (hidden[s] === 0) {
            continue;
        }
        const base = s * 6;
        soup[base + 3] = soup[base];
        soup[base + 4] = soup[base + 1];
        soup[base + 5] = soup[base + 2];
    }
}

/** Per-vertex hidden flags for a point soup. */
export function hiddenPoints(
    vertexCount: number,
    tupleOfVertex: (vertex: number) => number,
    tupleVisible: (tuple: number) => boolean
): Uint8Array {
    const hidden = new Uint8Array(vertexCount);
    for (let v = 0; v < vertexCount; v++) {
        if (!tupleVisible(tupleOfVertex(v))) {
            hidden[v] = 1;
        }
    }
    return hidden;
}

/**
 * Collapse hidden points in place to NaN (the GPU drops NaN vertices, the
 * same assumption the existing `?? Number.NaN` soup fallbacks already
 * make). Callers switch the cloud to `frustumCulled = false` while any
 * point hides so a NaN-poisoned bounding sphere can never cull the cloud.
 *
 * Returns the number of hidden vertices (0 means the soup is untouched).
 */
export function collapsePointSoup(soup: Float32Array, hidden: Uint8Array): number {
    let count = 0;
    for (let v = 0; v < hidden.length; v++) {
        if (hidden[v] === 0) {
            continue;
        }
        const base = v * 3;
        soup[base] = Number.NaN;
        soup[base + 1] = Number.NaN;
        soup[base + 2] = Number.NaN;
        count++;
    }
    return count;
}
