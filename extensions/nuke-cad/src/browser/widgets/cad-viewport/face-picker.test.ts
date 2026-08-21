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
import * as THREE from 'three';
import { buildTopologyRef, pointerToNdc, projectHitToFaceUv } from './face-picker';

function makeRect(x: number, y: number, width: number, height: number): DOMRect {
    return {
        x,
        y,
        width,
        height,
        top: y,
        left: x,
        right: x + width,
        bottom: y + height,
        toJSON: () => ({})
    } as DOMRect;
}

describe('face-picker', () => {
    describe('pointerToNdc', () => {
        it('maps the top-left corner to (-1, 1)', () => {
            const rect = makeRect(0, 0, 200, 100);
            expect(pointerToNdc(0, 0, rect)).toEqual({ x: -1, y: 1 });
        });

        it('maps the center to (0, 0)', () => {
            const rect = makeRect(0, 0, 200, 100);
            expect(pointerToNdc(100, 50, rect)).toEqual({ x: 0, y: 0 });
        });

        it('maps the bottom-right corner to (1, -1)', () => {
            const rect = makeRect(0, 0, 200, 100);
            expect(pointerToNdc(200, 100, rect)).toEqual({ x: 1, y: -1 });
        });

        it('accounts for a non-zero rectangle origin', () => {
            const rect = makeRect(50, 20, 200, 100);
            expect(pointerToNdc(150, 70, rect)).toEqual({ x: 0, y: 0 });
        });
    });

    describe('buildTopologyRef', () => {
        it('returns undefined when the hit has no fingerprint', () => {
            const hit = { solidId: 1, faceId: 2, mesh: undefined as unknown as import('three').Mesh };
            expect(buildTopologyRef('feature-1', hit as import('./face-picker').FacePickHit)).toBeUndefined();
        });

        it('builds a TopologyRef from a face hit', () => {
            const mesh = {} as import('three').Mesh;
            const hit = {
                solidId: 1,
                faceId: 2,
                mesh,
                fingerprint: {
                    surfaceType: 'plane' as const,
                    area: 10,
                    center: [0, 0, 0] as [number, number, number],
                    normal: [0, 0, 1] as [number, number, number]
                }
            };
            const ref = buildTopologyRef('feature-1', hit);
            expect(ref).toEqual({
                featureId: 'feature-1',
                kind: 'face',
                fingerprint: hit.fingerprint
            });
        });

        it('resolves the body tip feature when bodyId is present', () => {
            const mesh = {} as import('three').Mesh;
            const hit = {
                solidId: 1,
                faceId: 2,
                bodyId: 'body-a',
                mesh,
                fingerprint: {
                    surfaceType: 'plane' as const,
                    area: 10,
                    center: [0, 0, 0] as [number, number, number],
                    normal: [0, 0, 1] as [number, number, number]
                }
            };
            const ref = buildTopologyRef('fallback', hit, (bodyId) => (bodyId === 'body-a' ? 'body-tip' : undefined));
            expect(ref).toEqual({
                featureId: 'body-tip',
                kind: 'face',
                fingerprint: hit.fingerprint
            });
        });

        it('falls back to the supplied feature id when body tip resolution fails', () => {
            const mesh = {} as import('three').Mesh;
            const hit = {
                solidId: 1,
                faceId: 2,
                bodyId: 'body-a',
                mesh,
                fingerprint: {
                    surfaceType: 'plane' as const,
                    area: 10,
                    center: [0, 0, 0] as [number, number, number],
                    normal: [0, 0, 1] as [number, number, number]
                }
            };
            const ref = buildTopologyRef('fallback', hit, () => undefined);
            expect(ref).toEqual({
                featureId: 'fallback',
                kind: 'face',
                fingerprint: hit.fingerprint
            });
        });
    });

    describe('projectHitToFaceUv', () => {
        it('returns undefined when the hit lacks a point or fingerprint', () => {
            const hit = { solidId: 1, faceId: 1, mesh: {} as import('three').Mesh };
            expect(projectHitToFaceUv(hit as import('./face-picker').FacePickHit)).toBeUndefined();
        });

        it('projects a point on a Z-normal face to the expected UV', () => {
            const hit = {
                solidId: 1,
                faceId: 1,
                mesh: {} as THREE.Mesh,
                point: new THREE.Vector3(2, 3, 0),
                fingerprint: {
                    surfaceType: 'plane' as const,
                    area: 10,
                    center: [0, 0, 0] as [number, number, number],
                    normal: [0, 0, 1] as [number, number, number]
                }
            };
            expect(projectHitToFaceUv(hit)).toEqual([2, 3]);
        });

        it('uses the deterministic basis for a Y-normal face', () => {
            const hit = {
                solidId: 1,
                faceId: 1,
                mesh: {} as THREE.Mesh,
                point: new THREE.Vector3(1, 0, 2),
                fingerprint: {
                    surfaceType: 'plane' as const,
                    area: 10,
                    center: [0, 0, 0] as [number, number, number],
                    normal: [0, 1, 0] as [number, number, number]
                }
            };
            expect(projectHitToFaceUv(hit)).toEqual([-1, 2]);
        });
    });
});
