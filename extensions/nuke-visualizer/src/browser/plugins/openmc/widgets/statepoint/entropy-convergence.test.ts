import { describe, expect, it } from 'vitest';
import { activeEntropy, buildEntropyChart, summarizeEntropy } from './entropy-convergence-model';

describe('entropy convergence', () => {
    it('slices inactive batches from the active window', () => {
        expect(activeEntropy([1, 2, 3, 4, 5], 2)).toEqual([3, 4, 5]);
        expect(activeEntropy([1, 2, 3], 0)).toEqual([1, 2, 3]);
        expect(activeEntropy([1, 2, 3], 99)).toEqual([]);
    });

    it('summarizes a stable tail over the last active batches', () => {
        const values = [7, 6.9, 6.0, 5.999, 5.998, 5.997, 5.996, 5.995, 5.994, 5.993, 5.992, 5.991];
        const summary = summarizeEntropy(values, 2);
        expect(summary).not.toBeNull();
        expect(summary!.finalEntropy).toBeCloseTo(5.991);
        expect(summary!.stable).toBe(true);
        expect(summary!.hint).toContain('stable');
    });

    it('flags a still-changing tail', () => {
        const values = [3, 3.4, 3.9, 4.4, 4.8, 5.1, 5.4, 5.6, 5.75, 5.9, 6.05, 6.2];
        const summary = summarizeEntropy(values, 0);
        expect(summary).not.toBeNull();
        expect(summary!.stable).toBe(false);
        expect(summary!.change).toBeGreaterThan(0);
        expect(summary!.hint).toContain('still changing');
    });

    it('builds the entropy trace and inactive marker', () => {
        const chart = buildEntropyChart({ entropy: [6.1, 6.05, 6.0, 5.99], nInactive: 2, nBatches: 4 }, 'entropy');
        expect(chart.traces).toHaveLength(1);
        expect(chart.traces[0].x).toEqual([1, 2, 3, 4]);
        expect(chart.traces[0].y).toEqual([6.1, 6.05, 6.0, 5.99]);
        expect(chart.markerBatch).toBe(2.5);
        expect(chart.shapes[0].x0).toBe(2.5);
        expect(chart.summary!.finalEntropy).toBeCloseTo(5.99);
    });

    it('starts CMFD entropy at its solver batch', () => {
        const chart = buildEntropyChart({ cmfdEntropy: [4.2, 4.1, 4.0], cmfdEntropyStartBatch: 8, nInactive: 5, nBatches: 10 }, 'cmfd');
        expect(chart.traces[0].x).toEqual([8, 9, 10]);
        expect(chart.traces[0].name).toBe('CMFD entropy');
    });

    it('returns no traces for a missing source', () => {
        const chart = buildEntropyChart({ nInactive: 0, nBatches: 3 }, 'entropy');
        expect(chart.traces).toEqual([]);
        expect(chart.summary).toBeNull();
        expect(chart.markerBatch).toBeNull();
    });
});
