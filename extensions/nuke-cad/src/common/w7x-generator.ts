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
 * Pure planner for the valid-only, five-module W7-X generator.
 *
 * The reference STEP contains 55 solids: ten distinct modular-coil shapes with
 * five pure Z-rotated copies each, plus five full-360 shell components. The
 * planner turns that known inventory into fifteen imported source bodies and
 * fifty-five assembly instances without any browser/store dependency, so the
 * same plan can be validated by a minimal-profile test before the UI or the
 * backend touches the STEP.
 *
 * @module nuke-cad/common
 */

import w7xGeometryJson from './samples/w7x/w7x_geometry.json';
import type { DocumentUnits, ImportParams, ImportSolidSignature, ImportSourceFormat, ImportSourceUnit } from './cad-document';
import type { PosQuatPlacement, Quaternion } from './assembly-document';

/** One source solid fingerprint stored in the W7-X geometry asset. */
export type W7xSolidSignature = ImportSolidSignature;

/** One coil-shape copy in the reference STEP. */
export interface W7xCoilTransform {
    /** 1-based explorer-order index of the copy. */
    readonly index: number;
    /** Pure Z rotation from the module-0 representative, in degrees. */
    readonly rotationDeg: number;
}

/** One distinct modular-coil shape and its five module copies. */
export interface W7xCoilShape {
    /** Stable body label (`coil_01` … `coil_10`). */
    readonly id: string;
    /** 1-based explorer-order index of the module-0 representative solid. */
    readonly representativeIndex: number;
    /** Face count and volume of the representative solid. */
    readonly signature: W7xSolidSignature;
    /** Five module copies in module order. */
    readonly transforms: readonly W7xCoilTransform[];
}

/** One full-360 non-coil component. */
export interface W7xShell {
    /** Body label (`plasma`, `gap`, `firstwall`, `blanket`, `vessel`). */
    readonly label: string;
    /** 1-based explorer-order index in the reference STEP. */
    readonly index: number;
    /** Face count and volume of the solid. */
    readonly signature: W7xSolidSignature;
}

/** Committed provenance and expected inventory metadata for the reference STEP. */
export interface W7xGeometrySource {
    readonly fileName: string;
    readonly license: string;
    /** Lowercase SHA-256 hex of the reference STEP bytes. */
    readonly sourceHash: string;
    /** Reference STEP byte size. */
    readonly sourceSize: number;
    readonly sourceUnit: ImportSourceUnit;
    readonly documentUnits: DocumentUnits;
    readonly displayTolerance: number;
    readonly overlapCheck: boolean;
}

/** The small committed W7-X inventory asset (never the 47 MB STEP). */
export interface W7xGeometryAsset {
    readonly source: W7xGeometrySource;
    readonly moduleCount: number;
    readonly moduleAngleDeg: number;
    /** Expected number of solids in the reference STEP (50 coils + 5 shells). */
    readonly expectedSolidCount: number;
    readonly coilShapes: readonly W7xCoilShape[];
    readonly shells: readonly W7xShell[];
}

/** Bundled reference inventory; the generator is locked to this validated asset. */
export const W7X_GEOMETRY_ASSET = w7xGeometryJson as W7xGeometryAsset;

/** The only supported module count for the physically valid W7-X layout. */
export const W7X_MODULE_COUNT = 5;
/** Module copies in placement order (module 0 is the representative). */
export const W7X_MODULE_ORDER: readonly number[] = [0, 1, 2, 3, 4];
/** Module-copy rotations about global Z, matching {@link W7X_MODULE_ORDER}. */
export const W7X_MODULE_ROTATIONS_DEG: readonly number[] = [0, 72, 144, 216, 288];
/** Coil copies per distinct shape. */
export const W7X_COPIES_PER_COIL = 5;
/** Body labels for the ten imported coil shapes, in source order. */
export const W7X_COIL_BODY_LABELS: readonly string[] = [
    'coil_01',
    'coil_02',
    'coil_03',
    'coil_04',
    'coil_05',
    'coil_06',
    'coil_07',
    'coil_08',
    'coil_09',
    'coil_10'
];
/** Body labels for the five imported shell components, in source order. */
export const W7X_SHELL_BODY_LABELS: readonly string[] = ['plasma', 'gap', 'firstwall', 'blanket', 'vessel'];
/** Every imported source-body label, coils first and then shells. */
export const W7X_BODY_LABELS: readonly string[] = [...W7X_COIL_BODY_LABELS, ...W7X_SHELL_BODY_LABELS];
/** Import safety cap stored on every generator feature. */
export const W7X_IMPORT_MAX_SOLIDS = 100;
/** Default grounded instance (the module-0 representative of the first coil). */
export const W7X_GROUNDED_INSTANCE_ID = 'coil_01_m0';
/** Relative volume tolerance for source-solid signature validation. */
export const W7X_VOLUME_RELATIVE_TOLERANCE = 1e-5;

/** Body kind of one imported source body. */
export type W7xBodyKind = 'coil' | 'shell';

/** One inspected source solid (a structural subset of the backend inspection result). */
export interface W7xInspectionSolid {
    /** 1-based explorer-order index. */
    readonly index: number;
    /** STEP/IGES product name when the reader resolved one. */
    readonly name?: string;
    readonly faceCount: number;
    /** Volume in the effective source unit (`m` for the W7-X reference STEP). */
    readonly volume: number;
}

/** Structural subset of the backend import inspection consumed by the validator. */
export interface W7xInspection {
    readonly success?: boolean;
    readonly error?: string;
    readonly solidCount?: number;
    readonly solids?: readonly W7xInspectionSolid[];
}

/** Why one inspected solid or the inventory as a whole did not match the asset. */
export type W7xInspectionMismatchKind =
    'inspectionFailed' | 'count' | 'missingIndex' | 'unexpectedIndex' | 'duplicateIndex' | 'faceCount' | 'volume';

/** One structured inventory mismatch; `index` is absent for whole-inventory errors. */
export interface W7xInspectionMismatch {
    readonly kind: W7xInspectionMismatchKind;
    readonly message: string;
    /** 1-based source-solid index when the mismatch belongs to one solid. */
    readonly index?: number;
    /** Expected body label for a per-solid mismatch. */
    readonly bodyLabel?: string;
    readonly expected?: number | string;
    readonly actual?: number | string;
}

/** Result of validating one source inspection against the reference asset. */
export interface W7xInspectionValidation {
    readonly valid: boolean;
    readonly expectedSolidCount: number;
    readonly actualSolidCount: number;
    readonly mismatches: readonly W7xInspectionMismatch[];
}

/** Source identity supplied by the generator caller (project-relative STEP path). */
export interface W7xGeneratorSource {
    readonly sourcePath: string;
    readonly sourceHash: string;
    readonly sourceSize: number;
    readonly sourceFormat?: ImportSourceFormat;
    readonly sourceUnit?: ImportSourceUnit;
}

/** One imported source body and the `import` feature parameters that create it. */
export interface W7xBodyPlan {
    /** Stable logical body id; the assembly part reference is `body:<id>`. */
    readonly id: string;
    /** User-facing body label (`coil_01`, `plasma`, …). */
    readonly label: string;
    readonly kind: W7xBodyKind;
    /** 1-based source-solid index selected by the feature. */
    readonly sourceIndex: number;
    readonly signature: W7xSolidSignature;
    readonly params: ImportParams;
}

/** One placed assembly instance, expressed with the frozen assembly document types. */
export interface W7xInstancePlan {
    /** Stable instance id (`coil_01_m0`, `plasma`, …). */
    readonly id: string;
    /** Part reference understood by the assembly builder. */
    readonly part: string;
    readonly bodyId: string;
    readonly bodyLabel: string;
    readonly kind: W7xBodyKind;
    /** Module copy index (0 for the representative and for full-360 shells). */
    readonly moduleIndex: number;
    /** Pure Z rotation in degrees. */
    readonly rotationDeg: number;
    readonly placement: PosQuatPlacement;
}

/** One import-body draft derived from a generator body plan. */
export interface W7xImportBodyDraft {
    /** Body name shown in the feature tree (the plan label). */
    readonly name: string;
    /** Optional region-manifest label (the plan label). */
    readonly label: string;
    /** Import feature parameters selecting the exact source solid. */
    readonly params: ImportParams;
}

/** One assembly-instance draft with its part reference already resolved. */
export interface W7xAssemblyInstanceDraft {
    /** Stable readable instance id (`coil_01_m0`, `plasma`, …). */
    readonly id: string;
    /** `body:<actual store body id>` reference. */
    readonly part: string;
    readonly placement: PosQuatPlacement;
}

/** Complete deterministic plan for one five-module W7-X project. */
export interface W7xGeneratorPlan {
    readonly sourcePath: string;
    readonly sourceHash: string;
    readonly sourceSize: number;
    readonly sourceFormat?: ImportSourceFormat;
    readonly sourceUnit: ImportSourceUnit;
    readonly moduleCount: number;
    readonly moduleAngleDeg: number;
    readonly bodies: readonly W7xBodyPlan[];
    readonly instances: readonly W7xInstancePlan[];
    readonly groundedInstanceId: string;
}

interface ExpectedSolidSlot {
    readonly index: number;
    readonly bodyLabel: string;
    readonly signature: W7xSolidSignature;
}

/** Quaternion for a right-handed rotation about global Z. */
export function quaternionForZRotation(degrees: number): Quaternion {
    const halfRadians = (degrees * Math.PI) / 360;
    return [0, 0, Math.sin(halfRadians), Math.cos(halfRadians)];
}

/** Expected source solids in ascending 1-based explorer order. */
function expectedSolidSlots(asset: W7xGeometryAsset): ExpectedSolidSlot[] {
    const slots: ExpectedSolidSlot[] = [];
    for (const shape of asset.coilShapes) {
        for (const transform of shape.transforms) {
            slots.push({
                index: transform.index,
                bodyLabel: shape.id,
                signature: shape.signature
            });
        }
    }
    for (const shell of asset.shells) {
        slots.push({
            index: shell.index,
            bodyLabel: shell.label,
            signature: shell.signature
        });
    }
    return slots.sort((a, b) => a.index - b.index);
}

function volumesMatch(actual: number, expected: number): boolean {
    if (!Number.isFinite(actual)) {
        return false;
    }
    return Math.abs(actual - expected) <= W7X_VOLUME_RELATIVE_TOLERANCE * Math.max(Math.abs(expected), 1e-12);
}

function formatNumber(value: number): string {
    return Number.isFinite(value) ? String(value) : 'non-finite';
}

/**
 * Validate a backend inspection against the reference inventory.
 *
 * Checks the expected solid count, every 1-based index, face counts, and
 * volumes (relative tolerance {@link W7X_VOLUME_RELATIVE_TOLERANCE}). STEP
 * product names are advisory only: OCCT can report the assembly root name for
 * every solid, so names must never reject an otherwise exact inventory. All
 * differences are returned as structured mismatches; the function never
 * throws on bad inventory data.
 */
export function validateW7xInspection(inspection: W7xInspection, asset: W7xGeometryAsset = W7X_GEOMETRY_ASSET): W7xInspectionValidation {
    const expectedSlots = expectedSolidSlots(asset);
    const expectedSolidCount = asset.expectedSolidCount;
    const solids = inspection.solids ?? [];
    const actualSolidCount = inspection.solids !== undefined ? solids.length : (inspection.solidCount ?? 0);

    if (inspection.success === false) {
        const detail = inspection.error ? `: ${inspection.error}` : '.';
        return {
            valid: false,
            expectedSolidCount,
            actualSolidCount,
            mismatches: [
                {
                    kind: 'inspectionFailed',
                    message: `Import inspection failed${detail}`
                }
            ]
        };
    }

    const mismatches: W7xInspectionMismatch[] = [];
    if (actualSolidCount !== expectedSolidCount) {
        mismatches.push({
            kind: 'count',
            message: `Expected ${expectedSolidCount} source solids, inspection reported ${actualSolidCount}.`,
            expected: expectedSolidCount,
            actual: actualSolidCount
        });
    } else if (inspection.solidCount !== undefined && inspection.solidCount !== expectedSolidCount) {
        mismatches.push({
            kind: 'count',
            message: `Expected ${expectedSolidCount} source solids, inspection reported ${inspection.solidCount}.`,
            expected: expectedSolidCount,
            actual: inspection.solidCount
        });
    }

    const expectedByIndex = new Map(expectedSlots.map((slot) => [slot.index, slot]));
    const actualByIndex = new Map<number, W7xInspectionSolid[]>();
    for (const solid of solids) {
        const bucket = actualByIndex.get(solid.index);
        if (bucket) {
            bucket.push(solid);
        } else {
            actualByIndex.set(solid.index, [solid]);
        }
    }

    for (const [index, bucket] of actualByIndex) {
        if (!expectedByIndex.has(index)) {
            mismatches.push({
                kind: 'unexpectedIndex',
                index,
                message: `Unexpected source-solid index ${index}; the reference inventory has 55 solids at indices 1-55.`
            });
        }
        if (bucket.length > 1) {
            mismatches.push({
                kind: 'duplicateIndex',
                index,
                message: `Source-solid index ${index} appears ${bucket.length} times.`,
                actual: bucket.length
            });
        }
    }

    for (const slot of expectedSlots) {
        const bucket = actualByIndex.get(slot.index);
        const actual = bucket?.[0];
        if (!actual) {
            mismatches.push({
                kind: 'missingIndex',
                index: slot.index,
                bodyLabel: slot.bodyLabel,
                message: `Source solid ${slot.index} (${slot.bodyLabel}) is missing from the inspection.`,
                expected: slot.index
            });
            continue;
        }

        if (actual.faceCount !== slot.signature.faceCount) {
            mismatches.push({
                kind: 'faceCount',
                index: slot.index,
                bodyLabel: slot.bodyLabel,
                expected: slot.signature.faceCount,
                actual: actual.faceCount,
                message: `Source solid ${slot.index} (${slot.bodyLabel}): expected ${slot.signature.faceCount} faces, found ${actual.faceCount}.`
            });
        }

        if (!volumesMatch(actual.volume, slot.signature.volume)) {
            mismatches.push({
                kind: 'volume',
                index: slot.index,
                bodyLabel: slot.bodyLabel,
                expected: slot.signature.volume,
                actual: actual.volume,
                message:
                    `Source solid ${slot.index} (${slot.bodyLabel}): expected volume ${slot.signature.volume} m^3, ` +
                    `found ${formatNumber(actual.volume)} m^3 (relative tolerance ${W7X_VOLUME_RELATIVE_TOLERANCE}).`
            });
        }

        // STEP product names are advisory: OCCT often reports the assembly's
        // root product name for every solid (as this reference does), so the
        // index + face-count + volume fingerprint is the identity contract.
    }

    return {
        valid: mismatches.length === 0,
        expectedSolidCount,
        actualSolidCount,
        mismatches
    };
}

function coilBodyId(shapeId: string): string {
    return `w7x-${shapeId.replace(/_/g, '-')}`;
}

function shellBodyId(label: string): string {
    return `w7x-${label}`;
}

function importParams(
    source: W7xGeneratorSource,
    sourceUnit: ImportSourceUnit,
    sourceIndex: number,
    signature: W7xSolidSignature
): ImportParams {
    return {
        sourcePath: source.sourcePath,
        sourceHash: source.sourceHash,
        sourceSize: source.sourceSize,
        ...(source.sourceFormat !== undefined ? { sourceFormat: source.sourceFormat } : {}),
        sourceUnit,
        selection: {
            mode: 'solids',
            solids: [{ index: sourceIndex, signature: { faceCount: signature.faceCount, volume: signature.volume } }]
        },
        maxSolids: W7X_IMPORT_MAX_SOLIDS
    };
}

function placementForRotation(rotationDeg: number): PosQuatPlacement {
    return {
        position: [0, 0, 0],
        orientation: quaternionForZRotation(rotationDeg)
    };
}

/**
 * Build the deterministic fifteen-body / fifty-five-instance W7-X plan.
 *
 * Every imported feature uses the same project-relative source path, hash and
 * size, selects exactly one source solid by 1-based index plus signature, and
 * caps the source at {@link W7X_IMPORT_MAX_SOLIDS} solids. Coil bodies receive
 * five pure Z-rotated instances; shell bodies receive one identity instance.
 */
export function planW7xGenerator(source: W7xGeneratorSource, asset: W7xGeometryAsset = W7X_GEOMETRY_ASSET): W7xGeneratorPlan {
    const sourceUnit = source.sourceUnit ?? asset.source.sourceUnit;
    const bodies: W7xBodyPlan[] = [];
    const bodyByLabel = new Map<string, W7xBodyPlan>();

    for (const shape of asset.coilShapes) {
        const signature = { faceCount: shape.signature.faceCount, volume: shape.signature.volume };
        const body: W7xBodyPlan = {
            id: coilBodyId(shape.id),
            label: shape.id,
            kind: 'coil',
            sourceIndex: shape.representativeIndex,
            signature,
            params: importParams(source, sourceUnit, shape.representativeIndex, signature)
        };
        bodies.push(body);
        bodyByLabel.set(body.label, body);
    }

    for (const shell of asset.shells) {
        const signature = { faceCount: shell.signature.faceCount, volume: shell.signature.volume };
        const body: W7xBodyPlan = {
            id: shellBodyId(shell.label),
            label: shell.label,
            kind: 'shell',
            sourceIndex: shell.index,
            signature,
            params: importParams(source, sourceUnit, shell.index, signature)
        };
        bodies.push(body);
        bodyByLabel.set(body.label, body);
    }

    const instances: W7xInstancePlan[] = [];
    for (const shape of asset.coilShapes) {
        const body = bodyByLabel.get(shape.id);
        if (!body) {
            continue;
        }
        shape.transforms.forEach((transform, moduleIndex) => {
            instances.push({
                id: `${shape.id}_m${moduleIndex}`,
                part: `body:${body.id}`,
                bodyId: body.id,
                bodyLabel: body.label,
                kind: 'coil',
                moduleIndex,
                rotationDeg: transform.rotationDeg,
                placement: placementForRotation(transform.rotationDeg)
            });
        });
    }

    for (const shell of asset.shells) {
        const body = bodyByLabel.get(shell.label);
        if (!body) {
            continue;
        }
        instances.push({
            id: shell.label,
            part: `body:${body.id}`,
            bodyId: body.id,
            bodyLabel: body.label,
            kind: 'shell',
            moduleIndex: 0,
            rotationDeg: 0,
            placement: placementForRotation(0)
        });
    }

    return {
        sourcePath: source.sourcePath,
        sourceHash: source.sourceHash,
        sourceSize: source.sourceSize,
        ...(source.sourceFormat !== undefined ? { sourceFormat: source.sourceFormat } : {}),
        sourceUnit,
        moduleCount: asset.moduleCount,
        moduleAngleDeg: asset.moduleAngleDeg,
        bodies,
        instances,
        groundedInstanceId: instances[0]?.id ?? W7X_GROUNDED_INSTANCE_ID
    };
}

/**
 * Turn the fifteen body plans into one `addImportBodies` batch.
 *
 * Body name and label both use the stable plan label (`coil_01`, `plasma`, …)
 * so the feature tree, outline, and BOM stay readable after generation.
 */
export function mapW7xPlanToImports(plan: W7xGeneratorPlan): W7xImportBodyDraft[] {
    return plan.bodies.map((body) => ({
        name: body.label,
        label: body.label,
        params: body.params
    }));
}

/**
 * Pair the plan's body labels with the body ids returned by the store.
 *
 * `addImportBodies` returns ids in draft order, so the plan body order is the
 * only contract. A length mismatch is rejected instead of silently dropping a
 * body or pairing the wrong instance geometry.
 */
export function mapW7xBodyIds(plan: W7xGeneratorPlan, bodyIds: readonly string[]): Map<string, string> {
    if (bodyIds.length !== plan.bodies.length) {
        throw new Error(`W7-X generator expected ${plan.bodies.length} imported body ids, received ${bodyIds.length}.`);
    }
    const bodyIdsByLabel = new Map<string, string>();
    plan.bodies.forEach((body, index) => {
        const id = bodyIds[index];
        if (typeof id !== 'string' || id.length === 0) {
            throw new Error(`W7-X generator body '${body.label}' has no store body id.`);
        }
        bodyIdsByLabel.set(body.label, id);
    });
    return bodyIdsByLabel;
}

/**
 * Turn the fifty-five instance plans into one `addAssemblyInstances` batch.
 *
 * Every `part` is rewritten from the plan's logical `body:<plan id>` reference
 * to the actual store body id, so instance ids, placements, and grounding stay
 * exactly as planned while the document remains free to assign its own ids.
 */
export function mapW7xPlanToInstances(plan: W7xGeneratorPlan, bodyIdsByLabel: ReadonlyMap<string, string>): W7xAssemblyInstanceDraft[] {
    return plan.instances.map((instance) => {
        const bodyId = bodyIdsByLabel.get(instance.bodyLabel);
        if (bodyId === undefined) {
            throw new Error(`W7-X generator instance '${instance.id}' references missing body '${instance.bodyLabel}'.`);
        }
        return {
            id: instance.id,
            part: `body:${bodyId}`,
            placement: instance.placement
        };
    });
}
