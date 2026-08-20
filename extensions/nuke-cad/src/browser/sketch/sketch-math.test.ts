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
import {
    buildDatumPlane,
    buildDatumPlaneFromFace,
    intersectRayPlane,
    worldToSketch,
    sketchToWorld,
    pixelRadiusToModelUnits,
    projectPointOntoSegment,
    dist
} from './sketch-math';

describe('sketch-math', () => {
    describe('buildDatumPlane', () => {
        it('builds an XY plane at zero offset', () => {
            const plane = buildDatumPlane('XY', 0);
            expect(plane.normal).toEqual({ x: 0, y: 0, z: 1 });
            expect(plane.origin).toEqual({ x: 0, y: 0, z: 0 });
        });

        it('offsets XY along Z', () => {
            const plane = buildDatumPlane('XY', 2.5);
            expect(plane.origin).toEqual({ x: 0, y: 0, z: 2.5 });
        });

        it('offsets YZ along X', () => {
            const plane = buildDatumPlane('YZ', 1);
            expect(plane.normal).toEqual({ x: 1, y: 0, z: 0 });
            expect(plane.origin).toEqual({ x: 1, y: 0, z: 0 });
        });

        it('offsets XZ along Y', () => {
            const plane = buildDatumPlane('XZ', -3);
            expect(plane.normal).toEqual({ x: 0, y: 1, z: 0 });
            expect(plane.origin).toEqual({ x: 0, y: -3, z: 0 });
        });
    });

    describe('intersectRayPlane', () => {
        it('hits the XY plane from above', () => {
            const plane = buildDatumPlane('XY', 0);
            const ray = { origin: { x: 1, y: 2, z: 5 }, direction: { x: 0, y: 0, z: -1 } };
            const hit = intersectRayPlane(ray, plane);
            expect(hit).toEqual({ x: 1, y: 2, z: 0 });
        });

        it('returns undefined for a parallel ray', () => {
            const plane = buildDatumPlane('XY', 0);
            const ray = { origin: { x: 0, y: 0, z: 5 }, direction: { x: 1, y: 0, z: 0 } };
            expect(intersectRayPlane(ray, plane)).toBeUndefined();
        });

        it('hits an offset YZ plane', () => {
            const plane = buildDatumPlane('YZ', 4);
            const ray = { origin: { x: 10, y: 2, z: 3 }, direction: { x: -1, y: 0, z: 0 } };
            const hit = intersectRayPlane(ray, plane);
            expect(hit).toEqual({ x: 4, y: 2, z: 3 });
        });
    });

    describe('worldToSketch / sketchToWorld', () => {
        it('round-trips a point on the XY plane', () => {
            const plane = buildDatumPlane('XY', 2);
            const world = { x: 3, y: 4, z: 2 };
            const sketch = worldToSketch(world, plane);
            expect(sketch).toEqual({ x: 3, y: 4 });
            expect(sketchToWorld(sketch, plane)).toEqual(world);
        });

        it('round-trips a point on the YZ plane', () => {
            const plane = buildDatumPlane('YZ', 1);
            const world = { x: 1, y: 3, z: 4 };
            const sketch = worldToSketch(world, plane);
            expect(sketch).toEqual({ x: 3, y: 4 });
            expect(sketchToWorld(sketch, plane)).toEqual(world);
        });
    });

    describe('pixelRadiusToModelUnits', () => {
        it('scales by the orthographic view height', () => {
            expect(pixelRadiusToModelUnits(12, 20, 400)).toBeCloseTo(0.6, 10);
        });

        it('falls back to the pixel radius for a zero canvas height', () => {
            expect(pixelRadiusToModelUnits(12, 20, 0)).toBe(12);
        });
    });

    describe('projectPointOntoSegment', () => {
        it('projects inside the segment', () => {
            const p = projectPointOntoSegment({ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 4, y: 0 });
            expect(p).toEqual({ x: 1, y: 0 });
        });

        it('clamps before the start', () => {
            const p = projectPointOntoSegment({ x: -2, y: 1 }, { x: 0, y: 0 }, { x: 4, y: 0 });
            expect(p).toEqual({ x: 0, y: 0 });
        });

        it('clamps past the end', () => {
            const p = projectPointOntoSegment({ x: 6, y: -1 }, { x: 0, y: 0 }, { x: 4, y: 0 });
            expect(p).toEqual({ x: 4, y: 0 });
        });
    });

    describe('dist', () => {
        it('computes Euclidean distance', () => {
            expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
        });
    });

    describe('buildDatumPlaneFromFace', () => {
        it('builds a datum from a planar face fingerprint', () => {
            const reference = {
                featureId: 'base',
                kind: 'face' as const,
                fingerprint: {
                    surfaceType: 'plane' as const,
                    area: 100,
                    center: [0, 0, 5] as [number, number, number],
                    normal: [0, 0, 1] as [number, number, number]
                }
            };
            const plane = buildDatumPlaneFromFace(reference, 0);
            expect(plane.kind).toBe('face');
            expect(plane.normal).toEqual({ x: 0, y: 0, z: 1 });
            expect(plane.origin).toEqual({ x: 0, y: 0, z: 5 });
            expect(plane.reference).toBe(reference);
        });

        it('applies offset along the face normal', () => {
            const reference = {
                featureId: 'base',
                kind: 'face' as const,
                fingerprint: {
                    surfaceType: 'plane' as const,
                    area: 100,
                    center: [0, 0, 5] as [number, number, number],
                    normal: [0, 0, 1] as [number, number, number]
                }
            };
            const plane = buildDatumPlaneFromFace(reference, 2);
            expect(plane.origin).toEqual({ x: 0, y: 0, z: 7 });
        });

        it('throws for a non-planar face fingerprint', () => {
            const reference = {
                featureId: 'base',
                kind: 'face' as const,
                fingerprint: {
                    surfaceType: 'cylinder' as const,
                    area: 100,
                    center: [0, 0, 5] as [number, number, number]
                }
            };
            expect(() => buildDatumPlaneFromFace(reference)).toThrow('normal');
        });
    });
});
