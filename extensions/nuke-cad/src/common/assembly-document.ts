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
 * Assembly document foundation: mate-connector model over part instances.
 *
 * One mate connects exactly one part pair through two mate connectors; the
 * degrees of freedom live in the frame alignment itself (see
 * `assembly-placement.ts`), so positioning a mate is closed-form — there is
 * no constraint solver here.
 *
 * This module is pure TypeScript with no OCP/backend dependency: it owns the
 * document types, the small vector/quaternion/matrix math needed to interpret
 * them, and structural validation. Follow-ups (noted where natural below):
 * drag interaction along free DOFs, gear/screw coupling between mates,
 * flexible sub-assemblies, cross-document part loading, backend composition
 * of placed bodies, and any assembly UI.
 *
 * @module nuke-cad/common
 */

/** Current assembly document schema version. */
export const ASSEMBLY_SCHEMA_VERSION = 1;

/** 3-element cartesian vector. */
export type Vec3 = [number, number, number];

/** Unit quaternion in `[x, y, z, w]` order. */
export type Quaternion = [number, number, number, number];

/** Row-major 4x4 homogeneous matrix, last row `[0, 0, 0, 1]`. */
export type Mat4 = [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number
];

/** Position + orientation placement of an instance in assembly space. */
export interface PosQuatPlacement {
    position: Vec3;
    orientation: Quaternion;
}

/** Raw-matrix placement of an instance in assembly space. */
export interface MatrixPlacement {
    matrix: Mat4;
}

/** Either placement encoding an instance may carry. */
export type InstancePlacement = PosQuatPlacement | MatrixPlacement;

/** A single placed part in the assembly. `part` is a document path or an embedded part id. */
export interface AssemblyInstance {
    id: string;
    /** Path to the part document (e.g. `./bracket.nuke-cad`) or an embedded part id. */
    part: string;
    placement: InstancePlacement;
    /** Uniform (number) or per-axis scale. Defaults to 1 when omitted. */
    scale?: number | Vec3;
}

/**
 * A mate connector: a local frame on one instance. Only `xAxis`/`yAxis` are
 * stored; `z = x cross y`. Axes are orthonormalized on read (see
 * {@link orthonormalizeConnectorAxes}) and rejected when degenerate.
 */
export interface AssemblyConnector {
    id: string;
    instanceId: string;
    origin: Vec3;
    xAxis: Vec3;
    yAxis: Vec3;
}

/** Supported mate types. Each type fixes two connector frames and leaves a known free-DOF set. */
export type MateType = 'fixed' | 'revolute' | 'slider' | 'cylindrical' | 'ball' | 'planar';

/** All mate types in a stable order (validation + UI dropdowns). */
export const MATE_TYPES: MateType[] = ['fixed', 'revolute', 'slider', 'cylindrical', 'ball', 'planar'];

/** A mate between exactly one pair of instances via their connectors. */
export interface AssemblyMate {
    id: string;
    type: MateType;
    instanceA: string;
    connectorA: string;
    instanceB: string;
    connectorB: string;
}

/**
 * Assembly document root.
 *
 * Grounding is explicit: `groundedInstanceId` names the single instance fixed
 * in assembly space. There is no implicit default (the first instance is NOT
 * grounded automatically); a missing or dangling `groundedInstanceId` is a
 * validation error.
 */
export interface AssemblyDocument {
    version: 1;
    name: string;
    instances: AssemblyInstance[];
    connectors: AssemblyConnector[];
    mates: AssemblyMate[];
    groundedInstanceId: string;
}

/** A single structural problem found by {@link validateAssemblyDocument}. */
export interface AssemblyValidationIssue {
    path: string;
    message: string;
}

/** Result of {@link validateAssemblyDocument}. */
export interface AssemblyValidationResult {
    valid: boolean;
    issues: AssemblyValidationIssue[];
}

/** Orthonormal connector axes: stored x/y completed with `z = x cross y`. */
export interface ConnectorFrameAxes {
    xAxis: Vec3;
    yAxis: Vec3;
    zAxis: Vec3;
}

const PARALLEL_TOLERANCE = 1e-9;

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Type guard for {@link Vec3}. */
export function isVec3(value: unknown): value is Vec3 {
    return Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);
}

/** Type guard for {@link Quaternion}. */
export function isQuaternion(value: unknown): value is Quaternion {
    return Array.isArray(value) && value.length === 4 && value.every(isFiniteNumber);
}

/** Type guard for {@link Mat4}. */
export function isMat4(value: unknown): value is Mat4 {
    return Array.isArray(value) && value.length === 16 && value.every(isFiniteNumber);
}

/** True when the placement uses the raw-matrix encoding. */
export function isMatrixPlacement(placement: InstancePlacement): placement is MatrixPlacement {
    return isPlainObject(placement) && 'matrix' in placement;
}

export function dot(a: Vec3, b: Vec3): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function norm(v: Vec3): number {
    return Math.sqrt(dot(v, v));
}

/**
 * Normalize a quaternion to unit length. Throws when the quaternion is
 * zero-length (no meaningful rotation to recover).
 */
export function normalizeQuaternion(q: Quaternion): Quaternion {
    const length = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    if (!(length > PARALLEL_TOLERANCE)) {
        throw new Error('cannot normalize a zero-length quaternion');
    }
    return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

/** Rotation matrix (row-major 3x3) for a unit quaternion. The input is normalized first. */
export function quaternionToMatrix(q: Quaternion): [number, number, number, number, number, number, number, number, number] {
    const [x, y, z, w] = normalizeQuaternion(q);
    const xx = x * x;
    const yy = y * y;
    const zz = z * z;
    const xy = x * y;
    const xz = x * z;
    const yz = y * z;
    const wx = w * x;
    const wy = w * y;
    const wz = w * z;
    return [
        1 - 2 * (yy + zz),
        2 * (xy - wz),
        2 * (xz + wy),
        2 * (xy + wz),
        1 - 2 * (xx + zz),
        2 * (yz - wx),
        2 * (xz - wy),
        2 * (yz + wx),
        1 - 2 * (xx + yy)
    ];
}

/**
 * Unit quaternion for a proper rotation matrix given row by row. Uses the
 * largest-diagonal branch so the result is deterministic for every input.
 * Throws when the matrix is not a rotation (determinant far from +1).
 */
export function rotationMatrixToQuaternion(
    r00: number,
    r01: number,
    r02: number,
    r10: number,
    r11: number,
    r12: number,
    r20: number,
    r21: number,
    r22: number
): Quaternion {
    const trace = r00 + r11 + r22;
    let x: number;
    let y: number;
    let z: number;
    let w: number;
    if (trace > 0) {
        const s = Math.sqrt(trace + 1) * 2;
        w = 0.25 * s;
        x = (r21 - r12) / s;
        y = (r02 - r20) / s;
        z = (r10 - r01) / s;
    } else if (r00 > r11 && r00 > r22) {
        const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
        w = (r21 - r12) / s;
        x = 0.25 * s;
        y = (r01 + r10) / s;
        z = (r02 + r20) / s;
    } else if (r11 > r22) {
        const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
        w = (r02 - r20) / s;
        x = (r01 + r10) / s;
        y = 0.25 * s;
        z = (r12 + r21) / s;
    } else {
        const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
        w = (r10 - r01) / s;
        x = (r02 + r20) / s;
        y = (r12 + r21) / s;
        z = 0.25 * s;
    }
    const q: Quaternion = [x, y, z, w];
    const det = r00 * (r11 * r22 - r12 * r21) - r01 * (r10 * r22 - r12 * r20) + r02 * (r10 * r21 - r11 * r20);
    if (Math.abs(det - 1) > 1e-6) {
        throw new Error(`matrix is not a rotation (determinant ${det})`);
    }
    return normalizeQuaternion(q);
}

/** Homogeneous row-major matrix for a position + quaternion placement. */
export function placementToMatrix(position: Vec3, orientation: Quaternion): Mat4 {
    const [r00, r01, r02, r10, r11, r12, r20, r21, r22] = quaternionToMatrix(orientation);
    return [r00, r01, r02, position[0], r10, r11, r12, position[1], r20, r21, r22, position[2], 0, 0, 0, 1];
}

/** Homogeneous row-major matrix for an instance placement (either encoding). */
export function instancePlacementToMatrix(placement: InstancePlacement): Mat4 {
    if (isMatrixPlacement(placement)) {
        return [...placement.matrix] as Mat4;
    }
    return placementToMatrix(placement.position, placement.orientation);
}

/**
 * Orthonormalize connector axes with Gram-Schmidt: normalize x, orthogonalize
 * y against x, then `z = x cross y`.
 *
 * Throws when the axes are degenerate (zero-length x, zero-length y, or x
 * parallel to y) — the "or-error" half of orthonormalized-or-error. Small
 * deviations from orthogonality are corrected; only degeneracy fails.
 */
export function orthonormalizeConnectorAxes(axes: { xAxis: Vec3; yAxis: Vec3 }): ConnectorFrameAxes {
    const xLength = norm(axes.xAxis);
    if (!(xLength > PARALLEL_TOLERANCE)) {
        throw new Error('connector xAxis has zero length');
    }
    const xAxis: Vec3 = [axes.xAxis[0] / xLength, axes.xAxis[1] / xLength, axes.xAxis[2] / xLength];
    const projection = dot(axes.yAxis, xAxis);
    const orthogonalized: Vec3 = [
        axes.yAxis[0] - projection * xAxis[0],
        axes.yAxis[1] - projection * xAxis[1],
        axes.yAxis[2] - projection * xAxis[2]
    ];
    const yLength = norm(orthogonalized);
    if (!(yLength > PARALLEL_TOLERANCE)) {
        throw new Error('connector yAxis has zero length or is parallel to xAxis');
    }
    const yAxis: Vec3 = [orthogonalized[0] / yLength, orthogonalized[1] / yLength, orthogonalized[2] / yLength];
    return { xAxis, yAxis, zAxis: cross(xAxis, yAxis) };
}

/** Minimal factory for an empty assembly; callers add instances/connectors/mates immutably. */
export function createAssemblyDocument(name: string, groundedInstanceId: string): AssemblyDocument {
    return { version: ASSEMBLY_SCHEMA_VERSION, name, instances: [], connectors: [], mates: [], groundedInstanceId };
}

interface ValidationContext {
    issues: AssemblyValidationIssue[];
}

function issue(ctx: ValidationContext, path: string, message: string): void {
    ctx.issues.push({ path, message });
}

function checkIdList(ctx: ValidationContext, path: string, ids: string[]): void {
    const seen = new Set<string>();
    for (const [index, id] of ids.entries()) {
        if (!isNonEmptyString(id)) {
            issue(ctx, `${path}[${index}].id`, 'id must be a non-empty string');
        } else if (seen.has(id)) {
            issue(ctx, `${path}[${index}].id`, `duplicate id '${id}'`);
        } else {
            seen.add(id);
        }
    }
}

/**
 * Validate an assembly document structurally.
 *
 * Checks: schema version, instance/connector/mate id uniqueness, exactly-one
 * explicit grounding (`groundedInstanceId` present and referencing a known
 * instance), dangling references (connectors to instances, mates to
 * instances/connectors, connector-instance ownership), connector-axis
 * degeneracy, placement/scale well-formedness, and the one-mate-per-part-pair
 * rule. Reports every problem; `valid` is true only when no issues remain.
 */
export function validateAssemblyDocument(doc: AssemblyDocument): AssemblyValidationResult {
    const ctx: ValidationContext = { issues: [] };
    if (!isPlainObject(doc)) {
        return { valid: false, issues: [{ path: '', message: 'document must be an object' }] };
    }
    if (doc.version !== ASSEMBLY_SCHEMA_VERSION) {
        issue(ctx, 'version', `expected version ${ASSEMBLY_SCHEMA_VERSION}, got ${String(doc.version)}`);
    }
    if (!isNonEmptyString(doc.name)) {
        issue(ctx, 'name', 'name must be a non-empty string');
    }
    if (!Array.isArray(doc.instances)) {
        issue(ctx, 'instances', 'instances must be an array');
        return { valid: false, issues: ctx.issues };
    }
    if (!Array.isArray(doc.connectors)) {
        issue(ctx, 'connectors', 'connectors must be an array');
    }
    if (!Array.isArray(doc.mates)) {
        issue(ctx, 'mates', 'mates must be an array');
    }

    const instances = Array.isArray(doc.instances) ? doc.instances : [];
    const connectors = Array.isArray(doc.connectors) ? doc.connectors : [];
    const mates = Array.isArray(doc.mates) ? doc.mates : [];

    checkIdList(
        ctx,
        'instances',
        instances.map((instance) => (isPlainObject(instance) ? (instance.id as string) : ('' as unknown as string)))
    );
    if (Array.isArray(doc.connectors)) {
        checkIdList(
            ctx,
            'connectors',
            connectors.map((connector) => (isPlainObject(connector) ? (connector.id as string) : ('' as unknown as string)))
        );
    }
    if (Array.isArray(doc.mates)) {
        checkIdList(
            ctx,
            'mates',
            mates.map((mate) => (isPlainObject(mate) ? (mate.id as string) : ('' as unknown as string)))
        );
    }

    const instanceIds = new Set<string>();
    for (const [index, instance] of instances.entries()) {
        if (!isPlainObject(instance)) {
            issue(ctx, `instances[${index}]`, 'instance must be an object');
            continue;
        }
        if (isNonEmptyString(instance.id)) {
            instanceIds.add(instance.id);
        }
        if (!isNonEmptyString(instance.part)) {
            issue(ctx, `instances[${index}].part`, 'part must be a non-empty path or embedded part id');
        }
        validatePlacement(ctx, `instances[${index}].placement`, instance.placement);
        if (instance.scale !== undefined) {
            validateScale(ctx, `instances[${index}].scale`, instance.scale);
        }
    }

    // Exactly-one-grounded rule: grounding is explicit, never defaulted to
    // the first instance. (A future UI may offer "ground here" actions, but
    // the document itself always names its ground.)
    if (!isNonEmptyString(doc.groundedInstanceId)) {
        issue(ctx, 'groundedInstanceId', 'groundedInstanceId must name the single grounded instance (no implicit default)');
    } else if (!instanceIds.has(doc.groundedInstanceId)) {
        issue(ctx, 'groundedInstanceId', `grounded instance '${doc.groundedInstanceId}' does not exist`);
    }

    const connectorById = new Map<string, AssemblyConnector>();
    for (const [index, connector] of connectors.entries()) {
        if (!isPlainObject(connector)) {
            issue(ctx, `connectors[${index}]`, 'connector must be an object');
            continue;
        }
        if (isNonEmptyString(connector.id)) {
            connectorById.set(connector.id, connector as unknown as AssemblyConnector);
        }
        if (!isNonEmptyString(connector.instanceId)) {
            issue(ctx, `connectors[${index}].instanceId`, 'instanceId must be a non-empty string');
        } else if (!instanceIds.has(connector.instanceId)) {
            issue(ctx, `connectors[${index}].instanceId`, `instance '${connector.instanceId}' does not exist`);
        }
        if (!isVec3(connector.origin)) {
            issue(ctx, `connectors[${index}].origin`, 'origin must be a [x, y, z] array of finite numbers');
        }
        if (!isVec3(connector.xAxis) || !isVec3(connector.yAxis)) {
            issue(ctx, `connectors[${index}].axes`, 'xAxis and yAxis must be [x, y, z] arrays of finite numbers');
        } else {
            try {
                orthonormalizeConnectorAxes({ xAxis: connector.xAxis, yAxis: connector.yAxis });
            } catch (error) {
                issue(ctx, `connectors[${index}].axes`, error instanceof Error ? error.message : 'degenerate connector axes');
            }
        }
    }

    const pairToMateId = new Map<string, string>();
    for (const [index, mate] of mates.entries()) {
        if (!isPlainObject(mate)) {
            issue(ctx, `mates[${index}]`, 'mate must be an object');
            continue;
        }
        if (!MATE_TYPES.includes(mate.type as MateType)) {
            issue(ctx, `mates[${index}].type`, `type must be one of ${MATE_TYPES.join(', ')}`);
        }
        let pairKey: string | undefined;
        for (const side of ['A', 'B'] as const) {
            const instanceRef = mate[`instance${side}`];
            const connectorRef = mate[`connector${side}`];
            if (!isNonEmptyString(instanceRef)) {
                issue(ctx, `mates[${index}].instance${side}`, 'instance must be a non-empty string');
            } else if (!instanceIds.has(instanceRef)) {
                issue(ctx, `mates[${index}].instance${side}`, `instance '${instanceRef}' does not exist`);
            }
            if (!isNonEmptyString(connectorRef)) {
                issue(ctx, `mates[${index}].connector${side}`, 'connector must be a non-empty string');
            } else {
                const target = connectorById.get(connectorRef);
                if (!target) {
                    issue(ctx, `mates[${index}].connector${side}`, `connector '${connectorRef}' does not exist`);
                } else if (isNonEmptyString(instanceRef) && target.instanceId !== instanceRef) {
                    issue(
                        ctx,
                        `mates[${index}].connector${side}`,
                        `connector '${connectorRef}' belongs to '${target.instanceId}', not '${instanceRef}'`
                    );
                }
            }
        }
        if (isNonEmptyString(mate.instanceA) && mate.instanceA === mate.instanceB) {
            issue(ctx, `mates[${index}]`, 'mate cannot connect an instance to itself');
        }
        if (isNonEmptyString(mate.instanceA) && isNonEmptyString(mate.instanceB)) {
            pairKey = JSON.stringify([mate.instanceA, mate.instanceB].sort());
            const first = pairToMateId.get(pairKey);
            if (first !== undefined) {
                issue(
                    ctx,
                    `mates[${index}]`,
                    `mate pair '${mate.instanceA}'/'${mate.instanceB}' already joined by '${first}' (one mate per part pair)`
                );
            } else if (isNonEmptyString(mate.id)) {
                pairToMateId.set(pairKey, mate.id);
            }
        }
    }

    return { valid: ctx.issues.length === 0, issues: ctx.issues };
}

function validatePlacement(ctx: ValidationContext, path: string, placement: unknown): void {
    if (!isPlainObject(placement)) {
        issue(ctx, path, 'placement must be an object with position+orientation or matrix');
        return;
    }
    if ('matrix' in placement) {
        if (!isMat4(placement.matrix)) {
            issue(ctx, `${path}.matrix`, 'matrix must be a 16-element array of finite numbers');
            return;
        }
        const [m30, m31, m32, m33] = [placement.matrix[12], placement.matrix[13], placement.matrix[14], placement.matrix[15]];
        if (Math.abs(m30) > 1e-6 || Math.abs(m31) > 1e-6 || Math.abs(m32) > 1e-6 || Math.abs(m33 - 1) > 1e-6) {
            issue(ctx, `${path}.matrix`, 'matrix last row must be [0, 0, 0, 1]');
        }
        return;
    }
    if (!isVec3(placement.position)) {
        issue(ctx, `${path}.position`, 'position must be a [x, y, z] array of finite numbers');
    }
    if (!isQuaternion(placement.orientation)) {
        issue(ctx, `${path}.orientation`, 'orientation must be an [x, y, z, w] array of finite numbers');
    } else {
        const [x, y, z, w] = placement.orientation;
        if (!(Math.sqrt(x * x + y * y + z * z + w * w) > PARALLEL_TOLERANCE)) {
            issue(ctx, `${path}.orientation`, 'orientation must have non-zero length');
        }
    }
}

function validateScale(ctx: ValidationContext, path: string, scale: unknown): void {
    if (isFiniteNumber(scale)) {
        if (!(scale > 0)) {
            issue(ctx, path, 'scale must be positive');
        }
        return;
    }
    if (isVec3(scale)) {
        if (!(scale[0] > 0 && scale[1] > 0 && scale[2] > 0)) {
            issue(ctx, path, 'scale components must be positive');
        }
        return;
    }
    issue(ctx, path, 'scale must be a positive number or a [sx, sy, sz] array of positives');
}
