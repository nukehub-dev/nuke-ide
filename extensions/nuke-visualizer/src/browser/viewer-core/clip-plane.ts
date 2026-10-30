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
 * Per-axis clip-plane state for the native 3D viewer core.
 *
 * Each world axis (X/Y/Z) owns an independent clip plane: an enable flag, a
 * 0..1 position fraction across the dataset bounds along that axis, and a
 * side flip. Enabled planes apply TOGETHER (a box-section view), matching
 * the combined-clip semantics ParaView exposes across its
 * `vtkPVClipDataSet` planes.
 *
 * Pure functions + types only; no trame, no vuetify, no DOM, no three.js
 * import. {@link toThreePlaneParamsArray} returns `{ normal, constant }`
 * tuples that map 1:1 onto `THREE.Plane`:
 *
 * ```ts
 * const planes = toThreePlaneParamsArray(state, bounds).map(
 *     (params) => new THREE.Plane(new THREE.Vector3(...params.normal), params.constant)
 * );
 * renderer.localClippingEnabled = true;
 * material.clippingPlanes = planes;
 * ```
 *
 * three.js discards fragments with a negative signed distance
 * (`normal.dot(point) + constant < 0`), so with `invert: false` the kept
 * half-space is `{ p : p[axis] >= origin }` — the low side is removed.
 * `invert: true` keeps the opposite side.
 */

/** A 3D vector as an xyz tuple. */
export type Vector3Tuple = [number, number, number];

/** Clip axis selecting one of the three world-axis planes. */
export type ClipAxis = 'X' | 'Y' | 'Z';

/** The three clip axes in tab order. */
export const CLIP_AXES: readonly ClipAxis[] = ['X', 'Y', 'Z'];

/**
 * Clip state for one axis: whether its plane is active, where the plane
 * sits as a fraction across the dataset bounds along that axis (0 = min
 * face, 1 = max face, 0.5 = middle), and which half-space is kept.
 */
export interface AxisClipState {
    readonly enabled: boolean;
    readonly fraction: number;
    readonly invert: boolean;
}

/**
 * Per-axis clip state: each axis remembers its own enable flag, position,
 * and flip, so header X/Y/Z tabs never lose their settings.
 */
export interface ClipPlanesState {
    readonly X: AxisClipState;
    readonly Y: AxisClipState;
    readonly Z: AxisClipState;
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

/** Default per-axis state: plane through the middle, disabled, nothing inverted. */
export const DEFAULT_AXIS_CLIP_STATE: AxisClipState = {
    enabled: false,
    fraction: 0.5,
    invert: false
};

/** Default clip state: every axis through its middle, all planes disabled. */
export const DEFAULT_CLIP_PLANES_STATE: ClipPlanesState = {
    X: { ...DEFAULT_AXIS_CLIP_STATE },
    Y: { ...DEFAULT_AXIS_CLIP_STATE },
    Z: { ...DEFAULT_AXIS_CLIP_STATE }
};

/** Clamp a fraction to the [0, 1] slider range; non-finite input maps to 0.5. */
export function clampClipFraction(value: number): number {
    if (!Number.isFinite(value)) {
        return 0.5;
    }
    return Math.min(1, Math.max(0, value));
}

/** Sanitize one axis entry (finite fraction, boolean flags). */
function sanitizeAxisClip(value: Partial<AxisClipState>): AxisClipState {
    return {
        enabled: value.enabled ?? DEFAULT_AXIS_CLIP_STATE.enabled,
        fraction: value.fraction !== undefined ? clampClipFraction(value.fraction) : DEFAULT_AXIS_CLIP_STATE.fraction,
        invert: value.invert ?? DEFAULT_AXIS_CLIP_STATE.invert
    };
}

/** Create a per-axis clip state from a partial patch over the defaults. */
export function createClipPlanesState(patch: Partial<Record<ClipAxis, Partial<AxisClipState>>> = {}): ClipPlanesState {
    return {
        X: sanitizeAxisClip(patch.X ?? {}),
        Y: sanitizeAxisClip(patch.Y ?? {}),
        Z: sanitizeAxisClip(patch.Z ?? {})
    };
}

/** Runtime guard for one axis entry (boolean enabled/invert, finite fraction). */
export function isAxisClipState(value: unknown): value is AxisClipState {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate['enabled'] === 'boolean' &&
        typeof candidate['fraction'] === 'number' &&
        Number.isFinite(candidate['fraction']) &&
        typeof candidate['invert'] === 'boolean'
    );
}

/** Runtime guard for per-axis clip states. */
export function isClipPlanesState(value: unknown): value is ClipPlanesState {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value as Record<string, unknown>;
    return isAxisClipState(candidate['X']) && isAxisClipState(candidate['Y']) && isAxisClipState(candidate['Z']);
}

/** Index of an axis in xyz tuples. */
function clipAxisIndex(axis: ClipAxis): number {
    return axis === 'X' ? 0 : axis === 'Y' ? 1 : 2;
}

/** Unit normal for an axis plane (+X/+Y/+Z). */
export function axisClipNormal(axis: ClipAxis): Vector3Tuple {
    const index = clipAxisIndex(axis);
    return [index === 0 ? 1 : 0, index === 1 ? 1 : 0, index === 2 ? 1 : 0];
}

/** Whether any axis plane is active. */
export function anyClipEnabled(state: ClipPlanesState): boolean {
    return state.X.enabled || state.Y.enabled || state.Z.enabled;
}

/** Return a copy of `state` with one axis entry patched (fraction clamped). */
export function updateAxisClip(state: ClipPlanesState, axis: ClipAxis, patch: Partial<AxisClipState>): ClipPlanesState {
    return { ...state, [axis]: sanitizeAxisClip({ ...state[axis], ...patch }) };
}

/** Return a copy of `state` with every axis enabled or disabled (positions kept). */
export function setAllClipEnabled(state: ClipPlanesState, enabled: boolean): ClipPlanesState {
    return {
        X: { ...state.X, enabled },
        Y: { ...state.Y, enabled },
        Z: { ...state.Z, enabled }
    };
}

/**
 * Derive three.js plane parameters for every ENABLED axis plane. Each
 * plane sits at `min[axis] + fraction * size[axis]`; the normal is the
 * axis unit vector, negated when the entry is inverted, and
 * `constant = -(normal . origin)` so the plane passes through the origin
 * point. Disabled axes contribute no plane (empty array = no clipping).
 */
export function toThreePlaneParamsArray(state: ClipPlanesState, bounds: AxisAlignedBounds): ThreePlaneParams[] {
    const params: ThreePlaneParams[] = [];
    for (const axis of CLIP_AXES) {
        const entry = state[axis];
        if (!entry.enabled) {
            continue;
        }
        const index = clipAxisIndex(axis);
        const distance = bounds.min[index] + clampClipFraction(entry.fraction) * (bounds.max[index] - bounds.min[index]);
        const sign = entry.invert ? -1 : 1;
        const normal: Vector3Tuple = [0, 0, 0];
        normal[index] = sign;
        // Normalize negative zero (vitest `toEqual` distinguishes -0 from 0).
        const constant = -sign * distance === 0 ? 0 : -sign * distance;
        params.push({ normal, constant });
    }
    return params;
}

/** Short status-line description (`X: 50% [inverted]`, `off` when disabled). */
export function describeClipPlanes(state: ClipPlanesState): string {
    const parts: string[] = [];
    for (const axis of CLIP_AXES) {
        const entry = state[axis];
        if (entry.enabled) {
            parts.push(`${axis}: ${Math.round(clampClipFraction(entry.fraction) * 100)}%${entry.invert ? ' inverted' : ''}`);
        }
    }
    return parts.length > 0 ? parts.join(' + ') : 'off';
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
