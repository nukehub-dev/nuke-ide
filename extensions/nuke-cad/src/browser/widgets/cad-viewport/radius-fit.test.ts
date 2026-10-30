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
import { type MeasurePoint3D } from './measure-tool';
import { CIRCLE_FIT_MAX_RELATIVE_RESIDUAL, edgeRadius, fitCircleKasa } from './radius-fit';

/** Rotate (x, y, z) by `angle` radians around the X axis. */
function tiltX(p: MeasurePoint3D, angle: number): MeasurePoint3D {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
}

/** Samples of a radius-`r` circle at `center` in the XY plane, `count` points over `span` radians. */
function arcPoints(center: MeasurePoint3D, radius: number, count: number, span = Math.PI * 2, start = 0): MeasurePoint3D[] {
    const points: MeasurePoint3D[] = [];
    for (let i = 0; i < count; i++) {
        const angle = start + (span * i) / (count - 1);
        points.push([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle), center[2]]);
    }
    return points;
}

/** Deterministic pseudo-noise in [-amplitude, amplitude). */
function noise(index: number, amplitude: number): number {
    return amplitude * (2 * (Math.sin(index * 12.9898) * 43758.5453 - Math.floor(Math.sin(index * 12.9898) * 43758.5453)) - 1);
}

describe('fitCircleKasa', () => {
    it('fits a full circle in the XY plane', () => {
        const fit = fitCircleKasa(arcPoints([1, 2, 3], 5, 48));
        expect(fit).toBeDefined();
        expect(fit!.radius).toBeCloseTo(5, 6);
        expect(fit!.center[0]).toBeCloseTo(1, 6);
        expect(fit!.center[1]).toBeCloseTo(2, 6);
        expect(fit!.center[2]).toBeCloseTo(3, 6);
        expect(fit!.relativeResidual).toBeLessThan(1e-9);
    });

    it('fits a circle in a tilted plane', () => {
        const angle = 0.7;
        const points = arcPoints([0, 0, 0], 2.5, 40).map((p) => tiltX(p, angle));
        const fit = fitCircleKasa(points);
        expect(fit).toBeDefined();
        expect(fit!.radius).toBeCloseTo(2.5, 6);
        expect(fit!.center[0]).toBeCloseTo(0, 6);
        expect(fit!.center[1]).toBeCloseTo(0, 6);
        expect(fit!.center[2]).toBeCloseTo(0, 6);
    });

    it('fits a quarter arc', () => {
        const fit = fitCircleKasa(arcPoints([0, 0, 0], 10, 24, Math.PI / 2));
        expect(fit).toBeDefined();
        expect(fit!.radius).toBeCloseTo(10, 5);
        expect(fit!.center[0]).toBeCloseTo(0, 5);
        expect(fit!.center[1]).toBeCloseTo(0, 5);
    });

    it('tolerates noisy samples within the residual threshold', () => {
        const points = arcPoints([0, 0, 0], 8, 60).map((p, i) => [p[0] + noise(i, 0.01), p[1] + noise(i + 100, 0.01), p[2]] as const);
        const fit = fitCircleKasa(points);
        expect(fit).toBeDefined();
        expect(fit!.radius).toBeGreaterThan(7.9);
        expect(fit!.radius).toBeLessThan(8.1);
        expect(fit!.relativeResidual).toBeLessThan(CIRCLE_FIT_MAX_RELATIVE_RESIDUAL);
    });

    it('returns undefined for fewer than three points', () => {
        expect(
            fitCircleKasa([
                [0, 0, 0],
                [1, 0, 0]
            ])
        ).toBeUndefined();
        expect(fitCircleKasa([])).toBeUndefined();
    });

    it('returns undefined for collinear points', () => {
        const line: MeasurePoint3D[] = [];
        for (let i = 0; i < 10; i++) {
            line.push([i, 2 * i, 3 * i + 1]);
        }
        expect(fitCircleKasa(line)).toBeUndefined();
    });
});

describe('edgeRadius', () => {
    it('prefers the fingerprint center and averages polyline distances to it', () => {
        const center: MeasurePoint3D = [4, -1, 2];
        // Slightly off-round polyline around the fingerprint center.
        const points = arcPoints(center, 3, 24).map((p, i) => [p[0] + noise(i, 0.005), p[1], p[2]] as const);
        const result = edgeRadius({ curveType: 'circle', fingerprintCenter: center, points });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.source).toBe('fingerprint');
            expect(result.radius).toBeCloseTo(3, 2);
            expect(result.diameter).toBeCloseTo(6, 2);
            expect(result.center).toEqual(center);
        }
    });

    it('falls back to the Kasa fit when no fingerprint center is present', () => {
        const result = edgeRadius({ curveType: 'circle', points: arcPoints([0, 0, 1], 12, 36) });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.source).toBe('fit');
            expect(result.radius).toBeCloseTo(12, 5);
            expect(result.center[2]).toBeCloseTo(1, 5);
        }
    });

    it('fits when the curve type is unknown (no fingerprint)', () => {
        const result = edgeRadius({ points: arcPoints([0, 0, 0], 4, 32) });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.radius).toBeCloseTo(4, 5);
        }
    });

    it('rejects a straight-line edge even with a circle curve type claim', () => {
        const line: MeasurePoint3D[] = [];
        for (let i = 0; i < 16; i++) {
            line.push([i * 0.5, 0, 0]);
        }
        const result = edgeRadius({ curveType: 'circle', points: line });
        expect(result.ok).toBe(false);
    });

    it('rejects non-circular curve types without fitting', () => {
        const result = edgeRadius({ curveType: 'bspline', points: arcPoints([0, 0, 0], 5, 24) });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toContain('not a circle');
        }
    });

    it('rejects an ellipse whose fit residual exceeds the threshold', () => {
        // A 10×5 ellipse sampled densely: a circle fit leaves large residuals.
        const ellipse: MeasurePoint3D[] = [];
        for (let i = 0; i < 64; i++) {
            const angle = (i / 63) * Math.PI * 2;
            ellipse.push([10 * Math.cos(angle), 5 * Math.sin(angle), 0]);
        }
        const result = edgeRadius({ points: ellipse });
        expect(result.ok).toBe(false);
    });

    it('rejects too few polyline points', () => {
        const result = edgeRadius({
            curveType: 'circle',
            points: [
                [0, 0, 0],
                [1, 1, 0]
            ]
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toContain('too few');
        }
    });
});
