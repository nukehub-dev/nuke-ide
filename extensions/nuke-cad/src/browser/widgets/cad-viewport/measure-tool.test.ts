// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
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
import {
    MEASURE_CLEAR_NOTE,
    createMeasureAngle,
    createMeasureRadius,
    createMeasureSegment,
    formatMeasureAngle,
    formatMeasureDistance,
    formatMeasureRadius,
    formatMeasurementValue,
    isMeasureAngle,
    isMeasureRadius,
    isMeasureSegment,
    measureAngle,
    measureDistance,
    measureMidpoint,
    nextMeasureId,
    projectMeasurePoint
} from './measure-tool';

/** Identity view-projection matrix in column-major THREE.Matrix4 layout. */
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function translationMatrix(tx: number, ty: number): number[] {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, 0, 1];
}

describe('measure-tool', () => {
    it('computes the euclidean distance between two world points', () => {
        expect(measureDistance([0, 0, 0], [3, 4, 0])).toBe(5);
        expect(measureDistance([1, 2, 3], [1, 2, 3])).toBe(0);
        expect(measureDistance([0, 0, 0], [1, 1, 1])).toBeCloseTo(Math.sqrt(3), 12);
    });

    it('measures sketch-plane points by their 2D plane distance', () => {
        // Both points on the z=0 plane: the 3D distance equals the 2D one.
        const distance = measureDistance([1, 2, 0], [4, 6, 0]);
        expect(distance).toBe(5);
        expect(createMeasureSegment('m1', 'sketch', [1, 2, 0], [4, 6, 0]).distance).toBe(distance);
    });

    it('returns the midpoint of the segment', () => {
        expect(measureMidpoint([0, 0, 0], [10, -4, 6])).toEqual([5, -2, 3]);
        expect(measureMidpoint([1, 1, 1], [1, 1, 1])).toEqual([1, 1, 1]);
    });

    it('builds segments with kind, distance, and midpoint together', () => {
        const segment = createMeasureSegment('m7', 'model3d', [0, 0, 0], [2, 0, 0]);
        expect(segment.id).toBe('m7');
        expect(segment.kind).toBe('model3d');
        expect(segment.a).toEqual([0, 0, 0]);
        expect(segment.b).toEqual([2, 0, 0]);
        expect(segment.distance).toBe(2);
        expect(segment.midpoint).toEqual([1, 0, 0]);
        expect(segment.kind === 'sketch' || segment.kind === 'model3d').toBe(true);
    });

    it('generates unique monotonic measurement ids', () => {
        const first = nextMeasureId();
        const second = nextMeasureId();
        expect(first).not.toBe(second);
        expect(second).toBe(`measure-${Number(first.slice('measure-'.length)) + 1}`);
    });

    it('formats distances in trimmed model units without a millimeter suffix', () => {
        expect(formatMeasureDistance(5)).toBe('5');
        expect(formatMeasureDistance(2.5)).toBe('2.5');
        expect(formatMeasureDistance(1 / 3)).toBe('0.33');
        expect(formatMeasureDistance(100)).toBe('100');
        expect(formatMeasureDistance(0.001)).toBe('0');
        expect(formatMeasureDistance(NaN)).toBe('—');
        expect(formatMeasureDistance(42)).not.toContain('mm');
    });

    it('projects the world origin to the container center under an identity matrix', () => {
        expect(projectMeasurePoint([0, 0, 0], IDENTITY, 800, 600)).toEqual({ x: 400, y: 300, visible: true });
    });

    it('maps ndc extremes to the container corners', () => {
        expect(projectMeasurePoint([-1, 1, 0], IDENTITY, 800, 600)).toEqual({ x: 0, y: 0, visible: true });
        expect(projectMeasurePoint([1, -1, 0], IDENTITY, 800, 600)).toEqual({ x: 800, y: 600, visible: true });
    });

    it('honors translation in the projection matrix', () => {
        const point = projectMeasurePoint([0, 0, 0], translationMatrix(0.5, -0.25), 800, 600);
        expect(point.x).toBeCloseTo(600, 6);
        expect(point.y).toBeCloseTo(375, 6);
        expect(point.visible).toBe(true);
    });

    it('hides points behind the camera (non-positive clip w)', () => {
        // Same as identity but with w-row negated so clipW = -1 < 0.
        const behind = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1];
        const projected = projectMeasurePoint([0, 0, 0], behind, 800, 600);
        expect(projected.visible).toBe(false);
    });

    it('exposes the rebuild note shown in the measurements popover', () => {
        expect(MEASURE_CLEAR_NOTE).toContain('rebuild');
    });

    it('measures the angle at the vertex in degrees', () => {
        // Right angle in the XY plane.
        expect(measureAngle([1, 0, 0], [0, 0, 0], [0, 1, 0])).toBeCloseTo(90, 12);
        // Straight line through the vertex: 180°.
        expect(measureAngle([1, 0, 0], [0, 0, 0], [-1, 0, 0])).toBeCloseTo(180, 12);
        // Acute angle: cos⁻¹(1/√2) = 45°.
        expect(measureAngle([1, 0, 0], [0, 0, 0], [1, 1, 0])).toBeCloseTo(45, 12);
    });

    it('measures non-planar angles', () => {
        // Vectors (1,0,0) and (0,0,1): 90° out of plane.
        expect(measureAngle([1, 0, 5], [0, 0, 5], [0, 1, 6])).toBeCloseTo(90, 12);
        // cos⁻¹(-1/√3) ≈ 125.26° between (1,0,0) and (-1,1,1).
        const angle = measureAngle([1, 0, 0], [0, 0, 0], [-1, 1, 1]);
        expect(angle).toBeCloseTo((Math.acos(-1 / Math.sqrt(3)) * 180) / Math.PI, 10);
    });

    it('returns NaN for a degenerate zero-length leg', () => {
        expect(measureAngle([0, 0, 0], [0, 0, 0], [1, 0, 0])).toBeNaN();
        expect(measureAngle([1, 0, 0], [0, 0, 0], [0, 0, 0])).toBeNaN();
    });

    it('builds angle measurements with vertex and degrees together', () => {
        const angle = createMeasureAngle('mA', 'model3d', [2, 0, 0], [0, 0, 0], [0, 2, 0]);
        expect(angle.id).toBe('mA');
        expect(angle.kind).toBe('model3d');
        expect(angle.b).toEqual([0, 0, 0]);
        expect(angle.angle).toBeCloseTo(90, 12);
    });

    it('builds radius measurements with diameter', () => {
        const radius = createMeasureRadius('mR', [1, 2, 3], 2.5);
        expect(radius.kind).toBe('model3d');
        expect(radius.center).toEqual([1, 2, 3]);
        expect(radius.radius).toBe(2.5);
        expect(radius.diameter).toBe(5);
    });

    it('classifies measurements by their discriminating fields', () => {
        const segment = createMeasureSegment('m1', 'model3d', [0, 0, 0], [1, 0, 0]);
        const angle = createMeasureAngle('m2', 'model3d', [1, 0, 0], [0, 0, 0], [0, 1, 0]);
        const radius = createMeasureRadius('m3', [0, 0, 0], 4);
        expect(isMeasureSegment(segment)).toBe(true);
        expect(isMeasureAngle(segment)).toBe(false);
        expect(isMeasureAngle(angle)).toBe(true);
        expect(isMeasureRadius(angle)).toBe(false);
        expect(isMeasureRadius(radius)).toBe(true);
        expect(isMeasureSegment(radius)).toBe(false);
    });

    it('formats angles with a degree suffix and trims like distances', () => {
        expect(formatMeasureAngle(90)).toBe('90°');
        expect(formatMeasureAngle(45.5)).toBe('45.5°');
        expect(formatMeasureAngle(125.264)).toBe('125.3°');
        expect(formatMeasureAngle(NaN)).toBe('—');
    });

    it('formats radius rows with radius and diameter', () => {
        expect(formatMeasureRadius(5)).toBe('R 5 · ⌀ 10');
        expect(formatMeasureRadius(2.5)).toBe('R 2.5 · ⌀ 5');
        expect(formatMeasureRadius(NaN)).toBe('—');
    });

    it('formats any measurement kind for popover rows', () => {
        expect(formatMeasurementValue(createMeasureSegment('m1', 'model3d', [0, 0, 0], [3, 0, 0]))).toBe('3');
        expect(formatMeasurementValue(createMeasureAngle('m2', 'model3d', [1, 0, 0], [0, 0, 0], [0, 1, 0]))).toBe('90°');
        expect(formatMeasurementValue(createMeasureRadius('m3', [0, 0, 0], 4))).toBe('R 4 · ⌀ 8');
    });
});
