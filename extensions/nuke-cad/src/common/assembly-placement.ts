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
 * Closed-form mate placement: rigid transforms that coincide two connector
 * frames, plus the free-DOF descriptor each mate type leaves behind.
 *
 * There is no solver here by design. A mate glues frame B onto frame A
 * (`R = Ra * Rb^T`, `t = pa - R * pb`); whatever the mate type does NOT
 * constrain stays free for downstream consumers. Follow-ups (out of scope
 * for this foundation): interactive dragging along the free DOFs, gear/screw
 * coupling between mates, flexible sub-assemblies whose internal DOFs never
 * close, backend composition of the placed bodies, and any UI.
 *
 * All functions are pure and deterministic: same inputs, same outputs, no
 * hidden state. Frames are raw connector axes in some shared space (usually
 * assembly space after applying each instance placement).
 *
 * @module nuke-cad/common
 */

import type { Mat4, MateType, Quaternion, Vec3 } from './assembly-document';
import { normalizeQuaternion, orthonormalizeConnectorAxes, rotationMatrixToQuaternion } from './assembly-document';

/** A connector frame in a shared coordinate space: origin + orthonormal axes. */
export interface ConnectorFrame {
    origin: Vec3;
    xAxis: Vec3;
    yAxis: Vec3;
    zAxis: Vec3;
}

/** A rigid transform: position + unit quaternion + the equivalent matrix. */
export interface RigidTransform {
    position: Vec3;
    orientation: Quaternion;
    matrix: Mat4;
}

/** One unconstrained degree of freedom, expressed in the mated frame. */
export interface FreeDof {
    kind: 'rotation' | 'translation';
    /** Frame axis the DOF acts about/along. */
    axis: 'x' | 'y' | 'z';
}

/** Result of {@link resolveMatePlacement}: where B goes plus what stays free. */
export interface MatePlacementSolution {
    /** Rigid transform placing instance B so its connector frame coincides with A's. */
    transform: RigidTransform;
    /** Free DOFs left by the mate type (empty for `fixed`). */
    freeDofs: FreeDof[];
}

/**
 * Build a shared-space connector frame from a stored definition, completing
 * `z = x cross y` and orthonormalizing (throws on degenerate axes).
 */
export function connectorFrameFromDefinition(definition: { origin: Vec3; xAxis: Vec3; yAxis: Vec3 }): ConnectorFrame {
    const { xAxis, yAxis, zAxis } = orthonormalizeConnectorAxes({ xAxis: definition.xAxis, yAxis: definition.yAxis });
    return { origin: [definition.origin[0], definition.origin[1], definition.origin[2]], xAxis, yAxis, zAxis };
}

/**
 * Free DOFs left by each mate type, expressed in the coincided connector
 * frame (z = connector normal):
 *
 * - fixed: none
 * - revolute: rotation about z
 * - slider: translation along z
 * - cylindrical: rotation about z + translation along z
 * - ball: rotations about x, y, z
 * - planar: translations along x, y + rotation about z
 */
export function freeDofsForMateType(type: MateType): FreeDof[] {
    switch (type) {
        case 'fixed':
            return [];
        case 'revolute':
            return [{ kind: 'rotation', axis: 'z' }];
        case 'slider':
            return [{ kind: 'translation', axis: 'z' }];
        case 'cylindrical':
            return [
                { kind: 'rotation', axis: 'z' },
                { kind: 'translation', axis: 'z' }
            ];
        case 'ball':
            return [
                { kind: 'rotation', axis: 'x' },
                { kind: 'rotation', axis: 'y' },
                { kind: 'rotation', axis: 'z' }
            ];
        case 'planar':
            return [
                { kind: 'translation', axis: 'x' },
                { kind: 'translation', axis: 'y' },
                { kind: 'rotation', axis: 'z' }
            ];
    }
}

/** Number of constraints a mate type imposes (6 minus its free-DOF count). */
export function constrainedDofsForMateType(type: MateType): number {
    return 6 - freeDofsForMateType(type).length;
}

/**
 * Remaining rigid-body DOFs of an assembly: `6 * (n - 1) - constrained`,
 * where one instance is grounded (see `groundedInstanceId`) and each mate
 * removes its constrained DOFs.
 *
 * The result may be zero (fully defined) or negative (over-constrained:
 * more mates than needed, e.g. two `fixed` mates between the same pair —
 * which validation already rejects). Flexible sub-assemblies would need a
 * per-body count instead; out of scope for this foundation.
 */
export function countAssemblyDof(instanceCount: number, mateTypes: readonly MateType[]): number {
    const constrained = mateTypes.reduce((total, type) => total + constrainedDofsForMateType(type), 0);
    return 6 * (instanceCount - 1) - constrained;
}

function transposeTimes(frameA: ConnectorFrame, frameB: ConnectorFrame): [Vec3, Vec3, Vec3] {
    // R = Ra * Rb^T with rotations stored as axis columns: R[i][j] is the sum
    // over k of a_k[i] * b_k[j] (not a column-dot-column product).
    const a = [frameA.xAxis, frameA.yAxis, frameA.zAxis];
    const b = [frameB.xAxis, frameB.yAxis, frameB.zAxis];
    const rows: Vec3[] = [];
    for (let i = 0; i < 3; i++) {
        const row: Vec3 = [0, 1, 2].map((j) => a[0][i] * b[0][j] + a[1][i] * b[1][j] + a[2][i] * b[2][j]) as Vec3;
        rows.push(row);
    }
    return rows as [Vec3, Vec3, Vec3];
}

function dot3(a: Vec3, b: Vec3): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function applyRotation(rows: [Vec3, Vec3, Vec3], point: Vec3): Vec3 {
    return [dot3(rows[0], point), dot3(rows[1], point), dot3(rows[2], point)];
}

/**
 * Resolve the rigid transform placing instance B so that `frameB` coincides
 * with `frameA` (closed-form: `R = Ra * Rb^T`, `t = pa - R * pb`), plus the
 * free-DOF descriptor for `mateType`.
 *
 * The transform is the fully-coincided pose; a `revolute` mate, for example,
 * may afterwards spin about the frame z without violating the mate —
 * applying that spin is the caller's (or a future drag interaction's) job.
 */
export function resolveMatePlacement(mateType: MateType, frameA: ConnectorFrame, frameB: ConnectorFrame): MatePlacementSolution {
    const rows = transposeTimes(frameA, frameB);
    const rotatedOrigin = applyRotation(rows, frameB.origin);
    const position: Vec3 = [frameA.origin[0] - rotatedOrigin[0], frameA.origin[1] - rotatedOrigin[1], frameA.origin[2] - rotatedOrigin[2]];
    const orientation = rotationMatrixToQuaternion(
        rows[0][0],
        rows[0][1],
        rows[0][2],
        rows[1][0],
        rows[1][1],
        rows[1][2],
        rows[2][0],
        rows[2][1],
        rows[2][2]
    );
    const matrix: Mat4 = [
        rows[0][0],
        rows[0][1],
        rows[0][2],
        position[0],
        rows[1][0],
        rows[1][1],
        rows[1][2],
        position[1],
        rows[2][0],
        rows[2][1],
        rows[2][2],
        position[2],
        0,
        0,
        0,
        1
    ];
    return { transform: { position, orientation: normalizeQuaternion(orientation), matrix }, freeDofs: freeDofsForMateType(mateType) };
}

/** Apply a rigid transform to a point (rotation from the matrix, then translation). */
export function applyRigidTransformToPoint(transform: RigidTransform, point: Vec3): Vec3 {
    const m = transform.matrix;
    return [
        m[0] * point[0] + m[1] * point[1] + m[2] * point[2] + m[3],
        m[4] * point[0] + m[5] * point[1] + m[6] * point[2] + m[7],
        m[8] * point[0] + m[9] * point[1] + m[10] * point[2] + m[11]
    ];
}
