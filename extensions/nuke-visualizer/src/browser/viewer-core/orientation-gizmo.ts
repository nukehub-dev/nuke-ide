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
 * Orientation-gizmo projection math for the native 3D viewer core.
 *
 * A CAD-style orientation gizmo shows the six model-space axis directions
 * (±X/±Y/±Z) as seen by the active camera: each unit vector is projected
 * through the camera orientation into 2D overlay coordinates, so the overlay
 * rotates with the scene. Projection is rotation-only (orthographic onto the
 * unit circle) — the camera position never matters, only where it looks and
 * which way is up, so widgets bridge a plain {@link GizmoCameraPose} and
 * never pass three.js objects in.
 *
 * Pure functions + types only; no three.js, no DOM, no Theia imports.
 * Widgets drive `widgets/viewer-gizmo.tsx` imperatively:
 *
 * ```ts
 * const look = camera.getWorldDirection(new THREE.Vector3());
 * gizmo.update({ look: [look.x, look.y, look.z], up: [camera.up.x, camera.up.y, camera.up.z] });
 * ```
 */

/** A 3D vector as an xyz tuple. */
export type GizmoVector = [number, number, number];

/** One end of a model-space axis shown on the gizmo. */
export type GizmoAxisId = 'X' | 'Y' | 'Z' | '-X' | '-Y' | '-Z';

/** A gizmo axis: its knob id plus its model-space unit direction. */
export interface GizmoAxis {
    readonly id: GizmoAxisId;
    readonly direction: GizmoVector;
}

/** The six gizmo axes in knob order (positives first). */
export const GIZMO_AXES: readonly GizmoAxis[] = [
    { id: 'X', direction: [1, 0, 0] },
    { id: 'Y', direction: [0, 1, 0] },
    { id: 'Z', direction: [0, 0, 1] },
    { id: '-X', direction: [-1, 0, 0] },
    { id: '-Y', direction: [0, -1, 0] },
    { id: '-Z', direction: [0, 0, -1] }
];

/**
 * Camera pose for the projection: world-space look direction plus
 * world-space up. Neither needs to be unit length or orthogonal; degenerate
 * input falls back to the default pose instead of producing NaNs.
 */
export interface GizmoCameraPose {
    /** World-space camera look direction (need not be unit length). */
    readonly look: GizmoVector;
    /** World-space camera up (need not be unit length or orthogonal to look). */
    readonly up: GizmoVector;
}

/** Default pose (iso view): camera looks along -(1, 1, 1), Y up. */
export const DEFAULT_GIZMO_POSE: GizmoCameraPose = { look: [-1, -1, -1], up: [0, 1, 0] };

/**
 * One projected axis: overlay coordinates plus depth. `x`/`y` live on the
 * unit circle (right/up positive); `facing` is +1 when the axis points
 * straight at the camera (front) and -1 when it points away. `length` is the
 * on-screen spoke length — near zero means the axis runs along the view.
 */
export interface GizmoProjection {
    readonly axis: GizmoAxisId;
    readonly x: number;
    readonly y: number;
    readonly facing: number;
    readonly length: number;
}

/** A 2D overlay point in abstract gizmo units (scaled by the caller). */
export interface GizmoScreenPoint {
    readonly x: number;
    readonly y: number;
}

/** Screen octants (8 sectors of 45 degrees, counterclockwise from +X). */
export const GIZMO_OCTANT_COUNT = 8;

/**
 * Screen length below which an axis is "centered" (it runs along the view,
 * e.g. +Y in a top view) and belongs to no screen octant.
 */
export const GIZMO_CENTER_EPSILON = 1e-6;

/**
 * Click-to-snap direction for each gizmo knob, as a plain triple for the
 * orbit handle's `setViewDirection`.
 */
export const GIZMO_VIEW_DIRECTIONS: Record<GizmoAxisId, GizmoVector> = {
    X: [1, 0, 0],
    Y: [0, 1, 0],
    Z: [0, 0, 1],
    '-X': [-1, 0, 0],
    '-Y': [0, -1, 0],
    '-Z': [0, 0, -1]
};

function gizmoDot(a: GizmoVector, b: GizmoVector): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function gizmoCross(a: GizmoVector, b: GizmoVector): GizmoVector {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function gizmoLength(v: GizmoVector): number {
    return Math.sqrt(gizmoDot(v, v));
}

function isFiniteGizmoVector(v: GizmoVector): boolean {
    return Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}

/** Normalize `v` to unit length, falling back to `fallback` when degenerate or non-finite. Always unit. */
function normalizeGizmoOr(v: GizmoVector, fallback: GizmoVector): GizmoVector {
    if (isFiniteGizmoVector(v)) {
        const length = gizmoLength(v);
        if (length > 1e-12) {
            return [v[0] / length, v[1] / length, v[2] / length];
        }
    }
    const fallbackLength = gizmoLength(fallback);
    if (fallbackLength > 1e-12) {
        return [fallback[0] / fallbackLength, fallback[1] / fallbackLength, fallback[2] / fallbackLength];
    }
    return [1, 0, 0];
}

/** Orthonormal camera basis (right, up, look) with degenerate-input fallbacks. */
interface GizmoBasis {
    readonly right: GizmoVector;
    readonly up: GizmoVector;
    readonly look: GizmoVector;
}

function resolveGizmoBasis(pose: GizmoCameraPose): GizmoBasis {
    const look = normalizeGizmoOr(pose.look, DEFAULT_GIZMO_POSE.look);
    let up = isFiniteGizmoVector(pose.up) ? pose.up : DEFAULT_GIZMO_POSE.up;
    let right = gizmoCross(look, up);
    if (gizmoLength(right) <= 1e-9) {
        // Up runs parallel to the view: pick the world axis least aligned with it.
        const ax = Math.abs(look[0]);
        const ay = Math.abs(look[1]);
        const az = Math.abs(look[2]);
        up = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
        right = gizmoCross(look, up);
    }
    const rightNorm = normalizeGizmoOr(right, [1, 0, 0]);
    return { right: rightNorm, up: gizmoCross(rightNorm, look), look };
}

/**
 * Project the six model-space axes through a camera pose into overlay
 * coordinates. Returns one entry per {@link GIZMO_AXES} entry, in order.
 * The look direction is normalized internally, so the unit-circle invariant
 * `x*x + y*y + facing*facing === 1` holds for every pose (degenerate poses
 * resolve through the default pose instead of producing NaNs).
 */
export function projectGizmoAxes(pose: GizmoCameraPose): GizmoProjection[] {
    const basis = resolveGizmoBasis(pose);
    return GIZMO_AXES.map(({ id, direction }) => {
        // Normalize negative zero (vitest `toEqual` distinguishes -0 from 0).
        const x = gizmoDot(direction, basis.right) === 0 ? 0 : gizmoDot(direction, basis.right);
        const y = gizmoDot(direction, basis.up) === 0 ? 0 : gizmoDot(direction, basis.up);
        const facing = -gizmoDot(direction, basis.look) === 0 ? 0 : -gizmoDot(direction, basis.look);
        return { axis: id, x, y, facing, length: Math.sqrt(x * x + y * y) };
    });
}

/** Scale an overlay point by a spoke radius (non-finite/non-positive radii map to zero). */
export function toGizmoScreen(projection: Pick<GizmoProjection, 'x' | 'y'>, radius: number): GizmoScreenPoint {
    const scale = Number.isFinite(radius) ? Math.max(0, radius) : 0;
    return { x: projection.x * scale, y: projection.y * scale };
}

/**
 * Screen-octant bucket (0..7, counterclockwise from +X) for an overlay
 * point, or -1 when centered (below {@link GIZMO_CENTER_EPSILON}) or
 * non-finite. Octant 0 spans [-22.5°, +22.5°), octant 1 spans
 * [+22.5°, +67.5°), and so on.
 */
export function gizmoOctantFor(x: number, y: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return -1;
    }
    if (Math.sqrt(x * x + y * y) < GIZMO_CENTER_EPSILON) {
        return -1;
    }
    const angle = Math.atan2(y, x);
    const sector = Math.floor(((angle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4));
    return Math.min(GIZMO_OCTANT_COUNT - 1, Math.max(0, sector));
}

/**
 * Pick the front-most (highest `facing`) projection per occupied screen
 * octant — the overlap-resolution rule for gizmo hit-testing, so the knob on
 * top is always the axis pointing most toward the camera. Ties keep axis
 * order (positives first); centered axes belong to no octant and are skipped.
 */
export function pickFrontAxisPerOctant(projections: readonly GizmoProjection[]): GizmoProjection[] {
    const winners = new Map<number, GizmoProjection>();
    for (const projection of projections) {
        const octant = gizmoOctantFor(projection.x, projection.y);
        if (octant < 0) {
            continue;
        }
        const current = winners.get(octant);
        if (!current || projection.facing > current.facing) {
            winners.set(octant, projection);
        }
    }
    return [...winners.values()];
}
