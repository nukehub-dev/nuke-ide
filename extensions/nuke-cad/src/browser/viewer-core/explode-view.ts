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
 * Explode-view math for the CAD viewport.
 *
 * Pure transform planning shared by the viewport widget: each solid moves away
 * from the model's global bounding-box center along the direction from the
 * center to the solid's own centroid, scaled by the model diagonal, the
 * slider factor, and EXPLODE_MAX_SPAN. Offsets are applied as object `.position` transforms only —
 * never geometry edits — so the mesh reuse pool is untouched and picking (which
 * raycasts world matrices) keeps working on exploded models.
 *
 * @module nuke-cad/browser/viewer-core
 */

/** World-space point (x, y, z) in model units. */
export type ExplodePoint3D = readonly [number, number, number];

/** Axis-aligned bounding box in model units. */
export interface ExplodeBoundingBox {
    readonly min: number[];
    readonly max: number[];
}

/** Per-solid input: positional solid index plus its approximated centroid. */
export interface ExplodeSolidCentroid {
    readonly solidId: number;
    readonly centroid: ExplodePoint3D;
}

/** Distance below which a direction is treated as degenerate (zero offset). */
export const EXPLODE_EPSILON = 1e-9;

// At factor 1 each solid moves only a fraction of the model diagonal so large
// assemblies such as the tokamak stay in frame instead of flying out of view.
export const EXPLODE_MAX_SPAN = 0.35;

export function clampExplodeFactor(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.min(1, Math.max(0, value));
}

/**
 * Offset for one solid: `normalize(centroid - center) * diagonal * factor * EXPLODE_MAX_SPAN`.
 *
 * A centroid coinciding with the global center (or a zero/negative factor)
 * yields the zero vector — the solid simply does not move, which is the
 * correct behavior for a solid at the explode origin. A single centered solid
 * has nothing to separate from, so there is deliberately no fallback axis:
 * it stays at zero.
 */
export function explodeOffset(centroid: ExplodePoint3D, center: ExplodePoint3D, diagonal: number, factor: number): ExplodePoint3D {
    const dx = centroid[0] - center[0];
    const dy = centroid[1] - center[1];
    const dz = centroid[2] - center[2];
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length < EXPLODE_EPSILON || !(diagonal > 0) || factor <= 0) {
        return [0, 0, 0];
    }
    const scale = (diagonal * clampExplodeFactor(factor) * EXPLODE_MAX_SPAN) / length;
    return [dx * scale, dy * scale, dz * scale];
}

/** Center and diagonal of an axis-aligned bounding box. */
export function explodeBoxCenterDiagonal(box: ExplodeBoundingBox): { center: ExplodePoint3D; diagonal: number } {
    const center: ExplodePoint3D = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
    const diagonal = Math.sqrt((box.max[0] - box.min[0]) ** 2 + (box.max[1] - box.min[1]) ** 2 + (box.max[2] - box.min[2]) ** 2);
    return { center, diagonal };
}

/**
 * Plan the explode offsets for a whole model: solidId → world-space offset.
 *
 * With `factor` 0 the plan is all-zero (the assembled model) regardless of
 * inputs; callers can skip centroid computation entirely in that case.
 */
export function planExplodeOffsets(
    solids: readonly ExplodeSolidCentroid[],
    box: ExplodeBoundingBox,
    factor: number
): Map<number, ExplodePoint3D> {
    const offsets = new Map<number, ExplodePoint3D>();
    const clamped = clampExplodeFactor(factor);
    if (clamped <= 0) {
        for (const solid of solids) {
            offsets.set(solid.solidId, [0, 0, 0]);
        }
        return offsets;
    }
    const { center, diagonal } = explodeBoxCenterDiagonal(box);
    for (const solid of solids) {
        offsets.set(solid.solidId, explodeOffset(solid.centroid, center, diagonal, clamped));
    }
    return offsets;
}
