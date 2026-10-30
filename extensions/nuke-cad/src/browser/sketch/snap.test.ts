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

import { describe, it, expect } from 'vitest';
import { snap, createSnapConfig, type Point2, type SketchPrimitive } from './snap';

const CONFIG = createSnapConfig({ radius: 0.5, gridPitch: 1 });

function makeLine(id: string, p1: Point2, p2: Point2): SketchPrimitive[] {
    return [
        { type: 'point', id: `${id}-p1`, x: p1.x, y: p1.y },
        { type: 'point', id: `${id}-p2`, x: p2.x, y: p2.y },
        { type: 'line', id, p1Id: `${id}-p1`, p2Id: `${id}-p2` }
    ];
}

function makeCircle(id: string, center: Point2, radius: number): SketchPrimitive[] {
    return [
        { type: 'point', id: `${id}-c`, x: center.x, y: center.y },
        { type: 'circle', id, centerId: `${id}-c`, radius }
    ];
}

describe('snap', () => {
    it('returns raw point when snapping is disabled', () => {
        const primitives = makeLine('l1', { x: 0, y: 0 }, { x: 10, y: 0 });
        const result = snap({ x: 0.1, y: 0 }, primitives, createSnapConfig({ enabled: false }));
        expect(result.point).toEqual({ x: 0.1, y: 0 });
        expect(result.kind).toBeUndefined();
    });

    it('snaps to an endpoint with highest priority', () => {
        const primitives: SketchPrimitive[] = [...makeCircle('c1', { x: 5, y: 0 }, 5), { type: 'point', id: 'free', x: 0, y: 0 }];
        const result = snap({ x: 0.1, y: 0.1 }, primitives, CONFIG);
        expect(result.kind).toBe('endpoint');
        expect(result.pointId).toBe('free');
        expect(result.point).toEqual({ x: 0, y: 0 });
    });

    it('snaps to a midpoint when no endpoint is closer', () => {
        const primitives = makeLine('l1', { x: 0, y: 0 }, { x: 10, y: 0 });
        const result = snap({ x: 5.1, y: 0.1 }, primitives, CONFIG);
        expect(result.kind).toBe('midpoint');
        expect(result.sourceId).toBe('l1');
        expect(result.point).toEqual({ x: 5, y: 0 });
    });

    it('snaps to a circle center before quadrant and on-curve', () => {
        const primitives = makeCircle('c1', { x: 5, y: 0 }, 5);
        const result = snap({ x: 5.1, y: 0.1 }, primitives, CONFIG);
        expect(result.kind).toBe('center');
        expect(result.sourceId).toBe('c1');
        expect(result.pointId).toBe('c1-c');
        expect(result.point).toEqual({ x: 5, y: 0 });
    });

    it('snaps to circle quadrants', () => {
        const primitives = makeCircle('c1', { x: 0, y: 0 }, 5);
        const result = snap({ x: 5.1, y: 0.1 }, primitives, CONFIG);
        expect(result.kind).toBe('quadrant');
        expect(result.sourceId).toBe('c1');
        expect(result.point).toEqual({ x: 5, y: 0 });
    });

    it('snaps to the nearest quadrant among several circles', () => {
        const primitives: SketchPrimitive[] = [...makeCircle('c1', { x: 0, y: 0 }, 5), ...makeCircle('c2', { x: 20, y: 0 }, 5)];
        const result = snap({ x: 24.9, y: 0.1 }, primitives, CONFIG);
        expect(result.kind).toBe('quadrant');
        expect(result.sourceId).toBe('c2');
    });

    it('snaps to on-curve for line interiors', () => {
        const primitives = makeLine('l1', { x: 0, y: 0 }, { x: 10, y: 0 });
        const result = snap({ x: 3, y: 0.4 }, primitives, CONFIG);
        expect(result.kind).toBe('on_curve');
        expect(result.sourceId).toBe('l1');
        expect(result.point).toEqual({ x: 3, y: 0 });
    });

    it('snaps to on-curve for circle circumferences', () => {
        const primitives = makeCircle('c1', { x: 0, y: 0 }, 5);
        const result = snap({ x: 3.4, y: 3.4 }, primitives, CONFIG);
        expect(result.kind).toBe('on_curve');
        expect(result.sourceId).toBe('c1');
        const distance = Math.hypot(result.point.x, result.point.y);
        expect(distance).toBeCloseTo(5, 10);
    });

    it('falls back to grid snap when no geometry is near', () => {
        const primitives = makeLine('l1', { x: 100, y: 100 }, { x: 110, y: 100 });
        const result = snap({ x: 2.4, y: 2.4 }, primitives, CONFIG);
        expect(result.kind).toBe('grid');
        expect(result.point).toEqual({ x: 2, y: 2 });
    });

    it('returns raw point when nothing is within radius and grid is disabled', () => {
        const primitives = makeLine('l1', { x: 100, y: 100 }, { x: 110, y: 100 });
        const result = snap({ x: 2.4, y: 2.4 }, primitives, createSnapConfig({ gridEnabled: false }));
        expect(result.kind).toBeUndefined();
        expect(result.point).toEqual({ x: 2.4, y: 2.4 });
    });

    it('respects the snap radius threshold', () => {
        const primitives = makeLine('l1', { x: 0, y: 0 }, { x: 10, y: 0 });
        const tight = createSnapConfig({ radius: 0.05 });
        const result = snap({ x: 5, y: 0.4 }, primitives, tight);
        expect(result.kind).toBe('grid');
    });

    it('treats line endpoints as endpoint snaps', () => {
        const primitives = makeLine('l1', { x: 0, y: 0 }, { x: 10, y: 10 });
        const result = snap({ x: 10.1, y: 10.1 }, primitives, CONFIG);
        expect(result.kind).toBe('endpoint');
        expect(result.pointId).toBe('l1-p2');
    });

    it('prefers endpoint over midpoint for the same line', () => {
        const primitives = makeLine('l1', { x: 0, y: 0 }, { x: 10, y: 0 });
        const result = snap({ x: 0.1, y: 0.1 }, primitives, CONFIG);
        expect(result.kind).toBe('endpoint');
    });

    it('snaps to an arc center', () => {
        const primitives: SketchPrimitive[] = [
            { type: 'point', id: 'center', x: 5, y: 0 },
            { type: 'point', id: 'start', x: 10, y: 0 },
            { type: 'point', id: 'end', x: 5, y: 5 },
            { type: 'arc', id: 'a1', centerId: 'center', radius: 5, startAngle: 0, endAngle: Math.PI / 2, startId: 'start', endId: 'end' }
        ];
        const result = snap({ x: 5.1, y: 0.1 }, primitives, CONFIG);
        expect(result.kind).toBe('center');
        expect(result.sourceId).toBe('a1');
        expect(result.pointId).toBe('center');
    });

    function makeEllipse(id: string, center: Point2, focus1: Point2, radmin: number): SketchPrimitive[] {
        return [
            { type: 'point', id: `${id}-c`, x: center.x, y: center.y },
            { type: 'point', id: `${id}-f`, x: focus1.x, y: focus1.y },
            { type: 'ellipse', id, centerId: `${id}-c`, focus1Id: `${id}-f`, radmin }
        ];
    }

    function makeBSpline(id: string, poles: Point2[]): SketchPrimitive[] {
        const degree = Math.min(3, poles.length - 1);
        const spans = poles.length - degree;
        const knots: number[] = [];
        const mult: number[] = [];
        for (let i = 0; i <= spans; i++) {
            knots.push(i);
            mult.push(i === 0 || i === spans ? degree + 1 : 1);
        }
        return [
            ...poles.map((p, i) => ({ type: 'point', id: `${id}-p${i}`, x: p.x, y: p.y }) as SketchPrimitive),
            {
                type: 'bspline',
                id,
                poleIds: poles.map((_p, i) => `${id}-p${i}`),
                weights: poles.map(() => 1),
                knots,
                mult,
                degree,
                periodic: false
            } as SketchPrimitive
        ];
    }

    it('snaps to an ellipse center', () => {
        // center (0,0), focus (3,0): major 5, minor 4.
        const primitives = makeEllipse('e1', { x: 0, y: 0 }, { x: 3, y: 0 }, 4);
        const result = snap({ x: 0.1, y: 0.1 }, primitives, CONFIG);
        expect(result.kind).toBe('center');
        expect(result.sourceId).toBe('e1');
        expect(result.pointId).toBe('e1-c');
        expect(result.point).toEqual({ x: 0, y: 0 });
    });

    it('snaps on-curve to an ellipse circumference', () => {
        const primitives = makeEllipse('e1', { x: 0, y: 0 }, { x: 3, y: 0 }, 4);
        // Near the major-axis extreme (5, 0); must not be treated as a quadrant.
        const result = snap({ x: 5, y: 0.3 }, primitives, CONFIG);
        expect(result.kind).toBe('on_curve');
        expect(result.sourceId).toBe('e1');
        // Snap lands on a chord vertex, so verify it lies on the ellipse.
        const norm = (result.point.x * result.point.x) / 25 + (result.point.y * result.point.y) / 16;
        expect(norm).toBeCloseTo(1, 3);
    });

    it('snaps to B-spline end poles as endpoints', () => {
        const primitives = makeBSpline('b1', [
            { x: 0, y: 0 },
            { x: 3, y: 6 },
            { x: 6, y: 0 }
        ]);
        const result = snap({ x: 6.1, y: 0.1 }, primitives, CONFIG);
        expect(result.kind).toBe('endpoint');
        expect(result.pointId).toBe('b1-p2');
        expect(result.point).toEqual({ x: 6, y: 0 });
    });

    it('snaps on-curve to a B-spline interior, skipping end poles', () => {
        const primitives = makeBSpline('b1', [
            { x: 0, y: 0 },
            { x: 3, y: 6 },
            { x: 6, y: 0 }
        ]);
        // Quadratic B-spline: at t = 0.2 the curve passes through (1.2, 1.92);
        // both end poles are far away.
        const result = snap({ x: 1.25, y: 2.1 }, primitives, CONFIG);
        expect(result.kind).toBe('on_curve');
        expect(result.sourceId).toBe('b1');
        expect(result.point.y).toBeGreaterThan(1.5);
    });

    it('treats an interior B-spline pole as a point, not an on-curve hit', () => {
        const primitives = makeBSpline('b1', [
            { x: 0, y: 0 },
            { x: 3, y: 6 },
            { x: 6, y: 0 }
        ]);
        // The middle pole (3, 6) is off-curve; it is still a sketch point, so
        // snapping near it lands on the point rather than the curve below it.
        const result = snap({ x: 3.1, y: 5.9 }, primitives, CONFIG);
        expect(result.kind).toBe('endpoint');
        expect(result.pointId).toBe('b1-p1');
        expect(result.point).toEqual({ x: 3, y: 6 });
    });
});
