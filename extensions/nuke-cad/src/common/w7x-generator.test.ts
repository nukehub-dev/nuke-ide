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

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
    W7X_BODY_LABELS,
    W7X_COIL_BODY_LABELS,
    W7X_GEOMETRY_ASSET,
    W7X_GROUNDED_INSTANCE_ID,
    W7X_IMPORT_MAX_SOLIDS,
    W7X_MODULE_COUNT,
    W7X_MODULE_ORDER,
    W7X_MODULE_ROTATIONS_DEG,
    W7X_SHELL_BODY_LABELS,
    W7X_VOLUME_RELATIVE_TOLERANCE,
    mapW7xBodyIds,
    mapW7xPlanToImports,
    mapW7xPlanToInstances,
    planW7xGenerator,
    quaternionForZRotation,
    validateW7xInspection,
    type W7xGeneratorSource,
    type W7xGeometryAsset,
    type W7xInspection
} from './w7x-generator';

const EXPECTED_SOURCE_HASH = '384d025207b7d6ccc00bef364611526ef0c3093b091f6f4005fb8586ae4f34e3';
const EXPECTED_SOURCE_SIZE = 48795157;
const EXPECTED_COIL_VOLUMES = [
    2.7874774986709525, 2.768814942790038, 2.744234309451654, 2.7466608203846024, 2.739938518567987, 2.747058021956086, 2.7580355964580683,
    2.7532155225308585, 2.774817338505324, 2.788251847057275
];
const EXPECTED_SHELLS = [
    { label: 'plasma', index: 51, faceCount: 1, volume: 467.2701874526777 },
    { label: 'gap', index: 52, faceCount: 2, volume: 44.40839875069065 },
    { label: 'firstwall', index: 53, faceCount: 2, volume: 18.19782335675012 },
    { label: 'blanket', index: 54, faceCount: 2, volume: 591.5151859067528 },
    { label: 'vessel', index: 55, faceCount: 2, volume: 49.97831687987991 }
];

const asset = W7X_GEOMETRY_ASSET;
const SOURCE: W7xGeneratorSource = {
    sourcePath: './w7x-generator.parts/scaled_w7x_stellarator.step',
    sourceHash: asset.source.sourceHash,
    sourceSize: asset.source.sourceSize
};

type MutableInspectionSolid = { index: number; name?: string; faceCount: number; volume: number };
type MutableInspection = { success: boolean; solidCount: number; solids: MutableInspectionSolid[] };

function syntheticInspection(from: W7xGeometryAsset = asset): MutableInspection {
    const solids: MutableInspectionSolid[] = [];
    for (const shape of from.coilShapes) {
        for (const transform of shape.transforms) {
            solids.push({
                index: transform.index,
                name: `coil_${transform.index - 1}`,
                faceCount: shape.signature.faceCount,
                volume: shape.signature.volume
            });
        }
    }
    for (const shell of from.shells) {
        solids.push({
            index: shell.index,
            name: shell.label,
            faceCount: shell.signature.faceCount,
            volume: shell.signature.volume
        });
    }
    solids.sort((a, b) => a.index - b.index);
    return { success: true, solidCount: solids.length, solids };
}

function expectQuaternionClose(actual: readonly number[], expected: readonly number[]): void {
    expect(actual).toHaveLength(4);
    actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 12));
}

function mismatchKinds(result: ReturnType<typeof validateW7xInspection>): string[] {
    return result.mismatches.map((mismatch) => mismatch.kind);
}

describe('W7-X geometry asset', () => {
    it('identifies the pinned reference source', () => {
        expect(asset.source.fileName).toBe('scaled_w7x_stellarator.step');
        expect(asset.source.license).toBe('MIT');
        expect(asset.source.sourceHash).toMatch(/^[0-9a-f]{64}$/);
        expect(asset.source.sourceHash).toBe(EXPECTED_SOURCE_HASH);
        expect(asset.source.sourceSize).toBe(EXPECTED_SOURCE_SIZE);
        expect(asset.source.sourceUnit).toBe('m');
        expect(asset.source.documentUnits).toBe('m');
        expect(asset.source.displayTolerance).toBe(0.1);
        expect(asset.source.overlapCheck).toBe(false);
        expect(asset.moduleCount).toBe(W7X_MODULE_COUNT);
        expect(asset.moduleAngleDeg).toBe(72);
        expect(asset.expectedSolidCount).toBe(55);
    });

    it('lists the ten coil shapes and their five module transforms', () => {
        expect(W7X_MODULE_ORDER).toEqual([0, 1, 2, 3, 4]);
        expect(W7X_MODULE_ROTATIONS_DEG).toEqual([0, 72, 144, 216, 288]);
        expect(asset.coilShapes).toHaveLength(10);
        expect(asset.coilShapes.map((shape) => shape.id)).toEqual(W7X_COIL_BODY_LABELS);
        expect(asset.coilShapes.map((shape) => shape.representativeIndex)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

        asset.coilShapes.forEach((shape, shapeIndex) => {
            expect(shape.signature.faceCount).toBe(4);
            expect(shape.signature.volume).toBe(EXPECTED_COIL_VOLUMES[shapeIndex]);
            expect(shape.transforms).toHaveLength(5);
            expect(shape.transforms.map((transform) => transform.index)).toEqual([
                1 + shapeIndex,
                11 + shapeIndex,
                21 + shapeIndex,
                31 + shapeIndex,
                41 + shapeIndex
            ]);
            expect(shape.transforms.map((transform) => transform.rotationDeg)).toEqual([0, 72, 144, 216, 288]);
        });
    });

    it('lists the five full-360 shells with exact indices, faces, and volumes', () => {
        expect(asset.shells.map((shell) => shell.label)).toEqual(W7X_SHELL_BODY_LABELS);
        for (const [index, shell] of asset.shells.entries()) {
            expect(shell.label).toBe(EXPECTED_SHELLS[index].label);
            expect(shell.index).toBe(EXPECTED_SHELLS[index].index);
            expect(shell.signature.faceCount).toBe(EXPECTED_SHELLS[index].faceCount);
            expect(shell.signature.volume).toBe(EXPECTED_SHELLS[index].volume);
        }
    });

    it('covers every 1-based source index exactly once', () => {
        const indices = [
            ...asset.coilShapes.flatMap((shape) => shape.transforms.map((transform) => transform.index)),
            ...asset.shells.map((shell) => shell.index)
        ];
        expect(indices).toHaveLength(55);
        expect(new Set(indices).size).toBe(55);
        expect([...indices].sort((a, b) => a - b)).toEqual(Array.from({ length: 55 }, (_, index) => index + 1));
        expect(W7X_BODY_LABELS).toEqual([...W7X_COIL_BODY_LABELS, ...W7X_SHELL_BODY_LABELS]);
    });
});

const researchDirectory = path.resolve(__dirname, '../../../../.research/nuke-cad/w7x-parametric');
const inventoryPath = path.join(researchDirectory, 'solid_inventory.json');
const nonCoilPath = path.join(researchDirectory, 'non_coil_components.json');
const researchAvailable = fs.existsSync(inventoryPath) && fs.existsSync(nonCoilPath);

interface ResearchSolid {
    index: number;
    faces: number;
    volume_m3: number;
    step_name: string;
    is_coil: boolean;
}

describe.skipIf(!researchAvailable)('W7-X geometry asset vs research inventory', () => {
    it('matches every representative, copy index, and shell from the extracted inventory', () => {
        const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) as {
            source_size_bytes: number;
            solids: ResearchSolid[];
        };
        const nonCoil = JSON.parse(fs.readFileSync(nonCoilPath, 'utf8')) as { components: ResearchSolid[] };
        const byIndex = new Map(inventory.solids.map((solid) => [solid.index, solid]));
        const nonCoilByIndex = new Map(nonCoil.components.map((solid) => [solid.index, solid]));

        expect(asset.source.sourceSize).toBe(inventory.source_size_bytes);

        for (const shape of asset.coilShapes) {
            const representative = byIndex.get(shape.representativeIndex - 1);
            expect(representative, `missing representative for ${shape.id}`).toBeDefined();
            expect(representative?.is_coil).toBe(true);
            expect(representative?.faces).toBe(shape.signature.faceCount);
            expect(representative?.volume_m3).toBe(shape.signature.volume);
            expect(representative?.step_name).toBe(`coil_${shape.representativeIndex - 1}`);

            for (const transform of shape.transforms) {
                const copy = byIndex.get(transform.index - 1);
                expect(copy, `missing ${shape.id} copy ${transform.index}`).toBeDefined();
                expect(copy?.is_coil).toBe(true);
                expect(copy?.faces).toBe(shape.signature.faceCount);
                expect(copy?.step_name).toBe(`coil_${transform.index - 1}`);
                expect(Math.abs((copy?.volume_m3 ?? 0) - shape.signature.volume) / shape.signature.volume).toBeLessThan(
                    W7X_VOLUME_RELATIVE_TOLERANCE
                );
            }
        }

        for (const shell of asset.shells) {
            const source = nonCoilByIndex.get(shell.index - 1);
            expect(source, `missing ${shell.label}`).toBeDefined();
            expect(source?.step_name).toBe(shell.label);
            expect(source?.faces).toBe(shell.signature.faceCount);
            expect(source?.volume_m3).toBe(shell.signature.volume);
        }
    });
});

const referenceStepPath = process.env.NUKE_E2E_W7X_STEP;
const referenceStepAvailable = referenceStepPath !== undefined && fs.existsSync(referenceStepPath);

describe.skipIf(!referenceStepAvailable)('W7-X reference STEP identity', () => {
    it('matches the committed hash and size', () => {
        const bytes = fs.readFileSync(referenceStepPath as string);
        expect(bytes.length).toBe(asset.source.sourceSize);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.source.sourceHash);
    });
});

describe('W7-X generator plan', () => {
    it('creates fifteen imported bodies and fifty-five instances', () => {
        const plan = planW7xGenerator(SOURCE);
        expect(plan.bodies).toHaveLength(15);
        expect(plan.bodies.filter((body) => body.kind === 'coil')).toHaveLength(10);
        expect(plan.bodies.filter((body) => body.kind === 'shell')).toHaveLength(5);
        expect(plan.bodies.map((body) => body.label)).toEqual(W7X_BODY_LABELS);
        expect(plan.instances).toHaveLength(55);
        expect(plan.instances.filter((instance) => instance.kind === 'coil')).toHaveLength(50);
        expect(plan.instances.filter((instance) => instance.kind === 'shell')).toHaveLength(5);
        expect(plan.moduleCount).toBe(5);
        expect(plan.moduleAngleDeg).toBe(72);
    });

    it('stores one-solid import selections with the reference signature on every body', () => {
        const plan = planW7xGenerator({ ...SOURCE, sourceFormat: 'step' });
        for (const body of plan.bodies) {
            expect(body.params.sourcePath).toBe(SOURCE.sourcePath);
            expect(body.params.sourceHash).toBe(SOURCE.sourceHash);
            expect(body.params.sourceSize).toBe(SOURCE.sourceSize);
            expect(body.params.sourceFormat).toBe('step');
            expect(body.params.sourceUnit).toBe('m');
            expect(body.params.maxSolids).toBe(W7X_IMPORT_MAX_SOLIDS);
            expect(body.params.selection).toEqual({
                mode: 'solids',
                solids: [{ index: body.sourceIndex, signature: body.signature }]
            });
        }
        expect(plan.sourceUnit).toBe('m');
        expect(plan.sourceFormat).toBe('step');
    });

    it('places five rotated instances per coil body and one identity instance per shell', () => {
        const plan = planW7xGenerator(SOURCE);
        for (const shape of asset.coilShapes) {
            const body = plan.bodies.find((candidate) => candidate.label === shape.id);
            expect(body).toBeDefined();
            const coilInstances = plan.instances.filter((instance) => instance.bodyLabel === shape.id);
            expect(coilInstances.map((instance) => instance.id)).toEqual([
                `${shape.id}_m0`,
                `${shape.id}_m1`,
                `${shape.id}_m2`,
                `${shape.id}_m3`,
                `${shape.id}_m4`
            ]);
            expect(coilInstances.map((instance) => instance.moduleIndex)).toEqual([0, 1, 2, 3, 4]);
            expect(coilInstances.map((instance) => instance.rotationDeg)).toEqual([0, 72, 144, 216, 288]);
            for (const instance of coilInstances) {
                expect(instance.part).toBe(`body:${body?.id}`);
                expect(instance.placement.position).toEqual([0, 0, 0]);
                expectQuaternionClose(instance.placement.orientation, quaternionForZRotation(instance.rotationDeg));
            }
        }

        const shellInstances = plan.instances.filter((instance) => instance.kind === 'shell');
        expect(shellInstances.map((instance) => instance.id)).toEqual(W7X_SHELL_BODY_LABELS);
        for (const instance of shellInstances) {
            const body = plan.bodies.find((candidate) => candidate.id === instance.bodyId);
            expect(body?.kind).toBe('shell');
            expect(instance.part).toBe(`body:${body?.id}`);
            expect(instance.moduleIndex).toBe(0);
            expect(instance.rotationDeg).toBe(0);
            expect(instance.placement.position).toEqual([0, 0, 0]);
            expectQuaternionClose(instance.placement.orientation, [0, 0, 0, 1]);
        }
    });

    it('grounds exactly one existing coil instance and keeps every id unique', () => {
        const plan = planW7xGenerator(SOURCE);
        expect(plan.groundedInstanceId).toBe(W7X_GROUNDED_INSTANCE_ID);
        expect(plan.instances.filter((instance) => instance.id === plan.groundedInstanceId)).toHaveLength(1);

        const ids = [...plan.bodies.map((body) => body.id), ...plan.instances.map((instance) => instance.id)];
        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(plan.bodies.map((body) => body.label)).size).toBe(plan.bodies.length);

        const bodyIds = new Set(plan.bodies.map((body) => body.id));
        for (const instance of plan.instances) {
            expect(bodyIds.has(instance.bodyId)).toBe(true);
            expect(instance.part).toBe(`body:${instance.bodyId}`);
        }
    });
});

describe('W7-X plan mapping', () => {
    it('maps every body plan to one named import draft with its exact parameters', () => {
        const plan = planW7xGenerator(SOURCE);
        const drafts = mapW7xPlanToImports(plan);
        expect(drafts).toHaveLength(15);
        expect(drafts.map((draft) => draft.name)).toEqual(W7X_BODY_LABELS);
        expect(drafts.map((draft) => draft.label)).toEqual(W7X_BODY_LABELS);
        for (const [index, draft] of drafts.entries()) {
            expect(draft.params).toBe(plan.bodies[index].params);
        }
        expect(drafts[0].params.selection).toEqual({
            mode: 'solids',
            solids: [{ index: 1, signature: plan.bodies[0].signature }]
        });
        expect(drafts[14].params.selection).toEqual({
            mode: 'solids',
            solids: [{ index: 55, signature: plan.bodies[14].signature }]
        });
    });

    it('pairs store body ids with plan labels in draft order', () => {
        const plan = planW7xGenerator(SOURCE);
        const storeIds = W7X_BODY_LABELS.map((label, index) => `body-${index + 7}-${label}`);
        const bodyIdsByLabel = mapW7xBodyIds(plan, storeIds);
        expect([...bodyIdsByLabel.entries()]).toEqual(W7X_BODY_LABELS.map((label, index) => [label, storeIds[index]]));
        expect(bodyIdsByLabel.get('coil_01')).toBe('body-7-coil_01');
        expect(bodyIdsByLabel.get('vessel')).toBe('body-21-vessel');
    });

    it('rejects a body-id count mismatch instead of mispairing geometry', () => {
        const plan = planW7xGenerator(SOURCE);
        expect(() => mapW7xBodyIds(plan, ['only-one'])).toThrow(/expected 15 imported body ids, received 1/);
    });

    it('rewrites all 55 parts to the actual store body ids and preserves placements', () => {
        const plan = planW7xGenerator(SOURCE);
        const storeIds = W7X_BODY_LABELS.map((label) => `store-${label}`);
        const drafts = mapW7xPlanToInstances(plan, mapW7xBodyIds(plan, storeIds));

        expect(drafts).toHaveLength(55);
        expect(drafts.map((draft) => draft.id)).toEqual(plan.instances.map((instance) => instance.id));
        expect(drafts.filter((draft) => draft.part === 'body:store-coil_01')).toHaveLength(5);
        expect(drafts.find((draft) => draft.id === 'coil_01_m0')?.part).toBe('body:store-coil_01');
        expect(drafts.find((draft) => draft.id === 'coil_10_m4')?.part).toBe('body:store-coil_10');
        expect(drafts.find((draft) => draft.id === 'plasma')?.part).toBe('body:store-plasma');
        expect(drafts.find((draft) => draft.id === 'vessel')?.part).toBe('body:store-vessel');
        for (const [index, draft] of drafts.entries()) {
            expect(draft.placement).toBe(plan.instances[index].placement);
        }
        expect(new Set(drafts.map((draft) => draft.id)).size).toBe(55);
        expect(drafts.every((draft) => draft.part.startsWith('body:store-'))).toBe(true);
    });

    it('rejects instances whose body label has no store id', () => {
        const plan = planW7xGenerator(SOURCE);
        const bodyIdsByLabel = mapW7xBodyIds(
            plan,
            W7X_BODY_LABELS.map((label) => `store-${label}`)
        );
        bodyIdsByLabel.delete('coil_07');
        expect(() => mapW7xPlanToInstances(plan, bodyIdsByLabel)).toThrow(/coil_07_m0.*missing body 'coil_07'/);
    });
});

describe('W7-X inspection validation', () => {
    it('accepts the exact reference inventory', () => {
        const result = validateW7xInspection(syntheticInspection());
        expect(result.mismatches).toEqual([]);
        expect(result.valid).toBe(true);
        expect(result.expectedSolidCount).toBe(55);
        expect(result.actualSolidCount).toBe(55);
    });

    it('accepts missing names and copy volumes inside the relative tolerance', () => {
        const inspection = syntheticInspection();
        for (const solid of inspection.solids) {
            delete solid.name;
        }
        const firstCopy = inspection.solids.find((solid) => solid.index === 11);
        expect(firstCopy).toBeDefined();
        if (firstCopy) {
            firstCopy.volume *= 1 + W7X_VOLUME_RELATIVE_TOLERANCE / 2;
        }
        expect(validateW7xInspection(inspection).valid).toBe(true);
    });

    it('rejects a solid-count mismatch and reports the missing index', () => {
        const inspection = syntheticInspection();
        inspection.solids.pop();
        const result = validateW7xInspection(inspection);
        expect(result.valid).toBe(false);
        expect(mismatchKinds(result)).toContain('count');
        expect(result.mismatches.find((mismatch) => mismatch.kind === 'missingIndex')?.index).toBe(55);
    });

    it('rejects a changed index as both missing and unexpected', () => {
        const inspection = syntheticInspection();
        const solid = inspection.solids.find((candidate) => candidate.index === 1);
        expect(solid).toBeDefined();
        if (solid) {
            solid.index = 56;
        }
        const result = validateW7xInspection(inspection);
        expect(result.valid).toBe(false);
        expect(result.mismatches).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'missingIndex', index: 1 }),
                expect.objectContaining({ kind: 'unexpectedIndex', index: 56 })
            ])
        );
    });

    it('rejects a face-count mismatch', () => {
        const inspection = syntheticInspection();
        const solid = inspection.solids.find((candidate) => candidate.index === 1);
        expect(solid).toBeDefined();
        if (solid) {
            solid.faceCount = 3;
        }
        const result = validateW7xInspection(inspection);
        expect(result.valid).toBe(false);
        expect(mismatchKinds(result)).toEqual(['faceCount']);
        expect(result.mismatches[0]).toMatchObject({ index: 1, bodyLabel: 'coil_01', expected: 4, actual: 3 });
    });

    it('rejects a volume mismatch outside the relative tolerance', () => {
        const inspection = syntheticInspection();
        const solid = inspection.solids.find((candidate) => candidate.index === 51);
        expect(solid).toBeDefined();
        if (solid) {
            solid.volume *= 1 + W7X_VOLUME_RELATIVE_TOLERANCE * 2;
        }
        const result = validateW7xInspection(inspection);
        expect(result.valid).toBe(false);
        expect(mismatchKinds(result)).toEqual(['volume']);
        expect(result.mismatches[0]).toMatchObject({ index: 51, bodyLabel: 'plasma' });
    });

    it('accepts inherited/root STEP product names because geometry is the identity contract', () => {
        const inspection = syntheticInspection();
        for (const solid of inspection.solids) {
            solid.name = 'Simplified Stellarator based on reactor scaled W7X. Model made by Proxima Fusion';
        }
        const result = validateW7xInspection(inspection);
        expect(result.valid).toBe(true);
        expect(result.mismatches).toEqual([]);
    });

    it('reports a failed inspection without throwing', () => {
        const inspection: W7xInspection = { success: false, error: 'unreadable source', solids: [] };
        const result = validateW7xInspection(inspection);
        expect(result.valid).toBe(false);
        expect(mismatchKinds(result)).toEqual(['inspectionFailed']);
        expect(result.mismatches[0].message).toContain('unreadable source');
    });
});

describe('W7-X Z-rotation quaternions', () => {
    it('returns the identity at zero degrees', () => {
        expectQuaternionClose(quaternionForZRotation(0), [0, 0, 0, 1]);
    });

    it('returns the expected 72, 144, 216, and 288 degree rotations', () => {
        expectQuaternionClose(quaternionForZRotation(72), [0, 0, Math.sin(Math.PI / 5), Math.cos(Math.PI / 5)]);
        expectQuaternionClose(quaternionForZRotation(144), [0, 0, Math.sin((2 * Math.PI) / 5), Math.cos((2 * Math.PI) / 5)]);
        expectQuaternionClose(quaternionForZRotation(216), [0, 0, Math.sin((3 * Math.PI) / 5), Math.cos((3 * Math.PI) / 5)]);
        expectQuaternionClose(quaternionForZRotation(288), [0, 0, Math.sin((4 * Math.PI) / 5), Math.cos((4 * Math.PI) / 5)]);
    });

    it('always returns a unit quaternion', () => {
        for (const degrees of [-360, -72, 0, 72, 180, 288, 360]) {
            const [x, y, z, w] = quaternionForZRotation(degrees);
            expect(x).toBe(0);
            expect(y).toBe(0);
            expect(Math.hypot(x, y, z, w)).toBeCloseTo(1, 12);
        }
    });
});
