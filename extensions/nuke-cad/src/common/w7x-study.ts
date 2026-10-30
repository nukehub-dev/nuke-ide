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
 * Experimental W7-X coil-count study planner.
 *
 * The physically valid generator is locked to five modules. This module adds a
 * deliberately separate study mode that reuses the same fifteen imported bodies
 * while placing the ten coil shapes at four, five, or six module copies. The
 * committed report records the measured shell/coil interference from the
 * pinned reference STEP; the study is never simulation-ready and the caller
 * marks the document as a design study.
 *
 * `overlapCheck` is a document setting, not part of the plan.
 *
 * @module nuke-cad/common
 */

import w7xStudyJson from './samples/w7x/w7x_study.json';
import { W7X_GEOMETRY_ASSET, W7X_MODULE_COUNT, planW7xGenerator, quaternionForZRotation } from './w7x-generator';
import type { W7xGeneratorPlan, W7xGeneratorSource, W7xInstancePlan } from './w7x-generator';
import type { ImportSourceUnit, W7xCoilStudy, W7xCoilStudyReport } from './cad-document';

export type { W7xCoilCoilOverlap, W7xCoilShellOverlap, W7xCoilStudy, W7xCoilStudyReport } from './cad-document';

/** Module counts supported by the experimental coil study. */
export const W7X_STUDY_MODULE_COUNTS = [4, 5, 6] as const;

/** One module count supported by the experimental coil study. */
export type W7xStudyModuleCount = (typeof W7X_STUDY_MODULE_COUNTS)[number];

/** Source provenance for the committed study report. */
export interface W7xStudySource {
    readonly fileName: string;
    readonly license: string;
    /** Lowercase SHA-256 hex of the reference STEP bytes. */
    readonly sourceHash: string;
    /** Reference STEP byte size. */
    readonly sourceSize: number;
    readonly sourceUnit: ImportSourceUnit;
}

/** The committed study report asset; it never contains the reference STEP. */
export interface W7xCoilStudyAsset {
    readonly source: W7xStudySource;
    readonly reports: readonly W7xCoilStudyReport[];
}

/** Bundled measured reports for the pinned reference STEP. */
export const W7X_COIL_STUDY_ASSET = w7xStudyJson as W7xCoilStudyAsset;

/** Reports in module-count order: 4, 5, then 6. */
export const W7X_COIL_STUDY_REPORTS: readonly W7xCoilStudyReport[] = W7X_COIL_STUDY_ASSET.reports;

/** Module-copy rotations about global Z for each study module count. */
export const W7X_STUDY_MODULE_ROTATIONS_DEG: Readonly<Record<W7xStudyModuleCount, readonly number[]>> = {
    4: [0, 90, 180, 270],
    5: [0, 72, 144, 216, 288],
    6: [0, 60, 120, 180, 240, 300]
};

/** Complete deterministic plan for one experimental coil-count study. */
export interface W7xCoilStudyPlan extends W7xGeneratorPlan {
    readonly moduleCount: W7xStudyModuleCount;
    readonly designStudy: W7xCoilStudy;
}

/** Narrow an arbitrary number to a supported study module count. */
export function isW7xStudyModuleCount(value: number): value is W7xStudyModuleCount {
    return value === 4 || value === 5 || value === 6;
}

/** Return the committed measured report for one study module count. */
export function studyReport(moduleCount: W7xStudyModuleCount): W7xCoilStudyReport {
    const report = W7X_COIL_STUDY_REPORTS.find((candidate) => candidate.moduleCount === moduleCount);
    if (!report) {
        throw new Error(`No W7-X coil-study report is committed for ${moduleCount} modules.`);
    }
    return report;
}

function requirePinnedStudySource(source: W7xGeneratorSource): void {
    const expected = W7X_GEOMETRY_ASSET.source;
    if (source.sourceHash !== expected.sourceHash || source.sourceSize !== expected.sourceSize) {
        throw new Error(
            `W7-X coil study requires the pinned reference STEP (SHA-256 ${expected.sourceHash}, ${expected.sourceSize} bytes); ` +
                `received SHA-256 ${source.sourceHash}, ${source.sourceSize} bytes.`
        );
    }
    const sourceUnit = source.sourceUnit ?? expected.sourceUnit;
    if (sourceUnit !== expected.sourceUnit) {
        throw new Error(
            `W7-X coil study requires source unit '${expected.sourceUnit}' for the pinned reference STEP, received '${sourceUnit}'.`
        );
    }
}

function studyCoilInstances(plan: W7xGeneratorPlan, moduleCount: W7xStudyModuleCount): W7xInstancePlan[] {
    const rotations = W7X_STUDY_MODULE_ROTATIONS_DEG[moduleCount];
    const instances: W7xInstancePlan[] = [];

    for (const template of plan.instances.filter((instance) => instance.kind === 'coil' && instance.moduleIndex === 0)) {
        rotations.forEach((rotationDeg, moduleIndex) => {
            instances.push({
                id: `${template.bodyLabel}_m${moduleIndex}`,
                part: template.part,
                bodyId: template.bodyId,
                bodyLabel: template.bodyLabel,
                kind: 'coil',
                moduleIndex,
                rotationDeg,
                placement: {
                    position: template.placement.position,
                    orientation: quaternionForZRotation(rotationDeg)
                }
            });
        });
    }

    return instances;
}

/**
 * Build the experimental 4/5/6-module plan on top of the valid generator.
 *
 * Bodies and import parameters are reused unchanged from
 * {@link planW7xGenerator}; only the coil instance copies change. Shells keep
 * their identity placement, and the first coil instance stays grounded. The
 * source must match the pinned reference STEP hash/size, and the source unit
 * must stay metre-based so the measured report applies.
 */
export function planW7xCoilStudy(source: W7xGeneratorSource, moduleCount: W7xStudyModuleCount): W7xCoilStudyPlan {
    if (!isW7xStudyModuleCount(moduleCount)) {
        throw new Error(`W7-X coil study supports 4, 5, or 6 modules, received ${String(moduleCount)}.`);
    }

    requirePinnedStudySource(source);
    const report = studyReport(moduleCount);
    const generatorPlan = planW7xGenerator(source);
    const instances =
        moduleCount === W7X_MODULE_COUNT
            ? generatorPlan.instances
            : [
                  ...studyCoilInstances(generatorPlan, moduleCount),
                  ...generatorPlan.instances.filter((instance) => instance.kind === 'shell')
              ];

    return {
        ...generatorPlan,
        moduleCount,
        moduleAngleDeg: report.pitchDeg,
        instances,
        designStudy: {
            kind: 'w7x-coil-study',
            report
        }
    };
}
