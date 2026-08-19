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
});
