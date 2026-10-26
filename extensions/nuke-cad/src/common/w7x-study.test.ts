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
import { validateW7xCoilStudy } from './cad-document';
import {
    W7X_COIL_STUDY_ASSET,
    W7X_COIL_STUDY_REPORTS,
    W7X_STUDY_MODULE_COUNTS,
    W7X_STUDY_MODULE_ROTATIONS_DEG,
    isW7xStudyModuleCount,
    planW7xCoilStudy,
    studyReport,
    type W7xStudyModuleCount
} from './w7x-study';
import {
    W7X_BODY_LABELS,
    W7X_GEOMETRY_ASSET,
    W7X_GROUNDED_INSTANCE_ID,
    W7X_MODULE_COUNT,
    W7X_MODULE_ROTATIONS_DEG,
    W7X_SHELL_BODY_LABELS,
    mapW7xBodyIds,
    mapW7xPlanToInstances,
    planW7xGenerator,
    quaternionForZRotation,
    type W7xGeneratorSource
} from './w7x-generator';

const SOURCE: W7xGeneratorSource = {
    sourcePath: './w7x-study.parts/scaled_w7x_stellarator.step',
    sourceHash: W7X_GEOMETRY_ASSET.source.sourceHash,
    sourceSize: W7X_GEOMETRY_ASSET.source.sourceSize
};

const EXPECTED_INSTANCES: Record<W7xStudyModuleCount, number> = { 4: 45, 5: 55, 6: 65 };
const EXPECTED_COILS: Record<W7xStudyModuleCount, number> = { 4: 40, 5: 50, 6: 60 };
const EXPECTED_ROTATIONS: Record<W7xStudyModuleCount, readonly number[]> = {
    4: [0, 90, 180, 270],
    5: [0, 72, 144, 216, 288],
    6: [0, 60, 120, 180, 240, 300]
};

const EXPECTED_FOUR_MODULE_SHELL_OVERLAPS = [
    { coil: 'coil_01_m1', shell: 'plasma', volumeM3: 0.07262425261451198 },
    { coil: 'coil_01_m1', shell: 'gap', volumeM3: 0.045737274243147635 },
    { coil: 'coil_01_m1', shell: 'firstwall', volumeM3: 0.020429452553315554 },
    { coil: 'coil_01_m1', shell: 'blanket', volumeM3: 0.46259413190110726 },
    { coil: 'coil_01_m1', shell: 'vessel', volumeM3: 0.022858035443290542 }
];

const EXPECTED_SIX_MODULE_COIL_OVERLAPS = [
    { a: 'coil_01_m1', b: 'coil_08_m0', volumeM3: 0.07275555101930298 },
    { a: 'coil_01_m1', b: 'coil_09_m0', volumeM3: 0.019840057797974403 },
    { a: 'coil_01_m1', b: 'coil_07_m0', volumeM3: 0.0028936399505570176 }
];

function expectQuaternionClose(actual: readonly number[], expected: readonly number[]): void {
    expect(actual).toHaveLength(4);
    actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 12));
}

describe('W7-X coil study report asset', () => {
    it('pins the same reference STEP hash, size, and unit as the valid generator', () => {
        expect(W7X_COIL_STUDY_ASSET.source.fileName).toBe(W7X_GEOMETRY_ASSET.source.fileName);
        expect(W7X_COIL_STUDY_ASSET.source.license).toBe('MIT');
        expect(W7X_COIL_STUDY_ASSET.source.sourceHash).toBe(W7X_GEOMETRY_ASSET.source.sourceHash);
        expect(W7X_COIL_STUDY_ASSET.source.sourceHash).toMatch(/^[0-9a-f]{64}$/);
        expect(W7X_COIL_STUDY_ASSET.source.sourceSize).toBe(W7X_GEOMETRY_ASSET.source.sourceSize);
        expect(W7X_COIL_STUDY_ASSET.source.sourceUnit).toBe('m');
        expect(W7X_COIL_STUDY_ASSET.reports.map((report) => report.moduleCount)).toEqual([4, 5, 6]);
        expect(W7X_COIL_STUDY_REPORTS).toBe(W7X_COIL_STUDY_ASSET.reports);
    });

    it('keeps every report finite, non-empty, and inside the supported module counts', () => {
        for (const report of W7X_COIL_STUDY_REPORTS) {
            expect(W7X_STUDY_MODULE_COUNTS).toContain(report.moduleCount);
            for (const value of [report.pitchDeg, report.moduleSpanDeg, report.uncoveredSectorDeg, report.moduleOverlapDeg]) {
                expect(Number.isFinite(value)).toBe(true);
            }
            expect(report.summary.trim().length).toBeGreaterThan(0);
            for (const overlap of [...report.coilCoilOverlaps, ...report.coilShellOverlaps]) {
                expect(Number.isFinite(overlap.volumeM3)).toBe(true);
                expect(overlap.volumeM3).toBeGreaterThan(0);
            }
        }
    });

    it('reports the 4-module uncovered sector and every coil/shell intersection', () => {
        const report = studyReport(4);
        expect(report.valid).toBe(false);
        expect(report.pitchDeg).toBe(90);
        expect(report.moduleSpanDeg).toBe(65.34020296405286);
        expect(report.uncoveredSectorDeg).toBe(24.659797035947136);
        expect(report.moduleOverlapDeg).toBe(0);
        expect(report.minCoilClearanceM).toBeUndefined();
        expect(report.coilCoilOverlaps).toEqual([]);
        expect(report.coilShellOverlaps).toEqual(EXPECTED_FOUR_MODULE_SHELL_OVERLAPS);
        expect(report.summary).toContain('24.66');
        expect(report.summary).toContain('not a physically valid W7-X');
    });

    it('reports the valid 5-module layout and its minimum adjacent clearance', () => {
        const report = studyReport(5);
        expect(report.valid).toBe(true);
        expect(report.pitchDeg).toBe(72);
        expect(report.moduleSpanDeg).toBe(65.34020296405286);
        expect(report.uncoveredSectorDeg).toBe(6.659797035947136);
        expect(report.moduleOverlapDeg).toBe(0);
        expect(report.minCoilClearanceM).toBe(0.10280660700859308);
        expect(report.coilCoilOverlaps).toEqual([]);
        expect(report.coilShellOverlaps).toEqual([]);
        expect(report.summary).toContain('Valid five-module W7-X');
        expect(report.summary).toContain('0.103');
    });

    it('reports the 6-module overlap and every coil/coil intersection', () => {
        const report = studyReport(6);
        expect(report.valid).toBe(false);
        expect(report.pitchDeg).toBe(60);
        expect(report.moduleSpanDeg).toBe(65.34020296405286);
        expect(report.uncoveredSectorDeg).toBe(0);
        expect(report.moduleOverlapDeg).toBe(5.340202964052864);
        expect(report.minCoilClearanceM).toBeUndefined();
        expect(report.coilCoilOverlaps).toEqual(EXPECTED_SIX_MODULE_COIL_OVERLAPS);
        expect(report.coilShellOverlaps).toEqual([]);
        expect(report.summary).toContain('5.34');
        expect(report.summary).toContain('not a physically valid W7-X');
    });

    it('looks reports up by module count and rejects unsupported counts', () => {
        for (const moduleCount of W7X_STUDY_MODULE_COUNTS) {
            expect(studyReport(moduleCount)).toBe(W7X_COIL_STUDY_REPORTS.find((report) => report.moduleCount === moduleCount));
        }
        expect(() => studyReport(3 as W7xStudyModuleCount)).toThrow(/No W7-X coil-study report/);
    });

    it('narrows supported module counts', () => {
        expect(W7X_STUDY_MODULE_COUNTS).toEqual([4, 5, 6]);
        for (const value of [4, 5, 6]) {
            expect(isW7xStudyModuleCount(value)).toBe(true);
        }
        for (const value of [0, 3, 7, 4.5, Number.NaN]) {
            expect(isW7xStudyModuleCount(value)).toBe(false);
        }
    });
});

describe('W7-X coil study plan', () => {
    it('keeps fifteen bodies and creates 45/55/65 instances with 40/50/60 coils', () => {
        for (const moduleCount of W7X_STUDY_MODULE_COUNTS) {
            const plan = planW7xCoilStudy(SOURCE, moduleCount);
            expect(plan.bodies).toHaveLength(15);
            expect(plan.bodies.filter((body) => body.kind === 'coil')).toHaveLength(10);
            expect(plan.bodies.filter((body) => body.kind === 'shell')).toHaveLength(5);
            expect(plan.instances).toHaveLength(EXPECTED_INSTANCES[moduleCount]);
            expect(plan.instances.filter((instance) => instance.kind === 'coil')).toHaveLength(EXPECTED_COILS[moduleCount]);
            expect(plan.instances.filter((instance) => instance.kind === 'shell')).toHaveLength(5);
            expect(plan.moduleCount).toBe(moduleCount);
            expect(plan.moduleAngleDeg).toBe(360 / moduleCount);
        }
    });

    it('places the configured module rotations per coil shape', () => {
        for (const moduleCount of W7X_STUDY_MODULE_COUNTS) {
            const plan = planW7xCoilStudy(SOURCE, moduleCount);
            const rotations = EXPECTED_ROTATIONS[moduleCount];
            expect(W7X_STUDY_MODULE_ROTATIONS_DEG[moduleCount]).toEqual(rotations);

            for (const shape of W7X_GEOMETRY_ASSET.coilShapes) {
                const body = plan.bodies.find((candidate) => candidate.label === shape.id);
                expect(body).toBeDefined();
                const instances = plan.instances.filter((instance) => instance.bodyLabel === shape.id);
                expect(instances.map((instance) => instance.id)).toEqual(rotations.map((_, moduleIndex) => `${shape.id}_m${moduleIndex}`));
                expect(instances.map((instance) => instance.moduleIndex)).toEqual(rotations.map((_, moduleIndex) => moduleIndex));
                expect(instances.map((instance) => instance.rotationDeg)).toEqual(rotations);
                for (const instance of instances) {
                    expect(instance.part).toBe(`body:${body?.id}`);
                    expect(instance.bodyId).toBe(body?.id);
                    expect(instance.placement.position).toEqual([0, 0, 0]);
                    expectQuaternionClose(instance.placement.orientation, quaternionForZRotation(instance.rotationDeg));
                }
            }
        }
    });

    it('keeps the five shell instances at identity for every study', () => {
        for (const moduleCount of W7X_STUDY_MODULE_COUNTS) {
            const plan = planW7xCoilStudy(SOURCE, moduleCount);
            const shells = plan.instances.filter((instance) => instance.kind === 'shell');
            expect(shells.map((instance) => instance.id)).toEqual(W7X_SHELL_BODY_LABELS);
            for (const instance of shells) {
                expect(instance.moduleIndex).toBe(0);
                expect(instance.rotationDeg).toBe(0);
                expect(instance.placement.position).toEqual([0, 0, 0]);
                expectQuaternionClose(instance.placement.orientation, [0, 0, 0, 1]);
            }
        }
    });

    it('grounds coil_01_m0 and keeps body and instance ids unique', () => {
        for (const moduleCount of W7X_STUDY_MODULE_COUNTS) {
            const plan = planW7xCoilStudy(SOURCE, moduleCount);
            expect(plan.groundedInstanceId).toBe(W7X_GROUNDED_INSTANCE_ID);
            expect(plan.instances[0].id).toBe('coil_01_m0');
            expect(plan.instances.filter((instance) => instance.id === plan.groundedInstanceId)).toHaveLength(1);

            const bodyIds = plan.bodies.map((body) => body.id);
            const instanceIds = plan.instances.map((instance) => instance.id);
            expect(new Set([...bodyIds, ...instanceIds]).size).toBe(bodyIds.length + instanceIds.length);
            expect(new Set(plan.bodies.map((body) => body.label)).size).toBe(plan.bodies.length);

            const knownBodies = new Set(bodyIds);
            for (const instance of plan.instances) {
                expect(knownBodies.has(instance.bodyId)).toBe(true);
                expect(instance.part).toBe(`body:${instance.bodyId}`);
            }
        }
    });

    it('marks every plan as a design study with its measured report', () => {
        for (const moduleCount of W7X_STUDY_MODULE_COUNTS) {
            const plan = planW7xCoilStudy(SOURCE, moduleCount);
            expect(plan.designStudy.kind).toBe('w7x-coil-study');
            expect(plan.designStudy.report).toBe(studyReport(moduleCount));
            expect(plan.designStudy.report.moduleCount).toBe(moduleCount);
            expect('overlapCheck' in plan).toBe(false);
        }
    });

    it('passes the document design-study schema at every module count', () => {
        for (const moduleCount of W7X_STUDY_MODULE_COUNTS) {
            const plan = planW7xCoilStudy(SOURCE, moduleCount);
            const validation = validateW7xCoilStudy(plan.designStudy);
            expect(validation.issues).toEqual([]);
            expect(validation.valid).toBe(true);
        }
    });

    it('matches the valid generator exactly at five modules', () => {
        const valid = planW7xGenerator(SOURCE);
        const study = planW7xCoilStudy(SOURCE, 5);
        expect(study.bodies).toEqual(valid.bodies);
        expect(study.instances).toEqual(valid.instances);
        expect(study.groundedInstanceId).toBe(valid.groundedInstanceId);
        expect(study.moduleCount).toBe(W7X_MODULE_COUNT);
        expect(study.moduleAngleDeg).toBe(valid.moduleAngleDeg);
        expect(study.sourcePath).toBe(valid.sourcePath);
        expect(study.sourceHash).toBe(valid.sourceHash);
        expect(study.sourceSize).toBe(valid.sourceSize);
        expect(study.sourceUnit).toBe(valid.sourceUnit);
        expect(W7X_STUDY_MODULE_ROTATIONS_DEG[5]).toEqual(W7X_MODULE_ROTATIONS_DEG);
    });

    it('reuses the valid generator bodies and preserves the pinned source on every body', () => {
        const valid = planW7xGenerator({ ...SOURCE, sourceFormat: 'step', sourceUnit: 'm' });
        for (const moduleCount of W7X_STUDY_MODULE_COUNTS) {
            const plan = planW7xCoilStudy({ ...SOURCE, sourceFormat: 'step', sourceUnit: 'm' }, moduleCount);
            expect(plan.bodies).toEqual(valid.bodies);
            expect(plan.sourcePath).toBe(SOURCE.sourcePath);
            expect(plan.sourceHash).toBe(SOURCE.sourceHash);
            expect(plan.sourceSize).toBe(SOURCE.sourceSize);
            expect(plan.sourceFormat).toBe('step');
            expect(plan.sourceUnit).toBe('m');
            for (const body of plan.bodies) {
                expect(body.params.sourcePath).toBe(SOURCE.sourcePath);
                expect(body.params.sourceHash).toBe(SOURCE.sourceHash);
                expect(body.params.sourceSize).toBe(SOURCE.sourceSize);
                expect(body.params.sourceFormat).toBe('step');
                expect(body.params.sourceUnit).toBe('m');
            }
        }
    });

    it('rejects a source outside the pinned reference identity', () => {
        expect(() => planW7xCoilStudy({ ...SOURCE, sourceHash: '0'.repeat(64) }, 4)).toThrow(/pinned reference STEP/);
        expect(() => planW7xCoilStudy({ ...SOURCE, sourceSize: SOURCE.sourceSize + 1 }, 4)).toThrow(/pinned reference STEP/);
        expect(() => planW7xCoilStudy({ ...SOURCE, sourceUnit: 'mm' }, 4)).toThrow(/source unit 'm'/);
        expect(() => planW7xCoilStudy(SOURCE, 7 as W7xStudyModuleCount)).toThrow(/supports 4, 5, or 6/);
    });

    it('names only instances that the corresponding plan contains', () => {
        for (const moduleCount of W7X_STUDY_MODULE_COUNTS) {
            const plan = planW7xCoilStudy(SOURCE, moduleCount);
            const report = studyReport(moduleCount);
            const instanceIds = new Set(plan.instances.map((instance) => instance.id));
            for (const overlap of report.coilCoilOverlaps) {
                expect(instanceIds.has(overlap.a)).toBe(true);
                expect(instanceIds.has(overlap.b)).toBe(true);
            }
            for (const overlap of report.coilShellOverlaps) {
                expect(instanceIds.has(overlap.coil)).toBe(true);
                expect(instanceIds.has(overlap.shell)).toBe(true);
            }
            const studyCoil = plan.instances.find((instance) => instance.id === 'coil_01_m1');
            expect(studyCoil?.rotationDeg).toBe(360 / moduleCount);
        }
    });

    it('maps through the valid generator helpers at every module count', () => {
        for (const moduleCount of W7X_STUDY_MODULE_COUNTS) {
            const plan = planW7xCoilStudy(SOURCE, moduleCount);
            const storeIds = W7X_BODY_LABELS.map((label) => `store-${label}`);
            const drafts = mapW7xPlanToInstances(plan, mapW7xBodyIds(plan, storeIds));
            expect(drafts).toHaveLength(EXPECTED_INSTANCES[moduleCount]);
            expect(new Set(drafts.map((draft) => draft.id)).size).toBe(EXPECTED_INSTANCES[moduleCount]);
            expect(drafts.filter((draft) => draft.part === 'body:store-coil_01')).toHaveLength(moduleCount);
        }
    });
});
