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
 * Arbitrary-normal clip-plane state for the native 3D viewer core.
 *
 * Generalizes the axis-only section plane from nuke-cad
 * (`viewer-core/section-plane.ts`, axis + flip + fraction by design) to the
 * full plane-clip semantics ParaView exposes (`vtkPVClipDataSet` origin /
 * normal / invert): any unit normal, any origin point, and a side flip.
 *
 * Pure functions + types only; no trame, no vuetify, no DOM, no three.js
 * import. {@link toThreePlaneParams} returns `{ normal, constant }` tuples
 * that map 1:1 onto `THREE.Plane`:
 *
 * ```ts
 * const params = toThreePlaneParams(state);
 * const plane = new THREE.Plane(new THREE.Vector3(...params.normal), params.constant);
 * renderer.localClippingEnabled = true;
 * material.clippingPlanes = [plane];
 * ```
 *
 * three.js discards fragments with a negative signed distance
 * (`normal.dot(point) + constant < 0`), so with `invert: false` the kept
 * half-space is `{ p : n . (p - origin) >= 0 }` — the side the normal points
 * into is removed. `invert: true` keeps the opposite side.
 */

/** A 3D vector as an xyz tuple. */
export type Vector3Tuple = [number, number, number];

/**
 * Clip-plane state: an arbitrary (not necessarily unit) normal, an origin
 * point on the plane, and a flag selecting which half-space is kept.
 */
export interface ClipPlaneState {
    readonly normal: Vector3Tuple;
    readonly origin: Vector3Tuple;
    readonly invert: boolean;
}

/** Axis-aligned bounding box of a dataset (world coordinates). */
export interface AxisAlignedBounds {
    readonly min: Vector3Tuple;
    readonly max: Vector3Tuple;
}

/**
 * three.js `Plane` parameters: `distanceToPoint(p) = normal . p + constant`.
 * The normal is always unit length; `constant = -(normal . origin)`, negated
 * again when the state is inverted.
 */
export interface ThreePlaneParams {
    readonly normal: Vector3Tuple;
    readonly constant: number;
}

/** Default clip state: +X normal through the world origin, nothing inverted. */
export const DEFAULT_CLIP_PLANE_STATE: ClipPlaneState = {
    normal: [1, 0, 0],
    origin: [0, 0, 0],
    invert: false
};

/** Fallback normal used when a caller supplies a zero or non-finite vector. */
export const FALLBACK_CLIP_NORMAL: Vector3Tuple = [1, 0, 0];

/** Length of a vector; non-finite components count as zero length. */
export function vectorLength(value: readonly [number, number, number]): number {
    const [x, y, z] = value;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        return 0;
    }
    return Math.sqrt(x * x + y * y + z * z);
}

/** Normalize a vector to unit length; zero/non-finite input yields the +X fallback. */
export function normalizeClipNormal(value: readonly [number, number, number]): Vector3Tuple {
    const length = vectorLength(value);
    if (!(length > 0)) {
        return [...FALLBACK_CLIP_NORMAL];
    }
    return [value[0] / length, value[1] / length, value[2] / length];
}

/** Copy a raw xyz triple, replacing non-finite components with `fallback`. */
export function sanitizePoint(value: readonly [number, number, number], fallback = 0): Vector3Tuple {
    const clean = (v: number): number => (Number.isFinite(v) ? v : fallback);
    return [clean(value[0]), clean(value[1]), clean(value[2])];
}

/** Normalize negative zero to positive zero (vitest `toEqual` distinguishes them). */
function canonicalZero(value: number): number {
    return value === 0 ? 0 : value;
}

/** Create a clip state from a partial patch over the defaults. */
export function createClipPlaneState(patch: Partial<ClipPlaneState> = {}): ClipPlaneState {
    return {
        normal: patch.normal !== undefined ? normalizeClipNormal(patch.normal) : [...DEFAULT_CLIP_PLANE_STATE.normal],
        origin: patch.origin !== undefined ? sanitizePoint(patch.origin) : [...DEFAULT_CLIP_PLANE_STATE.origin],
        invert: patch.invert ?? DEFAULT_CLIP_PLANE_STATE.invert
    };
}

/** Runtime guard for clip-plane states (finite xyz triples plus a boolean flag). */
export function isClipPlaneState(value: unknown): value is ClipPlaneState {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value as Record<string, unknown>;
    const isTuple = (entry: unknown): entry is Vector3Tuple =>
        Array.isArray(entry) && entry.length === 3 && entry.every((v) => typeof v === 'number' && Number.isFinite(v));
    return isTuple(candidate['normal']) && isTuple(candidate['origin']) && typeof candidate['invert'] === 'boolean';
}

/**
 * Derive three.js plane parameters from a clip state. The normal is
 * normalized and negated when inverted; the constant follows
 * `constant = -(normal . origin)` so the plane passes through `origin`.
 */
export function toThreePlaneParams(state: ClipPlaneState): ThreePlaneParams {
    const unit = normalizeClipNormal(state.normal);
    const sign = state.invert ? -1 : 1;
    const normal: Vector3Tuple = [canonicalZero(unit[0] * sign), canonicalZero(unit[1] * sign), canonicalZero(unit[2] * sign)];
    const origin = sanitizePoint(state.origin);
    const constant = -(normal[0] * origin[0] + normal[1] * origin[1] + normal[2] * origin[2]);
    return { normal, constant };
}

/** Signed distance from `point` to the clip plane (negative = clipped away). */
export function clipPlaneDistance(state: ClipPlaneState, point: readonly [number, number, number]): number {
    const params = toThreePlaneParams(state);
    return params.normal[0] * point[0] + params.normal[1] * point[1] + params.normal[2] * point[2] + params.constant;
}

/** Return a copy of `state` with the kept half-space flipped. */
export function invertClipPlane(state: ClipPlaneState): ClipPlaneState {
    return { ...state, invert: !state.invert };
}

/** Return a copy of `state` with a new (normalized) normal. */
export function setClipNormal(state: ClipPlaneState, normal: readonly [number, number, number]): ClipPlaneState {
    return { ...state, normal: normalizeClipNormal(normal) };
}

/** Return a copy of `state` with a new origin. */
export function setClipOrigin(state: ClipPlaneState, origin: readonly [number, number, number]): ClipPlaneState {
    return { ...state, origin: sanitizePoint(origin) };
}

/** Return a copy of `state` with the given fields replaced (normal/origin sanitized). */
export function updateClipPlane(state: ClipPlaneState, patch: Partial<ClipPlaneState>): ClipPlaneState {
    return {
        normal: patch.normal !== undefined ? normalizeClipNormal(patch.normal) : state.normal,
        origin: patch.origin !== undefined ? sanitizePoint(patch.origin) : state.origin,
        invert: patch.invert ?? state.invert
    };
}

/**
 * Compute the bounding box of xyz-packed positions (`[x0, y0, z0, ...]`).
 * Returns undefined for an empty array.
 */
export function boundingBoxFromPositions(positions: ArrayLike<number>): AxisAlignedBounds | undefined {
    const count = Math.floor(positions.length / 3);
    if (count === 0) {
        return undefined;
    }
    let minX = positions[0];
    let minY = positions[1];
    let minZ = positions[2];
    let maxX = minX;
    let maxY = minY;
    let maxZ = minZ;
    for (let i = 1; i < count; i++) {
        const x = positions[i * 3];
        const y = positions[i * 3 + 1];
        const z = positions[i * 3 + 2];
        if (x < minX) {
            minX = x;
        }
        if (y < minY) {
            minY = y;
        }
        if (z < minZ) {
            minZ = z;
        }
        if (x > maxX) {
            maxX = x;
        }
        if (y > maxY) {
            maxY = y;
        }
        if (z > maxZ) {
            maxZ = z;
        }
    }
    return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/** Center point of a bounding box. */
export function boundingBoxCenter(bounds: AxisAlignedBounds): Vector3Tuple {
    return [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2];
}

/** Edge lengths of a bounding box. */
export function boundingBoxSize(bounds: AxisAlignedBounds): Vector3Tuple {
    return [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
}

/** The eight corners of a bounding box. */
export function boundingBoxCorners(bounds: AxisAlignedBounds): Vector3Tuple[] {
    const corners: Vector3Tuple[] = [];
    for (let i = 0; i < 8; i++) {
        corners.push([
            (i & 1) === 0 ? bounds.min[0] : bounds.max[0],
            (i & 2) === 0 ? bounds.min[1] : bounds.max[1],
            (i & 4) === 0 ? bounds.min[2] : bounds.max[2]
        ]);
    }
    return corners;
}

/**
 * Projected interval of a bounding box onto a (normalized) normal: the range
 * of `normal . corner` over the eight corners. Drives origin sliders — an
 * origin swept across `[min, max]` moves the plane through the whole dataset.
 */
export function clipProjectionExtent(bounds: AxisAlignedBounds, normal: readonly [number, number, number]): { min: number; max: number } {
    const unit = normalizeClipNormal(normal);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const corner of boundingBoxCorners(bounds)) {
        const dot = unit[0] * corner[0] + unit[1] * corner[1] + unit[2] * corner[2];
        if (dot < min) {
            min = dot;
        }
        if (dot > max) {
            max = dot;
        }
    }
    return { min, max };
}

/**
 * Origin point at `fraction` (clamped to [0, 1]) of the sweep across `bounds`
 * along `normal`: `origin = normal * lerp(projMin, projMax, fraction)`.
 * Fraction 0/1 place the plane on the dataset faces, 0.5 through the middle.
 */
export function clipOriginAtFraction(normal: readonly [number, number, number], bounds: AxisAlignedBounds, fraction: number): Vector3Tuple {
    const unit = normalizeClipNormal(normal);
    const extent = clipProjectionExtent(bounds, unit);
    const clamped = Math.min(1, Math.max(0, fraction));
    const distance = extent.min + (extent.max - extent.min) * clamped;
    return [canonicalZero(unit[0] * distance), canonicalZero(unit[1] * distance), canonicalZero(unit[2] * distance)];
}

/** Return a copy of `state` with the origin moved to the bounds center (normal kept). */
export function fitClipOriginToBounds(state: ClipPlaneState, bounds: AxisAlignedBounds): ClipPlaneState {
    return { ...state, origin: boundingBoxCenter(bounds) };
}

/** Short status-line description (`n=(…) o=(…) [inverted]`) for toolbar hints. */
export function describeClipPlane(state: ClipPlaneState): string {
    const format = (v: Vector3Tuple): string => `(${v[0].toFixed(2)}, ${v[1].toFixed(2)}, ${v[2].toFixed(2)})`;
    return `n=${format(state.normal)} o=${format(state.origin)}${state.invert ? ' inverted' : ''}`;
}
