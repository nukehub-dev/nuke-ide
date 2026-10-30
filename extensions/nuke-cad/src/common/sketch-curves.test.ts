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
    clampedUniformKnots,
    deBoor,
    ellipseAxes,
    expandKnots,
    nearestPolylinePoint,
    sampleBSplineCurve,
    sampleEllipse,
    sharedBSplinePolyline,
    sharedEllipsePolyline
} from './sketch-curves';

describe('ellipseAxes', () => {
    it('derives axes from the planegcs focus form', () => {
        // center (0, 0), focus1 (3, 0): |c - f1| = 3, radmin 4 -> major 5 (3-4-5).
        const axes = ellipseAxes({ x: 0, y: 0 }, { x: 3, y: 0 }, 4);
        expect(axes.major).toBeCloseTo(5, 12);
        expect(axes.minor).toBeCloseTo(4, 12);
        expect(axes.phi).toBeCloseTo(0, 12);
        expect(axes.center).toEqual({ x: 0, y: 0 });
    });

    it('degenerates to a circle when the focus coincides with the center', () => {
        const axes = ellipseAxes({ x: 0, y: 0 }, { x: 0, y: 0 }, 4);
        expect(axes.major).toBeCloseTo(4, 12);
        expect(axes.minor).toBeCloseTo(4, 12);
        expect(axes.phi).toBe(0);
    });
});

describe('sampleEllipse', () => {
    it('produces a closed polyline of segments + 1 points', () => {
        const polyline = sampleEllipse({ x: 0, y: 0 }, { x: 3, y: 0 }, 4, 16);
        expect(polyline.length).toBe(17);
        expect(polyline[0].x).toBeCloseTo(polyline[16].x, 12);
        expect(polyline[0].y).toBeCloseTo(polyline[16].y, 12);
    });

    it('places the major-axis extreme at center + major along the focus direction', () => {
        const polyline = sampleEllipse({ x: 0, y: 0 }, { x: 3, y: 0 }, 4, 360);
        // major = 5 (3-4-5); the point at t = 0 is (5, 0).
        expect(polyline[0].x).toBeCloseTo(5, 9);
        expect(polyline[0].y).toBeCloseTo(0, 9);
        // t = 90 degrees gives the minor extreme (0, 4).
        expect(polyline[90].x).toBeCloseTo(0, 9);
        expect(polyline[90].y).toBeCloseTo(4, 9);
    });
});

describe('clampedUniformKnots', () => {
    it('satisfies the poles + degree + 1 multiplicity invariant', () => {
        for (const [poleCount, degree] of [
            [2, 1],
            [3, 2],
            [4, 3],
            [5, 3],
            [8, 3]
        ]) {
            const { knots, mult } = clampedUniformKnots(poleCount, degree);
            expect(sum(mult)).toBe(poleCount + degree + 1);
            expect(knots.length).toBe(mult.length);
            expect(mult[0]).toBe(degree + 1);
            expect(mult[mult.length - 1]).toBe(degree + 1);
            for (let i = 1; i < knots.length; i++) {
                expect(knots[i]).toBeGreaterThan(knots[i - 1]);
            }
            expect(knots[0]).toBe(0);
            expect(knots[knots.length - 1]).toBe(poleCount - degree);
        }
    });

    it('rejects invalid pole/degree combinations', () => {
        expect(() => clampedUniformKnots(1, 1)).toThrow();
        expect(() => clampedUniformKnots(3, 0)).toThrow();
        expect(() => clampedUniformKnots(3, 3)).toThrow();
        expect(() => clampedUniformKnots(3, 1.5)).toThrow();
    });
});

function sum(values: readonly number[]): number {
    let total = 0;
    for (const v of values) {
        total += v;
    }
    return total;
}

describe('expandKnots', () => {
    it('expands multiplicities into a flat non-decreasing vector', () => {
        expect(expandKnots([0, 1], [3, 3])).toEqual([0, 0, 0, 1, 1, 1]);
        expect(expandKnots([0, 1, 2], [2, 1, 2])).toEqual([0, 0, 1, 2, 2]);
    });

    it('rejects length mismatches', () => {
        expect(() => expandKnots([0, 1], [3])).toThrow();
    });
});

describe('deBoor', () => {
    const linePoles = [
        { x: 0, y: 0 },
        { x: 10, y: 4 }
    ];
    const lineKnots = expandKnots([0, 1], [2, 2]);

    it('evaluates a degree-1 two-pole curve as a straight line', () => {
        expect(deBoor(0, linePoles, lineKnots, 1)).toEqual({ x: 0, y: 0 });
        expect(deBoor(0.5, linePoles, lineKnots, 1)).toEqual({ x: 5, y: 2 });
        expect(deBoor(1, linePoles, lineKnots, 1)).toEqual({ x: 10, y: 4 });
    });

    it('interpolates the end poles of a clamped curve', () => {
        const poles = [
            { x: 1, y: 1 },
            { x: 4, y: 9 },
            { x: 9, y: 2 },
            { x: 12, y: 6 }
        ];
        const { knots, mult } = clampedUniformKnots(4, 3);
        const expanded = expandKnots(knots, mult);
        expect(deBoor(expanded[0], poles, expanded, 3)).toEqual(poles[0]);
        expect(deBoor(expanded[expanded.length - 1], poles, expanded, 3)).toEqual(poles[3]);
    });

    it('matches the quadratic Bezier midpoint for a clamped degree-2 curve', () => {
        const poles = [
            { x: 0, y: 0 },
            { x: 1, y: 2 },
            { x: 2, y: 0 }
        ];
        const expanded = expandKnots([0, 1], [3, 3]);
        // B(0.5) = 0.25*P0 + 0.5*P1 + 0.25*P2 = (1, 1).
        const mid = deBoor(0.5, poles, expanded, 2);
        expect(mid.x).toBeCloseTo(1, 12);
        expect(mid.y).toBeCloseTo(1, 12);
    });

    it('matches the cubic Bezier value at t = 0.5 for a clamped degree-3 curve', () => {
        const poles = [
            { x: 0, y: 0 },
            { x: 0, y: 1 },
            { x: 1, y: 1 },
            { x: 1, y: 0 }
        ];
        const expanded = expandKnots([0, 1], [4, 4]);
        // B(0.5) = 1/8*P0 + 3/8*P1 + 3/8*P2 + 1/8*P3 = (0.5, 0.75).
        const mid = deBoor(0.5, poles, expanded, 3);
        expect(mid.x).toBeCloseTo(0.5, 12);
        expect(mid.y).toBeCloseTo(0.75, 12);
    });

    it('clamps u outside the knot range', () => {
        expect(deBoor(-1, linePoles, lineKnots, 1)).toEqual({ x: 0, y: 0 });
        expect(deBoor(2, linePoles, lineKnots, 1)).toEqual({ x: 10, y: 4 });
    });

    it('rejects malformed knot vectors', () => {
        expect(() => deBoor(0, linePoles, [0, 1], 1)).toThrow();
    });
});

describe('sampleBSplineCurve', () => {
    it('returns segments + 1 points interpolating both end poles', () => {
        const poles = [
            { x: 0, y: 0 },
            { x: 3, y: 6 },
            { x: 6, y: 0 },
            { x: 9, y: 6 }
        ];
        const { knots, mult } = clampedUniformKnots(4, 3);
        const samples = sampleBSplineCurve(poles, knots, mult, 3, 32);
        expect(samples.length).toBe(33);
        expect(samples[0]).toEqual(poles[0]);
        expect(samples[32]).toEqual(poles[3]);
    });

    it('produces points on a degree-1 control polygon', () => {
        const poles = [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 }
        ];
        const { knots, mult } = clampedUniformKnots(3, 1);
        const samples = sampleBSplineCurve(poles, knots, mult, 1, 4);
        expect(samples[2]).toEqual({ x: 10, y: 0 });
    });
});

describe('nearestPolylinePoint', () => {
    it('finds the closest vertex', () => {
        const polyline = [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 }
        ];
        const hit = nearestPolylinePoint({ x: 9.5, y: 1 }, polyline);
        expect(hit).toBeDefined();
        expect(hit!.point).toEqual({ x: 10, y: 0 });
        expect(hit!.distance).toBeCloseTo(Math.hypot(0.5, 1), 12);
    });

    it('returns undefined for an empty polyline', () => {
        expect(nearestPolylinePoint({ x: 0, y: 0 }, [])).toBeUndefined();
    });
});

describe('shared samplers', () => {
    it('return the same array instance for identical arguments', () => {
        const center = { x: 1, y: 2 };
        const focus = { x: 4, y: 2 };
        const first = sharedEllipsePolyline(center, focus, 1.5);
        const second = sharedEllipsePolyline({ x: 1, y: 2 }, { x: 4, y: 2 }, 1.5);
        expect(first).toBe(second);

        const poles = [
            { x: 0, y: 0 },
            { x: 1, y: 2 },
            { x: 2, y: 0 }
        ];
        const { knots, mult } = clampedUniformKnots(3, 2);
        const b1 = sharedBSplinePolyline(poles, knots, mult, 2);
        const b2 = sharedBSplinePolyline(
            [
                { x: 0, y: 0 },
                { x: 1, y: 2 },
                { x: 2, y: 0 }
            ],
            knots,
            mult,
            2
        );
        expect(b1).toBe(b2);
    });
});
