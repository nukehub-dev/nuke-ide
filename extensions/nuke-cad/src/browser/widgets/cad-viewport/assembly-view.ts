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
 * Pure assembly helpers for the CAD viewport.
 *
 * Instance rendering reuses the `tess-reuse.ts` face pool: BufferGeometry is
 * shared per source face, never cloned per instance. Reuse key:
 * `<sourcePath>#<bodyId>::<faceFingerprint>` (backend geometric fingerprint
 * with the coordinate-signature fallback, never `hash`/positional ids). Each
 * instance gets a `THREE.Group` carrying the solved Mat4; mesh `userData` is
 * `{ instanceId, solidId, faceId }`, re-derived per build because positional
 * ids shuffle.
 *
 * Placement solving mirrors the backend contract: BFS from the
 * grounded instance (which keeps its stored placement) through
 * `resolveMatePlacement`; unmated non-grounded instances keep their stored
 * placement. `countAssemblyDof(...) < 0` is a warning (first-mate-wins), never
 * fatal.
 *
 * Kept free of three.js/Theia imports so vitest can exercise it directly.
 *
 * @module nuke-cad/browser/widgets
 */

import {
    instancePlacementToMatrix,
    type AssemblyConnector,
    type AssemblyInstance,
    type AssemblyMate,
    type Mat4,
    type MateType,
    type Vec3
} from '../../../common/assembly-document';
import {
    connectorFrameFromDefinition,
    constrainedDofsForMateType,
    countAssemblyDof,
    freeDofsForMateType,
    resolveMatePlacement,
    type ConnectorFrame
} from '../../../common/assembly-placement';
import { faceReuseKey, type ParsedTessFace } from './tess-reuse';
import type { AssemblySection } from '../../document/cad-document-store';

/** Face payload subset carrying optional assembly per-instance attribution. */
export type AssemblyFaceInput = Pick<ParsedTessFace, 'fingerprint' | 'nodeCount' | 'triangleCount' | 'positions'> & {
    readonly bodyId?: string;
    readonly instanceId?: string;
};

/**
 * Shared BufferGeometry reuse key for one source face.
 *
 * `<sourcePath>#<bodyId>::<faceFingerprint>` where the fingerprint is the
 * backend geometric fingerprint (coordinate-signature fallback) — never the
 * process-salted `hash` field or positional `solidId`/`faceId`.
 */
export function assemblyReuseKey(sourcePart: string, bodyId: string | undefined, face: AssemblyFaceInput): string {
    return `${sourcePart}#${bodyId ?? ''}::${faceReuseKey(face)}`;
}

/** Identity 4x4 (row-major). */
export function identityMat4(): Mat4 {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Row-major 4x4 product `out = a * b` (apply `b` first, then `a`). */
export function multiplyMat4(a: Mat4, b: Mat4): Mat4 {
    const out = new Array<number>(16).fill(0);
    for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) {
                sum += a[row * 4 + k] * b[k * 4 + col];
            }
            out[row * 4 + col] = sum;
        }
    }
    return out as unknown as Mat4;
}

/** Apply a row-major Mat4 to a point (rotation + translation). */
export function applyMat4ToPoint(matrix: Mat4, point: Vec3): Vec3 {
    return [
        matrix[0] * point[0] + matrix[1] * point[1] + matrix[2] * point[2] + matrix[3],
        matrix[4] * point[0] + matrix[5] * point[1] + matrix[6] * point[2] + matrix[7],
        matrix[8] * point[0] + matrix[9] * point[1] + matrix[10] * point[2] + matrix[11]
    ];
}

/** Apply the rotation part of a row-major Mat4 to a direction vector. */
export function applyMat4ToVector(matrix: Mat4, vector: Vec3): Vec3 {
    return [
        matrix[0] * vector[0] + matrix[1] * vector[1] + matrix[2] * vector[2],
        matrix[4] * vector[0] + matrix[5] * vector[1] + matrix[6] * vector[2],
        matrix[8] * vector[0] + matrix[9] * vector[1] + matrix[10] * vector[2]
    ];
}

/** Lift a stored connector definition into assembly space through an instance placement. */
export function connectorFrameInAssembly(connector: AssemblyConnector, instanceMatrix: Mat4): ConnectorFrame {
    return connectorFrameFromDefinition({
        origin: applyMat4ToPoint(instanceMatrix, connector.origin),
        xAxis: applyMat4ToVector(instanceMatrix, connector.xAxis),
        yAxis: applyMat4ToVector(instanceMatrix, connector.yAxis)
    });
}

/**
 * Solve final instance placements closed-form: BFS from the grounded instance
 * (keeps its stored placement) through `resolveMatePlacement`. For a mate
 * A(solved) → B(unsolved), A's connector frame is lifted to assembly space
 * while B's stays instance-local, so the closed form yields B's assembly
 * placement directly. Unmated non-grounded instances keep their stored
 * placement; over-constrained assemblies resolve first-mate-wins.
 */
export function solveAssemblyTransforms(assembly: AssemblySection): Map<string, Mat4> {
    const byId = new Map<string, AssemblyInstance>(assembly.instances.map((i) => [i.id, i]));
    const connectorsById = new Map<string, AssemblyConnector>(assembly.connectors.map((c) => [c.id, c]));
    const solved = new Map<string, Mat4>();
    const grounded = byId.get(assembly.groundedInstanceId);
    if (grounded !== undefined) {
        solved.set(grounded.id, instancePlacementToMatrix(grounded.placement));
    }
    // Unmated instances (and every instance when nothing is grounded) keep
    // their stored placement; mates only overwrite through the BFS below.
    for (const instance of assembly.instances) {
        if (!solved.has(instance.id)) {
            solved.set(instance.id, instancePlacementToMatrix(instance.placement));
        }
    }
    if (grounded === undefined) {
        return solved;
    }
    const proven = new Set<string>([grounded.id]);
    let progressed = true;
    while (progressed) {
        progressed = false;
        for (const mate of assembly.mates) {
            const target = solveMateStep(mate, byId, connectorsById, solved, proven);
            if (target !== undefined) {
                solved.set(target.instanceId, target.matrix);
                proven.add(target.instanceId);
                progressed = true;
            }
        }
    }
    return solved;
}

function solveMateStep(
    mate: AssemblyMate,
    byId: Map<string, AssemblyInstance>,
    connectorsById: Map<string, AssemblyConnector>,
    solved: Map<string, Mat4>,
    proven: Set<string>
): { instanceId: string; matrix: Mat4 } | undefined {
    const aProven = proven.has(mate.instanceA);
    const bProven = proven.has(mate.instanceB);
    if (aProven === bProven) {
        return undefined;
    }
    const solvedSide = aProven ? 'A' : 'B';
    const openSide = aProven ? 'B' : 'A';
    const solvedInstanceId = solvedSide === 'A' ? mate.instanceA : mate.instanceB;
    const openInstanceId = openSide === 'A' ? mate.instanceA : mate.instanceB;
    const solvedConnector = connectorsById.get(solvedSide === 'A' ? mate.connectorA : mate.connectorB);
    const openConnector = connectorsById.get(openSide === 'A' ? mate.connectorA : mate.connectorB);
    if (solvedConnector === undefined || openConnector === undefined) {
        return undefined;
    }
    if (!byId.has(openInstanceId)) {
        return undefined;
    }
    const solvedMatrix = solved.get(solvedInstanceId);
    if (solvedMatrix === undefined) {
        return undefined;
    }
    const frameSolved = connectorFrameInAssembly(solvedConnector, solvedMatrix);
    const frameOpen = connectorFrameFromDefinition(openConnector);
    // resolveMatePlacement returns the second frame's instance placement in
    // the shared space: the solved frame is assembly-space, the open frame
    // is instance-local, so the result is the open instance's placement
    // regardless of which mate side was proven first.
    const solution = resolveMatePlacement(mate.type, frameSolved, frameOpen);
    return { instanceId: openInstanceId, matrix: solution.transform.matrix };
}

/**
 * Guard a connector pick against deleted instances/connectors (mirrors
 * `resolveCurvePick`): returns the connector only when both it and its
 * instance still exist.
 */
export function resolveConnectorPick(
    connectors: readonly AssemblyConnector[],
    instances: readonly AssemblyInstance[],
    connectorId: unknown
): AssemblyConnector | undefined {
    if (typeof connectorId !== 'string' || connectorId.length === 0) {
        return undefined;
    }
    const connector = connectors.find((c) => c.id === connectorId);
    if (connector === undefined) {
        return undefined;
    }
    if (!instances.some((i) => i.id === connector.instanceId)) {
        return undefined;
    }
    return connector;
}

/** Human-readable free-DOF hint for a mate type (`fixed` locks everything). */
export function freeDofHintText(type: MateType): string {
    const dofs = freeDofsForMateType(type);
    if (dofs.length === 0) {
        return 'Locks all 6 DOF';
    }
    return `Free: ${dofs.map((d) => `${d.kind} about/along ${d.axis}`).join(', ')}`;
}

/** Constrained-DOF contribution of one mate (6 minus its free DOFs). */
export function mateDofContribution(type: MateType): number {
    return constrainedDofsForMateType(type);
}

/** Remaining rigid-body DOFs for an assembly section (grounded-first BFS count). */
export function assemblyDofRemaining(assembly: AssemblySection): number {
    return countAssemblyDof(
        assembly.instances.length,
        assembly.mates.map((m) => m.type)
    );
}

/** One BOM row: instance id, part source, joining mate type, DOF contribution. */
export interface BomRow {
    readonly instanceId: string;
    readonly part: string;
    readonly grounded: boolean;
    readonly mateType?: MateType;
    /** Constrained DOFs removed by the joining mate (0 for grounded/unmated). */
    readonly dofContribution: number;
}

/** Build BOM rows for every instance (first joining mate wins per instance). */
export function buildBomRows(assembly: AssemblySection): BomRow[] {
    return assembly.instances.map((instance) => {
        const grounded = assembly.groundedInstanceId === instance.id;
        const mate = assembly.mates.find((m) => m.instanceA === instance.id || m.instanceB === instance.id);
        return {
            instanceId: instance.id,
            part: instance.part,
            grounded,
            mateType: mate?.type,
            dofContribution: grounded || mate === undefined ? 0 : mateDofContribution(mate.type)
        };
    });
}

/**
 * Map an instance to built solid ids through the assembly `selectorMap` channel
 * (`<instanceId>/<bodyLabel>` keys). Empty when the assembly keys are not present.
 */
export function instanceSolidIds(selectorMap: Record<string, number[]> | undefined, instanceId: string): number[] {
    if (selectorMap === undefined) {
        return [];
    }
    const prefix = `${instanceId}/`;
    const ids = new Set<number>();
    for (const [key, solids] of Object.entries(selectorMap)) {
        if (key === instanceId || key.startsWith(prefix)) {
            for (const solid of solids) {
                ids.add(solid);
            }
        }
    }
    return [...ids].sort((a, b) => a - b);
}

/** Mate pair key (order-independent) for the one-mate-per-pair rule. */
export function matePairKey(instanceA: string, instanceB: string): string {
    return JSON.stringify([instanceA, instanceB].sort());
}

/** One connector frame at its solved assembly pose (for triad overlays + preview). */
export interface ConnectorTriad {
    readonly connectorId: string;
    readonly instanceId: string;
    readonly origin: Vec3;
    readonly xAxis: Vec3;
    readonly yAxis: Vec3;
    readonly zAxis: Vec3;
}

/**
 * Every connector frame lifted to its solved assembly pose (BFS placements).
 * Drives the hover-triad highlight during connector-pick mode and the ghosted
 * mate preview (both connectors at solved poses in `cad-preview`).
 */
export function assemblyConnectorTriads(assembly: AssemblySection): ConnectorTriad[] {
    const transforms = solveAssemblyTransforms(assembly);
    const triads: ConnectorTriad[] = [];
    for (const connector of assembly.connectors) {
        const matrix = transforms.get(connector.instanceId);
        if (matrix === undefined) {
            continue;
        }
        try {
            const frame = connectorFrameInAssembly(connector, matrix);
            triads.push({
                connectorId: connector.id,
                instanceId: connector.instanceId,
                origin: frame.origin,
                xAxis: frame.xAxis,
                yAxis: frame.yAxis,
                zAxis: frame.zAxis
            });
        } catch {
            continue;
        }
    }
    return triads;
}
