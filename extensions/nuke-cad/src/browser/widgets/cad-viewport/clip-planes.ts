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
 * Per-render camera clip planes for the CAD viewport.
 *
 * A fixed far plane silently clips anything larger than a few metres — the
 * tokamak document's bounding diagonal is ≈ 6.4 km, so its solids sit beyond a
 * `far = 10000` plane and vanish. A fixed `near = 0.01` paired with that far
 * plane is also a 1e6 depth ratio, which z-fights concentric shells.
 *
 * Both planes therefore scale with the scene: `near` follows the camera
 * distance (with a radius-based floor for close-ups) and `far` always sits
 * beyond the model's far side.
 */

/** Absolute lower bound for the near plane, in world units. */
const MIN_NEAR = 1e-4;
/** The far plane must stay at least this many times beyond the near plane. */
const MIN_FAR_TO_NEAR_RATIO = 10;
/** Near plane as a fraction of the camera-to-target distance. */
const NEAR_DISTANCE_FRACTION = 0.01;
/** Near plane as a fraction of the model radius (covers dolly-ins). */
const NEAR_RADIUS_FRACTION = 1e-4;

export interface ClipPlanes {
    near: number;
    far: number;
}

/** Clamp non-finite and negative inputs to zero so the frustum stays valid. */
function clampInput(value: number): number {
    return Number.isFinite(value) ? Math.max(value, 0) : 0;
}

/**
 * Clip planes for a camera `distance` away from its orbit target, framing a
 * model of `modelRadius` (half its bounding diagonal).
 *
 * `far` is never closer than three radii beyond the camera-to-target distance
 * nor ten radii from the camera, so the whole model stays inside the frustum
 * at fit distance and while dollying. The far/near ratio stays bounded (at
 * most about 290 at fit distance) instead of the old fixed 1e6.
 */
export function computeClipPlanes(distance: number, modelRadius: number): ClipPlanes {
    const safeDistance = clampInput(distance);
    const safeRadius = clampInput(modelRadius);
    let near = Math.max(safeDistance * NEAR_DISTANCE_FRACTION, safeRadius * NEAR_RADIUS_FRACTION, MIN_NEAR);
    const far = Math.max(safeDistance + safeRadius * 3, safeRadius * 10, MIN_NEAR * MIN_FAR_TO_NEAR_RATIO);
    // Degenerate scenes (zero distance and radius) collapse the two planes
    // onto each other; pull the near plane back to keep usable depth range.
    if (far <= near * MIN_FAR_TO_NEAR_RATIO) {
        near = far / (MIN_FAR_TO_NEAR_RATIO * 2);
    }
    return { near, far };
}
