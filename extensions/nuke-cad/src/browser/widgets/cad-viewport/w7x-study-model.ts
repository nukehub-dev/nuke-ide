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
 * Presentational model for the W7-X coil-study dialog and viewport banner.
 *
 * The measured report is already the source of truth (Agent B's study asset);
 * this module only formats its numbers and assembles the persistent banner
 * text. Keeping the copy/formatting pure makes the dialog's module-count
 * selection and the non-dismissible banner testable without a DOM.
 *
 * @module nuke-cad/browser/widgets
 */

import type { W7xCoilShapeStudy, W7xDesignStudy } from '../../../common/cad-document';
import type { W7xCoilStudyReport, W7xStudyModuleCount } from '../../../common/w7x-study';
import { W7X_SHAPE_STUDY_BANNER_STATUS, W7X_SHAPE_STUDY_BANNER_TITLE, W7X_SHAPE_STUDY_BANNER_WARNING } from './w7x-shape-study-model';

/** Reports keyed by the module count the dialog can select. */
export type W7xStudyReportSet = Readonly<Record<W7xStudyModuleCount, W7xCoilStudyReport>>;

/** The dialog's default module count: the physically valid layout. */
export const W7X_STUDY_DEFAULT_MODULE_COUNT: W7xStudyModuleCount = 5;

/** The warning shown in both the dialog and the persistent banner. */
export const W7X_STUDY_WARNING = 'Design study — not a physically valid W7-X';

/** The export restriction repeated wherever the study is visible. */
export const W7X_STUDY_EXPORT_NOTE = 'Simulation export disabled';

/** One row in the report's measured-metrics table. */
export interface W7xStudyMetricRow {
    readonly id: 'pitch' | 'span' | 'uncovered' | 'overlap' | 'clearance';
    readonly label: string;
    readonly value: string;
}

/** One coil/coil or coil/shell collision row. */
export interface W7xStudyOverlapRow {
    readonly a: string;
    readonly b: string;
    readonly volume: string;
}

/** User-facing rendering of one measured report. */
export interface W7xStudyReportView {
    readonly moduleCount: W7xStudyModuleCount;
    readonly valid: boolean;
    readonly statusLabel: string;
    readonly summary: string;
    readonly metrics: readonly W7xStudyMetricRow[];
    readonly coilCoilOverlaps: readonly W7xStudyOverlapRow[];
    readonly coilShellOverlaps: readonly W7xStudyOverlapRow[];
}

/** Persistent banner text; no dismiss action is modeled on purpose. */
export interface W7xStudyBannerModel {
    readonly kind: W7xDesignStudy['kind'];
    readonly moduleCount: W7xStudyModuleCount;
    readonly valid: boolean;
    /** True for native-sweep shape studies whose geometry is explicit approximate. */
    readonly approximate: boolean;
    readonly title: string;
    readonly statusLabel: string;
    readonly summary: string;
    readonly warning: string;
    readonly exportNote: string;
    readonly ariaLabel: string;
}

function trimFixed(value: number, digits: number): string {
    if (!Number.isFinite(value)) {
        return '—';
    }
    return value.toFixed(digits).replace(/\.?0+$/, '') || '0';
}

/** Format a report angle without trailing zeros (`72°`, `65.3402°`). */
export function formatStudyAngle(degrees: number): string {
    return `${trimFixed(degrees, 4)}°`;
}

/** Format a clearance in metres (`~0.103 m`), rounded to millimetres. */
export function formatStudyClearance(metres: number | undefined): string {
    return metres === undefined ? '—' : `~${trimFixed(metres, 3)} m`;
}

/** Format an intersection volume in cubic metres. */
export function formatStudyVolume(volumeM3: number): string {
    return `${trimFixed(volumeM3, 6)} m³`;
}

/** Resolve the committed report for the selected module count. */
export function selectW7xStudyReport(reports: W7xStudyReportSet, moduleCount: W7xStudyModuleCount): W7xCoilStudyReport {
    return reports[moduleCount];
}

/** Build the dialog's report table and collision lists for one selection. */
export function buildW7xStudyReportView(report: W7xCoilStudyReport): W7xStudyReportView {
    return {
        moduleCount: report.moduleCount,
        valid: report.valid,
        statusLabel: report.valid ? 'Valid layout' : 'Invalid layout',
        summary: report.summary,
        metrics: [
            { id: 'pitch', label: 'Module pitch', value: formatStudyAngle(report.pitchDeg) },
            { id: 'span', label: 'Module span', value: formatStudyAngle(report.moduleSpanDeg) },
            { id: 'uncovered', label: 'Uncovered sector', value: formatStudyAngle(report.uncoveredSectorDeg) },
            { id: 'overlap', label: 'Module overlap', value: formatStudyAngle(report.moduleOverlapDeg) },
            { id: 'clearance', label: 'Min. adjacent coil clearance', value: formatStudyClearance(report.minCoilClearanceM) }
        ],
        coilCoilOverlaps: report.coilCoilOverlaps.map((overlap) => ({
            a: overlap.a,
            b: overlap.b,
            volume: formatStudyVolume(overlap.volumeM3)
        })),
        coilShellOverlaps: report.coilShellOverlaps.map((overlap) => ({
            a: overlap.coil,
            b: overlap.shell,
            volume: formatStudyVolume(overlap.volumeM3)
        }))
    };
}

/** Build the always-visible viewport banner for a design-study document. */
export function buildW7xDesignStudyBanner(study: W7xDesignStudy): W7xStudyBannerModel {
    if (study.kind === 'w7x-coil-shape-study') {
        const shapeStudy: W7xCoilShapeStudy = study;
        return {
            kind: shapeStudy.kind,
            moduleCount: shapeStudy.report.moduleCount,
            valid: true,
            approximate: true,
            title: W7X_SHAPE_STUDY_BANNER_TITLE,
            statusLabel: W7X_SHAPE_STUDY_BANNER_STATUS,
            summary: shapeStudy.report.summary,
            warning: W7X_SHAPE_STUDY_BANNER_WARNING,
            exportNote: W7X_STUDY_EXPORT_NOTE,
            ariaLabel:
                `W7-X coil shape study, ${shapeStudy.report.moduleCount} modules, ` +
                `${shapeStudy.report.bodyCount} native coil bodies, approximate geometry. ${W7X_STUDY_EXPORT_NOTE}.`
        };
    }
    const report = study.report;
    return {
        kind: study.kind,
        moduleCount: report.moduleCount,
        valid: report.valid,
        approximate: false,
        title: `W7-X coil study · ${report.moduleCount} modules`,
        statusLabel: report.valid ? 'Valid layout' : 'Invalid layout',
        summary: report.summary,
        warning: report.valid ? 'Study document — not simulation ready.' : W7X_STUDY_WARNING,
        exportNote: W7X_STUDY_EXPORT_NOTE,
        ariaLabel: `W7-X design study, ${report.moduleCount} modules, ${report.valid ? 'valid layout' : 'invalid layout'}. ${W7X_STUDY_EXPORT_NOTE}.`
    };
}
