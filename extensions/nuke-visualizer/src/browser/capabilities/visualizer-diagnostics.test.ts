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
import type { OpenMCTallySeries, OpenMCTallySeriesStep, OpenMCStatepointInfo } from '../../common/openmc-protocol';
import {
    analyzeTallySeries,
    capDiagnosticIssues,
    compareStatepointMetadata,
    DIAGNOSTIC_ISSUE_LIMIT,
    isWorseningUncertainty,
    keffShiftSeverity,
    relativeKeffShift,
    relativeUncertainty,
    tallySetDelta,
    uncertaintySeverity
} from './visualizer-diagnostics';

function statepoint(overrides: Partial<OpenMCStatepointInfo> = {}): OpenMCStatepointInfo {
    return {
        file: '/workspace/statepoint.100.h5',
        batches: 50,
        generationsPerBatch: 1000,
        kEff: 1,
        kEffStd: 0.0005,
        nTallies: 2,
        tallyIds: [1, 2],
        ...overrides
    };
}

function step(overrides: Partial<OpenMCTallySeriesStep> = {}): OpenMCTallySeriesStep {
    return {
        index: 0,
        time: 100,
        file: '/workspace/statepoint.100.h5',
        fileName: 'statepoint.100.h5',
        value: 1,
        std: 0.01,
        nBins: 4,
        ...overrides
    };
}

function series(overrides: Partial<OpenMCTallySeries> = {}): OpenMCTallySeries {
    return {
        files: ['/workspace/statepoint.100.h5'],
        tallyId: 1,
        tallyName: 'Flux tally',
        score: 'flux',
        nuclide: 'total',
        statistic: 'total',
        timeLabel: 'Batch',
        steps: [step()],
        range: [1, 1],
        hasMesh: false,
        volumeWeighted: false,
        ...overrides
    };
}

function issueCodes(issues: ReturnType<typeof compareStatepointMetadata>['issues']): string[] {
    return issues.map((issue) => issue.code);
}

describe('visualizer diagnostics helpers', () => {
    it('computes relative uncertainty and keeps a zero estimate meaningful', () => {
        expect(relativeUncertainty(2, 0.5)).toBe(0.25);
        expect(relativeUncertainty(-2, 0.5)).toBe(0.25);
        expect(relativeUncertainty(0, 0)).toBe(0);
        expect(relativeUncertainty(0, 0.5)).toBe(Number.POSITIVE_INFINITY);
        expect(relativeUncertainty(undefined, 0.5)).toBeUndefined();
        expect(relativeUncertainty(1, Number.NaN)).toBeUndefined();
    });

    it('computes the relative k-effective shift from the first file', () => {
        expect(relativeKeffShift(1, 1.01)).toBeCloseTo(0.01);
        expect(relativeKeffShift(1.01, 1)).toBeCloseTo(0.00990099);
        expect(relativeKeffShift(1, 1)).toBe(0);
        expect(relativeKeffShift(0, 1)).toBeUndefined();
        expect(relativeKeffShift(undefined, 1)).toBeUndefined();
        expect(relativeKeffShift(1, Number.POSITIVE_INFINITY)).toBeUndefined();
    });

    it('bands k-effective shifts at 1% and 5%', () => {
        expect(keffShiftSeverity(0.01)).toBeUndefined();
        expect(keffShiftSeverity(0.0101)).toBe('warning');
        expect(keffShiftSeverity(0.05)).toBe('warning');
        expect(keffShiftSeverity(0.0501)).toBe('error');
        expect(keffShiftSeverity(undefined)).toBeUndefined();
    });

    it('bands tally uncertainty at 10% and 25%', () => {
        expect(uncertaintySeverity(0.1)).toBeUndefined();
        expect(uncertaintySeverity(0.1001)).toBe('warning');
        expect(uncertaintySeverity(0.25)).toBe('warning');
        expect(uncertaintySeverity(0.2501)).toBe('error');
        expect(uncertaintySeverity(Number.POSITIVE_INFINITY)).toBe('error');
        expect(uncertaintySeverity(undefined)).toBeUndefined();
    });

    it('detects only a more than 20% uncertainty growth', () => {
        expect(isWorseningUncertainty(0.05, 0.061)).toBe(true);
        expect(isWorseningUncertainty(0.05, 0.06)).toBe(false);
        expect(isWorseningUncertainty(0.1, 0.05)).toBe(false);
        expect(isWorseningUncertainty(0, 0)).toBe(false);
        expect(isWorseningUncertainty(0, 1)).toBe(true);
        expect(isWorseningUncertainty(undefined, 1)).toBe(false);
    });

    it('returns the sorted tally id sets present on only one side', () => {
        expect(tallySetDelta([1, 2, 3], [3, 4, 5])).toEqual({ added: [4, 5], removed: [1, 2] });
        expect(tallySetDelta([1, 2], [1, 2])).toEqual({ added: [], removed: [] });
        expect(tallySetDelta([], [2])).toEqual({ added: [2], removed: [] });
    });

    it('caps findings at 20 and reports truncation', () => {
        const findings = Array.from({ length: 25 }, (_, index) => ({
            severity: 'info' as const,
            code: `finding-${index}`,
            message: `Finding ${index}`
        }));

        const capped = capDiagnosticIssues(findings);

        expect(capped).toHaveLength(DIAGNOSTIC_ISSUE_LIMIT);
        expect(capped[DIAGNOSTIC_ISSUE_LIMIT - 1].code).toBe('findings-truncated');
    });
});

describe('compareStatepointMetadata', () => {
    it('reports no findings for matching healthy metadata', () => {
        const comparison = compareStatepointMetadata(
            '/workspace/a.h5',
            statepoint(),
            '/workspace/b.h5',
            statepoint({ file: '/workspace/b.h5' })
        );

        expect(comparison.issues).toEqual([]);
        expect(comparison.warnings).toEqual([]);
        expect(comparison.delta).toEqual({ kEff: 0, kEffStd: 0, tallyIdsAdded: [], tallyIdsRemoved: [] });
        expect(comparison.a).toEqual({
            batches: 50,
            generationsPerBatch: 1000,
            kEff: 1,
            kEffStd: 0.0005,
            nTallies: 2,
            tallyIds: [1, 2]
        });
    });

    it('warns when either file omits k-effective', () => {
        const comparison = compareStatepointMetadata(
            '/workspace/a.h5',
            statepoint(),
            '/workspace/b.h5',
            statepoint({ kEff: undefined, kEffStd: undefined })
        );

        expect(issueCodes(comparison.issues)).toEqual(['missing-keff']);
        expect(comparison.issues[0].severity).toBe('warning');
        expect(comparison.warnings).toHaveLength(1);
        expect(comparison.delta.kEff).toBeUndefined();
    });

    it('still reports a k-effective shift when only the standard deviation is missing', () => {
        const comparison = compareStatepointMetadata(
            '/workspace/a.h5',
            statepoint(),
            '/workspace/b.h5',
            statepoint({ kEff: 1.02, kEffStd: undefined })
        );

        expect(issueCodes(comparison.issues)).toEqual(['missing-keff', 'keff-shift']);
        expect(comparison.delta.kEffStd).toBeUndefined();
    });

    it('warns on a relative k-effective shift above 1%', () => {
        const comparison = compareStatepointMetadata('/workspace/a.h5', statepoint(), '/workspace/b.h5', statepoint({ kEff: 1.02 }));

        expect(comparison.issues).toEqual([expect.objectContaining({ severity: 'warning', code: 'keff-shift', category: 'convergence' })]);
        expect(comparison.issues[0].message).toContain('2.00%');
        expect(comparison.delta.kEff).toBeCloseTo(0.02);
    });

    it('reports a relative k-effective shift above 5% as an error', () => {
        const comparison = compareStatepointMetadata('/workspace/a.h5', statepoint(), '/workspace/b.h5', statepoint({ kEff: 1.07 }));

        expect(comparison.issues[0]).toMatchObject({ severity: 'error', code: 'keff-shift' });
        expect(comparison.warnings).toEqual([]);
    });

    it('reports batch and tally set differences as info with tally names', () => {
        const comparison = compareStatepointMetadata(
            '/workspace/a.h5',
            statepoint({ batches: 50 }),
            '/workspace/b.h5',
            statepoint({ batches: 80, tallyIds: [1, 3], nTallies: 2 }),
            {
                a: new Map([
                    [1, 'Flux tally'],
                    [2, 'Heating tally']
                ]),
                b: new Map([
                    [1, 'Flux tally'],
                    [3, 'Fission tally']
                ])
            }
        );

        expect(issueCodes(comparison.issues)).toEqual(['batch-count-diff', 'tally-set-diff']);
        expect(comparison.issues.every((issue) => issue.severity === 'info')).toBe(true);
        expect(comparison.issues[1].message).toContain('3 (Fission tally)');
        expect(comparison.issues[1].message).toContain('2 (Heating tally)');
        expect(comparison.delta.batches).toBe(30);
        expect(comparison.delta.tallyIdsAdded).toEqual([3]);
        expect(comparison.delta.tallyIdsRemoved).toEqual([2]);
    });

    it('treats non-finite k-effective values as missing', () => {
        const comparison = compareStatepointMetadata(
            '/workspace/a.h5',
            statepoint({ kEff: Number.NaN }),
            '/workspace/b.h5',
            statepoint({ kEffStd: Number.POSITIVE_INFINITY })
        );

        expect(issueCodes(comparison.issues)).toEqual(['missing-keff']);
        expect(comparison.a.kEff).toBeUndefined();
        expect(comparison.b.kEffStd).toBeUndefined();
    });
});

describe('analyzeTallySeries', () => {
    it('passes the aggregate series through without findings when it is healthy', () => {
        const analysis = analyzeTallySeries(
            series({
                steps: [step(), step({ index: 1, time: 200, std: 0.012, nBins: 5 })],
                range: [1, 1.1]
            })
        );

        expect(analysis).toMatchObject({
            files: ['/workspace/statepoint.100.h5'],
            tallyId: 1,
            tallyName: 'Flux tally',
            score: 'flux',
            nuclide: 'total',
            statistic: 'total',
            timeLabel: 'Batch',
            range: [1, 1.1],
            hasMesh: false,
            issues: [],
            warnings: []
        });
        expect(analysis.steps).toHaveLength(2);
    });

    it('reports an empty series as an error finding', () => {
        const analysis = analyzeTallySeries(series({ steps: [], range: [0, 0] }));

        expect(analysis.issues).toEqual([expect.objectContaining({ severity: 'error', code: 'no-steps' })]);
        expect(analysis.warnings).toEqual([]);
    });

    it('warns about a step without finite bins', () => {
        const analysis = analyzeTallySeries(series({ steps: [step({ nBins: 0 })] }));

        expect(issueCodes([...analysis.issues])).toEqual(['empty-bins', 'single-step']);
        expect(analysis.issues[0].severity).toBe('warning');
        expect(analysis.warnings).toHaveLength(1);
    });

    it('warns above 10% relative uncertainty and errors above 25%', () => {
        const warning = analyzeTallySeries(series({ steps: [step({ value: 1, std: 0.15 })] }));
        const error = analyzeTallySeries(series({ steps: [step({ value: 1, std: 0.3 })] }));

        expect(warning.issues[0]).toMatchObject({ severity: 'warning', code: 'high-uncertainty' });
        expect(warning.issues[0].message).toContain('15.00%');
        expect(error.issues[0]).toMatchObject({ severity: 'error', code: 'high-uncertainty' });
        expect(error.issues[0].message).toContain('30.00%');
    });

    it('warns when uncertainty grows more than 20% from first to last step', () => {
        const analysis = analyzeTallySeries(
            series({
                steps: [
                    step({ index: 0, value: 1, std: 0.05 }),
                    step({ index: 1, time: 200, fileName: 'statepoint.200.h5', value: 1, std: 0.09 })
                ]
            })
        );

        expect(issueCodes([...analysis.issues])).toEqual(['worsening-uncertainty']);
        expect(analysis.issues[0].severity).toBe('warning');
    });

    it('does not report worsening uncertainty for a flat or improving series', () => {
        const analysis = analyzeTallySeries(
            series({
                steps: [step({ index: 0, value: 1, std: 0.1 }), step({ index: 1, time: 200, value: 1, std: 0.1 })]
            })
        );

        expect(analysis.issues).toEqual([]);
    });

    it('reports mesh tallies and single-step series as info', () => {
        const analysis = analyzeTallySeries(series({ hasMesh: true }));

        expect(issueCodes([...analysis.issues])).toEqual(['mesh-tally', 'single-step']);
        expect(analysis.issues.every((issue) => issue.severity === 'info')).toBe(true);
        expect(analysis.hasMesh).toBe(true);
    });

    it('caps series findings at 20', () => {
        const steps = Array.from({ length: 25 }, (_, index) => step({ index, time: index, value: 1, std: 1 }));
        const analysis = analyzeTallySeries(series({ steps }));

        expect(analysis.issues).toHaveLength(DIAGNOSTIC_ISSUE_LIMIT);
        expect(analysis.issues[DIAGNOSTIC_ISSUE_LIMIT - 1].code).toBe('findings-truncated');
    });
});
