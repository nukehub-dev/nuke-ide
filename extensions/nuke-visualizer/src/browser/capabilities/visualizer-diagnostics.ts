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
 * Visualizer diagnostics
 *
 * Pure metadata comparison and tally-series triage shared by the visualizer's
 * read-only diagnostic capabilities. Nothing here reads files, opens viewers,
 * or touches Theia services: the capabilities load statepoint data through the
 * headless OpenMC backend and pass the results through these helpers.
 *
 * @module nuke-visualizer/browser/capabilities
 */

import type {
    OpenMCTallySeries,
    OpenMCTallySeriesStatistic,
    OpenMCTallySeriesStep,
    OpenMCStatepointInfo
} from '../../common/openmc-protocol';

/** Maximum number of findings returned by a diagnostic capability. */
export const DIAGNOSTIC_ISSUE_LIMIT = 20;

/** Relative k-effective difference that warrants a warning. */
export const KEFF_SHIFT_WARNING_RELATIVE = 0.01;

/** Relative k-effective difference that is reported as an error. */
export const KEFF_SHIFT_ERROR_RELATIVE = 0.05;

/** Relative tally uncertainty that warrants a warning. */
export const HIGH_UNCERTAINTY_WARNING_RELATIVE = 0.1;

/** Relative tally uncertainty that is reported as an error. */
export const HIGH_UNCERTAINTY_ERROR_RELATIVE = 0.25;

/** Growth factor between the first and last step that counts as worsening. */
export const WORSENING_UNCERTAINTY_FACTOR = 1.2;

/** Shared diagnostic finding shape rendered by capability consumers. */
export interface NukeDiagnosticIssue {
    readonly severity: 'error' | 'warning' | 'info';
    readonly code: string;
    readonly category?: string;
    readonly message: string;
    readonly suggestion?: string;
}

/** Summary fields compared for one statepoint. */
export interface StatepointComparisonSide {
    readonly batches: number;
    readonly generationsPerBatch: number;
    readonly kEff?: number;
    readonly kEffStd?: number;
    readonly nTallies: number;
    readonly tallyIds: readonly number[];
}

/** Numeric and tally-set differences between two statepoints. */
export interface StatepointComparisonDelta {
    readonly batches?: number;
    readonly kEff?: number;
    readonly kEffStd?: number;
    readonly tallyIdsAdded: readonly number[];
    readonly tallyIdsRemoved: readonly number[];
}

/** Metadata comparison payload rendered by the capability result. */
export interface StatepointComparison {
    readonly fileA: string;
    readonly fileB: string;
    readonly a: StatepointComparisonSide;
    readonly b: StatepointComparisonSide;
    readonly delta: StatepointComparisonDelta;
    readonly issues: readonly NukeDiagnosticIssue[];
    readonly warnings: readonly string[];
}

/** Tally-series payload with the findings derived from its aggregate steps. */
export interface TallySeriesAnalysis {
    readonly files: readonly string[];
    readonly tallyId: number;
    readonly tallyName: string;
    readonly score: string;
    readonly nuclide: string;
    readonly statistic: OpenMCTallySeriesStatistic;
    readonly timeLabel: string;
    readonly steps: readonly OpenMCTallySeriesStep[];
    readonly range: readonly [number, number];
    readonly hasMesh: boolean;
    readonly issues: readonly NukeDiagnosticIssue[];
    readonly warnings: readonly string[];
}

/** Optional tally names used to make tally-set differences readable. */
export interface TallyNameLookup {
    readonly a?: ReadonlyMap<number, string>;
    readonly b?: ReadonlyMap<number, string>;
}

/**
 * Relative uncertainty `std / abs(value)`.
 *
 * Returns `undefined` when either input is not a finite number. A zero value
 * with a non-zero standard deviation yields an infinite relative uncertainty so
 * callers can report it instead of silently dropping the step.
 */
export function relativeUncertainty(value: number | undefined, std: number | undefined): number | undefined {
    if (!isFiniteNumber(value) || !isFiniteNumber(std)) {
        return undefined;
    }
    if (value === 0) {
        return std === 0 ? 0 : Number.POSITIVE_INFINITY;
    }
    return std / Math.abs(value);
}

/**
 * Relative difference of `candidate` from `reference`, `abs(candidate - reference) / abs(reference)`.
 *
 * Returns `undefined` when either value is missing, not finite, or the
 * reference is zero.
 */
export function relativeKeffShift(reference: number | undefined, candidate: number | undefined): number | undefined {
    if (!isFiniteNumber(reference) || !isFiniteNumber(candidate) || reference === 0) {
        return undefined;
    }
    return Math.abs(candidate - reference) / Math.abs(reference);
}

/** Severity band for a relative k-effective shift, or `undefined` below the warning threshold. */
export function keffShiftSeverity(relativeShift: number | undefined): 'error' | 'warning' | undefined {
    if (relativeShift === undefined) {
        return undefined;
    }
    if (relativeShift > KEFF_SHIFT_ERROR_RELATIVE) {
        return 'error';
    }
    if (relativeShift > KEFF_SHIFT_WARNING_RELATIVE) {
        return 'warning';
    }
    return undefined;
}

/** Tally ids present in only one of the two sets, sorted ascending. */
export function tallySetDelta(
    tallyIdsA: readonly number[],
    tallyIdsB: readonly number[]
): { readonly added: readonly number[]; readonly removed: readonly number[] } {
    const setA = new Set(tallyIdsA);
    const setB = new Set(tallyIdsB);
    return {
        added: [...setB].filter((id) => !setA.has(id)).sort((left, right) => left - right),
        removed: [...setA].filter((id) => !setB.has(id)).sort((left, right) => left - right)
    };
}

/** Severity band for a relative tally uncertainty, or `undefined` below the warning threshold. */
export function uncertaintySeverity(relative: number | undefined): 'error' | 'warning' | undefined {
    if (relative === undefined) {
        return undefined;
    }
    if (relative > HIGH_UNCERTAINTY_ERROR_RELATIVE) {
        return 'error';
    }
    if (relative > HIGH_UNCERTAINTY_WARNING_RELATIVE) {
        return 'warning';
    }
    return undefined;
}

/**
 * True when the last step's relative uncertainty exceeds the first step's by
 * more than {@link WORSENING_UNCERTAINTY_FACTOR}.
 */
export function isWorseningUncertainty(first: number | undefined, last: number | undefined): boolean {
    return first !== undefined && last !== undefined && last > first * WORSENING_UNCERTAINTY_FACTOR;
}

/** Format a relative value as a percentage for findings. */
export function formatRelativeUncertainty(value: number): string {
    return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : 'unbounded';
}

/**
 * Compare two statepoint metadata summaries.
 *
 * Findings:
 *
 * - `missing-keff` (warning) when either side omits k-effective or its standard
 *   deviation.
 * - `keff-shift` (warning above 1%, error above 5%) for the relative
 *   k-effective difference from the first file.
 * - `batch-count-diff` (info) when the batch counts differ.
 * - `tally-set-diff` (info) when the tally id sets differ.
 */
export function compareStatepointMetadata(
    fileA: string,
    infoA: OpenMCStatepointInfo,
    fileB: string,
    infoB: OpenMCStatepointInfo,
    names: TallyNameLookup = {}
): StatepointComparison {
    const a = comparisonSide(infoA);
    const b = comparisonSide(infoB);
    const findings: NukeDiagnosticIssue[] = [];
    const missingKeff = a.kEff === undefined || b.kEff === undefined;
    const missingKeffStd = a.kEffStd === undefined || b.kEffStd === undefined;

    if (missingKeff || missingKeffStd) {
        findings.push({
            severity: 'warning',
            code: 'missing-keff',
            category: 'convergence',
            message: 'One or both statepoints do not report both k-effective and its standard deviation.',
            suggestion: 'Fixed-source statepoints legitimately omit k-effective; confirm eigenvalue mode before comparing eigenvalues.'
        });
    }
    if (!missingKeff) {
        const shift = relativeKeffShift(a.kEff, b.kEff);
        const severity = keffShiftSeverity(shift);
        if (shift !== undefined && severity !== undefined) {
            findings.push({
                severity,
                code: 'keff-shift',
                category: 'convergence',
                message:
                    `Relative k-effective difference is ${formatRelativeUncertainty(shift)} (${a.kEff} → ${b.kEff}), ` +
                    `above the ${severity === 'error' ? '5% error' : '1% warning'} threshold.`,
                suggestion: 'Confirm both files model the same configuration before treating the difference as a physical result.'
            });
        }
    }

    if (a.batches !== b.batches) {
        findings.push({
            severity: 'info',
            code: 'batch-count-diff',
            category: 'convergence',
            message: `Batch counts differ between the compared statepoints (${a.batches} → ${b.batches}).`,
            suggestion: 'Compare convergence settings before attributing a k-effective difference to the model.'
        });
    }

    const tallyDelta = tallySetDelta(a.tallyIds, b.tallyIds);
    if (tallyDelta.added.length > 0 || tallyDelta.removed.length > 0) {
        const parts: string[] = [];
        if (tallyDelta.added.length > 0) {
            parts.push(`added ${describeTallyIds(tallyDelta.added, names.b)}`);
        }
        if (tallyDelta.removed.length > 0) {
            parts.push(`removed ${describeTallyIds(tallyDelta.removed, names.a)}`);
        }
        findings.push({
            severity: 'info',
            code: 'tally-set-diff',
            category: 'tallies',
            message: `Tally IDs differ between the compared statepoints: ${parts.join('; ')}.`,
            suggestion: 'Match tallies by id before comparing per-tally values.'
        });
    }

    const issues = capDiagnosticIssues(findings);
    return {
        fileA,
        fileB,
        a,
        b,
        delta: comparisonDelta(a, b),
        issues,
        warnings: warningMessages(issues)
    };
}

/**
 * Analyze the aggregate steps of a tally series.
 *
 * Findings:
 *
 * - `no-steps` (error) when the series has no steps.
 * - `empty-bins` (warning) for a step with zero finite bins.
 * - `high-uncertainty` (warning above 10%, error above 25%) per step.
 * - `worsening-uncertainty` (warning) when the last step grows more than 20%
 *   over the first.
 * - `mesh-tally` (info) for a mesh tally.
 * - `single-step` (info) when a trend cannot be assessed.
 *
 * Aggregate step statistics are the only tally values available through the
 * tally-series contract; per-bin values for a single file are not read.
 */
export function analyzeTallySeries(series: OpenMCTallySeries): TallySeriesAnalysis {
    const steps = Array.isArray(series.steps) ? series.steps : [];
    const findings: NukeDiagnosticIssue[] = [];

    if (steps.length === 0) {
        findings.push({
            severity: 'error',
            code: 'no-steps',
            category: 'tallies',
            message: 'The tally series returned no statepoint steps.',
            suggestion: 'Confirm the files are readable statepoints that contain this tally and score.'
        });
    } else {
        for (const step of steps) {
            if (step.nBins === 0) {
                findings.push({
                    severity: 'warning',
                    code: 'empty-bins',
                    category: 'tallies',
                    message: `Step ${step.index} (${step.fileName}) has no finite tally bins.`,
                    suggestion: 'Check that the requested score and nuclide exist in this statepoint.'
                });
            }
            const relative = relativeUncertainty(step.value, step.std);
            const severity = uncertaintySeverity(relative);
            if (relative !== undefined && severity !== undefined) {
                findings.push({
                    severity,
                    code: 'high-uncertainty',
                    category: 'statistics',
                    message:
                        `Step ${step.index} (${step.fileName}) has a relative uncertainty of ${formatRelativeUncertainty(relative)}, ` +
                        `above the ${severity === 'error' ? '25% error' : '10% warning'} threshold.`,
                    suggestion: 'Run more histories before drawing conclusions from this step.'
                });
            }
        }

        const first = relativeUncertainty(steps[0].value, steps[0].std);
        const last = relativeUncertainty(steps[steps.length - 1].value, steps[steps.length - 1].std);
        if (first !== undefined && last !== undefined && isWorseningUncertainty(first, last)) {
            findings.push({
                severity: 'warning',
                code: 'worsening-uncertainty',
                category: 'statistics',
                message:
                    `Relative uncertainty grew from ${formatRelativeUncertainty(first)} at the first step to ` +
                    `${formatRelativeUncertainty(last)} at the last step, more than 20% growth.`,
                suggestion: 'Later statepoints carry less statistical weight; extend the run instead of extrapolating the trend.'
            });
        }
    }

    if (series.hasMesh) {
        findings.push({
            severity: 'info',
            code: 'mesh-tally',
            category: 'tallies',
            message: `Tally ${series.tallyId} (${series.tallyName}) is a mesh tally; aggregate series values cannot show spatial behavior.`,
            suggestion: 'Open the tally series or tally in the viewer for spatial interpretation.'
        });
    }
    if (steps.length === 1) {
        findings.push({
            severity: 'info',
            code: 'single-step',
            category: 'statistics',
            message: 'The series contains a single statepoint step; a trend cannot be assessed.',
            suggestion: 'Add sibling statepoints to compare uncertainty over time.'
        });
    }

    const issues = capDiagnosticIssues(findings);
    return {
        files: Array.isArray(series.files) ? [...series.files] : [],
        tallyId: series.tallyId,
        tallyName: series.tallyName,
        score: series.score,
        nuclide: series.nuclide,
        statistic: series.statistic,
        timeLabel: series.timeLabel,
        steps: steps.map((step) => ({ ...step })),
        range: normalizeRange(series.range),
        hasMesh: series.hasMesh === true,
        issues,
        warnings: warningMessages(issues)
    };
}

/** Keep at most {@link DIAGNOSTIC_ISSUE_LIMIT} findings, replacing the tail with a truncation notice. */
export function capDiagnosticIssues(findings: readonly NukeDiagnosticIssue[]): NukeDiagnosticIssue[] {
    if (findings.length <= DIAGNOSTIC_ISSUE_LIMIT) {
        return [...findings];
    }
    const omitted = findings.length - (DIAGNOSTIC_ISSUE_LIMIT - 1);
    return [
        ...findings.slice(0, DIAGNOSTIC_ISSUE_LIMIT - 1),
        {
            severity: 'info',
            code: 'findings-truncated',
            message: `${omitted} additional finding(s) were omitted from this diagnosis.`,
            suggestion: 'Narrow the request to compare fewer tallies or statepoint steps.'
        }
    ];
}

function comparisonSide(info: OpenMCStatepointInfo): StatepointComparisonSide {
    return {
        batches: info.batches,
        generationsPerBatch: info.generationsPerBatch,
        kEff: isFiniteNumber(info.kEff) ? info.kEff : undefined,
        kEffStd: isFiniteNumber(info.kEffStd) ? info.kEffStd : undefined,
        nTallies: info.nTallies,
        tallyIds: Array.isArray(info.tallyIds) ? [...info.tallyIds] : []
    };
}

function comparisonDelta(a: StatepointComparisonSide, b: StatepointComparisonSide): StatepointComparisonDelta {
    const tallyDelta = tallySetDelta(a.tallyIds, b.tallyIds);
    const delta: {
        batches?: number;
        kEff?: number;
        kEffStd?: number;
        tallyIdsAdded: readonly number[];
        tallyIdsRemoved: readonly number[];
    } = {
        tallyIdsAdded: tallyDelta.added,
        tallyIdsRemoved: tallyDelta.removed
    };
    if (a.batches !== b.batches) {
        delta.batches = b.batches - a.batches;
    }
    if (a.kEff !== undefined && b.kEff !== undefined) {
        delta.kEff = b.kEff - a.kEff;
    }
    if (a.kEffStd !== undefined && b.kEffStd !== undefined) {
        delta.kEffStd = b.kEffStd - a.kEffStd;
    }
    return delta;
}

function describeTallyIds(ids: readonly number[], names: ReadonlyMap<number, string> | undefined): string {
    return ids
        .map((id) => {
            const name = names?.get(id);
            return name ? `${id} (${name})` : `${id}`;
        })
        .join(', ');
}

function normalizeRange(range: readonly number[] | undefined): [number, number] {
    if (Array.isArray(range) && range.length === 2 && isFiniteNumber(range[0]) && isFiniteNumber(range[1])) {
        return [range[0], range[1]];
    }
    return [0, 0];
}

function warningMessages(issues: readonly NukeDiagnosticIssue[]): string[] {
    return issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.message);
}

function isFiniteNumber(value: number | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}
