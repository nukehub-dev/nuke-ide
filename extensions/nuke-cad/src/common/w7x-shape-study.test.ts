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

import { describe, expect, it } from 'vitest';
import { ASSEMBLY_SCHEMA_VERSION, validateAssemblyDocument } from './assembly-document';
import { validateNukeCadDocument } from './cad-document';
import type { CoilSweepParams } from './cad-document';
import {
    W7X_COIL_SHAPE_ASSET,
    W7X_SHAPE_BODY_COUNT,
    W7X_SHAPE_BODY_PREFIX,
    W7X_SHAPE_CURVE_PREFIX,
    W7X_SHAPE_DEFAULTS,
    W7X_SHAPE_FEATURE_PREFIX,
    W7X_SHAPE_GROUNDED_INSTANCE_ID,
    W7X_SHAPE_INSTANCE_COUNT,
    W7X_SHAPE_MAX_STATIONS,
    W7X_SHAPE_MAX_TILT_DEG,
    W7X_SHAPE_MIN_STATIONS,
    W7X_SHAPE_MIN_TILT_DEG,
    W7X_SHAPE_REFERENCE_VOLUME_M3,
    W7X_SHAPE_SAMPLE_COUNT,
    createW7xShapeStudyDocument,
    planW7xShapeStudy,
    validateW7xCoilShapeAsset,
    type W7xCoilShapeAsset,
    type W7xShapeStudyConfig,
    type W7xShapeStudyPlan
} from './w7x-shape-study';
import { W7X_GEOMETRY_ASSET, W7X_MODULE_COUNT, W7X_MODULE_ROTATIONS_DEG, quaternionForZRotation } from './w7x-generator';

const EXPECTED_SOURCE_HASH = '384d025207b7d6ccc00bef364611526ef0c3093b091f6f4005fb8586ae4f34e3';
const EXPECTED_SOURCE_SIZE = 48795157;
const EXPECTED_ROTATIONS = [0, 72, 144, 216, 288];

interface MutableCoilShape {
    id: string;
    representativeIndex: number;
    referenceVolumeM3: number;
    referenceAreaM2: number;
    referenceBbox: { min: number[]; max: number[]; dims: number[] };
    referenceCenterM3: number[];
    samples: number[][];
    transforms: Array<{ index: number; rotationDeg: number }>;
}

interface MutableCoilAsset {
    source: {
        fileName: string;
        license: string;
        sourceHash: string;
        sourceSize: number;
        sourceUnit: string;
        documentUnits: string;
    };
    moduleCount: number;
    moduleAngleDeg: number;
    coilShapeCount: number;
    coilShapes: MutableCoilShape[];
}

function mutableAsset(): MutableCoilAsset {
    return JSON.parse(JSON.stringify(W7X_COIL_SHAPE_ASSET)) as MutableCoilAsset;
}

function expectAssetRejected(asset: MutableCoilAsset, pattern: RegExp): void {
    expect(() => validateW7xCoilShapeAsset(asset as unknown as W7xCoilShapeAsset)).toThrow(pattern);
}

function expectQuaternionClose(actual: readonly number[], expected: readonly number[]): void {
    expect(actual).toHaveLength(4);
    actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 12));
}

function validatePlanAssembly(plan: W7xShapeStudyPlan) {
    const assembly = plan.document.assembly;
    if (!assembly) {
        throw new Error('shape-study plan has no assembly block');
    }
    return validateAssemblyDocument({
        version: ASSEMBLY_SCHEMA_VERSION,
        name: plan.document.name,
        instances: assembly.instances,
        connectors: assembly.connectors,
        mates: assembly.mates,
        groundedInstanceId: assembly.groundedInstanceId
    });
}

describe('W7-X coil shape asset', () => {
    it('pins the same reference STEP hash, size, and units as the exact geometry asset', () => {
        const source = W7X_COIL_SHAPE_ASSET.source;
        expect(source.fileName).toBe(W7X_GEOMETRY_ASSET.source.fileName);
        expect(source.license).toBe('MIT');
        expect(source.sourceHash).toBe(EXPECTED_SOURCE_HASH);
        expect(source.sourceHash).toBe(W7X_GEOMETRY_ASSET.source.sourceHash);
        expect(source.sourceHash).toMatch(/^[0-9a-f]{64}$/);
        expect(source.sourceSize).toBe(EXPECTED_SOURCE_SIZE);
        expect(source.sourceSize).toBe(W7X_GEOMETRY_ASSET.source.sourceSize);
        expect(source.sourceUnit).toBe(W7X_GEOMETRY_ASSET.source.sourceUnit);
        expect(source.documentUnits).toBe(W7X_GEOMETRY_ASSET.source.documentUnits);
        expect(W7X_COIL_SHAPE_ASSET.moduleCount).toBe(W7X_MODULE_COUNT);
        expect(W7X_COIL_SHAPE_ASSET.moduleAngleDeg).toBe(72);
        expect(W7X_COIL_SHAPE_ASSET.coilShapeCount).toBe(W7X_SHAPE_BODY_COUNT);
        expect(W7X_COIL_SHAPE_ASSET.coilShapes).toHaveLength(W7X_SHAPE_BODY_COUNT);
        expect(validateW7xCoilShapeAsset()).toBe(W7X_COIL_SHAPE_ASSET);
    });

    it('lists ten sequential shapes with unique ids, indices, and five module transforms', () => {
        const ids = new Set<string>();
        const representativeIndices = new Set<number>();
        const transformIndices = new Set<number>();

        for (const [index, shape] of W7X_COIL_SHAPE_ASSET.coilShapes.entries()) {
            expect(shape.id).toBe(`coil_${String(index + 1).padStart(2, '0')}`);
            expect(shape.representativeIndex).toBe(index + 1);
            expect(ids.has(shape.id)).toBe(false);
            expect(representativeIndices.has(shape.representativeIndex)).toBe(false);
            ids.add(shape.id);
            representativeIndices.add(shape.representativeIndex);

            expect(shape.referenceVolumeM3).toBeGreaterThan(0);
            expect(Number.isFinite(shape.referenceVolumeM3)).toBe(true);
            expect(shape.referenceAreaM2).toBeGreaterThan(0);
            expect(Number.isFinite(shape.referenceAreaM2)).toBe(true);
            for (const value of [...shape.referenceCenterM3, ...shape.referenceBbox.min, ...shape.referenceBbox.max]) {
                expect(Number.isFinite(value)).toBe(true);
            }
            expect(shape.referenceBbox.dims.every((value) => Number.isFinite(value) && value > 0)).toBe(true);

            expect(shape.transforms).toHaveLength(5);
            for (const [moduleIndex, transform] of shape.transforms.entries()) {
                expect(transform.rotationDeg).toBe(EXPECTED_ROTATIONS[moduleIndex]);
                expect(transform.index).toBe(shape.representativeIndex + 10 * moduleIndex);
                expect(transformIndices.has(transform.index)).toBe(false);
                transformIndices.add(transform.index);
            }
        }

        expect(ids.size).toBe(W7X_SHAPE_BODY_COUNT);
        expect(representativeIndices.size).toBe(W7X_SHAPE_BODY_COUNT);
        expect(transformIndices.size).toBe(W7X_SHAPE_BODY_COUNT * 5);
    });

    it('carries 121 finite samples per shape with the first point repeated last', () => {
        for (const shape of W7X_COIL_SHAPE_ASSET.coilShapes) {
            expect(shape.samples).toHaveLength(W7X_SHAPE_SAMPLE_COUNT);
            for (const point of shape.samples) {
                expect(point).toHaveLength(3);
                expect(point.every(Number.isFinite)).toBe(true);
            }
            expect(shape.samples[0]).toEqual(shape.samples[shape.samples.length - 1]);
        }
    });

    it('matches the expected one-module reference volume and the exact generator volumes within asset rounding', () => {
        const sum = W7X_COIL_SHAPE_ASSET.coilShapes.reduce((total, shape) => total + shape.referenceVolumeM3, 0);
        expect(sum).toBeCloseTo(W7X_SHAPE_REFERENCE_VOLUME_M3, 12);
        expect(W7X_SHAPE_REFERENCE_VOLUME_M3).toBe(27.608505577);

        // The centerline asset rounds each metric to nine decimals; the pinned
        // generator signatures are full precision. The difference is sub-2e-6 m³.
        W7X_COIL_SHAPE_ASSET.coilShapes.forEach((shape, index) => {
            expect(shape.referenceVolumeM3).toBeCloseTo(W7X_GEOMETRY_ASSET.coilShapes[index].signature.volume, 5);
        });
    });

    it('rejects malformed assets with clear, path-qualified errors', () => {
        let asset = mutableAsset();
        asset.source.sourceHash = '0'.repeat(64);
        expectAssetRejected(asset, /sourceHash/);

        asset = mutableAsset();
        asset.source.sourceSize += 1;
        expectAssetRejected(asset, /sourceSize/);

        asset = mutableAsset();
        asset.moduleCount = 4;
        expectAssetRejected(asset, /moduleCount/);

        asset = mutableAsset();
        asset.coilShapeCount = 9;
        expectAssetRejected(asset, /coilShapeCount/);

        asset = mutableAsset();
        asset.coilShapes.pop();
        expectAssetRejected(asset, /coilShapes must contain exactly 10/);

        asset = mutableAsset();
        asset.coilShapes[1].id = 'coil_01';
        expectAssetRejected(asset, /coilShapes\[1\]\.id must be 'coil_02'/);

        asset = mutableAsset();
        asset.coilShapes[0].samples.pop();
        expectAssetRejected(asset, /121/);

        asset = mutableAsset();
        asset.coilShapes[0].samples[W7X_SHAPE_SAMPLE_COUNT - 1] = [0, 0, 0];
        expectAssetRejected(asset, /closed centerline/);

        asset = mutableAsset();
        asset.coilShapes[0].referenceAreaM2 = 0;
        expectAssetRejected(asset, /referenceAreaM2/);

        asset = mutableAsset();
        asset.coilShapes[0].transforms[1].rotationDeg = 90;
        expectAssetRejected(asset, /rotationDeg must be 72/);

        asset = mutableAsset();
        asset.coilShapes[0].transforms[1].index = 12;
        expectAssetRejected(asset, /index must be 11/);

        asset = mutableAsset();
        asset.coilShapes[0].referenceVolumeM3 += 1;
        expectAssetRejected(asset, /reference volume sum/);
    });
});

describe('W7-X shape study config', () => {
    it('exposes the locked defaults and stable curve prefix', () => {
        expect(W7X_SHAPE_DEFAULTS).toEqual({ width: 0.37, height: 0.37, tiltDeg: 8.6, twistDeg: 0, stations: 60 });
        expect(W7X_SHAPE_CURVE_PREFIX).toBe('curve-coil-');
        expect(W7X_SHAPE_BODY_PREFIX).toBe('body-coil-');
        expect(W7X_SHAPE_FEATURE_PREFIX).toBe('coil-sweep-');
        expect(W7X_SHAPE_INSTANCE_COUNT).toBe(W7X_SHAPE_BODY_COUNT * W7X_MODULE_COUNT);
    });

    it('uses the defaults only for absent fields and applies explicit overrides everywhere', () => {
        const defaults = planW7xShapeStudy();
        expect(defaults.designStudy.report).toMatchObject({
            sectionWidthM: 0.37,
            sectionHeightM: 0.37,
            sectionTiltDeg: 8.6,
            twistDeg: 0,
            stations: 60
        });
        for (const feature of defaults.features) {
            expect(feature.params).toMatchObject({ width: 0.37, height: 0.37, tiltDeg: 8.6, twistDeg: 0, stations: 60 });
        }

        const overrides: W7xShapeStudyConfig = { width: 0.5, height: 0.22, tiltDeg: -30, twistDeg: 12.5, stations: 128 };
        const plan = planW7xShapeStudy(overrides);
        expect(plan.designStudy.report).toMatchObject({
            sectionWidthM: 0.5,
            sectionHeightM: 0.22,
            sectionTiltDeg: -30,
            twistDeg: 12.5,
            stations: 128
        });
        expect(plan.document.parameters).toMatchObject({
            sectionWidthM: 0.5,
            sectionHeightM: 0.22,
            sectionTiltDeg: -30,
            twistDeg: 12.5,
            stations: 128
        });
        for (const feature of plan.features) {
            const params = feature.params as CoilSweepParams;
            expect(params.width).toBe(0.5);
            expect(params.height).toBe(0.22);
            expect(params.tiltDeg).toBe(-30);
            expect(params.twistDeg).toBe(12.5);
            expect(params.stations).toBe(128);
        }

        const partial = planW7xShapeStudy({ width: 0.5 });
        expect(partial.designStudy.report).toMatchObject({
            sectionWidthM: 0.5,
            sectionHeightM: W7X_SHAPE_DEFAULTS.height,
            sectionTiltDeg: W7X_SHAPE_DEFAULTS.tiltDeg,
            twistDeg: W7X_SHAPE_DEFAULTS.twistDeg,
            stations: W7X_SHAPE_DEFAULTS.stations
        });
        expect(W7X_SHAPE_DEFAULTS).toEqual({ width: 0.37, height: 0.37, tiltDeg: 8.6, twistDeg: 0, stations: 60 });
    });

    it('accepts the exact tilt and station boundaries', () => {
        for (const tiltDeg of [W7X_SHAPE_MIN_TILT_DEG, W7X_SHAPE_MAX_TILT_DEG]) {
            expect(planW7xShapeStudy({ tiltDeg }).designStudy.report.sectionTiltDeg).toBe(tiltDeg);
        }
        for (const stations of [W7X_SHAPE_MIN_STATIONS, W7X_SHAPE_MAX_STATIONS]) {
            expect(planW7xShapeStudy({ stations }).designStudy.report.stations).toBe(stations);
        }
    });

    it('rejects invalid values instead of clamping them', () => {
        const cases: Array<[Partial<W7xShapeStudyConfig>, RegExp]> = [
            [{ width: 0 }, /section width/],
            [{ width: -0.1 }, /section width/],
            [{ width: Number.NaN }, /section width/],
            [{ width: Number.POSITIVE_INFINITY }, /section width/],
            [{ height: 0 }, /section height/],
            [{ height: Number.NEGATIVE_INFINITY }, /section height/],
            [{ tiltDeg: W7X_SHAPE_MIN_TILT_DEG - 1 }, /section tilt/],
            [{ tiltDeg: W7X_SHAPE_MAX_TILT_DEG + 1 }, /section tilt/],
            [{ tiltDeg: Number.NaN }, /section tilt/],
            [{ twistDeg: Number.NaN }, /twist/],
            [{ twistDeg: Number.POSITIVE_INFINITY }, /twist/],
            [{ stations: W7X_SHAPE_MIN_STATIONS - 1 }, /stations/],
            [{ stations: W7X_SHAPE_MAX_STATIONS + 1 }, /stations/],
            [{ stations: 60.5 }, /stations/],
            [{ stations: Number.NaN }, /stations/]
        ];
        for (const [config, pattern] of cases) {
            expect(() => planW7xShapeStudy(config)).toThrow(pattern);
        }
        expect(() => planW7xShapeStudy(null as unknown as Partial<W7xShapeStudyConfig>)).toThrow(/config must be an object/);
        expect(() => planW7xShapeStudy({ width: null as unknown as number })).toThrow(/section width/);
    });
});

describe('W7-X shape study plan', () => {
    it('builds ten curves, ten bodies, ten coilSweep features, and fifty instances', () => {
        const plan = planW7xShapeStudy();
        expect(plan.curves).toHaveLength(W7X_SHAPE_BODY_COUNT);
        expect(plan.bodies).toHaveLength(W7X_SHAPE_BODY_COUNT);
        expect(plan.features).toHaveLength(W7X_SHAPE_BODY_COUNT);
        expect(plan.instances).toHaveLength(W7X_SHAPE_INSTANCE_COUNT);
        expect(plan.document.curves).toBe(plan.curves);
        expect(plan.document.bodies).toBe(plan.bodies);
        expect(plan.document.features).toBe(plan.features);
        expect(plan.document.assembly?.instances).toBe(plan.instances);
        expect(plan.document.assembly?.instances).toHaveLength(W7X_SHAPE_INSTANCE_COUNT);
        expect(plan.features.every((feature) => feature.type === 'coilSweep')).toBe(true);
    });

    it('uses the stable curve, body, feature, and instance ids', () => {
        const plan = planW7xShapeStudy();
        const expectedCurveIds = Array.from(
            { length: W7X_SHAPE_BODY_COUNT },
            (_, index) => `${W7X_SHAPE_CURVE_PREFIX}${String(index + 1).padStart(2, '0')}`
        );
        const expectedBodyIds = Array.from(
            { length: W7X_SHAPE_BODY_COUNT },
            (_, index) => `${W7X_SHAPE_BODY_PREFIX}${String(index + 1).padStart(2, '0')}`
        );
        const expectedFeatureIds = Array.from(
            { length: W7X_SHAPE_BODY_COUNT },
            (_, index) => `${W7X_SHAPE_FEATURE_PREFIX}${String(index + 1).padStart(2, '0')}`
        );

        expect(plan.curves.map((curve) => curve.id)).toEqual(expectedCurveIds);
        expect(plan.bodies.map((body) => body.id)).toEqual(expectedBodyIds);
        expect(plan.features.map((feature) => feature.id)).toEqual(expectedFeatureIds);
        expect(plan.instances.map((instance) => instance.id)).toEqual(
            W7X_COIL_SHAPE_ASSET.coilShapes.flatMap((shape) => Array.from({ length: 5 }, (_, moduleIndex) => `${shape.id}_m${moduleIndex}`))
        );

        const allIds = [
            ...plan.curves.map((curve) => curve.id),
            ...plan.bodies.map((body) => body.id),
            ...plan.features.map((feature) => feature.id),
            ...plan.instances.map((instance) => instance.id)
        ];
        expect(new Set(allIds).size).toBe(allIds.length);
        expect(plan.instances[0].id).toBe(W7X_SHAPE_GROUNDED_INSTANCE_ID);
        expect(plan.document.assembly?.groundedInstanceId).toBe(W7X_SHAPE_GROUNDED_INSTANCE_ID);
        expect(plan.instances.filter((instance) => instance.id === W7X_SHAPE_GROUNDED_INSTANCE_ID)).toHaveLength(1);
    });

    it('wires each sweep to its own curve and body with no pathCurveId collisions', () => {
        const plan = planW7xShapeStudy({ width: 0.41, height: 0.29, tiltDeg: 10, twistDeg: 3.5, stations: 96 });
        const curveIds = new Set(plan.curves.map((curve) => curve.id));
        const pathCurveIds = plan.features.map((feature) => (feature.params as CoilSweepParams).pathCurveId);

        expect(new Set(pathCurveIds).size).toBe(pathCurveIds.length);
        expect(new Set(pathCurveIds)).toEqual(curveIds);
        plan.features.forEach((feature, index) => {
            const params = feature.params as CoilSweepParams;
            expect(feature.body).toBe(plan.bodies[index].id);
            expect(params.pathCurveId).toBe(plan.curves[index].id);
            expect(params.width).toBe(0.41);
            expect(params.height).toBe(0.29);
            expect(params.tiltDeg).toBe(10);
            expect(params.twistDeg).toBe(3.5);
            expect(params.stations).toBe(96);
            expect(feature.suppressed).toBe(false);
            expect(feature.dependsOn).toEqual([]);
            expect(feature.name).toBe(`${plan.bodies[index].label} sweep`);
            expect(feature.sketchId).toBeUndefined();
        });
        expect(new Set(plan.bodies.map((body) => body.label))).toEqual(new Set(plan.curves.map((curve) => curve.name.split(' ')[0])));
    });

    it('places five pure Z rotations per shape with grounding and no connectors or mates', () => {
        const plan = planW7xShapeStudy();
        for (const [shapeIndex, shape] of W7X_COIL_SHAPE_ASSET.coilShapes.entries()) {
            const instances = plan.instances.slice(shapeIndex * 5, shapeIndex * 5 + 5);
            expect(instances.map((instance) => instance.id)).toEqual(
                EXPECTED_ROTATIONS.map((_, moduleIndex) => `${shape.id}_m${moduleIndex}`)
            );
            instances.forEach((instance, moduleIndex) => {
                expect(instance.part).toBe(`body:${plan.bodies[shapeIndex].id}`);
                expect(instance.placement.position).toEqual([0, 0, 0]);
                expect(instance.placement.orientation[0]).toBe(0);
                expect(instance.placement.orientation[1]).toBe(0);
                expectQuaternionClose(instance.placement.orientation, quaternionForZRotation(W7X_MODULE_ROTATIONS_DEG[moduleIndex]));
            });
        }
        expect(plan.document.assembly?.connectors).toEqual([]);
        expect(plan.document.assembly?.mates).toEqual([]);
    });

    it('keeps each curve as the committed closed point list', () => {
        const plan = planW7xShapeStudy();
        plan.curves.forEach((curve, index) => {
            const shape = W7X_COIL_SHAPE_ASSET.coilShapes[index];
            expect(curve.name).toBe(`${shape.id} centerline`);
            expect(curve.source).toEqual({ kind: 'points' });
            expect(curve.samples).toHaveLength(W7X_SHAPE_SAMPLE_COUNT);
            expect(curve.samples[0]).toEqual(shape.samples[0]);
            expect(curve.samples[curve.samples.length - 1]).toEqual(curve.samples[0]);
            expect(curve.samples).toEqual(shape.samples);
        });
    });

    it('carries the shape-study marker and reports the per-module reference volume', () => {
        const plan = planW7xShapeStudy();
        const report = plan.designStudy.report;

        expect(plan.designStudy.kind).toBe('w7x-coil-shape-study');
        expect(plan.document.designStudy).toBe(plan.designStudy);
        expect(report).toMatchObject({
            moduleCount: 5,
            coilCount: 50,
            bodyCount: 10,
            sectionWidthM: 0.37,
            sectionHeightM: 0.37,
            sectionTiltDeg: 8.6,
            twistDeg: 0,
            stations: 60,
            referenceVolumeM3: W7X_SHAPE_REFERENCE_VOLUME_M3
        });
        expect(report.referenceVolumeM3).toBe(27.608505577);
        expect(plan.referenceVolumeM3).toBe(27.608505577);
        expect(report.summary).toContain('10 native coil sweep bodies');
        expect(report.summary).toContain('5 modules');
        expect(report.summary).toContain('50 coil instances');
        expect(report.summary).toContain('approximate the reference B-reps');
        expect(report.summary).toContain('for one module');
        expect(report.summary).toContain('27.608505577 m^3');
        expect(report.summary).toContain('Simulation export is disabled');
        expect(report.summary).not.toContain('undefined');
    });

    it('builds a complete v3 document that passes document and assembly validation', () => {
        const plan = planW7xShapeStudy();
        const document = plan.document;

        expect(document.version).toBe(3);
        expect(document.name.length).toBeGreaterThan(0);
        expect(document.units).toBe('m');
        expect(document.displayTolerance).toBe(0.1);
        expect(document.overlapCheck).toBe(false);
        expect(document.datums.map((datum) => datum.id)).toEqual(['datum-xy', 'datum-yz', 'datum-xz']);
        expect(document.sketches).toEqual([]);
        expect(document.parameters).toEqual({
            moduleCount: 5,
            coilCount: 50,
            sectionWidthM: 0.37,
            sectionHeightM: 0.37,
            sectionTiltDeg: 8.6,
            twistDeg: 0,
            stations: 60
        });

        expect(validateNukeCadDocument(document)).toEqual({ valid: true, issues: [] });
        expect(validatePlanAssembly(plan)).toEqual({ valid: true, issues: [] });
    });

    it('reports the same reference total as the ten committed shape volumes and five modules', () => {
        const plan = planW7xShapeStudy();
        const sum = W7X_COIL_SHAPE_ASSET.coilShapes.reduce((total, shape) => total + shape.referenceVolumeM3, 0);
        expect(plan.referenceVolumeM3).toBeCloseTo(sum, 12);
        expect(plan.designStudy.report.referenceVolumeM3).toBeCloseTo(sum, 12);
        expect(plan.referenceVolumeM3 * W7X_MODULE_COUNT).toBeCloseTo(138.042527885, 9);
    });

    it('creates a named document and rejects empty names', () => {
        const document = createW7xShapeStudyDocument('My W7-X study', { width: 0.44 });
        expect(document.name).toBe('My W7-X study');
        expect(document.designStudy?.kind).toBe('w7x-coil-shape-study');
        if (document.designStudy?.kind !== 'w7x-coil-shape-study') {
            throw new Error('created document has no shape-study marker');
        }
        expect(document.designStudy.report.sectionWidthM).toBe(0.44);
        expect(document.designStudy.report.sectionHeightM).toBe(W7X_SHAPE_DEFAULTS.height);
        expect(validateNukeCadDocument(document)).toEqual({ valid: true, issues: [] });
        expect(() => createW7xShapeStudyDocument('')).toThrow(/non-empty string/);
        expect(() => createW7xShapeStudyDocument('   ')).toThrow(/non-empty string/);
    });

    it('accepts a structurally valid clone of the committed asset', () => {
        const plan = planW7xShapeStudy(undefined, mutableAsset() as unknown as W7xCoilShapeAsset);
        expect(plan.curves).toHaveLength(W7X_SHAPE_BODY_COUNT);
        expect(plan.instances).toHaveLength(W7X_SHAPE_INSTANCE_COUNT);
    });
});
