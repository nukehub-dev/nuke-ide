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
 * Tests for the viewer-core distance-measure model (no DOM, no three.js):
 * point-pair state transitions, distance math, label formatting, and
 * label-screen-position projection.
 */

import { describe, expect, it } from 'vitest';
import {
    addMeasurePoint,
    cancelMeasureStep,
    clearMeasurePoints,
    createMeasureSegment,
    EMPTY_MEASURE_STATE,
    formatMeasureDistance,
    MEASURE_CLEAR_NOTE,
    measureDistance,
    measureMidpoint,
    projectMeasurePoint,
    resetMeasureState,
    setMeasureActive
} from './measure-model';

/** Identity view-projection matrix in column-major THREE.Matrix4 layout. */
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe('measureDistance', () => {
    it('computes the euclidean distance between two world points', () => {
        expect(measureDistance([0, 0, 0], [3, 4, 0])).toBe(5);
        expect(measureDistance([1, 2, 3], [1, 2, 3])).toBe(0);
        expect(measureDistance([0, 0, 0], [1, 1, 1])).toBeCloseTo(Math.sqrt(3), 12);
    });

    it('measures the unit-square diagonal used by the Playwright fixture', () => {
        expect(measureDistance([0, 0, 0], [1, 1, 0])).toBeCloseTo(Math.SQRT2, 12);
    });

    it('returns the midpoint of the segment', () => {
        expect(measureMidpoint([0, 0, 0], [10, -4, 6])).toEqual([5, -2, 3]);
        expect(measureMidpoint([1, 1, 1], [1, 1, 1])).toEqual([1, 1, 1]);
    });

    it('builds segments with distance and midpoint together', () => {
        const segment = createMeasureSegment([0, 0, 0], [2, 0, 0]);
        expect(segment.distance).toBe(2);
        expect(segment.midpoint).toEqual([1, 0, 0]);
    });
});

describe('formatMeasureDistance', () => {
    it('trims trailing zeros without a unit suffix', () => {
        expect(formatMeasureDistance(5)).toBe('5');
        expect(formatMeasureDistance(2.5)).toBe('2.5');
        expect(formatMeasureDistance(Math.SQRT2)).toBe('1.41');
        expect(formatMeasureDistance(0)).toBe('0');
    });

    it('renders non-finite input as an em dash', () => {
        expect(formatMeasureDistance(Number.NaN)).toBe('—');
        expect(formatMeasureDistance(Number.POSITIVE_INFINITY)).toBe('—');
    });
});

describe('measure state', () => {
    it('ignores clicks while the tool is inactive', () => {
        expect(addMeasurePoint(EMPTY_MEASURE_STATE, [1, 0, 0])).toBe(EMPTY_MEASURE_STATE);
    });

    it('commits a pair on the second click and restarts on the third', () => {
        const pending = addMeasurePoint(setMeasureActive(EMPTY_MEASURE_STATE, true), [0, 0, 0]);
        expect(pending.pending).toEqual([0, 0, 0]);
        expect(pending.segment).toBeUndefined();
        const committed = addMeasurePoint(pending, [3, 4, 0]);
        expect(committed.pending).toBeUndefined();
        expect(committed.segment?.distance).toBe(5);
        expect(committed.segment?.midpoint).toEqual([1.5, 2, 0]);
        const restarted = addMeasurePoint(committed, [9, 9, 9]);
        expect(restarted.pending).toEqual([9, 9, 9]);
        expect(restarted.segment).toBeUndefined();
    });

    it('deactivating drops the pending point but keeps a committed segment', () => {
        const pending = addMeasurePoint(setMeasureActive(EMPTY_MEASURE_STATE, true), [0, 0, 0]);
        expect(setMeasureActive(pending, false).pending).toBeUndefined();
        const committed = addMeasurePoint(pending, [1, 0, 0]);
        expect(setMeasureActive(committed, false).segment?.distance).toBe(1);
    });

    it('cancels newest-first: pending, then segment, then the tool itself', () => {
        const pending = addMeasurePoint(setMeasureActive(EMPTY_MEASURE_STATE, true), [0, 0, 0]);
        const noPending = cancelMeasureStep(pending);
        expect(noPending.pending).toBeUndefined();
        expect(noPending.active).toBe(true);
        const committed = addMeasurePoint(pending, [1, 0, 0]);
        const noSegment = cancelMeasureStep(committed);
        expect(noSegment.segment).toBeUndefined();
        expect(noSegment.active).toBe(true);
        expect(cancelMeasureStep(noSegment).active).toBe(false);
        expect(cancelMeasureStep(EMPTY_MEASURE_STATE)).toBe(EMPTY_MEASURE_STATE);
    });

    it('clears points but keeps the tool flag, and resets fully on rebuild', () => {
        const committed = addMeasurePoint(addMeasurePoint(setMeasureActive(EMPTY_MEASURE_STATE, true), [0, 0, 0]), [1, 0, 0]);
        const cleared = clearMeasurePoints(committed);
        expect(cleared).toEqual({ active: true, pending: undefined, segment: undefined });
        expect(resetMeasureState()).toEqual(EMPTY_MEASURE_STATE);
    });

    it('documents the viewport-state-never-document-state contract', () => {
        expect(MEASURE_CLEAR_NOTE).toBe('Measurements are cleared after rebuild');
    });
});

describe('projectMeasurePoint', () => {
    it('maps the identity clip volume onto container pixels', () => {
        expect(projectMeasurePoint([0, 0, 0], IDENTITY, 200, 100)).toEqual({ x: 100, y: 50, visible: true });
        expect(projectMeasurePoint([-1, 1, 0], IDENTITY, 200, 100)).toEqual({ x: 0, y: 0, visible: true });
        expect(projectMeasurePoint([1, -1, 0], IDENTITY, 200, 100)).toEqual({ x: 200, y: 100, visible: true });
    });

    it('hides points behind the camera', () => {
        // Negative w (last column flipped) puts the origin behind the camera.
        const behind = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1];
        expect(projectMeasurePoint([0, 0, 0], behind, 200, 100).visible).toBe(false);
    });
});
