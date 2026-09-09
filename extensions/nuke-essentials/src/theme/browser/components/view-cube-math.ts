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
 * Pure projection math for the shared {@link ViewCube} orientation gizmo.
 *
 * The cube adopts the nuke-cad labeled-triad pattern: the six model-space
 * axis directions (±X/±Y/±Z) are rotated by the inverse camera orientation
 * into 2D overlay coordinates, so the overlay mirrors the scene. Projection
 * is rotation-only (orthographic onto the unit disc) — the camera position
 * never matters, only its orientation.
 *
 * Callers bridge a plain quaternion tuple and never pass three.js objects
 * in, so this module is Theia-free and three-free (no imports at all):
 *
 * ```ts
 * cube.update({ quaternion: [camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w] });
 * ```
 *
 * Pure functions + types only; no DOM, no Theia imports. The Y-up / Z-up
 * convention lives with the caller's snap handler (which maps the returned
 * direction triples onto its own orbit controls), never here.
 */

/** A 3D vector as an xyz tuple. */
export type ViewCubeVector = readonly [number, number, number];

/** A camera orientation as an xyzw quaternion tuple. */
export type ViewCubeQuaternion = readonly [number, number, number, number];

/** One end of a model-space axis shown on the cube. */
export type ViewCubeAxisId = 'X' | 'Y' | 'Z' | '-X' | '-Y' | '-Z';

/** A cube axis: its knob id plus its model-space unit direction. */
export interface ViewCubeAxis {
    readonly id: ViewCubeAxisId;
    readonly direction: ViewCubeVector;
}

/** The six cube axes in knob order (positives first). */
export const VIEW_CUBE_AXES: readonly ViewCubeAxis[] = [
    { id: 'X', direction: [1, 0, 0] },
    { id: 'Y', direction: [0, 1, 0] },
    { id: 'Z', direction: [0, 0, 1] },
    { id: '-X', direction: [-1, 0, 0] },
    { id: '-Y', direction: [0, -1, 0] },
    { id: '-Z', direction: [0, 0, -1] }
];

/** Identity orientation (no rotation). */
export const VIEW_CUBE_IDENTITY: { readonly quaternion: ViewCubeQuaternion } = { quaternion: [0, 0, 0, 1] };

/**
 * Cube overlay box edge in CSS px. The overlay is a fixed-size box (never a
 * fraction of the viewarea), mirrored by `.nuke-view-cube` in
 * `view-cube.css` — keep both in sync (covered by
 * `view-cube-math.test.ts`).
 */
export const VIEW_CUBE_BOX = 68;

/** Overlay center in CSS px (half the box edge). */
export const VIEW_CUBE_CENTER = VIEW_CUBE_BOX / 2;

/** Spoke length in CSS px for a unit overlay coordinate. */
export const VIEW_CUBE_RADIUS = 26;

/**
 * Axis-knob hit-box edge in CSS px. Each knob slot is a definite box of this
 * size (never 0x0: a zero-size box lets the Nuke Tooltip span collapse and
 * shrink the knob buttons to slivers), mirrored by
 * `.nuke-view-cube-knob-slot` in `view-cube.css`. The slot intentionally
 * overflows the 68px box at extreme spoke endpoints — it is transparent hit
 * area; the visible knob circle itself (below) fits exactly.
 */
export const VIEW_CUBE_KNOB = 22;

/** Visible knob-circle diameter in CSS px for the +X/+Y/+Z ends. */
export const VIEW_CUBE_KNOB_DIAMETER = 16;

/** Visible knob-circle diameter in CSS px for the −X/−Y/−Z ends. */
export const VIEW_CUBE_KNOB_NEGATIVE_DIAMETER = 13;

/** Camera orientation for a cube update: a plain quaternion tuple. */
export interface ViewCubeOrientation {
    readonly quaternion: ViewCubeQuaternion;
}

/**
 * One projected axis: overlay coordinates plus depth. `x`/`y` live on the
 * unit disc (right/up positive); `depth` is +1 when the axis points
 * straight at the camera (front) and -1 when it points away.
 * `positive` marks the +X/+Y/+Z ends (spokes + filled knobs).
 */
export interface ViewCubeProjection {
    readonly axis: ViewCubeAxisId;
    readonly x: number;
    readonly y: number;
    readonly depth: number;
    readonly positive: boolean;
}

function isFiniteQuaternion(q: ViewCubeQuaternion): boolean {
    return q.every((component) => Number.isFinite(component));
}

/** Rotate `v` by unit quaternion `q` (plain math, no three.js). */
export function rotateVectorByQuaternion(v: ViewCubeVector, q: ViewCubeQuaternion): [number, number, number] {
    const [x, y, z] = v;
    const [qx, qy, qz, qw] = q;
    // v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + w * v).
    const cx = qy * z - qz * y + qw * x;
    const cy = qz * x - qx * z + qw * y;
    const cz = qx * y - qy * x + qw * z;
    return [x + 2 * (qy * cz - qz * cy), y + 2 * (qz * cx - qx * cz), z + 2 * (qx * cy - qy * cx)];
}

/** Normalize `q` to unit length, falling back to identity when degenerate or non-finite. Always unit. */
function normalizeQuaternionOrIdentity(q: ViewCubeQuaternion): ViewCubeQuaternion {
    if (isFiniteQuaternion(q)) {
        const length = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
        if (length > 1e-12) {
            return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
        }
    }
    return [0, 0, 0, 1];
}

/** Conjugate (inverse rotation for a unit quaternion) of `q`. */
function conjugateQuaternion(q: ViewCubeQuaternion): ViewCubeQuaternion {
    return [-q[0], -q[1], -q[2], q[3]];
}

/**
 * Project the six model-space axes through a camera orientation into
 * overlay coordinates. Returns one entry per {@link VIEW_CUBE_AXES} entry,
 * sorted back-to-front (paint order: most negative `depth` first) so the
 * front-most knob always wins overlapping screen regions. The unit-disc
 * invariant `x*x + y*y + depth*depth === 1` holds for every orientation
 * (degenerate quaternions resolve through identity instead of NaNs).
 */
export function projectViewCube(orientation: ViewCubeOrientation): ViewCubeProjection[] {
    const inverse = conjugateQuaternion(normalizeQuaternionOrIdentity(orientation.quaternion));
    const projections = VIEW_CUBE_AXES.map(({ id, direction }) => {
        const rotated = rotateVectorByQuaternion(direction, inverse);
        const x = rotated[0] === 0 ? 0 : rotated[0];
        const y = rotated[1] === 0 ? 0 : rotated[1];
        const depth = rotated[2] === 0 ? 0 : rotated[2];
        return { axis: id, x, y, depth, positive: !id.startsWith('-') };
    });
    projections.sort((a, b) => a.depth - b.depth);
    return projections;
}

/** Knob label for an axis: the family letter (both +X and -X read `X`, the CAD convention). */
export function viewCubeKnobLabel(axis: ViewCubeAxisId): string {
    return axis.replace('-', '');
}

/** Tooltip for an axis knob. */
export function viewCubeSnapLabel(axis: ViewCubeAxisId): string {
    return `Snap to ${axis} view`;
}

/** Axis family key for styling (`x` | `y` | `z`). */
export function viewCubeAxisFamily(axis: ViewCubeAxisId): 'x' | 'y' | 'z' {
    return viewCubeKnobLabel(axis).toLowerCase() as 'x' | 'y' | 'z';
}
