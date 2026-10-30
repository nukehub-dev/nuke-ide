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
import {
    buildTopologyRef,
    dedupeFaceCandidates,
    pointerToNdc,
    projectHitToFaceUv,
    raycastFaceCandidates,
    type FacePickCandidate
} from './face-picker';

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

    describe('raycastFaceCandidates', () => {
        const camera = {} as THREE.Camera;
        const ndc = { x: 0, y: 0 };

        const mesh = (userData: Record<string, unknown>): THREE.Mesh => ({ userData }) as unknown as THREE.Mesh;

        const raycasterOf = (intersections: readonly { object: THREE.Mesh; distance: number; point: THREE.Vector3 }[]): THREE.Raycaster =>
            ({
                setFromCamera: () => undefined,
                intersectObjects: () => intersections
            }) as unknown as THREE.Raycaster;

        it('maps valid hits in distance order and skips invalid userData', () => {
            const near = mesh({ solidId: 1, faceId: 2, bodyId: 'body-a' });
            const badType = mesh({ solidId: '1', faceId: 2 });
            const missing = mesh({});
            const far = mesh({ solidId: 3, faceId: 4 });
            const result = raycastFaceCandidates(
                [near, far],
                raycasterOf([
                    { object: near, distance: 1.25, point: new THREE.Vector3(0, 0, 1) },
                    { object: badType, distance: 2, point: new THREE.Vector3(0, 0, 2) },
                    { object: missing, distance: 3, point: new THREE.Vector3(0, 0, 3) },
                    { object: far, distance: 4.5, point: new THREE.Vector3(0, 0, 4) }
                ]),
                ndc,
                camera
            );

            expect(result.map((entry) => `${entry.solidId}:${entry.faceId}`)).toEqual(['1:2', '3:4']);
            expect(result[0].bodyId).toBe('body-a');
            expect(result[0].distance).toBe(1.25);
            expect(result[0].point?.toArray()).toEqual([0, 0, 1]);
            expect(result[1].bodyId).toBeUndefined();
        });

        it('dedupes a face hit twice (entering and exiting a shell), keeping the nearest', () => {
            const shell = mesh({ solidId: 2, faceId: 7, bodyId: 'body-b' });
            const cap = mesh({ solidId: 2, faceId: 8 });
            const result = raycastFaceCandidates(
                [shell, cap],
                raycasterOf([
                    { object: shell, distance: 1, point: new THREE.Vector3(0, 0, 1) },
                    { object: cap, distance: 2, point: new THREE.Vector3(0, 0, 2) },
                    { object: shell, distance: 5, point: new THREE.Vector3(0, 0, 5) }
                ]),
                ndc,
                camera
            );

            expect(result.map((entry) => `${entry.solidId}:${entry.faceId}`)).toEqual(['2:7', '2:8']);
            expect(result[0].distance).toBe(1);
        });

        it('caps the list at the limit', () => {
            const meshes = [1, 2, 3, 4].map((faceId) => mesh({ solidId: 1, faceId }));
            const result = raycastFaceCandidates(
                meshes,
                raycasterOf(meshes.map((object, index) => ({ object, distance: index + 1, point: new THREE.Vector3() }))),
                ndc,
                camera,
                2
            );

            expect(result.map((entry) => entry.faceId)).toEqual([1, 2]);
        });

        it('returns no candidates when the ray misses', () => {
            expect(raycastFaceCandidates([], raycasterOf([]), ndc, camera)).toEqual([]);
        });
    });

    describe('dedupeFaceCandidates', () => {
        const mesh = {} as THREE.Mesh;
        const candidate = (solidId: number, faceId: number, distance: number): FacePickCandidate => ({
            solidId,
            faceId,
            distance,
            mesh
        });

        it('sorts unsorted input by distance', () => {
            const result = dedupeFaceCandidates([candidate(1, 1, 5), candidate(2, 2, 1), candidate(3, 3, 3)]);
            expect(result.map((entry) => entry.distance)).toEqual([1, 3, 5]);
        });

        it('keeps the nearest hit per solid/face and drops later duplicates', () => {
            const result = dedupeFaceCandidates([candidate(1, 1, 4), candidate(1, 1, 2), candidate(1, 2, 3)]);
            expect(result.map((entry) => `${entry.solidId}:${entry.faceId}:${entry.distance}`)).toEqual(['1:1:2', '1:2:3']);
        });

        it('returns an empty list for a non-positive limit', () => {
            expect(dedupeFaceCandidates([candidate(1, 1, 1)], 0)).toEqual([]);
            expect(dedupeFaceCandidates([candidate(1, 1, 1)], -1)).toEqual([]);
        });
    });
});
